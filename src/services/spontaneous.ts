/**
 * Спонтанные реплики: раз в день, в случайное время, бот сам пишет одну
 * короткую реплику в раздел — без вопроса и без команды, как обычный
 * участник, которому вдруг было что сказать.
 *
 * Как устроено, по шагам:
 *
 *  1. Один раз в сутки, в случайный момент внутри дневного окна (не ночью),
 *     срабатывает таймер и перебирает все известные разделы (см. src/services/topics.ts).
 *  2. Для каждого — свой бросок монеты (config.spontaneous.chance): не судьба
 *     сегодня, значит просто ничего не произойдёт. Раздел выключен через
 *     /stop — тоже ничего.
 *  3. Если материала мало (реплик в архиве почти нет), тоже молчим: писать
 *     в мёртвый раздел ради самого факта — хуже, чем не написать вовсе.
 *  4. Дальше — два вызова модели, оба на самой лёгкой (config.spontaneous.model):
 *     первый читает последние реплики (изредка — ещё и долгую память) и делает
 *     короткий разбор «что происходит»; второй превращает разбор в саму
 *     реплику — с учётом жанра и манеры, которые выбраны случайно ещё
 *     до всякой генерации (см. pickPlan).
 *  5. Готовое уходит в чат, а следом — в историю раздела, архив поиска
 *     и долгую память, теми же функциями, что и обычный ответ /гем: реплика
 *     бота не должна пропадать из того, что он сам же помнит.
 *
 * Жанры (см. pickPlan):
 *   • grounded (большинство случаев) — реакция на последние реплики,
 *     без долгой памяти: меньше матерала — меньше риска соврать;
 *   • deep (редко) — вывод по долгой памяти, что-то из более старого;
 *   • deepJoke (совсем редко, подмножество deep) — тот же вывод, но подан
 *     как шутка: если он окажется неточным, это прочитается как ирония,
 *     а не как «бот путает факты»;
 *   • имитация манеры (независимо от жанра, изредка) — реплика в духе того,
 *     как обычно пишет один из участников последних сообщений. Не подмена
 *     личности: сообщение всё равно приходит от самого бота, Telegram
 *     подписывает отправителя сам, — просто взятая на один раз манера речи.
 */
import { FileAdapter } from '@grammyjs/storage-file';
import type { Bot, GrammyError } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { findTextProvider } from './registry.js';
import { getDigest, noteMessage as noteDigestMessage } from './digest.js';
import { rememberMessage, recentMessages, type IndexedMessage } from './search-index.js';
import { knownTopics } from './topics.js';
import { markdownToTelegramHtml, splitMarkdown } from '../format.js';
import type { BotContext, SessionData } from '../types.js';

/** Своё хранилище сессий: читаем и правим их напрямую, без апдейта от Telegram. */
const sessions = new FileAdapter<SessionData>({ dirName: config.session.dir });

/** Разбирает ключ раздела обратно на id чата и топика (см. sessionKey в src/utils.ts). */
function parseKey(key: string): { chatId: number; threadId?: number } {
  const [chatPart, threadPart] = key.split('_');
  const chatId = Number(chatPart);
  const threadId = threadPart !== undefined ? Number(threadPart) : undefined;
  return threadId === undefined ? { chatId } : { chatId, threadId };
}

type Genre = 'grounded' | 'deep' | 'deepJoke';

interface Plan {
  genre: Genre;
  /** Манера речи — ник/имя, чью манеру взять на этот раз, если решили её взять. */
  impersonate?: string;
}

/** Бросает все монеты сразу — до всякого обращения к модели, дёшево и предсказуемо для тестов. */
function pickPlan(speakers: string[]): Plan {
  const useDeep = Math.random() < config.spontaneous.deepChance;
  const genre: Genre = useDeep ? (Math.random() < config.spontaneous.jokeChance ? 'deepJoke' : 'deep') : 'grounded';

  const wantImpersonate = Math.random() < config.spontaneous.impersonateChance;
  const impersonate = wantImpersonate && speakers.length > 0 ? speakers[Math.floor(Math.random() * speakers.length)] : undefined;

  return { genre, ...(impersonate ? { impersonate } : {}) };
}

const ANALYST_ROLE =
  'Ты помогаешь другому этапу того же бота понять, что сейчас происходит в чате. ' +
  'Твой текст никто не прочитает как есть — это черновая заметка для следующего шага, ' +
  'а не сообщение в чат. Пиши по-русски, кратко, по делу, без форматирования и вступлений.';

function buildAnalysisPrompt(genre: Genre, digestText: string, recent: IndexedMessage[]): string {
  const chunk = recent.map((m) => `${m.who}: ${m.text}`).join('\n');

  if (genre === 'grounded') {
    return (
      `Вот последние сообщения в разделе чата:\n${chunk}\n\n` +
      'Опиши в паре строк: о чём говорили только что, какое настроение, и что здесь ' +
      'уместно было бы сказать одной короткой репликой от третьего участника, который сейчас ' +
      'просто читает переписку. Конкретно, без общих слов.'
    );
  }

  return (
    (digestText ? `Долгая память о более ранних разговорах в этом разделе:\n${digestText}\n\n` : '') +
    `Последние сообщения:\n${chunk}\n\n` +
    'Найди что-то из более раннего (из долгой памяти), что можно было бы к слову вспомнить ' +
    'или обыграть сейчас, — и опиши это в паре строк. Если из старого зацепиться не за что, ' +
    'так и скажи прямо, не придумывай.'
  );
}

function composeRole(genre: Genre, impersonate: string | undefined): string {
  const base =
    'Ты пишешь ОДНУ короткую реплику в групповой чат — как обычный участник, которому вдруг ' +
    'было что сказать, а не как ассистент, отвечающий на вопрос. Один-два, максимум три коротких ' +
    'предложения. Без заголовков, списков, markdown-разметки, канцелярита и фраз вроде «я заметил, что» ' +
    'или «как ИИ». Смайлик уместен один и только если он правда нужен, никакой фиксированной схемы значков. ' +
    'Не упоминай, что ты сжимал память, анализировал переписку или выполняешь какую-то функцию — ' +
    'просто скажи то, что сказал бы в этот момент.';

  const genreNote =
    genre === 'grounded'
      ? 'Опирайся строго на то, что реально было в последних сообщениях, — конкретно, по именам и темам.'
      : genre === 'deep'
        ? 'Речь о чём-то из более давнего разговора — мягко, не как о доказанном факте: если не уверен ' +
          'в детали, сформулируй как воспоминание или предположение, а не как утверждение.'
        : 'Речь о чём-то из более давнего разговора, но подай это явно как шутку или подкол — ' +
          'легко, с самоиронией, чтобы если что-то вспомнилось неточно, это читалось как юмор, а не как сбой.';

  const impersonateNote = impersonate
    ? ` Пиши в манере, в которой в последних сообщениях обычно пишет ${impersonate} — переняв тон и словечки, ` +
      'но не называй себя его именем и не притворяйся, что это буквально он: сообщение всё равно от тебя.'
    : '';

  return `${base} ${genreNote}${impersonateNote}`;
}

/** Отправляет готовую реплику и возвращает id сообщения — пригодится для архива. */
async function sendSpontaneous(bot: Bot<BotContext>, chatId: number, threadId: number | undefined, text: string): Promise<number> {
  const [chunk = text] = splitMarkdown(text);

  try {
    const sent = await bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
    return sent.message_id;
  } catch (error) {
    const isMarkupError = (error as GrammyError)?.description && /parse entities|unsupported start tag/i.test((error as GrammyError).description);
    if (!isMarkupError) throw error;

    const sent = await bot.api.sendMessage(chatId, chunk, {
      link_preview_options: { is_disabled: true },
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
    return sent.message_id;
  }
}

/** Дописывает реплику бота в историю раздела — тем же способом и с тем же потолком, что и обычный ответ. */
async function appendToHistory(key: string, text: string): Promise<void> {
  if (config.ai.historyLimit <= 0) return;

  // Гонка с обычным ответом в этот же момент теоретически возможна (оба читают
  // и пишут сессию напрямую, без общей блокировки), но при случайном времени
  // раз в сутки на маленькую группу вероятность пренебрежимо мала — так же,
  // как и цена: в худшем случае потеряется одна реплика из истории, не больше.
  const data = await sessions.read(key);
  if (!data) return;

  data.history.push({ role: 'assistant', text });
  data.history = data.history.slice(-config.ai.historyLimit);
  await sessions.write(key, data);
}

/** Пытается написать в один раздел. Ничего не бросает наружу — вызывающий код разделы не должен терять. */
async function maybePostTo(bot: Bot<BotContext>, key: string): Promise<void> {
  if (Math.random() > config.spontaneous.chance) return;

  const session = await sessions.read(key);
  if (session?.muted) return;

  const recent = await recentMessages(key, config.spontaneous.recentLimit);
  if (recent.length < config.spontaneous.minRecent) return;

  const gemini = findTextProvider('gemini');
  if (!gemini?.isConfigured) return;

  const speakers = [...new Set(recent.map((m) => m.who).filter((who) => who !== 'бот'))];
  const plan = pickPlan(speakers);
  const digestText = plan.genre === 'grounded' ? '' : await getDigest(key);

  // «Глубокий» жанр без единой строчки долгой памяти ничем не отличался бы
  // от обычного — тогда лучше честно откатиться на обычный.
  const genre: Genre = plan.genre !== 'grounded' && !digestText ? 'grounded' : plan.genre;

  const model = config.spontaneous.model;
  const shared = { model, temperature: 0.9, rawSystemPrompt: true as const };

  const analysis = await gemini.generateText(buildAnalysisPrompt(genre, digestText, recent), {
    ...shared,
    systemPrompt: ANALYST_ROLE,
    temperature: 0.5,
    maxOutputTokens: 400,
  });

  const message = (
    await gemini.generateText(analysis, {
      ...shared,
      systemPrompt: composeRole(genre, plan.impersonate),
      maxOutputTokens: config.spontaneous.maxOutputTokens,
    })
  ).trim();

  if (!message) return;

  const { chatId, threadId } = parseKey(key);
  const messageId = await sendSpontaneous(bot, chatId, threadId, message);

  rememberMessage(key, { ts: Date.now(), who: 'бот', text: message, messageId });
  noteDigestMessage(key, 'бот', message);
  await appendToHistory(key, message);

  logger.info('Спонтанная реплика отправлена', { key, genre, impersonate: plan.impersonate ?? null });
}

async function runOnce(bot: Bot<BotContext>): Promise<void> {
  if (!config.spontaneous.enabled) return;

  for (const key of await knownTopics()) {
    try {
      await maybePostTo(bot, key);
    } catch (error) {
      logger.warn('Спонтанная реплика не удалась', { key, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Сколько миллисекунд до случайного момента в пределах дневного окна —
 * сегодня, если он ещё впереди, иначе завтра.
 *
 * Не строит Date в чужом часовом поясе (там своя возня с DST), а считает
 * разницу в минутах между «сейчас» и целью — тем же приёмом, что и обратный
 * отсчёт до полуночи в src/services/daily-quota.ts.
 */
function msUntilNextWindow(): number {
  const tz = config.spontaneous.timezone;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(),
  );
  const [hours = 0, minutes = 0] = parts.split(':').map(Number);
  const nowMinutes = hours * 60 + minutes;

  const start = config.spontaneous.windowStartHour * 60;
  const end = config.spontaneous.windowEndHour * 60;
  const targetMinutes = start + Math.floor(Math.random() * Math.max(1, end - start));

  const diff = targetMinutes > nowMinutes ? targetMinutes - nowMinutes : 24 * 60 - nowMinutes + targetMinutes;
  return diff * 60_000;
}

let timer: NodeJS.Timeout | undefined;

/** Запускает суточный цикл. Вызывается один раз при старте бота (см. src/index.ts). */
export function scheduleSpontaneous(bot: Bot<BotContext>): void {
  if (!config.spontaneous.enabled) return;

  const tick = (): void => {
    const delay = msUntilNextWindow();
    logger.info('Следующая спонтанная попытка', { через: Math.round(delay / 60_000) + ' мин' });

    timer = setTimeout(() => {
      void runOnce(bot)
        .catch((error) => logger.warn('Суточный обход разделов упал', { error: error instanceof Error ? error.message : String(error) }))
        .finally(tick);
    }, delay);
  };

  tick();
}

/** Останавливает таймер — для аккуратного завершения процесса. */
export function stopSpontaneous(): void {
  if (timer) clearTimeout(timer);
}

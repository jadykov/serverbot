/**
 * Команды, работающие с нейросетями: /гем (/gem) и /reset.
 *
 * Точка входа намеренно одна. Раньше рядом жили /ask и /ai — выбор провайдера
 * кнопками и запрос к выбранному, — но текстовый провайдер настроен ровно один,
 * так что /ask сводился к тому же Gemini, только без слов-переключателей,
 * а /ai предлагал меню, в котором нечего выбирать.
 *
 * Что умеет /гем, задаётся первым словом запроса, и слово это пишется
 * с восклицательным знаком:
 *   /гем <вопрос>             — обычный ответ цепочкой, выбранной для раздела;
 *   /гем !контекст <задача>   — сильная цепочка (латинская форма: !context);
 *   /гем !нарисуй <описание>  — картинка вместо текста (латинская форма: !draw);
 *   /гем !скажи <текст>       — ответ голосом (!say);
 *   /гем !найди <что искать>  — поиск по переписке раздела (!find).
 *
 * Восклицательный знак — не украшение. Без него слова-переключатели воровали
 * обычные вопросы: «/гем скажи, что такое рекурсия» уходило в озвучку вместо
 * ответа, «/гем найди ошибку в этом SQL» — в поиск по архиву переписки,
 * а «/гем нарисуй схему словами» тратило деньги на картинку. Все четыре слова
 * слишком обычны для русской речи, чтобы значить команду просто так.
 *
 * Про две формы команды Gemini
 * ----------------------------
 * Telegram считает командой только латиницу: имя вида «гем» он не принимает
 * (setMyCommands отвечает BOT_COMMAND_INVALID) и не размечает такое слово
 * как bot_command. Поэтому:
 *   • /gem — настоящая команда: видна в меню и работает в группах даже
 *     при включённом privacy mode;
 *   • /гем — ловим регулярным выражением по тексту сообщения. В личке
 *     работает всегда, в группах — только если у бота отключён privacy mode
 *     (@BotFather → /setprivacy → Disable).
 */
import { GrammyError, InputFile, type Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { findTextProvider } from '../services/registry.js';
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from '../format.js';
import { sessionKey, withChatAction } from '../utils.js';
import { collectAlbumPart, downloadAttachment, pickPhotoFileId } from '../media.js';
import { generateWithChain } from '../services/chain.js';
import { startDraw } from './draw.js';
import { synthesizeSpeech } from '../services/gemini-tts.js';
import { rememberMessage, searchMessages } from '../services/search-index.js';
import { BOX_COLORS, drawBoxes, findObjects } from '../services/pointing.js';
import { resolveChain, THINK_CHAIN } from '../models.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type Attachment,
  type BotContext,
  type ChatMessage,
  type TextProvider,
} from '../types.js';

/** id провайдера Gemini в реестре. */
const GEMINI_ID = 'gemini';

/**
 * Кириллическая форма команды: /гем, /гем@имя_бота.
 * Регистр не важен, аргументы — всё, что после первого пробела.
 */
const CYRILLIC_GEM = /^\/гем(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

/**
 * Собирает регулярку слова-переключателя: «!контекст ...», «!draw ...».
 *
 * Отдельными командами это не сделано намеренно. Точка входа к нейросети одна,
 * её и надо помнить; а меню Telegram не засоряется пунктами, которые
 * отличаются друг от друга только выбором цепочки.
 *
 * Восклицательный знак обязателен, и пробел после него допускается: «!нарисуй»
 * и «! нарисуй» — одно и то же. Разделитель после слова прописан явно,
 * а не через \b: в JavaScript граница слова определяется по латинице,
 * и с кириллицей \b просто не срабатывает — «!контекст чего-то» не совпало бы
 * вообще. Заодно такая запись не ловит «!контекстный» и «!contextual»,
 * где слово лишь начинается похоже.
 */
function switchWord(words: string): RegExp {
  return new RegExp(`^!\\s*(?:${words})(?:[\\s,:.—–-]+([\\s\\S]*))?$`, 'i');
}

const CONTEXT_PREFIX = switchWord('контекст|context');

/**
 * Второе слово-переключатель, по тому же принципу: «/гем нарисуй ...»,
 * «/gem draw ...» — вместо ответа текстом бот рисует картинку.
 */
const DRAW_PREFIX = switchWord('нарисуй|draw');

/**
 * Третье слово-переключатель: «/гем скажи ...» — ответ голосом.
 *
 * Без текста после слова озвучивается последняя реплика бота: чаще всего
 * это и нужно — прочитал ответ, захотел послушать.
 */
const SPEAK_PREFIX = switchWord('скажи|say');

/**
 * Четвёртое слово-переключатель: «/гем найди ...» — поиск по переписке
 * раздела. Ищет по смыслу, а не по буквам (см. src/services/search-index.ts).
 */
const SEARCH_PREFIX = switchWord('найди|найти|find');

/**
 * Та же команда, но в подписи к фотографии: «/гем что здесь написано».
 * Латинская и кириллическая формы вместе — в подписи Telegram не размечает
 * команды, так что разбираем обе одинаково, обычным текстом.
 */
const MEDIA_COMMAND = /^\/(?:гем|gem)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

/**
 * Те же слова, но без восклицательного знака. Ловим их не чтобы выполнить,
 * а чтобы подсказать: человек, привыкший к прежнему синтаксису, иначе решит,
 * что рисование сломалось. Ответ на вопрос он при этом всё равно получит.
 */
const FORGOTTEN_BANG = /^(?:нарисуй|draw|контекст|context|скажи|say|найди|найти|find)(?:[\s,:.—–-]|$)/i;

/** Что спросить у модели, если картинку прислали вообще без подписи. */
const DEFAULT_IMAGE_PROMPT = 'Что на этой картинке? Опиши кратко и по делу.';

/** Единая обработка ошибок нейросетей: пользователю — подсказка, в лог — детали. */
async function replyWithError(ctx: BotContext, error: unknown): Promise<void> {
  if (error instanceof ProviderNotConfiguredError) {
    await ctx.reply(
      ['🔌 Нейросеть не подключена. Чтобы включить её, добавьте ключи в .env:', '', ...error.hints.map((hint) => '• ' + hint)].join(
        '\n',
      ),
    );
    return;
  }

  if (error instanceof ProviderRequestError) {
    logger.warn('Ошибка провайдера', { provider: error.provider, message: error.message });
    await ctx.reply(`⚠️ ${error.message}`);
    return;
  }

  logger.error('Непредвиденная ошибка при обращении к нейросети', {
    error: error instanceof Error ? error.message : String(error),
  });
  await ctx.reply('😔 Что-то пошло не так. Попробуйте ещё раз чуть позже.');
}

/**
 * Отправляет ответ нейросети с разметкой.
 *
 * Модель пишет обычный Markdown, а Telegram понимает свой ограниченный
 * набор тегов — конвертируем (см. src/format.ts). Если Telegram всё же
 * не принял разметку, повторяем отправку обычным текстом: пользователь
 * должен получить ответ в любом случае.
 */
async function sendMarkdown(ctx: BotContext, markdown: string): Promise<void> {
  for (const chunk of splitMarkdown(markdown)) {
    try {
      await ctx.reply(markdownToTelegramHtml(chunk), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      const isMarkupError =
        error instanceof GrammyError && /parse entities|unsupported start tag|can't find end/i.test(error.description);

      if (!isMarkupError) throw error;

      logger.warn('Telegram отклонил разметку, отправляю обычным текстом', {
        description: error.description,
      });
      await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
    }
  }
}

/**
 * Отрезает от истории последние N сообщений для отправки в модель.
 *
 * Тонкость: диалог обязан начинаться с реплики пользователя. Реплики
 * складываются парами, но при нечётном HISTORY_LIMIT окно может начаться
 * с ответа ассистента — модели семейства Gemma к такому порядку ролей
 * относятся строго и отвечают ошибкой. Лишнюю первую реплику отбрасываем.
 */
function takeHistory(history: ChatMessage[], limit: number): ChatMessage[] {
  if (limit <= 0) return [];
  const window = history.slice(-limit);
  return window[0]?.role === 'assistant' ? window.slice(1) : window;
}

/**
 * Общий сценарий «вопрос → ответ»: идём по цепочке моделей и отвечаем первым,
 * что получилось. Если ответила не первая модель, дописываем сноску — иначе
 * непонятно, почему ответ вдруг стал другого качества.
 */
async function askChain(
  ctx: BotContext,
  provider: TextProvider,
  models: string[],
  prompt: string,
  attachments: Attachment[] = [],
  /**
   * Что записать в историю вместо prompt. Нужно там, где к запросу подмешан
   * служебный контекст: цитата реплики, на которую человек ответил. В историю
   * она попасть не должна — бот и так помнит собственные слова, а дубли
   * съедают и место, и внимание модели.
   */
  historyText?: string,
): Promise<boolean> {
  try {
    // Историю передаём укороченной: длинный контекст = дороже и медленнее.
    const history = takeHistory(ctx.session.history, config.ai.historyLimit);
    // Промпт раздела перекрывает общий, если его задали командой /режим.
    const systemPrompt = ctx.session.systemPrompt || undefined;

    // Пока модель думает, показываем «печатает…».
    const answer = await withChatAction(ctx, 'typing', () =>
      generateWithChain(provider, models, prompt, { history, attachments, systemPrompt }),
    );

    if (config.ai.historyLimit > 0) {
      // В историю попадает только текст: картинки повторно не пересылаются,
      // иначе каждый следующий вопрос тащил бы за собой все прежние вложения.
      // Контекст при этом не теряется — что было на снимке, модель описала
      // в своём же ответе, а он в истории есть.
      ctx.session.history.push({ role: 'user', text: historyText ?? prompt }, { role: 'assistant', text: answer.text });
      // Ответы бота идут в архив поиска наравне с репликами людей: в них
      // половина полезного, что вообще было сказано в разделе. Ссылки на них
      // не будет — id сообщения станет известен только после отправки.
      const key = sessionKey(ctx);
      if (key) rememberMessage(key, { ts: Date.now(), who: 'бот', text: answer.text });
      // Держим в памяти только последние N сообщений.
      ctx.session.history = ctx.session.history.slice(-config.ai.historyLimit);
    }

    await sendMarkdown(ctx, answer.text);

    if (answer.skipped.length > 0) {
      await ctx.reply(
        `<i>Отвечала запасная модель <code>${escapeHtml(answer.model)}</code>: ` +
          `${answer.skipped.length === 1 ? 'основная была недоступна' : 'предыдущие были недоступны'}.</i>`,
        { parse_mode: 'HTML' },
      );
    }

    return true;
  } catch (error) {
    await replyWithError(ctx, error);
    return false;
  }
}

/**
 * Отдаёт провайдер Gemini, если он готов работать, и сам объясняет
 * пользователю причину, если нет.
 */
async function requireGemini(ctx: BotContext): Promise<TextProvider | null> {
  const gemini = findTextProvider(GEMINI_ID);

  if (!gemini) {
    await ctx.reply('⚠️ Провайдер Gemini не зарегистрирован в боте.');
    return null;
  }
  if (!gemini.isConfigured) {
    await ctx.reply(`🔌 Gemini не подключён.\n\n• ${gemini.setupHint}`);
    return null;
  }

  return gemini;
}

/** Берёт текст запроса из аргументов команды либо из сообщения, на которое ответили. */
function extractPrompt(ctx: BotContext, args: string): string {
  return args.trim() || ctx.message?.reply_to_message?.text?.trim() || '';
}

/**
 * Обработчик /гем и /gem.
 *
 * По умолчанию работает цепочкой, выбранной для раздела командой /режим.
 * Если запрос начинается со слова «контекст» (или «context»), вместо неё берётся
 * сильная цепочка — какой бы режим в разделе ни стоял. Дневная норма у этих
 * моделей небольшая, поэтому переключение всегда явное.
 */
async function handleGemini(ctx: BotContext, rawPrompt: string): Promise<void> {
  const trimmed = rawPrompt.trim();

  /**
   * Реплай на фотографию. Картинки в этом сообщении нет — она в том, на которое
   * ответили, — поэтому обработчик снимков сюда не добирается, и выкачивать её
   * приходится отдельно.
   *
   * Ветка забирает и пустой запрос («/гем» реплаем на фото — «что тут?»),
   * и «!где» с рамками, и любой вопрос про снимок. А вот «!нарисуй», «!скажи»,
   * «!найди» и «!контекст» пропускает дальше: они про своё, и то, что рядом
   * оказалась фотография, ничего в них не меняет.
   */
  const repliedPhoto = pickPhotoFileId(ctx.message?.reply_to_message?.photo ?? []);
  const ownsPhoto =
    repliedPhoto &&
    !DRAW_PREFIX.test(trimmed) &&
    !SPEAK_PREFIX.test(trimmed) &&
    !SEARCH_PREFIX.test(trimmed) &&
    !CONTEXT_PREFIX.test(trimmed);

  if (repliedPhoto && ownsPhoto) {
    await handleRepliedPhoto(ctx, repliedPhoto, rawPrompt);
    return;
  }

  if (!rawPrompt) {
    await ctx.reply(
      'Напишите запрос после команды. Например:\n' +
        '<code>/гем объясни рекурсию за три предложения</code>\n\n' +
        'Слова с восклицательным знаком меняют поведение:\n' +
        '<code>/гем !контекст почему этот SQL висит</code> — модель посильнее\n' +
        '<code>/гем !нарисуй кота-космонавта</code> — картинка вместо текста\n' +
        '<code>/гем !скажи привет</code> — ответ голосом\n' +
        '<code>/гем !найди где обсуждали деплой</code> — поиск по переписке\n\n' +
        'Ещё можно ответить командой <code>/гем</code> на любое сообщение — я возьму его текст, ' +
        'а если это фотография, разберу её.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // «!где» без снимка объяснить нечем: показывать не на чем. Молча отвечать
  // текстом было бы хуже всего — человек решит, что рамки сломались.
  if (!repliedPhoto && WHERE_PREFIX.test(trimmed)) {
    await ctx.reply(
      '«!где» работает по фотографии: пришлите её с такой подписью ' +
        'либо ответьте этой командой на уже отправленный снимок.',
    );
    return;
  }

  // «нарисуй» уводит запрос в совсем другую ветку — проверяем его первым.
  const draw = DRAW_PREFIX.exec(rawPrompt.trim());
  if (draw) {
    // Уточняющие вопросы задаёт бесплатный Gemini на своей лёгкой цепочке —
    // платит бот только за саму картинку (см. src/commands/draw.ts).
    try {
      await startDraw(ctx, (draw[1] ?? '').trim());
    } catch (error) {
      await replyWithError(ctx, error);
    }
    return;
  }

  const search = SEARCH_PREFIX.exec(rawPrompt.trim());
  if (search) {
    await handleSearch(ctx, (search[1] ?? '').trim());
    return;
  }

  const speak = SPEAK_PREFIX.exec(rawPrompt.trim());
  if (speak) {
    await handleSpeak(ctx, (speak[1] ?? '').trim());
    return;
  }

  const think = CONTEXT_PREFIX.exec(rawPrompt.trim());
  const prompt = think ? (think[1] ?? '').trim() : rawPrompt;

  if (think && !prompt) {
    await ctx.reply(
      'После «!контекст» нужна сама задача. Например:\n' +
        '<code>/гем !контекст почему этот SQL висит на большой таблице</code>\n\n' +
        'Эти модели сильнее, но их дневная норма невелика — для обычных вопросов ' +
        'хватает просто <code>/гем</code>.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const chain = think ? resolveChain(THINK_CHAIN) : resolveChain(ctx.session.chainId);
  const answered = await askChain(ctx, gemini, chain.models, prompt);

  // Запрос начался со слова-переключателя, но без «!». Отвечаем как на обычный
  // вопрос — человек, скорее всего, его и задавал, — но подсказываем синтаксис:
  // иначе тот, кто действительно хотел нарисовать, решит, что бот сломался.
  if (answered && FORGOTTEN_BANG.test(prompt)) {
    const word = prompt.split(/[\s,:.—–-]/)[0]!.toLowerCase();
    await ctx.reply(
      `<i>Если это была команда, а не вопрос, — она пишется с восклицательным знаком: ` +
        `<code>/гем !${escapeHtml(word)} …</code></i>`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Ссылка на сообщение в чате.
 *
 * У приватных супергрупп (а форум — всегда супергруппа) публичной ссылки нет,
 * но есть внутренняя: t.me/c/<id без префикса -100>/<id сообщения>. В личке
 * ссылаться не на что и незачем — там и так всё рядом.
 */
function messageLink(chatId: number, messageId: number | undefined): string | null {
  if (messageId === undefined || chatId >= 0) return null;
  return `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${messageId}`;
}

/** Дата находки человеческим языком: «14 августа, 16:12». */
function formatWhen(ts: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.imageQuota.timezone,
  }).format(new Date(ts));
}

/**
 * Поиск по переписке раздела: «/гем найди ...».
 *
 * Ищет по смыслу: «где мы обсуждали выкатку» находит разговор про деплой,
 * даже если слова «выкатка» там не было.
 */
async function handleSearch(ctx: BotContext, query: string): Promise<void> {
  if (!query) {
    await ctx.reply(
      'Напишите, что искать:\n<code>/гем найди где мы обсуждали деплой</code>\n\n' +
        'Я ищу по смыслу, а не по точным словам, и только по этому разделу.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (!config.search.enabled) {
    await ctx.reply('🔍 Поиск по переписке выключен (SEARCH_ENABLED=false).');
    return;
  }

  const key = sessionKey(ctx);
  if (!key) return;

  try {
    const hits = await withChatAction(ctx, 'typing', () => searchMessages(key, query));

    if (hits.length === 0) {
      await ctx.reply(
        '🔍 Ничего похожего не нашлось.\n\n' +
          '<i>Я ищу только по этому разделу и только по тому, что было сказано после ' +
          'включения поиска: задним числом переписка не индексируется.</i>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const chatId = ctx.chat?.id ?? 0;
    const lines = hits.map((hit) => {
      const link = messageLink(chatId, hit.messageId);
      const when = formatWhen(hit.ts);
      const snippet = escapeHtml(hit.text.slice(0, 300)) + (hit.text.length > 300 ? '…' : '');
      const head = link ? `<a href="${link}">${when}</a>` : when;

      return `${head}, ${escapeHtml(hit.who)}:\n${snippet}`;
    });

    await ctx.reply(`🔍 <b>Нашёл по смыслу:</b>\n\n${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Обрезает текст до разумной длины по границе предложения.
 *
 * Резать на полуслове неприятно на слух: голос обрывается посреди фразы,
 * и непонятно, кончилась мысль или сломался бот.
 */
function trimForSpeech(text: string, limit: number): { text: string; trimmed: boolean } {
  if (text.length <= limit) return { text, trimmed: false };

  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));

  return { text: lastStop > limit / 3 ? cut.slice(0, lastStop + 1) : cut, trimmed: true };
}

/**
 * Озвучка: «/гем скажи ...».
 *
 * Без текста берётся последний ответ бота из истории раздела — обычно
 * человек как раз его и хочет послушать, а переписывать его руками глупо.
 */
async function handleSpeak(ctx: BotContext, request: string): Promise<void> {
  // Что озвучивать, по убыванию определённости:
  //   1. текст после «!скажи» — сказано прямо, спорить не о чем;
  //   2. сообщение, на которое ответили реплаем, — показано пальцем.
  //      Причём любое, не только своё: попросить озвучить чужую реплику
  //      так же естественно, как свою;
  //   3. последний ответ бота в разделе — «прочитай, что ты там написал».
  const replyTo = ctx.message?.reply_to_message;
  const quoted = (replyTo?.text ?? replyTo?.caption ?? '').trim();
  const lastAnswer = [...ctx.session.history].reverse().find((message) => message.role === 'assistant')?.text;
  const source = request || quoted || lastAnswer || '';

  if (!source) {
    await ctx.reply(
      'Напишите, что произнести:\n<code>/гем !скажи привет, коллеги</code>\n\n' +
        'Или ответьте этой командой на сообщение — озвучу его. Без того и другого ' +
        'я читаю свой последний ответ, но в этом разделе я ещё ничего не отвечал.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Разметка Markdown на слух превращается в мусор: «звёздочка жирный звёздочка».
  const plain = source.replace(/[*_`#>]/g, '').replace(/\[([^\]]+)]\([^)]+\)/g, '$1');
  const { text, trimmed } = trimForSpeech(plain.trim(), config.tts.maxChars);

  try {
    const speech = await withChatAction(ctx, 'record_voice', () => synthesizeSpeech(text));

    const notes = [
      speech.skipped.length > 0 ? 'озвучивала запасная модель' : '',
      trimmed ? `прочитано ${text.length} знаков из ${plain.length}` : '',
    ].filter(Boolean);
    const caption = notes.length > 0 ? `🔊 ${notes.join(', ')}` : undefined;

    // Настоящее голосовое Telegram принимает только в OGG/Opus. Без ffmpeg
    // отдаём WAV обычным аудиофайлом — играется так же, выглядит иначе.
    if (speech.isVoice) {
      await ctx.replyWithVoice(new InputFile(speech.data, 'speech.ogg'), caption ? { caption } : {});
    } else {
      await ctx.replyWithAudio(new InputFile(speech.data, 'speech.wav'), {
        title: 'Озвучка',
        ...(caption ? { caption } : {}),
      });
    }
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Решает, обращались ли фотографией к боту, и достаёт из подписи вопрос.
 *
 * В группе у бота отключён privacy mode (иначе не работает /гем), то есть он
 * видит вообще все картинки в чате. Отвечать на каждую нельзя — бот вклинивался
 * бы в любую беседу. Поэтому в группе нужен явный признак обращения: команда
 * в подписи либо ответ на сообщение самого бота. В личке признак не нужен.
 */
function resolveImageRequest(ctx: BotContext, caption: string): { prompt: string } | null {
  const match = MEDIA_COMMAND.exec(caption.trim());

  // «/гем@другой_бот» в общем чате — не наше дело.
  const addressee = match?.[1];
  if (addressee && addressee.toLowerCase() !== ctx.me.username.toLowerCase()) return null;

  const repliesToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  const isPrivate = ctx.chat?.type === 'private';

  if (!isPrivate && !match && !repliesToBot) return null;

  // С командой берём остаток подписи, без команды — всю подпись целиком.
  const asked = (match ? (match[2] ?? '') : caption).trim();
  return { prompt: asked || DEFAULT_IMAGE_PROMPT };
}

/**
 * Команда реплаем на чужую (или свою) фотографию: «/гем !где здесь клапан»,
 * «/гем что тут написано».
 *
 * Отдельная ветка нужна из-за того, как устроен Telegram: в таком сообщении
 * самой картинки нет, есть только ссылка на неё в reply_to_message. Обработчик
 * снимков ждёт фото в текущем сообщении и потому не срабатывал вовсе, а запрос
 * уходил в модель голым текстом — она честно отвечала словами про несуществующий
 * снимок. Поэтому картинку выкачиваем отсюда сами.
 */
async function handleRepliedPhoto(ctx: BotContext, fileId: string, rawPrompt: string): Promise<void> {
  const gemini = findTextProvider(GEMINI_ID);
  if (!gemini?.isConfigured) {
    await ctx.reply('🔌 Gemini не подключён — разбирать картинки некому.');
    return;
  }

  try {
    const image = await withChatAction(ctx, 'typing', () => downloadAttachment(ctx, fileId));

    const where = WHERE_PREFIX.exec(rawPrompt.trim());
    if (where && image.mimeType === 'image/jpeg') {
      await handlePointing(ctx, image, (where[1] ?? '').trim());
      return;
    }

    const prompt = rawPrompt.trim() || DEFAULT_IMAGE_PROMPT;
    await askChain(ctx, gemini, resolveChain(ctx.session.chainId).models, prompt, [image]);
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Ответ реплаем на сообщение бота — продолжение разговора, а не новый запрос.
 *
 * Раньше на такую реплику бот в группе молчал, а в личке предлагал
 * «использовать команду»: формально верно, по-человечески глупо. Если человек
 * отвечает именно на реплику бота, обращение очевидно и без команды.
 *
 * Цитату подмешиваем в запрос, но не в историю. Во-первых, отвечать могут
 * на давнее сообщение, которое из истории уже вытеснено. Во-вторых, в живом
 * топике у бота десяток реплик подряд, и без цитаты непонятно, какую именно
 * имеют в виду.
 */
async function handleReplyToBot(ctx: BotContext, text: string, quoted: string): Promise<void> {
  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const prompt = quoted
    ? `Пользователь отвечает на твою реплику:\n«${quoted.slice(0, 700)}»\n\nЕго ответ: ${text}`
    : text;

  await askChain(ctx, gemini, resolveChain(ctx.session.chainId).models, prompt, [], text);
}

/**
 * Подпись к фотографии вида «/гем !где здесь клапан» — просьба показать,
 * а не рассказать. Уводит снимок в отдельную ветку с рамками.
 */
const WHERE_PREFIX = switchWord('где(?:\\s+(?:здесь|тут|на\\s+фото|на\\s+картинке))?|where');

/**
 * «Где здесь ...»: находит предметы на фотографии и обводит их рамками.
 *
 * Отдельно от обычного разбора картинки, потому что задача другая. Обычная
 * модель расскажет, что на снимке; эта — покажет, где именно, вернув
 * координаты (см. src/services/pointing.ts).
 */
async function handlePointing(ctx: BotContext, image: Attachment, query: string): Promise<void> {
  try {
    const found = await withChatAction(ctx, 'upload_photo', () => findObjects(image, query));

    if (found.length === 0) {
      await ctx.reply(`🔍 Не нашёл на фотографии: ${escapeHtml(query)}`, { parse_mode: 'HTML' });
      return;
    }

    const marked = drawBoxes(image.data, found);
    const legend = found
      .map((object, index) => `${BOX_COLORS[index % BOX_COLORS.length]!.name} — ${object.label}`)
      .join('\n');

    await ctx.replyWithPhoto(new InputFile(marked, 'found.jpg'), {
      caption: `🔍 ${query}\n\n${legend}`,
    });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/** Скачивает картинки и отправляет их в модель вместе с вопросом. */
async function handlePhotos(ctx: BotContext, fileIds: string[], caption: string): Promise<void> {
  const request = resolveImageRequest(ctx, caption);
  if (!request) return;

  const gemini = findTextProvider(GEMINI_ID);
  if (!gemini?.isConfigured) {
    await ctx.reply('🔌 Gemini не подключён — разбирать картинки некому.');
    return;
  }

  try {
    const attachments = await withChatAction(ctx, 'typing', () =>
      Promise.all(fileIds.map((fileId) => downloadAttachment(ctx, fileId))),
    );

    // «где здесь ...» — просьба показать, а не рассказать. Рамки рисуются
    // по первому снимку: обводить каждый кадр альбома человек не просил.
    const where = WHERE_PREFIX.exec(request.prompt.trim());
    const first = attachments[0];
    if (where && first && first.mimeType === 'image/jpeg') {
      await handlePointing(ctx, first, (where[1] ?? '').trim());
      return;
    }

    await askChain(ctx, gemini, resolveChain(ctx.session.chainId).models, request.prompt, attachments);
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

export function registerAiCommands(bot: Bot<BotContext>): void {
  // ------------------------------------------------------- /gem и /гем
  bot.command('gem', async (ctx) => {
    await handleGemini(ctx, extractPrompt(ctx, ctx.match));
  });

  bot.hears(CYRILLIC_GEM, async (ctx) => {
    // ctx.match для регулярки — результат exec; для строкового триггера это string.
    const match = typeof ctx.match === 'string' ? null : ctx.match;
    const addressee = match?.[1];

    // В группе может быть несколько ботов: /гем@другой_бот — не наше дело.
    if (addressee && addressee.toLowerCase() !== ctx.me.username.toLowerCase()) return;

    await handleGemini(ctx, extractPrompt(ctx, match?.[2] ?? ''));
  });

  // ---------------------------------------------------------------- /reset
  bot.command('reset', async (ctx) => {
    const removed = ctx.session.history.length;
    ctx.session.history = [];
    await ctx.reply(`🧹 История диалога очищена (было сообщений: ${removed}). Начинаем с чистого листа.`);
  });

  // ------------------------------------------------------------ картинки
  // Альбом Telegram присылает несколькими апдейтами с общим media_group_id:
  // копим их и отправляем в модель одним запросом, иначе на альбом из пяти
  // снимков прилетело бы пять отдельных ответов.
  bot.on('message:photo', async (ctx) => {
    const fileId = pickPhotoFileId(ctx.message.photo);
    if (!fileId) return;

    const caption = ctx.message.caption ?? '';
    const albumId = ctx.message.media_group_id;

    if (albumId) {
      collectAlbumPart(ctx, albumId, fileId, caption, handlePhotos);
      return;
    }

    await handlePhotos(ctx, [fileId], caption);
  });

  // --------------------------------------------------- обычные сообщения
  // Регистрируется последним: сюда попадает всё, что не разобрали
  // предыдущие обработчики.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const replyTo = ctx.message.reply_to_message;

    // Ответ реплаем на реплику бота — продолжение разговора. Команда здесь
    // не нужна: обращение и так очевидно, причём и в группе тоже. Это
    // единственный случай, когда бот отвечает в группе на обычный текст.
    if (replyTo?.from?.id === ctx.me.id && text && !text.startsWith('/')) {
      await handleReplyToBot(ctx, text, (replyTo.text ?? replyTo.caption ?? '').trim());
      return;
    }

    // В остальном в группах бот молчит на обычные сообщения: обращаться
    // к нему нужно командой. Иначе он вклинивался бы в каждую беседу.
    if (ctx.chat.type !== 'private') return;

    if (text.startsWith('/')) {
      await ctx.reply('🤔 Не знаю такую команду. Список всех команд — /help');
      return;
    }

    // Свободный текст запросом не считается — это осознанное решение,
    // чтобы случайные сообщения не тратили квоту нейросети.
    await ctx.reply('Чтобы спросить нейросеть, используйте команду. Например:\n/гем ' + text.slice(0, 100));
  });
}

/**
 * Базовые и тестовые команды бота.
 *
 * Сюда собрано всё, что не требует обращения к нейросетям:
 * приветствие, справка и «пинг-понг»-команды в стиле Марко-Поло,
 * которыми удобно проверять, что бот вообще жив и получает апдейты.
 */
import { GrammyError, type Bot } from 'grammy';
import { config, isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { describeProviders, resolveTextProvider } from '../services/registry.js';
import { escapeHtml } from '../format.js';
import { formatDuration } from '../utils.js';
import type { BotContext } from '../types.js';

/**
 * Текст справки — используется в /start и /help.
 *
 * Главное здесь — порядок. Сверху то, за чем приходят каждый день: спросить,
 * нарисовать, озвучить. Ниже — правило про восклицательный знак, без которого
 * половина команд «не работает». В самом низу, под свёрнутыми цитатами, всё
 * остальное: подробности про файлы и проверочные команды. Их читают раз
 * в месяц, а места в сообщении они занимали столько же, сколько нужное.
 *
 * Всё это обязано уместиться в одно сообщение — 4096 знаков вместе с тегами
 * (см. HELP_LIMIT ниже). Поэтому подробности написаны плотно: добавляя сюда
 * строку, проверьте, что не выходите за потолок, иначе справка поедет
 * частями. Место экономится словами, а не выбрасыванием команд: команда,
 * которой нет в справке, для группы не существует.
 *
 * Про «мельче шрифтом»: размеров шрифта в Telegram нет вовсе. Второстепенное
 * поэтому уводится не размером, а весом — курсивом и свёрнутой цитатой
 * <blockquote expandable>, которая показывает одну строку и раскрывается
 * по нажатию. Спойлер для этого не годится: он замазывает текст, будто там
 * тайна, — а тут просто подробности.
 *
 * Про <code> и <i> в строках команд: в моноширинный кусок попадает ровно то,
 * что нужно скопировать, — команда со словом-переключателем и ничего больше.
 * Telegram копирует такой кусок по нажатию целиком, и раньше вместе с
 * «/гем !контекст» человек уносил в строку ввода слово «задача», которое там
 * не нужно и которое ещё надо заметить и стереть. Место аргумента поэтому
 * стоит рядом курсивом: видно, что писать дальше, но в буфер оно не попадёт.
 */
const HELP_TEXT = [
  '🤖 <b>Я отвечаю нейросетью</b> — на вопросы, по картинкам и по присланным файлам.',
  'Ещё рисую, пишу песни, озвучиваю, слушаю голосовые, ищу по переписке и в интернете.',
  '',
  '<b>Главное</b>',
  '<code>/гем</code> <i>вопрос</i> — спросить. Латиницей то же самое: <code>/gem</code>',
  '<code>/гем !контекст</code> <i>задача</i> — модель посильнее, разбор подробный',
  `<code>/гем !нарисуй</code> <i>описание</i> — картинка (${config.imageQuota.perUserPerDay} в день)`,
  '<code>/гем !скажи</code> <i>«мужской» текст</i> — озвучить; в кавычках — голос и манера',
  `<code>/гем !трек</code> <i>описание</i> — песня с вокалом (${config.trackQuota.perUserPerDay} в день)`,
  `<code>/гем !сеть</code> <i>вопрос</i> — поиск в интернете (${config.webQuota.perUserPerDay} в день)`,
  `<code>/гем !размышление</code> <i>вопрос</i> — долгое размышление (${config.deepQuota.perUserPerDay} в день)`,
  '<code>/гем !файл</code> <i>что сделать</i> — ответ файлом: md, txt, html и другие',
  '<code>/гем !расшифруй</code> реплаем на голосовое — послушаю и отвечу',
  '<code>/гем !расшифруй в текст</code> реплаем — выпишу сказанное дословно',
  '',
  '<b>❗ Восклицательный знак обязателен</b>',
  '<code>/гем</code> <i>скажи, что такое рекурсия</i> — <i>это вопрос</i>',
  '<code>/гем !скажи</code> <i>что такое рекурсия</i> — <i>это озвучка</i>',
  '',
  '<i>Картинку или файл можно просто прислать — разберу. В группе добавьте подпись</i>',
  '<i>с командой. На ответ реплаем моему сообщению отвечу и без команды.</i>',
  '',
  '<blockquote expandable><b>Подробности</b>',
  '',
  '<b>Картинки.</b> В группе нужна подпись к снимку: <code>/гем</code> <i>что здесь написано</i>.',
  'Подпись <code>/гем !где</code> <i>здесь клапан</i> — обведу найденное рамкой на фото.',
  'То же работает реплаем на уже отправленный снимок.',
  '',
  '<b>Файлы к разбору.</b> .txt, .fb2, .pdf, .md, .csv, .json, .xml, .srt — прочитаю',
  'и отвечу по нему, а без вопроса перескажу. Предел около 230 страниц.',
  '',
  '<b>Файлы от меня.</b> Формат — первым словом: <code>!файл html</code> <i>график продаж</i>.',
  'Есть md, txt, html, svg, csv, json, py, js, ts, sh, sql; без слова будет md.',
  'А <code>/гем !файл</code> реплаем выгрузит то сообщение, на которое вы ответили.',
  '',
  '<b>Длина ответа.</b> Обычный <code>/гем</code> отвечает по надобности: на простое —',
  'коротко, на сложное — подробно. <code>!контекст</code> разворачивается всегда.',
  'Не влезло в сообщение — пришлю файлом целиком, .md. Так с любым длинным ответом.',
  '',
  '<b>Голос от меня.</b> В кавычках перед текстом — <b>пол</b> (мужской, женский),',
  '<b>тембр</b> (низкий, высокий, бодрый, твёрдый, мягкий, яркий, уверенный)',
  'и <b>манера</b> словами: <code>«мужской, устало»</code>, <code>«высокий, как диктор новостей»</code>.',
  'Без текста прочитаю то, на что вы ответили, иначе — свой последний ответ.',
  '',
  '<b>Голос мне.</b> В личке просто наговорите. В группе — реплаем с <code>!расшифруй</code>',
  'или сразу с вопросом по записи. Расшифровку не печатаю: её и так все слышали, —',
  'отвечаю по сказанному. Нужен текст записи — <code>!расшифруй в текст</code>.',
  '',
  `<b>Песни.</b> Стиль и слова соберу сам, слова покажу сразу. Длительность словами`,
  `(«полминуты»), по умолчанию и не больше ${config.goapi.music.maxDuration} с. Без пения — скажите «инструментал».`,
  '',
  '<b>Поиск по переписке.</b> <code>/гем !найди</code> <i>что искать</i> — по нашей переписке',
  'в разделе, по смыслу, а не по буквам. Бесплатно и без нормы.',
  '',
  '<b>Себе в личные.</b> <code>/гем !личка</code> реплаем — пришлю то сообщение вам в личку:',
  'файл, снимок или текст. Нужно, чтобы вы хоть раз мне писали — первым я не могу.',
  '',
  '<b>Про платное.</b> <code>!сеть</code> ходит в интернет и даёт ссылки на источники,',
  'а <code>!размышление</code> думает над одним вопросом минуту-другую — без истории раздела,',
  'но со свежими страницами. Обе платные, отсюда и дневные нормы.</blockquote>',
  '',
  '<blockquote expandable><b>Проверка и служебное</b>',
  '',
  '/ping — задержка до Telegram',
  '/marco и /polo — отвечу «Polo!» и «Marco!»',
  '/test — связь и готовность нейросетей',
  '/test ai — то же плюс живой запрос',
  '/stop — замолчать в этом разделе, /start — включить обратно',
  '/whoami — ваши id пользователя и чата',
  '/status — аптайм, память, режим работы',
  '<code>/гем !лимиты</code> — сколько осталось от дневных норм',
  '/help — эта справка</blockquote>',
].join('\n');

/**
 * Та же справка без HTML-тегов — источник знаний бота о самом себе.
 *
 * Используется в src/commands/ai.ts: когда человек спрашивает не по делу,
 * а «что ты умеешь» или «как тобой пользоваться», модель получает этот текст
 * в подсказке вместо того, чтобы гадать или выдумывать несуществующие
 * команды. Отдельного файла-справочника не заводим: HELP_TEXT и так —
 * готовый, выверенный и всегда актуальный список команд, дублировать его
 * было бы источником рассинхрона.
 */
export const HELP_TEXT_PLAIN = HELP_TEXT.replace(/<[^>]+>/g, '');

/**
 * Потолок одного сообщения справки.
 *
 * У Telegram это 4096 знаков, и здесь можно брать почти вплотную: справка
 * уже написана HTML-ом, а теги в лимит не входят — считаем мы строку целиком,
 * то есть с запасом в свою же пользу. Это не MESSAGE_LIMIT: тот скромнее
 * ровно потому, что там разметка ещё превратится в теги и текст подрастёт.
 */
const HELP_LIMIT = 4000;

/**
 * Делит справку на неделимые куски: раздел или свёрнутая цитата целиком.
 *
 * Цитата неделима не из эстетики: разорванный <blockquote> — это незакрытый
 * тег, то есть Telegram откажет в разметке и справки не будет вовсе.
 */
function helpUnits(text: string): string[] {
  const units: string[] = [];
  let quote: string[] = [];

  for (const block of text.split('\n\n')) {
    if (quote.length > 0) {
      quote.push(block);
      if (block.includes('</blockquote>')) {
        units.push(quote.join('\n\n'));
        quote = [];
      }
      continue;
    }

    if (block.includes('<blockquote') && !block.includes('</blockquote>')) {
      quote = [block];
      continue;
    }

    units.push(block);
  }

  // Цитату забыли закрыть — отдаём как есть: чинить разметку не наше дело,
  // а потерять кусок справки хуже.
  if (quote.length > 0) units.push(quote.join('\n\n'));

  return units;
}

/**
 * Разрезает одну слишком длинную цитату, повторяя её открывающий тег.
 *
 * Случай запасной: сегодня самая большая цитата — 3400 знаков из 4000,
 * но справка растёт с каждой командой, и однажды перерастёт. Пусть тогда
 * приедет двумя цитатами, а не ошибкой.
 */
function splitQuote(unit: string, limit: number): string[] {
  const open = /^<blockquote[^>]*>/.exec(unit)?.[0];
  if (!open || !unit.endsWith('</blockquote>')) return [unit];

  const inner = unit.slice(open.length, -'</blockquote>'.length);
  const room = limit - open.length - '</blockquote>'.length;
  const parts: string[] = [];
  let current: string[] = [];

  for (const block of inner.split('\n\n')) {
    if (current.length > 0 && current.join('\n\n').length + block.length + 2 > room) {
      parts.push(`${open}${current.join('\n\n')}</blockquote>`);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) parts.push(`${open}${current.join('\n\n')}</blockquote>`);

  return parts;
}

/**
 * Режет справку на сообщения — страховка, а не обычный путь.
 *
 * Справка обязана быть одним сообщением: читают её сплошь, и разорванная
 * пополам она сразу теряет вид. Но однажды текст дорос до 5224 знаков при
 * потолке в 4096, и Telegram ответил «message is too long» — то есть /help
 * не укоротился, а перестал приходить вовсе. Второй раз так попасться нельзя.
 *
 * Поэтому здесь два рубежа. Первый — сторож ниже: если справка переросла
 * сообщение, он скажет об этом в лог при запуске, и текст надо сократить.
 * Второй — это деление: пусть лучше приедет двумя сообщениями, чем не
 * приедет никак.
 *
 * Куски набираются жадно и только по границам разделов, снаружи цитат.
 */
function splitHelp(text: string, limit = HELP_LIMIT): string[] {
  const parts: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) parts.push(current.join('\n\n'));
    current = [];
  };

  for (const unit of helpUnits(text)) {
    for (const piece of unit.length > limit ? splitQuote(unit, limit) : [unit]) {
      if (current.length > 0 && current.join('\n\n').length + piece.length + 2 > limit) flush();
      current.push(piece);
    }
  }

  flush();
  return parts.filter((part) => part.trim().length > 0);
}

/**
 * Сторож длины: справка должна оставаться одним сообщением.
 *
 * Проверяется при запуске, а не при первом /help: узнать о том, что справка
 * переросла потолок, лучше из своего лога, чем от человека, которому она
 * приехала двумя кусками.
 */
if (HELP_TEXT.length > HELP_LIMIT) {
  logger.warn('Справка переросла одно сообщение и будет приходить частями — её пора сократить', {
    chars: HELP_TEXT.length,
    limit: HELP_LIMIT,
  });
}

/**
 * Отправляет справку, а если клиент споткнулся о разметку — то же самое
 * обычной цитатой.
 *
 * Свёрнутые цитаты появились в Bot API не сразу, и на старом сервере Telegram
 * (или в самописном клиенте) атрибут expandable может оказаться незнакомым.
 * Остаться из-за этого совсем без справки было бы обиднее всего.
 */
async function sendHelp(ctx: BotContext, prefix = ''): Promise<void> {
  const send = async (text: string): Promise<void> => {
    for (const part of splitHelp(text)) {
      await ctx.reply(part, { parse_mode: 'HTML' });
    }
  };

  try {
    await send(prefix + HELP_TEXT);
  } catch (error) {
    const isMarkupError =
      error instanceof GrammyError && /parse entities|unsupported start tag|can't find end/i.test(error.description);

    if (!isMarkupError) throw error;

    logger.warn('Telegram не принял свёрнутые цитаты в справке, отправляю обычными', {
      description: error instanceof GrammyError ? error.description : '',
    });
    await send(prefix + HELP_TEXT.replace(/<blockquote expandable>/g, '<blockquote>'));
  }
}

/**
 * Кириллические двойники выключателя: /стоп, /старт и их разговорные формы.
 *
 * Telegram считает командой только латиницу, поэтому /стоп в меню не попадёт
 * и командой размечен не будет — ловим его текстом, ровно как /гем
 * (см. commands/ai.ts). Имя бота после команды допускается: в группе клиент
 * подставляет его сам.
 */
const CYRILLIC_STOP = /^\/(?:стоп|выключись)(?:@[A-Za-z0-9_]+)?\s*$/i;
const CYRILLIC_START = /^\/(?:старт|включись)(?:@[A-Za-z0-9_]+)?\s*$/i;

/**
 * Выключает бота в разделе. Кто именно выключил — говорим вслух: в группе
 * замолчавший бот иначе выглядит сломавшимся, и разбираться пойдут все сразу.
 */
async function muteHere(ctx: BotContext): Promise<void> {
  const who = escapeHtml(ctx.from?.first_name ?? 'кто-то');

  if (ctx.session.muted) {
    await ctx.reply('🔇 Я и так молчу в этом разделе. Включить обратно — /start');
    return;
  }

  ctx.session.muted = true;
  logger.info('Бот выключен в разделе', { chatId: ctx.chat?.id, userId: ctx.from?.id });

  await ctx.reply(
    `🔇 Молчу в этом разделе — выключил <b>${who}</b>.\n\n` +
      'Здесь я больше не отвечаю, не трачу квоты и не записываю переписку в архив поиска. ' +
      'Остальные разделы работают как работали.\n\n' +
      'Включить обратно — /start, и это может сделать любой.',
    { parse_mode: 'HTML' },
  );
}

/**
 * Включает бота обратно. Совмещено с приветствием намеренно: «запустить
 * бота» — это ровно то, что /start и означает, отдельная команда была бы
 * четвёртым словом, которое надо помнить.
 *
 * Полную справку при пробуждении не показываем: её только что не спрашивали,
 * а она на два экрана.
 */
async function unmuteHere(ctx: BotContext): Promise<void> {
  const name = escapeHtml(ctx.from?.first_name ?? 'друг');

  if (ctx.session.muted) {
    ctx.session.muted = false;
    logger.info('Бот включён в разделе', { chatId: ctx.chat?.id, userId: ctx.from?.id });

    await ctx.reply(`🔊 Снова здесь — включил <b>${name}</b>. Справка: /help`, { parse_mode: 'HTML' });
    return;
  }

  await sendHelp(ctx, `👋 Привет, <b>${name}</b>!\n\n`);
}

export function registerBasicCommands(bot: Bot<BotContext>): void {
  // -------------------------------------------------------- /start и /stop
  // Пара «выключить — включить» на раздел. Прав ни у кого не спрашиваем:
  // нажать может любой участник (почему — см. middlewares/mute.ts).
  bot.command('start', unmuteHere);
  bot.command('stop', muteHere);
  bot.hears(CYRILLIC_START, unmuteHere);
  bot.hears(CYRILLIC_STOP, muteHere);

  // ----------------------------------------------------------------- /help
  bot.command('help', async (ctx) => {
    await sendHelp(ctx);
  });

  // ----------------------------------------------------------------- /ping
  // Отправляем сообщение и сразу его редактируем: разница во времени
  // и есть реальная задержка до Bot API (round-trip).
  bot.command('ping', async (ctx) => {
    const startedAt = Date.now();
    const message = await ctx.reply('🏓 Pong!');
    const latency = Date.now() - startedAt;

    await ctx.api.editMessageText(
      message.chat.id,
      message.message_id,
      `🏓 <b>Pong!</b>\nЗадержка до Telegram API: <b>${latency} мс</b>\nАптайм процесса: ${formatDuration(process.uptime() * 1000)}`,
      { parse_mode: 'HTML' },
    );
  });

  // ------------------------------------------------------- /marco и /polo
  // Простейший тест «команда → ответ»: если работает, значит апдейты
  // доходят до бота, а ответы — до Telegram.
  bot.command('marco', async (ctx) => {
    await ctx.reply('🌊 Polo!');
  });

  bot.command('polo', async (ctx) => {
    await ctx.reply('🏊 Marco!');
  });

  // Тот же тест, но на обычное сообщение без слэша: напишите «marco» — получите «Polo!».
  bot.hears(/^\s*marco[\s!.?]*$/i, async (ctx) => {
    await ctx.reply('🌊 Polo!');
  });
  bot.hears(/^\s*(поло|polo)[\s!.?]*$/i, async (ctx) => {
    await ctx.reply('🏊 Marco!');
  });

  // --------------------------------------------------------------- /whoami
  bot.command('whoami', async (ctx) => {
    const user = ctx.from;
    const lines = [
      '<b>Кто вы для бота</b>',
      `ID пользователя: <code>${user?.id ?? '—'}</code>`,
      `Username: ${user?.username ? '@' + escapeHtml(user.username) : '—'}`,
      `Имя: ${escapeHtml(user?.first_name ?? '—')}`,
      `Язык клиента: ${escapeHtml(user?.language_code ?? '—')}`,
      '',
      `ID чата: <code>${ctx.chat?.id ?? '—'}</code>`,
      `Тип чата: ${ctx.chat?.type ?? '—'}`,
      `Права администратора бота: ${isAdmin(user?.id) ? 'да' : 'нет'}`,
      '',
      '<i>Чтобы стать админом, добавьте свой ID пользователя в ADMIN_IDS в .env и перезапустите бота.</i>',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // --------------------------------------------------------------- /status
  bot.command('status', async (ctx) => {
    const memory = process.memoryUsage();
    const lines = [
      '<b>Состояние сервиса</b>',
      `Окружение: <code>${config.nodeEnv}</code>`,
      `Аптайм: ${formatDuration(process.uptime() * 1000)}`,
      `Память (RSS): ${Math.round(memory.rss / 1024 / 1024)} МБ`,
      `Node.js: ${process.version}`,
      '',
      '<b>Провайдеры</b>',
      ...describeProviders().map(
        (provider) => `${provider.ready ? '✅' : '⚪️'} ${escapeHtml(provider.title)} — ${provider.kind}`,
      ),
      '',
      `Текст: <code>${escapeHtml(ctx.session.textProviderId)}</code>, ` +
        `картинки: <code>${escapeHtml(ctx.session.imageProviderId)}</code>`,
      `Сообщений в истории диалога: ${ctx.session.history.length}`,
    ];

    // Админам показываем чуть больше технических деталей.
    if (isAdmin(ctx.from?.id)) {
      lines.push(
        '',
        '<b>Только для админов</b>',
        `PID: <code>${process.pid}</code>`,
        `Лимит: ${config.rateLimit.max} запросов / ${Math.round(config.rateLimit.windowMs / 1000)} с`,
        `Таймаут запроса к ИИ: ${Math.round(config.ai.timeoutMs / 1000)} с`,
        `Уровень логов: <code>${config.logLevel}</code>`,
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // ----------------------------------------------------------------- /test
  // Самодиагностика. Без аргументов — быстрые проверки, с аргументом "ai" —
  // ещё и настоящий (короткий и дешёвый) запрос к текстовой нейросети.
  bot.command('test', async (ctx) => {
    const withAiCheck = ctx.match.trim().toLowerCase() === 'ai';
    const results: string[] = ['<b>Самодиагностика</b>', ''];

    // 1. Связь с Telegram Bot API.
    const startedAt = Date.now();
    try {
      const me = await ctx.api.getMe();
      results.push(`✅ Telegram API — ответил за ${Date.now() - startedAt} мс (я @${escapeHtml(me.username)})`);
    } catch (error) {
      results.push(`❌ Telegram API — ${error instanceof Error ? escapeHtml(error.message) : 'ошибка'}`);
    }

    // 2. Конфигурация провайдеров.
    for (const provider of describeProviders()) {
      results.push(
        provider.ready
          ? `✅ ${escapeHtml(provider.title)} — ключи на месте (${provider.kind})`
          : `⚪️ ${escapeHtml(provider.title)} — не настроен, команда будет недоступна`,
      );
    }

    // 3. Боевой запрос к текстовой модели (по флагу).
    if (withAiCheck) {
      const aiStartedAt = Date.now();
      try {
        const provider = resolveTextProvider(ctx.session.textProviderId);
        const answer = await provider.generateText('Ответь ровно одним словом: работает', {
          // Лимит с запасом: модели с «размышлениями» тратят сотни токенов
          // ещё до того, как начнут писать сам ответ.
          maxOutputTokens: 512,
          temperature: 0,
        });
        results.push(
          '',
          `✅ Живой запрос к «${escapeHtml(provider.title)}» за ${Date.now() - aiStartedAt} мс`,
          `Ответ модели: <i>${escapeHtml(answer.slice(0, 200))}</i>`,
        );
      } catch (error) {
        logger.warn('Самодиагностика: запрос к нейросети не удался', {
          error: error instanceof Error ? error.message : String(error),
        });
        results.push('', `❌ Живой запрос не прошёл: ${escapeHtml(error instanceof Error ? error.message : 'ошибка')}`);
      }
    } else {
      results.push('', '<i>Подсказка: /test ai — проверить нейросеть настоящим запросом.</i>');
    }

    await ctx.reply(results.join('\n'), { parse_mode: 'HTML' });
  });
}

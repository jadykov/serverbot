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
 * Про «мельче шрифтом»: размеров шрифта в Telegram нет вовсе. Второстепенное
 * поэтому уводится не размером, а весом — курсивом и свёрнутой цитатой
 * <blockquote expandable>, которая показывает одну строку и раскрывается
 * по нажатию. Спойлер для этого не годится: он замазывает текст, будто там
 * тайна, — а тут просто подробности.
 */
const HELP_TEXT = [
  '🤖 <b>Я отвечаю нейросетью</b> — на вопросы, по картинкам и по присланным файлам.',
  'Ещё рисую, пишу песни, озвучиваю, слушаю голосовые, ищу по переписке и в интернете.',
  '',
  '<b>Главное</b>',
  '<code>/гем вопрос</code> — спросить. Латиницей то же самое: <code>/gem</code>',
  '<code>/гем !контекст задача</code> — модель посильнее, для сложного',
  `<code>/гем !нарисуй описание</code> — картинка (платно, ${config.imageQuota.perUserPerDay} в день на человека)`,
  '<code>/гем !скажи текст</code> — озвучить голосом',
  `<code>/гем !трек описание</code> — песня с вокалом (платно, ${config.trackQuota.perUserPerDay} в день на человека)`,
  '<code>/гем !найди что искать</code> — поиск по переписке раздела, по смыслу',
  `<code>/гем !сеть вопрос</code> — поискать в интернете (платно, ${config.webQuota.perUserPerDay} в день на человека)`,
  '<code>/гем !файл что сделать</code> — прислать ответ файлом',
  '<code>/гем !расшифруй</code> реплаем на голосовое — послушаю и отвечу',
  '<code>/гем !личка</code> реплаем — переслать сообщение вам в личные',
  '',
  '<b>❗ Восклицательный знак обязателен</b>',
  '<code>/гем скажи, что такое рекурсия</code> — <i>это вопрос</i>',
  '<code>/гем !скажи что такое рекурсия</code> — <i>это озвучка</i>',
  '',
  '<i>Картинку или файл можно просто прислать — разберу. В группе добавьте подпись</i>',
  '<i>с командой. На ответ реплаем моему сообщению отвечу и без команды.</i>',
  '',
  '<blockquote expandable><b>Подробности: картинки, файлы, голоса</b>',
  '',
  '<b>Картинки.</b> Пришлите снимок — разберу, что на нём. В группе нужна подпись:',
  '<code>/гем что здесь написано</code>. Подпись <code>/гем !где здесь клапан</code> — обведу',
  'найденное рамкой прямо на фото. Всё это работает и реплаем на снимок.',
  '',
  '<b>Файлы к разбору.</b> Присылайте .txt, .fb2, .pdf, .md, .csv, .json, .xml, .srt —',
  'прочитаю и отвечу по нему, а без вопроса перескажу. Предел около 230 страниц.',
  '',
  '<b>Файлы от меня.</b> <code>/гем !файл смета на ремонт кухни</code> пришлёт .md,',
  '<code>/гем !файл html график продаж</code> — страницу, открывающуюся без интернета.',
  'Так же: txt, svg, csv, json, py, sql. А <code>/гем !файл</code> реплаем выгрузит',
  'в файл то сообщение, на которое вы ответили, — без обращения к нейросети.',
  '',
  '<b>Длинный ответ.</b> В чат я отвечаю одним сообщением. Нужен разбор целиком —',
  '<code>/гем !контекст md ваш вопрос</code>: тот же ответ приедет файлом.',
  'Вместо md можно txt или html.',
  '',
  '<b>Голосовые вам от меня.</b> <code>/гем !скажи «низкий» смена закончена</code>. В кавычках:',
  'мужской, женский, низкий, высокий, бодрый, твёрдый, мягкий, яркий, напористый,',
  'уверенный — или любая манера словами: <code>«шёпотом»</code>, <code>«как в Warcraft 3»</code>.',
  'Пол — только словом «мужской» или «женский»: манерой он не задаётся.',
  'Без текста прочитаю то, на что вы ответили, иначе — свой последний ответ.',
  '',
  '<b>Голосовые мне.</b> В личке просто наговорите — послушаю и отвечу. В группе',
  'ответьте на голосовое командой <code>/гем !расшифруй</code>, а если есть вопрос',
  'по записи — сразу им: <code>/гем что он просит сделать</code>. Расшифровку',
  'я не печатаю: её и так все слышали, — отвечаю по сказанному.',
  '',
  '<b>Песни.</b> <code>/гем !трек грустная песня про дедлайны, женский вокал</code> —',
  'пришлю музыку с пением. Стиль и слова соберу сам, слова покажу сразу,',
  'пока пишется музыка. Длительность можно назвать словами («полминуты»,',
  `«секунд десять»), по умолчанию и не больше ${config.goapi.music.maxDuration} с. Без вокала — скажите «инструментал».`,
  'Это платно, как и картинки, поэтому норма своя и небольшая.',
  '',
  '<b>Поиск в интернете.</b> <code>/гем !сеть что нового про Gemini 3</code> — отвечу',
  'по свежим страницам и снизу дам ссылки на источники. Не путать с <code>!найди</code>:',
  'та ищет по нашей переписке и бесплатна, а эта ходит в интернет и стоит денег,',
  'поэтому норма небольшая.</blockquote>',
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
  '/help — эта справка</blockquote>',
].join('\n');

/**
 * Отправляет справку, а если клиент споткнулся о разметку — то же самое
 * обычной цитатой.
 *
 * Свёрнутые цитаты появились в Bot API не сразу, и на старом сервере Telegram
 * (или в самописном клиенте) атрибут expandable может оказаться незнакомым.
 * Остаться из-за этого совсем без справки было бы обиднее всего.
 */
async function sendHelp(ctx: BotContext, prefix = ''): Promise<void> {
  try {
    await ctx.reply(prefix + HELP_TEXT, { parse_mode: 'HTML' });
  } catch (error) {
    const isMarkupError =
      error instanceof GrammyError && /parse entities|unsupported start tag|can't find end/i.test(error.description);

    if (!isMarkupError) throw error;

    logger.warn('Telegram не принял свёрнутые цитаты в справке, отправляю обычными', {
      description: error instanceof GrammyError ? error.description : '',
    });
    await ctx.reply(prefix + HELP_TEXT.replace(/<blockquote expandable>/g, '<blockquote>'), { parse_mode: 'HTML' });
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

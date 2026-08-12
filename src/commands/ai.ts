/**
 * Команды, работающие с нейросетями: /гем (/gem), /ask, /draw, /ai, /reset.
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
import { GrammyError, InlineKeyboard, InputFile, type Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  describeProviders,
  findTextProvider,
  imageProviders,
  resolveImageProvider,
  resolveTextProvider,
  textProviders,
} from '../services/registry.js';
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from '../format.js';
import { withChatAction } from '../utils.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type BotContext,
  type TextProvider,
} from '../types.js';

/** id провайдера Gemini в реестре. */
const GEMINI_ID = 'gemini';

/**
 * Кириллическая форма команды: /гем, /гем@имя_бота.
 * Регистр не важен, аргументы — всё, что после первого пробела.
 */
const CYRILLIC_GEM = /^\/гем(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

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

/** Общий сценарий «вопрос → ответ» для конкретного провайдера. */
async function askProvider(ctx: BotContext, provider: TextProvider, prompt: string): Promise<void> {
  try {
    // Историю передаём укороченной: длинный контекст = дороже и медленнее.
    const history = config.ai.historyLimit > 0 ? ctx.session.history.slice(-config.ai.historyLimit) : [];

    // Пока модель думает, показываем «печатает…».
    const answer = await withChatAction(ctx, 'typing', () => provider.generateText(prompt, { history }));

    if (config.ai.historyLimit > 0) {
      ctx.session.history.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer });
      // Держим в памяти только последние N сообщений.
      ctx.session.history = ctx.session.history.slice(-config.ai.historyLimit);
    }

    await sendMarkdown(ctx, answer);
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/** Берёт текст запроса из аргументов команды либо из сообщения, на которое ответили. */
function extractPrompt(ctx: BotContext, args: string): string {
  return args.trim() || ctx.message?.reply_to_message?.text?.trim() || '';
}

/** Обработчик /гем и /gem — всегда обращается именно к Gemini. */
async function handleGemini(ctx: BotContext, prompt: string): Promise<void> {
  if (!prompt) {
    await ctx.reply(
      'Напишите запрос после команды. Например:\n' +
        '<code>/гем объясни рекурсию за три предложения</code>\n\n' +
        'Ещё можно ответить командой <code>/гем</code> на любое сообщение — я возьму его текст.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const gemini = findTextProvider(GEMINI_ID);
  if (!gemini) {
    await ctx.reply('⚠️ Провайдер Gemini не зарегистрирован в боте.');
    return;
  }
  if (!gemini.isConfigured) {
    await ctx.reply(`🔌 Gemini не подключён.\n\n• ${gemini.setupHint}`);
    return;
  }

  await askProvider(ctx, gemini, prompt);
}

/** Клавиатура выбора провайдера. Активный помечен зелёным, ненастроенный — замком. */
function buildProviderKeyboard(ctx: BotContext): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const provider of textProviders) {
    const mark = provider.id === ctx.session.textProviderId ? '🟢' : provider.isConfigured ? '⚪️' : '🔒';
    keyboard.text(`${mark} текст: ${provider.title}`, `set:text:${provider.id}`).row();
  }
  for (const provider of imageProviders) {
    const mark = provider.id === ctx.session.imageProviderId ? '🟢' : provider.isConfigured ? '⚪️' : '🔒';
    keyboard.text(`${mark} картинки: ${provider.title}`, `set:image:${provider.id}`).row();
  }

  return keyboard;
}

/** Текст сообщения со списком провайдеров. */
function buildProviderMessage(ctx: BotContext): string {
  return [
    '<b>Подключённые нейросети</b>',
    '',
    ...describeProviders().map(
      (provider) =>
        `${provider.ready ? '✅' : '🔒'} <b>${escapeHtml(provider.title)}</b> — ${provider.kind}` +
        (provider.ready ? '' : ' (нет ключей в .env)'),
    ),
    '',
    `Сейчас активны: <code>${escapeHtml(ctx.session.textProviderId)}</code> для текста, ` +
      `<code>${escapeHtml(ctx.session.imageProviderId)}</code> для картинок.`,
    '',
    '<i>Выбор влияет на /ask. Команда /гем всегда обращается к Gemini.</i>',
  ].join('\n');
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

  // ------------------------------------------------------------------ /ask
  // Работает через провайдера, выбранного в /ai (по умолчанию тот же Gemini).
  bot.command('ask', async (ctx) => {
    const prompt = extractPrompt(ctx, ctx.match);

    if (!prompt) {
      await ctx.reply(
        'Задайте вопрос после команды. Например:\n<code>/ask объясни рекурсию за 3 предложения</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const provider = resolveTextProvider(ctx.session.textProviderId);
      await askProvider(ctx, provider, prompt);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  // ----------------------------------------------------------------- /draw
  bot.command('draw', async (ctx) => {
    const prompt = extractPrompt(ctx, ctx.match);

    if (!prompt) {
      await ctx.reply('Опишите картинку. Например:\n<code>/draw кот-космонавт в стиле акварели</code>', {
        parse_mode: 'HTML',
      });
      return;
    }

    try {
      const provider = resolveImageProvider(ctx.session.imageProviderId);
      const notice = await ctx.reply('🎨 Рисую… это занимает 10–60 секунд.');

      const image = await withChatAction(ctx, 'upload_photo', () => provider.generateImage(prompt));

      // InputFile умеет отправлять Buffer напрямую — сохранять файл на диск не нужно.
      const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      await ctx.replyWithPhoto(new InputFile(image.data, `kandinsky.${extension}`), {
        caption: `🖼 ${prompt.slice(0, 900)}\n\n${provider.title}, ${(image.elapsedMs / 1000).toFixed(1)} с`,
      });

      // Убираем служебное сообщение «Рисую…», чтобы не мусорить в чате.
      await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
    } catch (error) {
      await replyWithError(ctx, error);
    }
  });

  // ------------------------------------------------------------------- /ai
  bot.command('ai', async (ctx) => {
    await ctx.reply(buildProviderMessage(ctx), {
      parse_mode: 'HTML',
      reply_markup: buildProviderKeyboard(ctx),
    });
  });

  // Нажатие на кнопку выбора провайдера.
  bot.callbackQuery(/^set:(text|image):/, async (ctx) => {
    // Разбираем callback_data вручную: так проще и типобезопаснее.
    const [, kind, providerId] = ctx.callbackQuery.data.split(':');
    if (!kind || !providerId) {
      await ctx.answerCallbackQuery({ text: 'Непонятная кнопка' });
      return;
    }

    const provider =
      kind === 'text'
        ? textProviders.find((item) => item.id === providerId)
        : imageProviders.find((item) => item.id === providerId);

    if (!provider) {
      await ctx.answerCallbackQuery({ text: 'Такого провайдера больше нет' });
      return;
    }

    if (!provider.isConfigured) {
      // show_alert — Telegram покажет всплывающее окно вместо тоста.
      await ctx.answerCallbackQuery({ text: `${provider.title}: нет ключей в .env`, show_alert: true });
      return;
    }

    if (kind === 'text') ctx.session.textProviderId = provider.id;
    else ctx.session.imageProviderId = provider.id;

    await ctx.answerCallbackQuery({ text: `Выбрано: ${provider.title}` });
    // Перерисовываем сообщение, чтобы галочка переехала на новую кнопку.
    await ctx.editMessageText(buildProviderMessage(ctx), {
      parse_mode: 'HTML',
      reply_markup: buildProviderKeyboard(ctx),
    });
  });

  // ---------------------------------------------------------------- /reset
  bot.command('reset', async (ctx) => {
    const removed = ctx.session.history.length;
    ctx.session.history = [];
    await ctx.reply(`🧹 История диалога очищена (было сообщений: ${removed}). Начинаем с чистого листа.`);
  });

  // --------------------------------------------------- обычные сообщения
  // Регистрируется последним: сюда попадает всё, что не разобрали
  // предыдущие обработчики.
  bot.on('message:text', async (ctx) => {
    // В группах бот молчит на обычные сообщения: обращаться к нему нужно
    // командой. Иначе он вклинивался бы в каждую беседу.
    if (ctx.chat.type !== 'private') return;

    const text = ctx.message.text.trim();

    if (text.startsWith('/')) {
      await ctx.reply('🤔 Не знаю такую команду. Список всех команд — /help');
      return;
    }

    // Свободный текст запросом не считается — это осознанное решение,
    // чтобы случайные сообщения не тратили квоту нейросети.
    await ctx.reply('Чтобы спросить нейросеть, используйте команду. Например:\n/гем ' + text.slice(0, 100));
  });
}

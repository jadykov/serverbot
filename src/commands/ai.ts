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
import { collectAlbumPart, downloadAttachment, pickPhotoFileId } from '../media.js';
import { generateWithChain } from '../services/chain.js';
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
 * Слово-переключатель в начале запроса: «/гем мышление ...», «/gem think ...».
 *
 * Отдельной командой это не сделано намеренно. Точка входа к нейросети одна,
 * её и надо помнить; а меню Telegram не засоряется ещё одним пунктом, который
 * от соседнего отличается только выбором цепочки.
 *
 * Разделитель после слова прописан явно, а не через \b: в JavaScript граница
 * слова определяется по латинице, и с кириллицей \b просто не срабатывает —
 * «мышление что-то» не совпало бы вообще. Заодно такая запись не ловит
 * «мышления» и «thinking», где слово лишь начинается похоже.
 */
const THINK_PREFIX = /^(?:мышление|think)(?:[\s,:.—–-]+([\s\S]*))?$/i;

/**
 * Та же команда, но в подписи к фотографии: «/гем что здесь написано».
 * Латинская и кириллическая формы вместе — в подписи Telegram не размечает
 * команды, так что разбираем обе одинаково, обычным текстом.
 */
const MEDIA_COMMAND = /^\/(?:гем|gem)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

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
): Promise<void> {
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
      ctx.session.history.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer.text });
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
  } catch (error) {
    await replyWithError(ctx, error);
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
 * Если запрос начинается со слова «мышление» (или «think»), вместо неё берётся
 * сильная цепочка — какой бы режим в разделе ни стоял. Дневная норма у этих
 * моделей небольшая, поэтому переключение всегда явное.
 */
async function handleGemini(ctx: BotContext, rawPrompt: string): Promise<void> {
  if (!rawPrompt) {
    await ctx.reply(
      'Напишите запрос после команды. Например:\n' +
        '<code>/гем объясни рекурсию за три предложения</code>\n\n' +
        'Для сложной задачи добавьте слово «мышление» — возьму модель посильнее:\n' +
        '<code>/гем мышление почему этот SQL висит на большой таблице</code>\n\n' +
        'Ещё можно ответить командой <code>/гем</code> на любое сообщение — я возьму его текст.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const think = THINK_PREFIX.exec(rawPrompt.trim());
  const prompt = think ? (think[1] ?? '').trim() : rawPrompt;

  if (think && !prompt) {
    await ctx.reply(
      'После «мышление» нужна сама задача. Например:\n' +
        '<code>/гем мышление почему этот SQL висит на большой таблице</code>\n\n' +
        'Эти модели сильнее, но их дневная норма невелика — для обычных вопросов ' +
        'хватает просто <code>/гем</code>.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const chain = think ? resolveChain(THINK_CHAIN) : resolveChain(ctx.session.chainId);
  await askChain(ctx, gemini, chain.models, prompt);
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
    await askChain(ctx, gemini, resolveChain(ctx.session.chainId).models, request.prompt, attachments);
  } catch (error) {
    await replyWithError(ctx, error);
  }
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
      // У Gemini есть цепочка резервных моделей, у остальных провайдеров —
      // одна модель из .env, перебирать там нечего.
      const models = provider.id === GEMINI_ID ? resolveChain(ctx.session.chainId).models : [];
      await askChain(ctx, provider, models, prompt);
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
      // Стоимость показываем прямо в подписи: это единственное, за что бот
      // платит, и в общей компании расход честнее держать на виду.
      const price = image.costUsd !== undefined ? `, $${image.costUsd.toFixed(4)}` : '';
      await ctx.replyWithPhoto(new InputFile(image.data, `image.${extension}`), {
        caption: `🖼 ${prompt.slice(0, 900)}\n\n${provider.title}, ${(image.elapsedMs / 1000).toFixed(1)} с${price}`,
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

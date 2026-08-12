/**
 * Команды, работающие с нейросетями: /ask, /draw, /ai, /reset.
 *
 * Обработчики намеренно ничего не знают о конкретных API — они берут
 * провайдера из реестра (src/services/registry.ts) по id из сессии чата.
 */
import { InlineKeyboard, InputFile, type Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  describeProviders,
  imageProviders,
  resolveImageProvider,
  resolveTextProvider,
  textProviders,
} from '../services/registry.js';
import { escapeHtml, splitMessage, withChatAction } from '../utils.js';
import { ProviderNotConfiguredError, ProviderRequestError, type BotContext } from '../types.js';

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

/** Общий сценарий «вопрос → ответ текстовой модели». */
async function handleQuestion(ctx: BotContext, prompt: string): Promise<void> {
  try {
    const provider = resolveTextProvider(ctx.session.textProviderId);

    // Историю передаём укороченной: длинный контекст = дороже и медленнее.
    const history = config.ai.historyLimit > 0 ? ctx.session.history.slice(-config.ai.historyLimit) : [];

    // Пока модель думает, показываем «печатает…».
    const answer = await withChatAction(ctx, 'typing', () => provider.generateText(prompt, { history }));

    if (config.ai.historyLimit > 0) {
      ctx.session.history.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer });
      // Держим в памяти только последние N сообщений.
      ctx.session.history = ctx.session.history.slice(-config.ai.historyLimit);
    }

    // Ответ модели отправляем без parse_mode: в нём легко встречаются
    // символы * _ [ ] < >, из-за которых Telegram отклонил бы сообщение.
    for (const chunk of splitMessage(answer)) {
      await ctx.reply(chunk);
    }
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
    '<i>Нажмите кнопку, чтобы переключить провайдера для этого чата.</i>',
  ].join('\n');
}

export function registerAiCommands(bot: Bot<BotContext>): void {
  // ------------------------------------------------------------------ /ask
  bot.command('ask', async (ctx) => {
    // Промпт берём после команды, а если его нет — из сообщения, на которое ответили.
    const prompt = ctx.match.trim() || ctx.message?.reply_to_message?.text?.trim() || '';

    if (!prompt) {
      await ctx.reply(
        'Задайте вопрос после команды. Например:\n<code>/ask объясни рекурсию за 3 предложения</code>\n\n' +
          'Ещё можно ответить командой /ask на любое сообщение — я возьму его текст.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    await handleQuestion(ctx, prompt);
  });

  // ----------------------------------------------------------------- /draw
  bot.command('draw', async (ctx) => {
    const prompt = ctx.match.trim() || ctx.message?.reply_to_message?.text?.trim() || '';

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
      // alert: true — Telegram покажет всплывающее окно вместо тоста.
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
    const text = ctx.message.text.trim();

    // Неизвестная команда — подсказываем справку, а не отправляем её в нейросеть.
    if (text.startsWith('/')) {
      await ctx.reply('🤔 Не знаю такую команду. Список всех команд — /help');
      return;
    }

    // В группах бот молчит, пока к нему не обратились явно через команду:
    // иначе он будет вклиниваться в каждое сообщение чата.
    if (ctx.chat.type !== 'private') return;

    await handleQuestion(ctx, text);
  });
}

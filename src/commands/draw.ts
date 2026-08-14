/**
 * Рисование: разговор перед тратой денег.
 *
 * Раньше «/гем нарисуй кота» сразу уходило в Krea. При $0,015 за картинку
 * и двух картинках в день на человека это дорогая рулетка: модель дорисовывает
 * недосказанное сама (у неё для этого есть параметр creativity со значением
 * medium по умолчанию), и попадание в замысел — дело случая.
 *
 * Теперь между командой и деньгами стоит бесплатный Gemini на лёгкой цепочке:
 * он смотрит, чего в запросе не хватает, задаёт два-три вопроса кнопками
 * и собирает промпт по правилам Krea (см. src/services/krea-prompt.ts). Деньги тратятся
 * только по явному нажатию «Рисовать», и промпт уходит с creativity=raw —
 * договорились об одном, значит рисуем именно это.
 *
 * Черновик лежит в сессии раздела, но по одному на человека: в общем топике
 * рисовать могут двое сразу, и чужую кнопку нажать нельзя.
 */
import { InlineKeyboard, InputFile, type Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml } from '../format.js';
import { withChatAction } from '../utils.js';
import { findTextProvider, resolveImageProvider } from '../services/registry.js';
import { peekImageQuota, releaseImageSlot, reserveImageSlot } from '../services/image-quota.js';
import { composeDrawing, planDrawing, stripStableDiffusionSyntax } from '../services/krea-prompt.js';
import type { BotContext, DrawDraft, TextProvider } from '../types.js';

/** Префикс callback_data. Телеграм даёт на неё 64 байта — держим коротко. */
const CB = 'd';

/** id провайдера Gemini в реестре. */
const GEMINI_ID = 'gemini';

/**
 * Кто собирает промпт: Gemini на отдельной лёгкой цепочке (GEMINI_CHAIN_DRAW),
 * а не на цепочке раздела. Человек ждёт ответа здесь и сейчас, а задача
 * формальная — вернуть JSON с вопросами; тяжёлая модель тратит на неё
 * 25 секунд вместо полутора, не выигрывая в качестве.
 */
function planner(): { provider: TextProvider; models: string[] } | null {
  const provider = findTextProvider(GEMINI_ID);
  if (!provider?.isConfigured) return null;
  return { provider, models: config.gemini.chains.draw };
}

/** Достаёт черновики раздела, попутно выбрасывая протухшие. */
function drafts(ctx: BotContext): Record<string, DrawDraft> {
  const all = ctx.session.drawDrafts ?? {};
  const deadline = Date.now() - config.draw.draftTtlMin * 60 * 1000;

  for (const [userId, draft] of Object.entries(all)) {
    if (draft.updatedAt < deadline) delete all[userId];
  }

  ctx.session.drawDrafts = all;
  return all;
}

function getDraft(ctx: BotContext): DrawDraft | undefined {
  const userId = ctx.from?.id;
  return userId === undefined ? undefined : drafts(ctx)[String(userId)];
}

function setDraft(ctx: BotContext, draft: DrawDraft): void {
  const userId = ctx.from?.id;
  if (userId === undefined) return;
  drafts(ctx)[String(userId)] = { ...draft, updatedAt: Date.now() };
}

function clearDraft(ctx: BotContext): void {
  const userId = ctx.from?.id;
  if (userId !== undefined) delete drafts(ctx)[String(userId)];
}

/** Клавиатура одного вопроса: варианты ответа плюс «рисуй как есть». */
function questionKeyboard(step: number, options: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  options.forEach((option, index) => {
    keyboard.text(option, `${CB}:a:${step}:${index}`).row();
  });
  return keyboard.text('⏩ Рисуй как есть', `${CB}:skip`);
}

/** Клавиатура подтверждения — единственное место, где тратятся деньги. */
function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎨 Рисовать', `${CB}:go`)
    .row()
    .text('✏️ Поправить', `${CB}:edit`)
    .text('✖️ Отмена', `${CB}:cancel`);
}

/** Текст вопроса с номером: человеку видно, сколько ещё осталось. */
function questionText(draft: DrawDraft): string {
  const question = draft.questions[draft.step];
  const total = draft.questions.length;

  return [
    `🎨 <b>${escapeHtml(draft.original)}</b>`,
    '',
    `Уточню ${total === 1 ? 'одну вещь' : `${total} ${total < 5 ? 'вещи' : 'вещей'}`} — картинка стоит денег, ` +
      'и хочется попасть с первого раза.',
    '',
    `<b>${draft.step + 1}/${total}.</b> ${escapeHtml(question?.text ?? '')}`,
  ].join('\n');
}

/** Текст подтверждения: что нарисуем, почём и сколько ещё осталось на сегодня. */
async function confirmText(ctx: BotContext, draft: DrawDraft): Promise<string> {
  const quota = await peekImageQuota(ctx.from?.id);
  const left = quota ? `\nОстанется на сегодня: ${Math.max(0, quota.limit - quota.used - 1)} из ${quota.limit}` : '';

  return [
    '🎨 <b>Нарисую вот это:</b>',
    escapeHtml(draft.summary),
    '',
    `<i>Промпт: ${escapeHtml(draft.prompt)}</i>`,
    `<i>Примерно $0,015${left}</i>`,
  ].join('\n');
}

/** Показывает подтверждение: новым сообщением или заменой прежнего. */
async function showConfirm(ctx: BotContext, draft: DrawDraft): Promise<void> {
  const text = await confirmText(ctx, draft);
  const options = { parse_mode: 'HTML' as const, reply_markup: confirmKeyboard() };

  if (ctx.callbackQuery) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

/**
 * Точка входа из «/гем нарисуй ...».
 *
 * Ничего не тратит: либо задаёт первый вопрос, либо, если замысел и так
 * описан подробно, сразу показывает черновик на подтверждение.
 */
export async function startDraw(ctx: BotContext, request: string): Promise<void> {
  if (!request) {
    await ctx.reply(
      'Опишите картинку после слова «нарисуй». Например:\n' +
        '<code>/гем нарисуй кота-космонавта в стиле акварели</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Скобки и «masterpiece» из мира Stable Diffusion Krea читает как обычный
  // текст и рисует их содержимое буквально — убираем и говорим об этом.
  const { cleaned, removed } = stripStableDiffusionSyntax(request);
  if (removed) {
    await ctx.reply(
      '<i>Убрал из запроса веса и слова вроде «8k, masterpiece»: Krea 2 читает их как обычный текст, ' +
        'а не как указания. Стиль лучше задавать словами.</i>',
      { parse_mode: 'HTML' },
    );
  }

  // Выключатель на случай, если разговоры надоели: рисуем сразу, как раньше.
  // Некому вести разговор (Gemini не настроен) — та же ветка: без картинки
  // человека оставлять незачем, пусть модель дорисовывает сама.
  const helper = planner();
  if (!config.draw.askQuestions || !helper) {
    await generate(ctx, { ...emptyDraft(cleaned), refined: false });
    return;
  }

  const plan = await withChatAction(ctx, 'typing', () => planDrawing(helper.provider, helper.models, cleaned));

  const draft: DrawDraft = {
    ...emptyDraft(cleaned),
    prompt: plan.prompt,
    summary: plan.summary,
    questions: plan.questions,
  };

  // Замысел описан подробно — спрашивать нечего, сразу к подтверждению.
  if (draft.questions.length === 0) {
    draft.refined = true;
    setDraft(ctx, draft);
    await showConfirm(ctx, draft);
    return;
  }

  setDraft(ctx, draft);
  await ctx.reply(questionText(draft), { parse_mode: 'HTML', reply_markup: questionKeyboard(0, draft.questions[0]!.options) });
}

function emptyDraft(request: string): DrawDraft {
  return {
    original: request,
    prompt: request,
    summary: request,
    questions: [],
    answers: [],
    step: 0,
    awaitingEdit: false,
    refined: false,
    updatedAt: Date.now(),
  };
}

/**
 * Единственное место, где тратятся деньги.
 *
 * Слот дневной нормы занимается до вызова и возвращается при неудаче:
 * рисование идёт полминуты, за это время можно нажать кнопку ещё раз.
 */
async function generate(ctx: BotContext, draft: DrawDraft): Promise<void> {
  const userId = ctx.from?.id;
  const quota = await reserveImageSlot(userId);

  if (!quota.allowed) {
    await ctx.reply(
      `🚫 На сегодня картинки закончились: ${quota.limit} в день на человека — ` +
        `рисование единственное, что стоит денег.\n\nНорма обновится через ${quota.resetsIn}. ` +
        'Текстовые запросы работают как обычно.',
    );
    return;
  }

  const notice = await ctx.reply('🎨 Рисую… это занимает 10–60 секунд.');

  try {
    const provider = resolveImageProvider(ctx.session.imageProviderId);
    // Промпт, собранный в разговоре, менять уже незачем — raw. А «рисуй как
    // есть» держится как раз на дорисовке моделью, там оставляем medium.
    const creativity = draft.refined ? config.openrouter.image.creativityRefined : config.openrouter.image.creativityRaw;

    const image = await withChatAction(ctx, 'upload_photo', () => provider.generateImage(draft.prompt, { creativity }));

    const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const price = image.costUsd !== undefined ? `, $${image.costUsd.toFixed(4)}` : '';
    const left = Number.isFinite(quota.remaining) ? `\nОсталось на сегодня: ${quota.remaining} из ${quota.limit}` : '';

    await ctx.replyWithPhoto(new InputFile(image.data, `image.${extension}`), {
      caption: `🖼 ${draft.summary.slice(0, 900)}\n\n${provider.title}, ${(image.elapsedMs / 1000).toFixed(1)} с${price}${left}`,
    });

    clearDraft(ctx);
    await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
  } catch (error) {
    await releaseImageSlot(userId);
    await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
    logger.warn('Не удалось нарисовать картинку', { error: error instanceof Error ? error.message : String(error) });
    await ctx.reply(`⚠️ ${error instanceof Error ? error.message : 'Не получилось нарисовать картинку.'}`);
  }
}

/**
 * Регистрирует кнопки и перехват правки.
 *
 * Вызывать ДО registerAiCommands: правка приходит обычным сообщением,
 * а там стоит общая ловушка для текста.
 */
export function registerDrawCommands(bot: Bot<BotContext>): void {
  // Ответ на наводящий вопрос.
  bot.callbackQuery(new RegExp(`^${CB}:a:(\\d+):(\\d+)$`), async (ctx) => {
    const draft = getDraft(ctx);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Этот черновик уже не действует — начните заново.', show_alert: true });
      return;
    }

    const [, stepRaw, optionRaw] = ctx.match as RegExpMatchArray;
    const step = Number(stepRaw);
    const question = draft.questions[step];
    const option = question?.options[Number(optionRaw)];

    if (!question || option === undefined) {
      await ctx.answerCallbackQuery({ text: 'Кнопка устарела.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: option });

    draft.answers[step] = `${question.text} — ${option}`;
    draft.step = step + 1;

    // Вопросы кончились: собираем окончательный промпт с учётом ответов.
    if (draft.step >= draft.questions.length) {
      const helper = planner();
      if (helper) {
        const plan = await withChatAction(ctx, 'typing', () =>
          composeDrawing(helper.provider, helper.models, draft.original, draft.answers),
        );
        draft.prompt = plan.prompt;
        draft.summary = plan.summary;
      }
      draft.refined = true;
      setDraft(ctx, draft);
      await showConfirm(ctx, draft);
      return;
    }

    setDraft(ctx, draft);
    await ctx.editMessageText(questionText(draft), {
      parse_mode: 'HTML',
      reply_markup: questionKeyboard(draft.step, draft.questions[draft.step]!.options),
    });
  });

  // «Рисуй как есть» — пропустить оставшиеся вопросы.
  bot.callbackQuery(`${CB}:skip`, async (ctx) => {
    const draft = getDraft(ctx);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Этот черновик уже не действует — начните заново.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Человек отказался уточнять — пусть недосказанное дорисовывает модель.
    draft.refined = false;
    draft.prompt = draft.original;
    draft.summary = draft.original;
    setDraft(ctx, draft);
    await showConfirm(ctx, draft);
  });

  // Подтверждение — здесь и только здесь тратятся деньги.
  bot.callbackQuery(`${CB}:go`, async (ctx) => {
    const draft = getDraft(ctx);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Этот черновик уже не действует — начните заново.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await generate(ctx, draft);
  });

  // Правка текстом: ждём следующее сообщение этого человека.
  bot.callbackQuery(`${CB}:edit`, async (ctx) => {
    const draft = getDraft(ctx);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Этот черновик уже не действует — начните заново.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    draft.awaitingEdit = true;
    setDraft(ctx, draft);
    await ctx.reply('✏️ Напишите, что поправить — например «сделай ночь» или «убери шлем».');
  });

  bot.callbackQuery(`${CB}:cancel`, async (ctx) => {
    clearDraft(ctx);
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    await ctx.editMessageText('✖️ Рисование отменено. Ничего не потрачено.');
  });

  // Перехват правки. Всё остальное пропускаем дальше — этим обработчиком
  // мы стоим перед общей ловушкой обычных сообщений.
  bot.on('message:text', async (ctx, next) => {
    const draft = getDraft(ctx);
    if (!draft?.awaitingEdit) return next();

    const edit = ctx.message.text.trim();
    if (edit.startsWith('/')) return next();

    draft.awaitingEdit = false;

    const helper = planner();
    if (helper) {
      const plan = await withChatAction(ctx, 'typing', () =>
        composeDrawing(helper.provider, helper.models, draft.original, draft.answers, edit),
      );
      draft.prompt = plan.prompt;
      draft.summary = plan.summary;
    }

    draft.refined = true;
    setDraft(ctx, draft);
    await showConfirm(ctx, draft);
  });
}

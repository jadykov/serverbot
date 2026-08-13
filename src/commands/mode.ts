/**
 * Команда /режим (/mode) — настройка раздела форума.
 *
 * Смысл в том, что в форуме сам раздел говорит о намерении больше, чем тип
 * сообщения: в «коде» нужна думающая модель, в «болтовне» — быстрая. Настроил
 * топик один раз — дальше он работает сам, и участникам не нужно выбирать
 * модель при каждом вопросе.
 *
 * Настройки хранятся в сессии, а она привязана к паре «чат + топик»
 * (см. getSessionKey в src/bot.ts), поэтому в каждом разделе они свои.
 *
 * Про две формы команды — та же история, что у /гем: Telegram принимает
 * в именах команд только латиницу, поэтому /mode настоящая команда,
 * а /режим ловится по тексту сообщения.
 */
import { InlineKeyboard, type Bot } from 'grammy';
import { escapeHtml } from '../format.js';
import { listChains, resolveChain } from '../models.js';
import type { BotContext } from '../types.js';

/** Кириллическая форма: /режим, /режим@имя_бота, /режим промпт ... */
const CYRILLIC_MODE = /^\/режим(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

/** Насколько длинный свой промпт разрешаем: длиннее — это уже злоупотребление. */
const MAX_PROMPT_LENGTH = 1500;

/** Настройки живут отдельно в каждом топике — об этом стоит сказать прямо. */
function describeScope(ctx: BotContext): string {
  if (ctx.chat?.type === 'private') return 'в этом диалоге';
  const message = ctx.message;
  const isTopic = message && 'is_topic_message' in message && message.is_topic_message;
  return isTopic ? 'в этом разделе' : 'в этом чате';
}

function buildKeyboard(ctx: BotContext): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const currentId = resolveChain(ctx.session.chainId).id;

  for (const chain of listChains()) {
    const mark = chain.id === currentId ? '🟢' : '⚪️';
    keyboard.text(`${mark} ${chain.title}`, `mode:chain:${chain.id}`).row();
  }

  if (ctx.session.systemPrompt) {
    keyboard.text('🧹 Убрать свой промпт', 'mode:prompt:clear').row();
  }

  return keyboard;
}

function buildMessage(ctx: BotContext): string {
  const chain = resolveChain(ctx.session.chainId);
  const prompt = ctx.session.systemPrompt ?? '';

  return [
    `<b>Режим ${escapeHtml(describeScope(ctx))}</b>`,
    '',
    `Цепочка: <b>${escapeHtml(chain.title)}</b> — ${escapeHtml(chain.hint)}`,
    `Порядок моделей: <code>${escapeHtml(chain.models.join(' → '))}</code>`,
    '',
    prompt
      ? `Свой промпт:\n<blockquote>${escapeHtml(prompt)}</blockquote>`
      : 'Свой промпт: <i>не задан, используется общий</i>',
    '',
    '<i>Задать промпт:</i> <code>/режим промпт Ты дотошный ревьюер кода</code>',
    '<i>Сбросить всё:</i> <code>/режим сброс</code>',
  ].join('\n');
}

async function showMode(ctx: BotContext): Promise<void> {
  await ctx.reply(buildMessage(ctx), {
    parse_mode: 'HTML',
    reply_markup: buildKeyboard(ctx),
  });
}

/** Разбирает то, что написали после команды: промпт, сброс или ничего. */
async function handleMode(ctx: BotContext, args: string): Promise<void> {
  const text = args.trim();

  if (!text) {
    await showMode(ctx);
    return;
  }

  const lower = text.toLowerCase();

  if (lower === 'сброс' || lower === 'reset') {
    ctx.session.chainId = resolveChain(undefined).id;
    ctx.session.systemPrompt = '';
    await ctx.reply('🧹 Настройки раздела сброшены к умолчаниям.');
    return;
  }

  const promptMatch = /^(?:промпт|prompt)\s+([\s\S]+)$/i.exec(text);
  if (promptMatch) {
    const prompt = promptMatch[1]!.trim();

    if (prompt.length > MAX_PROMPT_LENGTH) {
      await ctx.reply(
        `⚠️ Промпт длиннее ${MAX_PROMPT_LENGTH} символов — столько инструкций модель всё равно не удержит. ` +
          'Сформулируйте короче.',
      );
      return;
    }

    ctx.session.systemPrompt = prompt;
    await ctx.reply(`✅ Промпт ${describeScope(ctx)} обновлён. Проверить — /режим`);
    return;
  }

  await ctx.reply(
    'Не понял. Доступно:\n' +
      '<code>/режим</code> — показать настройки\n' +
      '<code>/режим промпт ТЕКСТ</code> — задать свою инструкцию\n' +
      '<code>/режим сброс</code> — вернуть умолчания',
    { parse_mode: 'HTML' },
  );
}

export function registerModeCommands(bot: Bot<BotContext>): void {
  bot.command('mode', async (ctx) => {
    await handleMode(ctx, ctx.match);
  });

  bot.hears(CYRILLIC_MODE, async (ctx) => {
    const match = typeof ctx.match === 'string' ? null : ctx.match;

    // В группе может быть несколько ботов: /режим@другой_бот — не наше дело.
    const addressee = match?.[1];
    if (addressee && addressee.toLowerCase() !== ctx.me.username.toLowerCase()) return;

    await handleMode(ctx, match?.[2] ?? '');
  });

  bot.callbackQuery(/^mode:chain:/, async (ctx) => {
    const chainId = ctx.callbackQuery.data.split(':')[2];
    const chain = listChains().find((item) => item.id === chainId);

    if (!chain) {
      await ctx.answerCallbackQuery({ text: 'Такого режима больше нет' });
      return;
    }

    ctx.session.chainId = chain.id;
    await ctx.answerCallbackQuery({ text: `Режим: ${chain.title}` });
    await ctx.editMessageText(buildMessage(ctx), {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(ctx),
    });
  });

  bot.callbackQuery('mode:prompt:clear', async (ctx) => {
    ctx.session.systemPrompt = '';
    await ctx.answerCallbackQuery({ text: 'Свой промпт убран' });
    await ctx.editMessageText(buildMessage(ctx), {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(ctx),
    });
  });
}

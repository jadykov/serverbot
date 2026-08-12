/**
 * Middleware логирования: пишет в лог каждый входящий апдейт и время его обработки.
 * Порядок важен: этот middleware регистрируется первым, чтобы измерять всё,
 * что происходит дальше по цепочке.
 */
import type { MiddlewareFn } from 'grammy';
import { logger } from '../logger.js';
import type { BotContext } from '../types.js';

/** Определяет тип апдейта: message, callback_query, edited_message и т.д. */
function getUpdateKind(ctx: BotContext): string {
  const keys = Object.keys(ctx.update).filter((key) => key !== 'update_id');
  return keys[0] ?? 'unknown';
}

export const requestLogger: MiddlewareFn<BotContext> = async (ctx, next) => {
  const startedAt = Date.now();
  const payload = ctx.message?.text ?? ctx.callbackQuery?.data ?? '';

  logger.debug('Входящий апдейт', {
    updateId: ctx.update.update_id,
    kind: getUpdateKind(ctx),
    userId: ctx.from?.id,
    username: ctx.from?.username,
    chatId: ctx.chat?.id,
    text: payload.slice(0, 120),
  });

  // next() передаёт управление следующему middleware/обработчику.
  await next();

  logger.info('Апдейт обработан', {
    updateId: ctx.update.update_id,
    kind: getUpdateKind(ctx),
    userId: ctx.from?.id,
    ms: Date.now() - startedAt,
  });
};

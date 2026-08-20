/**
 * Middleware, который просто отмечает: «в этом разделе бот бывал».
 *
 * Стоит до сессии и до выключателя намеренно — список нужен спонтанным
 * репликам (src/services/spontaneous.ts) целиком, включая разделы,
 * молчащие сейчас: сама попытка написать уже проверяет /stop отдельно,
 * а вот забыть про раздел из-за того, что он временно выключен, не должна.
 */
import type { MiddlewareFn } from 'grammy';
import { noteTopic } from '../services/topics.js';
import { sessionKey } from '../utils.js';
import type { BotContext } from '../types.js';

export const topicsCollector: MiddlewareFn<BotContext> = async (ctx, next) => {
  const key = sessionKey(ctx);
  if (key) void noteTopic(key);
  return next();
};

/**
 * Middleware, который копит справочник «@ник → id».
 *
 * Стоит до выключателя раздела и до рейт-лимита нарочно: справочник — это
 * не работа для пользователя, а память бота о том, кто вообще есть в чате.
 * Отключённый топик и отбитый спам к этому знанию отношения не имеют, а вот
 * потерять человека, написавшего единственный раз в выключенном разделе,
 * было бы обидно — по нику он потом не найдётся.
 *
 * Ничего не ждёт и никого не задерживает: запись на диск случается только
 * тогда, когда справочник действительно изменился (см. services/user-directory).
 */
import type { MiddlewareFn } from 'grammy';
import { rememberUser } from '../services/user-directory.js';
import type { BotContext } from '../types.js';

export const userDirectory: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) void rememberUser(ctx.from);
  return next();
};

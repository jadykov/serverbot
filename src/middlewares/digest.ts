/**
 * Middleware, который копит переписку раздела для долгой памяти.
 *
 * По той же причине, что и у архива поиска (src/middlewares/searchIndex.ts):
 * помнить нужно весь разговор, а не только обращения к боту, — иначе память
 * знала бы только о том, что спросили у /гем, и упускала бы сам разговор
 * вокруг. Команды в неё поэтому не берём: «/гем нарисуй кота» ничего не
 * добавляет к памяти о людях и темах, а вот реплики рядом — добавляют.
 */
import type { MiddlewareFn } from 'grammy';
import { noteMessage } from '../services/digest.js';
import { authorName } from './searchIndex.js';
import { sessionKey } from '../utils.js';
import type { BotContext } from '../types.js';

export const digestCollector: MiddlewareFn<BotContext> = async (ctx, next) => {
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  const key = sessionKey(ctx);

  if (key && text && !text.startsWith('/')) {
    noteMessage(key, authorName(ctx), text);
  }

  return next();
};

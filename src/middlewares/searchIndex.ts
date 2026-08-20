/**
 * Middleware, который запоминает переписку раздела для поиска по смыслу.
 *
 * Почему это middleware, а не часть команды: искать надо по всему разговору,
 * а не только по обращениям к боту. В группе у него отключён privacy mode
 * (иначе не работает «/гем»), то есть он видит всё, что пишут в топике, —
 * и как раз это и делает поиск полезным: люди ищут свои же обсуждения,
 * а не ответы нейросети.
 *
 * Индексация ничего не ждёт и никого не задерживает: реплика уходит в буфер,
 * а вектор для неё считается пачкой в фоне (см. src/services/search-index.ts).
 */
import type { MiddlewareFn } from 'grammy';
import { rememberMessage } from '../services/search-index.js';
import { sessionKey } from '../utils.js';
import type { BotContext } from '../types.js';

/**
 * Как подписать реплику в результатах поиска.
 *
 * Общая для всего, что подписывает реплику именем автора: используется
 * и в архиве поиска, и в долгой памяти (src/services/digest.ts), и в самом
 * разговоре с моделью (src/commands/ai.ts) — какой бы механизм ни спрашивал,
 * «кто есть кто» должно определяться одинаково.
 */
export function authorName(ctx: BotContext): string {
  const from = ctx.from;
  if (!from) return 'кто-то';
  return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || 'кто-то';
}

export const searchIndexer: MiddlewareFn<BotContext> = async (ctx, next) => {
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  const key = sessionKey(ctx);

  // Команды в архив не берём: искать «/гем нарисуй кота» незачем,
  // а вот обычный разговор вокруг команды — самое ценное.
  if (key && text && !text.startsWith('/')) {
    rememberMessage(key, {
      ts: Date.now(),
      who: authorName(ctx),
      text,
      messageId: ctx.message?.message_id,
    });
  }

  return next();
};

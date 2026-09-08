/**
 * Простейший рейт-лимит «скользящее окно», хранится в памяти процесса.
 *
 * Зачем: запросы к нейросетям стоят денег и времени, а один пользователь
 * с зажатым Enter способен выжрать всю квоту.
 *
 * Ограничение: счётчики живут в памяти одного процесса. Если запускаете
 * несколько реплик бота — выносите хранилище в Redis
 * (например, пакет @grammyjs/ratelimiter со стором Redis).
 */
import type { MiddlewareFn } from 'grammy';
import { config, isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { messagesQuota } from '../services/daily-quota.js';
import type { BotContext } from '../types.js';

/** userId -> метки времени последних запросов. */
const hits = new Map<number, number[]>();

// Раз в 5 минут подчищаем протухшие записи, чтобы Map не рос бесконечно.
// unref() не даёт таймеру удерживать процесс при остановке бота.
const cleanupTimer = setInterval(
  () => {
    const threshold = Date.now() - config.rateLimit.windowMs;
    for (const [userId, timestamps] of hits) {
      const fresh = timestamps.filter((time) => time > threshold);
      if (fresh.length === 0) hits.delete(userId);
      else hits.set(userId, fresh);
    }
  },
  5 * 60 * 1000,
);
cleanupTimer.unref();

export const rateLimit: MiddlewareFn<BotContext> = async (ctx, next) => {
  const userId = ctx.from?.id;

  // Служебные апдейты без пользователя и админов не ограничиваем.
  if (userId === undefined || isAdmin(userId)) {
    return next();
  }

  const now = Date.now();
  const threshold = now - config.rateLimit.windowMs;
  const timestamps = (hits.get(userId) ?? []).filter((time) => time > threshold);

  if (timestamps.length >= config.rateLimit.max) {
    const retryInSec = Math.max(1, Math.ceil(((timestamps[0] ?? now) + config.rateLimit.windowMs - now) / 1000));
    logger.warn('Сработал рейт-лимит', { userId, limit: config.rateLimit.max });
    await ctx.reply(`⏳ Слишком много запросов. Подождите ${retryInSec} с и попробуйте снова.`);
    return; // next() не вызываем — обработка апдейта прекращается.
  }

  timestamps.push(now);
  hits.set(userId, timestamps);

  // Дневная норма сообщений (MESSAGES_DAILY_LIMIT, по умолчанию 50):
  // обычный «/гем» идёт по бесплатному Gemini, но норма у него общая на всех.
  // Слот не возвращаем: middleware не знает, чем кончилась обработка, —
  // считаются попытки, а не полученные ответы. Админы выше уже прошли мимо.
  const slot = await messagesQuota.reserve(userId);
  if (!slot.allowed) {
    logger.warn('Дневная норма сообщений исчерпана', { userId, limit: slot.limit });
    await ctx.reply(
      `🚫 На сегодня лимит сообщений исчерпан: ${slot.limit} в день на человека.\n\n` +
        `Норма обновится через ${slot.resetsIn}.`,
    );
    return;
  }

  return next();
};

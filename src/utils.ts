/**
 * Мелкие утилиты, которые нужны в нескольких местах проекта.
 */
import type { BotContext } from './types.js';

/**
 * Контекст без самой сессии: именно такой grammY передаёт в getSessionKey —
 * ключ считается до того, как сессия загружена.
 */
type SessionlessContext = Omit<BotContext, 'session'>;

/**
 * Ключ раздела: id чата, а в форуме — id чата и топика.
 *
 * По нему живёт сессия (см. src/bot.ts), и по нему же лежит архив поиска.
 * Функция вынесена сюда именно поэтому: ключ обязан совпадать до символа,
 * иначе настройки раздела окажутся в одном месте, а его переписка в другом.
 * Разделитель — подчёркивание, а не двоеточие: ключ становится именем файла.
 */
export function sessionKey(ctx: SessionlessContext): string | undefined {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return undefined;

  const message = ctx.message ?? ctx.callbackQuery?.message;
  const isTopic = message && 'is_topic_message' in message && message.is_topic_message;
  const threadId = isTopic ? message.message_thread_id : undefined;

  return threadId === undefined ? String(chatId) : `${chatId}_${threadId}`;
}

/** Пауза на указанное число миллисекунд. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ограничивает время выполнения промиса.
 * Нужно, потому что зависший запрос к нейросети иначе будет держать
 * пользователя (и память процесса) бесконечно долго.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: превышен таймаут ${Math.round(ms / 1000)} с`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Человекочитаемая длительность: 3665000 -> "1 ч 1 мин 5 с". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} с`);
  return parts.join(' ');
}

/**
 * Показывает статус «печатает…» / «отправляет фото…», пока выполняется
 * долгая операция. Telegram гасит индикатор через ~5 секунд, поэтому
 * его приходится периодически обновлять.
 */
export async function withChatAction<T>(
  ctx: BotContext,
  action: 'typing' | 'upload_photo' | 'record_voice' | 'upload_voice' | 'upload_document',
  task: () => Promise<T>,
): Promise<T> {
  const send = () => {
    // Ошибки индикатора намеренно глушим: это украшение, а не основная работа.
    void ctx.replyWithChatAction(action).catch(() => undefined);
  };

  send();
  const timer = setInterval(send, 4500);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

/** Определяет mime-тип картинки по «магическим» первым байтам. */
export function detectImageMime(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

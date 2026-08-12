/**
 * Мелкие утилиты, которые нужны в нескольких местах проекта.
 */
import type { BotContext } from './types.js';

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

/**
 * Режет длинный текст на куски, влезающие в одно сообщение Telegram
 * (жёсткий лимит — 4096 символов). Стараемся резать по переводу строки,
 * чтобы не рвать слова и абзацы посередине.
 */
export function splitMessage(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Ищем ближайший удобный разделитель с конца окна.
    const breakPoint = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = breakPoint > limit * 0.5 ? breakPoint : limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Экранирует спецсимволы для parse_mode: 'HTML'. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  action: 'typing' | 'upload_photo',
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

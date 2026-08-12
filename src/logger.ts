/**
 * Минималистичный логгер без внешних зависимостей.
 *
 * - в разработке пишет человекочитаемые цветные строки;
 * - в продакшене — JSON-строки (удобно собирать через docker logs, Loki, ELK и т.п.).
 */
import { inspect } from 'node:util';
import { config } from './config.js';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVEL_WEIGHT;

/** Дополнительные поля лога (id пользователя, длительность и т.д.). */
type Meta = Record<string, unknown>;

const threshold = LEVEL_WEIGHT[config.logLevel];

const DECOR: Record<Level, { color: string; badge: string }> = {
  debug: { color: '\x1b[90m', badge: 'DEBUG' },
  info: { color: '\x1b[36m', badge: 'INFO ' },
  warn: { color: '\x1b[33m', badge: 'WARN ' },
  error: { color: '\x1b[31m', badge: 'ERROR' },
};
const RESET = '\x1b[0m';

function write(level: Level, message: string, meta?: Meta): void {
  if (LEVEL_WEIGHT[level] < threshold) return;

  const time = new Date().toISOString();

  if (config.isProduction) {
    // Одна строка = одно событие: так логи легко парсить машинами.
    const payload = JSON.stringify({ time, level, message, ...meta });
    if (level === 'error' || level === 'warn') console.error(payload);
    else console.log(payload);
    return;
  }

  const { color, badge } = DECOR[level];
  const tail = meta && Object.keys(meta).length > 0 ? ` ${inspect(meta, { depth: 3, colors: true })}` : '';
  const line = `${color}${badge}${RESET} ${time.slice(11, 19)} ${message}${tail}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** Превращает что угодно (Error, строку, объект) в набор полей для лога. */
export function describeError(error: unknown): Meta {
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      // Стек в проде тоже нужен — без него отладка превращается в гадание.
      stack: error.stack,
      ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
    };
  }
  return { error: String(error) };
}

export const logger = {
  debug: (message: string, meta?: Meta) => write('debug', message, meta),
  info: (message: string, meta?: Meta) => write('info', message, meta),
  warn: (message: string, meta?: Meta) => write('warn', message, meta),
  error: (message: string, meta?: Meta) => write('error', message, meta),
};

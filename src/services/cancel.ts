/**
 * Кнопка «Отмена» под долгими запросами («!размышление», «!сеть»).
 *
 * Думает модель минуты, а ждать её молча — читать поломку. Поэтому под
 * «думаю…»-уведомлением висит кнопка: нажатие роняет AbortController,
 * сигнал которого вызывающий код заранее прокинул вниз до fetch
 * (см. signal в TextGenerationOptions). Деньги это не возвращает —
 * ушедший запрос уже ушёл, — но ожидание режет и слот нормы освобождает.
 *
 * Контроллеры живут здесь, в памяти процесса, а не в сессии: сессия
 * персистится в файлы, а AbortController несериализуем. Ключ —
 * `chatId:noticeId` (уникален на чат, коротко влезает в callback_data
 * с его потолком 64 байта). Запись удаляет тот, кто acted первым:
 * кнопка — при отмене, обработчик — в finally при любом исходе,
 * поэтому двойного release квоты быть не может.
 */
import { InlineKeyboard } from 'grammy';
import { ProviderRequestError } from '../types.js';

/** Чей слот нормы освобождать при отмене — других долгих путей пока нет. */
export type CancellableQuota = 'deep' | 'web';

export interface PendingTask {
  controller: AbortController;
  /** Кто заказал: чужую кнопку не обслуживаем, а вежливо отбиваем. */
  userId: number | undefined;
  quota: CancellableQuota;
}

const pending = new Map<string, PendingTask>();

/** Префикс callback_data кнопки отмены. Держать коротким (потолок — 64 байта). */
export const CANCEL_CB = 'c';

/** Ключ задачи: chatId:noticeId. */
export function taskKey(chatId: number | string, noticeId: number): string {
  return `${chatId}:${noticeId}`;
}

/** Клавиатура из одной кнопки «Отмена» под уведомлением. */
export function cancelKeyboard(key: string): InlineKeyboard {
  return new InlineKeyboard().text('✖️ Отмена', `${CANCEL_CB}:${key}`);
}

/**
 * Запоминает контроллер нового долгого запроса и возвращает его же —
 * для `signal` вниз по стеку. Вызывать после отправки уведомления
 * (нужен его message_id для ключа).
 */
export function registerTask(key: string, userId: number | undefined, quota: CancellableQuota): AbortController {
  const controller = new AbortController();
  pending.set(key, { controller, userId, quota });
  return controller;
}

/**
 * Забирает задачу (и удаляет из реестра). Вызывающий код — в finally:
 * что осталось после естественного финиша или ошибки — то протухшее,
 * держать его в памяти незачем.
 */export function takeTask(key: string): PendingTask | undefined {
  const task = pending.get(key);
  if (task) pending.delete(key);
  return task;
}

/**
 * Подсмотреть задачу, не забирая. Нужно кнопке: чужой запрос отбиваем,
 * не трогая чужого контроллера и не теряя запись.
 */
export function peekTask(key: string): PendingTask | undefined {
  return pending.get(key);
}

/** Ошибка отмены для слоёв, у которых нет своего fetch с сигналом (цепочки). */
export function cancelledError(provider: string): ProviderRequestError {
  return new ProviderRequestError(provider, 'Запрос отменён.', { kind: 'cancelled' });
}

/**
 * Внешний сигнал + таймаут одним целым для fetch. Без внешнего —
 * ровно AbortSignal.timeout, как раньше. AbortSignal.any доступен
 * начиная с Node 20 — отдельная библиотека не нужна.
 */
export function withTimeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  if (!signal) return AbortSignal.timeout(ms);
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/**
 * Это отмена, а не поломка: либо голый AbortError, либо наш kind.
 * Такую ошибку вызывающий код не показывает человеку и слот за неё
 * не держит — кнопка уже всё сказала и вернула.
 */
export function isCancelled(error: unknown): boolean {
  if (error instanceof ProviderRequestError && error.kind === 'cancelled') return true;
  return error instanceof Error && error.name === 'AbortError';
}

/** Бросить отмену, если сигнал уже сорван — проверка перед очередным шагом. */
export function throwIfAborted(provider: string, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError(provider);
}

/**
 * Перебор цепочки моделей.
 *
 * Это не экономия квоты, а страховка. Дневных норм при нашем размере группы
 * хватает с многократным запасом, но норма может кончиться из-за случайности,
 * а модель — внезапно исчезнуть: Google периодически выводит версии из
 * обращения, и вчера работавшее имя сегодня отвечает 404. В обоих случаях
 * правильное поведение одинаковое — молча взять следующую модель, а не
 * показывать человеку ошибку.
 *
 * Ключевая тонкость — не перебирать цепочку там, где это бессмысленно.
 * Неверный ключ, географическая блокировка или отказ цензуры повторятся
 * на любой модели, а таймаут вообще превратит перебор в многоминутное
 * молчание. Что именно считается поводом попробовать дальше — см. RETRYABLE
 * и ProviderErrorKind в src/types.ts.
 */
import { logger } from '../logger.js';
import {
  ProviderRequestError,
  type ProviderErrorKind,
  type TextGenerationOptions,
  type TextProvider,
} from '../types.js';

/** Отказы, после которых имеет смысл попробовать следующую модель. */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>(['quota', 'not-found', 'server']);

export interface ChainAnswer {
  text: string;
  /** Модель, которая в итоге ответила. */
  model: string;
  /** Модели, отказавшие до неё, по порядку. Пусто — ответила первая. */
  skipped: string[];
}

/**
 * Идёт по цепочке моделей и возвращает первый успешный ответ.
 *
 * Бросает ProviderRequestError, если ответить не смог никто: либо на первом
 * же неперебираемом отказе, либо когда цепочка закончилась.
 */
export async function generateWithChain(
  provider: TextProvider,
  models: string[],
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<ChainAnswer> {
  // Пустая цепочка — это «у провайдера одна модель, она в его же настройках».
  // Так работают все провайдеры, кроме Gemini: перебирать там нечего.
  if (models.length === 0) {
    const text = await provider.generateText(prompt, options);
    return { text, model: 'по умолчанию', skipped: [] };
  }

  const skipped: string[] = [];
  let lastError: ProviderRequestError | undefined;

  for (const model of models) {
    try {
      const text = await provider.generateText(prompt, { ...options, model });
      if (skipped.length > 0) {
        logger.info('Ответила резервная модель', { model, skipped });
      }
      return { text, model, skipped };
    } catch (error) {
      const kind = error instanceof ProviderRequestError ? error.kind : 'unknown';

      // Причина, которая повторится на любой модели, — показываем как есть.
      if (!RETRYABLE.has(kind)) throw error;

      lastError = error as ProviderRequestError;
      skipped.push(model);
      logger.warn('Модель отказала, беру следующую из цепочки', { model, kind, message: lastError.message });
    }
  }

  throw new ProviderRequestError(
    provider.id,
    `Ни одна модель не смогла ответить — перепробованы все ${skipped.length}: ${skipped.join(', ')}.\n\n` +
      `Последняя причина: ${lastError?.message ?? 'неизвестна'}`,
    { cause: lastError, kind: lastError?.kind ?? 'unknown' },
  );
}

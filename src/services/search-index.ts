/**
 * Поиск по переписке раздела: «/гем найди ...».
 *
 * Зачем это отдельно от истории диалога. В сессии живут последние два-три
 * десятка реплик — ровно столько, сколько влезает в контекст модели. Всё,
 * что было раньше, для бота не существует, а для людей — существует: «мы же
 * это уже обсуждали, где-то в мае». Поэтому здесь свой архив, и он растёт.
 *
 * Как устроено. Каждое сообщение раздела превращается в вектор (эмбеддинг)
 * и дописывается в файл. Поиск превращает в вектор запрос и ищет ближайшие
 * по косинусной близости — то есть по смыслу, а не по буквам: «где мы
 * обсуждали деплой» найдёт разговор про выкатку на сервер.
 *
 * Про квоту. У эмбеддингов норма 1000 запросов в день, и тратить по запросу
 * на сообщение было бы расточительно. Поэтому сообщения копятся в буфере
 * и уходят пачкой: один запрос на десяток реплик растягивает норму
 * до десяти тысяч сообщений в сутки — заведомо больше, чем напишет группа.
 *
 * Про размер. Вектор хранится не списком чисел в JSON, а base64 от Float32Array:
 * 768 измерений это 3 КБ вместо 15 КБ текстом, и разбирается быстрее.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { translateGeminiError } from './gemini.js';
import { ProviderRequestError } from '../types.js';

/** Одна запомненная реплика. */
export interface IndexedMessage {
  /** Когда сказано, мс. */
  ts: number;
  /** Кто сказал: имя человека или «бот». */
  who: string;
  text: string;
  /** id сообщения в Telegram — из него собирается ссылка. */
  messageId?: number;
}

/** Запись в файле архива: реплика плюс её вектор в base64. */
interface StoredRecord extends IndexedMessage {
  vec: string;
}

/** Найденное: реплика и насколько близко по смыслу (0…1). */
export interface SearchHit extends IndexedMessage {
  score: number;
}

const PROVIDER_ID = 'gemini-embed';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({
      apiKey: config.gemini.apiKey,
      ...(config.gemini.baseUrl ? { httpOptions: { baseUrl: config.gemini.baseUrl } } : {}),
    });
  }
  return client;
}

/** Файл архива раздела. Ключ тот же, что у сессии, — chatId либо chatId_threadId. */
function archivePath(key: string): string {
  // В ключе только цифры, минус и подчёркивание, так что путь безопасен.
  return path.join(config.search.dir, `${key}.jsonl`);
}

function encodeVector(values: number[]): string {
  return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

function decodeVector(encoded: string): Float32Array {
  const raw = Buffer.from(encoded, 'base64');
  // Копируем в свой буфер: Buffer из пула может быть не выровнен под Float32.
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  return new Float32Array(copy.buffer);
}

/**
 * Косинусная близость. Векторы Gemini уже нормированы, но собственную длину
 * всё равно считаем: при outputDimensionality меньше исходной нормировка
 * теряется, и без деления счёт поехал бы.
 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Отказы, после которых имеет смысл взять следующую модель эмбеддингов. */
const RETRYABLE = new Set(['quota', 'not-found', 'server']);

/**
 * Считает векторы для нескольких текстов одним запросом.
 *
 * taskType моделям нужен разный: индексируемая реплика — это документ,
 * а строка поиска — запрос. Пара «документ/запрос» заметно точнее, чем
 * если считать обе стороны одинаково.
 */
async function embed(texts: string[], taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): Promise<number[][]> {
  const skipped: string[] = [];
  let lastError: ProviderRequestError | undefined;

  for (const model of config.search.chain) {
    try {
      const response = await getClient().models.embedContent({
        model,
        contents: texts,
        config: { taskType, outputDimensionality: config.search.dimensions },
      });

      const vectors = (response.embeddings ?? []).map((item) => item.values ?? []);
      if (vectors.length !== texts.length) {
        throw new ProviderRequestError(PROVIDER_ID, 'Модель вернула не столько векторов, сколько текстов.', {
          kind: 'server',
        });
      }

      if (skipped.length > 0) logger.info('Эмбеддинги посчитала запасная модель', { model, skipped });
      return vectors;
    } catch (error) {
      const failure = error instanceof ProviderRequestError ? error : translateGeminiError(PROVIDER_ID, model, error);
      if (!RETRYABLE.has(failure.kind)) throw failure;

      lastError = failure;
      skipped.push(model);
    }
  }

  throw new ProviderRequestError(
    PROVIDER_ID,
    `Не удалось посчитать эмбеддинги: перепробованы все модели (${skipped.join(', ')}). ` +
      `Последняя причина: ${lastError?.message ?? 'неизвестна'}`,
    { cause: lastError, kind: lastError?.kind ?? 'unknown' },
  );
}

/** Накопленные, но ещё не проиндексированные реплики: ключ раздела -> реплики. */
const pending = new Map<string, IndexedMessage[]>();
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Запоминает реплику. Возврата ждать не нужно: индексация идёт пачками
 * в фоне и к ответу пользователю отношения не имеет.
 */
export function rememberMessage(key: string, message: IndexedMessage): void {
  if (!config.search.enabled || !config.gemini.apiKey) return;

  // Совсем короткие реплики искать бессмысленно: «ок», «+», «спасибо».
  if (message.text.trim().length < config.search.minChars) return;

  const queue = pending.get(key) ?? [];
  queue.push(message);
  pending.set(key, queue);

  if (queue.length >= config.search.batchSize) {
    void flush(key);
    return;
  }

  // Иначе ждём: вдруг разговор продолжится и наберётся полная пачка.
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushAll();
    }, config.search.flushMs);
    // Таймер не должен удерживать процесс при остановке бота.
    flushTimer.unref();
  }
}

/** Досчитывает и дописывает в архив всё накопленное по одному разделу. */
async function flush(key: string): Promise<void> {
  const queue = pending.get(key);
  if (!queue || queue.length === 0) return;
  pending.delete(key);

  try {
    const vectors = await embed(
      queue.map((message) => message.text),
      'RETRIEVAL_DOCUMENT',
    );

    const lines = queue
      .map((message, index) => JSON.stringify({ ...message, vec: encodeVector(vectors[index] ?? []) } as StoredRecord))
      .join('\n');

    await mkdir(config.search.dir, { recursive: true });
    await appendFile(archivePath(key), lines + '\n', 'utf8');

    logger.debug('Реплики проиндексированы', { key, count: queue.length });
  } catch (error) {
    // Поиск — удобство, а не основная работа бота: если индексация упала,
    // человек этого даже не заметит, и падать целиком незачем.
    logger.warn('Не удалось проиндексировать реплики', {
      key,
      count: queue.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Сбрасывает накопленное по всем разделам разом. */
export async function flushAll(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => flush(key)));
}

/**
 * Ищет по архиву раздела.
 *
 * Перед поиском досбрасываем буфер: обиднее всего не найти то,
 * что написали пять минут назад.
 */
export async function searchMessages(key: string, query: string): Promise<SearchHit[]> {
  await flush(key);

  let raw: string;
  try {
    raw = await readFile(archivePath(key), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const [queryVector] = await embed([query], 'RETRIEVAL_QUERY');
  if (!queryVector) return [];
  const needle = new Float32Array(queryVector);

  const hits: SearchHit[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as StoredRecord;
      const score = cosine(needle, decodeVector(record.vec));
      hits.push({ ts: record.ts, who: record.who, text: record.text, messageId: record.messageId, score });
    } catch {
      // Битая строка — обрыв записи при остановке процесса. Пропускаем.
    }
  }

  const ranked = hits.sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score ?? 0;

  return ranked
    .filter((hit) => hit.score >= config.search.minScore && hit.score >= best - config.search.scoreGap)
    .slice(0, config.search.topK);
}

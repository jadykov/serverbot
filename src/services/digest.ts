/**
 * Долгая память раздела: скользящая выжимка переписки.
 *
 * Идея отличается от архива поиска (src/services/search-index.ts) ровно
 * в одном, но главном: там реплики просто копятся и достаются по запросу
 * («!найди»), здесь же они постоянно пересжимаются в одну короткую память,
 * которая едет в каждый обычный ответ сама, без всякой команды.
 *
 * Как это устроено. Реплики раздела копятся в буфере (в памяти процесса —
 * как и буфер поиска, переживать рестарт ему не обязательно, максимум
 * потеряется недосчитанный кусок). Когда накопится config.digest.batchSize
 * реплик, буфер целиком уходит в модель вместе с прежней выжимкой: получаем
 * не добавку, а новую выжимку взамен старой — «сжатие сжатого», поэтому
 * размер не растёт, сколько бы времени ни прошло. Готовая выжимка пишется
 * на диск (переживает рестарт) и кэшируется в памяти.
 *
 * Слияние идёт в фоне, уже после того, как человек получил свой ответ:
 * его вызывают и не ждут (см. noteMessage). Считает его отдельная, медленная
 * модель (Gemma по умолчанию) — не та, что отвечает в чате, поэтому лишней
 * задержки или траты минутной нормы «живой» модели не возникает.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { findTextProvider } from './registry.js';

/** Одна ещё не сжатая реплика, ждущая своей очереди в буфере. */
interface PendingLine {
  who: string;
  text: string;
}

/** Накопленное, но ещё не слитое: раздел -> реплики. */
const buffers = new Map<string, PendingLine[]>();

/** Готовая выжимка раздела, однажды прочитанная с диска. */
const cache = new Map<string, string>();

/** Раздел, для которого сейчас идёт слияние — второе не запускаем поверх первого. */
const merging = new Set<string>();

function digestFile(key: string): string {
  // В ключе только цифры, минус и подчёркивание — путь безопасен, как и у сессий.
  return path.join(config.session.dir, 'digest', `${key}.json`);
}

async function loadDigest(key: string): Promise<string> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const raw = await readFile(digestFile(key), 'utf8');
    const parsed = JSON.parse(raw) as { digest?: string };
    const digest = typeof parsed.digest === 'string' ? parsed.digest : '';
    cache.set(key, digest);
    return digest;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn('Не удалось прочитать выжимку раздела', { key, error: String(error) });
    cache.set(key, '');
    return '';
  }
}

/** Пишет выжимку на диск переименованием — как и у справочника ников. */
async function saveDigest(key: string, digest: string): Promise<void> {
  cache.set(key, digest);

  try {
    const file = digestFile(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ digest }), 'utf8');
    await rename(tmp, file);
  } catch (error) {
    logger.warn('Не удалось сохранить выжимку раздела', { key, error: String(error) });
  }
}

const DIGEST_ROLE =
  'Ты — модуль долгой памяти чат-бота: сливаешь прежнюю память и свежий кусок переписки ' +
  'в одну обновлённую память для другой нейросети. Пиши по-русски, сплошным текстом, ' +
  'без заголовков, разметки и вступлений вроде «вот выжимка».';

/** Складывает промпт для слияния: прежняя память + новый кусок переписки. */
function buildMergePrompt(previous: string, lines: PendingLine[]): string {
  const chunk = lines.map((line) => `${line.who}: ${line.text}`).join('\n');

  return [
    previous ? `Текущая память о более ранних разговорах в этом разделе:\n${previous}` : 'Памяти о прошлых разговорах пока нет — это первое слияние.',
    `Свежий кусок переписки, ${lines.length} реплик:\n${chunk}`,
    `Слей это в одну обновлённую память: о чём говорили, кто что просил, планировал, обещал ` +
      `или уточнял, какие имена людей и важные факты всплывали. Свежее важнее старого: если места ` +
      `не хватает на всё, в первую очередь сжимай и обобщай старое, а не выбрасывай новое. ` +
      `Уложись примерно в ${config.digest.maxChars} знаков.`,
  ].join('\n\n');
}

/** Сливает буфер с прежней памятью и сохраняет результат. Ошибку не бросает — только логирует. */
async function mergeDigest(key: string, lines: PendingLine[]): Promise<void> {
  merging.add(key);
  try {
    const gemini = findTextProvider('gemini');
    if (!gemini?.isConfigured) return;

    const previous = await loadDigest(key);
    const prompt = buildMergePrompt(previous, lines);

    const text = await gemini.generateText(prompt, {
      model: config.digest.model,
      systemPrompt: DIGEST_ROLE,
      temperature: 0.3,
      maxOutputTokens: config.digest.maxOutputTokens,
    });

    await saveDigest(key, text.trim().slice(0, config.digest.maxChars));
  } catch (error) {
    // Память — удобство, а не основная работа бота: не срослось — не беда,
    // прежняя выжимка остаётся как была, а буфер уже пуст (реплики не потеряны
    // для разговора, только для этого конкретного слияния).
    logger.warn('Не удалось слить память раздела', { key, error: error instanceof Error ? error.message : String(error) });
  } finally {
    merging.delete(key);
  }
}

/**
 * Запоминает реплику раздела. Возврата ждать не нужно: слияние, когда до него
 * дойдёт очередь, идёт в фоне и к ответу текущему человеку отношения не имеет.
 */
export function noteMessage(key: string, who: string, text: string): void {
  if (!config.digest.enabled || !findTextProvider('gemini')?.isConfigured) return;
  if (text.trim().length < config.digest.minChars) return;

  const queue = buffers.get(key) ?? [];
  queue.push({ who, text });
  buffers.set(key, queue);

  if (queue.length >= config.digest.batchSize && !merging.has(key)) {
    buffers.delete(key);
    void mergeDigest(key, queue);
  }
}

/** Отдаёт текущую память раздела — пустая строка, если сливать ещё нечего. */
export async function getDigest(key: string): Promise<string> {
  if (!config.digest.enabled) return '';
  return loadDigest(key);
}

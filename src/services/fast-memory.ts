/**
 * Быстрая память раздела: короткие директивы о том, что просили в чате,
 * как разговаривать, что делать и чего не делать.
 *
 * Отличие от выжимки (digest.ts): выжимка помнит «о чём говорили», памятка —
 * «как со мной надо». Требования к тону, запреты, предпочтения, мелкие факты
 * о собеседнике. Поэтому и вес другой: выжимка — до 9000 знаков, памятка —
 * не более maxLines строк по maxLineChars (см. config.fastMemory). Памятка
 * грузится в каждый обычный ответ, расти ей нельзя — старые строки при
 * обновлении вытесняются, а не дописываются.
 *
 * Обновление — довеском к слиянию выжимки: тот же свежий кусок переписки
 * уходит вторым дешёвым вызовом в ту же Gemma (см. mergeDigest в digest.ts).
 * Отдельного расписания нет: раз в batchSize реплик — достаточно свежо
 * для директив и достаточно редко, чтобы не тратить ничего.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { PendingLine } from './digest.js';
import { findTextProvider } from './registry.js';

/** Строки памятки, однажды прочитанные с диска. */
const cache = new Map<string, string[]>();

function notesFile(key: string): string {
  // Ключ тот же безопасный, что у выжимки (цифры, минус, подчёркивание),
  // префикс свой, чтобы listDigestKeys не принимал памятку за раздел.
  return path.join(config.session.dir, 'digest', `notes-${key}.json`);
}

async function loadNotes(key: string): Promise<string[]> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const raw = await readFile(notesFile(key), 'utf8');
    const parsed = JSON.parse(raw) as { lines?: unknown };
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.filter((line): line is string => typeof line === 'string' && line.length > 0)
      : [];
    cache.set(key, lines);
    return lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Не удалось прочитать быструю память', { key, error: String(error) });
    }
    cache.set(key, []);
    return [];
  }
}

async function saveNotes(key: string, lines: string[]): Promise<void> {
  cache.set(key, lines);

  const file = notesFile(key);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ lines }), 'utf8');
    await rename(tmp, file);
  } catch (error) {
    logger.warn('Не удалось сохранить быструю память', { key, error: String(error) });
  }
}

/**
 * Чистит ответ модели до списка строк памятки: по одной на строку, без
 * нумерации и маркеров, не длиннее потолка. Чистая функция — проверяется
 * без модели и диска.
 */
export function parseNotesLines(text: string, maxLines: number, maxLineChars: number): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^[\s\-*•·\d.)]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, Math.max(maxLines, 0))
    .map((line) => line.slice(0, Math.max(maxLineChars, 0)))
    .filter((line) => line.length > 0);
}

/**
 * Памятка раздела одной строкой для промпта — пустая, если фиксировать
 * пока нечего. Пустота не ошибка: тогда правило просто не добавляется.
 */
export async function getFastMemory(key: string | undefined): Promise<string> {
  if (!config.fastMemory.enabled || !key) return '';
  const lines = await loadNotes(key);
  return lines.join('\n');
}

const NOTES_KEEPER =
  'Ты — секретарь чат-бота: ведёшь его короткую памятку о собеседнике. ' +
  'Памятка — это durable-директивы, а не пересказ болтовни.';

/**
 * Обновляет памятку по свежему куску переписки: прежние строки плюс кусок —
 * новые строки взамен. Звать из слияния выжимки (см. mergeDigest): кусок
 * тот же, вызов второй и дешёвый. Ошибку не бросает — только логирует.
 */
export async function updateFastMemory(key: string, lines: PendingLine[]): Promise<void> {
  if (!config.fastMemory.enabled || lines.length === 0) return;

  try {
    const gemini = findTextProvider('gemini');
    if (!gemini?.isConfigured) return;

    const previous = await loadNotes(key);
    const chunk = lines.map((line) => `${line.who}: ${line.text}`).join('\n');

    const text = await gemini.generateText(
      `${previous.length > 0 ? `Текущая памятка:\n${previous.join('\n')}\n\n` : 'Памятки пока нет — это первая.'}` +
        `Свежий кусок переписки:\n${chunk}\n\n` +
        'Обнови памятку: оставь still-верное, выкинь устаревшее, добавь новое из куска. ' +
        'Бери только durable-директивы: как просили разговаривать (тон, длина, формат), что делать и чего не делать, ' +
        'предпочтения и мелкие факты о собеседнике. Болтовню, разовые вопросы и ответы на них — не бери. ' +
        `Не более ${config.fastMemory.maxLines} строк, каждая — одна директива одним предложением. ` +
        'Верни ТОЛЬКО строки памятки, по одной на строку, без нумерации, маркеров и пояснений.',
      {
        model: config.fastMemory.model,
        systemPrompt: NOTES_KEEPER,
        temperature: 0.3,
        maxOutputTokens: config.fastMemory.maxOutputTokens,
        timeoutMs: 90_000,
        // Без общих правил бота — это не ответ в чат, а служебные строки.
        rawSystemPrompt: true,
      },
    );

    await saveNotes(key, parseNotesLines(text, config.fastMemory.maxLines, config.fastMemory.maxLineChars));
  } catch (error) {
    // Памятка — удобство, а не основная работа: не срослось — останется
    // прежняя, а разговору это никак не мешает.
    logger.warn('Не удалось обновить быструю память', { key, error: error instanceof Error ? error.message : String(error) });
  }
}

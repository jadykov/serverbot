/**
 * Список разделов, где бот хоть раз видел сообщение.
 *
 * Нужен ровно одному потребителю — спонтанным репликам (src/services/spontaneous.ts):
 * та работает фоново, без апдейта от Telegram, и сама выбрать, в каких
 * разделах вообще есть жизнь, не может. Хранилище сессий (@grammyjs/storage-file)
 * списка своих ключей не отдаёт, поэтому ведём свой — отдельно от сессии
 * и предельно простой: раздел один раз добавился и больше не трогается.
 *
 * Выключенные через /stop разделы отсюда не убираются: список — это «где бот
 * бывал», а не «где он сейчас говорит». Молчание проверяется отдельно, в момент
 * самой попытки написать (см. spontaneous.ts) — так же, как и обычные ответы.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const known = new Set<string>();
let loaded = false;

const registryFile = (): string => path.join(config.session.dir, 'topics.json');

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;

  try {
    const raw = await readFile(registryFile(), 'utf8');
    const parsed = JSON.parse(raw) as string[];
    for (const key of parsed) known.add(key);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn('Не удалось прочитать список разделов', { error: String(error) });
  }
}

async function save(): Promise<void> {
  try {
    await mkdir(path.dirname(registryFile()), { recursive: true });
    const tmp = `${registryFile()}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify([...known]), 'utf8');
    await rename(tmp, registryFile());
  } catch (error) {
    logger.warn('Не удалось сохранить список разделов', { error: String(error) });
  }
}

/** Запоминает раздел. Дешёвая на каждый день после первого: пишет на диск только новый ключ. */
export async function noteTopic(key: string): Promise<void> {
  if (known.has(key)) return;

  await load();
  if (known.has(key)) return;

  known.add(key);
  await save();
}

export async function knownTopics(): Promise<string[]> {
  await load();
  return [...known];
}

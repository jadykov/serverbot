/**
 * Справочник «@ник → id»: кто в разделах писал и под каким именем.
 *
 * Заведён ради одной вещи, которой у Telegram нет вовсе: превратить «@ник»
 * в числовой id. Метода «найди пользователя по нику» в Bot API не существует
 * ни в каком виде — бот знает человека только по сообщению, которое тот сам
 * прислал. Поэтому справочник копится по ходу разговора: каждый написавший
 * оставляет в нём запись, и после этого его можно назвать ником, а не числом.
 *
 * Отсюда два следствия, о которых честнее знать заранее:
 *
 *  • молчун боту неизвестен. Человек, не написавший ни слова с тех пор, как
 *    справочник появился, по нику не найдётся — его сначала надо услышать;
 *  • ник — не постоянная величина. Его меняют, и старая запись после этого
 *    указывает на того же человека, но зовут его уже иначе. Ключ поэтому
 *    не удаляется, а перезаписывается: id в записи всегда свежий.
 *
 * Хранение — как у дневных норм: работаем из памяти, на диск пишем ради
 * переживания рестарта, файл лежит в каталоге сессий (в Docker это том).
 * Запись на диск происходит не на каждое сообщение, а только когда справочник
 * действительно изменился: пришёл новый человек или сменил ник.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** Что помним про человека. Ник — ключ, поэтому в записи его нет. */
export interface KnownUser {
  id: number;
  /** Имя из профиля — чтобы в ответе бота было видно, кого он нашёл. */
  name?: string;
}

/** Ник в нижнем регистре -> человек. */
const users = new Map<string, KnownUser>();
let loaded = false;

const directoryFile = (): string => path.join(config.session.dir, 'usernames.json');

/** Приводит «@Cochujang», «Cochujang» и «cochujang» к одному ключу. */
function normalize(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

/** Читает справочник с диска. Нет файла — не беда, начнём копить заново. */
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;

  try {
    const raw = await readFile(directoryFile(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, KnownUser>;
    for (const [username, user] of Object.entries(parsed)) {
      if (typeof user?.id === 'number') users.set(username, user);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn('Не удалось прочитать справочник ников', { file: directoryFile() });
  }
}

/**
 * Пишет справочник на диск переименованием: оборвись процесс — файл целый.
 *
 * Имя временного файла своё у каждой записи, включая случайный хвост. Это
 * не педантизм: rememberUser зовётся на каждое сообщение и не ожидается
 * вызывающим, так что два новых человека в одну миллисекунду дали бы две записи
 * с одним именем — они писали бы в один файл вперемешку, а переименовали бы
 * вторым, и на диск легла бы каша. Следующий старт не разобрал бы JSON
 * и начал справочник с нуля.
 */
async function save(): Promise<void> {
  const plain: Record<string, KnownUser> = {};
  for (const [username, user] of users) plain[username] = user;

  try {
    await mkdir(path.dirname(directoryFile()), { recursive: true });
    const tmp = `${directoryFile()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(plain), 'utf8');
    await rename(tmp, directoryFile());
  } catch (error) {
    logger.warn('Не удалось сохранить справочник ников', { error: String(error) });
  }
}

/**
 * Запоминает написавшего. Зовётся на каждое сообщение, поэтому дешёвая:
 * без изменений — ни записи на диск, ни лишней работы.
 */
export async function rememberUser(from: {
  id: number;
  username?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
}): Promise<void> {
  if (!from.username) return;

  await load();

  const key = normalize(from.username);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const known = users.get(key);

  if (known?.id === from.id && known.name === (name || undefined)) return;

  users.set(key, { id: from.id, ...(name ? { name } : {}) });
  await save();
}

/** Ищет человека по нику. Собака и регистр не важны. */
export async function findUser(username: string): Promise<KnownUser | undefined> {
  await load();
  return users.get(normalize(username));
}

/** Сколько человек в справочнике — для подсказки, когда ник не нашёлся. */
export async function knownUsers(): Promise<number> {
  await load();
  return users.size;
}

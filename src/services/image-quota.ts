/**
 * Дневная норма картинок на одного пользователя.
 *
 * Зачем отдельно от рейт-лимита: тот считает запросы в минуту и защищает
 * от зажатого Enter, а здесь речь о деньгах. Картинка у Krea стоит $0,015 —
 * в семь раз дороже прежней модели, — и без нормы один увлёкшийся человек
 * за вечер тратит бюджет всей группы.
 *
 * Счётчик лежит на диске рядом с сессиями, а не в памяти процесса: иначе
 * любой рестарт или деплой молча обнулял бы норму всем сразу, и лимит
 * обходился бы простым «попросите перезапустить бота».
 *
 * Ограничение то же, что у рейт-лимита: считается один процесс. Для нескольких
 * реплик счётчик нужно выносить в общее хранилище (Redis).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** Сколько картинок пользователь уже потратил и в какой день. */
interface QuotaRecord {
  /** Календарный день в виде YYYY-MM-DD по часовому поясу из конфигурации. */
  day: string;
  used: number;
}

/**
 * Файл лежит в каталоге сессий: он уже смонтирован на том в Docker, и терять
 * счётчик по той же причине, по которой мы не теряем настройки топиков,
 * не хочется. Имя не пересекается с файлами сессий — те называются по id чата.
 */
const QUOTA_FILE = path.join(config.session.dir, 'image-quota.json');

/** userId -> запись. Диск здесь — надёжность, а работаем из памяти. */
const records = new Map<number, QuotaRecord>();
let loaded = false;

/** Текущий календарный день в настроенном часовом поясе: YYYY-MM-DD. */
function currentDay(): string {
  // Локаль en-CA выбрана не для языка, а ради формата: она единственная
  // из распространённых печатает дату как 2026-08-14.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.imageQuota.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Сколько осталось до полуночи в том же часовом поясе, человеческим текстом. */
function timeUntilReset(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.imageQuota.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  const [hours = 0, minutes = 0] = parts.split(':').map(Number);
  const minutesLeft = 24 * 60 - (hours * 60 + minutes);

  if (minutesLeft < 60) return `${minutesLeft} мин`;
  const h = Math.floor(minutesLeft / 60);
  const m = minutesLeft % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

/** Читает счётчики с диска. Отсутствующий или битый файл — не ошибка. */
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;

  try {
    const raw = await readFile(QUOTA_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, QuotaRecord>;
    const today = currentDay();

    for (const [userId, record] of Object.entries(parsed)) {
      // Вчерашние записи не восстанавливаем: норма уже обновилась,
      // а файл заодно не растёт бесконечно.
      if (record?.day === today) records.set(Number(userId), record);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('Не удалось прочитать счётчик картинок, начинаем с нуля', { file: QUOTA_FILE });
    }
  }
}

/** Пишет счётчики на диск: сначала во временный файл, потом переименованием. */
async function save(): Promise<void> {
  const today = currentDay();
  const plain: Record<string, QuotaRecord> = {};
  for (const [userId, record] of records) {
    if (record.day === today) plain[String(userId)] = record;
  }

  try {
    await mkdir(path.dirname(QUOTA_FILE), { recursive: true });
    // Переименование атомарно: оборвись процесс на середине записи,
    // на диске останется целый предыдущий файл, а не половина нового.
    const tmp = `${QUOTA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(plain), 'utf8');
    await rename(tmp, QUOTA_FILE);
  } catch (error) {
    // Счётчик не критичен настолько, чтобы из-за него не отдать картинку:
    // в худшем случае норма переживёт рестарт неточной.
    logger.warn('Не удалось сохранить счётчик картинок', { file: QUOTA_FILE, error: String(error) });
  }
}

/** Ответ на попытку занять слот. */
export type QuotaDecision =
  | { allowed: true; used: number; limit: number; remaining: number }
  | { allowed: false; used: number; limit: number; resetsIn: string };

/**
 * Занимает одну картинку из дневной нормы.
 *
 * Слот именно занимается заранее, а не списывается по факту готовой картинки:
 * рисование идёт полминуты, и за это время можно успеть отправить команду
 * ещё дважды. При неудачной генерации слот возвращается — см. releaseImageSlot.
 */
export async function reserveImageSlot(userId: number | undefined): Promise<QuotaDecision> {
  const limit = config.imageQuota.perUserPerDay;

  // 0 или меньше — лимит выключен. Админы, в отличие от рейт-лимита, норме
  // подчиняются наравне со всеми: рейт-лимит защищает бота от спама, а норма
  // делит общий кошелёк, и исключений в ней быть не должно — иначе это уже
  // не общая норма, а привилегия.
  if (limit <= 0 || userId === undefined) {
    return { allowed: true, used: 0, limit: 0, remaining: Number.POSITIVE_INFINITY };
  }

  await load();

  const today = currentDay();
  const record = records.get(userId);
  const used = record?.day === today ? record.used : 0;

  if (used >= limit) {
    logger.info('Дневная норма картинок исчерпана', { userId, used, limit });
    return { allowed: false, used, limit, resetsIn: timeUntilReset() };
  }

  records.set(userId, { day: today, used: used + 1 });
  await save();

  return { allowed: true, used: used + 1, limit, remaining: limit - used - 1 };
}

/**
 * Сколько осталось на сегодня, без списания. Нужно, чтобы показать остаток
 * ещё до рисования — в подтверждении, когда деньги ещё не потрачены.
 */
export async function peekImageQuota(userId: number | undefined): Promise<{ used: number; limit: number } | null> {
  const limit = config.imageQuota.perUserPerDay;
  if (limit <= 0 || userId === undefined) return null;

  await load();
  const record = records.get(userId);
  return { used: record?.day === currentDay() ? record.used : 0, limit };
}

/** Возвращает занятый слот обратно, если картинка так и не получилась. */
export async function releaseImageSlot(userId: number | undefined): Promise<void> {
  if (userId === undefined) return;

  const record = records.get(userId);
  if (!record || record.day !== currentDay() || record.used <= 0) return;

  record.used -= 1;
  await save();
}

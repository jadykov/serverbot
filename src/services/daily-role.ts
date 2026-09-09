/**
 * Роль дня раздела: вечером бот читает выжимку Gemma и выбирает себе
 * краткую роль на завтра (тон и фокус обычных ответов «гем вопрос»).
 *
 * Почему отдельным файлом, а не внутри digest.ts: выжимка — это память,
 * а роль — поведение; у них разные расписания, разные модели-выборщики
 * и разное время жизни. Общее только каталог на диске.
 *
 * Как это устроено. Раз в минуту таймер (см. startDailyRoleTimer, зовётся
 * из index.ts) сверяет московское время с DAILY_ROLE_HOUR:MINUTE. В срок —
 * обход всех разделов с готовой выжимкой (см. listDigestKeys): у кого
 * выжимки хватает (см. minDigestChars), тому выбираем роль одной дешёвой
 * генерацией и кладём в roles.json рядом с выжимками. askChain подмешивает
 * роль только в smart-цепочку; нет роли — поведение как раньше.
 *
 * Пропуск срока из-за рестарта догоняется на старте: если 18:00 уже прошло,
 * а сегодняшнего выбора не было — выбираем сразу. Двойной запуск в одну
 * минуту невозможен (метка lastRun), повтор после рестарта — возможен,
 * но безвреден: та же дата просто перезапишется.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getDigest, listDigestKeys } from './digest.js';
import { findTextProvider } from './registry.js';

/** Одна выбранная роль: на какую дату и каким текстом. */
interface RoleEntry {
  date: string;
  role: string;
}

/** Всё состояние файла: когда выбирали в последний раз + роли разделов. */
interface RolesFile {
  lastRun: string;
  roles: Record<string, RoleEntry>;
}

/** Роли, однажды прочитанные с диска. */
const cache = new Map<string, RoleEntry>();
let cacheLoaded = false;
let cacheLoad: Promise<void> | null = null;
/** Дата (YYYY-MM-DD) последнего выбора — переживает рестарт в файле. */
let lastRun = '';

function rolesFile(): string {
  return path.join(config.session.dir, 'digest', 'roles.json');
}

/** Дата московским календарём: 2026-09-09. */
export function dayIn(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Час и минута московским временем — для сверки со сроком. */
export function hourMinuteIn(timezone: string, at: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const hour = get('hour');
  // Полночь в hour12:false иногда отдаётся как «24» — приводим к нулю,
  // иначе срок в 00:00 никогда бы не наступил, а дата бы поплыла.
  return { hour: hour === 24 ? 0 : hour, minute: get('minute') };
}

function isValidEntry(entry: unknown): entry is RoleEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as Record<string, unknown>;
  return typeof candidate['date'] === 'string' && typeof candidate['role'] === 'string';
}

async function ensureLoaded(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoad ??= loadRoles().then(() => {
    cacheLoaded = true;
  });
  await cacheLoad;
}

async function loadRoles(): Promise<void> {
  try {
    const raw = await readFile(rolesFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RolesFile>;
    if (typeof parsed.lastRun === 'string') lastRun = parsed.lastRun;
    const roles = parsed.roles;
    if (typeof roles === 'object' && roles !== null) {
      for (const [key, entry] of Object.entries(roles)) {
        if (isValidEntry(entry) && entry.role) cache.set(key, entry);
      }
    }
  } catch (error) {
    // Файла ещё нет — ролей нет, это обычный старт, а не поломка.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Не удалось прочитать роли дня', { error: String(error) });
    }
  }
}

async function saveRoles(): Promise<void> {
  const file = rolesFile();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const payload: RolesFile = { lastRun, roles: Object.fromEntries(cache) };
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, file);
  } catch (error) {
    logger.warn('Не удалось сохранить роли дня', { error: String(error) });
  }
}

/**
 * Роль раздела для обычных ответов — пустая строка, если выбирать
 * ещё не из чего. Пустота здесь не ошибка: askChain тогда ведёт себя
 * ровно как раньше, без всякой роли.
 */
export async function getDailyRole(key: string | undefined): Promise<string> {
  if (!config.dailyRole.enabled || !key) return '';
  await ensureLoaded();
  return cache.get(key)?.role ?? '';
}

const ROLE_MAKER =
  'Ты придумываешь краткую роль на завтра для ассистента чат-бота по выжимке сегодняшних разговоров. ' +
  'Роль — это тон и фокус обычных ответов, а не новая личность.';

/** Просит модель выбрать роль по выжимке. Бросает — зовёт тот, кто логирует. */
async function pickRole(digest: string): Promise<string> {
  const gemini = findTextProvider('gemini');
  if (!gemini?.isConfigured) throw new Error('провайдер Gemini не настроен');

  const text = await gemini.generateText(
    `Выжимка сегодняшних разговоров раздела:\n${digest}\n\n` +
      'Придумай роль на завтра: 1–2 фразы по-русски — каким быть в обычных ответах (тон, на что обращать внимание). ' +
      'Без смены имени (бот — «гем»), без выдачи себя за человека или другую модель, ' +
      'без политики, медицины и финансовых советов. Верни ТОЛЬКО текст роли, без пояснений.',
    {
      model: config.dailyRole.model,
      systemPrompt: ROLE_MAKER,
      temperature: 0.7,
      // Потолок с запасом: роль короткая, но модели из семейства Gemma
      // с маленьким лимитом отвечают пустотой (см. комментарий у gemini.ts).
      maxOutputTokens: 2_000,
      timeoutMs: 90_000,
      // Без общих правил бота (разметка, смайлики) — это не ответ в чат,
      // а служебная строка, им они только мешают.
      rawSystemPrompt: true,
    },
  );

  return text.trim().slice(0, config.dailyRole.maxRoleChars);
}

/** Обходит разделы и выбирает роль тем, у кого выжимки хватает. */
async function pickAll(today: string): Promise<void> {
  const keys = await listDigestKeys();
  let picked = 0;
  for (const key of keys) {
    const digest = await getDigest(key);
    if (digest.trim().length < config.dailyRole.minDigestChars) continue;
    try {
      const role = await pickRole(digest);
      if (!role) continue;
      cache.set(key, { date: today, role });
      picked += 1;
    } catch (error) {
      // Роль — украшение, а не основная работа: одному разделу не выбралось —
      // остальные всё равно получат свои, а этот — завтра.
      logger.warn('Не удалось выбрать роль дня', { key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await saveRoles();
  logger.info('Роли дня выбраны', { sections: picked });
}

/** Один тик таймера: в срок — выбрать, иначе — ничего не делать. */
async function tick(catchup: boolean): Promise<void> {
  if (!config.dailyRole.enabled) return;
  await ensureLoaded();
  const now = new Date();
  const { hour, minute } = hourMinuteIn(config.dailyRole.timezone, now);
  const today = dayIn(config.dailyRole.timezone, now);
  if (lastRun === today) return;

  const due = hour > config.dailyRole.hour || (hour === config.dailyRole.hour && minute >= config.dailyRole.minute);
  // Без catchup — только точное попадание в минуту срока; с ним (старт бота) —
  // ещё и «срок сегодня уже прошёл, а выбора не было».
  if ((minute === config.dailyRole.minute && hour === config.dailyRole.hour) || (catchup && due)) {
    lastRun = today;
    await pickAll(today);
  }
}

/**
 * Запускает минутный таймер выбора роли. Возвращает его же для остановки
 * в shutdown (см. index.ts). Импорт модуля таймер не ставит — только эта
 * функция, чтобы ничего не тикало в тестах и скриптах.
 */
export function startDailyRoleTimer(): NodeJS.Timeout {
  const timer = setInterval(() => void tick(false).catch((error: unknown) => {
    logger.warn('Тик ролей дня сорвался', { error: error instanceof Error ? error.message : String(error) });
  }), 60_000);
  // Догоняем пропущенный сегодня срок (рестарт после 18:00) — обычный тик
  // дальше ходит сам каждую минуту.
  void tick(true).catch((error: unknown) => {
    logger.warn('Стартовый выбор ролей дня сорвался', { error: error instanceof Error ? error.message : String(error) });
  });
  return timer;
}

/**
 * Конфигурация приложения.
 *
 * Все настройки читаются ТОЛЬКО из переменных окружения:
 *  - в разработке они подтягиваются из файла .env (пакет dotenv);
 *  - в продакшене/докере — из окружения контейнера (env_file, -e, секреты оркестратора).
 *
 * Модуль ничего не выбрасывает при импорте: ошибки конфигурации складываются
 * в массив и проверяются функцией assertConfigValid() уже при старте,
 * чтобы пользователь увидел понятное сообщение, а не стектрейс.
 */
import 'dotenv/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Читает переменную окружения, пустую строку считает отсутствующим значением. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

/** Читает строку со значением по умолчанию. */
function envString(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

/** Читает целое число, при мусоре в значении — падает с понятным текстом. */
function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Переменная окружения ${name} должна быть числом, а получено: "${raw}"`);
  }
  return parsed;
}

/** Читает булево значение: true/1/yes/on считаются истиной. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return ['true', '1', 'yes', 'on', 'da'].includes(raw);
}

/** Читает список числовых id через запятую: "123,456" -> [123, 456]. */
function envIdList(name: string): number[] {
  const raw = env(name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id));
}

// Ошибки конфигурации собираем сюда, а не бросаем сразу.
const configErrors: string[] = [];

const nodeEnv = envString('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

const botToken = env('BOT_TOKEN') ?? '';
if (!botToken) {
  configErrors.push('BOT_TOKEN не задан. Получите токен у @BotFather и впишите его в .env');
} else if (!/^\d+:[\w-]{30,}$/.test(botToken)) {
  configErrors.push('BOT_TOKEN выглядит некорректно. Ожидается формат 1234567890:AA...');
}

const logLevelRaw = envString('LOG_LEVEL', 'info').toLowerCase();
const logLevel: LogLevel = (['debug', 'info', 'warn', 'error'] as const).includes(logLevelRaw as LogLevel)
  ? (logLevelRaw as LogLevel)
  : 'info';

/** Единый объект конфигурации, который импортируют все остальные модули. */
export const config = {
  nodeEnv,
  isProduction,
  logLevel,

  bot: {
    token: botToken,
    dropPendingUpdates: envBool('DROP_PENDING_UPDATES', true),
  },

  /**
   * Встроенный HTTP-сервер нужен только для проверки живости (/health):
   * его дёргают docker healthcheck, systemd-мониторинг или внешний аптайм-чекер.
   * Наружу он не публикуется — ни домен, ни открытые порты не требуются.
   */
  server: {
    host: envString('SERVER_HOST', '0.0.0.0'),
    port: envInt('SERVER_PORT', 3000),
  },

  /** Telegram id администраторов: без рейт-лимита и с расширенным /status. */
  adminIds: envIdList('ADMIN_IDS'),

  rateLimit: {
    max: envInt('RATE_LIMIT_MAX', 15),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000),
  },

  ai: {
    /** Общий таймаут запроса к любой нейросети. */
    timeoutMs: envInt('AI_TIMEOUT_MS', 90_000),
    /** Сколько сообщений диалога держать в контексте (0 — без истории). */
    historyLimit: envInt('HISTORY_LIMIT', 10),
  },

  gemini: {
    apiKey: env('GEMINI_API_KEY') ?? '',
    // Плавающий алиас: всегда актуальная lite-модель. Конкретные версии
    // со временем выводят из обращения, и они начинают отвечать 404.
    // Именно lite — она не тратит токены на «размышления»: для чат-бота
    // это заметно быстрее и дешевле.
    model: envString('GEMINI_MODEL', 'gemini-flash-lite-latest'),
    /**
     * Управление «размышлениями». Пусто — параметр не отправляется вовсе
     * (безопасно для любой модели). Подробности — в src/services/gemini.ts.
     */
    thinking: env('GEMINI_THINKING') ?? '',
  },

  openai: {
    apiKey: env('OPENAI_API_KEY') ?? '',
    baseUrl: envString('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: envString('OPENAI_MODEL', 'gpt-4o-mini'),
  },

  fusionbrain: {
    apiKey: env('FUSIONBRAIN_API_KEY') ?? '',
    secretKey: env('FUSIONBRAIN_SECRET_KEY') ?? '',
    baseUrl: envString('FUSIONBRAIN_BASE_URL', 'https://api-key.fusionbrain.ai').replace(/\/+$/, ''),
    width: envInt('FUSIONBRAIN_WIDTH', 1024),
    height: envInt('FUSIONBRAIN_HEIGHT', 1024),
  },
} as const;

/** Проверка: пользователь — администратор бота? */
export function isAdmin(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return config.adminIds.includes(userId);
}

/**
 * Ошибка конфигурации. Отдельный класс нужен, чтобы при старте показать
 * пользователю понятный текст без стектрейса (стектрейс тут бесполезен).
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Вызывается один раз при старте. Если конфигурация битая — бросает
 * исключение с человекочитаемым списком проблем.
 */
export function assertConfigValid(): void {
  if (configErrors.length === 0) return;
  const list = configErrors.map((message, index) => `  ${index + 1}) ${message}`).join('\n');
  throw new ConfigError(`Ошибки конфигурации:\n${list}\n\nПодсказка: сверьтесь с файлом .env.example`);
}

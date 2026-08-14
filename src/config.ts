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

/** Читает список строк через запятую: "a, b ,c" -> ["a", "b", "c"]. */
function envStringList(name: string, fallback: string[]): string[] {
  const raw = env(name);
  if (!raw) return fallback;
  const items = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return items.length > 0 ? items : fallback;
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

  /**
   * Дневная норма картинок на человека.
   *
   * Рейт-лимита выше для этого мало: он считает запросы в минуту и защищает
   * от зажатого Enter, а рисование — единственное, что стоит живых денег
   * ($0,015 за картинку у Krea, в семь раз дороже прежней модели). Без нормы
   * один увлёкшийся человек за вечер тратит месячный бюджет всей группы.
   *
   * День календарный, а не скользящие сутки: «две картинки в день» понятно
   * без объяснений, а «сутки с момента первой» пришлось бы растолковывать.
   * Часовой пояс задаётся явно, иначе в Docker день сменялся бы по UTC,
   * то есть в три часа ночи по Москве.
   */
  imageQuota: {
    perUserPerDay: envInt('IMAGE_DAILY_LIMIT', 2),
    timezone: envString('IMAGE_DAILY_LIMIT_TZ', 'Europe/Moscow'),
  },

  /**
   * Разговор перед рисованием: бот уточняет замысел и только потом тратит
   * деньги. Уточнения ведёт бесплатная Gemma, поэтому диалог не стоит ничего,
   * а картинка получается с первого раза — при двух попытках в день это
   * важнее, чем сэкономленные пять секунд.
   */
  draw: {
    /** Выключатель: false — старое поведение, рисуем сразу по команде. */
    askQuestions: envBool('DRAW_ASK_QUESTIONS', true),
    /** Сколько вопросов задавать максимум. Больше трёх — уже допрос. */
    maxQuestions: envInt('DRAW_MAX_QUESTIONS', 3),
    /** Через сколько минут брошенный черновик выбрасывается. */
    draftTtlMin: envInt('DRAW_DRAFT_TTL_MIN', 30),
  },

  ai: {
    /** Общий таймаут запроса к любой нейросети. */
    timeoutMs: envInt('AI_TIMEOUT_MS', 90_000),
    /** Сколько сообщений диалога держать в контексте (0 — без истории). */
    historyLimit: envInt('HISTORY_LIMIT', 30),
  },

  /**
   * Где хранить сессии. Раньше они жили только в памяти процесса, и это было
   * терпимо, пока в них лежала одна история переписки. Теперь там же настройки
   * каждого топика — их потеря при рестарте прошла бы незаметно и молча
   * ухудшила ответы, поэтому сессии уехали на диск.
   *
   * В Docker каталог обязан быть на томе, иначе пересоздание контейнера
   * приводит ровно к той же потере, от которой мы уходили.
   */
  session: {
    dir: envString('SESSION_DIR', 'data/sessions'),
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
    /**
     * Свой адрес API вместо стандартного generativelanguage.googleapis.com.
     * Нужен, когда Google не обслуживает IP сервера («User location is not
     * supported»): запросы направляются через прокси в разрешённом регионе.
     */
    baseUrl: (env('GEMINI_BASE_URL') ?? '').replace(/\/+$/, ''),
    /**
     * Цепочки моделей: первая отвечает, остальные подхватывают, если она
     * отказала (кончилась дневная квота, модель выведена из обращения).
     *
     * Имена вынесены в переменные окружения не случайно: Google регулярно
     * переименовывает модели и закрывает старые версии, а точный список,
     * доступный именно вашему ключу, виден только в AI Studio. Значения ниже —
     * разумное умолчание, а не гарантия; если приходит 404, поправьте .env,
     * пересобирать образ не нужно.
     */
    chains: {
      /** Всё основное: болтовня, команды, картинки на вход, документы. */
      main: envStringList('GEMINI_CHAIN_MAIN', [
        // Gemma впереди намеренно: её дневная норма на порядки больше, чем
        // у Flash Lite, поэтому основной поток тратит бездонный пул, а скромный
        // остаётся резервом. Порядок правится в .env, перекомпиляция не нужна.
        'gemma-4-31b-it',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemma-4-26b-a4b-it',
        'gemini-3-flash-preview',
        // Прошлое поколение в самом хвосте: по 20 запросов в день у каждой —
        // не рабочая лошадь, а страховка на случай, когда выдохлись все
        // предыдущие. Дописаны в обе цепочки: терять их незачем, они бесплатны.
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
      ]),
      /** Запросы «/гем контекст ...»: дневная квота маленькая, тратится осознанно. */
      think: envStringList('GEMINI_CHAIN_THINK', [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-2.5-flash',
      ]),
      /**
       * Подготовка запроса к рисованию: наводящие вопросы и сборка промпта.
       *
       * Цепочка своя и намеренно лёгкая. Задача короткая и полностью
       * формальная — вернуть JSON с тремя вопросами, — а человек в это время
       * ждёт. Замерено на одном и том же запросе: Gemma 31B думает 25 секунд,
       * flash-lite — полторы, и качество вопросов неотличимо. Gemma осталась
       * в хвосте цепочки на случай, если у lite кончится дневная норма.
       */
      draw: envStringList('GEMINI_CHAIN_DRAW', [
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-2.5-flash-lite',
        'gemma-4-31b-it',
      ]),
    },
  },

  openai: {
    apiKey: env('OPENAI_API_KEY') ?? '',
    baseUrl: envString('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: envString('OPENAI_MODEL', 'gpt-4o-mini'),
  },

  /**
   * OpenRouter — единственный платный канал бота. Через него идёт то, чего
   * на бесплатном тарифе Gemini не существует в принципе: генерация картинок
   * (у Google все image-модели помечены «Not available» для Free Tier).
   *
   * Ключ отдельный от OPENAI_API_KEY специально: тот может указывать на любой
   * OpenAI-совместимый сервис, а здесь нужен именно OpenRouter с его
   * эндпоинтом /images.
   */
  openrouter: {
    apiKey: env('OPENROUTER_API_KEY') ?? '',
    baseUrl: envString('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    image: {
      /**
       * Замерено на квадрате 1024x1024: $0,015 за картинку (~66 на доллар),
       * 17 секунд, png на 1,5 МБ. Прежняя openai/gpt-image-1-mini обходилась
       * в $0,0022 и рисовала вдвое быстрее, но заметно проще.
       */
      model: envString('OPENROUTER_IMAGE_MODEL', 'krea/krea-2-medium-turbo'),
      /**
       * Пропорция. У Krea их семь: 1:1, 4:3, 3:2, 16:9, 4:5, 2:3, 9:16.
       * Значения не из этого списка модель не понимает — 3:4, например,
       * даёт 400, ближайшая к нему форма и стоит по умолчанию.
       *
       * Задавать пропорцию явно стоит независимо от модели: без неё модель
       * выбирает форму сама. У прежней gpt-image-1-mini от формы напрямую
       * зависела цена — квадрат $0,0022, портрет и ландшафт $0,0033.
       */
      aspectRatio: envString('OPENROUTER_IMAGE_ASPECT_RATIO', '4:5'),
      /**
       * Ступень разрешения (пиксели API не принимает). У Krea 2 Medium Turbo
       * значение ровно одно — «1K», поэтому оно и стоит по умолчанию.
       * У gpt-image-1-mini ступеней было четыре (512|1K|2K|4K), но модель
       * их игнорировала, и параметр оставляли пустым.
       */
      resolution: envString('OPENROUTER_IMAGE_RESOLUTION', '1K'),
      /**
       * Качество и формат вывода — параметры моделей OpenAI; Krea ни того,
       * ни другого не понимает и отдаёт png. Пустая строка значит «не слать
       * это поле вовсе»: лишний параметр в запросе — повод для 400.
       */
      quality: envString('OPENROUTER_IMAGE_QUALITY', ''),
      format: envString('OPENROUTER_IMAGE_FORMAT', ''),
      /**
       * Слаг провайдера в OpenRouter — адрес, по которому доставляются
       * параметры, которых нет в общем словаре (у Krea это creativity
       * и слайдеры). Виден в /api/v1/images/models/<модель>/endpoints,
       * поле provider_slug. Пусто — такие параметры не отправляются вовсе.
       */
      providerSlug: envString('OPENROUTER_IMAGE_PROVIDER_SLUG', 'krea'),
      /**
       * Насколько модели позволено дописывать промпт за автора:
       * raw | low | medium | high. Пусто — не отправляем, у Krea включится
       * её собственное умолчание medium.
       *
       * Значения два, потому что случая тоже два. Промпт, собранный
       * в диалоге, менять уже незачем — для него raw. А запрос «рисуй как
       * есть», где человек написал два слова, наоборот, живёт за счёт
       * дорисовки моделью — для него medium.
       */
      creativityRefined: envString('KREA_CREATIVITY_REFINED', 'raw'),
      creativityRaw: envString('KREA_CREATIVITY_PLAIN', 'medium'),
    },
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

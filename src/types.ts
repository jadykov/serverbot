/**
 * Общие типы проекта.
 *
 * Ключевая идея архитектуры: бот не знает, с какой именно нейросетью работает.
 * Он знает только два интерфейса — TextProvider и ImageProvider. Чтобы добавить
 * ещё одну нейросеть, достаточно написать класс, реализующий интерфейс,
 * и зарегистрировать его в src/services/registry.ts.
 */
import type { Context, SessionFlavor } from 'grammy';

/** Одно сообщение в истории диалога. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Что хранится в сессии конкретного чата или топика (на диске, см. src/bot.ts).
 *
 * Новые поля добавляйте необязательными: файлы сессий переживают перезапуск
 * и обновление бота, поэтому в уже лежащих на диске записей нового поля
 * попросту не будет.
 */
export interface SessionData {
  /** Выбранный текстовый провайдер (id из реестра). */
  textProviderId: string;
  /** Выбранный провайдер картинок (id из реестра). */
  imageProviderId: string;
  /** Короткая история диалога раздела. */
  history: ChatMessage[];
  /** Цепочка моделей этого топика (id из src/models.ts). */
  chainId?: string;
  /** Своя системная инструкция топика. Пусто — общая по умолчанию. */
  systemPrompt?: string;
}

/** Контекст grammY, расширенный сессией. Используется во всех обработчиках. */
export type BotContext = Context & SessionFlavor<SessionData>;

/** Общие поля любого провайдера нейросети. */
interface BaseProvider {
  /** Машинный идентификатор, используется в командах и кнопках: gemini, openai... */
  readonly id: string;
  /** Человекочитаемое название для меню. */
  readonly title: string;
  /** Настроен ли провайдер (есть ли ключи в окружении). */
  readonly isConfigured: boolean;
  /** Подсказка, что именно нужно добавить в .env, если провайдер не настроен. */
  readonly setupHint: string;
}

/**
 * Файл, который уходит в модель вместе с текстом запроса: фотография из чата,
 * голосовое сообщение, страница документа. Байты держим в памяти — Telegram
 * не отдаёт файлы больше 20 МБ, так что складывать их на диск незачем.
 */
export interface Attachment {
  data: Buffer;
  /** MIME-тип: image/jpeg, image/png, audio/ogg и т.п. */
  mimeType: string;
}

export interface TextGenerationOptions {
  /** История предыдущих сообщений диалога. */
  history?: ChatMessage[];
  /** Системная инструкция («кто ты и как отвечаешь»). */
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Модель именно для этого запроса. Пусто — провайдер берёт свою
   * модель по умолчанию. Через этот параметр работает и выбор модели
   * в топике, и перебор цепочки при отказе (см. src/services/chain.ts).
   */
  model?: string;
  /** Картинки и другие файлы, которые нужно показать модели. */
  attachments?: Attachment[];
}

/** Провайдер текстовой нейросети (Gemini, OpenAI-совместимые API и т.п.). */
export interface TextProvider extends BaseProvider {
  generateText(prompt: string, options?: TextGenerationOptions): Promise<string>;
}

export interface ImageGenerationOptions {
  width?: number;
  height?: number;
  /** Что НЕ должно попасть на картинку. */
  negativePrompt?: string;
}

/** Результат генерации картинки. */
export interface GeneratedImage {
  /** Готовые байты изображения — их можно сразу отправить в Telegram. */
  data: Buffer;
  mimeType: string;
  /** Сколько времени заняла генерация, мс. */
  elapsedMs: number;
  /**
   * Сколько стоил вызов, в долларах, если провайдер это сообщает.
   * Считать расход по прайсу вслепую не нужно: OpenRouter возвращает
   * фактическую сумму в каждом ответе.
   */
  costUsd?: number;
}

/** Провайдер генерации изображений (сейчас — OpenRouter). */
export interface ImageProvider extends BaseProvider {
  generateImage(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage>;
}

/**
 * Ошибка «провайдер не настроен»: бот ловит её отдельно и отвечает
 * пользователю подсказкой, какие ключи прописать, вместо страшного стектрейса.
 */
export class ProviderNotConfiguredError extends Error {
  constructor(public readonly hints: string[]) {
    super('Ни один подходящий провайдер нейросети не настроен');
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * Из-за чего именно отказал провайдер. Нужно, чтобы перебор цепочки моделей
 * понимал, есть ли смысл пробовать следующую (см. src/services/chain.ts):
 *
 *  • quota / not-found / server — беда конкретной модели, соседняя может ответить;
 *  • auth / bad-request / blocked / geo — с любой моделью повторится то же самое,
 *    перебор только потратит время;
 *  • timeout — тоже не перебираем: четыре модели по таймауту превратятся
 *    в шесть минут ожидания.
 */
export type ProviderErrorKind =
  | 'quota'
  | 'not-found'
  | 'server'
  | 'bad-request'
  | 'auth'
  | 'blocked'
  | 'geo'
  | 'timeout'
  | 'unknown';

/** Ошибка на стороне внешнего API нейросети (таймаут, 4xx/5xx, цензура). */
export class ProviderRequestError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(
    public readonly provider: string,
    message: string,
    options?: { cause?: unknown; kind?: ProviderErrorKind },
  ) {
    super(message, options);
    this.name = 'ProviderRequestError';
    this.kind = options?.kind ?? 'unknown';
  }
}

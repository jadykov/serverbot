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

/** Что хранится в сессии конкретного чата (in-memory, см. src/bot.ts). */
export interface SessionData {
  /** Выбранный текстовый провайдер (id из реестра). */
  textProviderId: string;
  /** Выбранный провайдер картинок (id из реестра). */
  imageProviderId: string;
  /** Короткая история диалога для команды /ask. */
  history: ChatMessage[];
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

export interface TextGenerationOptions {
  /** История предыдущих сообщений диалога. */
  history?: ChatMessage[];
  /** Системная инструкция («кто ты и как отвечаешь»). */
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
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
}

/** Провайдер генерации изображений (FusionBrain/Kandinsky и т.п.). */
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

/** Ошибка на стороне внешнего API нейросети (таймаут, 4xx/5xx, цензура). */
export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderRequestError';
  }
}

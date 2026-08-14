/**
 * Провайдер текстовой нейросети Google Gemini.
 *
 * Документация и получение ключа: https://aistudio.google.com/apikey
 * Используется официальный SDK @google/genai (пришёл на смену устаревшему
 * @google/generative-ai).
 */
import { GoogleGenAI, ThinkingLevel, type Part, type ThinkingConfig } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { withTimeout } from '../utils.js';
import { ProviderRequestError, type TextGenerationOptions, type TextProvider } from '../types.js';

/**
 * «Размышления» (thinking) настраиваются по-разному в разных поколениях моделей:
 *   • Gemini 2.5  — thinkingConfig.thinkingBudget: число токенов (0 — выключить);
 *   • Gemini 3.x  — thinkingConfig.thinkingLevel: minimal | low | medium | high.
 *
 * Параметр «чужого» поколения приводит к ошибке 400 INVALID_ARGUMENT, поэтому
 * по умолчанию мы не отправляем thinkingConfig вообще — так запрос корректен
 * для любой модели. Включается явно через GEMINI_THINKING в .env:
 *   GEMINI_THINKING=0      → thinkingBudget: 0   (для Gemini 2.5)
 *   GEMINI_THINKING=low    → thinkingLevel: LOW  (для Gemini 3.x)
 */
const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

function buildThinkingConfig(): ThinkingConfig | undefined {
  const raw = config.gemini.thinking.trim();
  if (!raw) return undefined;

  // Число — это бюджет в токенах (формат Gemini 2.5).
  if (/^-?\d+$/.test(raw)) return { thinkingBudget: Number.parseInt(raw, 10) };

  const level = THINKING_LEVELS[raw.toLowerCase()];
  if (level) return { thinkingLevel: level };

  logger.warn(
    `GEMINI_THINKING="${raw}" не распознан и будет проигнорирован. ` +
      'Допустимые значения: число (бюджет токенов) либо minimal/low/medium/high.',
  );
  return undefined;
}

/**
 * Достаёт человекочитаемый текст из ошибки Google API:
 * SDK кладёт в message сырой JSON вида {"error":{"code":400,...}}.
 */
function extractApiError(message: string): { text: string; code?: number; status?: string } {
  const start = message.indexOf('{');
  if (start === -1) return { text: message };
  try {
    const parsed = JSON.parse(message.slice(start)) as {
      error?: { message?: string; code?: number; status?: string };
    };
    if (!parsed.error) return { text: message };
    return { text: parsed.error.message ?? message, code: parsed.error.code, status: parsed.error.status };
  } catch {
    return { text: message };
  }
}

/**
 * Системная инструкция. Отдельно проговариваем допустимую разметку:
 * ответ проходит через конвертер в HTML Telegram (см. src/format.ts),
 * а таблиц и вложенных списков Telegram не умеет в принципе.
 */
const DEFAULT_SYSTEM_PROMPT = [
  'Ты — дружелюбный ассистент внутри Telegram-бота.',
  'Отвечай на языке пользователя, по делу и без «воды».',
  'Оформляй ответ в Markdown, но только теми средствами, которые понимает Telegram:',
  '**жирный**, *курсив*, `инлайн-код`, блоки кода в тройных обратных кавычках с указанием языка,',
  'ссылки вида [текст](https://...), цитаты через >, списки через дефис.',
  'Не используй таблицы, вложенные списки и HTML-теги.',
  'Заголовки допустимы, но не глубже ###.',
].join(' ');

export class GeminiProvider implements TextProvider {
  readonly id = 'gemini';
  readonly title = 'Google Gemini';
  readonly setupHint = 'Добавьте GEMINI_API_KEY в .env (ключ бесплатно: https://aistudio.google.com/apikey)';

  /** Клиент создаём лениво: без ключа он и не нужен. */
  private client: GoogleGenAI | null = null;

  get isConfigured(): boolean {
    return config.gemini.apiKey.length > 0;
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({
        apiKey: config.gemini.apiKey,
        // Если задан GEMINI_BASE_URL — ходим через свой прокси.
        ...(config.gemini.baseUrl ? { httpOptions: { baseUrl: config.gemini.baseUrl } } : {}),
      });
      if (config.gemini.baseUrl) {
        logger.info('Gemini: запросы идут через прокси', { baseUrl: config.gemini.baseUrl });
      }
    }
    return this.client;
  }

  async generateText(prompt: string, options: TextGenerationOptions = {}): Promise<string> {
    if (!this.isConfigured) {
      throw new ProviderRequestError(this.id, this.setupHint, { kind: 'auth' });
    }

    // Текст запроса и приложенные файлы едут одним сообщением: сначала текст,
    // потом вложения. Файлы передаются прямо в теле запроса (inlineData),
    // это допустимо, пока весь запрос укладывается в 20 МБ, — а больше
    // Telegram боту и не отдаст.
    const userParts: Part[] = [{ text: prompt }];
    for (const attachment of options.attachments ?? []) {
      userParts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.data.toString('base64'),
        },
      });
    }

    // Gemini ждёт историю в формате [{ role, parts: [{ text }] }],
    // причём роль ассистента здесь называется "model", а не "assistant".
    const contents = [
      ...(options.history ?? []).map((message) => ({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.text }],
      })),
      { role: 'user', parts: userParts },
    ];

    // Модель приходит извне: её задаёт либо настройка топика, либо перебор
    // цепочки при отказе. Своя модель из .env — только значение по умолчанию.
    const model = options.model ?? config.gemini.model;
    const startedAt = Date.now();
    const thinkingConfig = buildThinkingConfig();

    try {
      const response = await withTimeout(
        this.getClient().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
            temperature: options.temperature ?? 0.8,
            maxOutputTokens: options.maxOutputTokens ?? 2048,
            // Отправляется, только если задан GEMINI_THINKING (см. выше).
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        }),
        config.ai.timeoutMs,
        `Gemini (${model})`,
      );

      const text = response.text?.trim();

      if (!text) {
        const blockReason = response.promptFeedback?.blockReason;
        // Сравниваем через String(): в SDK это enum, а не строковый литерал.
        const finishReason = String(response.candidates?.[0]?.finishReason ?? '');

        // Модели с «размышлениями» тратят лимит токенов на них,
        // и на сам ответ места может не остаться.
        if (finishReason === 'MAX_TOKENS') {
          const spent = response.usageMetadata?.thoughtsTokenCount ?? 0;
          throw new ProviderRequestError(
            this.id,
            `Ответ не поместился в лимит токенов${spent ? ` (${spent} из них модель потратила на размышления)` : ''}. ` +
              `Возьмите модель без размышлений (например, gemini-flash-lite-latest) ` +
              'или задайте GEMINI_THINKING=minimal / GEMINI_THINKING=0 под ваше поколение модели.',
            { kind: 'bad-request' },
          );
        }

        // Иначе пустой ответ обычно означает срабатывание фильтров безопасности.
        throw new ProviderRequestError(
          this.id,
          blockReason || finishReason
            ? `Модель отказалась отвечать (причина: ${blockReason ?? finishReason}).`
            : 'Модель вернула пустой ответ. Попробуйте переформулировать запрос.',
          { kind: 'blocked' },
        );
      }

      logger.debug('Gemini: ответ получен', {
        model,
        ms: Date.now() - startedAt,
        chars: text.length,
        attachments: options.attachments?.length ?? 0,
      });

      return text;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;

      const raw = error instanceof Error ? error.message : String(error);
      const { text, code, status } = extractApiError(raw);

      logger.warn('Gemini вернул ошибку', { model, code, status, text });

      // Таймаут ставит withTimeout, и это не ответ Google. Перебирать из-за
      // него цепочку нельзя: четыре модели подряд по полторы минуты — это
      // шесть минут молчания вместо ответа.
      if (/превышен таймаут/i.test(raw)) {
        throw new ProviderRequestError(
          this.id,
          `Модель «${model}» не ответила за отведённое время. Попробуйте ещё раз или упростите запрос.`,
          { cause: error, kind: 'timeout' },
        );
      }

      // Географическая блокировка. Google отклоняет запрос по IP отправителя,
      // а не по ключу: диапазоны многих хостингов у него в чёрном списке.
      // Ошибка приходит с кодом 400, но с настройками бота никак не связана.
      if (/location is not supported/i.test(text)) {
        throw new ProviderRequestError(
          this.id,
          'Google не обслуживает запросы с IP этого сервера («User location is not supported»).\n\n' +
            'Дело не в ключе и не в .env — тот же ключ работает с машины в другой сети. ' +
            'Google блокирует диапазоны многих хостингов целиком.\n\n' +
            'Что можно сделать:\n' +
            '• поднять прокси в разрешённом регионе и указать его в GEMINI_BASE_URL;\n' +
            '• переключиться на OpenAI-совместимый провайдер (OPENAI_BASE_URL, например OpenRouter);\n' +
            '• перенести бота на хостинг с другим диапазоном адресов.',
          { cause: error, kind: 'geo' },
        );
      }

      // 400: чаще всего в запрос попал параметр, которого модель не понимает.
      if (code === 400 || status === 'INVALID_ARGUMENT') {
        throw new ProviderRequestError(
          this.id,
          `Gemini отклонил запрос (400): ${text}\n\n` +
            `Модель: ${model}. Проверьте GEMINI_MODEL и GEMINI_THINKING в .env — ` +
            'у Gemini 2.5 и Gemini 3.x разные форматы параметра «размышлений».',
          { cause: error, kind: 'bad-request' },
        );
      }
      if (code === 404 || status === 'NOT_FOUND') {
        throw new ProviderRequestError(
          this.id,
          `Модель «${model}» недоступна для вашего ключа. Проверьте её имя в GEMINI_CHAIN_MAIN / GEMINI_CHAIN_THINK.`,
          { cause: error, kind: 'not-found' },
        );
      }
      if (code === 401 || code === 403 || /api[_ ]?key|API_KEY_INVALID/i.test(raw)) {
        throw new ProviderRequestError(this.id, 'Gemini отклонил ключ. Проверьте GEMINI_API_KEY.', {
          cause: error,
          kind: 'auth',
        });
      }
      if (code === 429 || /quota|RESOURCE_EXHAUSTED/i.test(raw)) {
        throw new ProviderRequestError(this.id, `У модели «${model}» закончилась дневная норма запросов.`, {
          cause: error,
          kind: 'quota',
        });
      }
      // 5xx — беда на стороне Google, причём обычно у конкретной модели:
      // соседняя в цепочке в этот же момент вполне может отвечать.
      if (code !== undefined && code >= 500) {
        throw new ProviderRequestError(this.id, `Google ответил ошибкой ${code}: ${text}`, {
          cause: error,
          kind: 'server',
        });
      }
      throw new ProviderRequestError(this.id, `Ошибка Gemini: ${text}`, { cause: error });
    }
  }
}

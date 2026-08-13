/**
 * Провайдер для любого OpenAI-совместимого API.
 *
 * Один и тот же код работает с OpenAI, OpenRouter, DeepSeek, Together,
 * локальной Ollama и десятком других сервисов — меняется только OPENAI_BASE_URL.
 * Здесь намеренно нет SDK: обычного fetch (встроен в Node 18+) достаточно,
 * и это хорошо показывает, как устроен протокол под капотом.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRequestError, type TextGenerationOptions, type TextProvider } from '../types.js';

/** Минимально необходимая часть ответа /chat/completions. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
}

export class OpenAiCompatibleProvider implements TextProvider {
  readonly id = 'openai';
  readonly title = 'OpenAI-совместимый API';
  readonly setupHint = 'Добавьте OPENAI_API_KEY (и при необходимости OPENAI_BASE_URL, OPENAI_MODEL) в .env';

  get isConfigured(): boolean {
    return config.openai.apiKey.length > 0;
  }

  async generateText(prompt: string, options: TextGenerationOptions = {}): Promise<string> {
    if (!this.isConfigured) {
      throw new ProviderRequestError(this.id, this.setupHint);
    }

    // Картинки в этом протоколе передаются внутри content как data-URL.
    // Пока вложений нет, content остаётся обычной строкой: так понимают
    // даже старые и урезанные реализации OpenAI-совместимого API.
    const attachments = options.attachments ?? [];
    const userContent: unknown =
      attachments.length > 0
        ? [
            { type: 'text', text: prompt },
            ...attachments.map((attachment) => ({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data.toString('base64')}`,
              },
            })),
          ]
        : prompt;

    const messages: Array<{ role: string; content: unknown }> = [
      {
        role: 'system',
        content:
          options.systemPrompt ??
          'Ты — ассистент в Telegram-боте. Отвечай кратко, на языке пользователя. ' +
            'Оформляй ответ в Markdown: **жирный**, *курсив*, `код`, блоки кода, ссылки, списки через дефис. ' +
            'Без таблиц, вложенных списков и HTML-тегов.',
      },
      ...(options.history ?? []).map((message) => ({ role: message.role, content: message.text })),
      { role: 'user', content: userContent },
    ];

    const model = options.model ?? config.openai.model;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${config.openai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.8,
          max_tokens: options.maxOutputTokens ?? 2048,
        }),
        // AbortSignal.timeout доступен начиная с Node 18 — отдельная библиотека не нужна.
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRequestError(this.id, `Сеть недоступна или запрос прерван: ${message}`, { cause: error });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ProviderRequestError(this.id, 'Ключ отклонён (401). Проверьте OPENAI_API_KEY и OPENAI_BASE_URL.');
      }
      if (response.status === 429) {
        throw new ProviderRequestError(this.id, 'Слишком много запросов или закончилась квота (429).');
      }
      throw new ProviderRequestError(this.id, `HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new ProviderRequestError(this.id, data.error?.message ?? 'Модель вернула пустой ответ.');
    }

    logger.debug('OpenAI-совместимый API: ответ получен', {
      model,
      ms: Date.now() - startedAt,
      chars: text.length,
      attachments: attachments.length,
    });

    return text;
  }
}

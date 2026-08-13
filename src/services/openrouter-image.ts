/**
 * Генерация картинок через OpenRouter.
 *
 * Почему не Gemini: на бесплатном тарифе Google генерация изображений
 * недоступна вовсе — у Imagen и у всех нативных image-моделей в колонке
 * Free Tier стоит «Not available». Веб-интерфейс AI Studio рисует бесплатно,
 * но через API те же модели требуют включённого биллинга, и на этом обычно
 * и происходит путаница. Поэтому картинки — единственное, за что бот платит.
 *
 * Почему это не OpenAiCompatibleProvider: у картинок отдельный эндпоинт
 * /api/v1/images со своими параметрами (разрешение, качество, формат),
 * а не chat/completions. Общего с текстовым провайдером тут только домен.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  ProviderRequestError,
  type GeneratedImage,
  type ImageGenerationOptions,
  type ImageProvider,
} from '../types.js';

/** Ответ /api/v1/images — берём только то, что нам нужно. */
interface ImagesResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  /** Фактическая стоимость вызова в долларах — её и надо записывать в счётчик. */
  usage?: { cost?: number };
  error?: { message?: string };
}

export class OpenRouterImageProvider implements ImageProvider {
  readonly id = 'openrouter';
  readonly title = 'OpenRouter (картинки)';
  readonly setupHint =
    'Добавьте OPENROUTER_API_KEY в .env (ключ и баланс: https://openrouter.ai/keys). ' +
    'Модель и качество настраиваются переменными OPENROUTER_IMAGE_*';

  get isConfigured(): boolean {
    return config.openrouter.apiKey.length > 0;
  }

  async generateImage(prompt: string, options: ImageGenerationOptions = {}): Promise<GeneratedImage> {
    if (!this.isConfigured) {
      throw new ProviderRequestError(this.id, this.setupHint, { kind: 'auth' });
    }

    const { model, quality, format } = config.openrouter.image;
    // Размер можно передать вызовом, иначе берём настроенный по умолчанию.
    const resolution =
      options.width && options.height ? `${options.width}x${options.height}` : config.openrouter.image.resolution;

    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${config.openrouter.baseUrl}/images`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openrouter.apiKey}`,
        },
        body: JSON.stringify({ model, prompt, resolution, quality, output_format: format }),
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRequestError(this.id, `Не удалось связаться с OpenRouter: ${message}`, {
        cause: error,
        kind: 'server',
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      if (response.status === 401) {
        throw new ProviderRequestError(this.id, 'OpenRouter отклонил ключ (401). Проверьте OPENROUTER_API_KEY.', {
          kind: 'auth',
        });
      }
      if (response.status === 402) {
        throw new ProviderRequestError(
          this.id,
          'На балансе OpenRouter закончились деньги (402). Пополните счёт — рисовать больше нечем.',
          { kind: 'quota' },
        );
      }
      if (response.status === 429) {
        throw new ProviderRequestError(this.id, 'OpenRouter просит подождать: слишком много запросов (429).', {
          kind: 'quota',
        });
      }

      throw new ProviderRequestError(this.id, `OpenRouter ответил ${response.status}: ${body.slice(0, 300)}`, {
        kind: response.status >= 500 ? 'server' : 'bad-request',
      });
    }

    const data = (await response.json()) as ImagesResponse;
    const image = data.data?.[0];

    if (!image?.b64_json) {
      throw new ProviderRequestError(
        this.id,
        data.error?.message ?? 'OpenRouter вернул ответ без картинки. Попробуйте переформулировать запрос.',
        { kind: 'blocked' },
      );
    }

    const elapsedMs = Date.now() - startedAt;
    const costUsd = data.usage?.cost;

    logger.info('Картинка сгенерирована', { model, resolution, quality, ms: elapsedMs, costUsd });

    return {
      data: Buffer.from(image.b64_json, 'base64'),
      mimeType: image.media_type ?? `image/${format}`,
      elapsedMs,
      costUsd,
    };
  }
}

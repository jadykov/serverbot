/**
 * Провайдер генерации изображений FusionBrain (модель Kandinsky).
 *
 * Ключи бесплатно: https://fusionbrain.ai/keys
 * API асинхронное и работает в три шага:
 *   1. GET  /key/api/v1/pipelines            — узнаём id пайплайна text2image;
 *   2. POST /key/api/v1/pipeline/run         — ставим задачу в очередь, получаем uuid;
 *   3. GET  /key/api/v1/pipeline/status/{id} — опрашиваем статус, пока не будет DONE.
 *
 * Авторизация — двумя заголовками: X-Key: Key <api_key> и X-Secret: Secret <secret_key>.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { detectImageMime, sleep } from '../utils.js';
import {
  ProviderRequestError,
  type GeneratedImage,
  type ImageGenerationOptions,
  type ImageProvider,
} from '../types.js';

/** Элемент списка пайплайнов. В старых версиях API id был числом. */
interface Pipeline {
  id: string | number;
  name?: string;
  type?: string;
  status?: string;
}

/** Ответ на постановку задачи. */
interface RunResponse {
  uuid?: string;
  status?: string;
  /** Если ключи исчерпали лимит, API отдаёт человекочитаемое описание. */
  errorDescription?: string;
  pipeline_status?: string;
}

/** Ответ статуса задачи. */
interface StatusResponse {
  uuid?: string;
  status?: 'INITIAL' | 'PROCESSING' | 'DONE' | 'FAIL';
  errorDescription?: string;
  result?: {
    files?: string[];
    censored?: boolean;
  };
  /** Формат старого API. */
  images?: string[];
  censored?: boolean;
}

/** Пауза между опросами статуса и максимальное число попыток. */
const POLL_INTERVAL_MS = 3000;
const FIRST_POLL_DELAY_MS = 4000;

export class FusionBrainProvider implements ImageProvider {
  readonly id = 'fusionbrain';
  readonly title = 'FusionBrain / Kandinsky';
  readonly setupHint =
    'Добавьте FUSIONBRAIN_API_KEY и FUSIONBRAIN_SECRET_KEY в .env (ключи: https://fusionbrain.ai/keys)';

  /** id пайплайна меняется редко — кэшируем на время жизни процесса. */
  private cachedPipelineId: string | null = null;

  get isConfigured(): boolean {
    return config.fusionbrain.apiKey.length > 0 && config.fusionbrain.secretKey.length > 0;
  }

  private get headers(): Record<string, string> {
    return {
      'X-Key': `Key ${config.fusionbrain.apiKey}`,
      'X-Secret': `Secret ${config.fusionbrain.secretKey}`,
    };
  }

  /** Обёртка над fetch: единая обработка сетевых ошибок и статусов. */
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${config.fusionbrain.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRequestError(this.id, `FusionBrain недоступен: ${message}`, { cause: error });
    }

    if (response.status === 401) {
      throw new ProviderRequestError(this.id, 'FusionBrain отклонил ключи (401). Проверьте API_KEY и SECRET_KEY.');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderRequestError(this.id, `FusionBrain вернул HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    return response.json();
  }

  /** Шаг 1: получаем идентификатор пайплайна text2image. */
  private async getPipelineId(): Promise<string> {
    if (this.cachedPipelineId) return this.cachedPipelineId;

    const data = (await this.request('/key/api/v1/pipelines')) as Pipeline[];
    if (!Array.isArray(data) || data.length === 0) {
      throw new ProviderRequestError(this.id, 'FusionBrain не вернул ни одного доступного пайплайна.');
    }

    const pipeline = data.find((item) => (item.type ?? 'TEXT2IMAGE') === 'TEXT2IMAGE') ?? data[0];
    if (!pipeline) {
      throw new ProviderRequestError(this.id, 'Не найден пайплайн генерации изображений.');
    }

    this.cachedPipelineId = String(pipeline.id);
    logger.debug('FusionBrain: выбран пайплайн', { id: this.cachedPipelineId, name: pipeline.name });
    return this.cachedPipelineId;
  }

  async generateImage(prompt: string, options: ImageGenerationOptions = {}): Promise<GeneratedImage> {
    if (!this.isConfigured) {
      throw new ProviderRequestError(this.id, this.setupHint);
    }

    const startedAt = Date.now();
    const pipelineId = await this.getPipelineId();

    // Шаг 2: ставим задачу. Параметры уходят как multipart/form-data,
    // где поле params — это JSON-blob. Заголовок content-type
    // выставлять ВРУЧНУЮ НЕЛЬЗЯ: fetch сам добавит boundary.
    const params = {
      type: 'GENERATE',
      numImages: 1,
      width: options.width ?? config.fusionbrain.width,
      height: options.height ?? config.fusionbrain.height,
      generateParams: { query: prompt },
      ...(options.negativePrompt ? { negativePromptDecoder: options.negativePrompt } : {}),
    };

    const form = new FormData();
    form.append('pipeline_id', pipelineId);
    form.append('params', new Blob([JSON.stringify(params)], { type: 'application/json' }));

    const run = (await this.request('/key/api/v1/pipeline/run', { method: 'POST', body: form })) as RunResponse;

    if (!run.uuid) {
      throw new ProviderRequestError(
        this.id,
        run.errorDescription ?? 'FusionBrain не принял задачу (нет uuid в ответе). Возможно, исчерпан дневной лимит.',
      );
    }

    logger.debug('FusionBrain: задача поставлена в очередь', { uuid: run.uuid });

    // Шаг 3: опрашиваем статус, пока не получим результат или не выйдет время.
    const deadline = startedAt + config.ai.timeoutMs;
    await sleep(FIRST_POLL_DELAY_MS);

    while (Date.now() < deadline) {
      const status = (await this.request(`/key/api/v1/pipeline/status/${run.uuid}`)) as StatusResponse;

      if (status.status === 'FAIL') {
        throw new ProviderRequestError(this.id, status.errorDescription ?? 'Генерация завершилась ошибкой.');
      }

      if (status.status === 'DONE') {
        if (status.result?.censored || status.censored) {
          throw new ProviderRequestError(
            this.id,
            'Запрос заблокирован фильтром FusionBrain. Попробуйте переформулировать описание.',
          );
        }

        // Новый API отдаёт result.files, старый — images. Поддерживаем оба.
        const files = status.result?.files ?? status.images ?? [];
        const first = files[0];
        if (!first) {
          throw new ProviderRequestError(this.id, 'Генерация завершилась, но картинка не пришла.');
        }

        // Иногда base64 приходит с префиксом data:image/png;base64,...
        const base64 = first.includes(',') ? first.slice(first.indexOf(',') + 1) : first;
        const data = Buffer.from(base64, 'base64');

        if (data.length === 0) {
          throw new ProviderRequestError(this.id, 'Пришло пустое изображение.');
        }

        const elapsedMs = Date.now() - startedAt;
        logger.debug('FusionBrain: изображение готово', { uuid: run.uuid, ms: elapsedMs, bytes: data.length });

        return { data, mimeType: detectImageMime(data), elapsedMs };
      }

      // INITIAL / PROCESSING — ждём дальше.
      await sleep(POLL_INTERVAL_MS);
    }

    throw new ProviderRequestError(
      this.id,
      `Не дождались картинку за ${Math.round(config.ai.timeoutMs / 1000)} с. Очередь FusionBrain перегружена — попробуйте позже.`,
    );
  }
}

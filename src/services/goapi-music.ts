/**
 * Музыка с вокалом через GoAPI: модель Ace-Step.
 *
 * Зачем ещё один посредник. Своей музыки у Google для нас нет: Gemini её
 * не пишет вовсе, а Lyria живёт в Vertex AI — с биллингом, сервисным
 * аккаунтом и совсем другим способом аутентификации. Ace-Step — открытая
 * модель, и у посредника секунда готового звука стоит $0,0005: минутный
 * трек с вокалом обходится в три цента, вдвое дороже картинки.
 *
 * Что важно знать про этот API:
 *
 *  • эндпоинт один на все модели сервиса — POST /api/v1/task, а что именно
 *    делать, сказано полями model и task_type. Поэтому здесь нет ни классов
 *    провайдера, ни реестра: это не «ещё одна нейросеть» в смысле src/types.ts,
 *    у которой есть текст или картинки, а одна конкретная задача;
 *  • генерация асинхронная. Сервис отвечает сразу, отдавая task_id, а трек
 *    нужно спрашивать самому, пока status не станет completed. Вебхук он тоже
 *    умеет, но для этого боту понадобился бы открытый наружу адрес — а он
 *    работает через long polling именно чтобы обойтись без него;
 *  • стиль и текст песни — разные поля. style_prompt описывает музыку
 *    (жанр, инструменты, темп, голос), lyrics содержит собственно слова;
 *    «[inst]» вместо слов означает инструментал;
 *  • платится длительность, а не запрос. Отсюда и потолок в конфигурации:
 *    четыре минуты — это $0,12, то есть четверть стартового баланса
 *    за одну команду.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRequestError } from '../types.js';

const PROVIDER_ID = 'goapi';

export const MUSIC_SETUP_HINT =
  'Добавьте GOAPI_API_KEY в .env (ключ и баланс: https://goapi.ai). ' +
  'Модель и длительность настраиваются переменными GOAPI_MUSIC_* и TRACK_*';

/** Что просим написать. Стиль и слова — разные поля, это не одно и то же. */
export interface TrackRequest {
  /** Описание музыки для модели, по-английски: жанр, инструменты, голос, темп. */
  stylePrompt: string;
  /** Слова песни. «[inst]» — инструментал без вокала. */
  lyrics: string;
  /** Длительность в секундах. Урезается по потолку из конфигурации. */
  duration: number;
}

/** Готовый трек. */
export interface GeneratedTrack {
  data: Buffer;
  mimeType: string;
  /** Сколько секунд заказали — по ним и считается цена. */
  duration: number;
  /** Стоимость по прайсу сервиса: длительность × цена секунды. */
  costUsd: number;
  elapsedMs: number;
}

/** Ответ GoAPI на любой запрос: снаружи code/message, внутри data. */
interface TaskResponse {
  code?: number;
  message?: string;
  data?: {
    task_id?: string;
    status?: string;
    output?: { audio_url?: string };
    error?: { code?: number; message?: string; raw_message?: string };
  };
}

export function isMusicConfigured(): boolean {
  return config.goapi.apiKey.length > 0;
}

/** Приводит заказанную длительность к тому, что модель и кошелёк примут. */
export function clampDuration(seconds: number): number {
  const { minDuration, maxDuration } = config.goapi.music;
  if (!Number.isFinite(seconds)) return config.goapi.music.duration;
  return Math.min(maxDuration, Math.max(minDuration, Math.round(seconds)));
}

/** Цена по прайсу сервиса. Считается по длительности, а не по факту запроса. */
export function trackPrice(duration: number): number {
  return duration * config.goapi.music.pricePerSecondUsd;
}

/** Один запрос к GoAPI с разбором того, что может пойти не так. */
async function call(path: string, init: RequestInit): Promise<TaskResponse> {
  let response: Response;
  try {
    response = await fetch(`${config.goapi.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        // Ключ передаётся именно так: не Bearer, а свой заголовок.
        'x-api-key': config.goapi.apiKey,
        ...init.headers,
      },
      // Таймаут здесь на одиночный запрос, а не на всю генерацию:
      // сама генерация ждётся опросом, у неё свой предел.
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError(PROVIDER_ID, `Не удалось связаться с GoAPI: ${message}`, {
      cause: error,
      kind: 'server',
    });
  }

  const text = await response.text().catch(() => '');

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderRequestError(PROVIDER_ID, 'GoAPI отклонил ключ. Проверьте GOAPI_API_KEY в .env.', {
        kind: 'auth',
      });
    }
    if (response.status === 402) {
      throw new ProviderRequestError(
        PROVIDER_ID,
        'На балансе GoAPI закончились деньги. Пополните счёт на goapi.ai — писать музыку больше нечем.',
        { kind: 'quota' },
      );
    }
    if (response.status === 429) {
      throw new ProviderRequestError(PROVIDER_ID, 'GoAPI просит подождать: слишком много запросов (429).', {
        kind: 'quota',
      });
    }

    throw new ProviderRequestError(PROVIDER_ID, `GoAPI ответил ${response.status}: ${text.slice(0, 300)}`, {
      kind: response.status >= 500 ? 'server' : 'bad-request',
    });
  }

  try {
    return JSON.parse(text) as TaskResponse;
  } catch {
    throw new ProviderRequestError(PROVIDER_ID, `GoAPI ответил не JSON: ${text.slice(0, 200)}`, { kind: 'server' });
  }
}

/**
 * Ставит задачу в очередь и возвращает её идентификатор.
 *
 * Отказ здесь возможен и с кодом 200: у GoAPI на успешный HTTP может
 * приехать code 4xx внутри тела — например, когда кончился баланс.
 * Поэтому проверяется не только статус ответа.
 */
async function createTask(request: TrackRequest): Promise<string> {
  const { model, taskType } = config.goapi.music;

  const body = {
    model,
    task_type: taskType,
    input: {
      style_prompt: request.stylePrompt,
      lyrics: request.lyrics,
      duration: request.duration,
    },
  };

  const answer = await call('/api/v1/task', { method: 'POST', body: JSON.stringify(body) });
  const taskId = answer.data?.task_id;

  if (!taskId) {
    const reason = answer.data?.error?.message ?? answer.message ?? 'сервис не вернул task_id';
    throw new ProviderRequestError(PROVIDER_ID, `GoAPI не принял задачу: ${reason}`, {
      kind: answer.code === 402 || /credit|balance|insufficient/i.test(reason) ? 'quota' : 'bad-request',
    });
  }

  return taskId;
}

/**
 * Ждёт готовности трека, спрашивая сервис.
 *
 * Статусы у GoAPI: pending и processing — работа идёт, completed — готово,
 * failed — не вышло. Незнакомый статус считаем работой: сервис вправе
 * завести новый, и падать из-за этого незачем.
 */
async function waitForTrack(taskId: string): Promise<string> {
  const { pollMs, timeoutMs } = config.goapi.music;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; ; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));

    const answer = await call(`/api/v1/task/${encodeURIComponent(taskId)}`, { method: 'GET' });
    const status = (answer.data?.status ?? '').toLowerCase();

    if (status === 'completed') {
      const url = answer.data?.output?.audio_url;
      if (!url) {
        throw new ProviderRequestError(PROVIDER_ID, 'GoAPI отчитался о готовности, но ссылки на трек не дал.', {
          kind: 'server',
        });
      }
      return url;
    }

    if (status === 'failed') {
      const error = answer.data?.error;
      throw new ProviderRequestError(
        PROVIDER_ID,
        `Модель не справилась с запросом: ${error?.message ?? error?.raw_message ?? 'причина не названа'}`,
        { kind: 'bad-request' },
      );
    }

    if (Date.now() > deadline) {
      throw new ProviderRequestError(
        PROVIDER_ID,
        `Трек не готов за отведённые ${Math.round(timeoutMs / 1000)} с. Задача осталась в очереди GoAPI (${taskId}) — ` +
          'деньги за неё сервис спишет, если она всё-таки завершится.',
        { kind: 'server' },
      );
    }

    logger.debug('Трек ещё пишется', { taskId, status: status || '(пусто)', attempt });
  }
}

/** Забирает готовый файл по ссылке, которую дал сервис. */
async function download(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(config.ai.timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError(PROVIDER_ID, `Трек готов, но скачать его не удалось: ${message}`, {
      cause: error,
      kind: 'server',
    });
  }

  if (!response.ok) {
    throw new ProviderRequestError(PROVIDER_ID, `Трек готов, но скачивание вернуло HTTP ${response.status}.`, {
      kind: 'server',
    });
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Пишет трек: ставит задачу, ждёт её и отдаёт готовый файл.
 *
 * Единственное место в этом модуле, которое тратит деньги, — createTask:
 * платится сам заказ, и отменить его после отправки нельзя. Поэтому всё,
 * что можно проверить заранее (ключ, длительность), проверяется до него.
 */
export async function generateTrack(request: TrackRequest): Promise<GeneratedTrack> {
  if (!isMusicConfigured()) {
    throw new ProviderRequestError(PROVIDER_ID, MUSIC_SETUP_HINT, { kind: 'auth' });
  }

  const duration = clampDuration(request.duration);
  const startedAt = Date.now();

  const taskId = await createTask({ ...request, duration });
  logger.info('Заказан трек', {
    taskId,
    duration,
    model: config.goapi.music.model,
    usd: trackPrice(duration).toFixed(4),
    инструментал: request.lyrics.trim() === '[inst]',
  });

  const url = await waitForTrack(taskId);
  const data = await download(url);
  const elapsedMs = Date.now() - startedAt;

  logger.info('Трек готов', { taskId, kb: Math.round(data.length / 1024), sec: Math.round(elapsedMs / 1000) });

  return {
    data,
    // Ace-Step у GoAPI отдаёт mp3 — расширение видно прямо в ссылке.
    mimeType: url.toLowerCase().includes('.wav') ? 'audio/wav' : 'audio/mpeg',
    duration,
    costUsd: trackPrice(duration),
    elapsedMs,
  };
}

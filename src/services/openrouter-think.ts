/**
 * Глубокое размышление над одним вопросом («/гем !размышление ...») — OpenRouter.
 *
 * Четвёртое место, где бот тратит деньги, и единственное, где платят
 * не за картинку, звук или поиск, а за само думанье.
 *
 * Обычный /гем отвечает в разговоре: коротко на простое, подробно на сложное.
 * Здесь наоборот — один вопрос, никакой переписки вокруг, и модель, которой
 * дают время подумать перед ответом. Философский вопрос, спор, «а как вообще
 * на это смотреть» — то, где полминуты размышления меняют ответ целиком.
 *
 * Что важно знать про этот вызов:
 *
 *  • думанье просят параметром reasoning, а не словами в промпте. effort —
 *    это доля бюджета, уходящая на размышление: high ≈ 0,8 от max_tokens,
 *    xhigh и max ≈ 0,95. Отсюда ловушка: доля делит не качество, а место,
 *    и при max модель продумает всё, не оставив себе места написать.
 *    Поэтому по умолчанию high при 24 000 — 19 200 токенов на мысли
 *    и 4800 на текст, чего хватает и на длинный ответ по существу;
 *  • сами мысли не возвращаются (reasoning.exclude). Платим за них всё
 *    равно — но в чате они не нужны, там нужен ответ;
 *  • модель — цепочка в .env (DEEP_CHAIN, голова contrib, запас luna),
 *    и это не лень, а осознанный выбор: цена за один и тот же вопрос
 *    отличается впятеро, а кто из них лучше рассуждает по-русски,
 *    выясняется одним вечером с одним и тем же вопросом. DEEP_MODEL
 *    оставлен как алиас головы ради совместимости со старым .env;
 *  • ключ тот же, что у картинок и запасного поиска: аккаунт OpenRouter
 *    один, отдельный заводить незачем;
 *  • свежих фактов у модели нет и быть не может — её знания кончаются
 *    задолго до сегодня. Поэтому в промпт кладут настоящую дату, а факты
 *    подвозят страницами из Tavily (см. handleDeep в commands/ai.ts).
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { today } from '../utils.js';
import { ProviderRequestError, type ProviderErrorKind } from '../types.js';
import { throwIfAborted, withTimeoutSignal } from './cancel.js';
import type { WebPage } from './tavily.js';

const PROVIDER_ID = 'openrouter';

/**
 * Отказы, после которых thinkDeeply пробует следующую модель цепочки.
 * Свой набор, глобальный RETRYABLE из chain.ts не трогаем: там таймаут
 * неперебираемый сознательно, и здесь тоже — см. комментарий к таймауту
 * в thinkDeeply. Пустой ответ по обрыву длины (kind server) перебирается:
 * бюджет мог съесть именно эту модель, а запасная напишет короче.
 */
const DEEP_RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'quota',
  'not-found',
  'server',
  'unknown',
]);

/** Ответ chat/completions — берём только то, что нужно. */
interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    /** Фактическая стоимость вызова в долларах — её сообщает сам OpenRouter. */
    cost?: number;
    completion_tokens?: number;
    /**
     * Сколько токенов ушло на невидимые мысли. Единственный способ узнать,
     * что происходит внутри: сами мысли мы не показываем, а без их объёма
     * настройка DEEP_EFFORT и DEEP_MAX_TOKENS остаётся гаданием.
     */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  model?: string;
  error?: { message?: string };
}

/** Готовое размышление. */
export interface DeepAnswer {
  text: string;
  /** Кто отвечал: OpenRouter возвращает точное имя, а не то, что просили. */
  model: string;
  costUsd?: number;
  /**
   * Сколько токенов модель потратила на размышление. Показывается в подписи
   * под ответом — по этому числу и настраиваются потолки: если мыслей вышло
   * втрое меньше разрешённого, поднимать потолок незачем, а если модель
   * упёрлась в него, есть о чём говорить.
   */
  thoughtTokens?: number;
  /**
   * Кончилось ли место посреди ответа. Молчать об этом нельзя: оборванный
   * текст выглядит как законченный — просто короче, чем ждали, — и человек
   * решает, что модель так и ответила, вместо того чтобы переспросить
   * покороче или поднять DEEP_MAX_TOKENS.
   */
  truncated?: boolean;
  elapsedMs: number;
}

/**
 * Сколько токенов из бюджета отведено мыслям при нынешнем усилии.
 *
 * Нужна не запросу, а подписи под ответом: «мыслей 13 500 из 19 200» —
 * единственный способ понять, тесно модели или просторно, а сам OpenRouter
 * этого числа не сообщает, только фактическую трату.
 */
const THOUGHT_SHARE: Record<string, number> = {
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
  max: 0.95,
};

export function deepThoughtBudget(): number {
  const { effort, maxTokens } = config.openrouter.deep;
  return Math.round(maxTokens * (THOUGHT_SHARE[effort.toLowerCase()] ?? 0.8));
}

export const DEEP_SETUP_HINT =
  'Добавьте OPENROUTER_API_KEY в .env (ключ и баланс: https://openrouter.ai/keys) — ' +
  'размышление идёт через него же, что и картинки. Порядок моделей задаётся DEEP_CHAIN.';

/** Настроено ли размышление. Ключ общий с картинками и поиском. */
export function isDeepThinkConfigured(): boolean {
  return config.openrouter.apiKey.length > 0;
}

/**
 * Правила для модели.
 *
 * Здесь просят ровно того, чего не просят больше нигде в боте: думать вслух
 * и не спешить. Разговора вокруг вопроса нет — значит, и уточнить нечего:
 * ответ должен быть самодостаточным.
 *
 * Дата ставится в промпт живой, а не берётся из головы модели: без неё
 * «сегодня» для неё — день, которым кончилось обучение, и всякий срок она
 * считает от него. Это самая частая странность моделей со старой границей
 * знаний, и лечится она одной строкой, а не сменой модели.
 *
 * Про формат сказано отдельно, потому что модели на «порассуждай» охотно
 * отвечают списком тезисов, а список — это не рассуждение, а оглавление
 * рассуждения, которое так и не написали.
 */
function systemPrompt(grounded: boolean): string {
  return [
    'Тебе задают один вопрос — без переписки вокруг и без предыстории, только он.',
    'Это просьба подумать, а не выдать справку.',
    '',
    `Сегодня ${today()}. Это настоящая сегодняшняя дата, а не день, которым кончается`,
    'твоё обучение: сроки и «сколько времени прошло» считай от неё.',
    grounded
      ? 'К вопросу приложены свежие страницы из интернета. В том, что касается фактов, ' +
        'верь им, а не памяти: они новее. Если к вопросу они не относятся — не притягивай ' +
        'их за уши, думай сам. Ссылки в текст не вставляй, их допишет бот.'
      : 'Если вопрос упирается в то, что случилось после твоей границы знаний, — скажи об этом ' +
        'прямо, вместо того чтобы выдавать устаревшее за нынешнее.',
    '',
    'Отвечай развёрнуто и по-русски, живым языком.',
    'Разбери сам вопрос: что в нём спрашивается на самом деле и на каких допущениях он стоит.',
    'Покажи разные взгляды и назови, чем каждый держится, а не просто перечисли их.',
    'Скажи, где ответ упирается в то, что проверить нельзя, — и чем дело кончается по-твоему.',
    'Закончи подробными выводами по существу: что из разобранного следует и что с этим делать дальше.',
    'Выводы — про дело, а не про объём: без воды.',
    '',
    'Пиши связным текстом, абзацами: список тезисов — это оглавление рассуждения,',
    'а не рассуждение. Списком пользуйся, только когда перечисляешь действительно',
    'однородное. Заголовки уместны, если ответ длинный.',
    'Дыши абзацами: каждый смысловой блок — отдельным абзацем с пустой строкой между ними;',
    'заголовок отделяй пустой строкой сверху и снизу; список — пустыми строками до и после;',
    'внутри абзаца — 2–4 предложения.',
    'Воды, повторов и пересказа вопроса быть не должно: длина берётся из мысли, а не из слов.',
    '',
    'Разметка — обычный Markdown: **жирный** только для заголовков, подчёркивания (++плюсы++) —',
    'только при реальной необходимости, максимум 1–2 слова на ответ, *курсив* редко и только для названий, `код` — только там, где текст реально нужно скопировать тапом, списки на •.',
    'Каждый заголовок — обязательно **жирным**, заголовок plain-текстом запрещён.',
    'Каждое предложение заканчивай точкой (или ? ! …), заголовки и пункты списка — тоже с точкой в конце, кроме главного заголовка ответа, где точка мешает. Каждое новое предложение начинай с заглавной буквы.',
    'Смайлики — максимум два на ответ и только уместно; в длинном ответе обязательно освежай текст строгими маркерами-разметкой',
    'для чтения с телефона (📌 ❗️ ⚠️ ✅ в начале заголовка или важной строки, текстовые • → · для структуры),',
    'ориентир — маркер в каждом втором-третьем блоке, но не чаще одного маркера в строке.',
    'Таблицы в Telegram не отображаются, не используй их.',
  ].join('\n');
}

/**
 * Складывает вопрос и найденные страницы в одно сообщение.
 *
 * Страницы идут перед вопросом, а не после: так модель сначала читает
 * материал, а потом узнаёт, что с ним делать, — и не начинает отвечать
 * с середины первой же ссылки.
 */
function userMessage(question: string, pages: WebPage[]): string {
  if (pages.length === 0) return question;

  const found = pages
    .map((page, index) => `[${index + 1}] ${page.title} — ${page.url}\n${page.content}`)
    .join('\n\n');

  return `Свежие страницы из интернета по теме вопроса:\n\n${found}\n\n---\n\nВопрос: ${question}`;
}

/**
 * Думает над вопросом и возвращает ответ.
 *
 * Таймаут свой и большой: с размышлением ответ идёт минуты, а не секунды,
 * и общий девяностосекундный потолок обрывал бы ровно те вопросы, ради
 * которых команду и позвали.
 *
 * Цепочка идёт по config.openrouter.deep.chain (по умолчанию contrib →
 * luna): первый успех — ответ. Дальше — только на DEEP_RETRYABLE
 * (квота, пропавшая модель, сбой провайдера, неизвестное); auth,
 * bad-request (модель не понимает reasoning), timeout и блокировки —
 * наружу сразу.
 *
 * Таймаут — на каждую попытку отдельно, а не общий на цепочку: contrib
 * думает долго (полный ответ до ~13 с и больше), deep-ответы большие,
 * и общий бюджет обрезал бы запасную модель ровно тогда, когда голова
 * съела время впустую. Худший случай — N × DEEP_TIMEOUT_MS, но на деле
 * retryable-отказы это быстрые HTTP-ошибки (4xx/5xx за доли секунды),
 * а таймаут сам не перебирается — так что вторая попытка почти никогда
 * не ждёт полных 300 с сверх первой.
 */
export async function thinkDeeply(question: string, pages: WebPage[] = [], signal?: AbortSignal): Promise<DeepAnswer> {
  if (!isDeepThinkConfigured()) {
    throw new ProviderRequestError(PROVIDER_ID, DEEP_SETUP_HINT, { kind: 'auth' });
  }

  const { chain, model: head, effort, maxTokens, timeoutMs } = config.openrouter.deep;
  const models = chain.length > 0 ? chain : [head];
  const startedAt = Date.now();

  const skipped: string[] = [];
  let lastError: ProviderRequestError | undefined;

  for (const model of models) {
    // Отмена — не повод для запасной модели, она уже не нужна никому.
    throwIfAborted(PROVIDER_ID, signal);
    try {
      const answer = await requestDeepModel(model, question, pages, { effort, maxTokens, timeoutMs }, startedAt, signal);
      if (skipped.length > 0) {
        logger.info('Размышление ответила резервная модель', { model, skipped });
      }
      return answer;
    } catch (error) {
      const kind = error instanceof ProviderRequestError ? error.kind : 'unknown';

      // Причина, которая повторится на любой модели, — показываем как есть.
      if (!DEEP_RETRYABLE.has(kind)) throw error;

      lastError = error instanceof ProviderRequestError ? error : new ProviderRequestError(PROVIDER_ID, String(error), { kind });
      skipped.push(model);
      logger.warn('Deep-модель отказала, беру следующую из цепочки', {
        model,
        kind,
        message: lastError.message,
      });
    }
  }

  throw new ProviderRequestError(
    PROVIDER_ID,
    `Ни одна deep-модель не смогла ответить — перепробованы все ${skipped.length}: ${skipped.join(', ')}.\n\n` +
      `Последняя причина: ${lastError?.message ?? 'неизвестна'}`,
    { cause: lastError, kind: lastError?.kind ?? 'unknown' },
  );
}

interface DeepRequestOptions {
  effort: string;
  maxTokens: number;
  timeoutMs: number;
}

/** Один вызов chat/completions на заданной модели. Бросает ProviderRequestError с честным kind. */
async function requestDeepModel(
  model: string,
  question: string,
  pages: WebPage[],
  options: DeepRequestOptions,
  startedAt: number,
  signal?: AbortSignal,
): Promise<DeepAnswer> {
  const { effort, maxTokens, timeoutMs } = options;

  let response: Response;
  try {
    response = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model,
        // Истории нет намеренно: вопрос задают «голым», и переписка раздела
        // сюда не подмешивается — ни по смыслу, ни по деньгам (см. handleDeep).
        messages: [
          { role: 'system', content: systemPrompt(pages.length > 0) },
          { role: 'user', content: userMessage(question, pages) },
        ],
        max_tokens: maxTokens,
        // Собственно думанье. exclude — не показывать мысли: платим за них
        // всё равно, но в чат идёт ответ, а не черновик. Одинаково на обеих
        // моделях цепочки: запасная должна думать так же, а не отвечать
        // наспех.
        reasoning: { effort, exclude: true },
        usage: { include: true },
      }),
      signal: withTimeoutSignal(signal, timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // AbortSignal.timeout бросает TimeoutError — помечаем честно, чтобы
    // цепочка его НЕ перебирала: ждать ещё 300 с за молчание — не страховка.
    // Внешняя отмена (AbortError) — kind 'cancelled', тоже не перебирается.
    const kind: ProviderErrorKind =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : error instanceof Error && error.name === 'AbortError'
          ? 'cancelled'
          : 'server';
    throw new ProviderRequestError(PROVIDER_ID, `Не удалось связаться с OpenRouter: ${message}`, {
      cause: error,
      kind,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    if (response.status === 401) {
      throw new ProviderRequestError(PROVIDER_ID, 'OpenRouter отклонил ключ (401). Проверьте OPENROUTER_API_KEY.', {
        kind: 'auth',
      });
    }
    if (response.status === 402) {
      throw new ProviderRequestError(
        PROVIDER_ID,
        'На балансе OpenRouter закончились деньги (402). Пополните счёт — думать больше не на что.',
        { kind: 'quota' },
      );
    }
    if (response.status === 429) {
      throw new ProviderRequestError(PROVIDER_ID, 'OpenRouter просит подождать: слишком много запросов (429).', {
        kind: 'quota',
      });
    }
    // Модели из обращения выводят: вчера работавшее имя сегодня отвечает
    // 404. Это главный сценарий подхвата запасной — без kind цепочка
    // отказ бы НЕ перебрала.
    if (response.status === 404) {
      throw new ProviderRequestError(PROVIDER_ID, `Модели ${model} нет на OpenRouter (404): ${body.slice(0, 200)}.`, {
        kind: 'not-found',
      });
    }
    // 400 здесь чаще всего значит, что выбранная модель не понимает reasoning
    // в том виде, в каком его прислали, — об этом и говорим прямо, иначе
    // человек будет искать причину в своём вопросе.
    if (response.status === 400) {
      throw new ProviderRequestError(
        PROVIDER_ID,
        `OpenRouter отклонил запрос (400): ${body.slice(0, 200)}. ` +
          `Проверьте DEEP_CHAIN (${model}) и DEEP_EFFORT (${effort}): размышление поддерживают не все модели.`,
        { kind: 'bad-request' },
      );
    }

    throw new ProviderRequestError(PROVIDER_ID, `OpenRouter ответил ${response.status}: ${body.slice(0, 300)}`, {
      kind: response.status >= 500 ? 'server' : 'bad-request',
    });
  }

  const data = (await response.json()) as ChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    // Пустой ответ при обрыве по длине — это ровно ловушка effort: всё место
    // ушло на мысли, на текст не осталось. Говорим, что крутить.
    const truncated = data.choices?.[0]?.finish_reason === 'length';
    throw new ProviderRequestError(
      PROVIDER_ID,
      truncated
        ? `Модель продумала ответ, но не успела его написать: весь бюджет ушёл на размышление. ` +
          `Поднимите DEEP_MAX_TOKENS (сейчас ${maxTokens}) или опустите DEEP_EFFORT (сейчас ${effort}).`
        : `${data.error?.message ?? 'OpenRouter вернул пустой ответ'}.`,
      { kind: 'server' },
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const thoughtTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
  // Текст есть, но бюджет кончился раньше точки: ответ оборван на полуслове.
  const truncated = data.choices?.[0]?.finish_reason === 'length';

  logger.info('Размышление готово', {
    model: data.model ?? model,
    effort,
    maxTokens,
    pages: pages.length,
    seconds: Math.round(elapsedMs / 1000),
    thoughtTokens,
    truncated,
    completionTokens: data.usage?.completion_tokens,
    chars: text.length,
    costUsd: data.usage?.cost,
  });

  return {
    text,
    model: data.model ?? model,
    ...(typeof data.usage?.cost === 'number' ? { costUsd: data.usage.cost } : {}),
    ...(typeof thoughtTokens === 'number' ? { thoughtTokens } : {}),
    ...(truncated ? { truncated: true } : {}),
    elapsedMs,
  };
}

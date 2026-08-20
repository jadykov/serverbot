/**
 * Глубокое размышление над одним вопросом («/гем !размышление ...») — OpenRouter.
 *
 * Четвёртое место, где бот тратит деньги, и единственное, где платят
 * не за картинку, звук или поиск, а за само думанье.
 *
 * Зачем это, когда есть «!контекст». «!контекст» — это разбор в разговоре:
 * бесплатный Gemini, вся история раздела, ответ по делу. Здесь наоборот —
 * один вопрос, никакой переписки вокруг, и модель, которой дают время
 * подумать перед ответом. Философский вопрос, спор, «а как вообще на это
 * смотреть» — то, где полминуты размышления меняют ответ целиком.
 *
 * Что важно знать про этот вызов:
 *
 *  • думанье просят параметром reasoning, а не словами в промпте. effort —
 *    это доля бюджета, уходящая на размышление: high ≈ 0,8 от max_tokens,
 *    xhigh ≈ 0,95. Отсюда ловушка: при xhigh и скромном max_tokens модель
 *    продумает всё и не оставит места самому ответу. Поэтому по умолчанию
 *    high при 12 000 — около 9600 токенов на мысли и 2400 на текст;
 *  • сами мысли не возвращаются (reasoning.exclude). Платим за них всё
 *    равно — но в чате они не нужны, там нужен ответ;
 *  • модель — переменная в .env, и это не лень, а осознанный выбор: цена
 *    за один и тот же вопрос отличается впятеро (см. DEEP_MODEL), а кто
 *    из них лучше рассуждает по-русски, выясняется одним вечером с одним
 *    и тем же вопросом;
 *  • ключ тот же, что у картинок и запасного поиска: аккаунт OpenRouter
 *    один, отдельный заводить незачем;
 *  • свежих фактов у модели нет и быть не может — её знания кончаются
 *    задолго до сегодня. Поэтому в промпт кладут настоящую дату, а факты
 *    подвозят страницами из Tavily (см. handleDeep в commands/ai.ts).
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { today } from '../utils.js';
import { ProviderRequestError } from '../types.js';
import type { WebPage } from './tavily.js';

const PROVIDER_ID = 'openrouter';

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
  elapsedMs: number;
}

export const DEEP_SETUP_HINT =
  'Добавьте OPENROUTER_API_KEY в .env (ключ и баланс: https://openrouter.ai/keys) — ' +
  'размышление идёт через него же, что и картинки. Модель задаётся DEEP_MODEL.';

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
    '',
    'Пиши связным текстом, абзацами: список тезисов — это оглавление рассуждения,',
    'а не рассуждение. Списком пользуйся, только когда перечисляешь действительно',
    'однородное. Заголовки уместны, если ответ длинный.',
    'Воды, повторов и пересказа вопроса быть не должно: длина берётся из мысли, а не из слов.',
    '',
    'Разметка — обычный Markdown: **жирный**, *курсив*, `код`, списки через дефис.',
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
 */
export async function thinkDeeply(question: string, pages: WebPage[] = []): Promise<DeepAnswer> {
  if (!isDeepThinkConfigured()) {
    throw new ProviderRequestError(PROVIDER_ID, DEEP_SETUP_HINT, { kind: 'auth' });
  }

  const { model, effort, maxTokens, timeoutMs } = config.openrouter.deep;
  const startedAt = Date.now();

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
        // всё равно, но в чат идёт ответ, а не черновик.
        reasoning: { effort, exclude: true },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError(PROVIDER_ID, `Не удалось связаться с OpenRouter: ${message}`, {
      cause: error,
      kind: 'server',
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
    // 400 здесь чаще всего значит, что выбранная модель не понимает reasoning
    // в том виде, в каком его прислали, — об этом и говорим прямо, иначе
    // человек будет искать причину в своём вопросе.
    if (response.status === 400) {
      throw new ProviderRequestError(
        PROVIDER_ID,
        `OpenRouter отклонил запрос (400): ${body.slice(0, 200)}. ` +
          `Проверьте DEEP_MODEL (${model}) и DEEP_EFFORT (${effort}): размышление поддерживают не все модели.`,
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

  logger.info('Размышление готово', {
    model: data.model ?? model,
    effort,
    maxTokens,
    pages: pages.length,
    seconds: Math.round(elapsedMs / 1000),
    thoughtTokens,
    completionTokens: data.usage?.completion_tokens,
    chars: text.length,
    costUsd: data.usage?.cost,
  });

  return {
    text,
    model: data.model ?? model,
    ...(typeof data.usage?.cost === 'number' ? { costUsd: data.usage.cost } : {}),
    ...(typeof thoughtTokens === 'number' ? { thoughtTokens } : {}),
    elapsedMs,
  };
}

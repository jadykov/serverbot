/**
 * Живой поиск в интернете через OpenRouter («/гем !сеть ...»).
 *
 * Третье и последнее место, где бот тратит деньги, — и самое дешёвое из трёх:
 * поиск обходится примерно в $0,004 против $0,015 за картинку.
 *
 * Почему не встроенный поиск Gemini, с которого начинали. Grounding with
 * Google Search бесплатному ключу недоступен: API отвечает, что инструмент
 * для этого ключа не разрешён. Проверено на живом ключе бота 18 августа 2026.
 * Заработает он, если у Google включить биллинг, — но тогда это будут ровно
 * такие же деньги, только у другого поставщика.
 *
 * Почему не DuckDuckGo, с которого обычно предлагают начать: официального
 * поискового API у него нет вовсе. Бесплатный Instant Answer отдаёт карточки
 * из Википедии, а не выдачу, и на живой вопрос возвращает пустоту. Остаётся
 * скрейпить HTML, а его DuckDuckGo целенаправленно душит (202, 403) —
 * и особенно быстро с адресов дата-центров, то есть ровно с нашей VPS.
 *
 * Как это устроено у OpenRouter. Поиск здесь не модель, а плагин к обычному
 * запросу chat/completions: найденные страницы подмешиваются в тот же вызов,
 * и модель, которая ищет, она же и отвечает. Второго обращения к нейросети
 * не нужно — а значит, не нужно и ждать дважды.
 *
 * Движок поиска выбирается отдельно от модели, и это главная экономия: цены
 * у движков различаются в разы ($0,001 у parallel против $0,007 у exa),
 * а модель к ним подходит любая. Оба параметра — в .env, без пересборки.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRequestError } from '../types.js';

/** Ответ chat/completions — берём только то, что нужно. */
interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      /**
       * Ссылки на найденное. OpenRouter приводит их к одному виду
       * независимо от движка — этим он здесь и удобен.
       */
      annotations?: Array<{
        type?: string;
        url_citation?: { url?: string; title?: string };
      }>;
    };
  }>;
  /** Фактическая стоимость вызова в долларах: поиск плюс токены. */
  usage?: { cost?: number };
  error?: { message?: string };
}

export interface WebAnswer {
  text: string;
  /** Источники готовыми ссылками Markdown, по порядку. */
  sources: string[];
  costUsd?: number;
  elapsedMs: number;
}

export const WEB_SETUP_HINT =
  'Добавьте OPENROUTER_API_KEY в .env (ключ и баланс: https://openrouter.ai/keys) — ' +
  'живой поиск идёт через него же, что и картинки.';

/** Настроен ли поиск. Ключ тот же, что у картинок: аккаунт OpenRouter один. */
export function isWebSearchConfigured(): boolean {
  return config.openrouter.apiKey.length > 0;
}

/**
 * Правила для модели.
 *
 * Свой список источников ей запрещают не из вредности: бот дописывает
 * собственный, из annotations, и два списка подряд выглядят поломкой.
 * Ограничение по длине здесь же, а не в общем правиле: ответ с поиском
 * выходит длиннее обычного, а ссылки идут последними и при обрезке
 * по границе сообщения Telegram пропали бы первыми.
 */
const SYSTEM_PROMPT = [
  'Ты — помощник в групповом чате Telegram. Отвечай по-русски, коротко и по делу,',
  'опираясь на найденные страницы, а не на память. Если найденное противоречит',
  'само себе — так и скажи, а не выбирай молча одну версию.',
  'Если в найденном ответа нет, честно скажи об этом, а не придумывай.',
  'Ответ не длиннее 2000 знаков. Своего списка источников не составляй',
  'и ссылки в текст не вставляй — их допишет бот.',
  'Разметка — обычный Markdown: **жирный**, *курсив*, `код`. Заголовки и таблицы',
  'в Telegram не отображаются, не используй их.',
].join(' ');

/** Достаёт источники из ответа, по пять штук: больше в сообщение не влезет. */
function collectSources(response: ChatResponse): string[] {
  const annotations = response.choices?.[0]?.message?.annotations ?? [];
  const seen = new Set<string>();
  const links: string[] = [];

  for (const annotation of annotations) {
    const url = annotation.url_citation?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);

    // Заголовок бывает пустым и бывает длиной в предложение — режем.
    const raw = annotation.url_citation?.title?.trim() || new URL(url).hostname.replace(/^www\./, '');
    const title = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;

    // Скобки в подписи сломали бы разметку [текст](url) при разборе.
    links.push(`[${title.replace(/[[\]()]/g, '')}](${url})`);
    if (links.length === 5) break;
  }

  return links;
}

/** Ищет в интернете и отвечает по найденному. */
export async function searchWeb(query: string): Promise<WebAnswer> {
  if (!isWebSearchConfigured()) {
    throw new ProviderRequestError('openrouter', WEB_SETUP_HINT, { kind: 'auth' });
  }

  const { model, engine, maxResults } = config.openrouter.web;
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
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
        // Собственно поиск. Движок и число страниц — из .env: цена запроса
        // складывается почти целиком из них, а не из модели.
        plugins: [{ id: 'web', engine, max_results: maxResults }],
        // Просим вернуть фактическую стоимость вызова: считать её по прайсу
        // вслепую незачем, когда сервис сообщает точную сумму сам.
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError('openrouter', `Не удалось связаться с OpenRouter: ${message}`, {
      cause: error,
      kind: 'server',
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    if (response.status === 401) {
      throw new ProviderRequestError('openrouter', 'OpenRouter отклонил ключ (401). Проверьте OPENROUTER_API_KEY.', {
        kind: 'auth',
      });
    }
    if (response.status === 402) {
      throw new ProviderRequestError(
        'openrouter',
        'На балансе OpenRouter закончились деньги (402). Пополните счёт — искать больше нечем.',
        { kind: 'quota' },
      );
    }
    if (response.status === 429) {
      throw new ProviderRequestError('openrouter', 'OpenRouter просит подождать: слишком много запросов (429).', {
        kind: 'quota',
      });
    }

    throw new ProviderRequestError('openrouter', `OpenRouter ответил ${response.status}: ${body.slice(0, 300)}`, {
      kind: response.status >= 500 ? 'server' : 'bad-request',
    });
  }

  const data = (await response.json()) as ChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new ProviderRequestError(
      'openrouter',
      data.error?.message ?? 'OpenRouter вернул пустой ответ. Попробуйте переформулировать запрос.',
      { kind: 'blocked' },
    );
  }

  const sources = collectSources(data);
  const elapsedMs = Date.now() - startedAt;

  logger.info('Живой поиск выполнен', {
    model,
    engine,
    ms: elapsedMs,
    sources: sources.length,
    costUsd: data.usage?.cost,
  });

  return { text, sources, costUsd: data.usage?.cost, elapsedMs };
}

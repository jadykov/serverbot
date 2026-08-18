/**
 * Поиск в интернете через Tavily.
 *
 * Отличие от OpenRouter принципиальное: Tavily — это поисковый сервис,
 * а не нейросеть. Он возвращает страницы (заголовок, адрес, выжимку),
 * и на этом его работа кончается. Ответ по найденному пишет обычная
 * бесплатная цепочка Gemini — та же, что отвечает на любой вопрос.
 *
 * Отсюда и главное свойство: поиск через Tavily не стоит денег вовсе.
 * Тратится не доллар, а кредит из пакета (у нас их 1000, по одному
 * за обычный поиск), а разбор найденного идёт по бесплатной дневной норме
 * Google. Поэтому Tavily здесь основной, а платный OpenRouter — запасной
 * (см. handleWeb в commands/ai.ts).
 *
 * Глубина поиска намеренно оставлена обычной: advanced стоит два кредита
 * вместо одного, а разница нужна на длинных исследовательских запросах,
 * которых в групповом чате не бывает.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRequestError } from '../types.js';

/** Одна найденная страница. */
export interface WebPage {
  title: string;
  url: string;
  /** Выжимка со страницы — по ней и отвечает модель. */
  content: string;
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
  error?: string;
  detail?: { error?: string };
}

export const TAVILY_SETUP_HINT =
  'Добавьте TAVILY_API_KEY в .env (ключ и остаток кредитов: https://app.tavily.com) — ' +
  'это бесплатный путь для «!сеть». Без него поиск идёт через платный OpenRouter.';

export function isTavilyConfigured(): boolean {
  return config.tavily.apiKey.length > 0;
}

/**
 * Ищет страницы по запросу. Пустой список — это не ошибка, а «ничего
 * не нашлось»: решать, что с этим делать, вызывающему коду.
 */
export async function searchTavily(query: string): Promise<WebPage[]> {
  if (!isTavilyConfigured()) {
    throw new ProviderRequestError('tavily', TAVILY_SETUP_HINT, { kind: 'auth' });
  }

  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(`${config.tavily.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.tavily.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: config.tavily.maxResults,
        search_depth: config.tavily.searchDepth,
        // Свой ответ Tavily тоже умеет писать, но он нам не нужен: отвечает
        // бот своим голосом и своей моделью, а лишняя генерация — лишние
        // кредиты. Берём только страницы.
        include_answer: false,
      }),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError('tavily', `Не удалось связаться с Tavily: ${message}`, {
      cause: error,
      kind: 'server',
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    if (response.status === 401) {
      throw new ProviderRequestError('tavily', 'Tavily отклонил ключ (401). Проверьте TAVILY_API_KEY.', {
        kind: 'auth',
      });
    }
    // 432 у Tavily значит «кредиты кончились» — именно тот случай, ради
    // которого и держится запасной путь через OpenRouter.
    if (response.status === 432 || response.status === 429) {
      throw new ProviderRequestError(
        'tavily',
        `Tavily больше не отвечает на запросы (${response.status}): кончились кредиты или превышена частота.`,
        { kind: 'quota' },
      );
    }

    throw new ProviderRequestError('tavily', `Tavily ответил ${response.status}: ${body.slice(0, 300)}`, {
      kind: response.status >= 500 ? 'server' : 'bad-request',
    });
  }

  const data = (await response.json()) as TavilyResponse;

  const pages: WebPage[] = (data.results ?? [])
    .filter((item): item is { title?: string; url: string; content?: string } => Boolean(item.url))
    .map((item) => ({
      title: item.title?.trim() || new URL(item.url).hostname.replace(/^www\./, ''),
      url: item.url,
      content: item.content?.trim() ?? '',
    }));

  logger.info('Tavily: поиск выполнен', {
    ms: Date.now() - startedAt,
    depth: config.tavily.searchDepth,
    pages: pages.length,
  });

  return pages;
}

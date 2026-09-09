/**
 * Реестр провайдеров нейросетей.
 *
 * Здесь — единственное место, которое нужно править, чтобы подключить
 * ещё одну нейросеть: написать класс с интерфейсом TextProvider/ImageProvider
 * и добавить его в соответствующий массив ниже.
 */
import { GeminiProvider } from './gemini.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { OpenRouterImageProvider } from './openrouter-image.js';
import { generateWithChain, RETRYABLE, type ChainAnswer } from './chain.js';
import { throwIfAborted } from './cancel.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ImageProvider,
  type TextGenerationOptions,
  type TextProvider,
} from '../types.js';

/** Текстовые нейросети. Первый настроенный в списке используется по умолчанию. */
export const textProviders: TextProvider[] = [new GeminiProvider(), new OpenAiCompatibleProvider()];

/**
 * Нейросети, рисующие картинки. Здесь только платный OpenRouter: бесплатной
 * генерации изображений в Gemini API не существует — см. комментарий
 * в src/services/openrouter-image.ts.
 */
export const imageProviders: ImageProvider[] = [new OpenRouterImageProvider()];

/** id провайдера, который подставляется в новую сессию. */
export const DEFAULT_TEXT_PROVIDER_ID = textProviders[0]?.id ?? 'gemini';
export const DEFAULT_IMAGE_PROVIDER_ID = imageProviders[0]?.id ?? 'openrouter';

/**
 * Находит текстовый провайдер по id — даже если он не настроен.
 * Нужен командам, которые привязаны к конкретной нейросети (например, /гем).
 */
export function findTextProvider(id: string): TextProvider | undefined {
  return textProviders.find((provider) => provider.id === id);
}

/**
 * Возвращает текстовый провайдер по id. Если он не настроен (нет ключей) —
 * молча подставляет первый настроенный. Если настроенных нет вовсе —
 * бросает ProviderNotConfiguredError со списком подсказок.
 */
export function resolveTextProvider(preferredId: string): TextProvider {
  const preferred = textProviders.find((provider) => provider.id === preferredId);
  if (preferred?.isConfigured) return preferred;

  const fallback = textProviders.find((provider) => provider.isConfigured);
  if (fallback) return fallback;

  throw new ProviderNotConfiguredError(textProviders.map((provider) => provider.setupHint));
}

/** То же самое для генерации картинок. */
export function resolveImageProvider(preferredId: string): ImageProvider {
  const preferred = imageProviders.find((provider) => provider.id === preferredId);
  if (preferred?.isConfigured) return preferred;

  const fallback = imageProviders.find((provider) => provider.isConfigured);
  if (fallback) return fallback;

  throw new ProviderNotConfiguredError(imageProviders.map((provider) => provider.setupHint));
}

/**
 * Двухуровневый фолбэк (п.3 плана): сначала платный OpenRouter-уровень,
 * при его retryable-отказе — бесплатный Gemini-уровень.
 *
 * Один уровень = провайдер + его цепочка + потолки именно этого уровня.
 * Явные maxOutputTokens/timeoutMs в options сильнее уровневых (так команды
 * задают свои потолки: файлы, поиск). Пустой уровень (провайдер не настроен
 * или цепочка пуста) молча пропускается — без OpenRouter-ключа бот работает
 * как раньше, на чистом Gemini.
 *
 * На второй уровень уходим только при отказах, которые там могут пройти:
 * quota/not-found/server (кончился баланс, модель сняли, 5xx) и unknown
 * (странный ответ посредника). auth/timeout/bad-request/blocked/geo —
 * наружу как есть: неверный ключ и обрезанный вес на Gemini не чинятся,
 * а таймаут ждать дважды (до 120с + 90с) — многоминутное молчание.
 */
export interface ChainLevel {
  provider: TextProvider;
  models: string[];
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export async function generateWithFallback(
  levels: ChainLevel[],
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<ChainAnswer> {
  const skipped: string[] = [];
  let lastError: unknown;

  for (const level of levels) {
    if (!level.provider.isConfigured || level.models.length === 0) continue;
    // Отмена — не повод для следующего уровня (см. chain.ts).
    throwIfAborted(level.provider.id, options.signal);
    try {
      const answer = await generateWithChain(level.provider, level.models, prompt, {
        ...options,
        maxOutputTokens: options.maxOutputTokens ?? level.maxOutputTokens,
        timeoutMs: options.timeoutMs ?? level.timeoutMs,
      });
      return { ...answer, skipped: [...skipped, ...answer.skipped] };
    } catch (error) {
      const kind = error instanceof ProviderRequestError ? error.kind : 'unknown';
      // Неперебираемый отказ — дальше будет то же самое (или дольше).
      if (error instanceof ProviderRequestError && !RETRYABLE.has(kind) && kind !== 'unknown') throw error;
      // Непредвиденное (баг SDK, TypeError и т.п.) — не маскируем под
      // «не подключена»: исходная ошибка должна дойти до replyWithError.
      lastError = error;
      skipped.push(...level.models);
      logger.warn('Уровень цепочки отказал целиком, ухожу на следующий', {
        provider: level.provider.id,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (lastError) throw lastError;
  throw new ProviderNotConfiguredError(textProviders.map((provider) => provider.setupHint));
}

/**
 * Пол потолка ответа для OpenRouter-уровней: contrib с меньшим отдаёт
 * пустоту или огрызок — весь лимит съедают рассуждения (замерено 2026-09-08:
 * при 50 токенах content null; 2026-09-09: финал «!сети» с 1400 вернулся
 * обрывком «**Глав», в истории сессии так и легло).
 */
export const OPENROUTER_OUTPUT_FLOOR = 4_000;

/** Уровни умной цепочки: OpenRouter (только contrib) → Gemini. Пусто — только Gemini. */
export function resolveSmartLevels(fallbackModels: string[], fallbackMaxTokens: number): ChainLevel[] {
  const openai = findTextProvider('openai');
  const levels: ChainLevel[] = [];
  if (openai?.isConfigured && config.openai.chains.smart.length > 0) {
    // Пол — OPENROUTER_OUTPUT_FLOOR выше: contrib с меньшим потолком отдаёт
    // пустоту, весь лимит съедают рассуждения.
    levels.push({
      provider: openai,
      models: config.openai.chains.smart,
      maxOutputTokens: Math.min(
        Math.max(fallbackMaxTokens, OPENROUTER_OUTPUT_FLOOR),
        Math.max(config.openai.maxOutput.smart, OPENROUTER_OUTPUT_FLOOR),
      ),
      timeoutMs: config.openai.timeoutMs,
    });
  }
  const gemini = findTextProvider('gemini');
  if (gemini) levels.push({ provider: gemini, models: fallbackModels, maxOutputTokens: fallbackMaxTokens });
  return levels;
}

/**
 * Уровни быстрой цепочки (JSON-планы): точный плоский порядок владельца
 * 3.5-lite → 3.1-lite → contrib → gemma. Luna в середине — только для
 * диалога «!нарисуй» (withLuna=true): планировщики !скажи и !трек идут
 * без неё, по решению владельца запас luna после contrib положен только
 * «!сети», «!размышлению» и «!нарисуй».
 */
export function resolveFastLevels(withLuna = false): ChainLevel[] {
  const levels: ChainLevel[] = [];
  const gemini = findTextProvider('gemini');
  // L1 Gemini lite-голова: всё из GEMINI_CHAIN_FAST, кроме Gemma (фильтр, а не
  // отдельный ключ — состав правится одним списком). Потолок разговорный main:
  // планы короткие, и резать их не о чем.
  const liteHead = config.gemini.chains.fast.filter((model) => !/gemma/i.test(model));
  if (gemini && liteHead.length > 0) {
    levels.push({ provider: gemini, models: liteHead, maxOutputTokens: config.gemini.maxOutput.main });
  }
  // L2 OpenRouter: contrib, а для «!нарисуй» — contrib→luna. Без флага luna
  // из списка вычищается: даже если она осталась в чужом .env, в !скажи
  // и !трек она не пойдёт. Если флага просят, а luna в ключе нет, —
  // добавляем её запасом после contrib.
  const openai = findTextProvider('openai');
  const fastModels = withLuna
    ? [...config.openai.chains.fast.filter((model) => !/luna/i.test(model)), 'openai/gpt-5.6-luna'].filter(
        (model, index, all) => all.indexOf(model) === index,
      )
    : config.openai.chains.fast.filter((model) => !/luna/i.test(model));
  if (openai?.isConfigured && fastModels.length > 0) {
    levels.push({
      provider: openai,
      models: fastModels,
      maxOutputTokens: config.openai.maxOutput.fast,
      timeoutMs: config.ai.timeoutMs,
    });
  }
  // L3 Gemini Gemma-хвост: последняя страховка с огромной дневной нормой.
  const gemmaTail = config.gemini.chains.fast.filter((model) => /gemma/i.test(model));
  if (gemini && gemmaTail.length > 0) {
    levels.push({ provider: gemini, models: gemmaTail, maxOutputTokens: config.gemini.maxOutput.main });
  }
  return levels;
}

/**
 * Порядок Gemini-хвоста для «!сеть»: проверен вживую на боте 21.08.2026 тем же
 * по весу запросом (пять страниц Tavily на входе первого прохода).
 *
 *  • gemini-3.7-flash (бывшая голова) то отказывал с 503 «high demand», то не
 *    укладывался даже в увеличенный таймаут на весе поисковых страниц.
 *    Таймаут цепочка не перебирает (см. RETRYABLE в chain.ts) — первая же его
 *    неудача такого рода валила весь запрос, а не шла дальше.
 *  • gemini-3.6-flash тоже словил 503 в том же тесте.
 *  • gemini-3.5-flash ответил 200 за 13 секунд — из проверенных моделей
 *    единственный, кто отработал с первого раза.
 *
 * Ни одну модель совсем не убираем — 3.6 и 3.7 иногда вполне отвечают,
 * а резерв ничего не стоит. Просто первым идёт проверенно доступный 3.5,
 * а самый капризный 3.7 — почти в хвосте, но всё же перед Gemma: она
 * настоящая модель, а не запасной вариант «на всякий случай», и заслуживает
 * попытки раньше медленной страховки. Каких моделей в хвосте нет, те шаги
 * пропускаются сами.
 */
function reorderWebModels(models: string[]): string[] {
  const special = ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemma-4-31b-it'];
  return [
    ...(models.includes('gemini-3.5-flash') ? ['gemini-3.5-flash'] : []),
    ...models.filter((model) => !special.includes(model)),
    ...(models.includes('gemini-3.7-flash') ? ['gemini-3.7-flash'] : []),
    ...(models.includes('gemma-4-31b-it') ? ['gemma-4-31b-it'] : []),
  ];
}

/**
 * Уровни «!сеть»: L1 OpenRouter contrib→luna (contrib голова, luna запас),
 * L2 Gemini-хвост тем же спецпорядком (3.5 → … → 3.7 → gemma).
 *
 * Голова здесь задана явно, а не выведена из OPENAI_CHAIN_SMART: luna
 * положена только «!сети», «!размышлению» и «!нарисуй», и из умной цепочки
 * она убрана — выводить тут было бы не из чего. contrib берём из ключа,
 * если он там есть, иначе — дефолтный; luna добавляется запасом всегда.
 *
 * Потолки на проход задаёт вызывающий код явно (WEB_DIGEST_/WEB_FINAL_MAX_OUTPUT_TOKENS);
 * уровневные здесь — запасные, на случай вызова без явных. Явный потолок ниже
 * OPENROUTER_OUTPUT_FLOOR вызывающий код поднимает сам (см. searchWithTavily):
 * иначе contrib вернёт огрызок вместо ответа.
 */
export function resolveWebLevels(fallbackModels: string[]): ChainLevel[] {
  const levels: ChainLevel[] = [];
  const openai = findTextProvider('openai');
  // Явный порядок contrib→luna: contrib — из OPENAI_CHAIN_SMART, если он там
  // есть, иначе дефолтный; luna — запасом всегда, независимо от ключа.
  const contrib =
    config.openai.chains.smart.find((model) => /contributor/i.test(model)) ?? 'meta/muse-spark-1.3-contributor';
  const webModels = [contrib, 'openai/gpt-5.6-luna'].filter((model, index, all) => all.indexOf(model) === index);
  if (openai?.isConfigured) {
    levels.push({
      provider: openai,
      models: webModels,
      maxOutputTokens: config.ai.webDigestMaxOutputTokens,
      timeoutMs: config.ai.webTimeoutMs,
    });
  }
  const gemini = findTextProvider('gemini');
  const tail = reorderWebModels(fallbackModels);
  if (gemini && tail.length > 0) {
    levels.push({ provider: gemini, models: tail, maxOutputTokens: config.gemini.maxOutput.main });
  }
  return levels;
}

/** Сводка по всем провайдерам — используется в /status, /test и /health. */
export function describeProviders(): Array<{ id: string; title: string; kind: 'текст' | 'картинки'; ready: boolean }> {
  return [
    ...textProviders.map((provider) => ({
      id: provider.id,
      title: provider.title,
      kind: 'текст' as const,
      ready: provider.isConfigured,
    })),
    ...imageProviders.map((provider) => ({
      id: provider.id,
      title: provider.title,
      kind: 'картинки' as const,
      ready: provider.isConfigured,
    })),
  ];
}

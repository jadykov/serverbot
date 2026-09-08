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
  let lastError: ProviderRequestError | undefined;

  for (const level of levels) {
    if (!level.provider.isConfigured || level.models.length === 0) continue;
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
      lastError = error instanceof ProviderRequestError ? error : undefined;
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

/** Уровни умной цепочки: OpenRouter (contrib→full→luna) → Gemini. Пусто — только Gemini. */
export function resolveSmartLevels(fallbackModels: string[], fallbackMaxTokens: number): ChainLevel[] {
  const openai = findTextProvider('openai');
  const levels: ChainLevel[] = [];
  if (openai?.isConfigured && config.openai.chains.smart.length > 0) {
    // Пол 4000: contrib с меньшим потолком отдаёт пустоту — весь лимит
    // съедают рассуждения (замерено 2026-09-08: при 50 токенах content null).
    levels.push({
      provider: openai,
      models: config.openai.chains.smart,
      maxOutputTokens: Math.min(Math.max(fallbackMaxTokens, 4_000), Math.max(config.openai.maxOutput.smart, 4_000)),
      timeoutMs: config.openai.timeoutMs,
    });
  }
  const gemini = findTextProvider('gemini');
  if (gemini) levels.push({ provider: gemini, models: fallbackModels, maxOutputTokens: fallbackMaxTokens });
  return levels;
}

/** Уровни быстрой цепочки (JSON-планы): OpenRouter (contrib→luna) → Gemini fast. */
export function resolveFastLevels(): ChainLevel[] {
  const openai = findTextProvider('openai');
  const levels: ChainLevel[] = [];
  if (openai?.isConfigured && config.openai.chains.fast.length > 0) {
    levels.push({
      provider: openai,
      models: config.openai.chains.fast,
      maxOutputTokens: config.openai.maxOutput.fast,
      timeoutMs: config.ai.timeoutMs,
    });
  }
  const gemini = findTextProvider('gemini');
  if (gemini)
    levels.push({
      provider: gemini,
      models: config.gemini.chains.fast,
      maxOutputTokens: config.gemini.maxOutput.main,
    });
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

/**
 * Реестр провайдеров нейросетей.
 *
 * Здесь — единственное место, которое нужно править, чтобы подключить
 * ещё одну нейросеть: написать класс с интерфейсом TextProvider/ImageProvider
 * и добавить его в соответствующий массив ниже.
 */
import { GeminiProvider } from './gemini.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { FusionBrainProvider } from './fusionbrain.js';
import { ProviderNotConfiguredError, type ImageProvider, type TextProvider } from '../types.js';

/** Текстовые нейросети. Первый настроенный в списке используется по умолчанию. */
export const textProviders: TextProvider[] = [new GeminiProvider(), new OpenAiCompatibleProvider()];

/** Нейросети, рисующие картинки. */
export const imageProviders: ImageProvider[] = [new FusionBrainProvider()];

/** id провайдера, который подставляется в новую сессию. */
export const DEFAULT_TEXT_PROVIDER_ID = textProviders[0]?.id ?? 'gemini';
export const DEFAULT_IMAGE_PROVIDER_ID = imageProviders[0]?.id ?? 'fusionbrain';

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

/** Сводка по всем провайдерам — используется в /status, /test и /ai. */
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

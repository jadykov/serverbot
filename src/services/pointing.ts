/**
 * «Где здесь ...» — поиск объектов на фотографии с рамкой поверх снимка.
 *
 * Работают этим модели Robotics ER: они обучены не рассказывать про картинку,
 * а показывать на ней — возвращать координаты предметов. Дневная норма у них
 * по 20 запросов на модель, поэтому здесь та же цепочка с подхватом.
 *
 * Координаты приходят нормированными к 0…1000 по каждой стороне — то есть
 * не в пикселях, а в долях кадра. Так модели не нужно знать настоящий размер
 * снимка, а нам не нужно его ей сообщать: пересчёт в пиксели наш.
 *
 * Рамки рисуются вручную, без графических библиотек: JPEG разбирается
 * в массив пикселей (jpeg-js — чистый JavaScript, без нативных сборок),
 * поверх кладутся линии, всё собирается обратно. Подписи не рисуем — для
 * букв нужен шрифт и растеризатор; вместо этого рамки разного цвета,
 * а расшифровка цветов уходит в подпись под фотографией.
 */
import { decode, encode } from 'jpeg-js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { translateGeminiError } from './gemini.js';
import { ProviderRequestError, type Attachment } from '../types.js';
import { GoogleGenAI } from '@google/genai';
import { withTimeout } from '../utils.js';

/** Найденный предмет: рамка в долях кадра (0…1) и как модель его назвала. */
export interface FoundObject {
  label: string;
  /** Границы рамки: доли от ширины и высоты кадра. */
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** Цвета рамок по порядку. Названия — для подписи под фотографией. */
export const BOX_COLORS = [
  { name: '🟥 красная', rgb: [255, 59, 48] },
  { name: '🟩 зелёная', rgb: [52, 199, 89] },
  { name: '🟦 синяя', rgb: [0, 122, 255] },
  { name: '🟨 жёлтая', rgb: [255, 214, 10] },
  { name: '🟪 фиолетовая', rgb: [175, 82, 222] },
] as const;

const PROVIDER_ID = 'gemini-pointing';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({
      apiKey: config.gemini.apiKey,
      ...(config.gemini.baseUrl ? { httpOptions: { baseUrl: config.gemini.baseUrl } } : {}),
    });
  }
  return client;
}

/**
 * Инструкция модели. Просим строго JSON и строго нормированные координаты:
 * в свободном пересказе («слева вверху») рамку не нарисуешь.
 */
const INSTRUCTION = [
  'Ты находишь предметы на фотографии и показываешь, где они.',
  'Ответь строго JSON-массивом, без пояснений вокруг:',
  '[{"box_2d": [ymin, xmin, ymax, xmax], "label": "название по-русски"}]',
  'Координаты — целые числа от 0 до 1000, доли кадра: 0 — верхний/левый край, 1000 — нижний/правый.',
  'Если предмета на фотографии нет, верни пустой массив [].',
  'Не выдумывай: показывай только то, что действительно видно.',
].join('\n');

/** Отказы, после которых имеет смысл взять следующую модель. */
const RETRYABLE = new Set(['quota', 'not-found', 'server']);

/** Разбирает ответ модели в список рамок. */
function parseBoxes(raw: string, limit: number): FoundObject[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const boxes: FoundObject[] = [];

  for (const item of parsed) {
    const record = item as { box_2d?: unknown; label?: unknown };
    const box = record.box_2d;
    if (!Array.isArray(box) || box.length !== 4) continue;

    const [yMin, xMin, yMax, xMax] = box.map((value) => Number(value) / 1000);
    if ([yMin, xMin, yMax, xMax].some((value) => !Number.isFinite(value))) continue;
    // Вырожденные рамки модель иногда выдаёт при неуверенности — они бесполезны.
    if (xMax! <= xMin! || yMax! <= yMin!) continue;

    boxes.push({
      label: typeof record.label === 'string' ? record.label : 'объект',
      xMin: Math.max(0, xMin!),
      yMin: Math.max(0, yMin!),
      xMax: Math.min(1, xMax!),
      yMax: Math.min(1, yMax!),
    });

    if (boxes.length >= limit) break;
  }

  return boxes;
}

/** Спрашивает у моделей Robotics ER, где на снимке искомое. */
export async function findObjects(image: Attachment, query: string): Promise<FoundObject[]> {
  if (!config.gemini.apiKey) {
    throw new ProviderRequestError(PROVIDER_ID, 'Не задан GEMINI_API_KEY — искать нечем.', { kind: 'auth' });
  }

  const skipped: string[] = [];
  let lastError: ProviderRequestError | undefined;

  for (const model of config.pointing.chain) {
    try {
      const response = await withTimeout(
        getClient().models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { text: `Найди на фотографии: ${query}` },
                { inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } },
              ],
            },
          ],
          config: { systemInstruction: INSTRUCTION, temperature: 0.1 },
        }),
        config.ai.timeoutMs,
        `Gemini Robotics (${model})`,
      );

      const boxes = parseBoxes(response.text ?? '', BOX_COLORS.length);
      logger.info('Поиск объектов на фото', { model, skipped, query, found: boxes.length });
      return boxes;
    } catch (error) {
      const failure = error instanceof ProviderRequestError ? error : translateGeminiError(PROVIDER_ID, model, error);
      if (!RETRYABLE.has(failure.kind)) throw failure;

      lastError = failure;
      skipped.push(model);
    }
  }

  throw new ProviderRequestError(
    PROVIDER_ID,
    `Не удалось разобрать фотографию: перепробованы все модели (${skipped.join(', ')}). ` +
      `Дневная норма у них по 20 запросов.\n\nПоследняя причина: ${lastError?.message ?? 'неизвестна'}`,
    { cause: lastError, kind: lastError?.kind ?? 'unknown' },
  );
}

/**
 * Рисует рамки поверх фотографии.
 *
 * Толщину линии считаем от размера кадра, а не берём фиксированной: на снимке
 * 4000 пикселей шириной рамка в два пикселя попросту не видна.
 */
export function drawBoxes(jpeg: Buffer, boxes: FoundObject[]): Buffer {
  const image = decode(jpeg, { useTArray: true });
  const { width, height, data } = image;
  const thickness = Math.max(2, Math.round(Math.min(width, height) / 200));

  const paint = (x: number, y: number, rgb: readonly number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = rgb[0]!;
    data[offset + 1] = rgb[1]!;
    data[offset + 2] = rgb[2]!;
    data[offset + 3] = 255;
  };

  boxes.forEach((box, index) => {
    const color = BOX_COLORS[index % BOX_COLORS.length]!.rgb;
    const left = Math.round(box.xMin * width);
    const right = Math.round(box.xMax * width);
    const top = Math.round(box.yMin * height);
    const bottom = Math.round(box.yMax * height);

    for (let offset = 0; offset < thickness; offset += 1) {
      for (let x = left; x <= right; x += 1) {
        paint(x, top + offset, color);
        paint(x, bottom - offset, color);
      }
      for (let y = top; y <= bottom; y += 1) {
        paint(left + offset, y, color);
        paint(right - offset, y, color);
      }
    }
  });

  // Качество 90 — рамки чёткие, а вес файла остаётся телеграмным.
  return Buffer.from(encode({ data, width, height }, 90).data);
}

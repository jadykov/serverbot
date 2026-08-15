/**
 * Разбор присланных файлов: книги, статьи, выгрузки.
 *
 * Главное ограничение здесь не окно модели, а минутная квота бесплатного
 * тарифа. Замерено на живом ключе: у флешей окно 1 048 576 токенов, но
 * запрос больше 250 000 входных токенов отбивается сразу, и квота в ошибке
 * названа прямо — GenerateContentInputTokensPerModelPerMinute-FreeTier.
 * Проверено: 100 000 и 150 000 токенов проходят за 3–4 секунды, 200 000
 * и выше — уже нет.
 *
 * Отсюда предел по умолчанию: 150 000 токенов, около 450 КБ текста или
 * 230 страниц. Он оставляет примерно сотню тысяч минутного бюджета остальным
 * участникам — иначе один человек с книгой блокировал бы модель для всей
 * группы на минуту.
 *
 * Второй потолок — телеграмный: боты не могут скачать файл больше 20 МБ,
 * и обойти это нельзя никак (см. src/media.ts).
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { translateGeminiError } from './gemini.js';
import { ProviderRequestError, type Attachment } from '../types.js';

/** Подготовленный к отправке файл. */
export interface PreparedDocument {
  /** Что уйдёт в модель: текст для текстовых форматов, байты для PDF. */
  text?: string;
  attachment?: Attachment;
  /** Имя файла — показываем человеку и кладём в промпт. */
  fileName: string;
  /** Во что обошёлся файл в токенах. */
  tokens: number;
  /** Заметка о том, что с файлом сделали: перекодировали, вычистили разметку. */
  note?: string;
}

const PROVIDER_ID = 'gemini-docs';

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

/** Расширение файла в нижнем регистре, без точки. */
function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Декодирует текст, разбираясь с кодировкой.
 *
 * Русские книги в .txt и .fb2 сплошь и рядом лежат в windows-1251, а не в utf-8,
 * и молча прочитанные как utf-8 превращаются в «ЗЅСЂ». Определяем по-простому:
 * пробуем строгий utf-8, и если он спотыкается — перечитываем в 1251.
 */
function decodeText(data: Buffer): { text: string; recoded: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), recoded: false };
  } catch {
    return { text: new TextDecoder('windows-1251').decode(data), recoded: true };
  }
}

/**
 * Вытаскивает из FB2 читаемый текст.
 *
 * FB2 — это XML, и если отдать его модели как есть, треть токенов уйдёт
 * на теги и на base64 обложки внутри <binary>. Поэтому обложки вырезаем
 * целиком, абзацы превращаем в строки, остальные теги снимаем.
 */
function fb2ToText(xml: string): string {
  return xml
    // Картинки внутри FB2 лежат тут же, закодированные base64: мегабайты мусора.
    .replace(/<binary[\s\S]*?<\/binary>/gi, '')
    .replace(/<\/(?:p|title|section|subtitle|empty-line)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Считает токены той моделью, которой файл и уйдёт. */
async function countTokens(text: string | undefined, attachment: Attachment | undefined): Promise<number> {
  const model = config.gemini.chains.think[0] ?? config.gemini.model;

  try {
    const response = await getClient().models.countTokens({
      model,
      contents: [
        {
          role: 'user',
          parts: text
            ? [{ text }]
            : [{ inlineData: { mimeType: attachment!.mimeType, data: attachment!.data.toString('base64') } }],
        },
      ],
    });
    return response.totalTokens ?? 0;
  } catch (error) {
    throw translateGeminiError(PROVIDER_ID, model, error);
  }
}

/**
 * Готовит присланный файл к отправке в модель — или объясняет, почему нельзя.
 *
 * Отказы здесь намеренно подробные, с числами: «файл слишком большой» без
 * величины и предела не говорит человеку ничего, а он в этот момент решает,
 * резать ему книгу пополам или пересохранять.
 */
export async function prepareDocument(data: Buffer, fileName: string): Promise<PreparedDocument> {
  const extension = extensionOf(fileName);
  let text: string | undefined;
  let attachment: Attachment | undefined;
  let note: string | undefined;

  if (extension === 'pdf') {
    // PDF Gemini читает сам, постранично: разбирать его нам нечем и незачем.
    attachment = { data, mimeType: 'application/pdf' };
  } else if (extension === 'fb2') {
    const decoded = decodeText(data);
    text = fb2ToText(decoded.text);
    const saved = Math.round((1 - text.length / decoded.text.length) * 100);
    note = `из FB2 вычищена разметка${saved > 0 ? `, файл стал легче на ${saved}%` : ''}${
      decoded.recoded ? ', перекодирован из windows-1251' : ''
    }`;
  } else if (['txt', 'md', 'csv', 'log', 'json', 'xml', 'srt'].includes(extension)) {
    const decoded = decodeText(data);
    text = decoded.text;
    if (decoded.recoded) note = 'файл перекодирован из windows-1251';
  } else {
    throw new ProviderRequestError(
      PROVIDER_ID,
      `Формат «.${extension || 'без расширения'}» я разбирать не умею.\n\n` +
        'Понимаю: .txt, .md, .csv, .log, .json, .xml, .srt, .fb2 и .pdf.\n' +
        'EPUB и .fb2.zip нужно сначала распаковать или пересохранить.',
      { kind: 'bad-request' },
    );
  }

  if (text !== undefined && text.trim().length === 0) {
    throw new ProviderRequestError(PROVIDER_ID, 'В файле не нашлось текста — возможно, это скан или пустышка.', {
      kind: 'bad-request',
    });
  }

  const tokens = await countTokens(text, attachment);
  const limit = config.docs.maxTokens;

  if (tokens > limit) {
    const overshoot = Math.round((tokens / limit) * 10) / 10;
    throw new ProviderRequestError(
      PROVIDER_ID,
      `Файл слишком большой: ~${tokens.toLocaleString('ru')} токенов при пределе ${limit.toLocaleString('ru')} ` +
        `(это в ${overshoot} раза больше).\n\n` +
        'Дело не в памяти модели — окно у неё миллион токенов, — а в минутной норме бесплатного тарифа: ' +
        'она 250 тысяч на модель, и одним таким запросом заняло бы её всю.\n\n' +
        'Пришлите часть книги или спросите по главам.',
      { kind: 'bad-request' },
    );
  }

  logger.info('Файл подготовлен', { fileName, extension, tokens, kb: Math.round(data.length / 1024) });

  return { text, attachment, fileName, tokens, note };
}

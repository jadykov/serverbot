/**
 * Работа с файлами, которые приходят в чат: скачивание из Telegram
 * и склейка альбомов.
 *
 * Зачем отдельный модуль
 * ----------------------
 * Телеграм не присылает содержимое файла вместе с апдейтом — приходит только
 * идентификатор. Чтобы показать картинку нейросети, файл нужно сначала забрать
 * двумя запросами: getFile отдаёт путь, а сам файл лежит по адресу
 * api.telegram.org/file/bot<токен>/<путь>.
 *
 * Второе: альбом из нескольких фотографий Telegram присылает как несколько
 * независимых апдейтов с общим media_group_id. Если обрабатывать их «в лоб»,
 * на альбом из пяти снимков уйдёт пять запросов к модели и в чат прилетит
 * пять отдельных ответов. Поэтому апдейты альбома копятся и уходят одним пакетом.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { detectImageMime } from './utils.js';
import { ProviderRequestError, type Attachment, type BotContext } from './types.js';

/**
 * Потолок Bot API: файлы больше 20 МБ бот скачать не может в принципе,
 * getFile на них отвечает ошибкой. Проверяем заранее, чтобы показать
 * человеку понятную причину вместо «Bad Request: file is too big».
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Сколько ждём остальные части альбома, прежде чем считать его собранным. */
const ALBUM_WINDOW_MS = 1200;

/** Отдельный таймаут на скачивание: он не связан с ожиданием ответа нейросети. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Забирает файл из Telegram и отдаёт готовое вложение.
 *
 * mimeHint — тип, который Telegram сообщил в апдейте (у голосовых и документов
 * он есть). Для фотографий его нет, поэтому тип определяется по первым байтам.
 */
export async function downloadAttachment(
  ctx: BotContext,
  fileId: string,
  mimeHint?: string,
): Promise<Attachment> {
  const file = await ctx.api.getFile(fileId);

  if (file.file_size !== undefined && file.file_size > MAX_FILE_BYTES) {
    throw new ProviderRequestError(
      'telegram',
      `Файл слишком большой (${Math.round(file.file_size / 1024 / 1024)} МБ). ` +
        'Боты не могут скачивать файлы больше 20 МБ — это ограничение Telegram, а не бота.',
    );
  }

  if (!file.file_path) {
    throw new ProviderRequestError('telegram', 'Telegram не отдал путь к файлу. Попробуйте отправить его ещё раз.');
  }

  const url = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError('telegram', `Не удалось скачать файл: ${message}`, { cause: error });
  }

  if (!response.ok) {
    throw new ProviderRequestError('telegram', `Не удалось скачать файл: HTTP ${response.status}`);
  }

  const data = Buffer.from(await response.arrayBuffer());

  logger.debug('Файл скачан из Telegram', { bytes: data.length, path: file.file_path });

  return { data, mimeType: mimeHint ?? detectImageMime(data) };
}

/**
 * Выбирает, какой из размеров фотографии забирать.
 *
 * Telegram присылает одну и ту же картинку в нескольких разрешениях, по
 * возрастанию. Берём самое большое: мелкий текст на скриншотах читается только
 * в нём, а лимит токенов при нашем объёме всё равно недостижим.
 */
export function pickPhotoFileId(photo: ReadonlyArray<{ file_id: string }>): string | undefined {
  return photo.at(-1)?.file_id;
}

/** Одна собираемая пачка: части альбома, пришедшие к этому моменту. */
interface PendingAlbum {
  ctx: BotContext;
  fileIds: string[];
  caption: string;
  /** Пусто ровно один момент — между созданием пачки и постановкой таймера. */
  timer?: NodeJS.Timeout;
}

const albums = new Map<string, PendingAlbum>();

/**
 * Копит части альбома и вызывает onReady один раз, когда они перестали приходить.
 *
 * Каждая новая часть сдвигает таймер: Telegram шлёт их подряд, так что пауза
 * в ALBUM_WINDOW_MS означает, что альбом закончился. В onReady уходит контекст
 * первого сообщения — отвечать нужно именно на него.
 */
export function collectAlbumPart(
  ctx: BotContext,
  mediaGroupId: string,
  fileId: string,
  caption: string,
  onReady: (ctx: BotContext, fileIds: string[], caption: string) => Promise<void>,
): void {
  let album = albums.get(mediaGroupId);

  if (album) {
    clearTimeout(album.timer);
    album.fileIds.push(fileId);
    // Подпись у альбома одна и висит на произвольной его части — забираем первую непустую.
    if (!album.caption && caption) album.caption = caption;
  } else {
    // Контекст запоминаем от первой части: отвечать нужно именно на неё.
    album = { ctx, fileIds: [fileId], caption };
    albums.set(mediaGroupId, album);
  }

  const collected = album;
  const timer = setTimeout(() => {
    albums.delete(mediaGroupId);
    void onReady(collected.ctx, collected.fileIds, collected.caption).catch((error: unknown) => {
      logger.error('Ошибка при обработке альбома', {
        mediaGroupId,
        parts: collected.fileIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, ALBUM_WINDOW_MS);

  // Таймер не должен удерживать процесс при остановке бота.
  timer.unref();
  album.timer = timer;
}

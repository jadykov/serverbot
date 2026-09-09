/**
 * «/гем !файл ...» — ответ отдельным файлом вместо сообщения.
 *
 * Зачем: у сообщения Telegram потолок 4096 знаков, и всё длинное приезжает
 * пачкой кусков — читать неудобно, сохранить нельзя. Файл решает обе беды
 * разом, а заодно позволяет отдать то, чему в чате вообще не место:
 * самодостаточную HTML-страницу, схему в SVG, выгрузку в CSV.
 *
 * Два слова в запросе:
 *   /гем !файл <что сделать>          — модель создаёт содержимое в формате по умолчанию (md);
 *   /гем !файл <формат> <что сделать> — тот же заказ в названном формате.
 *
 * Реплай подхватывается: текст/подпись цитируются (до 700 знаков, как
 * в обычной ветке через buildReplyQuotePrompt), а документ из реплая
 * скачивается и читается через prepareDocument — иначе модель получала
 * только слова заказа («составь таблицу…») и выдумывала содержимое.
 *
 * Расширение выбирается, а не назначается: явное слово в запросе сильнее
 * всего, потом — по содержимому (страница, картинка, блок кода), и только
 * в последнюю очередь общее умолчание .md. Markdown, а не .txt, потому что
 * модель пишет разметкой: в .txt звёздочки и решётки остались бы мусором.
 */
import { InputFile } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml, markdownToHtmlPage, markdownToPlainText } from '../format.js';
import { withChatAction, sessionKey } from '../utils.js';
import { downloadAttachment } from '../media.js';
import { prepareDocument } from '../services/documents.js';
import { generateWithFallback, resolveSmartLevels } from '../services/registry.js';
import { rememberMessage } from '../services/search-index.js';
import { messagesQuota } from '../services/daily-quota.js';
import { resolveChain, THINK_CHAIN } from '../models.js';
import type { BotContext } from '../types.js';

/** Форматы, которые можно потребовать явно: «/гем !файл html дашборд продаж». */
const FORMATS: Record<string, { ext: string; hint: string }> = {
  md: { ext: 'md', hint: 'Markdown' },
  txt: { ext: 'txt', hint: 'простой текст без разметки' },
  html: {
    ext: 'html',
    hint:
      'один самодостаточный HTML-файл: стили внутри <style>, картинки и схемы — inline SVG. ' +
      'Никаких ссылок на внешние библиотеки, шрифты и картинки: файл должен открываться без интернета. ' +
      'Страницу делай читаемой, а не сплошной простынёй букв: заголовки и разделы, ' +
      'колонка текста не шире 46rem по центру, поля по краям, межстрочный интервал около 1.6, ' +
      'тёмная тема через prefers-color-scheme, вёрстка не разъезжается на телефоне. ' +
      'Данные — таблицей с рамками и подсветкой чётных строк, а не абзацем; ' +
      'числа, у которых видна динамика или доли, — простым inline-SVG графиком с подписями',
  },
  svg: { ext: 'svg', hint: 'один SVG-документ, начиная с <svg ...>, с явными width и height' },
  csv: { ext: 'csv', hint: 'CSV с заголовком, разделитель — запятая' },
  json: { ext: 'json', hint: 'один валидный JSON-документ' },
  py: { ext: 'py', hint: 'код на Python' },
  js: { ext: 'js', hint: 'код на JavaScript' },
  ts: { ext: 'ts', hint: 'код на TypeScript' },
  sh: { ext: 'sh', hint: 'shell-скрипт' },
  sql: { ext: 'sql', hint: 'SQL-запрос' },
};

/** Первое слово запроса, если это название формата. */
function takeFormat(request: string): { format?: (typeof FORMATS)[string]; rest: string } {
  const match = /^([a-z]{2,4})\b[\s,:.—–-]*([\s\S]*)$/i.exec(request.trim());
  const key = match?.[1]?.toLowerCase();
  const format = key ? FORMATS[key] : undefined;

  return format ? { format, rest: (match?.[2] ?? '').trim() } : { rest: request.trim() };
}

/** Определяет расширение по самому содержимому: страница, картинка, код. */
function sniffExtension(content: string): string {
  const text = content.trimStart();

  if (/^<!doctype html|^<html[\s>]/i.test(text)) return 'html';
  if (/^<\?xml[\s\S]*?<svg[\s>]|^<svg[\s>]/i.test(text)) return 'svg';
  if (/^[[{][\s\S]*[\]}]$/.test(text.trim())) return 'json';

  // Ответ целиком в одном блоке кода — берём расширение по языку.
  const fenced = /^```([a-z+#]+)?\n([\s\S]*)\n```$/i.exec(text.trim());
  const language = fenced?.[1]?.toLowerCase();
  if (language && FORMATS[language]) return FORMATS[language]!.ext;

  return config.files.defaultFormat;
}

/** Снимает ```-заборы, если модель обернула в них файл вопреки просьбе. */
function stripFence(content: string): string {
  const fenced = /^\s*```[a-z+#]*\n([\s\S]*?)\n?```\s*$/i.exec(content);
  return (fenced?.[1] ?? content).trim();
}

/** Транслитерация для имени файла: кириллица в именах ломается в части клиентов. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Собирает имя файла из запроса: коротко, латиницей, без пробелов. */
function makeFileName(request: string, ext: string): string {
  const slug = request
    .toLowerCase()
    .replace(/[а-яё]/g, (letter) => TRANSLIT[letter] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

  return `${slug || 'file'}.${ext}`;
}

/** Инструкция модели: нужен файл, а не рассказ о файле. */
function buildInstruction(hint: string): string {
  return [
    'Ты готовишь содержимое файла.',
    `Формат: ${hint}.`,
    'Верни ТОЛЬКО содержимое файла — без пояснений до и после, без «вот ваш файл»,',
    'без обрамляющих ``` заборов. Первый символ ответа — первый символ файла.',
    'Пиши сразу набело: правок не будет, файл уйдёт человеку как есть.',
  ].join(' ');
}

/**
 * Расширения, которым нужен BOM: без него iOS (Quick Look и сам Telegram)
 * иногда путает кодировку простого текста, и кириллица приезжает кракозябрами.
 * У остальных форматов свой парсер (JSON, SVG, код), которому BOM в начале
 * файла только мешает, — их не трогаем.
 */
const NEEDS_BOM = new Set(['md', 'txt']);

/**
 * Отправляет готовое содержимое файлом.
 *
 * В чат уходит короткая подпись — она же попадает в архив поиска. Сам файл
 * туда не ляжет: индексируется текст сообщений, а вложение поиск не увидит.
 */
async function sendFile(ctx: BotContext, content: string, fileName: string, caption: string): Promise<void> {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const text = NEEDS_BOM.has(ext) ? `\uFEFF${content}` : content;
  const data = Buffer.from(text, 'utf8');

  await ctx.replyWithDocument(new InputFile(data, fileName), {
    caption: `${caption}\n<code>${escapeHtml(fileName)}</code>, ${(data.length / 1024).toFixed(1)} КБ`,
    parse_mode: 'HTML',
  });

  const key = sessionKey(ctx);
  if (key) rememberMessage(key, { ts: Date.now(), who: 'бот', text: `${caption} (файл ${fileName})` });

  logger.info('Файл отправлен', { fileName, kb: Math.round(data.length / 1024) });
}

/**
 * Форматы, в которых развёрнутое «!размышление» уезжает файлом
 * (см. handleDeep в ./ai.ts).
 *
 * Набор нарочно куда уже, чем FORMATS выше. Там первое слово запроса —
 * это заказ на содержимое («!файл csv выгрузка продаж»), и слова вроде sql
 * или py осмысленны. Здесь же ответ уже написан как ответ, и его остаётся
 * только упаковать: разметкой (.md), простым текстом (.txt) или страницей
 * (.html).
 */
const ANSWER_FORMATS = ['md', 'txt', 'html'] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

/** Первое слово запроса, если это формат ответа-файла. Иначе формата нет. */
export function takeAnswerFormat(request: string): { format?: AnswerFormat; rest: string } {
  const match = /^\.?(md|markdown|txt|text|html)\b[\s,:.—–-]*([\s\S]*)$/i.exec(request.trim());
  const key = match?.[1]?.toLowerCase();
  if (!key) return { rest: request.trim() };

  const format: AnswerFormat = key.startsWith('md') || key === 'markdown' ? 'md' : key === 'html' ? 'html' : 'txt';
  return { format, rest: (match?.[2] ?? '').trim() };
}

/**
 * Упаковывает готовый ответ модели в файл и отправляет его.
 *
 * Ответ уже получен обычным путём, со всей историей раздела и своим промптом;
 * здесь он только перекладывается в файл — потому и разметку снимает не
 * модель, а мы сами (см. markdownToPlainText и markdownToHtmlPage
 * в src/format.ts). Единственное, о чём модель предупреждают заранее, — что
 * ответ станет страницей: тогда она пишет таблицами и графиками, которым
 * в чате места нет (см. HTML_FILE_RULE в ./ai.ts).
 *
 * .md отдаётся как есть: модель и так пишет разметкой, а её тут не портят.
 */
export async function sendAnswerAsFile(
  ctx: BotContext,
  answer: string,
  format: AnswerFormat,
  question: string,
  /** Приписка под именем файла: зачем он вообще приехал. */
  note?: string,
): Promise<void> {
  const title = question.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Ответ';

  const content =
    format === 'txt'
      ? markdownToPlainText(answer)
      : format === 'html'
        ? markdownToHtmlPage(answer, title)
        : answer.trim();

  const caption = `📄 ${escapeHtml(question.slice(0, 200))}${note ? `\n<i>${escapeHtml(note)}</i>` : ''}`;

  await sendFile(ctx, content, makeFileName(question, format), caption);
}

/**
 * «/гем !файл ...»: формат первым словом, дальше заказ модели.
 *
 * Реплай — часть заказа: текст/подпись цитируются, документ из реплая
 * читается (текст — в промпт, PDF — вложением). Без этого модель видела
 * только «составь таблицу…» и сочиняла файл из ничего.
 */
export async function handleFile(ctx: BotContext, request: string): Promise<void> {
  const { format, rest: rawRest } = takeFormat(request);

  // Текст/подпись сообщения, на которое ответили. Цитата — до 700 знаков,
  // как в обычной ветке (buildReplyQuotePrompt в ./ai.ts): отвечать могут
  // на давнее сообщение, которого в истории уже нет.
  const replied = ctx.message?.reply_to_message as
    | { document?: { file_id: string; file_name?: string }; text?: string; caption?: string; from?: { id: number } }
    | undefined;
  const repliedText = (replied?.text ?? replied?.caption ?? '').trim();
  const repliedDocument = replied?.document;

  let rest = rawRest;
  if (!rest && repliedText) rest = repliedText;

  if (!rest) {
    await messagesQuota.release(ctx.from?.id);
    await ctx.reply(
      'Напишите, что положить в файл:\n' +
        '<code>/гем !файл смета на ремонт кухни</code>\n' +
        '<code>/гем !файл html страница с графиком продаж</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Заказ с цитатой реплая (если есть что цитировать и это не сам заказ).
  const order =
    repliedText && repliedText !== rest
      ? replied?.from?.id === ctx.me?.id
        ? `Пользователь отвечает на твою реплику:\n«${repliedText.slice(0, 700)}»\n\nЗаказ на файл: ${rest}`
        : `Заказ задан реплаем на сообщение в чате:\n«${repliedText.slice(0, 700)}»\n\nЗаказ на файл: ${rest}`
      : rest;

  // Умные уровни: OpenRouter-голова, потом Gemini smart-хвост.
  // (THINK_CHAIN ниже — алиас smart, см. models.ts: моделей и потолок те же.)
  const levels = resolveSmartLevels(resolveChain(THINK_CHAIN).models, config.files.maxOutputTokens);
  if (levels.length === 0) {
    await messagesQuota.release(ctx.from?.id);
    await ctx.reply('🔌 Нейросеть не подключена — собирать файл некому.');
    return;
  }

  const chosen = format ?? FORMATS[config.files.defaultFormat] ?? FORMATS.md!;

  try {
    // Документ из реплая: скачиваем и читаем, как handleDocument в ./ai.ts.
    // Текст кладём в промпт, PDF — вложением (модель читает его сама).
    // Ошибка чтения (не тот формат, слишком большой) — сразу человеку.
    let prompt = order;
    let attachments: { data: Buffer; mimeType: string }[] | undefined;
    if (repliedDocument) {
      const fileName = repliedDocument.file_name ?? 'файл';
      const notice = await ctx.reply(`📄 Читаю «${fileName}»…`);
      try {
        const file = await withChatAction(ctx, 'typing', () => downloadAttachment(ctx, repliedDocument.file_id));
        const prepared = await prepareDocument(file.data, fileName);
        prompt = prepared.text ? `Файл «${fileName}»:\n\n${prepared.text}\n\n---\n\n${order}` : order;
        if (prepared.attachment) attachments = [prepared.attachment];
        await ctx.api
          .editMessageText(
            notice.chat.id,
            notice.message_id,
            `📄 «${fileName}» — ${prepared.tokens.toLocaleString('ru')} токенов${prepared.note ? `, ${prepared.note}` : ''}. Собираю файл…`,
          )
          .catch(() => undefined);
        await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
      } catch (error) {
        await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
        throw error;
      }
    }

    const answer = await withChatAction(ctx, 'upload_document', () =>
      generateWithFallback(levels, prompt, {
        systemPrompt: buildInstruction(chosen.hint),
        temperature: 0.6,
        ...(attachments ? { attachments } : {}),
      }),
    );

    const content = stripFence(answer.text);
    // Формат, названный явно, сильнее догадки по содержимому: человек мог
    // попросить .txt именно потому, что не хочет разметки.
    const ext = format?.ext ?? sniffExtension(content);

    await sendFile(ctx, content, makeFileName(rest, ext), `📄 ${escapeHtml(rest.slice(0, 200))}`);
  } catch (error) {
    logger.warn('Не удалось собрать файл', { error: error instanceof Error ? error.message : String(error) });
    await ctx.reply(`⚠️ ${error instanceof Error ? error.message : 'Не получилось собрать файл.'}`);
  }
}

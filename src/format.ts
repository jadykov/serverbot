/**
 * Преобразование Markdown, который пишет нейросеть, в разметку Telegram.
 *
 * Почему через HTML, а не MarkdownV2: в MarkdownV2 нужно экранировать полтора
 * десятка символов (`.`, `-`, `!`, `(`, `)` и т.д.), и любой пропущенный символ
 * ломает всё сообщение целиком. В HTML-режиме экранировать нужно ровно три
 * символа: & < >. Это заметно надёжнее для текста, который мы не контролируем.
 *
 * Telegram понимает только плоский набор тегов: b, i, u, s, a, code, pre,
 * blockquote, tg-spoiler. Списков и заголовков нет — их превращаем в текст.
 */

/** Экранирует символы, значимые для HTML-разметки Telegram. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Метка-заглушка, которой временно подменяется код.
 * Используем управляющий символ \u0001: в осмысленном тексте он не встречается,
 * поэтому случайно совпасть с содержимым ответа не может.
 */
const MARK = '\u0001';
const placeholder = (index: number): string => `${MARK}${index}${MARK}`;

/**
 * Markdown -> HTML для Telegram.
 *
 * Поддерживается: жирный, курсив, зачёркнутый, инлайн-код, блоки кода
 * с подсветкой языка, ссылки, цитаты, списки (превращаются в «•»),
 * заголовки (превращаются в жирный текст).
 */
export function markdownToTelegramHtml(markdown: string): string {
  const codeFragments: string[] = [];

  let text = markdown.replace(/\r\n/g, '\n');

  // 1. Вынимаем код ДО экранирования и любых замен, иначе разметка
  //    внутри примеров кода будет обработана как разметка.
  text = text.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
    const attribute = language ? ` class="language-${escapeHtml(language)}"` : '';
    codeFragments.push(`<pre><code${attribute}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return placeholder(codeFragments.length - 1);
  });

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeFragments.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder(codeFragments.length - 1);
  });

  // 2. Теперь безопасно экранировать всё остальное.
  text = escapeHtml(text);

  // 3. Блочные конструкции — построчно.
  text = text
    // Заголовки Markdown: Telegram их не поддерживает, делаем жирный текст.
    // [^\S\n]* — «пробелы, но не перевод строки»: обычный \s* съедал бы
    // пустую строку после заголовка, и абзац прилипал к нему вплотную.
    .replace(/^[^\S\n]{0,3}#{1,6}[^\S\n]+(.+?)[^\S\n]*#*$/gm, '<b>$1</b>')
    // Горизонтальная линия.
    .replace(/^[^\S\n]{0,3}(?:-[^\S\n]*-[^\S\n]*-|\*[^\S\n]*\*[^\S\n]*\*|_[^\S\n]*_[^\S\n]*_)[-*_ \t]*$/gm, '––––––––––')
    // Маркеры списка: - * + -> •  (нумерованные списки оставляем как есть).
    .replace(/^([^\S\n]*)[-*+][^\S\n]+/gm, '$1• ')
    // Цитаты (символ > уже экранирован в &gt;).
    .replace(/^[^\S\n]{0,3}&gt;[^\S\n]?(.*)$/gm, '<blockquote>$1</blockquote>');

  // Склеиваем подряд идущие строки-цитаты в одну — иначе Telegram
  // нарисует несколько отдельных цитат вместо одной.
  text = text.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // 4. Инлайновые конструкции.
  text = text
    // Ссылки [текст](url). Пробелы в URL не допускаем, чтобы не ловить скобки из текста.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, '<a href="$2">$1</a>')
    // Жирный: **текст** и __текст__
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<![\w\\])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<b>$1</b>')
    // Зачёркнутый: ~~текст~~
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    // Курсив: *текст* и _текст_.
    // Условия намеренно строгие, чтобы не портить snake_case и умножение.
    .replace(/(?<![*\w])\*(?=\S)([^*\n]*\S)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<![\w\\_])_(?=\S)([^_\n]*\S)_(?![\w_])/g, '<i>$1</i>');

  // 5. Возвращаем код на место.
  text = text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_match, index: string) => {
    return codeFragments[Number(index)] ?? '';
  });

  return text.trim();
}

/**
 * Сколько знаков кладём в одно сообщение.
 *
 * У Telegram потолок 4096, мы режем по 3500: запас нужен на разметку —
 * markdownToTelegramHtml разворачивает `код` в <code>код</code>, и текст
 * по дороге прибавляет в длине.
 */
export const MESSAGE_LIMIT = 3500;

/**
 * Режет длинный Markdown на куски под лимит сообщения Telegram (4096 символов).
 *
 * Главная тонкость: нельзя разрывать блок кода — иначе в первом куске
 * останется незакрытая ``` и разметка поедет. Если разрез приходится
 * на середину блока, мы закрываем блок в текущем куске и заново открываем
 * его в следующем.
 *
 * Лимит передают, когда часть сообщения занята чем-то ещё: под ответом
 * поиска идёт список источников, и место под него надо оставить заранее.
 */
export function splitMarkdown(markdown: string, limit = MESSAGE_LIMIT): string[] {
  if (markdown.length <= limit) return [markdown];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  // Язык открытого блока кода или null, если мы вне блока.
  let openFence: string | null = null;

  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join('\n');
    chunks.push(openFence === null ? body : `${body}\n\`\`\``);
    if (openFence === null) {
      current = [];
      currentLength = 0;
    } else {
      const reopened = `\`\`\`${openFence}`;
      current = [reopened];
      currentLength = reopened.length + 1;
    }
  };

  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    let line = rawLine;

    // Строка длиннее лимита (например, гигантский URL) — режем жёстко.
    while (line.length > limit) {
      flush();
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }

    if (currentLength + line.length + 1 > limit) flush();

    current.push(line);
    currentLength += line.length + 1;

    const fence = /^\s*```([\w+#.-]*)/.exec(line);
    if (fence) openFence = openFence === null ? (fence[1] ?? '') : null;
  }

  flush();
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Markdown -> простой текст.
 *
 * Нужен для ответа в .txt: разметка, которую модель пишет всегда, в текстовом
 * файле превращается в мусор — звёздочки вокруг слов, решётки перед
 * заголовками, обратные кавычки посреди кода. Здесь они снимаются, а сам
 * текст остаётся нетронутым.
 *
 * Ссылки разворачиваются в «текст (адрес)»: иначе адрес пропал бы совсем,
 * а в файле, который читают вне чата, это единственный способ дать ссылку.
 */
export function markdownToPlainText(markdown: string): string {
  const codeFragments: string[] = [];

  let text = markdown.replace(/\r\n/g, '\n');

  // Код вынимаем первым — и по той же причине, что и везде: звёздочки
  // и подчёркивания внутри примера кода не разметка, а сам код, и снимать
  // их нельзя. Заборы ``` при этом уходят: в текстовом файле они лишние.
  text = text.replace(/```[\w+#.-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    codeFragments.push(code.replace(/\n$/, ''));
    return placeholder(codeFragments.length - 1);
  });
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeFragments.push(code);
    return placeholder(codeFragments.length - 1);
  });

  text = text
    .replace(/^[^\S\n]{0,3}#{1,6}[^\S\n]+(.+?)[^\S\n]*#*$/gm, '$1')
    .replace(/^[^\S\n]{0,3}(?:-[^\S\n]*-[^\S\n]*-|\*[^\S\n]*\*[^\S\n]*\*|_[^\S\n]*_[^\S\n]*_)[-*_ \t]*$/gm, '––––––––––')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, '$1 ($2)')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/(?<![\w\\])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(?<![*\w])\*(?=\S)([^*\n]*\S)\*(?!\*)/g, '$1')
    .replace(/(?<![\w\\_])_(?=\S)([^_\n]*\S)_(?![\w_])/g, '$1')
    // После снятия заборов остаются лишние пустые строки — схлопываем.
    .replace(/\n{3,}/g, '\n\n');

  // Код возвращаем на место — уже нетронутым.
  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_match, index: string) => codeFragments[Number(index)] ?? '').trim();
}

/**
 * Инлайновая разметка одной строки для настоящей HTML-страницы.
 *
 * Порядок тот же, что и в markdownToTelegramHtml, и по той же причине:
 * код вынимается до экранирования, иначе разметка внутри примеров кода
 * будет обработана как разметка.
 */
function inlineToHtml(source: string): string {
  const code: string[] = [];

  let text = source.replace(/`([^`\n]+)`/g, (_match, fragment: string) => {
    code.push(`<code>${escapeHtml(fragment)}</code>`);
    return placeholder(code.length - 1);
  });

  text = escapeHtml(text)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w\\])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    .replace(/(?<![*\w])\*(?=\S)([^*\n]*\S)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![\w\\_])_(?=\S)([^_\n]*\S)_(?![\w_])/g, '<em>$1</em>');

  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_match, index: string) => code[Number(index)] ?? '');
}

/** Ячейки строки таблицы: крайние палочки лишние, внутренние — границы. */
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

/**
 * Строка-разделитель под шапкой: «|---|:--:|». Без неё палочки в тексте
 * остаются палочками: одна вертикальная черта посреди абзаца таблицей не
 * становится.
 */
function isTableDivider(line: string | undefined): boolean {
  if (!line || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Выравнивание столбцов из той же строки-разделителя: «:--», «--:», «:-:». */
function tableAlign(divider: string): (string | null)[] {
  return splitTableRow(divider).map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    return cell.endsWith(':') ? 'right' : null;
  });
}

/** Разобранная таблица в HTML: шапка отдельно, остальное — тело. */
function tableToHtml(rows: string[][], align: (string | null)[]): string {
  const cell = (text: string, tag: 'th' | 'td', column: number): string => {
    const side = align[column];
    return `<${tag}${side ? ` style="text-align:${side}"` : ''}>${inlineToHtml(text)}</${tag}>`;
  };

  const [head = [], ...body] = rows;
  const parts = ['<div class="table-wrap">', '<table>'];
  parts.push(`<thead><tr>${head.map((text, column) => cell(text, 'th', column)).join('')}</tr></thead>`);
  if (body.length > 0) {
    parts.push('<tbody>');
    for (const row of body) parts.push(`<tr>${row.map((text, column) => cell(text, 'td', column)).join('')}</tr>`);
    parts.push('</tbody>');
  }
  parts.push('</table>', '</div>');

  return parts.join('\n');
}

/**
 * Стили страницы. Скромные намеренно: файл читают, а не разглядывают.
 *
 * Всё внутри одного файла — ни шрифтов, ни библиотек снаружи: страница
 * должна открываться с флешки и без интернета. Тёмная тема идёт следом
 * за системной настройкой читателя, потому что выбирать её в статическом
 * файле негде.
 */
const PAGE_STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #ffffff; --muted: #5c5c5c; --line: #e3e3e3; --code-bg: #f5f5f5; --link: #0a58ca; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e8e8e8; --bg: #16181c; --muted: #a0a0a0; --line: #2f333a; --code-bg: #21252b; --link: #7aa7ff; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 46rem; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2rem 0 0.75rem; }
h1 { font-size: 1.75rem; } h2 { font-size: 1.35rem; } h3 { font-size: 1.15rem; }
p, ul, ol, blockquote, pre { margin: 0 0 1rem; }
ul, ol { padding-left: 1.5rem; }
li { margin: 0.25rem 0; }
a { color: var(--link); }
code { background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; font-size: 0.9em;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 0.875rem; }
blockquote { margin-left: 0; padding: 0.1rem 0 0.1rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
.table-wrap { overflow-x: auto; margin: 0 0 1rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
th, td { border: 1px solid var(--line); padding: 0.45rem 0.7rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); font-weight: 600; }
tbody tr:nth-child(even) td { background: var(--code-bg); }
figure { margin: 1.5rem 0; text-align: center; }
figure svg { max-width: 100%; height: auto; }
.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.85rem; }
`.trim();

/**
 * Markdown -> самодостаточная HTML-страница.
 *
 * Не путать с markdownToTelegramHtml: тот отдаёт плоский фрагмент для чата,
 * где нет ни заголовков, ни списков, ни таблиц. Здесь — полноценный документ,
 * который открывается в браузере и печатается на бумагу.
 *
 * Разбор построчный и намеренно простой: поддержано ровно то, чем пишет
 * модель (заголовки, списки, цитаты, таблицы, блоки кода, линия), без
 * вложенности. Чего не поняли — уедет обычным абзацем, а не сломает страницу.
 *
 * Особый случай — блок ```svg: модель кладёт туда готовый график, и он
 * вставляется рисунком, а не примером кода.
 */
export function markdownToHtmlPage(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];

  // Открытый список или цитата: закрываются, как только строка перестала
  // быть их продолжением.
  let list: 'ul' | 'ol' | null = null;
  let quote = false;
  let paragraph: string[] = [];

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inlineToHtml(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };
  const closeQuote = (): void => {
    if (!quote) return;
    html.push('</blockquote>');
    quote = false;
  };
  const closeAll = (): void => {
    closeParagraph();
    closeList();
    closeQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    // Блок кода: забираем до закрывающего забора целиком, ничего не разбирая.
    const fence = /^\s*```([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      closeAll();
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      // Блок ```svg — это не пример кода, а готовый рисунок: график, схема.
      // Вставляем его как есть, иначе на странице оказалась бы простыня
      // угловых скобок вместо картинки.
      const drawing = body.join('\n');
      if (language.toLowerCase() === 'svg' && /^\s*<svg[\s>]/i.test(drawing)) {
        html.push(`<figure>${drawing}</figure>`);
        continue;
      }

      const attribute = language ? ` class="language-${escapeHtml(language)}"` : '';
      html.push(`<pre><code${attribute}>${escapeHtml(drawing)}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      closeAll();
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      closeAll();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inlineToHtml(heading[2]!)}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}(?:-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/.test(line)) {
      closeAll();
      html.push('<hr>');
      continue;
    }

    // Таблица: строка со столбиками и сразу под ней разделитель. Продолжается,
    // пока идут строки с палочками, — пустая строка или обычный абзац её
    // закрывают.
    if (line.includes('|') && isTableDivider(lines[index + 1])) {
      closeAll();
      const align = tableAlign(lines[index + 1]!);
      const rows: string[][] = [splitTableRow(line)];

      index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      index -= 1; // цикл прибавит свою единицу — иначе съели бы строку после таблицы

      html.push(tableToHtml(rows, align));
      continue;
    }

    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoted) {
      closeParagraph();
      closeList();
      if (!quote) {
        html.push('<blockquote>');
        quote = true;
      }
      html.push(`<p>${inlineToHtml(quoted[1]!)}</p>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      closeQuote();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${inlineToHtml((bullet ?? numbered)![1]!)}</li>`);
      continue;
    }

    closeList();
    closeQuote();
    paragraph.push(line.trim());
  }

  closeAll();

  return [
    '<!doctype html>',
    '<html lang="ru">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    html.join('\n'),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

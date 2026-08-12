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
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, '<b>$1</b>')
    // Горизонтальная линия.
    .replace(/^\s{0,3}(?:-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/gm, '––––––––––')
    // Маркеры списка: - * + -> •  (нумерованные списки оставляем как есть).
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    // Цитаты (символ > уже экранирован в &gt;).
    .replace(/^\s{0,3}&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

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
 * Режет длинный Markdown на куски под лимит сообщения Telegram (4096 символов).
 *
 * Главная тонкость: нельзя разрывать блок кода — иначе в первом куске
 * останется незакрытая ``` и разметка поедет. Если разрез приходится
 * на середину блока, мы закрываем блок в текущем куске и заново открываем
 * его в следующем.
 */
export function splitMarkdown(markdown: string, limit = 3500): string[] {
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

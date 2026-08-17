/**
 * Команды, работающие с нейросетями: /гем и /gem.
 *
 * Точка входа намеренно одна. Раньше рядом жили /ask и /ai — выбор провайдера
 * кнопками и запрос к выбранному, — но текстовый провайдер настроен ровно один,
 * так что /ask сводился к тому же Gemini, только без слов-переключателей,
 * а /ai предлагал меню, в котором нечего выбирать.
 *
 * Что умеет /гем, задаётся первым словом запроса, и слово это пишется
 * с восклицательным знаком:
 *   /гем <вопрос>             — обычный ответ цепочкой, выбранной для раздела;
 *   /гем !контекст <задача>   — сильная цепочка;
 *   /гем !контекст md|txt|html <задача> — она же, но ответ приходит файлом;
 *   /гем !нарисуй <описание>  — картинка вместо текста;
 *   /гем !скажи <текст>       — ответ голосом;
 *   /гем !найди <что искать>  — поиск по переписке раздела;
 *   /гем !файл <что сделать>  — ответ отдельным файлом;
 *   /гем !где здесь <предмет> — рамка поверх фотографии;
 *   /гем !расшифруй (реплаем) — послушать голосовое и ответить по существу;
 *   /гем !личка (реплаем)    — переслать сообщение в личный диалог.
 *
 * Слова-переключатели существуют только по-русски. Латинские формы (!draw,
 * !say, !context, !find) убраны: две записи одного и того же приходилось
 * держать в голове и в справке, а польза от них нулевая — те же люди пишут
 * по-русски. Сама команда по-прежнему в двух видах, /гем и /gem, и слова
 * работают одинаково после обеих: /gem !нарисуй кота — совершенно законно.
 *
 * Восклицательный знак — не украшение. Без него слова-переключатели воровали
 * обычные вопросы: «/гем скажи, что такое рекурсия» уходило в озвучку вместо
 * ответа, «/гем найди ошибку в этом SQL» — в поиск по архиву переписки,
 * а «/гем нарисуй схему словами» тратило деньги на картинку. Все четыре слова
 * слишком обычны для русской речи, чтобы значить команду просто так.
 *
 * Про две формы команды Gemini
 * ----------------------------
 * Telegram считает командой только латиницу: имя вида «гем» он не принимает
 * (setMyCommands отвечает BOT_COMMAND_INVALID) и не размечает такое слово
 * как bot_command. Поэтому:
 *   • /gem — настоящая команда: видна в меню и работает в группах даже
 *     при включённом privacy mode;
 *   • /гем — ловим регулярным выражением по тексту сообщения. В личке
 *     работает всегда, в группах — только если у бота отключён privacy mode
 *     (@BotFather → /setprivacy → Disable).
 */
import { GrammyError, InputFile, type Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { findTextProvider } from '../services/registry.js';
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from '../format.js';
import { sessionKey, withChatAction } from '../utils.js';
import { collectAlbumPart, downloadAttachment, pickPhotoFileId } from '../media.js';
import { generateWithChain } from '../services/chain.js';
import { startDraw } from './draw.js';
import { listVoiceNames, parseVoiceRequest, synthesizeSpeech } from '../services/gemini-tts.js';
import { rememberMessage, searchMessages } from '../services/search-index.js';
import { BOX_COLORS, drawBoxes, findObjects } from '../services/pointing.js';
import { prepareDocument } from '../services/documents.js';
import { handleFile, sendAnswerAsFile, takeAnswerFormat, type AnswerFormat } from './file.js';
import { MAIN_CHAIN, resolveChain, THINK_CHAIN, VOICE_CHAIN, type ChainInfo } from '../models.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type Attachment,
  type BotContext,
  type ChatMessage,
  type TextProvider,
} from '../types.js';

/** id провайдера Gemini в реестре. */
const GEMINI_ID = 'gemini';

/**
 * Кириллическая форма команды: /гем, /гем@имя_бота.
 * Регистр не важен, аргументы — всё, что после первого пробела.
 */
const CYRILLIC_GEM = /^\/гем(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

/**
 * Собирает регулярку слова-переключателя: «!контекст ...», «!нарисуй ...».
 *
 * Отдельными командами это не сделано намеренно. Точка входа к нейросети одна,
 * её и надо помнить; а меню Telegram не засоряется пунктами, которые
 * отличаются друг от друга только выбором цепочки.
 *
 * Восклицательный знак обязателен, и пробел после него допускается: «!нарисуй»
 * и «! нарисуй» — одно и то же. Разделитель после слова прописан явно,
 * а не через \b: в JavaScript граница слова определяется по латинице,
 * и с кириллицей \b просто не срабатывает — «!контекст чего-то» не совпало бы
 * вообще. Заодно такая запись не ловит «!контекстный» и «!нарисуйте»,
 * где слово лишь начинается похоже.
 */
function switchWord(words: string): RegExp {
  return new RegExp(`^!\\s*(?:${words})(?:[\\s,:.—–-]+([\\s\\S]*))?$`, 'i');
}

const CONTEXT_PREFIX = switchWord('контекст');

/**
 * Второе слово-переключатель, по тому же принципу: «/гем !нарисуй ...» —
 * вместо ответа текстом бот рисует картинку.
 */
const DRAW_PREFIX = switchWord('нарисуй');

/**
 * Третье слово-переключатель: «/гем !скажи ...» — ответ голосом.
 *
 * Без текста после слова озвучивается последняя реплика бота: чаще всего
 * это и нужно — прочитал ответ, захотел послушать.
 */
const SPEAK_PREFIX = switchWord('скажи');

/**
 * Пятое слово-переключатель: «/гем !файл ...» — ответ отдельным файлом.
 * Реплаем и без запроса выгружает в файл то сообщение, на которое ответили.
 */
const FILE_PREFIX = switchWord('файл');

/**
 * Шестое слово-переключатель: «/гем !личка» реплаем — переслать сообщение
 * в личный диалог с ботом.
 *
 * Зачем: длинный файл или разбор удобнее забрать к себе, а не листать
 * в общем топике. Нейросеть тут ни при чём — пересылка целиком умение бота,
 * поэтому на просьбу «отправь мне это в личку», сказанную словами, модель
 * честно отвечает, что не может (см. NO_TOOLS_RULES в services/gemini.ts).
 *
 * Ограничение Telegram: бот не вправе написать первым. Пока человек не открыл
 * с ним личный диалог и не нажал «Запустить», API отвечает 403 — на этот
 * случай в топик уходит ссылка на бота.
 */
const DM_PREFIX = switchWord('личка|лс');

/**
 * Четвёртое слово-переключатель: «/гем !найди ...» — поиск по переписке
 * раздела. Ищет по смыслу, а не по буквам (см. src/services/search-index.ts).
 */
const SEARCH_PREFIX = switchWord('найди|найти');

/**
 * Седьмое слово-переключатель: «/гем !расшифруй» реплаем на голосовое.
 *
 * Слово нужно ровно потому, что голосовому нельзя написать подпись: у снимка
 * и файла есть caption, которым в группе и обращаются к боту, а у голосового
 * его нет. Единственный способ показать на него пальцем — ответить реплаем,
 * и в этом реплае должно быть хоть что-то. Вот это «что-то».
 *
 * Расшифровку при этом бот не печатает — см. VOICE_RULE ниже.
 */
const VOICE_PREFIX = switchWord('расшифруй|послушай');

/**
 * Та же команда, но в подписи к фотографии: «/гем что здесь написано».
 * Латинская и кириллическая формы вместе — в подписи Telegram не размечает
 * команды, так что разбираем обе одинаково, обычным текстом.
 */
const MEDIA_COMMAND = /^\/(?:гем|gem)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

/**
 * Те же слова, но без восклицательного знака. Ловим их не чтобы выполнить,
 * а чтобы подсказать: человек, привыкший к прежнему синтаксису, иначе решит,
 * что рисование сломалось. Ответ на вопрос он при этом всё равно получит.
 */
const FORGOTTEN_BANG = /^(?:нарисуй|контекст|скажи|найди|найти|расшифруй)(?:[\s,:.—–-]|$)/i;

/**
 * Добавка к инструкции для любого ответа, который идёт в чат.
 *
 * Модели склонны к обстоятельности, и без просьбы длинный разбор приезжает
 * простынёй на десяток сообщений подряд, где ни прокрутить, ни найти начало.
 * Здесь просят уложиться в одно — а кому нужен полный разбор, тот попросит
 * файлом («!контекст md ...»), там потолок в разы выше.
 */
const ONE_POST_RULE = [
  'Ответ должен уместиться в одно сообщение Telegram: не длиннее 3000 знаков.',
  'Не обрывай мысль на полуслове — лучше короче, но законченно:',
  'сначала главное, подробности только если остаётся место.',
].join(' ');

/** Что спросить у модели, если картинку прислали вообще без подписи. */
const DEFAULT_IMAGE_PROMPT = 'Что на этой картинке? Опиши кратко и по делу.';

/**
 * Правило для любого голосового: отвечать по сказанному, а расшифровку
 * держать при себе.
 *
 * Это осознанный выбор, а не экономия. Расшифровка нужна тому, кто голосовое
 * не слушал, — но в чате его уже послушали все, и стена текста поверх
 * прозвучавшего только засоряет топик. Модель слышит запись целиком, так что
 * отвечает она по смыслу, а не по пересказу; человеку остаётся собственно
 * ответ. Правило поэтому именно правило по умолчанию, а не запрет: попросят
 * расшифровку прямо («!расшифруй выпиши дословно») — модель её даст.
 */
const VOICE_RULE =
  'Тебе прислали голосовое сообщение из чата — ты слышишь запись целиком. ' +
  'По умолчанию расшифровку не приводи и сказанное не пересказывай: собеседники уже всё слышали, ' +
  'повтор им не нужен, — отвечай сразу по существу. ' +
  'Исключение одно: если расшифровку или дословную выписку попросили прямо, дай её.';

/** Что делать с голосовым, если вопроса к нему не задали. */
const VOICE_DEFAULT_TASK =
  'Ответь по существу сказанного — так же, как ответил бы на такое же сообщение текстом. ' +
  'Если это не вопрос, а просто реплика, отзовись на неё коротко и по делу.';

/** Единая обработка ошибок нейросетей: пользователю — подсказка, в лог — детали. */
async function replyWithError(ctx: BotContext, error: unknown): Promise<void> {
  if (error instanceof ProviderNotConfiguredError) {
    await ctx.reply(
      ['🔌 Нейросеть не подключена. Чтобы включить её, добавьте ключи в .env:', '', ...error.hints.map((hint) => '• ' + hint)].join(
        '\n',
      ),
    );
    return;
  }

  if (error instanceof ProviderRequestError) {
    logger.warn('Ошибка провайдера', { provider: error.provider, message: error.message });
    await ctx.reply(`⚠️ ${error.message}`);
    return;
  }

  logger.error('Непредвиденная ошибка при обращении к нейросети', {
    error: error instanceof Error ? error.message : String(error),
  });
  await ctx.reply('😔 Что-то пошло не так. Попробуйте ещё раз чуть позже.');
}

/**
 * Отправляет ответ нейросети с разметкой.
 *
 * Модель пишет обычный Markdown, а Telegram понимает свой ограниченный
 * набор тегов — конвертируем (см. src/format.ts). Если Telegram всё же
 * не принял разметку, повторяем отправку обычным текстом: пользователь
 * должен получить ответ в любом случае.
 */
async function sendMarkdown(ctx: BotContext, markdown: string): Promise<void> {
  for (const chunk of splitMarkdown(markdown)) {
    try {
      await ctx.reply(markdownToTelegramHtml(chunk), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      const isMarkupError =
        error instanceof GrammyError && /parse entities|unsupported start tag|can't find end/i.test(error.description);

      if (!isMarkupError) throw error;

      logger.warn('Telegram отклонил разметку, отправляю обычным текстом', {
        description: error.description,
      });
      await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
    }
  }
}

/**
 * Отрезает от истории последние N сообщений для отправки в модель.
 *
 * Тонкость: диалог обязан начинаться с реплики пользователя. Реплики
 * складываются парами, но при нечётном HISTORY_LIMIT окно может начаться
 * с ответа ассистента — модели семейства Gemma к такому порядку ролей
 * относятся строго и отвечают ошибкой. Лишнюю первую реплику отбрасываем.
 */
function takeHistory(history: ChatMessage[], limit: number): ChatMessage[] {
  if (limit <= 0) return [];
  const window = history.slice(-limit);
  return window[0]?.role === 'assistant' ? window.slice(1) : window;
}

/**
 * Общий сценарий «вопрос → ответ»: идём по цепочке моделей и отвечаем первым,
 * что получилось. Если ответила не первая модель, дописываем сноску — иначе
 * непонятно, почему ответ вдруг стал другого качества.
 */
interface AskOptions {
  attachments?: Attachment[];
  /**
   * Что записать в историю вместо prompt. Нужно там, где к запросу подмешан
   * служебный контекст: цитата реплики, на которую человек ответил. В историю
   * она попасть не должна — бот и так помнит собственные слова, а дубли
   * съедают и место, и внимание модели.
   */
  historyText?: string;
  /**
   * Отдать ответ файлом, а не сообщением: «/гем !контекст md ...».
   * Тогда же берётся файловый потолок ответа — он ещё выше, чем у цепочки:
   * файла просят как раз ради длинного разбора.
   */
  asFile?: AnswerFormat;
}

async function askChain(
  ctx: BotContext,
  provider: TextProvider,
  /** Цепочка целиком: из неё берутся и модели, и потолок ответа. */
  chain: ChainInfo,
  prompt: string,
  { attachments = [], historyText, asFile }: AskOptions = {},
): Promise<boolean> {
  /**
   * Всё, что идёт в чат, обязано уместиться в одно сообщение — и обычный
   * вопрос, и «!контекст», и разбор фотографии, и ответ по присланной книге.
   * Исключение ровно одно: ответ, который уезжает файлом.
   *
   * Три слоя, потому что одного мало: модель просят быть краткой, потолок
   * токенов у цепочки скромный, а на выходе всё равно режем — знаки модель
   * не считает, и обещаниям про длину верить нельзя.
   */
  const onePost = !asFile;
  try {
    // Историю передаём укороченной: длинный контекст = дороже и медленнее.
    const history = takeHistory(ctx.session.history, config.ai.historyLimit);

    // Пока модель думает, показываем «печатает…».
    const answer = await withChatAction(ctx, asFile ? 'upload_document' : 'typing', () =>
      generateWithChain(provider, chain.models, prompt, {
        history,
        attachments,
        // Потолок ответа: у цепочки свой (он упирается в минутную норму
        // её моделей), файловый ещё выше — файла просят ради длинного,
        // а для ответа в одно сообщение берётся самый скромный.
        maxOutputTokens: asFile ? config.files.answerMaxOutputTokens : chain.maxOutputTokens,
        ...(onePost ? { extraInstruction: ONE_POST_RULE } : {}),
      }),
    );

    if (config.ai.historyLimit > 0) {
      // В историю попадает только текст: картинки повторно не пересылаются,
      // иначе каждый следующий вопрос тащил бы за собой все прежние вложения.
      // Контекст при этом не теряется — что было на снимке, модель описала
      // в своём же ответе, а он в истории есть.
      ctx.session.history.push({ role: 'user', text: historyText ?? prompt }, { role: 'assistant', text: answer.text });
      // Ответы бота идут в архив поиска наравне с репликами людей: в них
      // половина полезного, что вообще было сказано в разделе. Ссылки на них
      // не будет — id сообщения станет известен только после отправки.
      const key = sessionKey(ctx);
      if (key) rememberMessage(key, { ts: Date.now(), who: 'бот', text: answer.text });
      // Держим в памяти только последние N сообщений.
      ctx.session.history = ctx.session.history.slice(-config.ai.historyLimit);
    }

    if (asFile) {
      await sendAnswerAsFile(ctx, answer.text, asFile, historyText ?? prompt);
    } else if (onePost) {
      // Просьба уложиться в сообщение — не гарантия: модель не считает знаки.
      // Режем сами, тем же делителем, что и обычную отправку, — он умеет
      // не рвать блок кода посередине. В историю при этом уходит полный
      // ответ: обрезка касается только показа.
      const [first = '', ...rest] = splitMarkdown(answer.text);
      await sendMarkdown(ctx, first);

      if (rest.length > 0) {
        await ctx.reply(
          '<i>Ответ длиннее одного сообщения и показан не целиком. ' +
            'Чтобы получить его весь — тем же вопросом, но файлом:</i>\n' +
            `<code>/гем !контекст md ${escapeHtml((historyText ?? prompt).slice(0, 100))}</code>`,
          { parse_mode: 'HTML' },
        );
      }
    } else {
      await sendMarkdown(ctx, answer.text);
    }

    if (answer.skipped.length > 0) {
      await ctx.reply(
        `<i>Отвечала запасная модель <code>${escapeHtml(answer.model)}</code>: ` +
          `${answer.skipped.length === 1 ? 'основная была недоступна' : 'предыдущие были недоступны'}.</i>`,
        { parse_mode: 'HTML' },
      );
    }

    return true;
  } catch (error) {
    await replyWithError(ctx, error);
    return false;
  }
}

/**
 * Отдаёт провайдер Gemini, если он готов работать, и сам объясняет
 * пользователю причину, если нет.
 */
async function requireGemini(ctx: BotContext): Promise<TextProvider | null> {
  const gemini = findTextProvider(GEMINI_ID);

  if (!gemini) {
    await ctx.reply('⚠️ Провайдер Gemini не зарегистрирован в боте.');
    return null;
  }
  if (!gemini.isConfigured) {
    await ctx.reply(`🔌 Gemini не подключён.\n\n• ${gemini.setupHint}`);
    return null;
  }

  return gemini;
}

/** Берёт текст запроса из аргументов команды либо из сообщения, на которое ответили. */
function extractPrompt(ctx: BotContext, args: string): string {
  return args.trim() || ctx.message?.reply_to_message?.text?.trim() || '';
}

/**
 * Обработчик /гем и /gem.
 *
 * По умолчанию работает цепочкой, выбранной для раздела командой /режим.
 * Если запрос начинается со слова «контекст» (или «context»), вместо неё берётся
 * сильная цепочка — какой бы режим в разделе ни стоял. Дневная норма у этих
 * моделей небольшая, поэтому переключение всегда явное.
 */
async function handleGemini(ctx: BotContext, rawPrompt: string): Promise<void> {
  const trimmed = rawPrompt.trim();

  /**
   * Реплай на фотографию. Картинки в этом сообщении нет — она в том, на которое
   * ответили, — поэтому обработчик снимков сюда не добирается, и выкачивать её
   * приходится отдельно.
   *
   * Ветка забирает и пустой запрос («/гем» реплаем на фото — «что тут?»),
   * и «!где» с рамками, и любой вопрос про снимок. А вот «!нарисуй», «!скажи»,
   * «!найди» и «!контекст» пропускает дальше: они про своё, и то, что рядом
   * оказалась фотография, ничего в них не меняет.
   */
  // «!личка» проверяем первой: она про доставку уже готового сообщения,
  // и что там внутри — файл, снимок или текст — совершенно неважно. Иначе
  // реплай на документ утащил бы handleDocument, а на фото — разбор снимка.
  if (DM_PREFIX.test(trimmed)) {
    await handleSendToDm(ctx);
    return;
  }

  /**
   * Реплай на голосовое: «/гем !расшифруй» или сразу вопрос по записи —
   * «/гем что он просит сделать».
   *
   * Ветка нужна по той же причине, что и ветка реплая на фотографию: самой
   * записи в этом сообщении нет, она в том, на которое ответили, и обработчик
   * голосовых сюда не добирается. Прочие слова-переключатели пропускаем
   * дальше: «!скажи» или «!найди» рядом с голосовым — всё равно про своё.
   */
  const repliedVoice = ctx.message?.reply_to_message?.voice;
  const voiceWord = VOICE_PREFIX.exec(trimmed);
  const ownsVoice =
    repliedVoice &&
    !DRAW_PREFIX.test(trimmed) &&
    !FILE_PREFIX.test(trimmed) &&
    !SPEAK_PREFIX.test(trimmed) &&
    !SEARCH_PREFIX.test(trimmed) &&
    !CONTEXT_PREFIX.test(trimmed);

  if (repliedVoice && ownsVoice) {
    // «!расшифруй выпиши дословно» — слово съедаем, остаток остаётся вопросом.
    await handleVoice(ctx, repliedVoice, voiceWord ? (voiceWord[1] ?? '').trim() : trimmed);
    return;
  }

  const repliedDocument = ctx.message?.reply_to_message?.document;
  if (repliedDocument && !FILE_PREFIX.test(trimmed)) {
    await handleDocument(ctx, repliedDocument.file_id, repliedDocument.file_name ?? 'файл', `/гем ${rawPrompt}`);
    return;
  }

  const repliedPhoto = pickPhotoFileId(ctx.message?.reply_to_message?.photo ?? []);
  const ownsPhoto =
    repliedPhoto &&
    !DRAW_PREFIX.test(trimmed) &&
    !FILE_PREFIX.test(trimmed) &&
    !SPEAK_PREFIX.test(trimmed) &&
    !SEARCH_PREFIX.test(trimmed) &&
    !CONTEXT_PREFIX.test(trimmed);

  if (repliedPhoto && ownsPhoto) {
    await handleRepliedPhoto(ctx, repliedPhoto, rawPrompt);
    return;
  }

  if (!rawPrompt) {
    await ctx.reply(
      'Напишите запрос после команды. Например:\n' +
        '<code>/гем объясни рекурсию за три предложения</code>\n\n' +
        'Слова с восклицательным знаком меняют поведение:\n' +
        '<code>/гем !контекст почему этот SQL висит</code> — модель посильнее\n' +
        '<code>/гем !нарисуй кота-космонавта</code> — картинка вместо текста\n' +
        '<code>/гем !скажи привет</code> — ответ голосом\n' +
        '<code>/гем !найди где обсуждали деплой</code> — поиск по переписке\n\n' +
        'Ещё можно ответить командой <code>/гем</code> на любое сообщение — я возьму его текст, ' +
        'а если это фотография, разберу её.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // «!расшифруй» без голосового: слушать нечего. Молча ответить текстом было бы
  // хуже всего — человек решит, что бот записи не слышит в принципе.
  if (voiceWord) {
    await ctx.reply(
      '«!расшифруй» работает по голосовому: ответьте этой командой на голосовое сообщение.\n\n' +
        'В личке команда и вовсе не нужна — пришлите голосовое, и я отвечу.',
    );
    return;
  }

  // «!где» без снимка объяснить нечем: показывать не на чем. Молча отвечать
  // текстом было бы хуже всего — человек решит, что рамки сломались.
  if (!repliedPhoto && WHERE_PREFIX.test(trimmed)) {
    await ctx.reply(
      '«!где» работает по фотографии: пришлите её с такой подписью ' +
        'либо ответьте этой командой на уже отправленный снимок.',
    );
    return;
  }

  // «нарисуй» уводит запрос в совсем другую ветку — проверяем его первым.
  const draw = DRAW_PREFIX.exec(rawPrompt.trim());
  if (draw) {
    // Уточняющие вопросы задаёт бесплатный Gemini на своей лёгкой цепочке —
    // платит бот только за саму картинку (см. src/commands/draw.ts).
    try {
      await startDraw(ctx, (draw[1] ?? '').trim());
    } catch (error) {
      await replyWithError(ctx, error);
    }
    return;
  }

  const file = FILE_PREFIX.exec(rawPrompt.trim());
  if (file) {
    await handleFile(ctx, (file[1] ?? '').trim());
    return;
  }

  const search = SEARCH_PREFIX.exec(rawPrompt.trim());
  if (search) {
    await handleSearch(ctx, (search[1] ?? '').trim());
    return;
  }

  const speak = SPEAK_PREFIX.exec(rawPrompt.trim());
  if (speak) {
    await handleSpeak(ctx, (speak[1] ?? '').trim());
    return;
  }

  const think = CONTEXT_PREFIX.exec(rawPrompt.trim());
  const asked = think ? (think[1] ?? '').trim() : rawPrompt;

  /**
   * «!контекст md ...», «!контекст txt ...», «!контекст html ...» — тот же
   * ответ, но файлом. Просят его ради длинных разборов: в чате такой ответ
   * приезжает пачкой кусков по 4096 знаков, где ни прокрутить, ни сохранить.
   *
   * Модель об этом не предупреждают: она отвечает как обычно, со всей историей
   * раздела, а упаковкой занимаемся мы (см. sendAnswerAsFile в ./file.ts).
   * Тем и отличается от «!файл», где модель пишет сразу содержимое файла
   * и никакого диалога вокруг нет.
   */
  const { format: fileFormat, rest } = think ? takeAnswerFormat(asked) : { format: undefined, rest: asked };
  const prompt = fileFormat ? rest : asked;

  if (think && !prompt) {
    await ctx.reply(
      (fileFormat ? `После «!контекст ${fileFormat}» нужна сама задача. Например:\n` : 'После «!контекст» нужна сама задача. Например:\n') +
        '<code>/гем !контекст почему этот SQL висит на большой таблице</code>\n' +
        '<code>/гем !контекст md разбор архитектуры бота</code> — ответ файлом\n\n' +
        'Форматы файла: <code>md</code>, <code>txt</code>, <code>html</code>. ' +
        'Эти модели сильнее, но их дневная норма невелика — для обычных вопросов ' +
        'хватает просто <code>/гем</code>.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const chain = think ? resolveChain(THINK_CHAIN) : resolveChain(MAIN_CHAIN);
  const answered = await askChain(ctx, gemini, chain, prompt, { asFile: fileFormat });

  // Запрос начался со слова-переключателя, но без «!». Отвечаем как на обычный
  // вопрос — человек, скорее всего, его и задавал, — но подсказываем синтаксис:
  // иначе тот, кто действительно хотел нарисовать, решит, что бот сломался.
  if (answered && FORGOTTEN_BANG.test(prompt)) {
    const word = prompt.split(/[\s,:.—–-]/)[0]!.toLowerCase();
    await ctx.reply(
      `<i>Если это была команда, а не вопрос, — она пишется с восклицательным знаком: ` +
        `<code>/гем !${escapeHtml(word)} …</code></i>`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Ссылка на сообщение в чате.
 *
 * У приватных супергрупп (а форум — всегда супергруппа) публичной ссылки нет,
 * но есть внутренняя: t.me/c/<id без префикса -100>/<id сообщения>. В личке
 * ссылаться не на что и незачем — там и так всё рядом.
 */
function messageLink(chatId: number, messageId: number | undefined): string | null {
  if (messageId === undefined || chatId >= 0) return null;
  return `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${messageId}`;
}

/** Дата находки человеческим языком: «14 августа, 16:12». */
function formatWhen(ts: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.imageQuota.timezone,
  }).format(new Date(ts));
}

/**
 * Поиск по переписке раздела: «/гем найди ...».
 *
 * Ищет по смыслу: «где мы обсуждали выкатку» находит разговор про деплой,
 * даже если слова «выкатка» там не было.
 */
async function handleSearch(ctx: BotContext, query: string): Promise<void> {
  if (!query) {
    await ctx.reply(
      'Напишите, что искать:\n<code>/гем найди где мы обсуждали деплой</code>\n\n' +
        'Я ищу по смыслу, а не по точным словам, и только по этому разделу.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (!config.search.enabled) {
    await ctx.reply('🔍 Поиск по переписке выключен (SEARCH_ENABLED=false).');
    return;
  }

  const key = sessionKey(ctx);
  if (!key) return;

  try {
    const hits = await withChatAction(ctx, 'typing', () => searchMessages(key, query));

    if (hits.length === 0) {
      await ctx.reply(
        '🔍 Ничего похожего не нашлось.\n\n' +
          '<i>Я ищу только по этому разделу и только по тому, что было сказано после ' +
          'включения поиска: задним числом переписка не индексируется.</i>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const chatId = ctx.chat?.id ?? 0;
    const lines = hits.map((hit) => {
      const link = messageLink(chatId, hit.messageId);
      const when = formatWhen(hit.ts);
      const snippet = escapeHtml(hit.text.slice(0, 300)) + (hit.text.length > 300 ? '…' : '');
      const head = link ? `<a href="${link}">${when}</a>` : when;

      return `${head}, ${escapeHtml(hit.who)}:\n${snippet}`;
    });

    await ctx.reply(`🔍 <b>Нашёл по смыслу:</b>\n\n${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Обрезает текст до разумной длины по границе предложения.
 *
 * Резать на полуслове неприятно на слух: голос обрывается посреди фразы,
 * и непонятно, кончилась мысль или сломался бот.
 */
function trimForSpeech(text: string, limit: number): { text: string; trimmed: boolean } {
  if (text.length <= limit) return { text, trimmed: false };

  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));

  return { text: lastStop > limit / 3 ? cut.slice(0, lastStop + 1) : cut, trimmed: true };
}

/**
 * «/гем !личка» реплаем — копия сообщения уезжает в личный диалог с ботом.
 *
 * Копируем, а не пересылаем: forward тащит за собой шапку «переслано из…»
 * и ссылку на закрытую группу, которая у получателя всё равно не откроется.
 * copyMessage делает самостоятельную копию — с файлом, подписью и разметкой,
 * но без хвоста. Файл при этом не перезаливается: Telegram копирует его
 * у себя, поэтому даже тяжёлый документ уходит мгновенно.
 */
async function handleSendToDm(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const chat = ctx.chat;
  const target = ctx.message?.reply_to_message;

  if (!userId || !chat) return;

  if (chat.type === 'private') {
    await ctx.reply('Мы и так в личном диалоге — пересылать некуда.');
    return;
  }

  if (!target) {
    await ctx.reply(
      'Ответьте <code>/гем !личка</code> на сообщение, которое нужно забрать себе — ' +
        'файл, снимок или обычный текст.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  try {
    await ctx.api.copyMessage(userId, chat.id, target.message_id);
    await ctx.reply('📨 Отправил вам в личные сообщения.');
    logger.info('Сообщение скопировано в личку', { userId, from: chat.id, message: target.message_id });
  } catch (error) {
    // 403 — единственная осмысленная ошибка здесь: человек не открывал
    // с ботом личный диалог, а первым бот написать не может.
    if (error instanceof GrammyError && error.error_code === 403) {
      const link = ctx.me?.username ? `https://t.me/${ctx.me.username}` : 'диалог с ботом';
      await ctx.reply(
        `Сначала откройте со мной личный диалог и нажмите «Запустить»: ${link}\n` +
          'После этого повторите — перешлю.',
        { link_preview_options: { is_disabled: true } },
      );
      return;
    }

    logger.warn('Не удалось скопировать сообщение в личку', {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.reply('⚠️ Не получилось переслать. Попробуйте ещё раз или сохраните файл прямо отсюда.');
  }
}

/**
 * Озвучка: «/гем скажи ...».
 *
 * Без текста берётся последний ответ бота из истории раздела — обычно
 * человек как раз его и хочет послушать, а переписывать его руками глупо.
 */
/**
 * Заказ голоса перед текстом: «/гем !скажи «низкий» привет, коллеги».
 *
 * Кавычки обязательны, и это не придирка. Без них не отличить голос от речи:
 * «!скажи низкий поклон всем» — это просьба прочитать фразу про поклон,
 * а не прочитать «поклон всем» низким голосом. Кавычки годятся любые,
 * какие поставит клавиатура: «ёлочки», "прямые", 'одинарные'.
 */
const VOICE_SPEC = /^\s*[«"'“]([^«»"'”]{1,60})[»"'”]\s*([\s\S]*)$/;

async function handleSpeak(ctx: BotContext, request: string): Promise<void> {
  // Голос и манера, если их заказали кавычками в начале.
  const spec = VOICE_SPEC.exec(request);
  const voiceRequest = spec ? parseVoiceRequest(spec[1] ?? '') : {};
  const asked = spec ? (spec[2] ?? '').trim() : request;

  // Что озвучивать, по убыванию определённости:
  //   1. текст после «!скажи» — сказано прямо, спорить не о чем;
  //   2. сообщение, на которое ответили реплаем, — показано пальцем.
  //      Причём любое, не только своё: попросить озвучить чужую реплику
  //      так же естественно, как свою;
  //   3. последний ответ бота в разделе — «прочитай, что ты там написал».
  const replyTo = ctx.message?.reply_to_message;
  const quoted = (replyTo?.text ?? replyTo?.caption ?? '').trim();
  const lastAnswer = [...ctx.session.history].reverse().find((message) => message.role === 'assistant')?.text;
  const source = asked || quoted || lastAnswer || '';

  if (!source) {
    await ctx.reply(
      'Напишите, что произнести:\n<code>/гем !скажи привет, коллеги</code>\n\n' +
        'Голос и манеру можно заказать кавычками перед текстом:\n' +
        '<code>/гем !скажи «низкий» привет, коллеги</code>\n' +
        '<code>/гем !скажи «как в Warcraft 3» работа не ждёт</code>\n\n' +
        `Готовые голоса: ${listVoiceNames().join(', ')}. ` +
        'Всё остальное в кавычках — это манера, и просить можно что угодно: ' +
        'шёпотом, устало, торжественно.\n\n' +
        'Или ответьте этой командой на сообщение — озвучу его. Без того и другого ' +
        'я читаю свой последний ответ, но в этом разделе я ещё ничего не отвечал.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Разметка Markdown на слух превращается в мусор: «звёздочка жирный звёздочка».
  const plain = source.replace(/[*_`#>]/g, '').replace(/\[([^\]]+)]\([^)]+\)/g, '$1');
  const { text, trimmed } = trimForSpeech(plain.trim(), config.tts.maxChars);

  try {
    const speech = await withChatAction(ctx, 'record_voice', () => synthesizeSpeech(text, voiceRequest));

    const notes = [
      spec ? `голос: ${spec[1]}` : '',
      speech.skipped.length > 0 ? 'озвучивала запасная модель' : '',
      trimmed ? `прочитано ${text.length} знаков из ${plain.length}` : '',
    ].filter(Boolean);
    const caption = notes.length > 0 ? `🔊 ${notes.join(', ')}` : undefined;

    // Настоящее голосовое Telegram принимает только в OGG/Opus. Без ffmpeg
    // отдаём WAV обычным аудиофайлом — играется так же, выглядит иначе.
    if (speech.isVoice) {
      await ctx.replyWithVoice(new InputFile(speech.data, 'speech.ogg'), caption ? { caption } : {});
    } else {
      await ctx.replyWithAudio(new InputFile(speech.data, 'speech.wav'), {
        title: 'Озвучка',
        ...(caption ? { caption } : {}),
      });
    }
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Решает, обращались ли фотографией к боту, и достаёт из подписи вопрос.
 *
 * В группе у бота отключён privacy mode (иначе не работает /гем), то есть он
 * видит вообще все картинки в чате. Отвечать на каждую нельзя — бот вклинивался
 * бы в любую беседу. Поэтому в группе нужен явный признак обращения: команда
 * в подписи либо ответ на сообщение самого бота. В личке признак не нужен.
 */
function resolveImageRequest(
  ctx: BotContext,
  caption: string,
  /**
   * Чем заменить пустую подпись. У снимка это «что на картинке?», у голосового
   * — ничего: там пустой запрос осмыслен сам по себе и означает «ответь по
   * сказанному» (см. VOICE_DEFAULT_TASK).
   */
  fallback: string = DEFAULT_IMAGE_PROMPT,
): { prompt: string } | null {
  const match = MEDIA_COMMAND.exec(caption.trim());

  // «/гем@другой_бот» в общем чате — не наше дело.
  const addressee = match?.[1];
  if (addressee && addressee.toLowerCase() !== ctx.me.username.toLowerCase()) return null;

  const repliesToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  const isPrivate = ctx.chat?.type === 'private';

  if (!isPrivate && !match && !repliesToBot) return null;

  // С командой берём остаток подписи, без команды — всю подпись целиком.
  const asked = (match ? (match[2] ?? '') : caption).trim();
  return { prompt: asked || fallback };
}

/**
 * Команда реплаем на чужую (или свою) фотографию: «/гем !где здесь клапан»,
 * «/гем что тут написано».
 *
 * Отдельная ветка нужна из-за того, как устроен Telegram: в таком сообщении
 * самой картинки нет, есть только ссылка на неё в reply_to_message. Обработчик
 * снимков ждёт фото в текущем сообщении и потому не срабатывал вовсе, а запрос
 * уходил в модель голым текстом — она честно отвечала словами про несуществующий
 * снимок. Поэтому картинку выкачиваем отсюда сами.
 */
async function handleRepliedPhoto(ctx: BotContext, fileId: string, rawPrompt: string): Promise<void> {
  const gemini = findTextProvider(GEMINI_ID);
  if (!gemini?.isConfigured) {
    await ctx.reply('🔌 Gemini не подключён — разбирать картинки некому.');
    return;
  }

  try {
    const image = await withChatAction(ctx, 'typing', () => downloadAttachment(ctx, fileId));

    const where = WHERE_PREFIX.exec(rawPrompt.trim());
    if (where && image.mimeType === 'image/jpeg') {
      await handlePointing(ctx, image, (where[1] ?? '').trim());
      return;
    }

    const prompt = rawPrompt.trim() || DEFAULT_IMAGE_PROMPT;
    await askChain(ctx, gemini, resolveChain(MAIN_CHAIN), prompt, { attachments: [image] });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Ответ реплаем на сообщение бота — продолжение разговора, а не новый запрос.
 *
 * Раньше на такую реплику бот в группе молчал, а в личке предлагал
 * «использовать команду»: формально верно, по-человечески глупо. Если человек
 * отвечает именно на реплику бота, обращение очевидно и без команды.
 *
 * Цитату подмешиваем в запрос, но не в историю. Во-первых, отвечать могут
 * на давнее сообщение, которое из истории уже вытеснено. Во-вторых, в живом
 * топике у бота десяток реплик подряд, и без цитаты непонятно, какую именно
 * имеют в виду.
 */
async function handleReplyToBot(ctx: BotContext, text: string, quoted: string): Promise<void> {
  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const prompt = quoted
    ? `Пользователь отвечает на твою реплику:\n«${quoted.slice(0, 700)}»\n\nЕго ответ: ${text}`
    : text;

  await askChain(ctx, gemini, resolveChain(MAIN_CHAIN), prompt, { historyText: text });
}

/**
 * Подпись к фотографии вида «/гем !где здесь клапан» — просьба показать,
 * а не рассказать. Уводит снимок в отдельную ветку с рамками.
 */
const WHERE_PREFIX = switchWord('где(?:\\s+(?:здесь|тут|на\\s+фото|на\\s+картинке))?');

/**
 * «Где здесь ...»: находит предметы на фотографии и обводит их рамками.
 *
 * Отдельно от обычного разбора картинки, потому что задача другая. Обычная
 * модель расскажет, что на снимке; эта — покажет, где именно, вернув
 * координаты (см. src/services/pointing.ts).
 */
async function handlePointing(ctx: BotContext, image: Attachment, query: string): Promise<void> {
  try {
    const found = await withChatAction(ctx, 'upload_photo', () => findObjects(image, query));

    if (found.length === 0) {
      await ctx.reply(`🔍 Не нашёл на фотографии: ${escapeHtml(query)}`, { parse_mode: 'HTML' });
      return;
    }

    const marked = drawBoxes(image.data, found);
    const legend = found
      .map((object, index) => `${BOX_COLORS[index % BOX_COLORS.length]!.name} — ${object.label}`)
      .join('\n');

    await ctx.replyWithPhoto(new InputFile(marked, 'found.jpg'), {
      caption: `🔍 ${query}\n\n${legend}`,
    });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/**
 * Присланный файл: книга, статья, выгрузка.
 *
 * Всегда уходит цепочкой флешей, какой бы режим ни стоял в разделе: у Gemma
 * окно 262 тысячи токенов против миллиона у них, а PDF она не принимает вовсе.
 *
 * Текст файла попадает в запрос, но не в историю — иначе одна книга занимала бы
 * контекст следующие триста сообщений. В историю уходит только строчка о том,
 * что файл был, и ответ модели: этого хватает, чтобы дальше спрашивать «а что
 * там про X» без повторной пересылки файла.
 */
async function handleDocument(ctx: BotContext, fileId: string, fileName: string, caption: string): Promise<void> {
  const request = resolveImageRequest(ctx, caption);
  if (!request) return;

  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const notice = await ctx.reply(`📄 Читаю «${fileName}»…`);

  try {
    const file = await withChatAction(ctx, 'typing', () => downloadAttachment(ctx, fileId));
    const prepared = await prepareDocument(file.data, fileName);

    // Вопрос человека или, если его нет, просьба пересказать: присылать книгу
    // молча — это обычно «прочитай и расскажи».
    const question = request.prompt === DEFAULT_IMAGE_PROMPT ? 'Перескажи, о чём этот файл, и выдели главное.' : request.prompt;

    const prompt = prepared.text
      ? `Файл «${fileName}»:\n\n${prepared.text}\n\n---\n\n${question}`
      : question;

    await ctx.api
      .editMessageText(
        notice.chat.id,
        notice.message_id,
        `📄 «${fileName}» — ${prepared.tokens.toLocaleString('ru')} токенов${prepared.note ? `, ${prepared.note}` : ''}. Думаю…`,
      )
      .catch(() => undefined);

    await askChain(ctx, gemini, resolveChain(THINK_CHAIN), prompt, {
      attachments: prepared.attachment ? [prepared.attachment] : [],
      historyText: `Прислал файл «${fileName}» (${prepared.tokens.toLocaleString('ru')} токенов). ${question}`,
    });

    await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
  } catch (error) {
    await ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

/** То немногое, что нужно от голосового: где взять файл и сколько он длится. */
interface VoiceMessage {
  file_id: string;
  duration: number;
  mime_type?: string;
}

/** Длительность записи человеческим видом: 0:42, 3:05. */
function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Голосовое сообщение: бот слушает запись и отвечает по сказанному.
 *
 * Отдельного «распознавания речи» здесь нет и не нужно. Голосовое уходит в
 * модель ровно тем же путём, что фотография, — вложением в обычный запрос
 * (см. inlineData в src/services/gemini.ts). Google берёт за звук 32 токена
 * на секунду, так что минута разговора обходится примерно в 2000 токенов:
 * дешевле, чем пара снимков, и несравнимо щедрее озвучки, у которой своя
 * отдельная норма в десяток запросов на модель в сутки.
 *
 * Цепочка своя, голосовая: в основной первой стоит Gemma, а она звука не
 * слышит (см. config.gemini.chains.voice).
 *
 * В историю раздела попадает только пометка о том, что голосовое было, и
 * ответ бота. Само сказанное там не сохраняется — как и содержимое снимков.
 * На продолжение разговора этого хватает: о чём шла речь, видно из ответа.
 */
async function handleVoice(ctx: BotContext, voice: VoiceMessage, question: string): Promise<void> {
  const gemini = await requireGemini(ctx);
  if (!gemini) return;

  const length = formatDuration(voice.duration ?? 0);

  try {
    // mime_type у голосовых Telegram присылает сам — обычно audio/ogg.
    const audio = await withChatAction(ctx, 'typing', () =>
      downloadAttachment(ctx, voice.file_id, voice.mime_type ?? 'audio/ogg'),
    );

    logger.info('Разбираю голосовое', {
      length,
      kb: Math.round(audio.data.length / 1024),
      asked: question || '(без вопроса)',
    });

    await askChain(ctx, gemini, resolveChain(VOICE_CHAIN), `${VOICE_RULE}\n\n${question || VOICE_DEFAULT_TASK}`, {
      attachments: [audio],
      historyText: `Прислал голосовое (${length}).${question ? ` ${question}` : ''}`,
    });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

/** Скачивает картинки и отправляет их в модель вместе с вопросом. */
async function handlePhotos(ctx: BotContext, fileIds: string[], caption: string): Promise<void> {
  const request = resolveImageRequest(ctx, caption);
  if (!request) return;

  const gemini = findTextProvider(GEMINI_ID);
  if (!gemini?.isConfigured) {
    await ctx.reply('🔌 Gemini не подключён — разбирать картинки некому.');
    return;
  }

  try {
    const attachments = await withChatAction(ctx, 'typing', () =>
      Promise.all(fileIds.map((fileId) => downloadAttachment(ctx, fileId))),
    );

    // «где здесь ...» — просьба показать, а не рассказать. Рамки рисуются
    // по первому снимку: обводить каждый кадр альбома человек не просил.
    const where = WHERE_PREFIX.exec(request.prompt.trim());
    const first = attachments[0];
    if (where && first && first.mimeType === 'image/jpeg') {
      await handlePointing(ctx, first, (where[1] ?? '').trim());
      return;
    }

    await askChain(ctx, gemini, resolveChain(MAIN_CHAIN), request.prompt, { attachments });
  } catch (error) {
    await replyWithError(ctx, error);
  }
}

export function registerAiCommands(bot: Bot<BotContext>): void {
  // ------------------------------------------------------- /gem и /гем
  bot.command('gem', async (ctx, next) => {
    // Команда в подписи к фотографии — не наше дело: снимок разбирает
    // обработчик ниже, он умеет и рамки, и склейку альбомов. Пропускаем
    // ход, иначе подпись «/гем !где каша» отвечала бы текстом.
    if (ctx.message?.photo) return next();

    // То же и с подписью к голосовому. Написать её позволяет не всякий клиент,
    // но если написали — запись должен разобрать обработчик голосовых, иначе
    // бот ответит на подпись текстом, будто никакого голосового и не было.
    if (ctx.message?.voice) return next();

    await handleGemini(ctx, extractPrompt(ctx, ctx.match));
  });

  bot.hears(CYRILLIC_GEM, async (ctx, next) => {
    // ctx.match для регулярки — результат exec; для строкового триггера это string.
    const match = typeof ctx.match === 'string' ? null : ctx.match;
    const addressee = match?.[1];

    // В группе может быть несколько ботов: /гем@другой_бот — не наше дело.
    if (addressee && addressee.toLowerCase() !== ctx.me.username.toLowerCase()) return;

    // hears в grammY срабатывает и на подпись к фотографии — отдаём её
    // обработчику снимков по той же причине, что и латинскую форму команды.
    if (ctx.message?.photo) return next();
    if (ctx.message?.voice) return next();

    await handleGemini(ctx, extractPrompt(ctx, match?.[2] ?? ''));
  });

  // ------------------------------------------------------------ картинки
  // Альбом Telegram присылает несколькими апдейтами с общим media_group_id:
  // копим их и отправляем в модель одним запросом, иначе на альбом из пяти
  // снимков прилетело бы пять отдельных ответов.
  bot.on('message:photo', async (ctx) => {
    const fileId = pickPhotoFileId(ctx.message.photo);
    if (!fileId) return;

    const caption = ctx.message.caption ?? '';
    const albumId = ctx.message.media_group_id;

    if (albumId) {
      collectAlbumPart(ctx, albumId, fileId, caption, handlePhotos);
      return;
    }

    await handlePhotos(ctx, [fileId], caption);
  });

  // ------------------------------------------------------------- файлы
  // Книги, статьи, выгрузки. Правила обращения те же, что у картинок:
  // в личке достаточно файла, в группе нужна подпись с командой.
  bot.on('message:document', async (ctx) => {
    const document = ctx.message.document;
    await handleDocument(ctx, document.file_id, document.file_name ?? 'файл', ctx.message.caption ?? '');
  });

  // ---------------------------------------------------------- голосовые
  // Правила обращения общие для всех вложений (см. resolveImageRequest):
  // в личке достаточно самого голосового, в группе — либо подпись с командой
  // (её позволяют не все клиенты), либо голосовое реплаем на реплику бота.
  // Показать боту чужое голосовое в группе можно только реплаем с «/гем» —
  // эту ветку разбирает handleGemini.
  bot.on('message:voice', async (ctx) => {
    const request = resolveImageRequest(ctx, ctx.message.caption ?? '', '');
    if (!request) return;

    await handleVoice(ctx, ctx.message.voice, request.prompt);
  });

  // --------------------------------------------------- обычные сообщения
  // Регистрируется последним: сюда попадает всё, что не разобрали
  // предыдущие обработчики.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const replyTo = ctx.message.reply_to_message;

    // Ответ реплаем на реплику бота — продолжение разговора. Команда здесь
    // не нужна: обращение и так очевидно, причём и в группе тоже. Это
    // единственный случай, когда бот отвечает в группе на обычный текст.
    if (replyTo?.from?.id === ctx.me.id && text && !text.startsWith('/')) {
      await handleReplyToBot(ctx, text, (replyTo.text ?? replyTo.caption ?? '').trim());
      return;
    }

    // В остальном в группах бот молчит на обычные сообщения: обращаться
    // к нему нужно командой. Иначе он вклинивался бы в каждую беседу.
    if (ctx.chat.type !== 'private') return;

    if (text.startsWith('/')) {
      await ctx.reply('🤔 Не знаю такую команду. Список всех команд — /help');
      return;
    }

    // Свободный текст запросом не считается — это осознанное решение,
    // чтобы случайные сообщения не тратили квоту нейросети.
    await ctx.reply('Чтобы спросить нейросеть, используйте команду. Например:\n/гем ' + text.slice(0, 100));
  });
}

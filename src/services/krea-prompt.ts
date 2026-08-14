/**
 * Подготовка запроса к Krea 2: наводящие вопросы и сборка промпта.
 *
 * Зачем это вообще. Картинка стоит $0,015 и нормирована — две в день
 * на человека. Значит, попасть надо с первого раза, а «нарисуй кота»
 * с первого раза не попадает. Уточнения ведёт бесплатная Gemma, так что
 * разговор не стоит ничего, а тратится только согласованный результат.
 *
 * Что известно про эту модель (krea.ai/docs, руководства fal.ai и самой Krea):
 *
 *  • она понимает описание сцены живым языком, а не набор ключевых слов;
 *    «masterpiece, best quality, 8k» игнорируется полностью;
 *  • веса из Stable Diffusion — (слово:1.5), ((слово)), [слово] — читаются
 *    как обычный текст, то есть попадают в картинку скобками и цифрами;
 *  • порядок, который советуют все руководства: субъект → окружение →
 *    композиция и кадр → свет → стиль и материал;
 *  • Turbo (наша модель) любит короткие промпты с явным указанием стиля,
 *    палитры и композиции — «длиннее» ей не помогает;
 *  • у модели есть собственное расширение промпта (creativity), поэтому
 *    согласованный текст надо отправлять с creativity=raw, иначе она
 *    допишет своё поверх договорённостей.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generateWithChain } from './chain.js';
import type { DrawQuestion, TextProvider } from '../types.js';

/** Результат обдумывания запроса: чего не хватает и что рисовать. */
export interface DrawPlan {
  /** Промпт для Krea, по-английски. */
  prompt: string;
  /** Тот же замысел одной строкой по-русски — его показываем человеку. */
  summary: string;
  /** Вопросы, если запрос слишком общий. Пусто — спрашивать нечего. */
  questions: DrawQuestion[];
}

/**
 * Синтаксис весов из Stable Diffusion. Krea читает его как текст, поэтому
 * скобки убираем, а слово внутри оставляем — человек не зря его написал.
 */
const SD_WEIGHTS = /[([]{1,3}\s*([^()[\]:]+?)\s*(?::\s*[\d.]+\s*)?[)\]]{1,3}/g;

/** Слова-заклинания из мира Stable Diffusion, на которые Krea не реагирует. */
const NOISE_WORDS =
  /\b(masterpiece|best quality|high quality|ultra[- ]?detailed|highly detailed|8k|4k uhd|hyperrealistic|award[- ]winning|trending on artstation|шедевр|лучшее качество|высокая детализация)\b/gi;

/** Убирает из запроса то, что эта модель всё равно не понимает. */
export function stripStableDiffusionSyntax(text: string): { cleaned: string; removed: boolean } {
  const cleaned = text
    .replace(SD_WEIGHTS, '$1')
    .replace(NOISE_WORDS, '')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');

  return { cleaned: cleaned || text.trim(), removed: cleaned !== text.trim() };
}

/** Общая часть инструкции: как эта модель хочет, чтобы к ней обращались. */
const KREA_RULES = [
  'Krea 2 Turbo понимает живое описание сцены, а не список ключевых слов.',
  'Хороший промпт идёт по порядку: субъект → окружение → композиция и кадр → свет → стиль и материал.',
  'Конкретные существительные работают лучше общих прилагательных.',
  'Слова вроде masterpiece, best quality, 8k, ultra detailed модель игнорирует — не используй их.',
  'Скобки и веса — (слово:1.5), ((слово)), [слово] — модель читает как обычный текст. Не используй их.',
  'Промпт должен быть коротким: одно-два предложения, не длиннее 60 слов.',
].join('\n');

/** Достаёт JSON из ответа модели: она любит завернуть его в ```json … ```. */
function parseJsonAnswer(text: string): unknown {
  // Заборы из обратных кавычек убираем везде, а не только по краям:
  // модель иногда дописывает пояснение и до объекта, и после него.
  const withoutFence = text.replace(/```(?:json)?/gi, ' ').trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('в ответе нет JSON-объекта');

  const candidate = withoutFence.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    // Две болячки, на которых спотыкаются небольшие модели: запятая перед
    // закрывающей скобкой и «умные» кавычки вместо обычных.
    const repaired = candidate.replace(/,(\s*[}\]])/g, '$1').replace(/[«»„“”]/g, '"');
    return JSON.parse(repaired);
  }
}

/**
 * Укорачивает подпись кнопки по границе слова.
 *
 * Резать по символам нельзя: «Крупный план, неоновый с» — это не вариант
 * ответа, а обрывок. Лучше потерять последнее слово целиком.
 */
function shorten(text: string, limit = 40): string {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, '') + '…';
}

/** Приводит вопросы из ответа модели к нашему виду, отбрасывая мусор. */
function normalizeQuestions(raw: unknown): DrawQuestion[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .slice(0, config.draw.maxQuestions)
    .map((item) => {
      const question = item as { text?: unknown; options?: unknown };
      const text = typeof question.text === 'string' ? question.text.trim() : '';
      const options = Array.isArray(question.options)
        ? question.options
            .filter((option): option is string => typeof option === 'string')
            .map((option) => shorten(option.trim()))
            .filter(Boolean)
            .slice(0, 4)
        : [];

      return { text, options };
    })
    .filter((question) => question.text.length > 0 && question.options.length >= 2);
}

/**
 * Первый заход: смотрит на запрос человека и решает, чего не хватает.
 *
 * Возвращает и вопросы, и черновик промпта сразу — вопросы могут оказаться
 * лишними (человек написал развёрнуто), и тогда мы просто покажем черновик,
 * не потратив ни лишнего вызова, ни времени человека.
 */
export async function planDrawing(provider: TextProvider, models: string[], request: string): Promise<DrawPlan> {
  const instruction = [
    'Ты помогаешь собрать запрос к модели генерации изображений Krea 2 Turbo.',
    '',
    KREA_RULES,
    '',
    'Тебе дадут замысел картинки словами пользователя. Сделай две вещи.',
    '',
    `1. Реши, чего не хватает, чтобы нарисовать именно задуманное. Задай не больше ${config.draw.maxQuestions} вопросов`,
    '   и только о крупном: стиль или медиум, место действия, кадр и композиция, свет и палитра.',
    '   Строгое правило: спрашивай ТОЛЬКО о том, чего в замысле нет. Если стиль, место и кадр',
    '   уже названы — верни "questions": [], даже если тебе любопытны детали. Мелочи вроде выражения',
    '   лица, породы или времени суток не спрашивай никогда: их сама модель дорисует не хуже.',
    '   К каждому вопросу дай 3-4 коротких варианта ответа (до 24 символов), они станут кнопками.',
    '   Вопросы и варианты — по-русски.',
    '',
    '2. Собери черновой промпт по замыслу как есть, не дожидаясь ответов.',
    '',
    'Ответь строго одним JSON-объектом без пояснений:',
    '{"questions":[{"text":"вопрос","options":["вариант","вариант","вариант"]}],',
    ' "prompt":"промпт для модели, по-английски",',
    ' "summary":"одна строка по-русски: что будет на картинке"}',
  ].join('\n');

  return askForPlan(provider, models, instruction, `Замысел пользователя: ${request}`, request);
}

/**
 * Второй заход: собирает окончательный промпт с учётом ответов на вопросы
 * и правок, если человек их прислал.
 */
export async function composeDrawing(
  provider: TextProvider,
  models: string[],
  request: string,
  answers: string[],
  edit?: string,
): Promise<DrawPlan> {
  const instruction = [
    'Ты собираешь окончательный запрос к модели генерации изображений Krea 2 Turbo.',
    '',
    KREA_RULES,
    '',
    'Учти все уточнения пользователя. Ничего не выдумывай сверх сказанного:',
    'дорисовывать за автора будет сама модель, твоя задача — точно передать замысел.',
    '',
    'Ответь строго одним JSON-объектом без пояснений:',
    '{"prompt":"промпт для модели, по-английски",',
    ' "summary":"одна строка по-русски: что будет на картинке"}',
  ].join('\n');

  const parts = [`Замысел: ${request}`];
  if (answers.length > 0) parts.push(`Уточнения: ${answers.join('; ')}`);
  if (edit) parts.push(`Правка, она важнее прежних уточнений: ${edit}`);

  return askForPlan(provider, models, instruction, parts.join('\n'), request);
}

/**
 * Спрашивает модель и разбирает JSON, давая ей второй шанс.
 *
 * Небольшие модели изредка возвращают почти-JSON: лишняя запятая, кавычки
 * ёлочкой, пояснение вокруг объекта. Первое лечится починкой в parseJsonAnswer,
 * остальное — простым «попробуй ещё раз»: это бесплатно и занимает секунду.
 * Если и второй раз мимо, рисуем по исходному запросу, а не показываем ошибку.
 */
async function askForPlan(
  provider: TextProvider,
  models: string[],
  instruction: string,
  request: string,
  fallback: string,
): Promise<DrawPlan> {
  for (const attempt of [1, 2]) {
    const answer = await generateWithChain(provider, models, request, {
      systemPrompt: attempt === 1 ? instruction : `${instruction}\n\nВАЖНО: ответ должен быть ровно одним JSON-объектом.`,
      temperature: 0.4,
    });

    const plan = toPlan(answer.text, fallback);
    if (plan) return plan;

    logger.warn('Помощник вернул не JSON, пробую ещё раз', { attempt });
  }

  return { prompt: fallback, summary: fallback, questions: [] };
}

/** Разбирает ответ модели. null — разобрать не вышло, стоит попробовать снова. */
function toPlan(text: string, fallback: string): DrawPlan | null {
  try {
    const parsed = parseJsonAnswer(text) as { prompt?: unknown; summary?: unknown; questions?: unknown };
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';

    return {
      // Чистим и то, что сочинила модель-помощник: она сама любит дописать
      // в промпт «8k resolution» и «highly detailed» — Krea их игнорирует.
      prompt: prompt ? stripStableDiffusionSyntax(prompt).cleaned : fallback,
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback,
      questions: normalizeQuestions(parsed.questions),
    };
  } catch (error) {
    logger.debug('Ответ помощника не разобрался как JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

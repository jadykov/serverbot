/**
 * Сборка запроса к Ace-Step: стиль музыки и слова песни.
 *
 * Зачем этот шаг. Модель ждёт не «сделай песню про дедлайны», а две разные
 * вещи: style_prompt — теги про музыку по-английски, и lyrics — собственно
 * слова с разметкой структуры ([verse], [chorus]). Написать это руками
 * каждый раз никто не станет, а без слов Ace-Step отдаёт инструментал.
 * Поэтому черновик собирает бесплатный Gemini на лёгкой цепочке — той же,
 * что готовит запросы к рисованию: задача формальная, и тяжёлая модель
 * тратит на неё двадцать секунд, ничего не выигрывая.
 *
 * Что известно про эту модель (карточка ace-step/ACE-Step и её примеры):
 *
 *  • style_prompt читается как набор тегов через запятую, а не как рассказ:
 *    жанр, настроение, инструменты, тип голоса, темп. Длинное описание
 *    сценой она размывает;
 *  • структура песни задаётся тегами в самих словах: [verse], [chorus],
 *    [bridge]. «[inst]» вместо слов означает инструментал без вокала;
 *  • язык слов модель определяет по самим словам, отдельного поля нет —
 *    поэтому русский текст так и пишется по-русски;
 *  • длительность — параметр запроса, а не просьба в промпте, и она же
 *    цена: платится секунда готового звука;
 *  • а вот длина вступления и концовки полем не задаётся никак — только
 *    словами и тегами (см. EDGE_SECONDS ниже).
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generateWithChain } from './chain.js';
import type { TextProvider } from '../types.js';

/** Что именно закажем у Ace-Step. */
export interface SongPlan {
  /** Теги про музыку, по-английски. */
  stylePrompt: string;
  /** Слова с разметкой структуры или «[inst]» для инструментала. */
  lyrics: string;
  /** Название трека по-русски — для подписи и имени файла. */
  title: string;
  /** Длительность в секундах: названная человеком или из настроек. */
  duration: number;
}

/** Инструментал — то же самое слово, которым его обозначает сама модель. */
const INSTRUMENTAL = '[inst]';

/**
 * Сколько секунд отдаём вступлению и концовке — каждой.
 *
 * Ace-Step любит начать с проигрыша и закончить долгим затуханием, и на
 * сорокасекундном треке эти края съедали до трети песни. Прямого поля
 * «длина вступления» у модели нет, поэтому просим двумя путями сразу:
 * словами в инструкции помощнику (петь с четвёртой-пятой секунды, после
 * последних слов не тянуть) и тегами в style_prompt, которые модель читает
 * буквально, — short intro, quick vocal entry, short outro.
 *
 * Отсюда же считается, сколько строк заказывать: поётся не вся длительность,
 * а середина, и строки надо мерить по ней, иначе текст не влезет и песня
 * оборвётся на полуслове.
 */
const EDGE_SECONDS = 5;

/** Сколько коротких строк поместится в трек: примерно строка на четыре секунды. */
function lineCount(duration: number): number {
  return Math.max(2, Math.round((duration - 2 * EDGE_SECONDS) / 4));
}

/** Достаёт JSON из ответа модели: она любит завернуть его в ```json … ```. */
function parseJsonAnswer(text: string): unknown {
  const withoutFence = text.replace(/```(?:json)?/gi, ' ').trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('в ответе нет JSON-объекта');

  const candidate = withoutFence.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    // Те же две болячки, что и у помощника по картинкам: лишняя запятая
    // перед закрывающей скобкой и «умные» кавычки вместо обычных.
    return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1').replace(/[«»„“”]/g, '"'));
  }
}

/**
 * Собирает инструкцию.
 *
 * Про длительность модель-помощник знает три вещи: сколько секунд по
 * умолчанию, сколько из них уходит на края (см. EDGE_SECONDS) и сколько
 * слов влезает в остаток. Последнее важнее, чем кажется: на минуту нужно
 * строк двенадцать-шестнадцать, а присланная простыня либо спевается
 * скороговоркой, либо обрывается на середине.
 */
function instruction(): string {
  const { duration, minDuration, maxDuration } = config.goapi.music;

  return [
    'Ты готовишь запрос к модели генерации музыки Ace-Step по замыслу пользователя.',
    '',
    'Модели нужны две разные вещи, и путать их нельзя:',
    '• style_prompt — музыка, набором тегов через запятую и ТОЛЬКО по-английски:',
    '  жанр, настроение, инструменты, тип голоса (female vocal, male vocal, choir),',
    '  темп. От 5 до 12 тегов, без предложений и без пересказа сюжета песни.',
    '  Последними обязательно добавь теги про края: short intro, quick vocal entry, short outro',
    '  (для инструментала — short intro, short outro: вокала там нет).',
    '• lyrics — слова песни с разметкой структуры: [verse], [chorus], [bridge].',
    '  Язык слов — язык замысла пользователя: русский замысел — русские слова.',
    '  Пиши настоящий текст, а не описание того, о чём он будет.',
    '',
    'Трек короткий, и проигрыш в нём — выброшенные секунды. Поэтому:',
    `• вступление не длиннее ${EDGE_SECONDS} секунд — первые слова должны зазвучать сразу.`,
    '  Начинай lyrics прямо с [verse]: отдельный [intro] не пиши вовсе.',
    `• концовка не длиннее ${EDGE_SECONDS} секунд после последних слов: длинного [outro] не пиши,`,
    '  песня заканчивается на словах, а не на минутном затухании.',
    '• на коротком треке (меньше 20 секунд) края ещё короче — секунда-две с каждой стороны.',
    '',
    `Длительность: ${duration} секунд по умолчанию. Если человек назвал своё время`,
    `(«полминуты», «секунд десять»), верни его в секундах, от ${minDuration} до ${maxDuration}.`,
    `Больше ${maxDuration} не проси: столько всё равно не закажут.`,
    '',
    'Соразмеряй слова с выбранной длительностью, помня про края: поётся не вся',
    'длительность, а середина. Примерно одна короткая строка на четыре секунды,',
    `то есть для ${duration} секунд — около ${lineCount(duration)} строк.`,
    `Взял другую длительность — пересчитай так же: секунды минус ${2 * EDGE_SECONDS} на края, остаток делить на четыре.`,
    'Лишнее не влезет: модель либо зачитает скороговоркой, либо оборвёт песню на середине.',
    '',
    `Если человек просит музыку без вокала (инструментал, минус, фон), верни lyrics ровно «${INSTRUMENTAL}».`,
    'Во всех остальных случаях песня со словами — это то, зачем команду и позвали.',
    '',
    'Ответь строго одним JSON-объектом без пояснений:',
    '{"style_prompt":"теги по-английски",',
    ' "lyrics":"[verse]\\nстрока\\nстрока\\n[chorus]\\nстрока",',
    ' "title":"короткое название по-русски",',
    ' "duration":секунды}',
  ].join('\n');
}

/** Приводит ответ модели к нашему виду. null — разобрать не вышло. */
function toPlan(text: string): SongPlan | null {
  try {
    const parsed = parseJsonAnswer(text) as {
      style_prompt?: unknown;
      lyrics?: unknown;
      title?: unknown;
      duration?: unknown;
    };

    const stylePrompt = typeof parsed.style_prompt === 'string' ? parsed.style_prompt.trim() : '';
    const lyrics = typeof parsed.lyrics === 'string' ? parsed.lyrics.trim() : '';

    // Стиль — единственное обязательное поле запроса: без него заказывать нечего.
    if (!stylePrompt) return null;

    const duration = typeof parsed.duration === 'number' ? parsed.duration : Number(parsed.duration);

    return {
      stylePrompt,
      lyrics: lyrics || INSTRUMENTAL,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '',
      duration: Number.isFinite(duration) && duration > 0 ? duration : config.goapi.music.duration,
    };
  } catch (error) {
    logger.debug('Ответ помощника по песне не разобрался как JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Просит помощника собрать песню, давая ему второй шанс.
 *
 * null означает «не вышло»: в отличие от рисования, откатиться на исходный
 * запрос здесь нельзя. Русская фраза в style_prompt даст модели не тот
 * стиль, а слов не даст вовсе — вместо песни приедет инструментал за те же
 * деньги. Лучше честно не начинать: этот шаг бесплатный, а трек — нет.
 */
export async function planSong(provider: TextProvider, models: string[], request: string): Promise<SongPlan | null> {
  const system = instruction();

  for (const attempt of [1, 2]) {
    const answer = await generateWithChain(provider, models, `Замысел пользователя: ${request}`, {
      systemPrompt: attempt === 1 ? system : `${system}\n\nВАЖНО: ответ должен быть ровно одним JSON-объектом.`,
      temperature: 0.8,
    });

    const plan = toPlan(answer.text);
    if (plan) return plan;

    logger.warn('Помощник по песне вернул не JSON, пробую ещё раз', { attempt });
  }

  return null;
}

/** Инструментал ли это. Нужно и для подписи, и для лога. */
export function isInstrumental(plan: SongPlan): boolean {
  return plan.lyrics.trim().toLowerCase() === INSTRUMENTAL;
}

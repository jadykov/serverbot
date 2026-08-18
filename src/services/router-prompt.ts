/**
 * Разбор просьбы, сказанной обычными словами: «надмозг» над командами бота.
 *
 * Зачем это. Команд у бота десяток, и все они пишутся восклицательным знаком:
 * «!скажи», «!нарисуй», «!сеть», «!личка». Синтаксис ровный, но помнить его
 * должен человек, а человек помнить не обязан — он пишет «озвучь это и скинь
 * мне в личку». Раньше на такую просьбу бот отвечал текстом и подсказывал
 * синтаксис (см. FORGOTTEN_BANG в commands/ai.ts). Здесь он вместо подсказки
 * пробует понять и сделать.
 *
 * Кто разбирает. Отдельный лёгкий вызов к flash-lite: 500 запросов в сутки,
 * полторы секунды на ответ, денег не стоит. Модель не отвечает человеку —
 * она возвращает JSON с планом из одного-трёх шагов, а выполняет план сам бот
 * своими же обработчиками. То есть нейросеть здесь не «умнее» остальных, у неё
 * ровно одна работа: перевести просьбу в команды, которые и так есть.
 *
 * Три правила, без которых затея вредит больше, чем помогает.
 *
 *   1. Молчаливый провал. Не разобралась, не ответила, вернула мусор вместо
 *      JSON — человек должен получить обычный ответ на свой вопрос, а не
 *      ошибку разбора. Роутер имеет право не сработать; не имеет права
 *      сломать разговор.
 *
 *   2. Деньги только по явной просьбе. Картинка стоит $0,015, минута музыки
 *      $0,03, поиск в интернете — платный вызов. Ошибка роутера здесь
 *      не «неудобно», а «списаны деньги за то, чего не просили». Поэтому
 *      платный шаг разрешён, только когда человек назвал действие сам,
 *      и не больше одного на просьбу.
 *
 *   3. Никакой самодеятельности. Три шага — потолок, и каждый обязан
 *      отвечать словам просьбы. «Заодно перескажу», «заодно нарисую» — нет.
 *
 * Что этот файл НЕ делает. Он готовит инструкцию и разбирает ответ. Выполнение
 * плана — отдельная работа: сегодняшние обработчики односоставные, каждый сам
 * пишет в чат и ничего не возвращает вызвавшему. Чтобы «расшифруй → пришли
 * в личку → ответь в чат» заработало, нужен исполнитель, умеющий передавать
 * результат одного шага следующему и выбирать, куда его отправить. Роутер
 * к этому готов (см. поля source и target у шага), исполнителя пока нет.
 */
import { logger } from '../logger.js';
import { generateWithChain } from './chain.js';
import type { TextProvider } from '../types.js';

/** Что бот умеет делать. Ровно это множество и предлагается модели. */
export type RouteAction =
  /** Обычный ответ в чат. Он же — исход по умолчанию. */
  | 'ask'
  /** Сильная цепочка: «!контекст». Сложные разборы, код, длинные задачи. */
  | 'think'
  /** Озвучить текст голосом: «!скажи». */
  | 'speak'
  /** Расшифровать голосовое, на которое ответили реплаем: «!расшифруй». */
  | 'transcribe'
  /** Поиск по переписке раздела: «!найди». Бесплатно. */
  | 'archive'
  /** Ответ файлом: «!файл». */
  | 'file'
  /** Переслать в личный диалог: «!личка». Нейросеть не участвует. */
  | 'dm'
  /** Поиск в интернете: «!сеть». ПЛАТНО. */
  | 'web'
  /** Нарисовать картинку: «!нарисуй». ПЛАТНО. */
  | 'draw'
  /** Песня с вокалом: «!трек». ПЛАТНО. */
  | 'track';

/** Действия, за которые бот платит деньгами. Роутеру они разрешены не всегда. */
export const PAID_ACTIONS: ReadonlySet<RouteAction> = new Set<RouteAction>(['web', 'draw', 'track']);

/** Откуда шаг берёт материал. */
export type RouteSource =
  /** Из слов самой просьбы. */
  | 'request'
  /** Из сообщения, на которое ответили реплаем. */
  | 'reply'
  /** Из результата предыдущего шага плана. */
  | 'previous'
  /** Из последнего ответа бота в разделе. */
  | 'last-answer';

/** Куда уходит результат шага. */
export type RouteTarget = 'chat' | 'dm';

export interface RouteStep {
  action: RouteAction;
  /** Запрос или текст для этого шага. Пусто — шаг работает с source. */
  input: string;
  source: RouteSource;
  target: RouteTarget;
}

export interface RoutePlan {
  steps: RouteStep[];
  /**
   * Вопрос человеку вместо выполнения. Непустой — план не выполняется,
   * бот спрашивает и ждёт. Это исход, а не ошибка.
   */
  clarify: string;
  /** Насколько модель уверена, 0…1. Ниже порога план не выполняется. */
  confidence: number;
}

/** Ниже этой уверенности план не выполняем: дешевле переспросить. */
export const MIN_CONFIDENCE = 0.6;

/**
 * Обстановка вокруг просьбы. Без неё разбор гадает: «расшифруй» осмысленно
 * только при реплае на голосовое, «озвучь» без текста — только при последнем
 * ответе бота.
 */
export interface RouteContext {
  /** Ответили реплаем на сообщение. */
  hasReply: boolean;
  /** И в этом сообщении голосовое. */
  replyHasVoice: boolean;
  /** …или снимок. */
  replyHasPhoto: boolean;
  /** …или файл. */
  replyHasDocument: boolean;
  /** В разделе уже есть ответ бота — есть что озвучивать «просто так». */
  hasLastAnswer: boolean;
  /** Личка с ботом открыта. Закрыта — шаг dm бесполезен (Telegram даёт 403). */
  dmAvailable: boolean;
}

/**
 * Каталог команд для инструкции.
 *
 * Здесь он живёт единожды и отсюда попадает в промпт: справка в /help
 * и этот список расходятся при первой же правке, если писать их порознь.
 */
const CATALOGUE: ReadonlyArray<{ action: RouteAction; command: string; about: string }> = [
  { action: 'ask', command: '/гем <вопрос>', about: 'обычный ответ в чат; исход по умолчанию' },
  { action: 'think', command: '/гем !контекст <задача>', about: 'сильные модели: код, разборы, длинные задачи' },
  { action: 'speak', command: '/гем !скажи <текст>', about: 'озвучить голосом; в кавычках можно заказать голос и манеру' },
  { action: 'transcribe', command: '/гем !расшифруй', about: 'понять голосовое, на которое ответили реплаем' },
  { action: 'archive', command: '/гем !найди <запрос>', about: 'поиск по переписке этого раздела, по смыслу' },
  { action: 'file', command: '/гем !файл <задача>', about: 'ответ отдельным файлом: md, txt, html, svg, csv, json, py, sql' },
  { action: 'dm', command: '/гем !личка', about: 'переслать в личный диалог с ботом; нейросеть не участвует' },
  { action: 'web', command: '/гем !сеть <запрос>', about: 'ПЛАТНО: ответ по свежим страницам из интернета' },
  { action: 'draw', command: '/гем !нарисуй <описание>', about: 'ПЛАТНО: картинка, около $0,015' },
  { action: 'track', command: '/гем !трек <описание>', about: 'ПЛАТНО: песня с вокалом, около $0,03 за минуту' },
];

/** Правила, по которым собирается план. Самая содержательная часть промпта. */
const RULES = [
  'Отвечай ровно одним JSON-объектом. Никаких пояснений до или после, никаких ```.',
  'Шагов не больше трёх. Меньше — лучше: один шаг закрывает почти любую просьбу.',
  'Каждый шаг должен отвечать словам просьбы. Ничего «заодно» и «на всякий случай» не добавляй.',
  'Обычный вопрос — это один шаг ask. Разговор, мнение, объяснение, шутка — всё это ask.',
  'Платные действия (web, draw, track) ставь, только когда человек назвал их сам: «нарисуй», ' +
    '«спой», «поищи в интернете», «что сейчас пишут». Косвенного намёка мало. Платный шаг в плане ' +
    'допустим только один.',
  'Не путай archive и web: archive ищет по нашей переписке («где мы это обсуждали»), web — по интернету ' +
    '(«что нового», «свежие новости»). Сомневаешься между ними — бери archive, он бесплатный.',
  'transcribe осмысленен только при реплае на голосовое. Нет реплая — не ставь его вовсе.',
  'dm без реплая и без предыдущего шага бессмыслен: пересылать нечего.',
  'Если личка недоступна, target «dm» ставить нельзя — ставь «chat».',
  'Если просьба непонятна или в ней два взаимоисключающих желания — оставь steps пустым и задай ' +
    'один короткий вопрос в clarify. Переспросить дешевле, чем сделать не то.',
  'confidence — честная оценка: 1.0 у «нарисуй кота», 0.5 у просьбы, которую пришлось домысливать.',
];

/** Примеры. Они учат разбору сильнее любых правил, поэтому их много и они разные. */
const EXAMPLES = [
  {
    request: 'вытащи текст из этой голосовухи и кинь мне в личку, а в чате ответь, что думаешь о сказанном',
    context: 'реплай на голосовое, личка открыта',
    plan: {
      steps: [
        { action: 'transcribe', input: '', source: 'reply', target: 'dm' },
        { action: 'ask', input: 'что ты думаешь о сказанном в голосовом', source: 'previous', target: 'chat' },
      ],
      clarify: '',
      confidence: 0.9,
    },
  },
  {
    request: 'озвучь свой прошлый ответ мужским голосом',
    context: 'реплая нет, ответ бота в разделе есть',
    plan: {
      steps: [{ action: 'speak', input: '«мужской»', source: 'last-answer', target: 'chat' }],
      clarify: '',
      confidence: 0.95,
    },
  },
  {
    request: 'что там сейчас с курсом рубля',
    context: 'реплая нет',
    plan: {
      steps: [{ action: 'web', input: 'курс рубля сегодня', source: 'request', target: 'chat' }],
      clarify: '',
      confidence: 0.8,
    },
  },
  {
    request: 'а помнишь, мы обсуждали выкатку на сервер?',
    context: 'реплая нет',
    plan: {
      steps: [{ action: 'archive', input: 'выкатка на сервер', source: 'request', target: 'chat' }],
      clarify: '',
      confidence: 0.75,
    },
  },
  {
    request: 'сделай красиво',
    context: 'реплая нет',
    plan: {
      steps: [],
      clarify: 'Красиво — это как? Нарисовать картинку, оформить текст файлом или переписать сообщение?',
      confidence: 0.2,
    },
  },
  {
    request: 'привет, как жизнь',
    context: 'реплая нет',
    plan: {
      steps: [{ action: 'ask', input: 'привет, как жизнь', source: 'request', target: 'chat' }],
      clarify: '',
      confidence: 1,
    },
  },
];

/** Обстановку описываем словами: модель читает её так же, как просьбу. */
function describeContext(context: RouteContext): string {
  const facts = [
    context.hasReply ? 'человек ответил реплаем на сообщение' : 'реплая нет',
    context.replyHasVoice ? 'в том сообщении голосовое' : '',
    context.replyHasPhoto ? 'в том сообщении снимок' : '',
    context.replyHasDocument ? 'в том сообщении файл' : '',
    context.hasLastAnswer ? 'в разделе есть предыдущий ответ бота' : 'бот в этом разделе ещё не отвечал',
    context.dmAvailable ? 'личка с ботом открыта' : 'личка недоступна — писать туда нельзя',
  ].filter(Boolean);

  return facts.join('; ');
}

/**
 * Собирает инструкцию для разбирающей модели.
 *
 * Промпт длинный намеренно: это единственное место, где живёт знание
 * «какими словами люди просят то, что бот умеет». Короткий промпт здесь
 * экономит десяток токенов и стоит ошибочного шага за деньги.
 */
export function buildRouterPrompt(request: string, context: RouteContext): string {
  const catalogue = CATALOGUE.map(({ action, command, about }) => `  • ${action} — ${command}: ${about}`).join('\n');
  const rules = RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  const examples = EXAMPLES.map(
    (example) =>
      `Просьба: ${example.request}\nОбстановка: ${example.context}\nОтвет: ${JSON.stringify(example.plan)}`,
  ).join('\n\n');

  return [
    'Ты — разборщик просьб в телеграм-боте. Ты НЕ отвечаешь человеку и НЕ выполняешь просьбу.',
    'Твоя единственная работа — перевести сказанное обычными словами в план из команд бота.',
    '',
    'Что бот умеет:',
    catalogue,
    '',
    'Формат ответа — один JSON-объект:',
    '{"steps":[{"action":"…","input":"…","source":"request|reply|previous|last-answer",' +
      '"target":"chat|dm"}],"clarify":"","confidence":0.0}',
    '',
    'Правила:',
    rules,
    '',
    'Примеры:',
    '',
    examples,
    '',
    `Обстановка сейчас: ${describeContext(context)}.`,
    '',
    `Просьба: ${request}`,
  ].join('\n');
}

/** Достаёт JSON из ответа: модель любит завернуть его в ```json … ```. */
function parseJsonAnswer(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end === -1) throw new Error('в ответе нет JSON-объекта');

  const candidate = text.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    // Хвостовая запятая и «ёлочки» вместо кавычек — две ошибки, которые
    // модели делают чаще прочих и которые чинятся без риска исказить смысл.
    return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1').replace(/[«»„“”]/g, '"'));
  }
}

const ACTIONS = new Set<string>(CATALOGUE.map(({ action }) => action));
const SOURCES = new Set<string>(['request', 'reply', 'previous', 'last-answer']);

/**
 * Приводит ответ модели к плану, отбрасывая всё, чего не понимает.
 *
 * Разбор нарочно недоверчивый: несуществующее действие, четвёртый шаг,
 * второй платный шаг — не повод падать, повод выбросить лишнее. Пустой план
 * на выходе — законный исход, он означает «отвечай как обычно».
 */
export function toRoutePlan(raw: unknown, context: RouteContext): RoutePlan {
  const source = raw as { steps?: unknown; clarify?: unknown; confidence?: unknown };
  const clarify = typeof source.clarify === 'string' ? source.clarify.trim() : '';
  const confidence = typeof source.confidence === 'number' ? source.confidence : Number(source.confidence) || 0;

  const steps: RouteStep[] = [];
  let paidUsed = false;

  for (const item of Array.isArray(source.steps) ? source.steps : []) {
    if (steps.length >= 3) break;

    const step = item as Partial<RouteStep>;
    const action = String(step.action ?? '') as RouteAction;

    if (!ACTIONS.has(action)) {
      logger.debug('Роутер вернул неизвестное действие, пропускаю', { action });
      continue;
    }

    // Второй платный шаг — почти наверняка фантазия модели, а платит человек.
    if (PAID_ACTIONS.has(action)) {
      if (paidUsed) continue;
      paidUsed = true;
    }

    // Просьба уйти в личку, когда лички нет, кончилась бы 403 на стороне
    // Telegram. Не отменяем шаг, а разворачиваем его в чат: человеку нужен
    // результат, а не рассказ про ограничения Bot API.
    const target: RouteTarget = step.target === 'dm' && context.dmAvailable ? 'dm' : 'chat';

    steps.push({
      action,
      input: typeof step.input === 'string' ? step.input.trim() : '',
      source: SOURCES.has(String(step.source)) ? (step.source as RouteSource) : 'request',
      target,
    });
  }

  return { steps, clarify, confidence };
}

/**
 * Разбирает просьбу. Возвращает пустой план, если разобрать не вышло, —
 * и это нормальный исход, а не ошибка: значит, отвечаем как обычно.
 */
export async function routeRequest(
  provider: TextProvider,
  models: string[],
  request: string,
  context: RouteContext,
): Promise<RoutePlan> {
  const empty: RoutePlan = { steps: [], clarify: '', confidence: 0 };

  try {
    const { text } = await generateWithChain(provider, models, buildRouterPrompt(request, context), {
      // Плану хватает с запасом, а лишний потолок — лишние мысли модели.
      maxOutputTokens: 500,
    });

    const plan = toRoutePlan(parseJsonAnswer(text), context);

    if (plan.confidence < MIN_CONFIDENCE && !plan.clarify) {
      logger.debug('Роутер не уверен в плане, отвечаем обычным путём', { confidence: plan.confidence });
      return empty;
    }

    logger.info('Просьба разобрана', {
      steps: plan.steps.map((step) => step.action),
      confidence: plan.confidence,
      ...(plan.clarify ? { clarify: true } : {}),
    });

    return plan;
  } catch (error) {
    // Здесь молчим намеренно: разбор — это удобство поверх бота, и его отказ
    // человека касаться не должен. Он задал вопрос — он получит ответ.
    logger.warn('Разобрать просьбу не вышло, отвечаю обычным путём', {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

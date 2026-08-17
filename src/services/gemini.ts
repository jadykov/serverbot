/**
 * Провайдер текстовой нейросети Google Gemini.
 *
 * Документация и получение ключа: https://aistudio.google.com/apikey
 * Используется официальный SDK @google/genai (пришёл на смену устаревшему
 * @google/generative-ai).
 */
import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse, type Part, type ThinkingConfig } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { withTimeout } from '../utils.js';
import { ProviderRequestError, type TextGenerationOptions, type TextProvider } from '../types.js';

/**
 * «Размышления» (thinking) настраиваются по-разному в разных поколениях моделей:
 *   • Gemini 2.5  — thinkingConfig.thinkingBudget: число токенов (0 — выключить);
 *   • Gemini 3.x  — thinkingConfig.thinkingLevel: minimal | low | medium | high.
 *
 * Параметр «чужого» поколения приводит к ошибке 400 INVALID_ARGUMENT, поэтому
 * по умолчанию мы не отправляем thinkingConfig вообще — так запрос корректен
 * для любой модели. Включается явно через GEMINI_THINKING в .env:
 *   GEMINI_THINKING=0      → thinkingBudget: 0   (для Gemini 2.5)
 *   GEMINI_THINKING=low    → thinkingLevel: LOW  (для Gemini 3.x)
 */
const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

function buildThinkingConfig(): ThinkingConfig | undefined {
  const raw = config.gemini.thinking.trim();
  if (!raw) return undefined;

  // Число — это бюджет в токенах (формат Gemini 2.5).
  if (/^-?\d+$/.test(raw)) return { thinkingBudget: Number.parseInt(raw, 10) };

  const level = THINKING_LEVELS[raw.toLowerCase()];
  if (level) return { thinkingLevel: level };

  logger.warn(
    `GEMINI_THINKING="${raw}" не распознан и будет проигнорирован. ` +
      'Допустимые значения: число (бюджет токенов) либо minimal/low/medium/high.',
  );
  return undefined;
}

/**
 * Достаёт человекочитаемый текст из ошибки Google API:
 * SDK кладёт в message сырой JSON вида {"error":{"code":400,...}}.
 */
function extractApiError(message: string): { text: string; code?: number; status?: string } {
  const start = message.indexOf('{');
  if (start === -1) return { text: message };
  try {
    const parsed = JSON.parse(message.slice(start)) as {
      error?: { message?: string; code?: number; status?: string };
    };
    if (!parsed.error) return { text: message };
    return { text: parsed.error.message ?? message, code: parsed.error.code, status: parsed.error.status };
  } catch {
    return { text: message };
  }
}

/**
 * Достаёт из ошибки 400 предел ответа, названный самой моделью.
 *
 * Потолки ответа у моделей разные, а списка, которому можно доверять, нет:
 * поколения выходят чаще, чем обновляется документация. Зато Google в отказе
 * пишет предел прямо — «maxOutputTokens must be less than or equal to 8192».
 * Берём число оттуда: из всех чисел в сообщении предел — наименьшее, потому
 * что второе число (если оно есть) — это то, сколько мы попросили.
 *
 * Нужно это ради подстраховки: попроси мы у модели больше, чем она умеет,
 * человек получил бы ошибку вместо ответа — 400 в цепочке не перебирается.
 */
export function outputLimitFromError(message: string): number | null {
  if (!/output[_ ]?tokens/i.test(message)) return null;

  // Код ошибки выкидываем сразу: в JSON от Google рядом лежит "code": 400,
  // и без этого пределом объявлялось бы оно.
  const text = message.replace(/"?code"?\s*[:=]\s*\d+/gi, ' ');

  // Потолки ответа меньше 512 токенов не встречаются — всё, что мельче,
  // это какие-то другие числа из сообщения.
  const numbers = [...text.matchAll(/\b(\d{3,7})\b/g)].map((match) => Number(match[1])).filter((value) => value >= 512);
  if (numbers.length === 0) return null;

  return Math.min(...numbers);
}

/** Кто такой бот. Роль одна на всех: своих ролей по топикам у бота нет. */
const DEFAULT_ROLE = [
  'Ты — дружелюбный ассистент внутри Telegram-бота.',
  'Отвечай на языке пользователя, по делу и без «воды».',
].join(' ');

/**
 * Правила оформления. Дописываются к инструкции всегда, в том числе к своей
 * инструкции раздела: ответ проходит через конвертер в HTML Telegram
 * (см. src/format.ts), а таблиц и вложенных списков Telegram не умеет
 * в принципе — эти ограничения не зависят от того, кем бот назначен в топике.
 */
const MARKUP_RULES = [
  'Оформляй ответ в Markdown, но только теми средствами, которые понимает Telegram:',
  '**жирный**, *курсив*, `инлайн-код`, блоки кода в тройных обратных кавычках с указанием языка,',
  'ссылки вида [текст](https://...), цитаты через >, списки через дефис.',
  'Не используй таблицы, вложенные списки и HTML-теги.',
  'Заголовки допустимы, но не глубже ###.',
].join(' ');

/**
 * Смайлики как элемент разметки, а не как украшение.
 *
 * Мысль простая: в Telegram нет ни выносок, ни цветных плашек, ни таблиц —
 * взгляду не за что зацепиться в сплошном тексте. Несколько строго
 * закреплённых значков дают то же, что даёт вёрстка: сразу видно, где
 * предупреждение, а где вывод. Работает это, только пока значков мало
 * и каждый значит ровно одно; как только они становятся настроением,
 * читать снова приходится подряд.
 *
 * Отсюда и запреты: не в конце строки (там значок ничего не размечает,
 * а просто хихикает), не в заголовках, не по два подряд и не в коротком
 * ответе, где размечать нечего.
 */
const EMOJI_RULES = [
  'Смайлики — часть разметки, а не украшение. Разрешены ровно эти, и только в начале строки:',
  '⚠️ — предупреждение: то, что сломается, потеряется или обойдётся дорого;',
  '📌 — главный вывод или итог, если ответ длинный;',
  '✅ и ❌ — «так верно» и «так неверно», и только парой в противопоставлении;',
  '💡 — неочевидный приём, который экономит время.',
  'Строже некуда: не больше одного значка на строку, не в заголовках, не в конце строки,',
  'не подряд. Если строка не предупреждение, не вывод и не сравнение — значка нет вовсе.',
  'В коротком ответе на две-три строки смайликов не должно быть совсем.',
  'Никогда не ставь их ради настроения, приветствия или эмоций.',
].join(' ');

/**
 * Инструментов у бота нет — и модель об этом надо предупреждать явно.
 *
 * Без этой оговорки просьба «нарисуй злого человека-паука» приводила к тому,
 * что модель отвечала выдуманным вызовом чужого инструмента — куском JSON
 * вида {"action": "dalle.text2im", "action_input": …}. Это не ошибка бота
 * и не сбой сети: так выглядит подражание другим ассистентам, у которых такой
 * инструмент есть. Человек же видел в чате нечитаемый JSON вместо ответа.
 *
 * Рисование в боте живёт отдельно — командой «/гем !нарисуй», через другого
 * провайдера (см. src/commands/draw.ts). Поэтому модели остаётся сказать, что
 * рисовать она не умеет, и назвать команду, которая умеет.
 */
const NO_TOOLS_RULES = [
  'Инструментов у тебя нет: ты не умеешь рисовать картинки, искать в интернете и запускать код.',
  'Никогда не выдавай вместо ответа служебный вызов инструмента —',
  'ни {"action": ...}, ни {"tool": ...}, ни dalle, ни text2im, ни в каком другом виде.',
  'Просят нарисовать — одной строкой ответь, что рисование включается командой /гем !нарисуй,',
  'и не пытайся изобразить картинку текстом.',
  'Просят переслать сообщение или файл в личные сообщения — это тоже умеет бот, а не ты:',
  'подскажи ответить командой /гем !личка на нужное сообщение.',
].join(' ');

/**
 * Собирает системную инструкцию: роль, правила оформления и добавка на один
 * запрос, если она есть.
 *
 * Параметр custom остался от промптов раздела, которые задавались командой
 * /режим и были убраны вместе с ней. Он не мёртвый: им пользуются вызовы, где
 * роль совсем другая, — сборка файла в commands/file.ts и разбор замысла
 * в services/krea-prompt.ts. Правила оформления при этом дописываются всегда,
 * иначе такой вызов начинал бы отвечать таблицами и HTML, которых Telegram
 * не понимает.
 */
function buildSystemPrompt(custom?: string, extra?: string): string {
  return [custom?.trim() || DEFAULT_ROLE, MARKUP_RULES, EMOJI_RULES, NO_TOOLS_RULES, extra?.trim() ?? ''].join(' ').trim();
}

export class GeminiProvider implements TextProvider {
  readonly id = 'gemini';
  readonly title = 'Google Gemini';
  readonly setupHint = 'Добавьте GEMINI_API_KEY в .env (ключ бесплатно: https://aistudio.google.com/apikey)';

  /** Клиент создаём лениво: без ключа он и не нужен. */
  private client: GoogleGenAI | null = null;

  get isConfigured(): boolean {
    return config.gemini.apiKey.length > 0;
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({
        apiKey: config.gemini.apiKey,
        // Если задан GEMINI_BASE_URL — ходим через свой прокси.
        ...(config.gemini.baseUrl ? { httpOptions: { baseUrl: config.gemini.baseUrl } } : {}),
      });
      if (config.gemini.baseUrl) {
        logger.info('Gemini: запросы идут через прокси', { baseUrl: config.gemini.baseUrl });
      }
    }
    return this.client;
  }

  async generateText(prompt: string, options: TextGenerationOptions = {}): Promise<string> {
    if (!this.isConfigured) {
      throw new ProviderRequestError(this.id, this.setupHint, { kind: 'auth' });
    }

    // Текст запроса и приложенные файлы едут одним сообщением: сначала текст,
    // потом вложения. Файлы передаются прямо в теле запроса (inlineData),
    // это допустимо, пока весь запрос укладывается в 20 МБ, — а больше
    // Telegram боту и не отдаст.
    const userParts: Part[] = [{ text: prompt }];
    for (const attachment of options.attachments ?? []) {
      userParts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.data.toString('base64'),
        },
      });
    }

    // Gemini ждёт историю в формате [{ role, parts: [{ text }] }],
    // причём роль ассистента здесь называется "model", а не "assistant".
    const contents = [
      ...(options.history ?? []).map((message) => ({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.text }],
      })),
      { role: 'user', parts: userParts },
    ];

    // Модель приходит извне: её задаёт либо настройка топика, либо перебор
    // цепочки при отказе. Своя модель из .env — только значение по умолчанию.
    const model = options.model ?? config.gemini.model;
    const startedAt = Date.now();
    const thinkingConfig = buildThinkingConfig();

    const requested = options.maxOutputTokens ?? 2048;

    const call = (maxOutputTokens: number): Promise<GenerateContentResponse> =>
      withTimeout(
        this.getClient().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: buildSystemPrompt(options.systemPrompt, options.extraInstruction),
            temperature: options.temperature ?? 0.8,
            maxOutputTokens,
            // Отправляется, только если задан GEMINI_THINKING (см. выше).
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        }),
        config.ai.timeoutMs,
        `Gemini (${model})`,
      );

    try {
      let response: GenerateContentResponse;
      try {
        response = await call(requested);
      } catch (error) {
        // Просили больше, чем модель умеет отдать за раз. Не беда человека:
        // повторяем тем же ходом, но с потолком, который назвала сама модель.
        const limit = outputLimitFromError(error instanceof Error ? error.message : String(error));
        if (limit === null || limit >= requested) throw error;

        logger.warn('Модель не приняла потолок ответа, повторяю с её собственным', { model, requested, limit });
        response = await call(limit);
      }

      const text = response.text?.trim();

      if (!text) {
        const blockReason = response.promptFeedback?.blockReason;
        // Сравниваем через String(): в SDK это enum, а не строковый литерал.
        const finishReason = String(response.candidates?.[0]?.finishReason ?? '');

        // Модели с «размышлениями» тратят лимит токенов на них,
        // и на сам ответ места может не остаться.
        if (finishReason === 'MAX_TOKENS') {
          const spent = response.usageMetadata?.thoughtsTokenCount ?? 0;
          throw new ProviderRequestError(
            this.id,
            `Ответ не поместился в лимит токенов${spent ? ` (${spent} из них модель потратила на размышления)` : ''}. ` +
              `Возьмите модель без размышлений (например, gemini-flash-lite-latest) ` +
              'или задайте GEMINI_THINKING=minimal / GEMINI_THINKING=0 под ваше поколение модели.',
            { kind: 'bad-request' },
          );
        }

        // Иначе пустой ответ обычно означает срабатывание фильтров безопасности.
        throw new ProviderRequestError(
          this.id,
          blockReason || finishReason
            ? `Модель отказалась отвечать (причина: ${blockReason ?? finishReason}).`
            : 'Модель вернула пустой ответ. Попробуйте переформулировать запрос.',
          { kind: 'blocked' },
        );
      }

      logger.debug('Gemini: ответ получен', {
        model,
        ms: Date.now() - startedAt,
        chars: text.length,
        attachments: options.attachments?.length ?? 0,
      });

      return text;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw translateGeminiError(this.id, model, error);
    }
  }
}

/**
 * Переводит ошибку Google API в понятную боту и человеку.
 *
 * Вынесено из провайдера, потому что к Gemini ходит не только он: тем же
 * ключом и с теми же отказами работает синтез речи (src/services/gemini-tts.ts).
 * Главное здесь — вид отказа: от него зависит, имеет ли смысл перебирать
 * цепочку моделей дальше (см. src/services/chain.ts).
 */
export function translateGeminiError(providerId: string, model: string, error: unknown): ProviderRequestError {
  const raw = error instanceof Error ? error.message : String(error);
  const { text, code, status } = extractApiError(raw);

  logger.warn('Gemini вернул ошибку', { model, code, status, text });

  // Таймаут ставит withTimeout, и это не ответ Google. Перебирать из-за
  // него цепочку нельзя: четыре модели подряд по полторы минуты — это
  // шесть минут молчания вместо ответа.
  if (/превышен таймаут/i.test(raw)) {
    return new ProviderRequestError(
      providerId,
      `Модель «${model}» не ответила за отведённое время. Попробуйте ещё раз или упростите запрос.`,
      { cause: error, kind: 'timeout' },
    );
  }

  // Географическая блокировка. Google отклоняет запрос по IP отправителя,
  // а не по ключу: диапазоны многих хостингов у него в чёрном списке.
  // Ошибка приходит с кодом 400, но с настройками бота никак не связана.
  if (/location is not supported/i.test(text)) {
    return new ProviderRequestError(
      providerId,
      'Google не обслуживает запросы с IP этого сервера («User location is not supported»).\n\n' +
        'Дело не в ключе и не в .env — тот же ключ работает с машины в другой сети. ' +
        'Google блокирует диапазоны многих хостингов целиком.\n\n' +
        'Что можно сделать:\n' +
        '• поднять прокси в разрешённом регионе и указать его в GEMINI_BASE_URL;\n' +
        '• переключиться на OpenAI-совместимый провайдер (OPENAI_BASE_URL, например OpenRouter);\n' +
        '• перенести бота на хостинг с другим диапазоном адресов.',
      { cause: error, kind: 'geo' },
    );
  }

  // 400: чаще всего в запрос попал параметр, которого модель не понимает.
  if (code === 400 || status === 'INVALID_ARGUMENT') {
    return new ProviderRequestError(
      providerId,
      `Gemini отклонил запрос (400): ${text}\n\n` +
        `Модель: ${model}. Проверьте GEMINI_MODEL и GEMINI_THINKING в .env — ` +
        'у Gemini 2.5 и Gemini 3.x разные форматы параметра «размышлений».',
      { cause: error, kind: 'bad-request' },
    );
  }
  if (code === 404 || status === 'NOT_FOUND') {
    return new ProviderRequestError(
      providerId,
      `Модель «${model}» недоступна для вашего ключа. Проверьте её имя в GEMINI_CHAIN_MAIN / GEMINI_CHAIN_THINK.`,
      { cause: error, kind: 'not-found' },
    );
  }
  if (code === 401 || code === 403 || /api[_ ]?key|API_KEY_INVALID/i.test(raw)) {
    return new ProviderRequestError(providerId, 'Gemini отклонил ключ. Проверьте GEMINI_API_KEY.', {
      cause: error,
      kind: 'auth',
    });
  }
  if (code === 429 || /quota|RESOURCE_EXHAUSTED/i.test(raw)) {
    return new ProviderRequestError(providerId, `У модели «${model}» закончилась дневная норма запросов.`, {
      cause: error,
      kind: 'quota',
    });
  }
  // 5xx — беда на стороне Google, причём обычно у конкретной модели:
  // соседняя в цепочке в этот же момент вполне может отвечать.
  if (code !== undefined && code >= 500) {
    return new ProviderRequestError(providerId, `Google ответил ошибкой ${code}: ${text}`, {
      cause: error,
      kind: 'server',
    });
  }
  return new ProviderRequestError(providerId, `Ошибка Gemini: ${text}`, { cause: error });
}

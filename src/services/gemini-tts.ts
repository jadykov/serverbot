/**
 * Синтез речи через Gemini TTS.
 *
 * Дневная норма у этих моделей маленькая — по 10 запросов на каждую, — но
 * моделей несколько, и работают они по той же схеме, что текстовые цепочки:
 * первая упёрлась в норму, следующая подхватила. В сумме это два-три десятка
 * озвучек в день на всю группу, чего с запасом хватает.
 *
 * Про формат. Gemini отдаёт сырой PCM (16 бит, моно, 24 кГц), а Telegram
 * ни PCM, ни WAV в качестве «голосового» не принимает: для кружочка с
 * осциллограммой нужен OGG/Opus. Поэтому:
 *
 *   • есть ffmpeg — перекодируем в OGG/Opus и шлём настоящим голосовым,
 *     заодно файл выходит вдесятеро легче;
 *   • нет ffmpeg — заворачиваем PCM в WAV и шлём обычным аудиофайлом.
 *     Играется так же, выглядит иначе.
 *
 * Зависимость необязательная намеренно: тянуть в образ 80 мегабайт ради
 * внешнего вида сообщения — плохая сделка, а работает бот и без неё.
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { withTimeout } from '../utils.js';
import { hasFfmpeg, runFfmpeg } from './ffmpeg.js';
import { translateGeminiError } from './gemini.js';
import { ProviderRequestError } from '../types.js';

/** Готовая озвучка. */
export interface Speech {
  data: Buffer;
  /** true — OGG/Opus, можно слать голосовым; false — WAV, только аудиофайлом. */
  isVoice: boolean;
  /** Модель, которая справилась, и те, что отказали до неё. */
  model: string;
  skipped: string[];
  elapsedMs: number;
}

/**
 * Готовые голоса Gemini и русские слова, которыми их зовут.
 *
 * У модели два разных рычага, и это стоит различать:
 *
 *   • голос (voiceName) — кто говорит. Набор закрытый, назвать можно только
 *     то, что есть у Google;
 *   • манера — как говорит. Задаётся обычными словами прямо в запросе
 *     («Скажи испуганным шёпотом: …»), и здесь можно просить что угодно,
 *     хоть «как в Warcraft 3».
 *
 * Отсюда и устройство таблицы: знакомое слово переключает голос, всё
 * остальное уходит моделью как описание манеры. Незнакомое слово — не ошибка
 * и не повод ругаться: «хрипло и устало» голосом не является, но манерой
 * является вполне.
 *
 * Важное исключение — пол. Он манерой не задаётся вовсе: сколько ни проси
 * «мужской голос в стиле Джесси Пинкмана», манеру модель отыграет, а говорить
 * будет голосом из настроек, то есть женским Kore. Поэтому «мужской»
 * и «женский» стоят в таблице наравне с «низким» и «высоким».
 */
const VOICES: Record<string, { voice: string; about: string }> = {
  мужской: { voice: 'Charon', about: 'мужской, спокойный' },
  женский: { voice: 'Kore', about: 'женский, ровный' },
  низкий: { voice: 'Charon', about: 'спокойный низкий' },
  высокий: { voice: 'Leda', about: 'высокий молодой' },
  бодрый: { voice: 'Puck', about: 'бодрый, с подъёмом' },
  твёрдый: { voice: 'Kore', about: 'твёрдый, ровный' },
  твердый: { voice: 'Kore', about: 'твёрдый, ровный' },
  мягкий: { voice: 'Aoede', about: 'мягкий, лёгкий' },
  яркий: { voice: 'Zephyr', about: 'яркий, звонкий' },
  напористый: { voice: 'Fenrir', about: 'напористый, громкий' },
  уверенный: { voice: 'Orus', about: 'уверенный, деловой' },
};

/** Как просить озвучку: готовый голос, своя манера или и то и другое. */
export interface VoiceRequest {
  /** Имя голоса Google. Пусто — берём из настроек (GEMINI_TTS_VOICE). */
  voice?: string;
  /** Манера, словами: «шёпотом», «как в Warcraft 3», «устало и хрипло». */
  style?: string;
}

/** Список голосов для справки: «низкий, высокий, бодрый…». */
export function listVoiceNames(): string[] {
  // Дубли ради буквы «ё» (твёрдый/твердый) в справке ни к чему.
  return [...new Set(Object.entries(VOICES).map(([name]) => name))].filter((name) => name !== 'твердый');
}

/**
 * Слова про пол говорящего: падежи и привычные синонимы.
 *
 * Отдельным списком, а не строками в таблице, потому что пишут их как придётся
 * — «мужской», «мужским», «мужчина», — а голос за каждым стоит один и тот же.
 * Сравниваем по началу слова: окончание здесь ничего не решает.
 */
const GENDERS: Array<{ start: RegExp; name: string }> = [
  { start: /^(?:мужск|мужчин|парен|пацан)/, name: 'мужской' },
  { start: /^(?:женск|женщин|девуш|девич)/, name: 'женский' },
];

/** «Голос» сразу после заказа: в манеру это слово не идёт. */
const VOICE_FILLER = /^голос(?:ом|а|е|у)?$/;

/** Для сравнения со словарём: регистр и знаки препинания только мешают. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Разбирает заказ голоса: знакомое слово — голос, всё прочее — манера.
 *
 * Слов может быть и несколько: «низкий, устало» — это и голос Charon,
 * и просьба читать устало. Знакомое слово берём одно, первое: «низкий, мягкий»
 * — это низкий голос, прочитанный мягко, а не спор двух голосов.
 *
 * Регистр остальных слов сохраняем: манера уходит модели текстом, и «в стиле
 * Джесси Пинкмана» читается ей понятнее, чем то же самое строчными.
 */
export function parseVoiceRequest(spec: string): VoiceRequest {
  const words = spec.split(/[\s,;]+/).filter(Boolean);

  let voice: string | undefined;
  let chosenAt = -1;
  const rest: string[] = [];

  words.forEach((word, index) => {
    const plain = normalizeWord(word);

    if (!voice) {
      const known = VOICES[plain] ? plain : GENDERS.find(({ start }) => start.test(plain))?.name;

      if (known) {
        voice = VOICES[known]!.voice;
        chosenAt = index;
        return;
      }
    }

    // «мужской голос в стиле …»: слово «голос» тут служебное, и в просьбу
    // к модели ему не надо — «Скажи голос в стиле …» звучит как оговорка.
    // Само по себе оно остаётся: «голосом робота» без него станет «робота».
    if (voice && index === chosenAt + 1 && VOICE_FILLER.test(plain)) return;

    rest.push(word);
  });

  return {
    ...(voice ? { voice } : {}),
    ...(rest.length > 0 ? { style: rest.join(' ') } : {}),
  };
}

const PROVIDER_ID = 'gemini-tts';

/** Частота дискретизации, которую отдаёт Gemini TTS. */
const SAMPLE_RATE = 24_000;

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

/**
 * Заворачивает сырой PCM в WAV, дописывая 44-байтовый заголовок RIFF.
 *
 * Сам звук при этом не трогается — меняется только «обёртка», по которой
 * проигрыватель понимает частоту, разрядность и число каналов.
 */
function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * 2; // моно, 16 бит = 2 байта на отсчёт

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // длина блока fmt
  header.writeUInt16LE(1, 20); // 1 = PCM без сжатия
  header.writeUInt16LE(1, 22); // каналов: моно
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // выравнивание блока
  header.writeUInt16LE(16, 34); // бит на отсчёт
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Перекодирует PCM в OGG/Opus через ffmpeg. */
function pcmToOpus(pcm: Buffer): Promise<Buffer> {
  return runFfmpeg(
    [
      // Вход — сырой поток, поэтому формат приходится описывать руками.
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-f', 'ogg',
      'pipe:1',
    ],
    pcm,
    'PCM → OGG/Opus',
  );
}

/** Один запрос к одной модели. Возвращает сырой PCM. */
async function synthesizeOnce(text: string, model: string, voice: string, style?: string): Promise<Buffer> {
  /**
   * Манера задаётся не параметром, а словами перед текстом — так устроен
   * Gemini TTS: «Скажи испуганным шёпотом: …». Сама эта фраза вслух
   * не читается, модель понимает её как указание, а не как часть текста.
   */
  const prompt = style ? `Скажи ${style}: ${text}` : text;

  const response = await withTimeout(
    getClient().models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        // Модель обязана ответить звуком, а не текстом.
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    }),
    config.ai.timeoutMs,
    `Gemini TTS (${model})`,
  );

  const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!audio) {
    const finishReason = String(response.candidates?.[0]?.finishReason ?? '');
    throw new ProviderRequestError(
      PROVIDER_ID,
      finishReason
        ? `Модель не стала озвучивать текст (причина: ${finishReason}).`
        : 'Модель вернула ответ без звука. Попробуйте другой текст.',
      { kind: 'blocked' },
    );
  }

  return Buffer.from(audio, 'base64');
}

/** Отказы, после которых имеет смысл взять следующую модель озвучки. */
const RETRYABLE = new Set(['quota', 'not-found', 'server']);

/**
 * Озвучивает текст, перебирая цепочку TTS-моделей.
 *
 * Перебор здесь нужнее, чем в тексте: дневная норма у каждой модели —
 * десяток запросов, и упереться в неё легко. Правила те же, что в chain.ts:
 * норма и отсутствие модели — повод попробовать соседнюю, отказ цензуры
 * и неверный ключ — нет.
 */
export async function synthesizeSpeech(text: string, request: VoiceRequest = {}): Promise<Speech> {
  if (!config.gemini.apiKey) {
    throw new ProviderRequestError(PROVIDER_ID, 'Не задан GEMINI_API_KEY — озвучивать нечем.', { kind: 'auth' });
  }

  const models = config.tts.chain;
  const startedAt = Date.now();
  const skipped: string[] = [];
  const voice = request.voice ?? config.tts.voice;
  let lastError: ProviderRequestError | undefined;

  for (const model of models) {
    try {
      let pcm: Buffer;
      try {
        pcm = await synthesizeOnce(text, model, voice, request.style);
      } catch (error) {
        // Набор голосов у Google меняется, и наш список может отстать.
        // Отказ из-за имени голоса — не повод остаться без озвучки:
        // повторяем тем же ходом, но голосом из настроек.
        const wrongVoice =
          voice !== config.tts.voice &&
          error instanceof Error &&
          /voice/i.test(error.message) &&
          /invalid|not found|unsupported|400/i.test(error.message);

        if (!wrongVoice) throw error;

        logger.warn('Модель не приняла голос, повторяю голосом по умолчанию', { model, voice });
        pcm = await synthesizeOnce(text, model, config.tts.voice, request.style);
      }
      const useVoice = hasFfmpeg();
      // Даже если ffmpeg есть, но споткнулся, — отдадим WAV, а не ошибку:
      // человеку нужна озвучка, а не рассказ про кодеки.
      let data: Buffer;
      let isVoice = useVoice;

      if (useVoice) {
        try {
          data = await pcmToOpus(pcm);
        } catch (error) {
          logger.warn('ffmpeg не справился, отправляю WAV', {
            error: error instanceof Error ? error.message : String(error),
          });
          data = pcmToWav(pcm);
          isVoice = false;
        }
      } else {
        data = pcmToWav(pcm);
      }

      logger.info('Текст озвучен', {
        model,
        skipped,
        voiceName: voice,
        ...(request.style ? { style: request.style } : {}),
        chars: text.length,
        kb: Math.round(data.length / 1024),
        voice: isVoice,
        ms: Date.now() - startedAt,
      });

      return { data, isVoice, model, skipped, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      const failure = error instanceof ProviderRequestError ? error : translateGeminiError(PROVIDER_ID, model, error);

      if (!RETRYABLE.has(failure.kind)) throw failure;

      lastError = failure;
      skipped.push(model);
      logger.warn('Модель озвучки отказала, беру следующую', { model, kind: failure.kind });
    }
  }

  throw new ProviderRequestError(
    PROVIDER_ID,
    `Озвучить не вышло: перепробованы все модели (${skipped.join(', ')}). ` +
      `Дневная норма у них небольшая — по 10 запросов на модель.\n\n` +
      `Последняя причина: ${lastError?.message ?? 'неизвестна'}`,
    { cause: lastError, kind: lastError?.kind ?? 'unknown' },
  );
}

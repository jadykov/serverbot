/**
 * Дневная норма на одного пользователя — для всего, что стоит денег.
 *
 * Зачем отдельно от рейт-лимита: тот считает запросы в минуту и защищает
 * от зажатого Enter, а здесь речь о деньгах. Картинка у Krea стоит $0,015,
 * минутный трек у Ace-Step — около $0,03, и без нормы один увлёкшийся
 * человек за вечер тратит бюджет всей группы.
 *
 * Норм четыре, и они независимы: картинки, треки, живой поиск и размышление
 * платятся разным сервисам и разными деньгами, так что общий счётчик врал бы
 * всем. Логика у них при этом одна до буквы — поэтому здесь фабрика,
 * а не четыре похожих модуля.
 *
 * Счётчик лежит на диске рядом с сессиями, а не в памяти процесса: иначе
 * любой рестарт или деплой молча обнулял бы норму всем сразу, и лимит
 * обходился бы простым «попросите перезапустить бота».
 *
 * Ограничение то же, что у рейт-лимита: считается один процесс. Для нескольких
 * реплик счётчик нужно выносить в общее хранилище (Redis).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** Сколько пользователь уже потратил и в какой день. */
interface QuotaRecord {
  /** Календарный день в виде YYYY-MM-DD по часовому поясу из конфигурации. */
  day: string;
  used: number;
}

/** Ответ на попытку занять слот. */
export type QuotaDecision =
  | { allowed: true; used: number; limit: number; remaining: number }
  | { allowed: false; used: number; limit: number; resetsIn: string };

/** Одна норма: занять слот, подсмотреть остаток, вернуть слот назад. */
export interface DailyQuota {
  reserve(userId: number | undefined): Promise<QuotaDecision>;
  peek(userId: number | undefined): Promise<{ used: number; limit: number } | null>;
  release(userId: number | undefined): Promise<void>;
}

interface QuotaOptions {
  /**
   * Имя файла со счётчиком. Лежит в каталоге сессий: он уже смонтирован
   * на том в Docker, и терять счётчик по той же причине, по которой мы
   * не теряем настройки топиков, не хочется. Имя не должно пересекаться
   * с файлами сессий — те называются по id чата.
   */
  file: string;
  /** Что нормируется, в родительном падеже: «картинок», «треков». Для лога. */
  what: string;
  /**
   * Предел и часовой пояс — функциями, а не значениями: модуль создаётся
   * при импорте, и читать конфигурацию в этот момент рано.
   */
  limit: () => number;
  timezone: () => string;
}

function createDailyQuota({ file, what, limit: limitOf, timezone }: QuotaOptions): DailyQuota {
  /** userId -> запись. Диск здесь — надёжность, а работаем из памяти. */
  const records = new Map<number, QuotaRecord>();
  let loaded = false;

  const quotaFile = (): string => path.join(config.session.dir, file);

  /** Текущий календарный день в настроенном часовом поясе: YYYY-MM-DD. */
  const currentDay = (): string =>
    // Локаль en-CA выбрана не для языка, а ради формата: она единственная
    // из распространённых печатает дату как 2026-08-14.
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

  /** Сколько осталось до полуночи в том же часовом поясе, человеческим текстом. */
  const timeUntilReset = (): string => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone(),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());

    const [hours = 0, minutes = 0] = parts.split(':').map(Number);
    const minutesLeft = 24 * 60 - (hours * 60 + minutes);

    if (minutesLeft < 60) return `${minutesLeft} мин`;
    const h = Math.floor(minutesLeft / 60);
    const m = minutesLeft % 60;
    return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
  };

  /** Читает счётчики с диска. Отсутствующий или битый файл — не ошибка. */
  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;

    try {
      const raw = await readFile(quotaFile(), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, QuotaRecord>;
      const today = currentDay();

      for (const [userId, record] of Object.entries(parsed)) {
        // Вчерашние записи не восстанавливаем: норма уже обновилась,
        // а файл заодно не растёт бесконечно.
        if (record?.day === today) records.set(Number(userId), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`Не удалось прочитать счётчик ${what}, начинаем с нуля`, { file: quotaFile() });
      }
    }
  };

  /** Пишет счётчики на диск: сначала во временный файл, потом переименованием. */
  const save = async (): Promise<void> => {
    const today = currentDay();
    const plain: Record<string, QuotaRecord> = {};
    for (const [userId, record] of records) {
      if (record.day === today) plain[String(userId)] = record;
    }

    try {
      await mkdir(path.dirname(quotaFile()), { recursive: true });
      /**
       * Переименование атомарно: оборвись процесс на середине записи,
       * на диске останется целый предыдущий файл, а не половина нового.
       *
       * Имя временного файла своё у каждой записи, и это не педантизм.
       * Два одновременных списания с общим именем писали бы в один файл
       * вперемешку, а переименовали бы вторым — на диск легла бы каша,
       * и следующий load() на битом JSON начал бы счёт с нуля, то есть
       * обнулил бы дневные нормы всей группе.
       */
      const tmp = `${quotaFile()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await writeFile(tmp, JSON.stringify(plain), 'utf8');
      await rename(tmp, quotaFile());
    } catch (error) {
      // Счётчик не критичен настолько, чтобы из-за него не отдать результат:
      // в худшем случае норма переживёт рестарт неточной.
      logger.warn(`Не удалось сохранить счётчик ${what}`, { file: quotaFile(), error: String(error) });
    }
  };

  return {
    /**
     * Занимает один слот дневной нормы.
     *
     * Слот именно занимается заранее, а не списывается по факту готового
     * результата: генерация идёт полминуты и дольше, и за это время можно
     * успеть отправить команду ещё дважды. При неудаче слот возвращается —
     * см. release.
     */
    async reserve(userId) {
      const limit = limitOf();

      // 0 или меньше — лимит выключен. Админы, в отличие от рейт-лимита, норме
      // подчиняются наравне со всеми: рейт-лимит защищает бота от спама, а норма
      // делит общий кошелёк, и исключений в ней быть не должно — иначе это уже
      // не общая норма, а привилегия.
      if (limit <= 0 || userId === undefined) {
        return { allowed: true, used: 0, limit: 0, remaining: Number.POSITIVE_INFINITY };
      }

      await load();

      const today = currentDay();
      const record = records.get(userId);
      const used = record?.day === today ? record.used : 0;

      if (used >= limit) {
        logger.info(`Дневная норма ${what} исчерпана`, { userId, used, limit });
        return { allowed: false, used, limit, resetsIn: timeUntilReset() };
      }

      records.set(userId, { day: today, used: used + 1 });
      await save();

      return { allowed: true, used: used + 1, limit, remaining: limit - used - 1 };
    },

    /**
     * Сколько потрачено на сегодня, без списания. Нужно, чтобы показать остаток
     * ещё до траты — в подтверждении, когда деньги ещё не ушли.
     */
    async peek(userId) {
      const limit = limitOf();
      if (limit <= 0 || userId === undefined) return null;

      await load();
      const record = records.get(userId);
      return { used: record?.day === currentDay() ? record.used : 0, limit };
    },

    /** Возвращает занятый слот обратно, если результата так и не вышло. */
    async release(userId) {
      if (userId === undefined) return;

      const record = records.get(userId);
      if (!record || record.day !== currentDay() || record.used <= 0) return;

      record.used -= 1;
      await save();
    },
  };
}

/** Норма на картинки. Файл прежний — счётчики на работающем боте не сбрасываются. */
export const imageQuota = createDailyQuota({
  file: 'image-quota.json',
  what: 'картинок',
  limit: () => config.imageQuota.perUserPerDay,
  timezone: () => config.imageQuota.timezone,
});

/** Норма на треки: платятся отдельным сервисом, значит и считаются отдельно. */
export const trackQuota = createDailyQuota({
  file: 'track-quota.json',
  what: 'треков',
  limit: () => config.trackQuota.perUserPerDay,
  timezone: () => config.trackQuota.timezone,
});

export const webQuota = createDailyQuota({
  file: 'web-quota.json',
  what: 'поисков',
  limit: () => config.webQuota.perUserPerDay,
  timezone: () => config.webQuota.timezone,
});

/** Норма на размышления: платный OpenRouter, и цена вопроса самая крупная. */
export const deepQuota = createDailyQuota({
  file: 'deep-quota.json',
  what: 'размышлений',
  limit: () => config.deepQuota.perUserPerDay,
  timezone: () => config.deepQuota.timezone,
});

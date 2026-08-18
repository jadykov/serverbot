/**
 * Сборка бота: middleware, команды, обработка ошибок.
 *
 * Порядок регистрации = порядок выполнения. Сначала общие middleware
 * (логи, сессия, лимиты), потом команды, и только в самом конце —
 * «ловушка» для обычных сообщений (она внутри registerAiCommands).
 */
import { Bot, GrammyError, HttpError, session } from 'grammy';
import { FileAdapter } from '@grammyjs/storage-file';
import { config } from './config.js';
import { describeError, logger } from './logger.js';
import { requestLogger } from './middlewares/logging.js';
import { replyToSender } from './middlewares/reply.js';
import { rateLimit } from './middlewares/rateLimit.js';
import { mute } from './middlewares/mute.js';
import { searchIndexer } from './middlewares/searchIndex.js';
import { registerBasicCommands } from './commands/basic.js';
import { registerAiCommands } from './commands/ai.js';
import { registerDrawCommands } from './commands/draw.js';
import { sessionKey } from './utils.js';
import { DEFAULT_IMAGE_PROVIDER_ID, DEFAULT_TEXT_PROVIDER_ID } from './services/registry.js';
import type { BotContext, SessionData } from './types.js';

/** Список команд для «синего» меню в клиенте Telegram (setMyCommands). */
export const BOT_COMMANDS = [
  { command: 'start', description: 'Запустить бота и увидеть справку' },
  { command: 'help', description: 'Список всех команд' },
  { command: 'stop', description: 'Замолчать в этом разделе (обратно — /start)' },
  // Кириллическую /гем в это меню добавить нельзя: Telegram принимает
  // в именах команд только латиницу (иначе BOT_COMMAND_INVALID).
  { command: 'gem', description: 'Запрос к Gemini (то же, что /гем). Слова: !нарисуй !скажи !найди !файл' },
  { command: 'ping', description: 'Проверить связь и задержку' },
  { command: 'marco', description: 'Тест: бот ответит Polo!' },
  { command: 'test', description: 'Самодиагностика бота' },
  { command: 'whoami', description: 'Показать ваши id' },
  { command: 'status', description: 'Состояние сервиса' },
] as const;

/** Создаёт и настраивает экземпляр бота (но не запускает его). */
export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.bot.token);

  // 1. Логирование — первым, чтобы видеть в том числе отвалившиеся апдейты.
  bot.use(requestLogger);

  // 2. Ответы реплаем и в нужный топик форума.
  bot.use(replyToSender);

  // 3. Сессия. Лежит в файлах на диске, а не в памяти процесса: в ней история
  //    диалога каждого топика. Держи мы её в памяти, любой деплой молча
  //    обрывал бы все разговоры на полуслове — ошибки нет, бот работает,
  //    просто перестаёт понимать, о чём шла речь.
  //
  //    Каталог задаётся SESSION_DIR и в Docker обязан лежать на томе.
  //    Если однажды понадобится несколько реплик бота — заменить адаптер
  //    на общий (@grammyjs/storage-redis), остальной код не изменится.
  bot.use(
    session({
      initial: (): SessionData => ({
        textProviderId: DEFAULT_TEXT_PROVIDER_ID,
        imageProviderId: DEFAULT_IMAGE_PROVIDER_ID,
        history: [],
      }),
      storage: new FileAdapter<SessionData>({ dirName: config.session.dir }),
      // Ключ сессии по умолчанию — id чата. Для форумов добавляем id топика:
      // так в каждом топике будет собственная история диалога и свои настройки,
      // и они не перемешиваются между собой. Сам ключ считает sessionKey
      // в src/utils.ts: по нему же лежит архив поиска, и разъехаться они
      // не должны — иначе настройки раздела окажутся в одном месте,
      // а его переписка в другом.
      getSessionKey: sessionKey,
    }),
  );

  // 4. Выключатель раздела. Стоит сразу после сессии — она ему и нужна, —
  //    и до всего остального: в выключенном топике бот не отвечает, не тратит
  //    квоты и не пополняет архив поиска (см. middlewares/mute.ts).
  bot.use(mute);

  // 5. Защита от спама.
  bot.use(rateLimit);

  // 6. Архив переписки для поиска по смыслу. Стоит после рейт-лимита:
  //    отбитый спам индексировать незачем.
  bot.use(searchIndexer);

  // 7. Команды. registerAiCommands — последней: внутри неё висит «ловушка»
  //    для обычных сообщений, и она должна получать управление после всех.
  //    registerDrawCommands стоит перед ней по той же причине: правка промпта
  //    приходит обычным сообщением, и перехватить его надо раньше ловушки.
  registerBasicCommands(bot);
  registerDrawCommands(bot);
  registerAiCommands(bot);

  // 8. Глобальная ловушка ошибок: без неё любое исключение
  //    в обработчике уронит поллинг.
  bot.catch(async (botError) => {
    const { ctx, error } = botError;

    if (error instanceof GrammyError) {
      // Telegram ответил ошибкой: неверные параметры, бот заблокирован и т.п.
      logger.error('Telegram API вернул ошибку', {
        description: error.description,
        method: error.method,
        code: error.error_code,
        updateId: ctx.update.update_id,
      });
    } else if (error instanceof HttpError) {
      // Не смогли достучаться до Telegram — обычно проблемы с сетью.
      logger.error('Не удалось связаться с Telegram', describeError(error));
    } else {
      logger.error('Необработанная ошибка в обработчике', {
        ...describeError(error),
        updateId: ctx.update.update_id,
      });
    }

    // Пытаемся предупредить пользователя, но не падаем, если и это не вышло
    // (например, бот заблокирован собеседником).
    try {
      await ctx.reply('😔 Внутренняя ошибка бота. Разработчики уже видят её в логах.');
    } catch {
      /* игнорируем */
    }
  });

  return bot;
}

/**
 * Сборка бота: middleware, команды, обработка ошибок.
 *
 * Порядок регистрации = порядок выполнения. Сначала общие middleware
 * (логи, сессия, лимиты), потом команды, и только в самом конце —
 * «ловушка» для обычных сообщений (она внутри registerAiCommands).
 */
import { Bot, GrammyError, HttpError, session } from 'grammy';
import { config } from './config.js';
import { describeError, logger } from './logger.js';
import { requestLogger } from './middlewares/logging.js';
import { replyToSender } from './middlewares/reply.js';
import { rateLimit } from './middlewares/rateLimit.js';
import { registerBasicCommands } from './commands/basic.js';
import { registerAiCommands } from './commands/ai.js';
import { DEFAULT_IMAGE_PROVIDER_ID, DEFAULT_TEXT_PROVIDER_ID } from './services/registry.js';
import type { BotContext, SessionData } from './types.js';

/** Список команд для «синего» меню в клиенте Telegram (setMyCommands). */
export const BOT_COMMANDS = [
  { command: 'start', description: 'Запустить бота и увидеть справку' },
  { command: 'help', description: 'Список всех команд' },
  // Кириллическую /гем в это меню добавить нельзя: Telegram принимает
  // в именах команд только латиницу (иначе BOT_COMMAND_INVALID).
  { command: 'gem', description: 'Запрос к Gemini (то же самое, что /гем)' },
  { command: 'ask', description: 'Вопрос выбранной текстовой нейросети' },
  { command: 'draw', description: 'Нарисовать картинку по описанию' },
  { command: 'ai', description: 'Выбрать активную нейросеть' },
  { command: 'reset', description: 'Очистить историю диалога' },
  { command: 'ping', description: 'Проверить связь и задержку' },
  { command: 'marco', description: 'Тест: бот ответит Polo!' },
  { command: 'echo', description: 'Повторить ваш текст' },
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

  // 3. Сессия. По умолчанию хранится в памяти процесса: при рестарте
  //    контекст диалогов теряется, а несколько реплик бота не увидят
  //    сессии друг друга. Для продакшена подключите внешнее хранилище:
  //    npm i @grammyjs/storage-redis
  //    session({ initial, storage: new RedisAdapter({ instance: redis }) })
  bot.use(
    session({
      initial: (): SessionData => ({
        textProviderId: DEFAULT_TEXT_PROVIDER_ID,
        imageProviderId: DEFAULT_IMAGE_PROVIDER_ID,
        history: [],
      }),
      // Ключ сессии по умолчанию — id чата. Для форумов добавляем id топика:
      // так в каждом топике будет собственная история диалога и они
      // не перемешиваются между собой.
      getSessionKey: (ctx) => {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) return undefined;

        const message = ctx.message ?? ctx.callbackQuery?.message;
        const isTopic = message && 'is_topic_message' in message && message.is_topic_message;
        const threadId = isTopic ? message.message_thread_id : undefined;

        return threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
      },
    }),
  );

  // 4. Защита от спама.
  bot.use(rateLimit);

  // 5. Команды.
  registerBasicCommands(bot);
  registerAiCommands(bot);

  // 6. Глобальная ловушка ошибок: без неё любое исключение
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

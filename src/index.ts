/**
 * Точка входа приложения.
 *
 * Что здесь происходит:
 *  1. проверяем конфигурацию;
 *  2. поднимаем HTTP-сервер для проверки живости (/health);
 *  3. запускаем long polling — бот сам опрашивает Telegram, поэтому
 *     ни домен, ни белый IP, ни открытые порты не нужны;
 *  4. корректно всё это останавливаем по SIGINT/SIGTERM
 *     (важно для `docker stop`, systemd и деплоя без потери сообщений).
 */
import { run, type RunnerHandle } from '@grammyjs/runner';
import { GrammyError } from 'grammy';
import { assertConfigValid, config, ConfigError } from './config.js';
import { describeError, logger } from './logger.js';
import { BOT_COMMANDS, createBot } from './bot.js';
import { createHttpServer, listen } from './server.js';
import { describeProviders } from './services/registry.js';
import { flushAll } from './services/search-index.js';

async function main(): Promise<void> {
  assertConfigValid();

  const bot = createBot();

  // init() запрашивает у Telegram информацию о боте: заодно это первая
  // проверка, что токен вообще рабочий.
  await bot.init();
  logger.info(`Бот @${bot.botInfo.username} инициализирован`, {
    id: bot.botInfo.id,
    env: config.nodeEnv,
  });

  for (const provider of describeProviders()) {
    logger[provider.ready ? 'info' : 'warn'](
      `Провайдер «${provider.title}» (${provider.kind}): ${provider.ready ? 'готов' : 'не настроен — команда будет отвечать подсказкой'}`,
    );
  }

  // Меню команд в интерфейсе Telegram. Обновляется при каждом старте.
  await bot.api.setMyCommands([...BOT_COMMANDS]).catch((error: unknown) => {
    logger.warn('Не удалось обновить меню команд', describeError(error));
  });

  const server = createHttpServer(bot);
  await listen(server);

  // Подстраховка: если на этом токене когда-то был установлен вебхук,
  // Telegram не отдаст апдейты по getUpdates, пока вебхук не удалён.
  // Отсюда классическая ошибка «бот запустился, но молчит».
  await bot.api.deleteWebhook({ drop_pending_updates: config.bot.dropPendingUpdates });

  // run() из @grammyjs/runner обрабатывает апдейты параллельно.
  // Встроенный bot.start() делает это последовательно: один медленный
  // запрос к нейросети заблокировал бы всех остальных пользователей.
  const runner: RunnerHandle = run(bot);
  logger.info('Long polling запущен');

  logger.info('✅ Бот готов к работе');

  // ------------------------------------------------------------ shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Получен сигнал ${signal}, останавливаюсь…`);

    // Если за 10 секунд не уложились — выходим принудительно,
    // иначе docker/systemd прибьют процесс сами и менее аккуратно.
    const force = setTimeout(() => {
      logger.warn('Мягкая остановка затянулась, выхожу принудительно');
      process.exit(1);
    }, 10_000);
    force.unref();

    try {
      if (runner.isRunning()) await runner.stop();
      // Реплики, не набравшие полную пачку, ждут своей очереди в памяти.
      // Без этой строчки каждая выкатка тихо теряла бы последние сообщения
      // каждого раздела: в архив поиска они бы уже не попали никогда.
      await flushAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('Остановлено штатно. Пока!');
      process.exit(0);
    } catch (error) {
      logger.error('Ошибка при остановке', describeError(error));
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT')); // Ctrl+C
  process.once('SIGTERM', () => void shutdown('SIGTERM')); // docker stop / systemctl stop
}

// Ошибки, до которых не добрался ни один try/catch, всё равно должны попасть в лог.
process.on('unhandledRejection', (reason) => {
  logger.error('Необработанный rejected-промис', describeError(reason));
});
process.on('uncaughtException', (error) => {
  logger.error('Необработанное исключение', describeError(error));
  process.exit(1);
});

main().catch((error: unknown) => {
  // Ошибку конфигурации показываем «как есть»: её текст написан для человека,
  // а стектрейс только мешает.
  if (error instanceof ConfigError) {
    console.error(`\n❌ ${error.message}\n`);
    process.exit(1);
  }

  // Самая частая ошибка первого запуска — неверный или отозванный токен.
  if (error instanceof GrammyError && error.error_code === 401) {
    console.error('\n❌ Telegram отклонил BOT_TOKEN (401 Unauthorized).');
    console.error('   Проверьте токен в .env или получите новый у @BotFather (/mybots → API Token).\n');
    process.exit(1);
  }

  logger.error('Не удалось запустить бота', describeError(error));
  process.exit(1);
});

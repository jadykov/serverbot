/**
 * Базовые и тестовые команды бота.
 *
 * Сюда собрано всё, что не требует обращения к нейросетям:
 * приветствие, справка и «пинг-понг»-команды в стиле Марко-Поло,
 * которыми удобно проверять, что бот вообще жив и получает апдейты.
 */
import type { Bot } from 'grammy';
import { config, isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { describeProviders, resolveTextProvider } from '../services/registry.js';
import { escapeHtml } from '../format.js';
import { formatDuration } from '../utils.js';
import type { BotContext } from '../types.js';

/** Текст справки — используется в /start и /help. */
const HELP_TEXT = [
  '<b>Что я умею</b>',
  '',
  '<b>Нейросети</b>',
  '/гем <i>запрос</i> — спросить Gemini (то же самое: /gem)',
  '/гем контекст <i>задача</i> — то же, но моделью посильнее (то же: /gem context)',
  '/гем нарисуй <i>описание</i> — картинка вместо текста, платно (то же: /gem draw)',
  '/режим — настроить раздел: цепочку моделей и свой промпт (то же: /mode)',
  '/reset — очистить историю диалога',
  '',
  '<i>Картинку можно просто прислать в чат — я её разберу. В группе добавьте</i>',
  '<i>к ней подпись с командой, например: /гем что здесь написано.</i>',
  '',
  '<b>Проверка работоспособности</b>',
  '/ping — ответить «pong» и показать задержку до Telegram',
  '/marco — классика: я отвечу «Polo!»',
  '/polo — а тут наоборот, отвечу «Marco!»',
  '/echo <i>текст</i> — повторю сообщение слово в слово',
  '/test — самодиагностика: связь с Telegram и готовность провайдеров',
  '/test ai — то же самое плюс реальный короткий запрос к нейросети',
  '',
  '<b>Служебное</b>',
  '/whoami — ваши id пользователя и чата (пригодится для ADMIN_IDS)',
  '/status — аптайм, память, режим работы',
  '/help — эта справка',
  '',
  '<i>Обычные сообщения запросом не считаются — обращайтесь ко мне командой.</i>',
  '<i>В группах и в топиках форума я отвечаю там же, где спросили, реплаем на ваш запрос.</i>',
].join('\n');

export function registerBasicCommands(bot: Bot<BotContext>): void {
  // ---------------------------------------------------------------- /start
  bot.command('start', async (ctx) => {
    const name = escapeHtml(ctx.from?.first_name ?? 'друг');
    await ctx.reply(
      `👋 Привет, <b>${name}</b>!\n\n` +
        'Я демонстрационный бот на Node.js + TypeScript. Умею общаться через ' +
        'текстовые нейросети и рисовать картинки.\n\n' +
        HELP_TEXT,
      { parse_mode: 'HTML' },
    );
  });

  // ----------------------------------------------------------------- /help
  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  // ----------------------------------------------------------------- /ping
  // Отправляем сообщение и сразу его редактируем: разница во времени
  // и есть реальная задержка до Bot API (round-trip).
  bot.command('ping', async (ctx) => {
    const startedAt = Date.now();
    const message = await ctx.reply('🏓 Pong!');
    const latency = Date.now() - startedAt;

    await ctx.api.editMessageText(
      message.chat.id,
      message.message_id,
      `🏓 <b>Pong!</b>\nЗадержка до Telegram API: <b>${latency} мс</b>\nАптайм процесса: ${formatDuration(process.uptime() * 1000)}`,
      { parse_mode: 'HTML' },
    );
  });

  // ------------------------------------------------------- /marco и /polo
  // Простейший тест «команда → ответ»: если работает, значит апдейты
  // доходят до бота, а ответы — до Telegram.
  bot.command('marco', async (ctx) => {
    await ctx.reply('🌊 Polo!');
  });

  bot.command('polo', async (ctx) => {
    await ctx.reply('🏊 Marco!');
  });

  // Тот же тест, но на обычное сообщение без слэша: напишите «marco» — получите «Polo!».
  bot.hears(/^\s*marco[\s!.?]*$/i, async (ctx) => {
    await ctx.reply('🌊 Polo!');
  });
  bot.hears(/^\s*(поло|polo)[\s!.?]*$/i, async (ctx) => {
    await ctx.reply('🏊 Marco!');
  });

  // ----------------------------------------------------------------- /echo
  bot.command('echo', async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await ctx.reply('Напишите текст после команды. Например: <code>/echo привет</code>', { parse_mode: 'HTML' });
      return;
    }
    // Отправляем как обычный текст, без parse_mode: пользовательский ввод
    // может содержать символы, ломающие разметку.
    await ctx.reply(text);
  });

  // --------------------------------------------------------------- /whoami
  bot.command('whoami', async (ctx) => {
    const user = ctx.from;
    const lines = [
      '<b>Кто вы для бота</b>',
      `ID пользователя: <code>${user?.id ?? '—'}</code>`,
      `Username: ${user?.username ? '@' + escapeHtml(user.username) : '—'}`,
      `Имя: ${escapeHtml(user?.first_name ?? '—')}`,
      `Язык клиента: ${escapeHtml(user?.language_code ?? '—')}`,
      '',
      `ID чата: <code>${ctx.chat?.id ?? '—'}</code>`,
      `Тип чата: ${ctx.chat?.type ?? '—'}`,
      `Права администратора бота: ${isAdmin(user?.id) ? 'да' : 'нет'}`,
      '',
      '<i>Чтобы стать админом, добавьте свой ID пользователя в ADMIN_IDS в .env и перезапустите бота.</i>',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // --------------------------------------------------------------- /status
  bot.command('status', async (ctx) => {
    const memory = process.memoryUsage();
    const lines = [
      '<b>Состояние сервиса</b>',
      `Окружение: <code>${config.nodeEnv}</code>`,
      `Аптайм: ${formatDuration(process.uptime() * 1000)}`,
      `Память (RSS): ${Math.round(memory.rss / 1024 / 1024)} МБ`,
      `Node.js: ${process.version}`,
      '',
      '<b>Провайдеры</b>',
      ...describeProviders().map(
        (provider) => `${provider.ready ? '✅' : '⚪️'} ${escapeHtml(provider.title)} — ${provider.kind}`,
      ),
      '',
      `Текст: <code>${escapeHtml(ctx.session.textProviderId)}</code>, ` +
        `картинки: <code>${escapeHtml(ctx.session.imageProviderId)}</code>`,
      `Сообщений в истории диалога: ${ctx.session.history.length}`,
    ];

    // Админам показываем чуть больше технических деталей.
    if (isAdmin(ctx.from?.id)) {
      lines.push(
        '',
        '<b>Только для админов</b>',
        `PID: <code>${process.pid}</code>`,
        `Лимит: ${config.rateLimit.max} запросов / ${Math.round(config.rateLimit.windowMs / 1000)} с`,
        `Таймаут запроса к ИИ: ${Math.round(config.ai.timeoutMs / 1000)} с`,
        `Уровень логов: <code>${config.logLevel}</code>`,
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // ----------------------------------------------------------------- /test
  // Самодиагностика. Без аргументов — быстрые проверки, с аргументом "ai" —
  // ещё и настоящий (короткий и дешёвый) запрос к текстовой нейросети.
  bot.command('test', async (ctx) => {
    const withAiCheck = ctx.match.trim().toLowerCase() === 'ai';
    const results: string[] = ['<b>Самодиагностика</b>', ''];

    // 1. Связь с Telegram Bot API.
    const startedAt = Date.now();
    try {
      const me = await ctx.api.getMe();
      results.push(`✅ Telegram API — ответил за ${Date.now() - startedAt} мс (я @${escapeHtml(me.username)})`);
    } catch (error) {
      results.push(`❌ Telegram API — ${error instanceof Error ? escapeHtml(error.message) : 'ошибка'}`);
    }

    // 2. Конфигурация провайдеров.
    for (const provider of describeProviders()) {
      results.push(
        provider.ready
          ? `✅ ${escapeHtml(provider.title)} — ключи на месте (${provider.kind})`
          : `⚪️ ${escapeHtml(provider.title)} — не настроен, команда будет недоступна`,
      );
    }

    // 3. Боевой запрос к текстовой модели (по флагу).
    if (withAiCheck) {
      const aiStartedAt = Date.now();
      try {
        const provider = resolveTextProvider(ctx.session.textProviderId);
        const answer = await provider.generateText('Ответь ровно одним словом: работает', {
          // Лимит с запасом: модели с «размышлениями» тратят сотни токенов
          // ещё до того, как начнут писать сам ответ.
          maxOutputTokens: 512,
          temperature: 0,
        });
        results.push(
          '',
          `✅ Живой запрос к «${escapeHtml(provider.title)}» за ${Date.now() - aiStartedAt} мс`,
          `Ответ модели: <i>${escapeHtml(answer.slice(0, 200))}</i>`,
        );
      } catch (error) {
        logger.warn('Самодиагностика: запрос к нейросети не удался', {
          error: error instanceof Error ? error.message : String(error),
        });
        results.push('', `❌ Живой запрос не прошёл: ${escapeHtml(error instanceof Error ? error.message : 'ошибка')}`);
      }
    } else {
      results.push('', '<i>Подсказка: /test ai — проверить нейросеть настоящим запросом.</i>');
    }

    await ctx.reply(results.join('\n'), { parse_mode: 'HTML' });
  });
}

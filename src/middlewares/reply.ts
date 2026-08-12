/**
 * Middleware «отвечай туда, откуда спросили».
 *
 * Подменяет ctx.reply / ctx.replyWithPhoto / ctx.replyWithChatAction так,
 * чтобы каждый ответ бота:
 *   1. приходил реплаем на сообщение с запросом (а не отдельным сообщением);
 *   2. попадал в тот же топик форума, где задали вопрос (message_thread_id).
 *
 * Благодаря этому обработчики команд остаются простыми: они вызывают
 * ctx.reply(...) и ничего не знают ни про топики, ни про реплаи.
 */
import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../types.js';

export const replyToSender: MiddlewareFn<BotContext> = async (ctx, next) => {
  const message = ctx.message ?? ctx.callbackQuery?.message;

  // message_thread_id есть и у обычных «тредов» в супергруппах, поэтому
  // ориентируемся именно на признак топика форума.
  const threadPart =
    message && 'is_topic_message' in message && message.is_topic_message && message.message_thread_id !== undefined
      ? { message_thread_id: message.message_thread_id }
      : {};

  // Реплаим только на сообщения пользователя. Для нажатий на кнопки
  // реплай не нужен: там ответ и так привязан к своему сообщению.
  const replyPart = ctx.message
    ? {
        reply_parameters: {
          message_id: ctx.message.message_id,
          // Если исходное сообщение успели удалить — отправим без реплая,
          // а не упадём с ошибкой.
          allow_sending_without_reply: true,
        },
      }
    : {};

  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = (text, other, signal) => originalReply(text, { ...threadPart, ...replyPart, ...other }, signal);

  const originalReplyWithPhoto = ctx.replyWithPhoto.bind(ctx);
  ctx.replyWithPhoto = (photo, other, signal) =>
    originalReplyWithPhoto(photo, { ...threadPart, ...replyPart, ...other }, signal);

  // У «печатает…» реплая быть не может — только топик.
  const originalChatAction = ctx.replyWithChatAction.bind(ctx);
  ctx.replyWithChatAction = (action, other, signal) => originalChatAction(action, { ...threadPart, ...other }, signal);

  await next();
};

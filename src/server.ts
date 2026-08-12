/**
 * Встроенный HTTP-сервер. Нужен ровно для одного — проверки живости:
 *
 *   GET /health → 200 и JSON с состоянием сервиса.
 *
 * Его дёргают docker healthcheck, systemd или внешний аптайм-мониторинг.
 * Наружу порт не публикуется (только на 127.0.0.1), домен не нужен.
 * Если проверка живости не нужна вовсе — файл можно удалить, а вызовы
 * createHttpServer/listen убрать из src/index.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Bot } from 'grammy';
import { config } from './config.js';
import { logger } from './logger.js';
import { describeProviders } from './services/registry.js';
import type { BotContext } from './types.js';

/** Отправляет JSON-ответ. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createHttpServer(bot: Bot<BotContext>): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      sendJson(res, 200, {
        status: 'ok',
        env: config.nodeEnv,
        uptimeSec: Math.round(process.uptime()),
        bot: bot.isInited() ? bot.botInfo.username : null,
        providers: describeProviders().map(({ id, ready }) => ({ id, ready })),
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

/** Запускает сервер и резолвит промис, когда порт реально занят. */
export function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off('error', reject);
      logger.info('HTTP-сервер слушает', {
        host: config.server.host,
        port: config.server.port,
        health: `http://${config.server.host}:${config.server.port}/health`,
      });
      resolve();
    });
  });
}

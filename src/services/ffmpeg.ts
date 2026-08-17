/**
 * Общая обвязка вокруг ffmpeg.
 *
 * Зависимость намеренно необязательная: бот работает и без неё, просто хуже.
 * Нужна она в двух местах, и в обоих — ради формата, а не ради содержания:
 *
 *   • озвучка (src/services/gemini-tts.ts): Gemini отдаёт сырой PCM, а
 *     Telegram принимает голосовые только в OGG/Opus;
 *   • голосовые на вход (src/services/voice.ts): Telegram отдаёт OGG/Opus,
 *     а Google в списке форматов пишет «OGG Vorbis».
 *
 * Раньше проверка и запуск жили внутри озвучки. Когда понадобились и второму
 * месту, копировать их было незачем: проверка обязана быть одна на процесс
 * (иначе в лог уедут два разных сообщения об одном и том же), а запуск
 * у обоих одинаковый — «отдать буфер на stdin, забрать буфер со stdout».
 */
import { spawn, spawnSync } from 'node:child_process';
import { logger } from '../logger.js';

/** Есть ли в системе ffmpeg. Проверяем один раз: ответ за время работы не меняется. */
let available: boolean | null = null;

export function hasFfmpeg(): boolean {
  if (available === null) {
    available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
    logger.info(
      available
        ? 'ffmpeg найден: озвучка пойдёт голосовыми, голосовые на вход — перекодированными'
        : 'ffmpeg не найден: озвучка пойдёт аудиофайлом (WAV), голосовые на вход — как есть. ' +
            'Чтобы это исправить, установите ffmpeg',
    );
  }
  return available;
}

/**
 * Прогоняет буфер через ffmpeg и возвращает результат.
 *
 * Ни временных файлов, ни диска: вход уходит в stdin, выход забирается со
 * stdout. Файлы у нас маленькие — Telegram больше 20 МБ и не отдаст, — так
 * что держать их в памяти дешевле, чем возиться с /tmp и его уборкой.
 *
 * what — что именно кодируем, для текста ошибки: «PCM → OGG/Opus».
 */
export function runFfmpeg(args: string[], input: Buffer, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);

    const chunks: Buffer[] = [];
    let stderr = '';

    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg (${what}) завершился с кодом ${code}: ${stderr.slice(0, 200)}`));
    });

    // stdin закрывается сразу: вход у нас целиком в памяти, дописывать нечего.
    ffmpeg.stdin.on('error', () => undefined);
    ffmpeg.stdin.end(input);
  });
}

# Telegram-бот на Node.js + TypeScript с нейросетями

Учебно-боевой пример телеграм-бота: несколько команд, подключение сразу нескольких
нейросетей (текст и картинки), Docker, health-check, graceful shutdown и подробные
комментарии в коде на русском языке.

* **Текст** — Google Gemini и любой OpenAI-совместимый API (OpenAI, OpenRouter, DeepSeek, Ollama…).
* **Картинки** — FusionBrain (модель Kandinsky).
* **Тестовые команды** в стиле «Марко-Поло» — чтобы за 5 секунд убедиться, что бот жив.

> **Бот работает через long polling** — сам опрашивает Telegram по исходящему
> соединению. Поэтому ему не нужны ни домен, ни белый IP, ни сертификат, ни
> проброшенные порты: он одинаково запускается дома за NAT, в WSL и на любом VPS.

---

## Содержание

1. [Команды бота](#команды-бота)
2. [Структура проекта](#структура-проекта)
3. [Шаг 0. Получаем ключи](#шаг-0-получаем-ключи)
4. [Запуск без Docker: dev](#запуск-без-docker-dev)
5. [Запуск без Docker: production](#запуск-без-docker-production)
6. [Запуск в Docker: dev](#запуск-в-docker-dev)
7. [Запуск в Docker: production](#запуск-в-docker-production)
8. [Деплой на удалённый сервер](#деплой-на-удалённый-сервер)
9. [Публикация образа в GHCR](#публикация-образа-в-ghcr)
10. [Работа в группах и топиках](#работа-в-группах-и-топиках)
11. [Разметка ответов](#разметка-ответов)
12. [Как проверить, что всё работает](#как-проверить-что-всё-работает)
13. [Переменные окружения](#переменные-окружения)
14. [Как добавить свою нейросеть](#как-добавить-свою-нейросеть)
15. [Траблшутинг](#траблшутинг)

---

## Команды бота

| Команда | Что делает |
| --- | --- |
| `/start`, `/help` | Приветствие и справка |
| `/гем <запрос>` | Запрос к Gemini. Латинский синоним — `/gem` |
| `/ask <вопрос>` | Вопрос нейросети, выбранной в `/ai` (с учётом истории диалога) |
| `/draw <описание>` | Сгенерировать картинку через FusionBrain/Kandinsky |
| `/ai` | Показать провайдеров и переключить активного кнопками |
| `/reset` | Очистить историю диалога |
| `/ping` | «Pong» + реальная задержка до Telegram API + аптайм |
| `/marco` | Отвечает `Polo!` — простейшая проверка живости |
| `/polo` | Отвечает `Marco!` |
| `/echo <текст>` | Повторяет текст слово в слово |
| `/test` | Самодиагностика: связь с Telegram + готовность провайдеров |
| `/test ai` | То же самое плюс настоящий короткий запрос к нейросети |
| `/whoami` | Ваши user id и chat id (нужны для `ADMIN_IDS`) |
| `/status` | Режим работы, аптайм, память, активные провайдеры |

Дополнительно: слово **marco** обычным сообщением (без слэша) тоже получит `Polo!`.

Обычные сообщения запросом к нейросети **не считаются** — обращаться к боту нужно
командой. Так случайная переписка не тратит квоту API.

Ответы Gemini приходят с разметкой: жирный, курсив, списки, ссылки, инлайн-код и
блоки кода с подсветкой языка (см. [Разметка ответов](#разметка-ответов)).

---

## Структура проекта

```
serverbot/
├── src/
│   ├── index.ts               # точка входа: старт polling и graceful shutdown
│   ├── bot.ts                 # сборка бота: middleware, команды, обработка ошибок
│   ├── server.ts              # маленький HTTP-сервер только с /health
│   ├── config.ts              # вся конфигурация из переменных окружения
│   ├── logger.ts              # логгер (JSON в проде, цветной в разработке)
│   ├── types.ts               # интерфейсы провайдеров, сессия, типы ошибок
│   ├── format.ts              # Markdown нейросети → разметка Telegram + нарезка
│   ├── utils.ts               # таймауты, «печатает…», длительности
│   ├── commands/
│   │   ├── basic.ts           # /start /help /ping /marco /echo /test /whoami /status
│   │   └── ai.ts              # /гем /gem /ask /draw /ai /reset
│   ├── middlewares/
│   │   ├── logging.ts         # лог каждого апдейта и времени обработки
│   │   ├── reply.ts           # ответы реплаем и в нужный топик форума
│   │   └── rateLimit.ts       # защита от спама
│   └── services/
│       ├── registry.ts        # реестр провайдеров — единственное место для новых ИИ
│       ├── gemini.ts          # Google Gemini
│       ├── openai-compatible.ts # OpenAI / OpenRouter / DeepSeek / Ollama…
│       └── fusionbrain.ts     # FusionBrain (Kandinsky), генерация картинок
├── Dockerfile                 # multi-stage: dev / build / runtime
├── docker-compose.yml         # production, сборка из исходников
├── docker-compose.dev.yml     # разработка с hot-reload
├── docker-compose.deploy.yml  # запуск готового образа из GHCR
├── .github/workflows/
│   └── docker-publish.yml     # автосборка и публикация образа в GHCR
└── .env.example               # шаблон конфигурации
```

**Главная идея архитектуры:** бот не знает, с какой нейросетью работает. Он видит только
интерфейсы `TextProvider` и `ImageProvider` из `src/types.ts`. Чтобы добавить ещё одну
модель, достаточно написать класс и вписать его в `src/services/registry.ts`.

---

## Шаг 0. Получаем ключи

### 1. Токен бота (обязательно)

1. Откройте в Telegram [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Придумайте имя и username (должен заканчиваться на `bot`).
3. Скопируйте токен вида `1234567890:AAH...`.

Полезно там же: `/setdescription`, `/setuserpic`, а для работы в группах —
`/setprivacy` → `Disable`, иначе бот не увидит обычные сообщения в группе.

### 2. Google Gemini (текст, бесплатный тариф)

Ключ: <https://aistudio.google.com/apikey> → `GEMINI_API_KEY`.

Посмотреть модели, доступные именно вашему ключу:

```bash
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" \
  https://generativelanguage.googleapis.com/v1beta/models | grep '"name"'
```

### 3. FusionBrain / Kandinsky (картинки, бесплатный тариф)

Ключи: <https://fusionbrain.ai/keys> → там выдают **пару**: `FUSIONBRAIN_API_KEY` и
`FUSIONBRAIN_SECRET_KEY`.

### 4. OpenAI-совместимый провайдер (опционально)

Любой сервис с эндпоинтом `/v1/chat/completions`: OpenAI, OpenRouter, DeepSeek,
локальная Ollama. Заполните `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`.

> Любой блок ключей можно оставить пустым — соответствующая команда просто ответит
> подсказкой, что именно нужно добавить в `.env`. Обязателен только `BOT_TOKEN`.

---

## Запуск без Docker: dev

Нужен **Node.js 20+** (проверить: `node -v`).

```bash
# 1. Зависимости
npm install

# 2. Конфигурация
cp .env.example .env
nano .env          # впишите как минимум BOT_TOKEN

# 3. Запуск с автоперезагрузкой при изменении файлов
npm run dev
```

В консоли появится:

```
INFO  Бот @your_bot инициализирован
INFO  HTTP-сервер слушает { port: 3000, health: 'http://0.0.0.0:3000/health' }
INFO  Long polling запущен
INFO  ✅ Бот готов к работе
```

Откройте бота в Telegram и отправьте `/marco` — придёт `🌊 Polo!`.

Полезные команды:

```bash
npm run typecheck   # проверить типы без сборки
npm run build       # скомпилировать TypeScript в dist/
npm start           # запустить уже собранный код
```

---

## Запуск без Docker: production

```bash
npm ci                  # ставим все зависимости: TypeScript нужен для сборки
npm run build           # компиляция src/ → dist/
npm prune --omit=dev    # опционально: выкинуть dev-зависимости после сборки
NODE_ENV=production npm start
```

Чтобы бот пережил перезагрузку сервера, оформите его как сервис systemd.

**`/etc/systemd/system/serverbot.service`:**

```ini
[Unit]
Description=Telegram AI bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/serverbot
EnvironmentFile=/opt/serverbot/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
# Немного безопасности: боту не нужен доступ ко всей файловой системе
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now serverbot
sudo systemctl status serverbot
journalctl -u serverbot -f          # логи в реальном времени
```

Альтернатива без systemd — **pm2**:

```bash
npm i -g pm2
pm2 start dist/index.js --name serverbot --time
pm2 logs serverbot
pm2 save && pm2 startup             # автозапуск после ребута
```

---

## Запуск в Docker: dev

Код монтируется с хоста, `tsx watch` перезапускает бота при каждом сохранении файла.

```bash
cp .env.example .env    # если ещё не сделали
docker compose -f docker-compose.dev.yml up --build
```

Остановить — `Ctrl+C` или:

```bash
docker compose -f docker-compose.dev.yml down
```

---

## Запуск в Docker: production

```bash
cp .env.example .env
nano .env

docker compose up -d --build      # собрать и запустить в фоне
docker compose logs -f bot        # смотреть логи
docker compose ps                 # статус и health-check
curl http://127.0.0.1:3000/health # проверка живости
```

Ответ health-check:

```json
{"status":"ok","env":"production","uptimeSec":42,
 "bot":"your_bot","providers":[{"id":"gemini","ready":true}]}
```

Управление:

```bash
docker compose restart bot        # перезапустить
docker compose down               # остановить и удалить контейнеры
docker compose up -d --build      # обновить после изменения кода
docker compose pull && docker compose up -d   # обновить базовые образы
```

Что уже сделано за вас в `Dockerfile` и `docker-compose.yml`:

* multi-stage сборка — в финальном образе нет ни исходников, ни TypeScript (~276 МБ);
* запуск от непривилегированного пользователя `node`, а не от root;
* `tini` как init — `docker stop` корректно доходит до Node, бот завершается штатно;
* `restart: unless-stopped` — переживает падение и перезагрузку сервера;
* health-check, ротация логов (3 файла по 10 МБ), лимит памяти 512 МБ;
* порт `3000` публикуется **только на 127.0.0.1** и нужен исключительно
  для health-check — снаружи бот недоступен, входящие соединения ему не нужны.

---

## Деплой на удалённый сервер

Подойдёт любой VPS с 1 ГБ RAM. Ниже — вариант «Ubuntu + Docker».

### 1. Установить Docker на сервере

```bash
ssh user@your-server-ip
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit     # перелогиньтесь, чтобы группа применилась
```

### 2. Доставить код

Вариант А — через git (удобно обновлять):

```bash
ssh user@your-server-ip
git clone <адрес-вашего-репозитория> /opt/serverbot
cd /opt/serverbot
```

Вариант Б — скопировать с локальной машины:

```bash
# node_modules и dist не копируем — они соберутся в образе
rsync -av --exclude node_modules --exclude dist --exclude .git \
      ./ user@your-server-ip:/opt/serverbot/
```

### 3. Настроить и запустить

```bash
cd /opt/serverbot
cp .env.example .env
nano .env                    # BOT_TOKEN и ключи нейросетей
docker compose up -d --build
docker compose logs -f bot
```

### 4. Обновление после изменений

```bash
cd /opt/serverbot
git pull                     # или повторный rsync
docker compose up -d --build
```

### 5. Файрвол

Боту нужны только **исходящие** соединения к `api.telegram.org` и к API нейросетей,
поэтому входящие порты открывать не нужно вообще — достаточно оставить SSH:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

> **Важно:** один и тот же токен нельзя использовать двумя запущенными ботами
> одновременно — Telegram будет отдавать ошибку `409 Conflict`. Останавливайте
> локальный `npm run dev`, пока бот работает на сервере (или заведите второго
> тестового бота у @BotFather).

---

## Публикация образа в GHCR

Готовый образ в GitHub Container Registry позволяет разворачивать бота на любой
машине одной командой — без исходников, Node.js и сборки. Нужен только Docker.

Итоговое имя образа: **`ghcr.io/jadykov/serverbot`**
(шаблон — `ghcr.io/<владелец>/<репозиторий>`, всё строчными буквами).

### Способ 1: автоматически через GitHub Actions (рекомендуется)

В репозитории уже лежит `.github/workflows/docker-publish.yml`. Он собирает
образ под **linux/amd64 и linux/arm64** и публикует его при каждом пуше в `main`.
Токен создавать не нужно — Actions использует встроенный `GITHUB_TOKEN`.

Достаточно запушить workflow в репозиторий:

```bash
git add .github/workflows/docker-publish.yml docker-compose.deploy.yml
git commit -m "Публикация образа в GHCR"
git push
```

Дальше — вкладка **Actions** в репозитории: там видно ход сборки. Первый запуск
занимает ~5 минут (arm64 собирается через эмуляцию), последующие — быстрее
за счёт кэша слоёв.

> В приватных репозиториях сборки расходуют бесплатные минуты Actions
> (2000 в месяц на бесплатном тарифе). Для публичных репозиториев Actions
> бесплатны без лимита. Если минут жалко — уберите `linux/arm64`
> из `platforms` или публикуйте образ вручную (способ 2).

Теги, которые создаёт workflow:

| Тег | Когда появляется | Пример |
| --- | --- | --- |
| `latest` | пуш в `main` | `ghcr.io/jadykov/serverbot:latest` |
| `sha-<хеш>` | каждая сборка | `ghcr.io/jadykov/serverbot:sha-0aaf4da` |
| `1.2.3`, `1.2` | git-тег `v1.2.3` | `ghcr.io/jadykov/serverbot:1.2.3` |

Выпустить версию:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

### Способ 2: вручную со своей машины

Понадобится **Personal Access Token (classic)** с правом `write:packages`:
GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic).

```bash
# 1. Логин в реестр (токен вставляется в ответ на приглашение)
docker login ghcr.io -u jadykov

# 2. Сборщик для мультиарх-образов (создаётся один раз)
docker buildx create --name multiarch --driver docker-container --use

# 3. Сборка и публикация сразу под две архитектуры
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --target runtime \
  -t ghcr.io/jadykov/serverbot:latest \
  --push .
```

Только под свою архитектуру (быстрее): уберите `--platform`.

### Сделать образ публичным

**Это обязательный шаг:** при первой публикации пакет создаётся приватным,
и `docker pull` с чужой машины вернёт `denied`.

1. Откройте профиль → вкладка **Packages** → пакет `serverbot`
   (прямая ссылка: `https://github.com/users/jadykov/packages/container/serverbot/settings`);
2. блок **Danger Zone** → **Change visibility** → **Public** → подтвердите ввод имени.

Там же, в **Manage Actions access**, стоит связать пакет с репозиторием, чтобы
последующие сборки могли его перезаписывать (обычно связывается само по метке
`org.opencontainers.image.source`).

Проверка со стороны — без логина в Docker:

```bash
docker pull ghcr.io/jadykov/serverbot:latest
```

### Развернуть на любой VM

На чистой машине нужны только Docker, файл `.env` и один compose-файл:

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit   # перелогиньтесь
```

```bash
# 2. Скопировать конфигурацию с рабочей машины
scp docker-compose.deploy.yml .env.example user@сервер:~/serverbot/
```

Репозиторий приватный, поэтому скачать файлы через `curl` с
`raw.githubusercontent.com` не получится — только `scp`, `git clone` с ключом
или просто вставить содержимое в редакторе. Если сделаете репозиторий публичным,
сработает и такой вариант:

```bash
curl -O https://raw.githubusercontent.com/jadykov/serverbot/main/docker-compose.deploy.yml
```

```bash
# 3. Ключи и запуск
cd ~/serverbot
mv .env.example .env && nano .env        # впишите BOT_TOKEN и ключи нейросетей
chmod 600 .env

docker compose -f docker-compose.deploy.yml up -d
docker compose -f docker-compose.deploy.yml logs -f
```

Обратите внимание: **сам образ публичный, а репозиторий может оставаться
приватным** — видимость пакета в GHCR настраивается отдельно от репозитория.
Ключей внутри образа нет, они подставляются из `.env` при запуске.

Обновление до свежего образа:

```bash
docker compose -f docker-compose.deploy.yml pull
docker compose -f docker-compose.deploy.yml up -d
```

Совсем без compose — одной командой:

```bash
docker run -d --name serverbot --restart unless-stopped \
  --env-file .env -e NODE_ENV=production \
  ghcr.io/jadykov/serverbot:latest
```

---

## Работа в группах и топиках

Бот полностью работает в группах и супергруппах, в том числе в форумах с топиками.

**Как добавить:** откройте группу → «Добавить участника» → найдите бота по username.
Права администратора ему не нужны.

**Куда он отвечает:** всегда туда же, где его спросили — реплаем на сообщение
с запросом и в тот же топик форума. За это отвечает `src/middlewares/reply.ts`,
который подставляет `reply_parameters` и `message_thread_id` во все ответы.
История диалога в форумах ведётся отдельно для каждого топика (ключ сессии
`chat_id:thread_id`, см. `src/bot.ts`).

**На что реагирует:** только на команды. Обычные сообщения в группе бот
игнорирует молча. Команда, адресованная другому боту (`/гем@другой_бот`),
тоже игнорируется.

### Важно: `/гем` против `/gem` в группах

Telegram считает командой только латиницу — имя `гем` API отклоняет
(`setMyCommands` → `BOT_COMMAND_INVALID`), и клиент не размечает такое слово
как команду. Отсюда практическое следствие:

| | `/gem запрос` | `/гем запрос` |
| --- | --- | --- |
| В личке | работает | работает |
| В группе с privacy mode (по умолчанию) | работает | **бот не получит сообщение** |
| В группе с отключённым privacy mode | работает | работает |
| Видна в меню команд | да | нет |

По умолчанию у бота включён privacy mode: в группах Telegram присылает ему
только команды, адресованные ему самому. Чтобы `/гем` работал и в группах:

1. @BotFather → `/setprivacy` → выберите бота → **Disable**;
2. **удалите бота из группы и добавьте заново** — без этого настройка не применится.

Проверить текущее состояние: `can_read_all_group_messages` в ответе

```bash
curl -s "https://api.telegram.org/bot<ВАШ_ТОКЕН>/getMe"
```

Если менять настройку не хочется — в группах просто используйте `/gem`.

---

## Разметка ответов

Нейросеть пишет обычный Markdown, а Telegram понимает только свой набор тегов.
Модуль `src/format.ts` конвертирует одно в другое:

| Markdown от модели | Что увидит пользователь |
| --- | --- |
| `**текст**`, `__текст__` | жирный |
| `*текст*`, `_текст_` | курсив |
| `~~текст~~` | зачёркнутый |
| `` `код` `` | моноширинный |
| ` ```js … ``` ` | блок кода с подсветкой языка |
| `[текст](https://…)` | ссылка |
| `> цитата` | блок цитаты |
| `- пункт` | `• пункт` |
| `## Заголовок` | жирная строка |

Почему конвертация именно в HTML, а не в MarkdownV2: в MarkdownV2 нужно
экранировать полтора десятка символов, и один пропущенный ломает всё сообщение.
В HTML экранируются всего три символа — `&`, `<`, `>`.

Защита от сюрпризов: если Telegram всё же отклонит разметку, бот повторит
отправку обычным текстом — пользователь получит ответ в любом случае.
Длинные ответы режутся по границам строк, причём блок кода не разрывается:
он закрывается в одном сообщении и заново открывается в следующем.

Таблиц в Telegram нет, поэтому в системном промпте модели прямо запрещены
таблицы, вложенные списки и HTML-теги (см. `src/services/gemini.ts`).

---

## Как проверить, что всё работает

По возрастанию сложности — так проще всего понять, на каком уровне сломалось:

1. **Процесс жив:** `curl http://127.0.0.1:3000/health` → `{"status":"ok",...}`
2. **Апдейты доходят:** отправьте боту `/marco` → `🌊 Polo!`
   (или просто напишите `marco` без слэша)
3. **Ответы уходят и Telegram отвечает быстро:** `/ping` → задержка в миллисекундах
4. **Текст передаётся без искажений:** `/echo привет, мир` → `привет, мир`
5. **Ключи и конфигурация на месте:** `/test` → список ✅/⚪️ по каждому провайдеру
6. **Нейросеть реально отвечает:** `/test ai` → живой запрос к модели
7. **Основной сценарий:** `/гем расскажи анекдот про программиста`
8. **Разметка:** `/гем покажи пример кода на python с пояснением` →
   должны прийти жирный текст, список и блок кода с подсветкой
9. **Картинки:** `/draw кот-космонавт, акварель`
10. **Группа:** добавьте бота в группу и отправьте `/gem привет` — ответ должен
    прийти реплаем на ваше сообщение; в форуме — в том же топике

---

## Переменные окружения

Вся конфигурация бота задаётся только переменными окружения — в коде нет ни одного
захардкоженного ключа. Читает их `src/config.ts`, там же лежат значения по умолчанию
и проверки: при неверной конфигурации бот не стартует, а печатает понятный список
проблем.

### Минимум для запуска

Обязательна ровно одна переменная — токен бота. Всё остальное включает функции:

```dotenv
BOT_TOKEN=1234567890:AAH...          # обязательно, от @BotFather
GEMINI_API_KEY=AIza...               # чтобы работали /гем и /ask
FUSIONBRAIN_API_KEY=...              # чтобы работал /draw
FUSIONBRAIN_SECRET_KEY=...
```

Если ключа нейросети нет, бот всё равно запустится: команда просто ответит
подсказкой, чего не хватает. Проверить, что видит бот, — команда `/test`.

### Четыре способа передать переменные

**1. Файл `.env` — разработка и docker compose**

Самый частый вариант. Файл лежит рядом с `package.json`, в git не попадает.

```bash
cp .env.example .env
nano .env
npm run dev        # dotenv подхватит файл автоматически
```

Compose-файлы (`docker-compose.yml`, `.dev.yml`, `.deploy.yml`) читают тот же
`.env` через `env_file` — отдельно ничего настраивать не нужно.

**2. Флаги `docker run`**

```bash
docker run -d --env-file .env \
  -e LOG_LEVEL=debug \
  ghcr.io/jadykov/serverbot:latest
```

Значение из `-e` перекрывает значение из `--env-file`.

**3. systemd — запуск без Docker**

```ini
[Service]
EnvironmentFile=/opt/serverbot/.env
Environment=NODE_ENV=production
```

**4. Секреты CI/облака**

В GitHub Actions, Kubernetes, Fly.io и т.п. переменные подставляются платформой.
Ничего менять в коде не нужно: приложение просто читает `process.env`.

### Правила синтаксиса `.env`

```dotenv
# комментарий
BOT_TOKEN=1234567890:AAH...      # без кавычек и без пробелов вокруг =
ADMIN_IDS=111111111,222222222    # список — через запятую, без пробелов
GEMINI_THINKING=                 # пустое значение = «не задано»
```

Частые ошибки: пробелы вокруг `=` (`BOT_TOKEN = 123` не сработает), кавычки
вокруг значения (попадут внутрь строки), перевод строки в середине токена
после копирования.

### Безопасность

* `.env` перечислен в `.gitignore` и в `.dockerignore` — он **не попадает
  ни в репозиторий, ни внутрь образа**. Образ можно публиковать публично:
  ключей в нём нет, они подставляются при запуске контейнера.
* На сервере ограничьте доступ к файлу: `chmod 600 .env`.
* Ключ утёк — отзовите его (@BotFather → `/revoke`, AI Studio → удалить ключ)
  и просто перезапустите контейнер с новым значением.

### Полный список

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `BOT_TOKEN` | — | **Обязательно.** Токен от @BotFather |
| `DROP_PENDING_UPDATES` | `true` | Игнорировать апдейты, накопившиеся за простой |
| `SERVER_HOST` / `SERVER_PORT` | `0.0.0.0` / `3000` | Адрес HTTP-сервера с `/health` |
| `GEMINI_API_KEY` | — | Ключ Google Gemini |
| `GEMINI_MODEL` | `gemini-flash-latest` | Модель Gemini (алиас или закреплённая версия) |
| `GEMINI_THINKING` | — | «Размышления»: число (бюджет токенов, Gemini 2.5) или `minimal`/`low`/`medium`/`high` (Gemini 3.x). Пусто — параметр не отправляется |
| `OPENAI_API_KEY` | — | Ключ OpenAI-совместимого API |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Базовый URL этого API |
| `OPENAI_MODEL` | `gpt-4o-mini` | Модель |
| `FUSIONBRAIN_API_KEY` | — | Ключ FusionBrain |
| `FUSIONBRAIN_SECRET_KEY` | — | Секрет FusionBrain |
| `FUSIONBRAIN_WIDTH` / `_HEIGHT` | `1024` | Размер картинки |
| `ADMIN_IDS` | — | ID админов через запятую (узнать: `/whoami`) |
| `RATE_LIMIT_MAX` | `15` | Запросов на пользователя за окно |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Длина окна, мс |
| `HISTORY_LIMIT` | `10` | Сообщений диалога в контексте (`0` — без истории) |
| `AI_TIMEOUT_MS` | `90000` | Таймаут запроса к нейросети |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## Как добавить свою нейросеть

1. Создайте `src/services/my-ai.ts` и реализуйте интерфейс `TextProvider`
   (или `ImageProvider`) из `src/types.ts`:

```ts
export class MyProvider implements TextProvider {
  readonly id = 'myai';
  readonly title = 'Моя нейросеть';
  readonly setupHint = 'Добавьте MYAI_API_KEY в .env';

  get isConfigured(): boolean {
    return Boolean(process.env.MYAI_API_KEY);
  }

  async generateText(prompt: string): Promise<string> {
    /* запрос к вашему API */
    return 'ответ';
  }
}
```

2. Добавьте её в массив в `src/services/registry.ts`:

```ts
export const textProviders: TextProvider[] = [
  new GeminiProvider(),
  new OpenAiCompatibleProvider(),
  new MyProvider(),   // ← новая строка
];
```

Всё: провайдер появится в `/ai`, `/status` и `/test`, а `/ask` сможет на него
переключиться. Менять команды не нужно.

---

## Траблшутинг

**`409 Conflict: terminated by other getUpdates request`**
С одним токеном запущено два экземпляра бота. Остановите лишний
(`docker compose down`, `pm2 stop`, локальный `npm run dev`) и подождите ~1 минуту.

**`401 Unauthorized`**
Неверный, отозванный или обрезанный `BOT_TOKEN`. Проверьте его в `.env`
(без кавычек и пробелов), при необходимости получите новый: @BotFather → `/mybots`.

**Бот запустился, но молчит**
Если на этом токене когда-то настраивали приём апдейтов по HTTP-адресу, Telegram
не отдаст их через `getUpdates`. Бот на старте сам сбрасывает такую настройку
(`deleteWebhook` в `src/index.ts`), проверить можно так:
`curl "https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo"` — поле `url` должно быть пустым.

**В группе не работает `/гем`, а `/gem` работает**
Ожидаемое поведение: кириллица не является командой для Telegram, и при
включённом privacy mode такое сообщение боту просто не доставляется.
Решение — см. [Работа в группах и топиках](#работа-в-группах-и-топиках).

**В группе бот не реагирует на обычные сообщения**
Так и задумано: в группах бот отвечает только на команды, иначе он вклинивался бы
в каждую беседу (см. конец `src/commands/ai.ts`).

**`Gemini отклонил запрос (400): Request contains an invalid argument`**
Модель не понимает какой-то параметр запроса. Практически всегда виноват
`GEMINI_THINKING`: у Gemini 2.5 «размышления» задаются числом (`thinkingBudget`),
у Gemini 3.x — уровнем (`thinkingLevel`), и значение «не от того поколения»
модель отвергает. Оставьте `GEMINI_THINKING` пустым — тогда параметр не
отправляется вовсе и запрос корректен для любой модели.

**`Модель «...» недоступна для вашего ключа` (404)**
Опечатка в `GEMINI_MODEL` либо модель вывели из обращения — Google периодически
закрывает старые версии («no longer available to new users»). Посмотрите
актуальный список (команда в разделе про ключи) или поставьте плавающий алиас
`gemini-flash-latest`.

**`Gemini отклонил ключ` / запросы к Gemini не проходят**
Проверьте ключ в [AI Studio](https://aistudio.google.com/apikey). Учтите, что
Gemini API доступен не во всех странах — на сервере в неподдерживаемом регионе
запросы будут падать по таймауту или с ошибкой доступа. Решение: сервер в
поддерживаемом регионе либо использование OpenAI-совместимого провайдера.

**FusionBrain: «не принял задачу» или долгое ожидание**
На бесплатном тарифе есть дневной лимит и общая очередь — генерация иногда занимает
до минуты. Увеличьте `AI_TIMEOUT_MS`. Ошибка про цензуру означает, что промпт
заблокирован фильтром сервиса — переформулируйте.

**Внутри Docker не срабатывает hot-reload**
Раскомментируйте `CHOKIDAR_USEPOLLING: "true"` в `docker-compose.dev.yml`
(типично для WSL2 и сетевых файловых систем).

**`Ошибки конфигурации: BOT_TOKEN не задан`**
Нет файла `.env` рядом с `package.json` либо переменная пустая.
`cp .env.example .env` и заполнить.

**Слишком много логов / слишком мало**
`LOG_LEVEL=debug` покажет каждый апдейт и тайминги запросов к нейросетям,
`LOG_LEVEL=warn` оставит только проблемы.

---

## Шпаргалка

```bash
npm run dev                                        # разработка локально
npm run build && npm start                         # прод локально
docker compose -f docker-compose.dev.yml up --build  # разработка в Docker
docker compose up -d --build                       # прод в Docker
docker compose logs -f bot                         # логи
curl http://127.0.0.1:3000/health                  # проверка живости
```

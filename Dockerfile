# syntax=docker/dockerfile:1
#
# Многостадийная сборка. Стадии:
#   deps      — установка всех зависимостей (включая dev);
#   dev       — образ для разработки с hot-reload (tsx watch);
#   build     — компиляция TypeScript в dist/;
#   prod-deps — только production-зависимости;
#   runtime   — итоговый лёгкий образ (без исходников и без TypeScript).
#
# Собрать прод-образ:  docker build -t serverbot .
# Собрать dev-образ:   docker build --target dev -t serverbot:dev .

# ------------------------------------------------------------------ base
FROM node:22-alpine AS base
WORKDIR /app
# tini — минимальный init-процесс. Он корректно пробрасывает сигналы
# (SIGTERM от `docker stop`) в Node и не оставляет процессов-зомби.
RUN apk add --no-cache tini
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# ------------------------------------------------------------------ deps
FROM base AS deps
# Копируем только манифесты: слой с зависимостями будет переиспользоваться,
# пока package.json не изменится, — это сильно ускоряет пересборку.
COPY package.json package-lock.json* ./
# npm ci нужен package-lock.json; если его нет — откатываемся на npm install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ------------------------------------------------------------------- dev
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
# Исходники в этой стадии обычно монтируются томом (см. docker-compose.dev.yml),
# поэтому изменения в src/ подхватываются без пересборки образа.
CMD ["npm", "run", "dev"]

# ----------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------- prod-deps
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# --------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
# В образе node уже есть непривилегированный пользователь `node`.
# Запускать контейнер от root — плохая привычка.
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

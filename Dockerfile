# Базовый образ уже содержит Node.js, Chromium и все системные зависимости
# для Playwright — не нужно отдельно ставить браузер и библиотеки для Linux.
# ВАЖНО: версия тега должна совпадать с версией @playwright/test из
# package-lock.json, иначе Playwright не найдёт браузер внутри контейнера.
ARG PLAYWRIGHT_VERSION=1.61.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]

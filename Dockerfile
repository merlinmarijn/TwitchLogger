# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY public ./public
COPY shared ./shared
COPY src ./src
COPY convex ./convex
COPY worker ./worker

RUN npm run build

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production \
    WORKER_PORT=8787 \
    TWITCH_TOKEN_STORE_PATH=/data/twitch-tokens.enc

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node shared ./shared
COPY --chown=node:node worker ./worker

RUN mkdir -p /data \
    && chown node:node /data

USER node

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.WORKER_PORT || '8787') + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "--import", "tsx", "worker/index.ts"]

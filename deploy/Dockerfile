# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@12.14.0

FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/game-sdk/package.json ./packages/game-sdk/
COPY packages/game-client/package.json ./packages/game-client/
COPY packages/platform/package.json ./packages/platform/
COPY packages/db/package.json ./packages/db/
COPY packages/ui/package.json ./packages/ui/
COPY packages/game-harness/package.json ./packages/game-harness/
COPY games/test-counter/package.json ./games/test-counter/
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN pnpm build

FROM base AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM base AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
CMD ["node", "apps/worker/dist/index.js"]

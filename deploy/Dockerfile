# syntax=docker/dockerfile:1
# The index pin retains amd64/arm64 support; Debian/glibc matches §8 and Argon2 prebuilds.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base
WORKDIR /app

FROM base AS dependencies
RUN npm install -g pnpm@12.14.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
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
COPY games/crossword/package.json ./games/crossword/
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN pnpm build

# Deploy each executable with its locked production workspace dependency closure.
# pnpm 12 deploy supports linked workspaces without changing workspace settings.
FROM builder AS production
RUN pnpm --filter @next-round/api --prod deploy /runtime/apps/api \
    && pnpm --filter @next-round/worker --prod deploy /runtime/apps/worker

# Workspace packages do not define publish files lists. Keep their runtime exports
# only; do not prune third-party source directories that may be executable code.
RUN node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const keep = new Set(["package.json", "dist", "migrations", "node_modules", "LICENSE", "NOTICE"]);
function cleanDist(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__mocks__"].includes(entry.name)) fs.rmSync(file, { recursive: true });
      else cleanDist(file);
    } else if (/\.(test|spec)\.|\.map$|\.d\.[cm]?ts$/.test(entry.name)) {
      fs.rmSync(file);
    }
  }
}
function cleanWorkspacePackages(directory) {
  const manifest = path.join(directory, "package.json");
  if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name?.startsWith("@next-round/")) {
    for (const entry of fs.readdirSync(directory)) {
      if (!keep.has(entry)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
    const dist = path.join(directory, "dist");
    if (fs.existsSync(dist)) cleanDist(dist);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) cleanWorkspacePackages(path.join(directory, entry.name));
  }
}
cleanWorkspacePackages("/runtime");
NODE
RUN mkdir -p /runtime/packages \
    && ln -s ../apps/api/node_modules/@next-round/db /runtime/packages/db

FROM base AS app
ENV NODE_ENV=production
# Runtime needs node, not package managers, headers, or upstream build tooling.
RUN rm -rf /usr/local/lib/node_modules /usr/local/include/node /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=production /runtime/ ./
# The API's default static root is /app/public; retain the built SPA/game assets.
COPY --from=builder /app/apps/web/dist/ ./public/
# API and worker module loaders resolve immutable clients relative to their
# compiled entrypoints. Retain that build layout as well as the SPA static root;
# include shared chunks so both copies come from the same complete web build.
COPY --from=builder /app/apps/web/dist/ ./apps/web/dist/
# Keep application and audited third-party attribution available in the image.
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY third_party/ ./third_party/
USER node:node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

# Next Round

Next Round is a self-hosted, open-source platform for turn-based games with friends or solo, complete with match history, detailed results, and instance leaderboards.

- **License:** [Apache-2.0](LICENSE)
- **Slug:** `next-round`
- **Repository:** `lewismatt/next-round`
- **Specification:** [docs/spec/master-spec.md](docs/spec/master-spec.md) (Master Specification v1.2)

---

## Architecture & Technology Stack

Next Round is organized as a pnpm TypeScript monorepo:

- **Runtime & Tooling:** Node.js 24 LTS, pnpm 12.14+, TypeScript 7
- **API & Live Invalidation:** Fastify 5, `@fastify/websocket` (native WebSockets), TypeBox 0.34 JSON Schema validation, Argon2 password hashing
- **Persistence & Background Jobs:** PostgreSQL 18.6 / 17, Drizzle ORM, `pg-boss` for durable background jobs, outbox invalidation, and deadline reconciliation
- **Web Frontend:** React 19, Vite 8, React Router 8, TanStack Query 5, Tailwind CSS v4, shadcn UI (Radix UI base)
- **Deployment & Proxy:** Caddy 2.11 (HTTPS / WebSocket proxy), Docker Compose
- **Testing:** Vitest, Playwright, TSX

### Monorepo Structure

```plain text
apps/
  api/                 Fastify composition; HTTP/WS adapters
  web/                 Platform shell; routes, theme, and module loader
  worker/              Jobs, reconciliation, retention, and projection runner
packages/
  contracts/           JSON Schemas, API types, error codes, OpenAPI export
  game-sdk/            Server hook types, manifests, validators (SDK next-round-game/0.1)
  game-client/         Browser bridge and typed hooks for game renderers
  platform/            Auth, access, match transactions, and shared services
  db/                  Drizzle definitions, reviewed SQL migrations
  ui/                  Platform shadcn UI components, CSS variables, theme tokens
  game-harness/        Simulated clients, clock controls, and fault injection
games/
  test-counter/        Minimal internal SDK test game fixture
  crossword/           First full game module (bundled after harness gate)
deploy/
  docker-compose.yml   Reproducible multi-service Compose configuration
  Caddyfile            Reverse proxy configuration (HTTPS & WebSocket upgrade)
  Dockerfile           Multi-stage container build for API and Worker
docs/
  spec/                Master specifications and Architecture Decision Records (ADRs)
```

---

## Quickstart & Local Development

### Prerequisites

- Node.js 24.22.0+ (LTS)
- pnpm 12.14.0+
- Docker and Docker Compose

### Install Dependencies

```bash
pnpm install --frozen-lockfile
```

### Typecheck and Build

```bash
pnpm typecheck
pnpm build
```

### Run with Docker Compose

```bash
cp deploy/.env.example deploy/.env
# Generate POSTGRES_PASSWORD, SESSION_SECRET and SETUP_TOKEN locally (see below).
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

Populate the three blank secrets in `deploy/.env` with independently generated
values from `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`.
Run it separately for each secret. Keep the file private (`chmod 600 deploy/.env`)
and out of Git. Blank secrets prevent Compose startup. The API also rejects missing
or short `SESSION_SECRET` and `SETUP_TOKEN` values before listening. `SETUP_TOKEN`
is the spec's canonical name; replace the old scaffold's `SETUP_SECRET` key.
This scaffold does not yet implement admin bootstrap. F1 will consume the setup
token and permit its removal after successful initialization.

For direct local API/worker startup, load the environment explicitly (for example,
`node --env-file=deploy/.env apps/api/dist/index.js`) and supply `DATABASE_URL`.
Use a URL-safe generated database password such as the hex value above.

The API ignores forwarded headers by default. For a custom proxy, `TRUST_PROXY`
accepts only comma-separated IP addresses/CIDRs you control; `true`, wildcard and
all-address ranges are rejected. Compose gives Caddy a stable private address and
trusts only that address; its API port is not published. If `172.30.0.0/24` conflicts
with your network, change `PROXY_SUBNET` and `CADDY_PROXY_IP` together. Caddy must
remain the only service assigned that address. Keep direct API access private.

Rotating `SESSION_SECRET` invalidates cookie signatures and any application MACs
derived from it (including future CSRF tokens); opaque session-token digests remain
unchanged. Treat rotation as a sign-in refresh for clients and restart API nodes
together. `SETUP_TOKEN` is independent and must never be reused as the session key.

---

## Agent and Contributor Guidelines

- Autonomous agents and contributors MUST read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before modifying code.
- Live work claims and phase gates are tracked in the [Next Round Planning Hub & Work Tracker](https://app.notion.com/p/Next-Round-Planning-Hub-3fd972a22c7581f689b3dde8783df72d).

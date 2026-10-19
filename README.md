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
  Dockerfile           Shared application image for migrations, API and worker
docs/
  spec/                Master specifications and Architecture Decision Records (ADRs)
```

### Installed manifest validation

`GameRegistry` validates manifest structure with the authoritative TypeBox
`GameManifestSchema`, then checks exact SemVer versions (no build metadata),
mode-ID uniqueness, player-count ordering, and `platformRange` against the
running `@next-round/platform` package version. Unknown manifest/configuration
properties are rejected; schema records retain their JSON Schema keywords.
Standalone `validateGameManifest(input)` checks structure and cross-field rules;
pass a platform version as its second argument to also enforce compatibility.

Every `(id, version)` may be registered only once, including identical repeated
registrations. Duplicate or incompatible registrations throw before changing
installed entries or the default version. Publish changed code/assets under a new
version; new versions coexist and `isDefault` selects the default on installation.
These registry checks do not establish asset-hash, retained-history, or complete
startup-readiness acceptance; those remain separate platform integration work.

### HTTP/WS game harness

`@next-round/game-harness` is a Node-only API client. It authenticates registered
accounts through `/api/v1/auth/login`, redeems guest invitations through the
documented HTTP endpoint, and uses the returned cookie and CSRF token. Account
seeding belongs in an isolated test service supplied as `provisionRegistered`;
the harness has no public signup or invented sessions. `addSession` attaches an
already authenticated device; devices sharing a principal remain separate clients.

The current API serves health routes only. Authentication, match transactions,
authorized snapshots and `/api/v1/live` are prerequisites for platform acceptance.
Missing routes fail instead of producing local receipts or snapshots. The harness
network tests use a test-only protocol server, not a replacement platform or
evidence of PostgreSQL/F1 acceptance.

After building, a service fixture can use the compiled client against its API:

```typescript
import { HarnessEnvironment } from "./packages/game-harness/dist/index.js";

const env = new HarnessEnvironment({ baseUrl: "http://localhost:3000" });
try {
  const host = await env.createRegisteredClient({
    username: "harness_host",
    displayName: "Harness host",
    password: process.env.HARNESS_PASSWORD, // Existing fixture account; never committed.
  });
  const { matchId } = await host.createMatch(
    "test-counter", "solo", { target: 2, turnSeconds: null }
  );
  await host.startMatch(matchId, (await host.getSnapshot(matchId)).revision);
  await host.connectWs();
  const original = {
    commandId: crypto.randomUUID(),
    expectedRevision: (await host.getSnapshot(matchId)).revision,
    type: "add",
    payload: { amount: 1 },
  };
  await host.act(matchId, original);
  await host.replayCommand(matchId, original);
} finally {
  env.reset();
}
```

Match mutations require explicit expected revisions. Replay sends the original
command ID, revision and payload; stale intentions are never retried automatically.
WS carries invalidation only. Acknowledged subscriptions and explicit reconnects
fetch authorized HTTP snapshots; revocation clears cached private views and rejects
late reads. Call `onSnapshot` to observe a scope, and inspect `receivedErrors` or
supply `onError` for asynchronous failures. Disconnect/reconnect is explicit so a
fixture controls when recovery happens.

`injectPostCommitFailure(matchId)` discards a successful HTTP response in the
client, allowing a response-loss retry scenario. It does not inject a database
failure or prove commit atomicity. `delayRoute` delays the matching HTTP route.
Notify suppression and listener disconnect require `serverFaults` callbacks wired
to real isolated test services; without them those methods throw. Clock controls
are local injectable services, never production endpoints. Neither reset nor
disconnect deletes server data or sends a leave command.

The Node transport pins `ws@8.22.0` (already used by the API plugin) and
`@types/ws@8.18.1`. It needs cookie/Origin upgrade headers that the browser
WebSocket constructor does not expose. Browser code still uses native WebSockets
and must not import this package.

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
pnpm build
pnpm typecheck
```

### Run with Docker Compose

```bash
cp deploy/.env.example deploy/.env
# Generate POSTGRES_PASSWORD, SESSION_SECRET and SETUP_TOKEN locally (see below).
docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build
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

### Production image and architecture pins

`deploy/Dockerfile` uses the immutable multi-architecture index for
`node:24.22.0-bookworm-slim`, correcting the initial Alpine scaffold to the
Debian-based runtime required by specification §8. PostgreSQL and Caddy likewise
pin multi-architecture indexes rather than amd64 child manifests. Exact digests
and upstream attribution are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
An index selects the host architecture; it is not evidence that the application
has been exercised on every architecture in that index.

API, worker and migration commands share one production image and run as the
unprivileged `node` user (UID/GID 1000). Build tooling and development dependencies
stay in build stages. The runtime retains compiled application/workspace code,
production dependencies, browser assets, reviewed migrations and license notices.
The root `.dockerignore` excludes local environment files, Git metadata, host
dependencies and build outputs; generate secrets only in the operator environment,
never as image build arguments or copied application files.

### Database migrations and upgrades

Compose builds `next-round-app:local` once for `migrate`, API and worker. The image
contains the compiled migration CLI and reviewed SQL with Drizzle metadata in
`packages/db/migrations`. The one-shot `migrate` service waits for PostgreSQL
health, then runs `node packages/db/dist/migrate-cli.js`. API and worker require
both a healthy database and successful migration completion. A nonzero migration
exit prevents their startup. This does not stop processes that were already
running, so stop the application services before an upgrade.

The pinned PostgreSQL 18 image mounts `pgdata` at `/var/lib/postgresql`, with
major-specific data beneath it. Do not mount it at the older
`/var/lib/postgresql/data` path. If a previous deployment populated a volume at
that older path, preserve it and use a reviewed backup/restore or PostgreSQL
upgrade procedure; changing the mount is not a data migration.

Run these commands from the repository root for each upgrade, after taking a
backup and retaining the previous compatible application image:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml stop caddy api worker
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build &&
  docker compose --env-file deploy/.env -f deploy/docker-compose.yml rm -f migrate &&
  docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

Removing only the `migrate` container intentionally reruns it on every upgrade,
even when an earlier container exited successfully. It does not remove database
volumes. Inspect failures with
`docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs migrate`.
Do not bypass dependencies or start API/worker manually after a failed migration.

For a local build outside Compose, export `DATABASE_DIRECT_URL` or `DATABASE_URL`
in the shell, then run:

```bash
pnpm build
pnpm --filter @next-round/db migrate
```

Alternatively, load the local env file explicitly:
`node --env-file=deploy/.env packages/db/dist/migrate-cli.js`.
The CLI prefers a nonblank `DATABASE_DIRECT_URL`, otherwise it uses `DATABASE_URL`.
Both must name the same application database if both are set. The migration role
needs permission to create and update the `next_round` and `pgboss` schemas.
Use a direct connection that preserves the PostgreSQL session, not a
transaction-pooled endpoint. Compose constructs `DATABASE_URL` from `POSTGRES_*`;
its optional `DATABASE_DIRECT_URL` must use a hostname reachable from the
container, such as `postgres`, rather than the host's `localhost`.

The runner holds a session advisory lock while checking and applying ordered SQL
and explicitly migrating pg-boss. Concurrent runners wait for that lock.
`next_round.schema_migrations` records immutable versions and SQL checksums.
Already applied SQL is checked rather than reapplied. Changed, missing or
reordered applied migrations fail instead of silently accepting drift. Keep
applied SQL and metadata unchanged and add a new reviewed migration for changes.
The CLI exits nonzero on configuration, connection, checksum or migration errors.
Do not use Drizzle schema push in production or delete ledger entries to bypass
an error.

Keep all database writers stopped during upgrades, including processes outside
Compose. Application SQL and its ledger commit together, but the pg-boss upgrade
is separate and may build indexes concurrently. The whole upgrade is not atomic.
An index build failure can leave pg-boss's schema version committed with a missing
or invalid index. The runner rejects detected pg-boss schema drift on later runs.
Inspect the pinned pg-boss version's public `getConstructionPlans` and
`getMigrationPlans` output and repair the affected indexes before retrying, or
restore a compatible backup. The CLI intentionally reports generic errors without
database credentials or raw server diagnostics.

Back up PostgreSQL consistently before destructive migrations. Retain the matching
application image, private env file and Caddy data/config with the backup.
Copying raw files from a running PostgreSQL data directory is not a consistent
backup method. Recovery may require restoring the database and its compatible
application image together. Starting an older image against a newer schema is
not a rollback, and reverse migrations are not assumed. PostgreSQL major upgrades
remain a separate operator procedure.

### Real PostgreSQL migration checks

The integration command requires `TEST_DATABASE_URL` for a disposable PostgreSQL
instance. Its role must be able to create and drop isolated test databases.
Never point it at a production server. CI uses PostgreSQL `18.6-alpine` and
`17-alpine`, runs the migration CLI, then runs the same integration command.
To exercise both locally after `pnpm install --frozen-lockfile` and `pnpm build`:

```bash
(
  set -eu
  for version in 18.6-alpine 17-alpine; do
    docker run --detach --rm --name next-round-migration-test \
      -e POSTGRES_DB=next_round -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
      -p 127.0.0.1:55432:5432 "postgres:$version"
    trap 'docker stop next-round-migration-test' EXIT
    until docker exec next-round-migration-test pg_isready -U postgres -d next_round; do
      sleep 1
    done
    export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/next_round
    DATABASE_DIRECT_URL="$TEST_DATABASE_URL" pnpm --filter @next-round/db migrate
    pnpm --filter @next-round/db test:integration
    docker stop next-round-migration-test
    trap - EXIT
  done
)
```

Record the exact server versions and command results when running these checks.
These commands are not evidence that the F0 gates passed. Migration coverage alone
does not establish the remaining F0 runtime feasibility checks (including Argon2
on the deployment image and pg-boss job/transaction behavior), F1 transactional
acceptance on both PostgreSQL majors, or a demonstrated backup restore.

---

## Agent and Contributor Guidelines

- Autonomous agents and contributors MUST read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before modifying code.
- Live work claims and phase gates are tracked in the [Next Round Planning Hub & Work Tracker](https://app.notion.com/p/Next-Round-Planning-Hub-3fd972a22c7581f689b3dde8783df72d).

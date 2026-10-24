# Next Round

Next Round is a self-hosted, open-source platform for turn-based games with friends or solo, complete with match history, detailed results, and instance leaderboards.

- **License:** [Apache-2.0](LICENSE)
- **Slug:** `next-round`
- **Repository:** `lewismatt/next-round`
- **Specification:** [docs/spec/master-spec.md](docs/spec/master-spec.md) (Master Specification v1.2)

## Current implementation

This is a development build, not a production release. The platform
implements bootstrap/password sessions, shared PostgreSQL credential budgets,
invitation/guest admission, chat, notifications, revisioned match commands,
private views, final results and career projections. State, deadlines, receipts
and worker effects commit transactionally; native WebSocket invalidations and
per-node PostgreSQL recovery sweeps drive authorized snapshot refreshes.

The basic browser shell supports sign-in, Home, match creation/admission,
immutable pinned game clients through `GameBridge`, shared panels, explicit
leave and results. Test Counter remains internal/operator-disabled by default.
The development CLI supervises real API/worker processes and exercises both
solo and group games. [Sprint 4 evidence](docs/sprint4-evidence.md) distinguishes
the browser journey, login budgets and composed H1–H6 evidence from integration.

The crossword module now exists as a working game: the content/import contract,
the turn, scoring, reveal, exposure and disabled-member rules, and a browser
client that plays a grid. The platform stores versioned, server-private puzzle
content with public catalog metadata, pins one immutable resource version per
match, and keeps principal exposure facts per resource identity.
[Sprint 5 evidence](docs/sprint5-evidence.md) records its implementation history.
The rights-reviewed puzzles and F3/F4 close-out landed in PR #40.

The [Trivia module](docs/trivia-design.md) adds simultaneous private answers,
stable round deadlines, public reveals and bank-free final results using the
same SDK. Its original CC0 starter bank is imported through Admin; Solo/Group
setup and the pinned client are available in the browser shell. See its design
for rules, provenance, transaction/browser evidence and the SDK 0.1 verdict.
Remaining self-service session/profile routes are not claimed complete.
See [the backlog](docs/BACKLOG.md) for triaged issues.

See the [review and remaining acceptance work](docs/reviews/2026-10-19.md).
The [work tracker](https://app.notion.com/p/3fd972a22c7581eca2f7fe7fb46d593b)
owns current claims, priorities and verification evidence.

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
  crossword/           First full game module (content contract, rules, client)
deploy/
  docker-compose.yml   Reproducible multi-service Compose configuration
  Caddyfile            Reverse proxy configuration (HTTPS & WebSocket upgrade)
  Dockerfile           Shared application image for migrations, API and worker
docs/
  spec/                Approved master specification
  adr/                 Architecture Decision Records
  reviews/             Dated findings and acceptance gaps
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
registrations. Registration checks every declared client entry and CSS file
inside the supplied asset root before changing the registry. Duplicate,
incompatible, or incomplete registrations cannot appear in `GET /api/v1/games`,
`GET /api/v1/games/:gameId`, or the immutable
`/games/{id}/{version}/{asset}` routes. New versions coexist, and `isDefault`
selects the default on installation.

The internal Test Counter is excluded from the API registry by default. To load
it for development or harness work, build the workspace and set
`NEXT_ROUND_ENABLE_TEST_COUNTER=true` for the API process. The loader registers
its pinned server hooks only after validating the browser bundle emitted by the
web build.

The crossword module registers itself with the API whenever its compiled
browser client is present in the build. Its content is imported by an
administrator and stays server-private:

```sh
# Import a versioned puzzle document (admin session, CSRF, Origin required).
curl -X POST http://localhost:3000/api/v1/admin/games/crossword/import \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H "cookie: $SESSION" -H "origin: $APP_ORIGIN" \
  -d '{"commandId":"'"$(uuidgen)"'","document":{ ... }}'

# Public catalog metadata for the puzzles of one module (registered users).
curl http://localhost:3000/api/v1/games/crossword/resources -H "cookie: $SESSION"
```

An import validates the document against the module's declared import schema
and the module's own content rules (grid shape, entries, clues, rights
allowlist), then stores the private content, the public catalog metadata and
the importer's exposure fact. The same grid keeps one identity; changed clues
or metadata create a new immutable content version. A match pins one resource
version and snapshot, and every resource-bound command locks the resource
identity first, so two matches on the same puzzle cannot both miss a prior
exposure.

Trivia is also registered in API and worker builds when its compiled client is
present. Import `games/trivia/content/starter.json` via **Admin → Trivia library**,
then choose **Start a game → Trivia**. Its resource format is
`next-round.trivia/1`; settings are `{rounds, secondsPerRound}`. The platform
pins the imported bank privately. No question bank or digest is embedded in the
browser; each round exposes its question, then reveals answers at the deadline.
The bank's CC0 provenance is agent-drafted, not a human content attestation.


The API boundary validates settings and action payloads against the selected
manifest schema. Unknown fields are rejected when the schema sets
`additionalProperties: false`, before match or reducer code runs.

### HTTP/WS game harness

`@next-round/game-harness` is a Node-only API client. It authenticates registered
accounts through `/api/v1/auth/login`, redeems guest invitations through the
documented HTTP endpoint, and uses the returned cookie and CSRF token. Account
seeding belongs in an isolated test service supplied as `provisionRegistered`;
the harness has no public signup or invented sessions. `addSession` attaches an
already authenticated device; devices sharing a principal remain separate clients.
Guest clients start with their redeemed match active, including sessions attached
through `addSession`. `connectWs()` subscribes and loads that match's authorized
snapshot without an explicit listener or a second join; invalidations and reconnects
refresh it until access is revoked.

The client uses production invitation/guest admission, private snapshots,
revisioned lifecycle/action commands and safe result projections. Its native
WebSocket transport receives metadata-only invalidations and refetches each
caller's authorized view; reconnect never sends leave. Browser code must not
import this Node-only package.

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
  const { matchId } = await host.createMatch("test-counter", "solo", {
    target: 2,
    turnSeconds: null,
  });
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
All match mutation helpers accept an optional `commandId` (the final argument;
`act` takes it in its action object). Store one ID and the original arguments per
intent. Creation/invitation helpers return it alongside their result; join/start/
leave return the command receipt. If a response is lost or the transport fails,
`HarnessCommandError` exposes `commandId`, an available `matchId`, and a safe
`reason`, without retaining the payload or session credentials. Reinvoke the same
helper with that ID and unchanged arguments; no helper retries automatically.
For creation, a parsed lost response also supplies the new match ID. If no
response arrived, that ID is unknown; replay the creation command ID to recover it.

Use `env.getClients(principalId)` for all devices, or
`env.getClient(principalId, cookie)` to select a session. A principal-only lookup
throws when multiple devices match instead of silently selecting the first.

WS carries invalidation only. Acknowledged subscriptions and explicit reconnects
fetch authorized HTTP snapshots; revocation clears cached private views and rejects
late reads. HTTP 401 and ACCOUNT_DISABLED revoke every cached scope and stop
further sends; match-specific 403/404 revoke only that match. Revisionless wakeups
still trigger a read, including wakeups during an in-flight request. Lagging
snapshots retry with bounded exponential backoff (25–250 ms) within the configured
timeout; only advancing revisions are published to observers. Call `onSnapshot` to observe a scope, and inspect `receivedErrors` or
supply `onError` for asynchronous failures. Disconnect/reconnect is explicit so a
fixture controls when recovery happens.

`injectPostCommitFailure(matchId)` discards a successful HTTP response in the
client, allowing a response-loss retry scenario. It does not inject a database
failure or prove commit atomicity. `delayRoute` delays the matching HTTP route.
Notify suppression and listener disconnect require `serverFaults` callbacks wired
to real isolated test services; without them those methods throw. An optional
`testClock` must control the actual injected test service; no pretend local or
no-op system clock is supplied. The CLI's deadline-expiry control operates only
on its disposable database, never through a production endpoint. Neither reset
nor disconnect deletes server data or sends a leave command.

The Node transport pins `ws@8.22.0` (already used by the API plugin) and
`@types/ws@8.18.1`. It needs cookie/Origin upgrade headers that the browser
WebSocket constructor does not expose. Browser code still uses native WebSockets
and must not import this package.

### Real development CLI and browser fixture

After `pnpm build`, use a disposable PostgreSQL 18 or 17 instance whose role can
create databases and roles:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55418/next_round \
  node scripts/sprint4-cli.mjs --scenario

TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55418/next_round \
  SPRINT4_PORT=3100 APP_ORIGIN=http://127.0.0.1:3000 \
  node scripts/sprint4-cli.mjs --fixture
# In a second terminal:
VITE_API_PROXY_TARGET=http://127.0.0.1:3100 pnpm --filter @next-round/web dev
```

The fixture prints local-only credentials, a started match and a guest link.
Open the web address, sign in as the printed host/peer, or open the guest link.
Ctrl-C stops the supervised processes and drops the isolated database. Never
point test-service controls at production data.

Without a flag, the CLI accepts newline-delimited JSON on stdin; `--help`
documents registered/guest provisioning, create/join/start/action/finish/leave,
WS subscribe/disconnect/reconnect, retained-intent replay, post-commit response
loss, process restart and deadline expiry. `pnpm test:sprint4` composes the real
two-process recovery/version checks, shared-service scenarios and failing
private-view negative control with the CLI/game scenarios.

### Minimal game-author example

Use `games/test-counter/src/manifest.ts`, `server.ts` and `client.ts` together as
the small working example. The manifest declares exact settings/action/state/
view/result schemas and solo/group bounds. The pure synchronous server hooks
receive `RuleContext`, state and an event, returning a transition with desired
deadline identities, obligations, facts and an optional final result. They never
open a database, socket or file. Notes preserve a current obligation's key and
generation; actor changes emit a fresh generation; all-disabled play suspends
without inventing a result and reactivation restores an enabled actor.

The client exports `client.mount(element, bridge)`, reads only its authorized
snapshot, subscribes to updates, issues one UUID per explicit action, and
unsubscribes/removes its DOM on unmount. Shared chat/participants open through
the bridge. The platform mounts the pinned `/games/{id}/{version}/client.js`,
owns credentials and lifecycle commands, refreshes after stale revisions without
replaying intent, and renders final projections independently of private state.

Receipt consumers must distinguish command scopes. `game.resource.import`
receipts deliberately have null `match_id` and `committed_revision`: imports
version resources without changing a match. Match receipt queries must select
their own scope rather than treating those columns as universally populated.
Server packages importing Node built-ins declare `types: ["node"]` and the
workspace's pinned `@types/node` in their own package.

#### Second-game contract proof: simultaneous trivia

Sprint T implements the original paper review against SDK `next-round-game/0.1`.
The mapping below is now exercised by real PostgreSQL tests and the compiled
browser. [Rules, evidence and bounded SDK verdict](docs/trivia-design.md).

| Requirement | Existing contract and game-author responsibility |
| --- | --- |
| Private question bank and answers | Import immutable server-private resources. `view` returns the current question and only the viewer's submission; never copy the resource or answer digest into a view or invalidation. |
| Simultaneous submissions | `needsActionFrom` contains all enabled members still awaiting submission. Each accepted submission uses the shared transaction/revision path. A stale submission requires an authoritative refresh and explicit retry of user intent; the client cannot auto-replay it. |
| One answer per member per round | Reducer state records answers by member ID and round generation. Duplicate command receipts replay before transition; a new command cannot replace an already accepted answer. |
| Round timeout and answer reveal | One stable round deadline survives individual submissions unchanged. At expiry, the deadline event closes the round, scores answers and exposes only the now-public explanation. An action at an overdue deadline receives the platform's reconciled revision. |
| Disconnect, disabled player and late join | Disconnect never leaves. `principal_status` removes disabled obligations without invented answers; the module chooses and documents whether late joiners start next round. All-disabled suspension must preserve round progress explicitly. |
| Results after private-state pruning | `final` stores per-member scores, outcome, eligibility and public attribution; `resultView` needs no answer bank or retained submissions. `career` derives metrics from the final result. |
| Version and failure privacy | Pin exact module/assets and immutable resource version. Bump the SDK minor for a breaking contract change; use safe rule codes rather than embedding submitted answers in errors. |

No SDK change was required. Simultaneous actions do require explicit conflict
UX: an authoritative refresh and user-initiated retry, fenced to the same round.
Unknown-response retries retain their original command ID and revision. This
proves Trivia's use of SDK 0.1, not compatibility with every possible future game.

---

## Quickstart & Local Development

### Prerequisites

- Node.js 24.22.1+ (LTS)
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
and out of Git. Blank database and session secrets prevent Compose startup. The
API rejects a missing or short `SESSION_SECRET` and rejects a malformed nonblank
`SETUP_TOKEN` before listening. `APP_ORIGIN` names the one browser origin accepted
for mutations. The initial setup request consumes `SETUP_TOKEN` by committing the
singleton instance and first administrator in one transaction. Remove the token
from the environment after setup and restart the API.

For direct local API/worker startup, load the environment explicitly (for example,
`node --env-file=deploy/.env apps/api/dist/index.js`) and supply `DATABASE_URL`.
Use a URL-safe generated database password such as the hex value above.

The API and worker must load the same installed game registry. The internal
fixture is opt-in on **both** processes with `NEXT_ROUND_ENABLE_TEST_COUNTER=true`;
build first so its versioned client assets exist. Worker startup and periodic
sweeps recover overdue deadlines and undelivered outbox rows using the same
database; do not delete pending rows or pg-boss data to repair a missed wakeup.
See [transaction and recovery behavior](docs/transaction-authority.md).

Each API process opens one dedicated `LISTEN next_round_live` session through
`DATABASE_DIRECT_URL`, falling back to `DATABASE_URL`. Both URLs must name the
same database. Do not use transaction pooling for the listener. Set
`LIVE_RECONCILE_INTERVAL_MS` on API and worker processes; the default is `10000`.
Startup rejects zero, negative, fractional, non-numeric, and greater-than-86400000
millisecond values. Sweep logs include query count, database wait and total
duration. They contain no module state, chat text or notification contents.
Request URLs are redacted so rejected query-string credentials cannot enter logs.

Administrators use `GET /api/v1/admin/games` and
`PATCH /api/v1/admin/games/:id` with `{"defaultVersion":"0.2.0"}` or
`{"enabled":false}`. Mutation requests require the usual session, Origin and CSRF
checks. Install compatible code/assets and immutable `module_versions` metadata
before selecting a new default. Defaults affect only new matches; disable blocks
new creation without changing existing pins. API and worker startup refuse missing
referenced code or declared client assets, including finished-history references.
Keep old packages and metadata unless a separately reviewed migration removes all
dependencies. No runtime download or installation endpoint is provided.

Run the compiled two-process acceptance scenario on an isolated local PostgreSQL:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55418/next_round pnpm test:sprint2
```

The runner creates and drops its own database and listener role, so its database
role needs `CREATEDB` and `CREATEROLE`. It launches two API processes and a worker,
records normal delivery/refetch and missed-wakeup recovery, and proves pinned
version/disable and startup retention behavior. Faults are confined to that
temporary database and test child launchers; there are no production fault routes.

The API ignores forwarded headers by default. For a custom proxy, `TRUST_PROXY`
accepts only comma-separated IP addresses/CIDRs you control; `true`, wildcard and
all-address ranges are rejected. Compose gives Caddy a stable private address and
trusts only that address; its API port is not published. If `172.30.0.0/24` conflicts
with your network, change `PROXY_SUBNET` and `CADDY_PROXY_IP` together. Caddy must
remain the only service assigned that address. Keep direct API access private.

For a private Tailscale Serve → loopback-published Docker API deployment, Docker
DNAT presents the compose bridge gateway as the ingress peer, not `127.0.0.1`.
Inspect the API's actual network with `docker network inspect` before setting
the operator override's `TRUST_PROXY` to that **single explicit gateway IP**.
Keep the published API bind on loopback; do not trust the subnet or all proxies.
Re-check after network recreation: a changed subnet changes the gateway and
trust fails closed to shared-IP behavior. Verify real tailnet client addresses
in API logs and verify a sibling container's forged `X-Forwarded-For` is ignored.

`SESSION_SECRET` configures the cookie plugin, but current session cookies are
unsigned opaque tokens and CSRF tokens have independent digests. Rotating this
secret does not revoke existing sessions. Revoke session rows to end access;
do not rely on a secret rotation as a sign-out mechanism. `SETUP_TOKEN` is
independent and must never be reused as the session key.

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
Never point it at a production server. The API integration suite checks bootstrap,
sessions, private match views, outsider denial, raw-state route absence,
finished-result projection, command retry, and an overlapping two-session
revision conflict. CI runs it on PostgreSQL `18.6-alpine` and `17-alpine`.
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
    pnpm --filter @next-round/api test:integration
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

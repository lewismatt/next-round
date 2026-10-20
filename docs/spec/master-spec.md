# Status, authority and scope

**Approved implementation baseline v1.2 — in active implementation on `main`.** Approved 2026-10-18. Product: **Next Round**. Repository: `lewismatt/next-round`. License: `Apache-2.0`.

This is the consolidated implementation specification. Matt approved the engineering baseline, G1/P2 defaults and C1–C5 module rules on 2026-10-18 (D47–D51). “MUST” defines the approved implementation contract. Guest participation does not itself exclude registered players from career credit; this replaces the earlier draft exclusion. Architecture approval D41 remains in force. SDK contract next-round-game/0.1 stays provisional through harness/crossword integration; baseline approval does not claim completed implementation or package validation.

**Naming revision (D52):** approved 2026-10-18 — app **Next Round**, slug `next-round`, repository `lewismatt/next-round`. Supersedes the original D22 identity; associated workspace/protocol/schema identifiers are updated below before implementation. All gameplay/access/architecture decisions and the build order remain in force.

This document and Notion Page 07 carry the approved implementation baseline. Pages 01–06 summarize the same decisions; the baseline owns exact API/SDK/schema/package and acceptance details. Keep both copies synchronized. Record requirement changes with an ADR and update affected contracts/acceptance cases. Page 08 owns execution status and evidence; a merged subset does not close an acceptance row.

## Source map

| Source | Requirements carried forward |
| --- | --- |
| [01 — Product & Accounts](https://app.notion.com/p/3fd972a22c7581659576db1920698d58) | Product boundary, accounts, invitations, guests, chat, privacy, licensing. |
| [02 — Platform Experience](https://app.notion.com/p/3fd972a22c7581469600df88fcdf54d9) | Home/Games/History, same-tab match, phone navigation, setup and accessibility. |
| [03 — Technical Design](https://app.notion.com/p/3fd972a22c75813e92b1fbe0d22d4f1b) | Approved stack, SDK ownership, transactions, delivery, hosting and versions. |
| [04 — Decisions & Implementation Checks](https://app.notion.com/p/3fd972a22c7581329e1bf98bc30ef6f2) | D01–D52, approved G1/P2 decisions, current identity and implementation-check register. |
| [05 — Roadmap & Build Readiness](https://app.notion.com/p/3fd972a22c7581719968d993c090474b) | Platform/SDK → harness/test game → crossword; lean validation. |
| [06 — Crossword Module](https://app.notion.com/p/3fd972a22c758174a745d189979d7fa7) | Approved crossword gameplay, scoring, solo, exposure and release-one scope. |

All six source pages and available associated comments were reviewed. Older research alternatives and original idea text are historical; current decisions govern.

## Release boundaries

First engineering milestone: a working platform/SDK plus harness/minimal test game. First playable release: crossword plus accounts/guest entry, discovery/invitations, chat, notifications, history/statistics, administration and Compose setup.

Release one trusts operator-installed server and browser game code. No untrusted-code sandbox, browser installer, hot-loading, universal existing-game compatibility or other-language server runner is promised. Defer native apps, push, public matchmaking, federation, cross-game rankings, voice/video, puzzle editor, saved presets, avatar uploads, built-in backup/export and a full configuration CLI.

Design target: 50 accounts, 20 live connections, 10 active matches, at most 8 active participants per match. Multiple concurrent matches and devices are supported. This target and the earlier 200 ms p95 suggestion are not routine benchmark gates.

# 1. Architecture and package baseline

## Processes and ownership

Use a pnpm workspace, TypeScript ESM and a React/Vite SPA. Fastify serves `/api/v1`, `/api/v1/live`, compiled SPA files and immutable versioned game assets. A separate worker entrypoint in the same application image runs pg-boss, deadline reconciliation, outbox delivery, retention and projection jobs. Caddy terminates HTTPS. PostgreSQL is the only initial database engine; no mandatory Redis or paid service.

The platform owns identity, authorization, memberships, revision/commit control, storage, durable jobs, chat, notifications and results/projections. Modules own rules, settings, state, private views, scoring, eligibility and the play interface. Modules have no database credentials, raw HTTP response access or independent writes to shared tables through the SDK. Installed code is trusted; these are architectural boundaries, not security isolation against a malicious module.

Native WebSocket carries subscriptions/invalidation; HTTPS carries commands and authoritative snapshots. This gives one command path and explicit recovery. No [Socket.IO](http://Socket.IO) dependency. pg-boss executes jobs at least once; application uniqueness/transaction rules supply business-level deduplication.

## Exact selected pins

These versions were checked against the npm registry or upstream release information while drafting. They are **approved baseline pins, not an installed or tested lockfile**. Use exact direct versions, a committed lockfile and frozen installs; no floating `latest` in a release. Select only required packages; optional peer adapters are not automatically dependencies.

| Area | Exact baseline | Purpose |
| --- | --- | --- |
| Runtime / package manager | Node 24.22.0; pnpm 12.14.0; TypeScript 7.0.2 | LTS runtime, workspace/build types. |
| Database / proxy | PostgreSQL 18.6; Caddy 2.11.7 | Reproducible Compose reference, subject to F0 verification; not a required cloud major. PostgreSQL 17 is the initial additional portability target, pending dependency and integration evidence. |
| API | fastify 5.12.7; @fastify/websocket 11.3.4; @fastify/cookie 11.1.3; @fastify/rate-limit 11.2.1; @fastify/helmet 13.2.0; @fastify/static 10.1.6; @fastify/swagger 9.9.2 | HTTP, native WS, cookies, abuse limits, headers, SPA/assets, generated API document. |
| Contracts | @sinclair/typebox 0.34.52; semver 7.8.5 | JSON Schema and inferred TS types; package compatibility. |
| Persistence / jobs | pg 8.23.1; drizzle-orm 0.45.4; drizzle-kit 0.31.11; pg-boss 12.38.0 | Bounded pools, reviewed SQL migrations, durable work. |
| Credentials / QR | argon2 0.45.1; qrcode 1.5.4 | Password hashing; render invitation/sign-in/reset links. |
| Browser | react and react-dom 19.3.1; vite 8.3.4; @vitejs/plugin-react 6.1.2; react-router 8.4.0; @tanstack/react-query 5.104.4 | SPA, routing and server cache. |
| Shared UI | tailwindcss and @tailwindcss/vite 4.3.3; shadcn CLI 4.22.0; radix-ui 1.8.1; lucide-react 1.59.0; class-variance-authority 0.7.1; clsx 2.1.1; tailwind-merge 3.7.0 | Copy reviewed shadcn source into packages/ui; CLI is build tooling. |
| Focused tests / development | vitest 5.0.5; @playwright/test 1.64.1; tsx 4.23.15 | Rule/service cases, real browser journeys, local entrypoints. |

Use TypeBox 0.34 JSON Schema directly with Fastify's validator; do not add the newer TypeBox type-provider package with its different `typebox` peer dependency. Keep schema defaults/coercion out of command payloads; reject unknown properties. Use Fastify's Pino logger. Node's crypto supplies random bytes, SHA-256 and timing-safe comparisons; browser WebSocket is native.

At scaffold time resolve exact required type packages/transitive dependencies in the lockfile, pin container images by digest for the selected tags, and record the generated shadcn component source. Confirm build/plugin peers, Argon2 on the chosen Linux image, pg-boss migration/transaction adapter and TypeScript tool compatibility in the F0 feasibility check. If a selected package is incompatible or affected by a relevant advisory, document the exact replacement before merging the scaffold; specification approval does not prove runtime compatibility.

**PostgreSQL compatibility:** separate the exact local image pin from the application's supported database range. During F0, verify the selected pg-boss/Drizzle/pg minimums, run migrations and job/transaction smoke checks on majors 18 and 17, and record exact tested versions. F1 transactional acceptance must pass on both before advertising both as supported. Avoid major-18-only SQL, extensions or catalog assumptions unless a recorded requirement justifies raising the minimum. If the selected dependencies prevent this range, record the tradeoff and replacement/minimum-version decision rather than silently dropping portability. Managed deployment additionally checks provider permissions, direct listener connections, pooling and extension requirements. Apply supported minor/security updates through normal tested image updates; do not freeze 18.6 indefinitely. [PostgreSQL versioning](https://www.postgresql.org/support/versioning/).

Core baseline license metadata: MIT for most runtime/UI packages, Apache-2.0 for TypeScript/Drizzle ORM/Playwright/CVA, ISC for lucide/semver, PostgreSQL License for PostgreSQL, Apache-2.0 for Caddy. Inventory the actual locked transitive graph and image notices in THIRD_PARTY_NOTICES at scaffold/release; this list is not a complete license audit.

Primary references: [npm registry](https://registry.npmjs.org/), [Node releases](https://nodejs.org/en/download), [PostgreSQL versions](https://www.postgresql.org/support/versioning/), [Caddy releases](https://github.com/caddyserver/caddy/releases), [Fastify](https://fastify.dev/docs/latest/), [WebSocket plugin](https://github.com/fastify/fastify-websocket), [pg-boss](https://github.com/timgit/pg-boss), [Argon2](https://github.com/ranisalt/node-argon2), [shadcn](https://ui.shadcn.com/docs). Package versions alone are not security/performance certification.

## Repository and installed-game layout

```plain text
apps/api/                 Fastify composition; HTTP/WS adapters
apps/web/                 platform shell; routes and module loader
apps/worker/              jobs, reconciliation and projection entrypoint
packages/contracts/      JSON Schemas, API types, error codes, OpenAPI export
packages/game-sdk/       server hook types, manifests, validators
packages/game-client/    browser bridge; optional React hooks
packages/platform/       auth, access, match transaction and shared services
packages/db/             Drizzle definitions, reviewed SQL migrations
packages/ui/             platform shadcn source and theme tokens
packages/game-harness/   simulated clients, clock controls and fault injection
games/test-counter/      minimal internal SDK test game
games/crossword/          first full game, added only after harness gate
deploy/                  Compose, Caddyfile, Dockerfile, env example
docs/                    spec, ADRs, operations, game-author guide
```

Workspace package names use `@next-round/*`; packages begin at `0.1.0`. SDK contract identifier is `next-round-game/0.1`; pre-1.0 breaking changes bump the minor identifier and compatibility range explicitly.

Each game exports `./manifest`, `./server`, `./client` and optional `./setup`. Build emits validated `manifest.json`, server ESM, browser ESM/CSS/assets and checksums. Bundling must not traverse server exports into browser code. React/ReactDOM are shared peer externals resolved by the platform build. Browser UI uses the typed bridge; non-React UIs may implement the mount contract. No CDN dependency or remote runtime import.

An operator adds a reviewed package to the server build registry and redeploys API/web/worker together. Startup validates every manifest, duplicate ID/version, SDK range and asset hash; fails readiness on a missing version required by live state or retained history rendering. Metadata-only tombstones and tested platform-owned static result projections do not require executable module code. Compatibility tooling runs before deployment. Existing versions coexist under immutable asset paths `/games/{id}/{version}/{hash}/...`.

# 2. Wire contracts and game SDK

## Shared values

Every boundary accepts UTF-8 JSON only: null, booleans, finite numbers, strings, arrays and plain objects. No Date, bigint, undefined, functions, NaN or class instances. IDs are UUID strings except module IDs/versions and SHA-256 digests. Timestamps are RFC 3339 UTC strings with milliseconds. Revisions are nonnegative safe integers; database bigint revisions must be checked before conversion. JSON Schema draft-07 is the common schema dialect; contracts use `additionalProperties:false`.

Module IDs match `^[a-z][a-z0-9-]{1,62}$`; versions are exact SemVer without build metadata. Action type names match `^[a-z][a-z0-9_.-]{0,63}$`. Display names: 1–40 Unicode code points after trim; no control characters/HTML. All rendering uses text escaping.

Manifest contract:

```typescript
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, Json>; // validated draft-07 subset
interface GameManifest {
  id: string; name: string; version: string;
  sdk: "next-round-game/0.1";
  platformRange: string; stateVersion: number; resultVersion: number;
  description: string;
  modes: Array<{
    id: string; label: string; minPlayersToStart: number; maxPlayers: number;
    lateJoin: boolean; rejoin: boolean;
  }>;
  capabilities: {
    chat: boolean; deadlines: boolean; solo: boolean;
    resources: boolean; careerStats: boolean;
  };
  settingsSchema: Schema;
  resourceSchemas?: { import: Schema; metadata: Schema; data: Schema; facts: Schema };
  actionSchemas: Record<string, Schema>;
  stateSchema: Schema; viewSchema: Schema; resultSchema: Schema;
  client: { entry: string; css: string[] };
  setupEntry?: string;
}
```

Manifest schemas and client files are public; private state values/resources are not. Never embed solution values as schema examples, defaults, enum values or bundle fixtures. State/result schema versions are positive integers. Player maxima are 1–8; no global two-player minimum. Each mode defines its own minimum. Custom setup UIs still submit values validated against settingsSchema. Hooks, asset paths and module IDs are resolved from the compiled allowlist, never from arbitrary request import paths.

## Lifecycle types and hooks

```typescript
interface Member {
  id: string; principalId: string; kind: "registered" | "guest";
  displayName: string; status: "active" | "left" | "removed";
  joinOrdinal: number; disabled: boolean; accessEpoch: number;
}
interface Deadline { key: string; generation: number; dueAt: string }
interface Resource { id: string; identity: string; version: number; data: Json }
interface Fact { principalId: string; key: string; value: Json }
interface RuleContext {
  matchId: string; moduleVersion: string; mode: string;
  phase: "lobby" | "active" | "finished" | null; revision: number;
  now: string; eventId: string; // server-provided; hooks must not read wall clock
  actor: { principalId: string; memberId: string } | null;
  members: readonly Member[]; hostMemberId: string | null;
  settings: Json; resource: Resource | null; facts: readonly Fact[];
}
type GameEvent =
  | { kind: "create" }
  | { kind: "join"; memberId: string; rejoin: boolean }
  | { kind: "start" }
  | { kind: "action"; type: string; payload: Json }
  | { kind: "leave"; memberId: string; reason: "left" | "removed" }
  | { kind: "principal_status"; memberId: string; disabled: boolean }
  | { kind: "deadline"; deadline: Deadline }
  | { kind: "finish"; reason: "host_ended" };
interface FinalResult {
  outcome: "solved" | "completed" | "ended_early" | "revealed" | "abandoned";
  data: Json;
  participants: Array<{
    memberId: string; score: number; contribution: Json;
    win: boolean; careerEligible: boolean; exclusionReasons: string[];
  }>;
}
interface Transition<S extends Json> {
  state: S;
  phase: "lobby" | "active" | "finished";
  hostMemberId: string | null;
  deadlines: Deadline[]; // desired active set; same key/generation keeps stored dueAt; omit fired identity to consume, other omissions cancel
  needsActionFrom: string[]; // member IDs; not necessarily a single turn
  facts: Array<{ principalId: string; key: string; value: Json }>;
  final: FinalResult | null;
}
type RuleError = { code: string; message: string; field?: string };
interface GameServer<S extends Json, V extends Json> {
  authority(ctx: RuleContext, state: S, memberId: string): {
    canStart: boolean; canFinish: boolean; removableMemberIds: string[];
  };
  importResource?(input: Json, ctx: { principalId: string; now: string }): {
    identity: string; metadata: Json; data: Json;
    importerFacts: Array<{ key: string; value: Json }>;
  };
  transition(ctx: RuleContext, state: S | null, event: GameEvent):
    { ok: true; value: Transition<S> } | { ok: false; error: RuleError };
  view(ctx: RuleContext, state: S, viewer: {
    principalId: string; memberId: string | null;
    access: "active" | "result_only";
  }): V;
  summary(ctx: RuleContext, state: S, viewerPrincipalId: string):
    { label: string; needsAction: boolean; detail: string | null };
  resultView(ctx: RuleContext, result: FinalResult, viewerPrincipalId: string): Json;
  career(result: FinalResult): Array<{
    memberId: string; points: number; played: number; wins: number;
  }>;
  migrate?(input: {
    fromVersion: string; fromStateVersion: number; toStateVersion: number;
    state: Json; settings: Json; result: FinalResult | null;
  }): { state: S; settings: Json; result: FinalResult | null };
}
```

`transition` is a pure, synchronous reducer. Context/state inputs are read-only; no network, filesystem, timers, randomness, logging of secret values or database access. Random material, if required later, must be supplied by the platform and recorded in the command context. IDs/generations are deterministic from eventId or supplied by the platform. Validation failure has no state mutation. A valid but unsuccessful guess can be an accepted game transition consuming an attempt; this differs from a rejected malformed or unauthorized command.

Create receives null state. Join/leave hooks see the proposed membership update; failure rolls it back, except explicit departure must be supported by every module and cannot trap a user. The platform validates phase transitions, host references, player limits, deadline uniqueness, schema validity and final/result invariants before committing.

`Transition.deadlines` is the complete desired active set, not an instruction to recreate every row. For an existing pending `(key, generation)`, the platform MUST retain its stored `dueAt`, deterministic event identity and scheduling deduplication identity, even if the reducer emits a different valid `dueAt`, unless it is the identity being consumed by the applied deadline event. The emitted time applies only to a new identity. When the applied event is `{kind:"deadline", deadline}`, that pending identity is consumed by this transition, MUST NOT appear in the output, and is not cancelled by omission. Other omitted pending identities are cancelled. `[]` cancels all pending deadlines only when the event is not consuming one of them; a deadline event emitting `[]` consumes the fired identity and cancels the other pending identities. Rescheduling requires a never-used generation for that key. Duplicate keys, reuse of a consumed/cancelled identity, or re-emitting the identity being consumed are invalid module output and abort the transition with `MODULE_FAILURE` and no partial commit. Validate the entire output before any deadline status change. `RuleContext` remains unchanged; a reducer can retain an obligation by re-emitting its key/generation without reading platform deadline rows.

The pure authority hook derives start/finish/removal authority for an active member; the platform intersects it with authenticated active membership, account status and global access limits. A module may select whether a host can end and whether a timed-out member can be removed by returning a rule error. Mode start minima count active enabled members; capacity maxima count all active seats, including disabled members whose memberships are retained. Default authoring examples grant start/finish to the permanent host; games may define temporary acting-host authority explicitly. `finish` is a request; automatic completion occurs through an accepted transition's `final`. Final is required exactly when phase first becomes finished. No subsequent scoring action is accepted. No universal pass action exists: pass/continue/reveal are module action types.

Reconnect calls no mutating hook; it reauthenticates and invokes view/summary against stored state. Results/history use resultView; result-only readers never receive active/private state. Career output must match participant eligibility, registered identities and finite nonnegative integer metrics; platform stores raw results separately.

Leave cancels/replaces relevant deadlines through the reducer. If nobody remains in a lobby, finish as abandoned; if all explicitly depart an active match, finish as ended_early/abandoned as specified by the module. No automatic abandonment solely due to age or disconnection in v1. Finished matches are history; “archive” means removal of retained sensitive state under explicit retention, not a new gameplay transition.

The generic contract permits simultaneous obligations through needsActionFrom and multiple deadlines; crossword's single-turn rule does not enter platform tables. Hook exceptions or invalid output abort the transaction, log an opaque module error and return MODULE_FAILURE. Trusted reducers must stay small; a process-level timeout cannot safely preempt arbitrary synchronous code, and this version does not claim hostile-code protection.

## Shared resources and facts

For reusable content, platform storage exposes versioned server-private resource data plus explicitly public catalog metadata. A match pins an immutable resource version and content snapshot. Import handlers run server-side, validate input and return resource data/public metadata and exposure facts; they receive no database handle. Admin-only import goes through the platform permission and transaction path.

Facts use a module-defined key, resource identity and principal: for example `crossword/seen`. A module may read facts only for current/proposed members and its pinned resource; facts output targets those principals. Values are schema-validated. The platform serializes all resource-bound commands by locking the resource identity before the match row, ensuring concurrent puzzle starts cannot both miss prior exposure. Anonymous external knowledge cannot be inferred; support an explicit declaration.

Resource catalog metadata and immutable content versions have separate schemas. Test Counter declares no resource. Crossword declares its schemas in section 9. Deleted/hidden content keeps identity/fact tombstones necessary for truthful exposure and career rules.

## Client bridge and mount contract

```typescript
interface MatchSnapshot<V extends Json = Json> {
  id: string; moduleId: string; moduleVersion: string; revision: number;
  phase: "lobby" | "active" | "finished";
  mode: string; settings: Json;
  hostMemberId: string | null; members: Member[];
  deadlines: Deadline[]; serverNow: string;
  capabilities: { canStart: boolean; canLeave: boolean; canInvite: boolean;
    canFinish: boolean; canChat: boolean; canAct: boolean };
  game: V;
}
interface CommandReceipt {
  commandId: string; matchId: string; committedRevision: number;
  replayed: boolean; outcome: "accepted";
}
interface GameBridge {
  getSnapshot(): MatchSnapshot;
  subscribe(listener: (snapshot: MatchSnapshot) => void): () => void;
  act(input: { type: string; payload: Json; commandId: string;
    expectedRevision: number }): Promise<CommandReceipt>;
  refresh(): Promise<MatchSnapshot>;
  openPanel(panel: "chat" | "participants"): void;
}
interface GameClient {
  mount(element: HTMLElement, bridge: GameBridge): { unmount(): void };
}
```

The platform injects the authenticated bridge; modules cannot choose the acting principal or access raw session credentials. Generate a UUID commandId once per intent and reuse it for network retries. On stale revision refresh and let the player reconsider; never silently resubmit a guess against changed state.

Module browser drafts are local UI state, never accepted game state. Clear cached match/chat/draft data on sign-out, access revocation or guest loss. Private drafts need not survive device changes. React hooks wrap the same bridge; games do not depend directly on TanStack Query or platform components.

The platform hosts loading/error/version-unavailable states, shared panels, membership and navigation. Modules render keyboard-operable controls, visible focus, accessible status, touch targets, phone layouts and light/dark compatibility. No mandatory shadcn look inside a game. Returning Home must not send leave.

# 3. HTTPS API v1

## Common rules

Same-origin JSON API, HTTPS only outside documented [localhost](http://localhost) development. Prefix every route below with `/api/v1`. Authenticated responses use `Cache-Control: no-store`. A successful single-resource response is `{data:T,serverNow:string}`; lists use `{data:T[],nextCursor:string|null,serverNow:string}`. Default page size 25, maximum 100; opaque keyset cursors sort by creation time and UUID. No offset pagination.

Create operations return 201, commands/read/update 200, successful deletes/revocations 204. Error shape:

```json
{"error":{"code":"STALE_REVISION","message":"Refresh this match before acting.","requestId":"uuid","details":{"currentRevision":12}}}
```

Expose only authorized error detail. Use 400 INVALID_REQUEST; 401 AUTH_REQUIRED/SESSION_EXPIRED/INVALID_CREDENTIALS; 403 FORBIDDEN/ACCOUNT_DISABLED; 404 NOT_FOUND for inaccessible match/resources; 409 STALE_REVISION/IDEMPOTENCY_CONFLICT/MATCH_CLOSED/MODULE_DISABLED/CAPACITY_REACHED; 410 TOKEN_INVALID for expired/redeemed/revoked bearer links with identical public messaging; 422 RULE_REJECTED/INCOMPATIBLE_MODULE; 429 RATE_LIMITED with Retry-After; 503 MODULE_UNAVAILABLE/SERVICE_UNAVAILABLE; 500 MODULE_FAILURE/INTERNAL_ERROR. Rule errors add a namespaced ruleCode. Never include stack traces, solution data, passwords, raw tokens, private guesses or arbitrary reducer state in errors.

Commands below carry `commandId:UUID`; match-scoped mutating commands also carry `expectedRevision:integer`. These fields are denoted **Cmd**. Every accepted match mutation increments revision once, including joins/departures/status changes; chat/read markers do not. State transitions return CommandReceipt; fetch a snapshot for private feedback. New-match creation returns `{matchId,revision:0,commandId}`.

## Setup, credentials and profile

| Method / path | Request | Response / authorization |
| --- | --- | --- |
| GET /setup | None | \{configured:boolean\}; no secrets/config details. |
| POST /setup | \{setupToken,commandId,instanceName,username,password,displayName,policy\} | \{principal,instance\}; one atomic first-admin creation, consumes operator-provided setup token. |
| POST /auth/login | \{username,password\} | \{principal,csrfToken,expiresAt\}; creates registered session cookie. |
| GET /auth/session | Cookie | \{principal,permissions,csrfToken,expiresAt,guestMatchId\}; 401 when absent/expired. |
| POST /auth/logout | \{\} | 204; revoke current session. |
| POST /auth/logout-all | \{password\} | 204; registered user; revoke all sessions. |
| POST /auth/register | \{token,username,password,displayName,commandId\} | \{principal,csrfToken,expiresAt,destination\}; consume registration invite, create account/session atomically; destination is internal match ID or null. |
| POST /auth/qr/redeem | \{token,commandId\} | Same session response; existing enabled account only, one-use 15-minute token. |
| POST /auth/reset/redeem | \{token,password,commandId\} | 204; one-use 30-minute token; revoke sessions, sign-in QRs and other reset tokens; user signs in afterward. |
| GET /me | None | \{id,kind,username\|null,displayName,theme,permissions\}; guest has no username. |
| PATCH /me | \{displayName?,theme?\} | Updated profile; theme = light/dark/system; guest may edit own name. |
| POST /me/password | \{currentPassword,newPassword\} | 204; registered only; revoke other sessions and outstanding sign-in/reset tokens, rotate current session. |

Principal response is `{id,kind:"registered"|"guest",displayName,username:string|null}`. Username is normalized lowercase ASCII, 3–32 characters matching `[a-z0-9_][a-z0-9_.-]{2,31}`; unique normalized index. Password: 12–128 Unicode code points, maximum 512 UTF-8 bytes, never silently truncate or normalize. Hash with Argon2id, 64 MiB memory, 3 iterations, parallelism 1 and unique library-generated salt; store PHC string and rehash after successful login if policy changes. No email column/requirement.

Use random 256-bit opaque session tokens, stored as SHA-256 digests, not browser JWTs/localStorage. Cookie `__Host-next-round-session`: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Registered sessions have 30-day absolute and 7-day idle expiry; refresh idle expiry at most once/5 minutes without extending absolute expiry. Allow multiple devices. CSRF token bound to the session is required as X-CSRF-Token on authenticated mutations; require exact configured Origin on HTTP browser mutations and WS upgrade. Pre-auth mutation routes require exact Origin and JSON content type. CORS is disabled by default. Local HTTP development uses a separately named non-Secure cookie only on [localhost](http://localhost).

Login limits: 5 failed attempts per normalized username and 20 per source IP per 15 minutes, with generic credential errors and a dummy hash for unknown names. Token redemption: 10/minute/IP; ordinary commands: 120/minute/principal; chat: 30/minute/principal. Counters are shared PostgreSQL buckets for credential/token routes; per-process rate limiting alone is insufficient after scaling. Trusted proxy addresses are configured, never accepted from arbitrary forwarded headers.

Admin bootstrap uses an env secret provided locally, not an open “first visitor wins” flow. PostgreSQL singleton lock prevents two first admins. Clear/rotate the setup secret after completion. Preserve at least one enabled admin. Document an offline, maintenance-mode admin reset command which emits a short-lived reset URL locally; no default credentials.

## Invitations

| Method / path | Request | Response / authorization |
| --- | --- | --- |
| GET /invitations | ?status=pending | Current registered user's incoming existing-member invites, including current `matchRevision` for revisioned acceptance; no other users' bearer tokens. |
| POST /invitations/registration | \{commandId,matchId?:UUID\} | \{id,url,expiresAt\}; admin or canInviteRegistrations; one use, 7 days; match must be invitable by caller. |
| POST /matches/:id/invitations | \{commandId,recipientPrincipalId\} | \{id,expiresAt\}; registered member/host with match invite access; existing enabled registered recipient; 7 days. |
| POST /invitations/:id/accept | \{commandId,expectedRevision\} | CommandReceipt; intended recipient, atomically consumes invite and joins/rejoins match. |
| POST /invitations/:id/decline | \{commandId\} | 204; intended recipient only. |
| DELETE /invitations/:id | None | 204; inviter or admin; revocation is idempotent. |
| POST /matches/:id/guest-invitations | \{commandId\} | \{id,url,expiresAt\}; canInviteGuests plus active match invite access; G1 approved 15 minutes, one use. |
| POST /guest-invitations/redeem | \{token,displayName,commandId\} | \{principal,csrfToken,expiresAt,matchId\}; atomic guest principal/session and join; no partially consumed invite if join fails. |
| POST /match-links/resolve | \{token\} | \{matchId,title,moduleId,phase,revision,requiresSignIn\}; only safe invitation preview and current revision for joining. No membership, state, participant list or chat. |
| POST /matches/:id/link | \{commandId,rotate?:boolean\} | \{url\}; host creates/rotates reusable registered-member join link; no guest/registration authority. |
| DELETE /matches/:id/link | None | 204; host/admin revokes reusable link. |

Links carry random 256-bit bearer tokens in URL fragments, submitted by POST; remove fragments from browser history after capture, do not log token-bearing URLs. GET never consumes a token. Redemptions lock the token/invitation row; token validity and inviter permissions are rechecked in the same transaction as account/join creation. Repeating redemption from a different session fails. If the success response is lost, retry can recover only using the already issued valid session; never reissue a session to anyone merely presenting a consumed token.

Registration-to-match redemption creates an account even if the match is now full/finished: atomically create a targeted member invitation for the new principal, return destination with invitationId and join status, and allow ordinary account use. The UI then accepts that invitation through the normal join checks; a closed/full match explains why admission failed. This preserves private-match admission after consuming the registration token without bypassing capacity or module rules. Guest redemption must instead fail without creating an orphan guest when the match is unavailable. If an authenticated guest already belongs to that same match, a fresh guest invite reuses its principal/member identity for permitted rejoin; otherwise redemption creates a new identity. A retained guest session for a different match cannot be extended to this one.

A registered match link requires login and grants admission only after the module's capacity/phase/late-join checks. Open games permit enabled registered instance members; public visitors never gain access. Removed members require a fresh targeted invitation, even in open games or with an old reusable link. Invite expiry does not expire an already accepted membership.

## Catalog, matches and shared services

| Method / path | Request | Response / policy |
| --- | --- | --- |
| GET /games | None | Enabled manifest summaries; registered only. Guest can fetch only its pinned manifest. |
| GET /games/:gameId | ?version=exact | Public manifest/setup schemas for accessible enabled/pinned version. |
| GET /games/:gameId/resources | ?cursor&amp;limit | Public resource catalog metadata, never [resource.data](http://resource.data); registered only. |
| GET /matches | ?scope=mine\|open&amp;phase=lobby\|active\|finished&amp;cursor&amp;limit | Authorized summary cards; guest confined to its match. Open scope excludes private/solo matches. |
| POST /matches | \{commandId,moduleId,mode,settings,resourceId?:UUID,visibility:"invite"\|"instance"\} | New match; registered creator, enabled selected default version; solo forces private. |
| GET /matches/:id | None | MatchSnapshot; active member only. Departed/result-only users use result endpoint. |
| POST /matches/:id/join | Cmd + \{linkToken?:string\} | Open access or valid link/fresh invitation; module late-join/rejoin/capacity check. |
| POST /matches/:id/start | Cmd | Module-derived start authority; mode minimum and module validation. |
| POST /matches/:id/actions | Cmd + \{type,payload\} | Active authorized member; type/payload schema then reducer. |
| POST /matches/:id/leave | Cmd | Explicit departure; always supported; cannot be confused with navigation. |
| POST /matches/:id/members/:memberId/remove | Cmd | Module-derived removal authority and eligibility; no blanket admin gameplay kick. |
| POST /matches/:id/finish | Cmd | Module-derived finish authority; reducer records ended_early when applicable. |
| GET /matches/:id/result | None | Projected final result; retained participant entitlement including departed; P2 privacy applies. |
| GET /matches/:id/chat | ?cursor&amp;limit | Active membership with chat access only; page-ordered message projections. |
| POST /matches/:id/chat | \{commandId,text\} | \{id,createdAt\}; plain text 1–2000 code points, max 8 KiB; deduplicate per sender/match/commandId. |
| GET /notifications | ?unreadOnly=true&amp;cursor&amp;limit | Own notifications; guest only its match. |
| POST /notifications/read | \{ids:UUID\[\]\} | 204; 1–100 own IDs; idempotent. Opening list does not mark read. |
| GET /me/history | ?gameId&amp;cursor&amp;limit | Personal result summaries; solo private, guest one match. |
| GET /players/:principalId/stats | ?gameId | Registered identity career/personal projections allowed by recorded visibility. |
| GET /games/:gameId/leaderboard | ?cursor&amp;limit | Game-specific eligible registered-player totals under visibility policy; no cross-game totals. |

Only active members can read chat, including after completion while membership is retained. Leaving/removal revokes chat/history reads and live chat access immediately. Result entitlement survives departure. No general spectator active-state endpoint ships in v1. Instance-open lobby cards may show title, game, capacity and settings; private participant data is never included.

## Administration

All routes require an enabled administrator, CSRF on writes, audit records and last-admin protection.

| Method / path | Contract |
| --- | --- |
| GET /admin/users; PATCH /admin/users/:id | List users; patch \{disabled?,role?:"admin"\|"member",canInviteRegistrations?,canInviteGuests?\}. Disable revokes sessions and pending invitations, not memberships. Reactivation does not restore revoked sessions/tokens. |
| POST /admin/users/:id/sign-in-qr | \{commandId\} → \{url,expiresAt\}; 15 minutes, enabled registered account only. |
| POST /admin/users/:id/reset | \{commandId\} → \{url,expiresAt\}; 30 minutes; reissue revokes earlier reset links. |
| GET /admin/policy; PUT /admin/policy | Read versioned policy; write \{expectedVersion,policy\}. Visibility/rejoin defaults affect future matches only; retention changes require separate plan. |
| GET /admin/games; PATCH /admin/games/:id | Installed versions/status/reference counts; write \{enabled?,defaultVersion?\}. Can select only installed compatible versions. Disable blocks creation; existing matches finish. |
| POST /admin/games/:id/import | \{commandId,document:Json\}; module importer, maximum 1 MiB; returns \{resourceId,identity,version,duplicate\}. Admin-only, validates rights/schema. |
| POST /admin/matches/:id/migrate | Cmd + \{targetVersion\}; maintenance operation using reviewed migration; atomic, audit and notify members. |
| POST /admin/retention-plans; POST /admin/retention-plans/:id/execute | Preview \{scope,policyVersion,cutoff\} → \{id,counts,expiresAt\}; execute \{confirmationId\} against unchanged target/version. Details in P2. |
| POST /admin/users/:id/anonymization-plans; POST /admin/anonymization-plans/:id/execute | Preview impact and confirm same immutable plan; removes credentials/profile attribution and recomputes affected public stats without rewriting gameplay scores. |
| GET /health/live; GET /health/ready; GET /version | Liveness; database/migration/module readiness; app/API/SDK build metadata and source URL. Public output contains no secrets or internal exception traces. |

Administrative access does not automatically grant ordinary match/chat reading. Operators can access stored data by infrastructure privileges; the product makes that distinction explicit.

# 4. PostgreSQL schema v1

The definitions below are the migration contract, not executed DDL. Use schema `next_round` for application tables and a separate `pgboss` schema owned/migrated through pg-boss. All timestamps are timestamptz UTC. UUID primary keys are application-generated crypto.randomUUID values. Unless marked nullable, columns are NOT NULL. Append created_at to entity tables and updated_at to mutable entities. Foreign keys use RESTRICT by default; deletion jobs enumerate approved cascades rather than relying on broad implicit deletion.

## Identity and policy

| Table | Columns and constraints |
| --- | --- |
| principals | id uuid PK; kind text CHECK registered/guest; display_name text; disabled_at timestamptz nullable; anonymized_at nullable; auth_epoch bigint default 0; inbox_revision bigint default 0; home_revision bigint default 0; guest_match_id uuid nullable FK matches. CHECK guest_match_id present iff kind=guest. Use deferred FK for atomic guest/join creation. |
| accounts | principal_id uuid PK/FK principals; username text UNIQUE normalized; password_hash text; role text CHECK admin/member; can_invite_registrations bool default false; can_invite_guests bool default false; theme text CHECK light/dark/system default system. Registered principals only, checked transactionally. |
| sessions | id uuid PK; principal_id FK; token_hash bytea UNIQUE length 32; csrf_hash bytea; auth_epoch bigint; created_at; last_seen_at; idle_expires_at; absolute_expires_at; revoked_at nullable. Guest limits in section 7. Index principal_id, expiry. |
| auth_tokens | id uuid PK; kind text CHECK signin/reset; token_hash bytea UNIQUE; principal_id FK; issuer_id FK; expires_at; used_at/revoked_at nullable. Partial index live tokens by principal/kind; redemption uses SELECT FOR UPDATE. |
| instance_policy | version bigint PK; instance_name text; policy jsonb validated against PolicyV1; changed_by FK; created_at. A separate instance singleton table has id boolean PK CHECK id=true, current_policy_version bigint FK, configured_at timestamptz; updates compare expectedVersion. |
| rate_buckets | key_hash bytea; window_start timestamptz; count integer; expires_at; PK(key_hash,window_start). Atomic increments; never retain raw password/token/user-agent in keys. |
| audit_log | id uuid PK; actor_id FK nullable; action text; target_type/id text; safe_metadata jsonb; created_at. No raw secrets/chat/solution values; operator/admin changes only. |

## Modules, invitations and membership

| Table | Columns and constraints |
| --- | --- |
| modules | id text PK; enabled bool; default_version text; FK(id,default_version) to module_versions, deferred for registry sync. |
| module_versions | module_id FK; version text; manifest jsonb; server_hash text; client_hash text; sdk_contract text; state_version integer; result_version integer; installed_at; PK(module_id,version). Immutable after installation; file availability verified against registry. |
| resource_identities | id uuid PK; module_id FK; identity text; UNIQUE(module_id,identity). Stable lock/tombstone row retained for exposure facts. |
| module_resources | id uuid PK; identity_id FK; version integer; public_metadata jsonb; private_data jsonb; schema_version integer; imported_by FK nullable; hidden_at nullable; UNIQUE(identity_id,version). Immutable private content. |
| module_facts | identity_id FK; principal_id FK; fact_key text; value jsonb; updated_at; PK(identity_id,principal_id,fact_key). Server-only; identity lock serializes access. |
| matches | id uuid PK; module_id/version composite FK; state_version integer; mode text; phase text CHECK lobby/active/finished; creator_id FK; host_member_id uuid nullable; resource_id FK nullable; resource_snapshot jsonb nullable server-only; settings jsonb; visibility text CHECK invite/instance/private; policy_version FK; policy_snapshot jsonb; revision bigint default 0 CHECK &gt;=0; state jsonb nullable server-only; state_pruned_at timestamptz nullable; chat_revision bigint default 0; needs_action_from uuid\[\]; started_at/finished_at nullable. Index phase/module and updated_at. Solo forces private. |
| match_members | id uuid PK; match_id FK; principal_id FK; status CHECK active/left/removed; join_ordinal bigint; access_epoch bigint default 0; chat_from_at timestamptz; joined_at; departed_at nullable. UNIQUE(match_id,principal_id); UNIQUE(match_id,join_ordinal). Rejoin reuses member ID, increments access_epoch and assigns a new max join ordinal. |
| member_periods | id uuid PK; member_id FK; access_epoch bigint; joined_at; departed_at nullable; departure_reason nullable. UNIQUE(member_id,access_epoch). Records participation/rejoin history without treating reconnect as rejoin. |
| invitations | id uuid PK; kind CHECK registration/member/guest; issuer_id FK; recipient_id FK nullable; match_id FK nullable; token_hash bytea UNIQUE nullable; status CHECK pending/accepted/declined/revoked; expires_at; consumed_by FK nullable; consumed_at nullable. Member invite requires recipient/match; guest requires match/token; registration requires token. Index recipient/status, issuer/status. |
| match_links | id uuid PK; match_id FK; token_hash bytea UNIQUE; issued_by FK; revoked_at nullable. One live reusable link per match using partial unique index. |

Add a deferred composite host FK `(id,host_member_id)` to `match_members(match_id,id)`; host must belong to the same match. A transaction invariant enforces host active/null as the mode requires and maximum active membership. Guests' principal guest_match_id must equal every associated membership/invitation destination. A guest cannot accumulate memberships across matches.

## Commands, jobs and results

| Table | Columns and constraints |
| --- | --- |
| command_receipts | principal_id FK; scope text; command_id uuid; request_hash bytea; match_id FK nullable; committed_revision bigint nullable; safe_receipt jsonb; created_at. PK(principal_id,scope,command_id). Store accepted mutations only; generic safe receipt excludes module views/guesses. Retain while match/result is retained. |
| match_events | match_id FK; revision bigint; event_id uuid UNIQUE; actor_id FK nullable; kind text; safe_metadata jsonb; created_at; PK(match_id,revision). Audit of accepted transitions, not an event-sourcing log or place to store raw guesses. |
| match_deadlines | match_id FK; key text; generation bigint; due_at; status CHECK pending/consumed/cancelled; event_id uuid UNIQUE; PK(match_id,key,generation). Partial index due_at WHERE pending. New generations never reuse old key/generation. |
| outbox | id uuid PK; topic text; aggregate_id text; aggregate_revision bigint nullable; dedupe_key text UNIQUE; safe_payload jsonb; available_at; attempts integer; leased_until nullable; delivered_at nullable. Index available_at WHERE delivered_at IS NULL. Payload has IDs/revisions, never private state. |
| chat_messages | id uuid PK; match_id FK; sender_id FK; command_id uuid; membership_epoch bigint; text text; created_at; deleted_at nullable. UNIQUE(match_id,sender_id,command_id). Index(match_id,created_at,id). |
| notifications | id uuid PK; principal_id FK; match_id FK nullable; kind CHECK invitation/action_required/turn_missed/result; dedupe_key text; safe_payload jsonb; created_at; read_at nullable; superseded_at nullable. UNIQUE(principal_id,dedupe_key); index principal_id/read_at/created_at. |
| match_results | match_id uuid PK/FK; module_id/version FK; result_version integer; outcome text; raw_result jsonb server-only; eligibility_reasons jsonb; finished_revision bigint; finished_at. Immutable except explicit tested migration/anonymization; one result per match. |
| participant_results | match_id FK; member_id FK; principal_id FK; score integer; contribution jsonb; win bool; career_eligible bool; exclusion_reasons jsonb; display_name_snapshot text; PK(match_id,member_id). Result privacy applies to snapshot names. |
| career_contributions | match_id FK; principal_id FK; module_id FK; metric_version integer; points/played/wins bigint; visibility CHECK owner/instance; PK(match_id,principal_id). Registered eligible identities only; rebuildable from raw retained results. |
| maintenance_plans | id uuid PK; kind text; actor_id FK; policy_version bigint; target_manifest jsonb; counts jsonb; confirmation_hash bytea; expires_at; executed_at nullable. Immutable approved scope; execute once. |

Leaderboards aggregate contributions by module and visibility; no mutable total is the only source of truth. A repair job can rebuild projections without replaying gameplay. Result and contribution insertions occur atomically with the final match transition; notifications may be materialized asynchronously through deduplicated outbox consumers.

Guest principals and anonymized IDs remain tombstones while referenced by retained history. Sensitive raw state/resource snapshots have separate retention from public result summaries; do not cascade away exposure/career rules merely by hiding a library item.

# 5. Transaction, deadline and recovery rules

## Accepted command algorithm

1. Authenticate and enforce current principal/session status, CSRF, guest scope, route-level permissions and payload schema. Begin transaction. All authenticated mutations lock the acting and any affected principals together in sorted UUID order before taking other locks. Then lock invitation/token rows, resource identity, match and membership rows in that global order. Deadline/system events take the affected principal locks first; discover candidate members before locking and retry if membership changed. This serializes disable/reset against actions without requiring database access inside hooks. Match commands use principal → resource-identity → match order; no hook may acquire extra locks.

2. For a match command, lock the pinned resource identity if present, then match row with FOR UPDATE. Recheck current session/principal and match authorization within the transaction. Fetch any existing receipt for this principal/scope/commandId before comparing revision or phase. Exact same canonical request hash returns the safe receipt with replayed=true and no state/effects. Different hash returns IDEMPOTENCY_CONFLICT. Replays still require currently permitted access to that receipt; they never restore revoked views.

3. Compare expectedRevision with the locked revision. Mismatch returns STALE_REVISION, with currentRevision only for an authorized reader; no receipt or state change. Canonical request hashing covers route, normalized validated fields and expectedRevision; it never logs the original payload.

4. Read authoritative database time after acquiring the match lock. First reconcile every due pending deadline in dueAt/key order through the same reducer/commit path. If this changes revision, commit the reconciled deadline transition(s) and their effects, then return STALE_REVISION for the user intent without applying it. Do not roll back those timeouts merely because the user intent became stale. Deadline wins when server time is at or beyond dueAt; client timestamps cannot backdate commands.

5. Load settings/resource/facts/members, validate phase/membership and run transition. Validate all output schemas/invariants before any deadline status change, including rejecting re-emission of the identity being consumed with MODULE_FAILURE and no partial commit. Reconcile deadlines by `(key, generation)`: a retained pending identity keeps its stored dueAt, event ID and scheduling deduplication identity, with no scheduling outbox row and no new obligation notification. New identities insert with the emitted time and create deduplicated scheduling outbox rows and new obligation notifications. Omission cancels a pending identity, except the identity named by the deadline event being applied, which is consumed. Every accepted state transition still writes state, exactly one next revision, event, receipt and a deduplicated match-invalidation outbox row in one transaction. Finish writes final/participant results and eligible contributions in the same transaction. Add other notification effects under the notification rules, including superseding action_required and creating one Turn missed on expiry; voluntary pass/action completion only supersedes it.

6. Commit before returning acknowledgement or publishing. The initiating browser refreshes its authorized snapshot; peers receive WS invalidation and fetch theirs. No raw state is broadcast. If HTTP response is lost after commit, identical retry finds the receipt.

Rejected commands do not consume game attempts. Accepted wrong guesses do. Receipt hashes do not serve as a stored plaintext guess log; private feedback belongs only in server-private state for the submitting member and may be cleared when the turn ends.

Implement READ COMMITTED plus explicit row locks and unique constraints. Deadlocks/serialization failures retry the entire transaction at most three times with bounded jitter, preserving the original command identity; exhaustion returns SERVICE_UNAVAILABLE and the client may retry the same command. No external network calls inside transactions. Finishing, leaving, joining and deadlines all share this path.

Non-match creation/token redemptions use analogous unique receipt/row-lock constraints. Initial match creation inserts revision 0, creator membership and its create event atomically. Maintain a separate [matches.chat](http://matches.chat)_revision on chat writes/deletions, principals.inbox_revision on notification creation/read/supersession, and principals.home_revision on relevant membership/invite/summary changes. These counters let live reconciliation detect missed wakeups without using random UUID ordering or advancing gameplay revisions for chat. Concurrent duplicate create requests serialize via a transaction advisory lock on principal/scope/commandId or a receipt reservation; they cannot create two matches.

## Deadline processing

Deadlines are durable rows, not process timers. Reducers emit unique keys and generations; new identities get absolute `dueAt` using `ctx.now`. Under the match lock, the platform reconciles the desired set against stored pending rows. The identity named by the applied `{kind:"deadline", deadline}` event is consumed, not cancelled by omission, and MUST NOT appear in the output. Retain other matching pending identities without changing their stored time, event ID or scheduling deduplication identity; cancel other omitted pending identities; insert new identities with their emitted time. A deadline event emitting `[]` consumes the fired identity and cancels every other pending identity. Validate the entire output before any status change or other diff, including rejecting re-emission of the identity being consumed with `MODULE_FAILURE` and no partial commit. A consumed deadline cannot remain pending or be resurrected. Preservation applies before expiry only: accepted-command step 4 still reconciles due deadlines first and returns STALE_REVISION for the user intent if reconciliation advances the revision, without applying that intent.

Outbox jobs schedule pg-boss wakeups with \{matchId,key,generation\}; only new identities create new scheduling effects. Retaining an identity MUST NOT postpone its existing wakeup or create another obligation notification. Existing outbox retry and overdue-row reconciliation still recover lost scheduling. Generation/status checks make late/duplicate jobs harmless. Worker applies deadlines using deterministic eventId, resource/match locks and the same transition/result rules. Snapshots and worker due checks use the stored `dueAt`, never a recomputed time from an unchanged reducer identity.

On worker startup and every 10 seconds, reconcile overdue pending deadline rows in bounded batches; queue loss/delayed scheduling cannot lose a deadline. User commands also reconcile due deadlines synchronously. API restart does not reset deadlines/counters. Disabled accounts are not removed: all requests fail immediately on disabled state, sessions/invitations are revoked, and durable principal_status events let modules adjust pending obligations. Re-enabling never silently rejoins a departed participant.

No catch-up loop may simulate thousands of unattended turns. A delayed timeout starts the next obligation from processing-time [ctx.now](http://ctx.now), not the historical dueAt; report the expired obligation once. Games needing historical cadence must introduce a later explicit contract.

## Outbox and multi-process delivery

Workers claim undelivered outbox rows with SKIP LOCKED and a lease. Effects are retryable and have application dedupe keys; mark delivered after durable effect acknowledgement. A crash after effect but before acknowledgement may repeat delivery; recipients/consumers must tolerate duplicates.

For live fanout, publish only aggregate IDs/revisions through PostgreSQL LISTEN/NOTIFY after commit. Every API process has a dedicated session connection (not transaction-pooled) to listen. PostgreSQL notifications are wakeups, not the durable source; the outbox and current database snapshots remain authoritative. Each connected API node reconciles subscribed revisions/notification change markers at configurable LIVE_RECONCILE_INTERVAL_MS (initial default 10000 ms) and immediately after listener recovery. The interval is an F1 tuning parameter. A missed wakeup can delay discovery until the next sweep, plus query/scheduling/refetch time; 10 seconds is not a guaranteed end-to-end ceiling. This internal recovery sweep does not replace prompt WebSocket delivery with browser polling.

On DB/listener failure mark live status degraded; recover listener, then invalidate all authorized scopes. A shared worker cannot “consume” an event on behalf of only one API node: each node independently observes wakeups and reconciles its own connected clients. Reference: [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).

# 6. WebSocket protocol and shell behavior

Connect to `wss://{instance}/api/v1/live` with subprotocol `next-round.live.v1`; authenticate from the session cookie and verify exact Origin before upgrade. No token in query strings. API v1 is versioned independently of SDK/module/state versions.

Client frames:

```json
{"type":"subscribe","requestId":"uuid","scope":{"kind":"match","id":"uuid"},"knownRevision":12}
{"type":"subscribe","requestId":"uuid","scope":{"kind":"notifications"}}
{"type":"unsubscribe","requestId":"uuid","scope":{"kind":"match","id":"uuid"}}
{"type":"ping","requestId":"uuid"}
```

Server frames:

```json
{"type":"hello","connectionId":"uuid","serverNow":"2026-10-18T14:00:00.000Z","heartbeatSeconds":25}
{"type":"subscribed","requestId":"uuid","scope":{"kind":"match","id":"uuid"},"revision":13}
{"type":"invalidate","scope":{"kind":"match","id":"uuid"},"revision":14}
{"type":"invalidate","scope":{"kind":"notifications"}}
{"type":"access_revoked","scope":{"kind":"match","id":"uuid"}}
{"type":"pong","requestId":"uuid","serverNow":"2026-10-18T14:00:01.000Z"}
{"type":"error","requestId":"uuid","code":"NOT_FOUND"}
```

Scopes also support `{kind:"chat",id:matchId}` and `{kind:"home"}`; chat invalidation carries no text/sender/message contents. Clients refetch the corresponding authorized HTTP resource. Max frame 16 KiB; max 20 subscriptions/connection. Server ping every 25 seconds, close after two missed pongs; close slow consumers with a retryable code rather than accumulating unbounded buffers.

Subscribe procedure registers the scope before taking its current authorized revision; the client fetches a snapshot after acknowledgement and ignores older invalidations. Concurrent changes either appear in the fetched revision or trigger another refresh. Reconnect uses exponential backoff 0.5–30 seconds with jitter, resubscribes and refetches all visible scopes. Do not replay a global event cursor containing other players'/private events. The server does not promise exactly-once socket delivery.

Session logout/expiry/disable closes connections with 4401; lost match access sends access_revoked and removes subscriptions. Every subscription/HTTP fetch checks current membership/access epoch; no module view/chat payload is queued on the socket. Already delivered content cannot be recalled, but new reads/delivery after the revocation transaction must be denied. Clear local caches immediately.

Notification behavior: one durable action_required notification per member/obligation generation. Deadline expiry supersedes its unread action_required notification and creates Turn missed; voluntary pass/action completion merely supersedes it. Result notification is unique per match/recipient. Unread persists across devices; explicit read IDs set read_at once. Notification links recheck current access and show a neutral unavailable outcome after removal/deletion.

## Shared UI

After sign-in land on Home with current matches, pending invites and Start a game. Phone tabs: Home/Games/History. Use the approved desktop sidebar layout; Account/Notifications/Admin remain accessible. Open a match in the same tab; module owns the play area, platform supplies chat/participants panels on demand.

Use shadcn Button, Card, Field/Input, Dialog/AlertDialog, Sheet/Drawer, Tabs, DropdownMenu and Table where appropriate; label destructive consequences, return focus after overlays and announce accepted/stale/error states accessibly. Light/dark/system theme is persisted. Keyboard, 320 CSS px phone width, long names and zoom must be usable. Do not show database/SDK/package terms in normal player flows.

Invitation destination is an internal route stored through sign-in; never accept an arbitrary redirect URL. Guest Home reduces to the invited match/result/sign-out. Closed, full, revoked, expired and unsupported-version destinations have distinct helpful states without exposing private data.

# 7. Approved product policies and exact access rules

G1/P2 are approved (D47/D48). One-match guest scope, same-device resume, existing-match policy preservation and departure chat restrictions remain in force.

## G1 — guest access and sessions (D47)

- Separate canInviteGuests permission, admin-only initially; regular users receive it only by admin grant. Guests cannot create matches, invite, administer or browse the instance. Guest admission still obeys mode/capacity/late-join rules.
- Guest redemption links expire after 15 minutes. The guest session has 30-day idle and 180-day absolute expiry, with cookie/expiry refresh bounded by those limits. Invite expiry never expires a redeemed guest session. Session storage loss or expiry has no name-based recovery; inviter removes the old seat and issues a new guest invite.
- Same browser retains one principal/session; no guest account on another device. Signing in/out may replace/clear that cookie and warns that guest resume access can be lost. No automatic account linking/conversion in release one; deferred explicitly. A guest who wants a registered account uses a separate registration invite; no retroactive merge of match identity or career points.
- Guest appears in per-match scores/results/contributions but has no lifetime leaderboard identity. Guest participation alone does not exclude registered players from normal crossword career credit. A guest participant has careerEligible=false with participant-only reason registered_identity_required; that reason must not enter the match-wide exclusion set or suppress registered participants’ contributions. Apply the same match-wide rules for custom play, known/declared prior exposure, participation falling to one and early ending. External knowledge relies on honest declaration for registered players and guests alike; do not introduce a blanket guest exclusion.
- A guest may receive host authority through the module’s ordinary lifecycle; guest invitation/admin prohibitions still apply. Crossword transfers permanent host to the earliest remaining participant in rotation, including a guest.
**Guest copy and acceptance (F2 H2):** show the consequence before entry and before guest sign-out/session replacement, and provide an understandable recovery state. Entry copy: “Keep using this browser to return to this game. If you clear its saved data, switch browsers or your guest access expires, you’ll need a new invitation. Your earlier points will stay with your original player and won’t move to your new player.” Lost-access copy: “We can’t restore your previous guest player in this browser. Ask the person who invited you for a new invitation. If the game still accepts players, you can join as a new player; your earlier points stay with your previous player.” Do not infer a previous identity or reveal its records without authorization. Offer registered sign-in only through the ordinary account flow; never imply it will recover or merge guest points. Verify that a non-technical playtester understands same-browser resume, the next step after access loss and non-transfer of points; retain accessible mobile wording without exposing cookies/principals.

## P2 — privacy, chat and retention defaults (D48)

```typescript
interface PolicyV1 {
  schemaVersion: 1;
  historyVisibility: "participants" | "instance"; // default participants
  statsVisibility: "owner" | "instance"; // default instance
  rejoinChat: "full" | "since_rejoin"; // default full
  retention: {
    chatDaysAfterFinish: number | null; // default null
    privateStateDaysAfterFinish: number | null; // default null
    resultDaysAfterFinish: number | null; // default null
    notificationDays: number | null; // default null
  };
}
```

Finite retention days are integers 1–3650. Null means retain until explicit administrative removal. Solo history/results are always owner-private regardless of instance defaults. Privacy fields are snapshotted per match at create; future default changes never rewrite existing matches. Stats contributions record the match's effective statsVisibility; instance leaderboard includes only instance-visible eligible contributions, own stats may include owner-only contributions.

Detailed historyVisibility=instance permits enabled registered instance members to view finished multiplayer result projections, not private state, wrong guesses, resource solutions or chat. Participants retain finished-result access after departure even with participants-only history. Guests remain restricted to their own match. Admin status alone does not bypass ordinary UI read rules.

With rejoinChat=full, a legitimately rejoined member regains the retained match chat history. With since_rejoin, chat_from_at is the latest rejoin time and reads exclude older messages; the first join can read from its original join time. While left/removed, all chat access is denied under either option. A removed player requires a fresh targeted invitation. Finished chat stays readable to still-active members until retained data is removed.

Retention is separate from visibility snapshots. Saving a new retention default alone never starts purging old data. Create an immutable impact plan with target IDs/counts, cutoff, policy version and 15-minute expiry; admin executes with the returned one-use confirmation. A plan may schedule a recurring policy for future eligible records, and applying it to already existing records must be stated in that same preview. New targets outside the preview require a new plan.

Delete finished chat independently. Private-state deletion sets matches.state/resource_snapshot to null and state_pruned_at after preserving a safe result projection; allow null state only for finished/pruned matches. Summary/result reads then use retained result projections, never a state hook. Record that live board replay is unavailable. Result deletion removes corresponding career contributions and history, recomputes leaderboards and leaves a minimal tombstone preventing stale retries from recreating results. Never run retention on active/lobby state. Exposure identity facts survive ordinary result pruning; describe them in the preview.

Admin anonymization first disables the principal and revokes credentials/sessions/invites. Active matches receive explicit principal_status handling; no silent departure or rewritten score. Scrub profile/display-name snapshots and redact attribution in retained chat/results; preserve an opaque principal tombstone and gameplay totals. Remove that principal's career projections and rebuild affected displays. Free-text messages can contain names; anonymization does not promise semantic removal of all personal references. Full chat deletion is a separate previewed operation. Self-service deletion/export remains deferred; operator backups may contain older data and follow operator policy.

## Disabled accounts and matches

Disabling takes effect for authentication/actions immediately at transaction boundaries; queued obligations are handled durably. Existing memberships stay in place, result entitlement is not erased, and pending invites issued by/for the disabled user are revoked. Permission revocation similarly cancels their pending registration or guest invites. Reactivation restores account eligibility only; the user signs in afresh.

Each module must handle principal_status so a disabled sole actor cannot permanently block all other enabled players. For Test Counter skip that member's next obligation; when no enabled members remain, keep state suspended without inventing a result. Crossword's approved disabled-host/current-player handling is C4 (D50). Temporary acting-host authority is distinct from permanent succession after explicit departure.

# 8. Version changes, operations and deployment

## Module updates, disable and removal

Pin module code version, state version, result version, resource snapshot and settings at match creation. Updating the installed default changes only new matches. Disabling a module blocks new matches; existing pinned matches may join/resume/finish if their stored rules allow. Account and membership restrictions continue to apply.

Migration is explicit: block concurrent commands with resource/match locks, verify source/target contracts and settings/state/result schemas, run a tested pure migration, commit version/state/result/deadlines and next revision atomically, then invalidate clients. Failed migration rolls back. Existing clients reload the target renderer; no mixed server/UI version.

Finished-history rendering still references a version. Removal is refused while any live match, result renderer, migration target or resource import path depends on it. Default safe path retains old code/assets for retained history. An operator may prune only after a reviewed migration or after generating a platform-owned, schema-versioned static result projection that preserves authorized history without old module code; this projection path must be tested before it is offered. Without such a path, keep the package. An unavailable required package fails startup/readiness with actionable references, not silent fallback to a different version. Keep module_versions metadata rows for foreign-key/history provenance even when executable files are safely pruned; reference checks distinguish metadata from runtime/renderer requirements.

## Compose contract

Services: caddy, postgres, migrate (one-shot), api and worker. API and worker use the same built image/registry; migrate completes before readiness. PostgreSQL is not exposed publicly. Caddy publishes 80/443 and proxies WSS; API/worker run non-root with bounded pools. Native Argon2 builds/prebuilt binaries must work on the chosen Debian-based runtime.

One operator directory, e.g. `./instance/`, contains `config/.env`, `postgres/`, `caddy/data/`, `caddy/config/` and optional `imports/`; document exact bind mounts and owner permissions. Use the correct PGDATA mount for the pinned PostgreSQL image; do not assume older-major paths. Imported canonical puzzle content lives in PostgreSQL; retaining original import files is optional. Built game packages/assets belong to the immutable application image. No runtime downloads/installation in the admin UI.

Environment keys: PUBLIC_ORIGIN, DATABASE_URL, DATABASE_DIRECT_URL (optional dedicated listener/migration connection), INSTANCE_DIR, SETUP_TOKEN, SESSION_SECRET, LOG_LEVEL, TRUST_PROXY, API_PORT, DB_POOL_MAX, WORKER_POOL_MAX and LIVE_RECONCILE_INTERVAL_MS (positive integer milliseconds, default 10000). Document validation and effective configuration at startup. Generate secrets locally; never commit them. SESSION_SECRET protects CSRF derivation/other application MACs; opaque session token digests do not depend on it. Document secret rotation effects. Initial pool limits: API 10, worker 5, listener 1; account for migration/queue pools in operator connection budgets.

Config precedence: explicit environment → env file → documented non-secret defaults. First-run wizard creates admin/instance/policy, followed by routine web administration. No default password and no external email service. [Localhost](http://Localhost) development may use HTTP; self-hosted production uses HTTPS. LAN-only operators supply a trusted certificate/internal CA arrangement rather than expecting public ACME issuance.

Migration command takes a database advisory lock, applies reviewed SQL plus explicit pg-boss schema migration, records checksum/version and exits nonzero on failure. Do not use automatic schema push in production. Back up before destructive migrations; retain compatible app image. Recovery may require database restore, not an assumed reverse migration. No automatic PostgreSQL major upgrade.

Log JSON with request/command IDs, module versions, accepted revisions, job retry counts and error codes. Redact cookies, Authorization, passwords, token-bearing URLs, chat bodies, solution/private state and submitted guesses. Health/live checks process liveness; readiness checks DB access/schema/registry. Worker heartbeat and oldest pending deadline/outbox age appear in admin health; expired lease/retry failures remain inspectable.

Operator runbook covers PostgreSQL-consistent backups, .env/Caddy data and matching application images; restoring raw database files from a running server is not the documented backup method. Demonstrate one representative restore at an appropriate integration milestone, without turning every change into a migration/load drill. Operator-owned backup remains the policy.

Cloud hosting uses the same container/API/worker and external PostgreSQL, secrets and optional future object storage. Dedicated LISTEN connection and pooling limits are explicit. Vercel frontend or Cloud Run deployment is later integration work; no provider certification or price estimate is implied.

Expose app/source version and a source-code link in About as a project transparency choice. Ship the full Apache-2.0 LICENSE, project attribution/NOTICE and applicable third-party notices; mark project-owned code with SPDX-License-Identifier: Apache-2.0 where appropriate. Preserve dependency/content licenses, copyright/attribution and required NOTICE material, and mark modified third-party files as required. CONTRIBUTING states that contributors must have the rights to submit their work and license intentional upstream contributions under Apache-2.0; it does not require copyright assignment. Downstream modifiers need not publish changes or contribute them back, including hosted modifications. No email, analytics or third-party telemetry service is required. [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

**Mobile licensing resolved (D53):** project-owned server, web/client, game modules, SDK, contracts/types and generated project code use Apache-2.0. Native iPhone/Android remains later scope; no separate client license, license segregation or independent rewrite is required solely because of the former AGPL choice. Reuse project-owned client code where technically suitable; keep server-only secrets/rules out of browser/mobile bundles. Third-party dependencies, templates/generators and bundled content retain their own terms and must be checked in F0/release inventories. Native packaging, credentials, deep links, downloaded-game policy and store-distribution review remain implementation work; Apache-2.0 does not guarantee store approval. Sources and context: [03 — Technical Design](https://app.notion.com/p/3fd972a22c75813e92b1fbe0d22d4f1b) (D30/D53), [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), [Apple EULA](https://www.apple.com/legal/internet-services/itunes/dev/stdeula/).

# 9. Approved crossword module — first full game, after the harness

Page 06 summarizes the approved module rules. C1–C5 below specify their implementation and acceptance (D49–D51). They are settled release-one choices; implementation still follows the platform/SDK and harness/test-game milestone.

## C1 — content/import contract (D49)

Module ID `crossword`, first package `0.1.0`, state/result/resource schema version 1. Modes `solo`, `quick`, `custom`; maximum 1/8/8 players and start minimum 1/2/2 respectively. Multiplayer supports late join/rejoin under invitation/module checks.

Ship three small original puzzles authored for the project and released with explicit CC0-1.0 content metadata; verify actual authorship/rights before inclusion. Do not fetch or scrape commercial puzzle content. Admin imports versioned JSON only; no .puz/IPUZ parser/editor in release one.

**F3 content dependency:** these three puzzles are an editorial/authorship deliverable on F3's release critical path, separate from code and synthetic test fixtures. Begin authoring and rights review alongside F1/F2 if practical without moving crossword implementation ahead of the harness. Author of record and rights reviewer: Matthew Lewis (assigned 2026-10-20, D54); the drafting agent is Larry. Each puzzle needs original grid/fill/clues, author/provenance and redistribution/CC0 evidence, schema validation, solution/clue correctness review and a clean human playtest. Per D54 (2026-10-20), an agent may draft the grid, fill and clues, but a draft alone establishes nothing: a puzzle counts only after the author of record has reviewed and edited it, completed the correctness review and a clean cold human playtest, and signed the CC0-1.0 attestation in writing. Unreviewed generated or synthetic content does not establish authorship, rights or playability. F3 cannot exit until all three pass the content checklist.

```typescript
interface CrosswordImportV1 {
  format: "next-round.crossword/1";
  title: string; author: string; language: "en";
  difficulty: "easy" | "medium" | "hard" | "unspecified";
  rights: { license: string; sourceUrl: string | null; attribution: string;
    permissionNote: string | null };
  rows: string[]; // rectangular; "#" blocked, otherwise one ASCII A-Z per cell
  clues: Array<{ direction: "across" | "down"; row: number; col: number;
    text: string }>; // zero-based start coordinates
}
```

Title 1–120 characters; author 1–120; clue text 1–500; grid 3–25 rows and columns. Maximum file/request 1 MiB. Require at least one open cell, orthogonally connected open cells, no one-cell entries, every open cell in both across and down entries, and exactly one nonempty clue per derived maximal entry of length at least 2. Reject out-of-range/duplicate/missing starts, invalid characters, dimensions, HTML/control characters and inconsistent solution lengths. Derive conventional clue numbers by row-major starts; do not trust supplied numbering.

Initial rights allowlist: CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0 or documented original/explicit redistribution permission reviewed by the operator. Reject absent/unknown rights until reviewed; an import checkbox is not a legal verification service. Store attribution/license with resource and expose appropriate attribution in the UI/result. Content retains its own license.

Identity = SHA-256 of UTF-8 canonical JSON `{"format":"next-round.crossword.identity/1","rows":[...]}` with uppercase normalized cells, row order preserved, no whitespace between JSON tokens. The same grid/solution gets the same identity despite changed title/clues. Rotations/rearrangements are not normalized into one identity in v1. This is documented exact-puzzle detection, not protection against all prior familiarity.

Duplicate identity imports preserve existing facts and add a reviewed immutable content version if clues/metadata changed; never overwrite active match snapshots. Record the importer as exposed at import even when content is a duplicate. Public catalog exposes title, dimensions, difficulty, author/rights and opaque resource ID, never solution rows or a solution-derived digest usable as a public lookup endpoint.

## C2 — settings and input (D49)

```typescript
interface CrosswordSettingsV1 {
  preset: "solo_casual" | "quick" | "custom";
  wrongGuessesPerTurn: number | null;
  correctWordsPerTurn: number | null;
  turnSeconds: number | null;
}
```

Null is unlimited/no timer, not zero. Finite wrongGuesses/correctWords values: integers 1–100; turnSeconds: integer 10–86400. Quick is exactly \{preset:quick,wrongGuessesPerTurn:3,correctWordsPerTurn:1,turnSeconds:null\}. Solo casual uses all null. Any timer/other adjustment is custom; a custom preset matching quick values remains custom and career-ineligible. Lock settings on start.

Support both whole-word entry and grid-cell typing using the same local draft array and explicit Submit word action. Typing never submits automatically or sends individual cells as guesses. Selecting a clue sets direction/active word; crossing cells are authoritative solved letters plus local draft letters. Backspace/arrows and phone virtual keyboard must work. Evaluate the shared implementation during the crossword slice; if both modes materially increase scope, record the scoped choice before cutting either mode (D25).

Answer submission normalization: trim outer whitespace, remove ASCII spaces/hyphens, uppercase ASCII a–z, then require exactly the entry length of A–Z characters. No rebus, accent transliteration or non-English alphabet in v1. Malformed length/characters, solved clue, conflicting solved crossing letter and out-of-turn submissions are rule rejections, not wrong guesses.

## Server state and authorized view

```typescript
interface CrosswordStateV1 {
  board: Array<string | null>; // row-major letters; blocked cells represented in resource
  words: Record<string, { completed: boolean; explicitSolver: string | null;
    assisted: boolean }>;
  scores: Record<string, number>; // member ID → integer
  rotation: string[]; currentMemberId: string | null;
  turn: { generation: number; wrong: number; correct: number;
    startedAt: string; dueAt: string | null } | null;
  soloAwaitingContinue: boolean;
  suspended: boolean; suspendedRemainingMs: number | null;
  timeoutRemovalEligible: string[]; // member IDs
  privateFeedback: Record<string, { turnGeneration: number;
    lastWrongGuess: string | null; remainingWrong: number | null }>;
  exclusionReasons: string[]; // monotonic set; never cleared
}
```

Resource snapshot contains grid/answers/clues/entry map; it is server-private. The module view contains grid shape, clues, shared accepted board, completed/assisted flags, scores, rotation/current actor, own wrong feedback, own remaining budgets, deadlines/Continue state and public exclusion reasons. Never return the resource object, unsolved letters, other members' guesses/remaining attempts or a hash of their guesses. Result-only view contains outcome, points/contributions/winners/eligibility and attribution, no unfinished solution.

Command payloads:

| Action type | Exact payload and behavior |
| --- | --- |
| submit_word | \{wordId:string,answer:string\}; current enabled player only; validate draft against authoritative solved crossings; accepted correct/wrong transition. |
| pass | \{\}; current player only; multiplayer advances rotation; solo starts a fresh turn unless already awaiting Continue. |
| continue | \{\}; solo only while soloAwaitingContinue; new counters/timer, board/points retained. |
| reveal_letter | \{row:integer,col:integer\}; solo only, unsolved valid cell. |
| reveal_word | \{wordId:string\}; solo only, reveals unsolved cells in that word. |
| reveal_puzzle | \{\}; solo only; finishes Revealed, earlier points retained, no reveal points. |
| declare_exposure | \{\}; any active member, including before start; records fact and permanently excludes match career credit. |

All action bodies reject extra keys. Repeated reveal of an already filled cell/word returns RULE_REJECTED/ALREADY_FILLED without changing scores/assistance or consuming a guess; identical command retry still returns its earlier receipt.

## Rules and scoring

Initialize creator first; rotation uses join order. Lobby host starts multiplayer only at two or more active participants; solo creation/start is one transaction. Late joins/rejoins append to rotation and keep earlier scores/member identity. Back/close/offline never depart.

A turn shares wrong budget across different clues; correct count and timer are also whole-turn counters. Correct does not reset wrong count/timer. Any finite limit ends the turn. In multiplayer advance to the next active enabled participant; solo pauses awaiting Continue, with no active deadline. Pass/departure ends current turn. No timer means wait indefinitely for action/pass/departure, unless account disabling requires C4 handling.

Correct explicitly submitted unsolved word earns exactly one point once and fills its letters. Recompute crossings after that fill: any other word completed entirely by existing crossings is complete for zero points, not another explicit solve. Concurrent submissions serialize by revision so a word cannot score twice. Wrong accepted guess increments own wrong counter and stores feedback only for that player. No deductions, speed, length or completion bonuses.

End when all words complete, host ends, or every player explicitly departs. Solved multiplayer winner is highest score, including ties; ended_early/revealed/abandoned has no winner. Raw personal points/contributions remain even if career-ineligible. A result projection must be sufficient for historical summaries after private-state retention; do not require the original answer resource to render a score table.

Career exclusions are match-wide and monotonic: custom rules, any prior exposure/declaration/importer, participation dropping to one after multiplayer has started, host ending unfinished, or all leaving. Solo has no multiplayer career credit. Guest participation alone creates no exclusion; eligible registered players receive normal credit, while guests retain per-match attribution only (D47). Late joins/rejoins never restore eligibility. A lobby that temporarily has one participant before start is not excluded solely for that reason.

Rank eligible registered players by total points, dense rank for equal totals; deterministic display order by normalized username/ID is not a competitive tiebreaker. Show games played, wins and average points/game (points/played, null when zero). Eligible tied leaders each receive one win. Deleted/owner-only results follow P2 projection rules.

## C3 — exposure and reveals (D49)

At solo start or multiplayer start, atomically check every participant's existing exposure fact, latch applicable exclusions, then record exposure to this puzzle for those principals. An exposure added by this match does not retroactively mark its own initial eligible participants as prior-exposed. Reconnecting or rejoining the same member identity does not itself count as playing another match; preserve the original admission/exposure attribution. Joining an active match checks prior facts before adding the new member and records exposure; concurrent resource-bound transactions are serialized. A second overlapping match sees the first match's committed start exposure and is ineligible.

Lobby title/grid-size/clue preview must not reveal solution cells or count as played exposure. Do not send the full playable clue/board view until start. External prior play/knowledge relies on declaration; do not claim tamper-proof identity/exposure enforcement. Importers are always exposed. Guest session/identity scope follows G1; it does not create a separate career exclusion.

Reveal letter marks both still-unsolved words crossing that cell assisted; reveal word applies the same rule to every newly revealed cell. Those affected words can later complete but earn zero points; keep any points already earned before assistance. Reveal puzzle adds no points and ends Revealed. Earlier accepted scores never decrease. Multiplayer rejects every reveal action server-side.

## C4 — inactivity and disabled members (D50)

Timeout sets timeoutRemovalEligible for the expired actor. Only current host may remove that player, and only while the flag remains. Clear the flag on that member's next accepted voluntary gameplay action/pass or departure; being online, refreshing or editing a profile is not gameplay activity. Three wrong guesses alone never grants removal eligibility. Untimed play waits; no hidden inactivity timer.

A disabled current player has their current obligation ended by principal_status, with no points or timeout/removal flag invented; skip them in subsequent rotation while disabled. Keep their membership. If the host is disabled, assign temporary acting-host authority to the earliest active enabled member; restore ordinary host authority on reactivation unless the original host explicitly left. If nobody is enabled, suspend with counters preserved and no running deadline; resume on reactivation with a fresh remaining-time deadline. These approved temporary authority rules preserve permanent host identity; permanent succession occurs on explicit host departure.

The SDK host field remains the permanent host; crossword view exposes actingHostMemberId, authority derives the allowed start/finish/removal operations and transition rechecks them. The platform intersects authority with active enabled membership instead of assuming every game uses permanent-host equality.

On explicit host departure, permanently transfer host to the earliest remaining participant in rotation (including a guest); one remaining player may finish, permanently ineligible for multiplayer career totals. A removed member needs a fresh targeted invitation; a lost guest session is a separate identity unless removed/reinvited.

## C5 — focused crossword acceptance

Reuse harness fixtures and real transaction path. Verify wrong/correct counters across clues; correct does not reset timer/wrong; pass; all finite/unlimited settings; crossing-only zero points; one point once; duplicate/revision race; private wrong feedback; limit Continue persists across restart; solo reveal effects on both crossing words; multiplayer reveal rejection; host/departure/rejoin ordering; timeout-removal flag and its clearing after gameplay; disabled-current-player skipping, temporary acting-host restoration and all-disabled timer suspension; every career exclusion including concurrent exposure; guest participation preserving otherwise eligible registered-player credit; malformed import/duplicate identity; full phone/keyboard input. Add specific regression cases when failures arise.

**F3 adversarial exposure fixtures:** run these through real transactions and the actual lobby/start/join UI, using one stable puzzle identity and explicit principal identities:

- Start two overlapping matches sharing a participant, including simultaneous start attempts. The first committed admission/start records exposure; the later one latches match-wide prior-exposure exclusion. Roll back a start and verify it leaves no exposure fact. As a control, disjoint unexposed player groups on the same puzzle remain eligible.
- Admit a previously exposed player after an initially eligible match has started. Exclusion becomes match-wide and permanent; existing per-match points stay intact and finalization creates no eligible career contributions. An unexposed late join does not invent prior exposure from its own admission.
- Declare outside prior knowledge in the lobby before start. Show the career-credit consequence to participants without exposing solutions or private guesses; the declaration records the exposure fact and latches exclusion before start; starting preserves it. Lobby preview alone records no played exposure. Leaving/rejoining must not erase an already latched exclusion.
- Reconnect/rejoin the same identity to the same match without treating that match's own original exposure as a second play. A genuinely different overlapping match still counts. Include a guest case without using display-name equality as identity or applying a blanket guest exclusion.
Capture deterministic assertions for exposure facts, exclusions and final contributions, then conduct a short human walkthrough with separate players/test personas. Known test solutions must not be presented as evidence of an honest unexposed playtest.

Before calling SDK stable, map a second full game on paper, e.g. trivia with a private answer and simultaneous submissions, against manifests/views/deadlines/results. Record needed contract changes rather than claiming the crossword proves all future game compatibility.

# 10. Build slices and acceptance gates

No delivery dates or estimates are committed. Build in dependency order; develop the harness alongside shared services and integrate the tiny test game before any crossword implementation.

## F0 — scaffold and focused package feasibility

Spec baseline review is complete (D51); carry the six review refinements below into implementation. The mobile code/license decision is resolved by D53; F0 implements Apache-2.0 license/contribution/notices and reviews third-party terms, verifies database portability separately from local image pins, and identifies the puzzle authoring/review workstream. The public repository/scaffold is integrated. F0 requires Apache-2.0 LICENSE/NOTICE and contribution guidance, README, CONTRIBUTING, `AGENTS.md`, this spec, workspace, lockfile, Compose and CI. Run a frozen dependency install/typecheck/build, boot API/worker against the pinned local PostgreSQL and run the major-17 compatibility smoke checks described in section 1, hash/verify one password, exercise one pg-boss transaction adapter/job retry and upgrade one WS connection through the local proxy. Track remaining F0-B evidence separately from production live/deadline services, which belong to F1.

### shadcn preset and scaffold reference

Matt supplied this exact shadcn/create command on 2026-10-18:

```bash
pnpm dlx shadcn@latest init --preset b7kBs9lVB5 --base radix --template vite --monorepo
```

Preset reference: [b7kBs9lVB5](https://ui.shadcn.com/create?preset=b7kBs9lVB5). Use Radix UI, the Vite template, pnpm and monorepo layout as shown. This is the selected platform UI starting point; individual game renderers retain their own UI contract.

The reference uses `@latest`. For the reproducible scaffold, begin with the selected `shadcn@4.22.0` baseline and verify preset/template support in F0; record any justified version replacement, exact dependencies and generated source. Preserve the reference command verbatim, but do not depend on a floating CLI version in repeatable build instructions. Reconcile generated `apps/web` and `packages/ui` with the full workspace rather than generating a nested second repository. Inspect resolved theme/font/icon configuration and reconcile any difference from the selected dependency list before committing. Do not decode the preset manually. This reference records intent; preset-generation evidence and compatibility checks are tracked in Page 08 rather than inferred from the scaffold's presence.

Record exact pins/digests/type-package versions and any necessary substitutions. Verify shadcn generation/React peer consistency and browser build excludes server exports. This is a focused proof of uncertain integration behavior, not a new architecture competition or full load benchmark. Exit: reproducible boot and evidence for selected package fit, with unresolved package-specific failures fixed or replaced.

## F1 — first implementation slice: platform/SDK transaction foundation

Deliver setup/admin bootstrap; username/password sessions; shared principal/permission boundary; versioned policy storage; module manifest validation/registry; database migrations; match create/join/start/action/leave/final transaction service; deadline rows/reconciler; outbox invalidation; authorized snapshot endpoint; SDK/client bridge and a basic sign-in/Home/match shell. Build harness service clients/fault hooks concurrently; use an internal deterministic rule fixture to test the SDK path.

This slice does not implement crossword, polished stats/admin screens, import UI or full invitation/chat journeys. Their exact contracts are already specified above and delivered in F2/F3. A basic admin can seed a second registered test account via test fixtures only; production registration still uses authorized invites, not public sign-up.

F1 acceptance cases are the first-slice merge gate:

| ID / requirement | Observable test and pass condition |
| --- | --- |
| F1-01 · D41/D42, bootstrap/auth | Two concurrent setup requests produce exactly one initial admin. Valid username/password signs in without email. Wrong password fails. Logout/expiry/disable denies the next protected HTTP request and reconnect; last enabled admin cannot be disabled. |
| F1-02 · D34/D35, manifest boundary | Load valid 1-player and 2–8-player modes. Unsupported SDK range, duplicate ID/version or missing client asset fails validation before serving it. Browser artifact has no server fixture secret; API rejects unknown settings/action fields. |
| F1-03 · D37, authorized views | A/B receive their own hidden fixture marker and never the other's; outsider cannot fetch/subscribe/act. No raw state endpoint exists. Error and invalidation payloads expose no secret/guess. Final-result view uses the result projection. |
| F1-04 · D37, retry | Drop response after an accepted score action commits. Retry identical commandId/body: one state revision, one score increase and one receipt; replayed=true. Same key/different body returns 409 with no mutation. |
| F1-05 · D42, multi-device conflict | Two sessions act at one expected revision. Exactly one transition commits; other returns STALE_REVISION, refresh sees accepted state. Neither browser auto-replays the rejected intent. |
| F1-06 · D36/D37, final atomicity | Race two completion actions and inject failure before commit. Either no final transition persists or exactly one result/participant projection/contribution set persists. Retry cannot add another win or result. |
| F1-07 · D33/D37, action/deadline race | At a due deadline race worker and action. Serialized database-time rule yields one timeout generation, consumes the due identity, supersedes its unread action_required notification and creates one Turn missed. Step 4 reconciles the timeout first and returns STALE_REVISION for the user intent without applying it; expired action cannot backdate itself. Duplicate/old-generation jobs have no effect. Before expiry, accept notes and a late join at later server times while retaining the same deadline key/generation, including a different emitted dueAt: stored/snapshot dueAt, event identity and scheduling/obligation-notification identity remain unchanged. A fresh generation schedules the new time. Voluntary omission, including a fresh-generation action/pass, cancels the omitted pending identity and only supersedes its action_required notification; omission of the fired identity by its deadline transition consumes it instead. [] from a non-deadline event cancels all pending identities; [] from a deadline event consumes the fired identity and cancels the others. Duplicate keys, consumed/cancelled identity reuse or re-emission of the identity being consumed return MODULE_FAILURE before any status change, with no partial state/deadline/effect writes. Repeat preservation/replacement/cancellation/consumption through restart and lost scheduling on PostgreSQL 18 and 17. |
| F1-08 · D06/D40, restart recovery | Stop API/worker after state commit but before outbox/job scheduling, restart with the same database. Stored state/counters/deadline survive; overdue deadline processes once and committed change becomes visible without manual repair. |
| F1-09 · D27/D33, client recovery | Use two API processes with one client each. Peer receives normal live invalidation and refreshed view. Suppress a committed change's NOTIFY wakeup while its listener stays connected: that node's own sweep detects the revision and refreshes its client without reconnect/manual repair. Repeat with listener disconnect/recovery and record normal delivery latency, missed-wakeup recovery latency and sweep query cost at the configured interval; retain or tune the initial 10000 ms default with evidence. Refresh/reconnect restores the authoritative snapshot. Home navigation sends no leave; explicit leave revokes active view and advances the fixture lifecycle. |
| F1-10 · D38, pinned version/disable | Create at v0.1.0, install v0.2.0/default change, disable module. Existing match still runs v0.1.0; new creation fails. Build/startup check refuses removal of referenced code/assets. |

Gate evidence: named commands and results in the PR/CI, with failure injection hooks restricted to test builds. Unit tests cover pure validation/rules where useful; transaction cases use real PostgreSQL, not mocked transaction behavior. One browser journey covers shell/live/reconnect; do not duplicate every server case through UI.

## F2 — harness and minimal Test Counter game

Package `test-counter@0.1.0` is internal/operator-disabled by default outside development. It is not a promised public game. Manifest modes solo (min 1/max 1) and group (min 2/max 8), lateJoin/rejoin true for group. Settings `{target:integer 1–20,turnSeconds:integer 1–60|null}`.

Private state: count=0, per-member score, join rotation/current actor, private marker/note per member and current deadline. Action `add` has `{amount:1}`, current actor only, increments shared count and own score, rotates actor and creates a new deadline generation; count reaching target finishes once. Action `note` has `{text:string,maxLength:80}`, active member only, changes only own private note and revision. Deadline rotates actor without awarding points. Leave/removal/status uses the same common lifecycle. Solo is allowed without a forced second player.

Notes and late join/rejoin that leave the current obligation unchanged retain its deadline key/generation. The platform preserves the original stored `dueAt` under section 5, even when these reducers recompute an emitted time from `ctx.now`. They cannot extend the turn, recreate its notification or reset its scheduling identity. A turn advance emits a fresh generation; finishing emits no active deadlines.

View shows shared count/scores and only viewer's marker/note. Final result records score, completed/ended_early outcome and winner(s); solo excluded from multiplayer career totals. This deliberately small fixture demonstrates private views, more than one mode, membership, deadline, retry, result and compatibility behavior.

Deliver a CLI/development panel to create simulated registered/guest clients, issue real HTTP commands/WS subscriptions, disconnect/reconnect, restart processes, replay command IDs and inject post-commit failure. Clock controls are injectable test services only, never production endpoints. Publish concise fixture and game-author examples.

Complete shared features using real platform services:

- **H1 · Tokens/invitations:** parallel registration/QR/reset/guest redemption consumes one token once; 7-day/15-minute/30-minute expiry boundaries; reset reissue/completion revocation; invitation permission revocation; redirected destination survives sign-in; full/finished/late-join outcomes.
- **H2 · Guest boundary:** retained same-device session resumes only its match; second device/display-name imitation cannot claim it; 15-minute invite expiry and 30-day idle/180-day absolute session expiry are distinct; no catalog/other-match/admin/invite access. Lost-session fresh invitation creates a new identity without transferring old points/history; the old contribution record remains.
- **H3 · Chat/access policy:** leave/removal revokes reads/writes/subscriptions; result access remains. Rejoin full/since_rejoin cases and fresh invite after removal; solo always private; changed defaults leave existing policy snapshots intact.
- **H4 · Notifications/results:** action/result notifications dedupe after worker retry; timeout becomes Turn missed; explicit read syncs across devices. Raw result and career projection eligibility stay separate. Guests receive match attribution only; their presence alone must not suppress eligible registered-player career points/wins.
- **H5 · Operations/version:** validate a migration rollback and successful migration, finished-history renderer retention, worker retry and one restore example. Reuse F1-09's two-process listener/fanout fault fixtures; extend them to the complete shared feature scopes rather than deferring the first fanout recovery measurement until F2.
- **H6 · Retention/admin:** preview has exact impact/counts, stale/expired plan cannot execute, repeat execution is harmless, active matches never purged, contribution removal changes leaderboard, disabled members are retained.
Exit: F1 plus these representative integration cases pass, with real local platform/SDK clients and no crossword dependencies. No mandatory all-combinations matrix, coverage percentage or 200 ms p95 gate; investigate latency when live behavior warrants it.

## F3 — crossword first full game

Implement the approved C1–C5 and G1/P2 rules. Build resource import/exposure service and crossword strictly through the SDK/shared platform. Add bundled rights-reviewed puzzles, setup/library UI, both input modes subject to feasibility, solo/multiplayer rules and C5 acceptance. Complete production Home/Games/History/Admin flows and responsive light/dark accessibility.

Exit: approved Page 06 rules plus section 9 cases pass, including the adversarial exposure fixtures and three completed authoring/rights/playtest checklists; no duplicated auth/chat/storage infrastructure inside the game. Record contract changes exposed by actual integration.

## F4 — integration review and contract stabilization

Review author guide and another full game's needs on paper, ensure version/error/privacy docs match behavior, and resolve remaining release risks with focused checks. Capacity/load exercises run only if they answer a concrete risk. Release readiness includes working no-paid-service Compose setup, recoverable durable data, license/source notices and understandable operations.

# 11. Approval register and remaining implementation checks

**All proposals reviewed in the walkthrough are approved by Matt on 2026-10-18.** D41 remains in force; D47–D51 record the settled defaults and implementation baseline. D52 records the approved Next Round / next-round naming revision in baseline v1.1. D53 records Matt's Apache-2.0 license selection on 2026-10-18 in baseline v1.2, superseding the earlier D07 AGPL-3.0-only/copyleft policy and resolving the mobile client sharing/license choice.

| Decision | Approved behavior | Implementation / verification |
| --- | --- | --- |
| D47 · G1 guests | Separate admin-granted invite permission; 15-minute one-use invites; 30-day idle/180-day absolute sessions; fresh identity after lost session; no account merge; per-match guest attribution, no guest lifetime leaderboard; no blanket guest career exclusion for registered players. | F2 H1/H2/H4; crossword C5. |
| D48 · P2 privacy | Participant-only detailed results, instance-visible registered stats, full chat after permitted rejoin, indefinite retention by default; previewed deletion/anonymization; existing-match visibility/rejoin settings preserved; self-service deletion/export deferred. | F2 H3/H4/H6; policy snapshots and projection checks. |
| D49 · C1–C3 crossword | Three original rights-reviewed puzzles; English A–Z JSON import/identity/exposure contract; bounded custom settings plus unlimited, shared word/cell drafts and explicit Submit; crossing-word reveal rules and honest external-exposure declarations. | F3 content/import, gameplay/input and C5 cases; both-input implementation feasibility remains a scoped engineering check under D25. |
| D50 · C4 inactivity/status | Removal eligibility after timeout clears after next accepted gameplay action/pass; disabled members skipped without departure; temporary acting host/restoration; all-disabled suspension; explicit departure controls permanent succession. | SDK authority/status hooks in F1/F2; crossword C5 in F3. |
| D51 · implementation baseline | Selected package pins; Fastify/Vite/native WS/pg-boss; opaque sessions/Argon2; API/SDK/schema/recovery contracts; F0–F4 order and ten F1 acceptance cases; approved platform layout. | F0 install/build/compatibility and exact lockfile/image digests; F1 acceptance; harness before crossword; second-game paper check before SDK stabilization. |
| D54 · Puzzle drafting (amends D49) | The three bundled puzzles may be drafted by an agent (grid, fill, clues) under a named human author of record, who reviews/edits the draft, completes solution/clue correctness review and a clean cold human playtest, and signs the CC0-1.0 attestation. Unreviewed generated content does not count. Author of record and rights reviewer: Matthew Lewis; drafting agent: Larry. | CONTENT checklist (Crossword Design page and authoring kit); F3 exit gate unchanged in substance. |

**D52 · Identity:** Next Round; slug `next-round`; repository `lewismatt/next-round`. All active product references and pre-implementation technical namespaces use this identity.

**D53 · License:** Apache-2.0 for project-owned code, including server, web/mobile client, SDK and shared packages. Intentional upstream contributions use the same license. Downstream modifications may remain private; the previous requirement that modifications stay open is superseded. Preserve third-party licenses/notices and separate puzzle-content licenses; the three original bundled puzzles remain CC0-1.0. F0 prepares license/SPDX/NOTICE/contribution materials and validates the actual dependency inventory. The stack and F0–F4 order are unchanged; mobile packaging/store checks remain later work.

**D54 · Puzzle drafting:** Matt amended D49 on 2026-10-20. Agent drafting of the bundled puzzles is permitted under a human author of record (Matthew Lewis, also rights reviewer and playtester; drafting agent: Larry). The human gates — editorial review, correctness review, clean cold playtest and the written CC0-1.0 attestation — are unchanged and remain the substance of the F3 exit gate. Recorded in [ADR 0002](../adr/0002-agent-drafted-crossword-puzzles.md).

There are no unresolved G1/P2/C1–C5 policy proposals. The six review refinements preserve those policies and build order; D53 resolves the mobile client sharing/license choice with Apache-2.0, without requiring a technology-stack change. Remaining work is implementation and verification: package/runtime compatibility, dependency lockfile/image digests, puzzle authorship/rights, scoped input feasibility, focused acceptance evidence and later SDK stabilization. Approval is not evidence that any runtime check has passed. A material requirement change is recorded with its impact before altering this baseline.

Repository created at `lewismatt/next-round`; F0 scaffold complete and F1 platform foundation in progress on `main`.


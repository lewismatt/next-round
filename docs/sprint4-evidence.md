# Sprint 4 — harness, Test Counter and browser shell

Date: 2026-10-20. Agent: `omp-s4-20261020`.

- Base: `main` at `49d9c93528a6553032981d99df977a1027a73fb4`.
- Implementation: `2f9043f731619c8fa493aa3e7503df28d88ceeec`.
- Review unit: [draft PR #32](https://github.com/lewismatt/next-round/pull/32),
  branch `feat/s4-harness-counter`.
- Node 24.22.0, pnpm 12.14.0; PostgreSQL 18.6-alpine and 17.11-alpine.
  No direct dependency pins, lockfile or database migrations changed.

## Delivered behavior

The basic browser shell signs in registered users, lists authorized match cards,
creates and admits matches, mounts the immutable pinned client through
`GameBridge`, refreshes on native WebSocket invalidations/reconnect, and exposes
chat, participants, invitations, explicit departure and final projections.
Token fragments are removed after capture. Guest entry, replacement, sign-out
and lost-access states explain the non-transferable same-browser identity.

Login failures use shared rolling PostgreSQL budgets: five per normalized
username and twenty per trusted source IP in fifteen minutes. Success does not
charge a failure; unknown usernames retain dummy password verification.
Exhaustion supplies `Retry-After`. Token redemption uses a rolling minute rather
than a wall-clock fixed window.

The platform now delivers `principal_status` in the administrator transaction,
using complete sorted principal locking and membership-discovery retries. The
Counter skips disabled actors, suspends all-disabled play without a result or
running deadline, and resumes an enabled actor with a fresh generation. Leaving
only disabled participants does not abandon them. The creator receives its own
private marker. Host finish uses the shared revision/receipt/final transaction
path, retaining participant result entitlement.

The development CLI operates real registered/guest HTTP and WS clients. It
retains explicit command intents for replay, discards a successful command
response to exercise post-commit response loss, restarts supervised compiled
API/worker processes, and expires deadlines only in its disposable database.
No production fault/clock endpoints were added. Unused pretend/no-op local
clocks were removed; optional injected clocks must control a real test service.
Fixture and game-author examples are in [README](../README.md#httpws-game-harness).

## Executed gates

Implementation commit `2f9043f731619c8fa493aa3e7503df28d88ceeec` passed build,
typecheck, lint, SPDX, the full 253-test matrix and composed acceptance on both
PostgreSQL majors. The complete server/CLI gate remains distinct from the
separately exercised real browser journey.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
node scripts/check-spdx.mjs

TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55418/next_round \
  pnpm exec vitest run --maxWorkers=2
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55417/next_round \
  pnpm exec vitest run --maxWorkers=2

PG_MAJOR=18 TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55418/next_round \
  pnpm test:sprint4
PG_MAJOR=17 TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55417/next_round \
  pnpm test:sprint4
```

| Gate                                                    | Observed outcome                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Frozen install                                          | Pass; direct pins and lockfile unchanged                                     |
| Build/browser boundary                                  | Pass; 12 browser artifacts, no server fixture secret                         |
| Typecheck/lint                                          | Pass, zero lint warnings                                                     |
| SPDX                                                    | Pass, 111 tracked source files                                               |
| Full unit/real-transaction suite, PG18.6                | 253/253, 22 files                                                            |
| Full unit/real-transaction suite, PG17.11               | 253/253, 22 files                                                            |
| Composed recovery/version + platform + CLI, both majors | Pass: two-process recovery, 20 platform scenarios, nine CLI/game scenarios   |
| Broken private-view negative control, both majors       | Required exit 1 at `consumer-visible private marker must be viewer-specific` |

The composed command runs `sprint2-acceptance.mjs`, `sprint3-evidence.mjs` and
`sprint4-cli.mjs --scenario`; it does not substitute a simulated server for the
production API/worker. The source role needs database/role creation privileges.
Restore uses matching PostgreSQL tools or the existing Docker fallback.

## Requirement-to-evidence map

| Requirements  | Exercised path                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1-01, BL-010 | Bootstrap/session integration and new two-node login regression: username/IP limits, normalized identity, unknown-name errors, concurrent boundaries, individual expiry, success not charging, forged forwarding headers and Retry-After                                                                     |
| F1-02/03      | Manifest/schema/registry and private-view integration; Counter solo/group/private markers/notes; compiled browser-secret scan; deliberately broken view rejected                                                                                                                                             |
| F1-04/05/06   | Real post-commit response loss and exact replay, conflicting body rejected, revision races and final transaction rollback/result tests; actual browser stale 409 sends no second intent                                                                                                                      |
| F1-07/08      | Real PostgreSQL deadline/restart integration; CLI retains note/late-join/rejoin obligation identities, stops worker before committed effects drain, restarts processes and consumes overdue generation once                                                                                                  |
| F1-09/10      | Two actual API processes; normal delivery, suppressed wakeup with stable listener PID, listener recovery with new PID, pinned/default/disabled versions and referenced-code/assets startup refusal; browser live/reconnect/Home/leave journey                                                                |
| H1            | Parallel redemption/expiry/permission cases; private-link destination survives browser sign-in; full/finished/late admission; preissued registration still creates an account after destination closes; new finished-match issuance denied; admin nonmember link revocation; rolling/concurrent token budget |
| H2            | Guest session/lifetime/scope/name-imitation and fresh-identity cases; real browser entry consent, same-device resume, sign-out warning, lost-cookie recovery and private-view clearing                                                                                                                       |
| H3            | Chat read/write/WS revocation, full/since-rejoin policy snapshots, fresh invitation after removal and private solo cases; actual browser explicit leave returns Home, denies active view with 404, later renders retained result                                                                             |
| H4            | Worker retry notification/result deduplication, Turn missed/read sync, guest attribution separate from registered career credit; CLI four-player final result and solo exclusion                                                                                                                             |
| H5            | Migration rollback/success, retained history renderer, worker retry and one dump/restore/readiness example; reused two-node fanout/listener recovery scopes                                                                                                                                                  |
| H6            | Exact/stale/expired/idempotent retention plans, active-match preservation, contribution removal/leaderboard change and disabled-member retention; real transactional sole-actor suspension/reactivation                                                                                                      |

## Real browser journey

The fixture was launched with a real PostgreSQL database and compiled API/worker:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55418/next_round \
  SPRINT4_PORT=3100 APP_ORIGIN=http://127.0.0.1:3000 \
  node scripts/sprint4-cli.mjs --fixture
VITE_API_PROXY_TARGET=http://127.0.0.1:3100 pnpm --filter @next-round/web dev
# The final compiled-artifact smoke used this instead of the dev server:
VITE_API_PROXY_TARGET=http://127.0.0.1:3100 \
  pnpm --filter @next-round/web exec vite preview --host 127.0.0.1 --port 3000
```

Actual Chromium interactions used independent host, peer and guest browser
contexts, not injected sessions or a mocked bridge:

1. Sign in, Home/resume, distinct non-null private host/peer markers, accepted
   score command and peer live refresh without manual reload.
2. Pause only incoming WS delivery to retain a stale host revision; peer saves
   its private note; host submits its note. Network evidence was one action POST
   returning 409 followed by an authorized GET. The host's authoritative note
   remained empty: the rejected intent was not replayed.
3. Close native sockets, let the client reconnect and observe the peer's next
   score. Return Home and resume without losing either membership or count.
4. Send chat through its shared panel. Inspect the 390-pixel dark layout:
   no horizontal document overflow, with screenshot/visible controls checked.
5. Open guest link: fragment removed, entry copy visible and consent required.
   Redeem, reload and retain the same guest principal/match. Inspect sign-out
   warning, cancel, clear cookies and reload: lost-access copy replaces the
   private game view.
6. Create an invite-only group through the UI. Open its registered-player link
   while signed out, sign in as a different account, and arrive at that private
   match. Host starts after the peer's admission.
7. Peer explicitly leaves: Home shown, active match GET returns 404, private view
   removed. Host ends the match; both retained and departed participants render
   the `ended_early` result projection, not private game state.
8. Against the compiled SPA, create/start/complete a solo target-one match and
   render `completed`, score one. Switch between two match URLs with the same
   route pattern: the group snapshot and solo result do not retain each other's
   state. Route/principal keys isolate each mount.

Local credentials/tokens are disposable and intentionally not recorded here.
The browser contexts and supervised fixture/web servers were closed afterward.

## Recovery timing

Committed-run measurements retained the 10000 ms interval and an already
running worker. Each pair is the two API processes' observations in milliseconds.
BL-009 remains open; these are not subsecond delivery claims or a new latency SLO.

| PostgreSQL | Normal command/refetch | Missed wakeup/refetch | Listener recovery/refetch | Sweep SQL wait / query count |
| ---------- | ---------------------- | --------------------- | ------------------------- | ---------------------------- |
| 18.6       | 4891.940, 4915.050     | 1867.832, 4342.082    | 389.959, 328.963          | 25.382, 29.503 / six each    |
| 17.11      | 6542.123, 6539.352     | 1420.669, 2933.939    | 282.726, 402.168          | 6.309, 12.148 / six each     |

Listener PIDs stayed 1296/1316 (PG18) and 1387/1389 (PG17) during suppressed
wakeups, then changed to 1411/1412 and 1395/1396 after listener recovery.

## Scope, failures and remaining work

Sprint 3's H1–H6 identifiers remain shared-service evidence. This sprint adds the
actual CLI/Test Counter, browser journey and login-budget gates; it does not
retroactively rename Sprint 3 into full F2. PR existence or a local pass does not
close a tracker acceptance row: review/integration remains the operator's call.
No merge, deployment, crossword, human puzzle playtest, polished production
History/Admin UI, full self-service session/profile routes or universal SDK
stability is claimed. Backup is an operator-run restore example, not a service
or production recovery guarantee.

Integration exposed and corrected actual missing contracts: Home listing,
invitation revisions, SPA fallback, pinned asset URL, host finish, account-status
delivery, creator markers and all-disabled resume. Initial CLI failures were
fixture mistakes (solo expected `invite` rather than actual forced `private`,
missing registration commandId and a bodyless JSON DELETE); assertions were
corrected to the approved behavior, not weakened around production failures.

A default-parallel local run of both database suites plus CLI work exposed two
existing short transport-test timeouts on PG17. Unchanged tests passed with
`--maxWorkers=2` on each major; BL-024 records the saturation concern. No
production timeout or retry behavior was widened. BL-010/014/015/020 are fixed;
BL-023 (expired credential-bucket cleanup) and BL-025 (obsolete started notice
above a completed solo result) are logged. Other pre-existing backlog remains
explicitly open.

Targeted read-only auth/status and browser-lifecycle source reviews found no
new Blocker/Major issue. They did not run acceptance and are not represented as
an independent full PR review. Page 07 and the repository spec synchronize the
safe invitation revision metadata without changing gameplay/policy requirements.

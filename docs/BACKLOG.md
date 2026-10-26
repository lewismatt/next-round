# Backlog — Nits, Nags & Small Bugs

Small, non-blocking issues found during reviews and implementation. None of
these block acceptance, but unlogged they compound into technical debt.
Triage periodically; fix opportunistically or promote to a work chunk.

The [Notion backlog](https://app.notion.com/p/3fd972a22c7581eca2f7fe7fb46d593b)
section on the work tracker mirrors this file for triage discussion.
**This file is authoritative** — if they disagree, this file wins.

## How to log an entry

- Add a row to the table (newest at the bottom). One or two lines: what, where,
  why it matters.
- Reference the file, the PR/commit where you found it, and your agent ID.
- Do NOT fix backlog items inside an unrelated change — log them and move on,
  unless the fix is a trivially obvious correction in a file you already touch.
- When your chunk touches an area with an `Accepted` item, fix it
  opportunistically and mark it `Fixed` with the commit/PR link.

## States

- `Open` — logged, not yet triaged.
- `Accepted` — triaged; fix in a named chunk or opportunistically.
- `Fixed` — resolved (link the commit/PR).
- `Won't fix` — triaged; decided against, with a reason.

| ID     | State | Found in                                              | Location                                                                        | Issue                                                                                                                                                                                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                         |
| ------ | ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BL-001 | Fixed | PR #27 review (Larry, 2026-10-19)                     | `packages/platform/src/match-service.ts`                                        | Lifecycle and action commands now check stale revision before closed state, after authorization and receipt replay.                                                                                                                                                                                                                                       | [Sprint 1](https://github.com/lewismatt/next-round/tree/feat/s1-durable-effects); PostgreSQL regression covers both paths and outsider denial.                                                                                                                |
| BL-002 | Fixed | PR #27 review (Larry, 2026-10-19)                     | `packages/platform/src/final-results.ts` (`prepareFinalResult`)                 | Replaced the server non-null assertion with an explicit `MODULE_FAILURE` guard before the career hook.                                                                                                                                                                                                                                                    | [Sprint 1](https://github.com/lewismatt/next-round/tree/feat/s1-durable-effects); no accidental TypeError fallback.                                                                                                                                           |
| BL-003 | Fixed | PR #27 review (Larry, 2026-10-19)                     | `packages/platform/src/final-results.ts` (`persistFinalResult`)                 | Missing snapshot `statsVisibility` is backfilled transactionally from the match's pinned immutable policy version, never current defaults. Invalid original policies/explicit values still fail closed.                                                                                                                                                   | [Sprint 1](https://github.com/lewismatt/next-round/tree/feat/s1-durable-effects); PostgreSQL regression proves historical owner visibility and rollback on invalid policy.                                                                                    |
| BL-004 | Fixed | PR #28 retro review (Larry, 2026-10-19)               | `apps/worker/src/worker.ts` (`deliverOutboxRow`)                                | Permanently failing outbox rows (invalid payload / unknown topic) are released with capped exponential backoff and retried forever — no max-attempts or dead-letter state. Payloads are platform-generated today, so unreachable in practice; schema drift would leave a zombie row erroring every ≤60s indefinitely.                                     | Sprint 6: eight-attempt fenced dead-letter state, crash-exhausted parking and one terminal diagnostic. PG18/17 worker regressions; operator inspection/retry SQL in docs/operations.md. |
| BL-005 | Fixed | PR #28 retro review (Larry, 2026-10-19)               | `packages/platform/src/config.ts`; API and worker startup                       | Shared interval validation rejects non-numeric, zero, negative, fractional and out-of-range timer values before timers start. Both processes retain the 10000 ms default.                                                                                                                                                                                 | [Sprint 2](https://github.com/lewismatt/next-round/tree/feat/s2-live-module-lifecycle), Codex-s2-20261020. Compiled before/after probe: Sprint 1 accepted NaN; Sprint 2 API and worker reject it. Boundary regressions cover numbers and environment strings. |
| BL-006 | Fixed | Sprint 2 implementation (Codex-s2-20261020)           | `docs/spec/master-spec.md` §8 vs `apps/api/src/config.ts`                       | The approved environment-key list names `PUBLIC_ORIGIN`, but the API, Compose and README require `APP_ORIGIN`. Supplying only the spec's key fails startup with `APP_ORIGIN is required`.                                                                                                                                                                 | Mop-up: spec §8 now names `APP_ORIGIN`, matching the runtime, Compose and README; no other `PUBLIC_ORIGIN` reference remains outside this ledger. |
| BL-007 | Fixed | Sprint 2 PostgreSQL verification (Codex-s2-20261020)  | PostgreSQL integration runs with pinned `pg@8.23.1`                             | Integration runs emit `Client.activeQuery` and `Client.queryQueue` deprecation warnings for removal in pg 9. Current pinned pg 8 behavior passes.                                                                                                                                                                                                         | Mop-up investigation: no caller exists in the pinned tree. Full-tree search finds no read or write of `Client.activeQuery`/`Client.queryQueue` in repo code, pg-pool 3.14, pg-boss 12.38 or drizzle; the only reader is pg's own legacy `Client#cancel`, which nothing in the tree invokes. The Sprint 2 warnings are not reproducible on current paths. Re-check on any pg major upgrade: the accessors disappear in pg 9 and nothing here depends on them. |
| BL-008 | Fixed | Sprint 2 CI run 39380094193 (Codex-s2-20261020)       | `.github/workflows/ci.yml`                                                      | GitHub warns that the pinned v4 checkout/setup-node/pnpm setup actions target deprecated Node 20, now forced to Node 24. It also announces the `ubuntu-latest` transition to Ubuntu 26. Current jobs pass.                                                                                                                                                | Mop-up: workflow actions moved to the current Node 24 majors — actions/checkout v7, actions/setup-node v7, pnpm/action-setup v6 — with each action.yml runtime verified as node24 and the workflow's inputs unchanged across the majors. Runner stays on the GitHub-hosted ubuntu-latest image. |
| BL-009 | Fixed | Sprint 2 two-process measurements (Codex-s2-20261020) | `apps/worker/src/worker.ts` periodic outbox drain                               | With the worker already running at the default 10000 ms cadence, normal committed-change-to-refetch took 5.94–6.02 s in the measured phase. Live delivery after a wakeup is independent of the recovery sweep, but the worker's regular outbox dispatch adds latency before that wakeup.                                                                  | Sprint 6: transactional outbox NOTIFY and dedicated reconnecting LISTEN established before startup drain, with periodic durable recovery retained. Steady-worker two-API refetch samples 76-80 ms; separate-process reconnect smoke 57/43 ms. Samples, not a p95 guarantee. |
| BL-010 | Fixed | Sprint 3 implementation (Codex-s3-20261020)           | `apps/api/src/routes/auth.ts`; `packages/platform/src/auth-service.ts` login    | Shared rolling PostgreSQL budgets now enforce five failed attempts per normalized username and twenty per trusted source IP per fifteen minutes. Successful logins consume no failure budget; concurrent nodes serialize checks and return Retry-After.                                                                                                   | [Sprint 4](https://github.com/lewismatt/next-round/tree/feat/s4-harness-counter); real PostgreSQL 18.6/17.11 regression covers boundaries, expiry, concurrency and forged forwarding headers.                                                                 |
| BL-011 | Fixed | Sprint 3 real-process acceptance (Codex-s3-20261020)  | `apps/api/src/server.ts` error mapping                                          | A bodyless DELETE with `Content-Type: application/json` reaches Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` parser error but is returned as `500 INTERNAL_ERROR`, rather than a client JSON error.                                                                                                                                                            | Sprint 6: Fastify content parser errors map to safe INVALID_REQUEST responses with client 400/413/415 status, no parser input echoed. HTTP regressions and compiled real-HTTP 400 smoke. |
| BL-012 | Fixed | PR #31 review (omp-review-s3-20261020)                | `apps/api/src/routes/auth.ts` (`requireSession`)                                | The session cookie name is derived per origin when cookies are set, but `requireSession` also reads the non-`__Host-` development cookie name in HTTPS deployments, so a sibling host can set `next-round-session` with `Domain=` and fixate the session of a visitor who is not yet signed in.                                                           | Sprint 6: origin-derived cookie names on protected HTTP, guest optional authentication and WebSocket handshake paths. HTTPS ignores development cookies; real PG HTTP/live denial regression. |
| BL-013 | Fixed | PR #31 review (omp-review-s3-20261020)                | `packages/platform/src/auth-service.ts` (`redeemResetToken`)                    | The reset token is consumed, `auth_epoch` bumped and sessions revoked even when the password update matches no account: the affected row count is not checked and a missing or disabled account is not rejected, so the caller receives 204 without any password change.                                                                                  | Sprint 6: reset updates exactly one enabled account or rolls back with TOKEN_INVALID. PG regressions preserve unused token for disabled/missing accounts. |
| BL-014 | Fixed | PR #31 review (omp-review-s3-20261020)                | `packages/platform/src/token-service.ts` (`issueRegistration`)                  | Registration invitation issuance now uses the shared invitable-match predicate under principal/match locks. Finished/pruned/unavailable destinations cannot mint new invitations.                                                                                                                                                                         | [Sprint 4](https://github.com/lewismatt/next-round/tree/feat/s4-harness-counter). Redemption intentionally still creates the account when a previously valid destination later closes, as §3 requires; admission is a separate revisioned check.              |
| BL-015 | Fixed | PR #31 review (omp-review-s3-20261020)                | `packages/platform/src/invitation-service.ts` (`revokeMatchLink`)               | An enabled administrator can revoke a reusable link without being a participant or host; ordinary nonmembers remain forbidden.                                                                                                                                                                                                                            | [Sprint 4](https://github.com/lewismatt/next-round/tree/feat/s4-harness-counter); real HTTP/SQL regression and CLI scenario verify revocation.                                                                                                                |
| BL-016 | Fixed | PR #31 review (omp-review-s3-20261020)                | `packages/platform/src/auth-service.ts` (registration, QR and reset redemption) | The redemption `commandId` reaches only the audit log, so a retry after a lost success response receives `TOKEN_INVALID` instead of the previous safe receipt; the specification's recovery rule (retry using the already issued valid session) is implemented for guests only.                                                                           | Sprint 6: safe command receipts for registration/QR/reset, bearer-keyed request HMAC and transactional valid-session recheck. Registration/QR retry binds to original issued session; reset retries require a fresh same-principal sign-in. No replacement credentials or plaintext secrets stored. |
| BL-017 | Fixed | PR #31 review (omp-review-s3-20261020)                | `apps/api/src/routes/invitations.ts`; `apps/api/src/routes/tokens.ts`           | The invitation minting routes have no per-principal cap and are not charged against the shared PostgreSQL rate buckets, so a principal with invite permission can create unlimited durable invitation rows; expired guest invitations are never collected.                                                                                                | Sprint 6: all invitation/link mint paths share PostgreSQL limits of 20 successful mints/hour and 50 outstanding invitations/live links per issuer. Rotation credits the replaced link transactionally. Worker deletes bounded expired nonaccepted guest rows; accepted recovery rows retained. |
| BL-018 | Fixed | PR #31 review (omp-review-s3-20261020)                | `apps/api/src/routes/auth.ts` (`GET /auth/session`)                             | The session read rotates the CSRF token when the cookie is missing or stale, without CSRF proof; the session cookie is `SameSite=Lax`, so a cross-site top-level navigation can invalidate the victim's CSRF token and fail their next mutation.                                                                                                          | Sprint 6: session GET verifies the existing origin-specific CSRF cookie; missing/stale proof is 403 without rotation or Set-Cookie. PG regression proves stored hash unchanged. |
| BL-019 | Fixed | PR #31 review (omp-review-s3-20261020)                | `packages/platform/src/auth-service.ts` (registration)                          | Registration answers a taken username with a different error code than an invalid token, so a holder of a valid invitation can probe which usernames exist.                                                                                                                                                                                               | Sprint 6: taken registration name and invalid token return identical TOKEN_INVALID code/message. PG regression covers both outcomes. |
| BL-020 | Fixed | PR #31 review (omp-review-s3-20261020)                | `packages/platform/src/token-service.ts` (`checkRedemptionLimit`)               | Token redemption now counts a continuous sixty-second PostgreSQL window under a transaction advisory lock instead of resetting at wall-minute boundaries; exhaustion includes Retry-After.                                                                                                                                                                | [Sprint 4](https://github.com/lewismatt/next-round/tree/feat/s4-harness-counter); CLI proves boundary carry-over and eleven concurrent attempts yielding ten token errors and one 429.                                                                        |
| BL-021 | Fixed | PR #31 review (omp-review-s3-20261020)                | `docs/operations.md`; Sprint 3 summary wording                                  | The Sprint 3 wording now states that backup and restore is the operator-run verification script `scripts/sprint3-operations.mjs` and not a platform service, and the runbook's evidence record holds the 2026-10-20 runs on PostgreSQL 18.6 and 17.11.                                                                                                    | [Sprint 3](https://github.com/lewismatt/next-round/tree/feat/s3-platform-acceptance) documentation pass; `docs/sprint3-evidence.md` and `docs/operations.md` updated. Production recoverability remains unproven beyond the restore check.                    |
| BL-022 | Fixed | PR #31 review (omp-review-s3-20261020)                | `docs/sprint3-evidence.md`; `docs/spec/master-spec.md` §10                      | `docs/sprint3-evidence.md` now carries a scope section stating that the Master Spec §10 F2 H1–H6 rows, the Test Counter game, the development panel and the F1 browser-shell journey remain open.                                                                                                                                                         | [Sprint 3](https://github.com/lewismatt/next-round/tree/feat/s3-platform-acceptance) documentation pass. The H-2 chunk covers the shared services; F2 acceptance stays a separate gate.                                                                       |
| BL-023 | Fixed | Sprint 4 integration (omp-s4-20261020)                | `next_round.rate_buckets`; `packages/platform/src/auth-service.ts` login        | Expired credential-budget rows are ignored correctly, but there is no global expiry sweep. Token redemption deletes expired rows for the current key; old login failure keys can accumulate indefinitely, especially unknown usernames.                                                                                                                   | Sprint 6: indexed SKIP LOCKED expiry sweep deletes at most 500 expired rate rows per recovery sweep and preserves active budgets. PG18/17 boundary regression. |
| BL-024 | Fixed | Sprint 4 local verification (omp-s4-20261020)         | `packages/game-harness/src/client.test.ts:730,855`                              | Running both full PostgreSQL matrices and CLI acceptance simultaneously at default Vitest parallelism caused a subscription gate timeout and a fifty-millisecond replay timeout on PG17. The unchanged meaningful boundary tests pass with --maxWorkers=2 on both majors.                                                                                 | Fixed in F3-B: CONTRIBUTING's Testing section now records the bounded-worker rule for full local verification (`pnpm vitest run --maxWorkers=2`) and forbids widening the gate timeouts or suppressing the tests; the transport gates themselves are unchanged and pass under the bound.                                            |
| BL-025 | Fixed | Sprint 4 compiled-browser smoke (omp-s4-20261020)     | `apps/web/src/App.tsx` (`MatchPage` actionMessage)                              | After a solo game completes, the final projection renders correctly but the previous “Game started.” notice remains above it.                                                                                                                                                                                                                             | Fixed in F3-B: `MatchPage` clears the started notice when the authoritative snapshot phase becomes `finished`; the explicit "Game ended. The result is ready." confirmation set by the finish action is preserved.                                                             |
| BL-026 | Fixed | PR #32 review (Larry, 2026-10-20)                     | `scripts/sprint3-identity.mjs` guest-lifetime assertions (~L611)                | The 30-day guest idle/absolute lifetime checks assert a 29.99-30.01 day window, which silently assumes a UTC database. On an America/Denver cluster the `interval '30 days'` expiry spans the 1 Nov DST fall-back and measures 30.0417 days, so the check fails although the production semantics (`clock_timestamp() + interval '30 days'`) are correct. | Fixed in F3-B: the guest idle/absolute and registration-invitation lifetime checks compute the expected expiry in PostgreSQL (`clock_timestamp() + interval`) under the database's own timezone and assert within 60 seconds, so the script verifies the exact production arithmetic on any cluster timezone. Test-tooling only; no production change. Diagnosed during the PR #32 local verification on PostgreSQL 16.                                                       |
| BL-027 | Fixed | PR #32 review (Larry, 2026-10-20)                     | `scripts/sprint3-operations.mjs` teardown                                       | After printing its pass result, teardown can throw an unhandled `57P01` (admin shutdown) when the restored database is dropped while the script's pool still holds an idle client - the same pool-drain race PR #32 fixed in the login-budget test fixture.                                                                                               | Fixed in F3-B: teardown drains each pool to socket close (the settle pattern from the PR #32 fixture) before dropping the restored database, and both pools log `error` events instead of crashing on them. The script's verdict is unaffected: the failure happened after the pass line.                                                                                                                        |
| BL-028 | Fixed | Sprint 5 implementation (omp-s5-20261020)             | `apps/api/src/crossword-fixture.ts` (`registerCrosswordModule`)                 | The crossword module joins the API registry only when its compiled browser client exists on disk, so an API deployment without the web build silently has no crossword module. The operator learns about it only from the readiness check, and only when the database expects the module.                                                                 | Sprint 6: API logs MODULE_CLIENT_MISSING and the worker logs a missing bundled-client warning when skipping crossword registration. Missing-client modules remain unregistered; existing readiness/startup retention checks still apply. |
| BL-029 | Fixed | Sprint 5 implementation (omp-s5-20261020)             | `apps/api/src/routes/games.ts` (`GET /games/:gameId/resources`)                 | The catalog route answers with an empty list for an unknown or disabled module, while `GET /games/:gameId` answers 404 for the same case. Two catalog reads of one game id can therefore disagree about whether the module exists.                                                                                                                        | Sprint 6: catalog checks enabled module/default runtime before listing. Unknown/disabled is 404 NOT_FOUND, unavailable installed code is 503; empty enabled catalog remains 200. PG HTTP regression. |
| BL-030 | Fixed | Sprint 5 implementation (omp-s5-20261020)             | `packages/platform/src/resource-service.ts` (`importModuleResource`)            | The admin import receipt is stored in `command_receipts` with a null match id and a null committed revision, because a content import has no match. Any query that assumes those columns are populated for every receipt must exclude the import scope.                                                                                                   | Sprint 6: importModuleResource and README document game.resource.import scope, both null match/revision columns, and scope-filtered receipt queries. Shared table retained; no schema fiction. |
| BL-031 | Fixed | Sprint 5 implementation (omp-s5-20261020)             | `games/crossword/tsconfig.json` (`"types": ["node"]`)                           | TypeScript's automatic `@types` discovery does not see the pnpm-linked type packages in this workspace layout, so a package that imports Node built-ins fails to resolve `node:crypto` until it declares `"types": ["node"]`. Only the API package declared it before this sprint.                                                                        | Sprint 6: explicit node types for API/worker/db/platform/harness and web tooling; existing crossword declaration retained. Missing direct @types/node dependencies use baseline 24.10.8 pin. Build/typecheck pass. |
| BL-032 | Fixed | PR #33 review (Larry, 2026-10-20)                      | `games/crossword/src/server.ts` (`submit_word` wrong-guess branch)            | An accepted wrong guess does not clear the actor's `timeoutRemovalEligible` flag, though spec §9 C4 clears the flag on the member's next accepted voluntary gameplay action; the correct-guess and pass branches do clear it. A host could therefore still remove a player who has resumed playing. Probe-verified during the PR #33 review (rotation returns to the flagged member, who submits an accepted wrong guess; the flag stays set).                                                                        | Fixed in F3-B: the wrong-guess branch now clears the actor's flag like the other accepted gameplay actions, with a regression test mirroring the pass-based clearing test (the test fails without the fix) and an end-to-end deadline case in the C5 acceptance harness.                                                  |
| BL-033 | Fixed | Post-merge CI (Larry, 2026-10-20)                    | `scripts/sprint2-acceptance.mjs` (sweep poll, `until()` at L44/L226)          | The F1-09 periodic-sweep measurement poll can time out on a loaded CI runner ("Timed out: periodic sweep measurements on both nodes") although both API nodes are healthy (200 responses, sweeps running at the configured interval). It failed the PostgreSQL 17-alpine job on both post-merge runs after PR #33 merged (runs 39465868380 and 39465960257, attempt 1) and passed on re-run (attempt 2 on both). Test-tooling timing sensitivity only; no production behaviour is affected. | Sprint 6: statistics collection no longer excludes samples logged after consumer refetch finishes. Separate 60s collection budget; 25s refresh bound and actual latency timestamps unchanged. Both-major compiled acceptance passes. |
| BL-034 | Fixed | Post-merge CI, docs commit 917098fb (Larry, 2026-10-20)      | `scripts/sprint3-evidence.mjs` (restore example); pg pool in the evidence harness  | After the restore example prints its pass result (status pass, readiness ready), an unhandled pg 'error' event — "terminating connection due to administrator command" (57P01 class) — crashes the node process when the restored database is dropped/torn down while the pool still holds an idle client. The failure cascades: "Full production H1–H6 acceptance failed" at `sprint3-evidence.mjs:30`, then `sprint4-evidence.mjs:44`. Attempt 2 on run 39474461874 passed with no changes. Test-tooling only; no production behaviour is affected. | Sprint 6: outer sprint3 acceptance pool drains through socket end before database DROP, matching already-fixed restore operations. Same drain added to touched worker recovery fixture after observed 57P01. Both-major matrices and composed restore/process teardown pass. |
| BL-035 | Fixed | F3-B coordinator report (Larry, 2026-10-20) | `apps/web/src/App.tsx` (`MatchPage` header) | The match page header still shows the generic title "Game" for crossword matches (it special-cases only test-counter); the puzzle title is available in the game view. | Sprint 6: match header uses authorized crossword view title, with saved result attribution title after state pruning. Real compiled-browser retained-result smoke verifies title without importing puzzle content. |
| BL-036 | Fixed | F3-B coordinator report (Larry, 2026-10-20) | `apps/web/src/App.tsx` (`HomePage` gameTitle/invitationTitle) | The home page title helpers still special-case `test-counter` naming with a manifest-name fallback - a leftover Sprint 4 shape. It works for crossword, but the special-casing is unnecessary. | Sprint 6: Home uses manifest names and invitation display uses its supplied title, without Test Counter naming branches. Build/typecheck and real shell navigation smoke. |
| BL-037 | Fixed | F3-B coordinator report (Larry, 2026-10-20) | `apps/web` (History/Admin pages) | No component-level tests exist for the new History and Admin pages - the repo has no web component-test infrastructure, so coverage rests on typecheck/build plus the human walkthrough. | Sprint 6: existing Vitest plus react-dom/server now tests extracted real History/Admin components (five cases: retained record links, escaped refresh failures, privilege exclusion, installed version/toggle, busy controls). Real browser History navigation and admin disable/enable smoke. SSR tests do not cover effects/hydration. |
| BL-038 | Fixed | F3-B coordinator report (Larry, 2026-10-20) | `apps/web/src/App.tsx` (`ResultView`) | The web result view only understands the test-counter result projection; crossword result fields (attribution, completedWords, totalWords, preset) in the result payload are silently dropped, though the generic participants score table renders. | Sprint 6: result renders completed/total words, preset, title/author and rights metadata as escaped text alongside scores. Real HTTP/PG18 retained-result browser smoke with pruned state and departed membership; no content lookup or puzzle import. |
| BL-039 | Fixed | Sprint 6 integration review (omp-s6-20261020) | `apps/api/src/routes/health.ts`; master spec §8 | The API health routes expose only liveness and database/registry readiness. No administrative worker-heartbeat, oldest pending deadline/outbox age or parked-effect view exists, although §8 calls for worker health visibility. | Mop-up: migration 0003 adds `worker_heartbeats`; the worker writes a heartbeat at startup and on every sweep and deletes it on graceful stop. `GET /api/v1/admin/health` (admin session) reports worker heartbeats with staleness, the oldest pending outbox age, the oldest overdue deadline age and parked effects (metadata only); the Admin page renders the same data in a Worker health section. API and worker integration regressions cover authorization, seeded ages/parked rows and heartbeat refresh. |
| BL-040 | Fixed | Sprint 6 compiled-browser smoke (omp-s6-20261020) | `apps/web/src/App.tsx` (`MatchPage` phase badge) | A retained result reached through the result-only fallback renders its score and attribution correctly but keeps the “Loading game” badge because there is no active snapshot. | Mop-up: the MatchPage badge reads Finished (via `phaseLabel`) whenever a retained result is present without a snapshot; 'Loading game' now appears only while neither snapshot nor result exists. |
| BL-041 | Fixed | Sprint 6 narrow-screen smoke (omp-s6-20261020) | `apps/web/src/styles.css`; shell navigation | At a 390px viewport the desktop-style header navigation and sign-out control extend past the available header width. The retained result fields remain readable. | Mop-up: at ≤720px the top shell navigation yields to the fixed bottom MobileNav (which carries the same links) and the header may wrap, so the brand and account controls fit phone widths. The retained-result screenshot check remains a human/CI smoke item; no layout contract beyond the CSS change is claimed. |
| BL-042 | Fixed | PR #35 review (Larry, 2026-10-20) | `apps/worker/src/worker.ts` (`deliverOutboxRow`, `safeErrorCode`) | Dead-lettered rows record `last_error_code = "INTERNAL_ERROR"` for the three primary permanent failure modes - invalid payload, unknown topic and pg-boss unavailable - because those paths throw plain `Error`s without a `.code`, so the terminal diagnostic BL-004 added cannot distinguish them and an operator must read code to triage a parked row. The competing-workers regression even pins the collapsed value. | Mop-up: the three delivery failure paths throw coded errors and `safeErrorCode` accepts the worker delivery codes, so `last_error_code` records INVALID_PAYLOAD / UNKNOWN_TOPIC / PGBOSS_UNAVAILABLE. The competing-workers pinning regression now expects UNKNOWN_TOPIC. |
| BL-043 | Fixed | PR #35 review (Larry, 2026-10-20) | `packages/platform/src/invitation-service.ts`; `packages/platform/src/invitation-budget.ts` | BL-017's PostgreSQL regression exercises only the registration-token mint path. The member/guest invitation path and the match-link path - including the rotation credit for a replaced link - are enforced correctly by inspection (charge inside the issuer row lock; replaced link revoked before the charge in the same transaction) but have no test. | Mop-up: `apps/api/src/invitation-budgets.integration.test.ts` drives all three invitation-service mint paths over HTTP: the rolling-hour cap binds across guest, member and link mints in both directions with Retry-After, the outstanding cap binds on every path, and link rotation succeeds at the cap leaving exactly one live link while the cap still binds afterwards. |
| BL-044 | Fixed | PR #35 review (Larry, 2026-10-20) | `apps/web/src/App.tsx` (`MatchPage` title fallback) | BL-036 removed the Test Counter naming branches from the Home and invitation titles, but the new BL-035 MatchPage title chain keeps `(moduleId === "test-counter" ? "Test Counter" : "Game")` as its final fallback - the same hard-coded-name pattern. Outside BL-036's stated scope, so Sprint 6 left it in place. | Mop-up: MatchPage loads the games catalog and its final title fallback is the module's manifest name, like the Home/invitation paths; the test-counter special case is removed. Result-only views carry no module id, so they keep the generic fallback after the attribution title. |
| BL-045 | Fixed | PR #35 review (Larry, 2026-10-20) | `apps/worker/src/crossword-fixture.ts` (module skip warning) | BL-028's worker skip diagnostic is an unstructured plain-text warning without the `MODULE_CLIENT_MISSING` code the API emits, so a log search for that code misses worker skips. Documented accurately in the BL-028 resolution; a consistency gap only. | Mop-up: the worker crossword fixture emits the same structured `MODULE_CLIENT_MISSING` JSON warning as the API fixture. |
| BL-046 | Fixed | PR #35 review (Larry, 2026-10-20) | `packages/db/migrations/meta/` | Migration 0002 has no `0002_snapshot.json` alongside the 0000/0001 snapshots. The custom migrator never reads snapshots, so runtime is unaffected, but the drizzle-kit generation chain is broken for whoever writes 0003. | Mop-up: `0002_snapshot.json` and `0003_snapshot.json` authored with drizzle-kit itself against the reviewed migration states, completing the chain 0000→0001→0002→0003; a final `drizzle-kit generate` against the complete journal reports no schema changes. |
| BL-047 | Fixed | PR #35 review (Larry, 2026-10-20) | `apps/worker/src/worker.ts` (outbox listener); `apps/api/src/server.ts` (parser contract) | BL-009's listener-kill/reconnect behaviour and BL-011's real-socket HTTP behaviour rest on throwaway probes that were removed after passing (disclosed in docs/sprint6-evidence.md). The committed tests cover commit/rollback prompt dispatch and inject-level parser privacy, but no committed regression kills the listener or exercises a real socket. | Mop-up: committed durable regressions — the worker suite terminates the LISTEN backend mid-run and proves prompt delivery resumes through the reconnected listener with the periodic sweep ten minutes out; `apps/api/src/http-parser.integration.test.ts` drives the compiled server over a real listening socket for malformed and oversized bodies (structured 400/413 envelopes, no input echo). |
| BL-048 | Fixed | PR #35 review (Larry, 2026-10-20) | `scripts/sprint2-acceptance.mjs` (sweep sample collection) | BL-033's collection-window fix dropped the window's upper bound while the sweep interval is 10 s and the collection budget is 60 s, so the reported `periodicSweepSamples` can include samples from a later sweep cycle, not only the recovering sweep. The pass/fail measurement (25 s refresh bound; latency computed from snapshot timestamps) is unaffected - only sample provenance is weaker than the pre-fix intent. | Mop-up: collection now reports, per node, only the first emitting sweep at or after the missed change — by construction that node's recovering cycle — so later sweep cycles cannot dilute the reported provenance. The 25 s refresh measurement and its timestamps are unchanged. |
| BL-049 | Fixed | PR #35 review (Larry, 2026-10-20) | `games/crossword/src/server.ts` (finish paths) | Pre-existing, surfaced by BL-038's new result rendering: the `reveal_puzzle` and all-complete finish paths store `completedWords: content.entries.length` unconditionally; only the timeout path computes the true completed count. On a reveal finish the retained result can therefore overstate completed words, and the web result view now displays the field. | Mop-up: triaged first — the reveal/solved finishes were already gated on allComplete, and applyReveal flags every fully filled word completed, so the hard-coded count coincided with the state-derived one. All four finish paths now derive `completedWords` from the final state's own completion flags via `countCompletedWords`, with a regression pinning the revealed result to the state-derived count. |
| BL-050 | Fixed | Mop-up full-suite verification (Larry, 2026-10-20) | `packages/db/src/index.ts` (`createDatabasePool`); `apps/worker/src/worker.ts` (worker pool) | Every `pg.Pool` created without an `error` listener (the `createDatabasePool` factory and the worker's own pool): when an idle pooled client's backend dies (database restart, restore, administrative termination) pg emits the failure on the pool and the unlistened `error` event throws as an uncaught exception, taking the process down. This is the root mechanism of the BL-027/BL-034 flake family (unhandled pg 'error' events after backend termination) and a production hazard, surfaced again by the mop-up's full-suite runs (391/391 tests passing but the run exiting 1 on one unhandled 57P01). | Fixed — mop-up 2026-10-20 (PR #36): both pool construction sites attach a default `error` listener that logs only the error code (never the message) and lets the pool discard the dead client. Verified in the full-suite run: 391/391 passing, exit 0, and the log shows the guard absorbing exactly one idle-client death that previously crashed the run. Row normalized to the six-column schema during the PR #36 adjudication (BL-054). |
| BL-051 | Fixed | PR #36 review (codex-review-pr36-20261020) | `apps/api/src/routes/health.ts`; `apps/worker/src/worker.ts` (heartbeat cadence) | Fixed 30-second stale threshold marks healthy workers stale when the supported reconciliation interval exceeds 30 seconds. Actual-handler probe: 45-second-old heartbeat at a validated 60000 ms cadence reports stale. | Fixed — PR #36 adjudication (Larry, 2026-10-20): heartbeats now run on a dedicated fixed 10-second timer decoupled from the reconciliation interval (sweep and startup writes retained), so the 30-second threshold is three missed heartbeats at any supported configuration. Worker regression starts a 60 s-interval worker and proves `last_seen_at` advances inside the sweep window; the reviewer's probe scenario is covered by the admin-health classification tests. |
| BL-052 | Fixed | PR #36 review (codex-review-pr36-20261020) | `apps/api/src/invitation-budgets.integration.test.ts` | Outstanding-cap test reaches both hourly and outstanding limits before its guest/link 429 assertions, so those assertions do not isolate outstanding enforcement. | Fixed — PR #36 adjudication (Larry, 2026-10-20): the test clears rate buckets after filling the outstanding cap and before the three rejection assertions, and now also proves the rejections created nothing (outstanding count unchanged at 50, no match link). Production enforcement bypass was not observed and none was found on re-inspection. |
| BL-053 | Fixed | PR #36 review (codex-review-pr36-20261020) | `apps/worker/src/worker.ts` (heartbeat lifecycle); admin-health query | Crashed worker UUID rows are never pruned and every row is returned/rendered; repeated crashes grow the stale list indefinitely. | Fixed — PR #36 adjudication (Larry, 2026-10-20): worker startup prunes heartbeat rows older than a documented 24-hour retention window (recent crash rows survive as diagnostics); the misleading shutdown comment now describes the actual cleanup. Worker regression seeds 25-hour-old and 2-hour-old crash rows and proves only the old row is pruned. |
| BL-054 | Fixed | PR #36 review (codex-review-pr36-20261020) | `docs/BACKLOG.md` on PR #36 | BL-050 has five cells, uses P2 as State and puts its resolution in the Issue column; burn-down count says 49 while the PR body says 50. | Fixed — PR #36 adjudication (Larry, 2026-10-20): BL-050 row restored to the six-column schema with State `Fixed`; the mop-up burn-down count below is corrected to 50 and the adjudication paragraph records the branch total (54 Fixed / 0 Open) separately from main's integrated counts. |
| BL-055 | Fixed | Playtest deploy on smallpc (Larry, 2026-10-20) | `deploy/Dockerfile` runtime layout vs `apps/api/src/crossword-fixture.ts` (and `apps/worker/src/crossword-fixture.ts`) | In the shipped Docker image the web build is installed under `/app/public/`, but the crossword registration check resolves the bundled client at `apps/web/dist/games/crossword/0.1.0/client.js` relative to the compiled API — a path that does not exist in the runtime image. Crossword registration is therefore skipped (`MODULE_CLIENT_MISSING`) in the project's own Docker deployment and the module is unavailable even though its client bundle is built and served. | Fixed on `fix/playtest-image-layout`: retain the complete web build at the module loaders' expected path as well as the SPA static root. CI now registers crossword and opt-in Test Counter through both compiled API/worker loaders in a fresh container, with real files and no mounts or symlinks. Negative control: old stock image exits 1 with MODULE_CLIENT_MISSING; repaired image exits 0. Matty-owned playtest containers recreated successfully on 2026-10-21; see `docs/playtest-2026-10-21.md`. Integration pending PR review. |
| BL-056 | Fixed | AGENT-FEATURE-TESTING (codex-local-feature-test-20261021) | `apps/web/src/App.tsx`; `apps/web/src/api.ts` | An unconfigured instance has no first-run web wizard: the root renders only sign-in/invitation links although GET /api/v1/setup returns configured=false and the database has no accounts. No web setup route or API client call exists. An operator cannot create the first admin through the browser, blocking T1 and the signed-in playtest flows. | Fixed on this review branch: first-run SetupGate and accessible form use GET/POST setup, baseline policy defaults, masked token/password inputs, error/retry handling and password confirmation. Wrong token rejected in the browser; correct token created codex_playtest; a repeated correct-token setup returned 403. No token/password is stored in browser storage, git, or this document. |
| BL-057 | Fixed | Fresh-instance feature test (codex-local-feature-test-20261021) | API startup / module installation metadata | After successful first-admin setup, Home and Admin show no installed games. The trusted bundled loader only fills the process registry; production never writes modules/module_versions metadata, while all integration fixtures seed it manually. This blocks puzzle import and match creation on a fresh deployment. | Fixed on this review branch: production API startup transactionally installs trusted bundled manifests/version fingerprints. Existing enabled/default choices and version records are preserved; Test Counter stays opt-in. New regression verifies a fresh install, concurrent repeat installation and preserved disabled/default/hash choices on PostgreSQL 18.6 and 17.11. |
| BL-058 | Fixed | Live playtest (codex-local-feature-test-20261021) | `apps/web/src/App.tsx` catalog, creation and result attribution | Public resource metadata preserves rights.permissionNote, but rights summaries omitted it, hiding pending-attestation wording on private playtest content. | Close-out: shared React-escaped PermissionNote renders in creation, Admin library and saved results; null/absent historical notes omitted. Targeted escaping/absence tests and compiled-browser smoke against all three real metadata surfaces pass. No content, stored metadata or rights wording changes. Evidence: `docs/playtest-2026-10-21.md` close-out. |
| BL-059 | Fixed | Live playtest (codex-local-feature-test-20261021) | `apps/web/src/App.tsx` SessionApp / authenticated header | Failed sign-out stored an invisible globalError on authenticated screens, so throttling appeared to do nothing. | Close-out: one authenticated header/error surface across routes, disabled “Signing out…” control, synchronous duplicate-submit lock, visible escaped failure and cleared-error retry; session cleanup only after success. Guest confirmation retained. Targeted tests plus compiled-browser held-request/429/session-retention/real-successful-retry smoke pass across Home/Admin/History/match/login/invite/guest routes. No rate budget changes. Evidence: `docs/playtest-2026-10-21.md` close-out. |
| BL-060 | Fixed | smallpc deployment inspection (codex-local-feature-test-20261021) | smallpc compose override TRUST_PROXY (operator configuration) | The inherited tailnet override trusts 127.0.0.1, but Docker DNAT presents the compose gateway; forwarded identities were ignored and tailnet users shared IP-keyed budgets. | Close-out: freshly inspected `next-round_default` gateway `172.18.0.1`, set only that explicit IP with recreation/fail-closed comment, applied `sudo docker compose up -d api`. Logs distinguish desktop `100.127.186.88` and smallpc `100.87.120.128`; sibling worker `172.18.0.3` sending forged XFF `100.111.222.33` is logged as `172.18.0.3`. Health/ready 200; no ports, rates or Serve changes. Evidence: `docs/playtest-2026-10-21.md` close-out. README documents the recipe; no tracked loopback-trust generator exists. |
| BL-061 | Fixed | PR #40 review, head `c3676e97` (codex-review-pr40-20261021) | `docs/f4-integration-review.md:46-52` | P3: the new review says all 20 public error codes are emitted, but `MODULE_DISABLED` and `INCOMPATIBLE_MODULE` occur only in catalog/status declarations. Disabled match creation returns `MODULE_UNAVAILABLE`; incompatible registry validation throws an ordinary `Error`. | Fixed in [PR #40](https://github.com/lewismatt/next-round/pull/40): distinguish catalog parity from runtime emission coverage and document the actual disabled/incompatible behavior. No runtime contract change. |
| BL-062 | Fixed | PR #40 review, head `c3676e97` (codex-review-pr40-20261021) | `docs/f4-integration-review.md:41-42` | P3: `SDK_IDENTIFIER` is attributed to game-sdk, but its sole definition is in `packages/contracts/src/manifest.ts:6`, exported by contracts; game-sdk does not re-export it. | Fixed in [PR #40](https://github.com/lewismatt/next-round/pull/40): name the contracts package and definition path; no alias or contract change. |
| BL-063 | Fixed | PR #40 review, head `c3676e97` (codex-review-pr40-20261021) | `games/crossword/README.md:3-4` | P3: the header still says F3-A / PR #33 is “not merged,” conflicting with the updated delivered milestone section and the integrated PR history. | Fixed in [PR #40](https://github.com/lewismatt/next-round/pull/40): identify the integrated F3 implementation and separate the pending launch-bundle/F4 review. |
| BL-064 | Open | PR #42 review (Larry, 2026-10-24) | `games/trivia/src/server.ts` (`membership` pause/resume) | Pause computes remaining time from `state.dueAt!` and resume reads `state.suspendedRemainingMs!` with no defensive guard; both hold only by invariant (dueAt non-null while active, remaining set on pause). If either invariant ever broke, remaining becomes NaN and resume `toISOString()` throws into MODULE_FAILURE. | Open — add explicit guards or keep as a documented invariant. |
| BL-065 | Open | PR #42 review (Larry, 2026-10-24) | `games/trivia/src/client.ts` (pending intent) | If `canSubmit` flips false mid-round with the round unchanged (e.g. member disabled), a pending unknown-outcome intent lingers with no visible retry button until the player picks a new answer or the round changes; it self-heals but the state is invisible. | Open — clear pending on eligibility loss or surface the retry. |
| BL-071 | Fixed | [PR #43 review](https://github.com/lewismatt/next-round/pull/43#pullrequestreview-5638966952), head `3bbbdc17` (codex-review-pr43-20261024) | `README.md:422-424` | P3: present-tense production-image documentation still names `node:24.22.0-bookworm-slim` after the Dockerfile moves to 24.22.1. This paragraph describes the current pin, unlike dated sprint evidence. | Fixed by PR #43 amendment `0a09cf32`, merged as `e7c7d396`; verified in fresh review 5639060753. Historical evidence stays unchanged. BL-066–BL-070 remain reserved by the Page 08 Phase B scope. |

| BL-072 | Open | Puzzle Club UI implementation (codex-puzzle-club-ui-20261025) | `apps/web/src/App.tsx`; Vite production `main.js` | Production build reports a main chunk just above 500 kB minified (about 146 kB gzip). The page builds and the bundle boundary scan passes, but route-level splitting would reduce initial JavaScript for slower phones. | Non-blocking follow-up: measure and split route/dialog code; do not suppress the warning by increasing the limit. |
| BL-073 | Fixed | Puzzle Club mobile navigation review (codex-puzzle-club-ui-20261025) | `apps/web/src/App.tsx` (`MobileNav`) | Guest navigation offered a Games anchor even though guest Home has only the invited match and no catalog target. | Hide Games for guest sessions while retaining their invited match, History and Account routes. Verified with a controlled guest browser fixture on this branch. |
| BL-074 | Fixed | Trivia extraction (Larry, 2026-10-25) | `games/trivia/` in core | Trivia was the only external-pattern game still tracked in core: Cipher and Golden Ladder live in their own repositories and are bundled as fetched workspace packages, while Trivia (Sprint T, PR #42) sat in the monorepo tree, splitting the module model across two patterns. | Fixed by this PR when merged: the module is extracted byte-faithful to lewismatt/next-round-trivia (initial full-tree commit `8637d328`), `games/trivia/` is gitignored, and core bundles it via `scripts/fetch-trivia.sh` pinned to that commit — the same mechanism as Cipher. No game logic changed. BL-064/BL-065 stay Open; their locations are now the external repo's `src/server.ts` / `src/client.ts`, which the fetched tree restores at the same core paths. |
| BL-075 | Fixed | Trivia 0.2.0 adoption (Larry, 2026-10-25) | `scripts/fetch-trivia.sh`; `apps/api/src/trivia-module.ts`; `apps/worker/src/trivia-module.ts`; `apps/web/vite.config.ts` | Core still pinned Trivia 0.1.0 (`8637d328`), whose banks play in strict order capped at 20 rounds and whose schema rejects categorized questions — so the categorized question pool built in the Trivia repo (format `next-round.trivia/2`, launch floor 300) could not be used by the platform at all. | Fixed by this PR when merged: the fetch pin moves to the Trivia repo's 0.2.0 commit `de146427` (format /2 with category + difficulty, seeded draw stored in state, optional `category` match setting, stateVersion 2; /1 banks still import with unchanged identities), the bundled-client paths move to `games/trivia/0.2.0/` in the API, worker, web bundle, bundle check and image smoke script, and the real-PostgreSQL trivia acceptance test is adapted to look up the seeded draw's current question instead of assuming bank order. No platform logic changed; a category picker in the web UI is deliberately out of scope (settings without `category` keep working). |

## Sprint 5 triage (omp-s5-20261020)

- BL-028 to BL-031 are logged by this sprint and stay Open. None of them blocks
  the crossword module or the resource substrate.
- BL-024 stays Open. This sprint ran both PostgreSQL matrices with
  `--maxWorkers=2` as the item requires, and the bound held; the deterministic
  transport gates it describes were not re-investigated here.
- BL-025, BL-026 and BL-027 stay Open. This subchunk did not touch the shell
  notice surface, the identity acceptance script or the operations script, so
  those fixes belong with the remaining Sprint 5 work that extends those
  files.
- BL-032 (from Larry's PR #33 review) is assigned to the remaining Sprint 5
  work: the timeout-removal flag must also clear on an accepted wrong guess
  (spec §9 C4).

## Sprint 5 F3-B triage (larry-f3b-20261020)

- BL-024, BL-025, BL-026, BL-027 and BL-032 are Fixed by the F3-B chunk; the
  row resolutions record what landed. BL-024's transport gates are unchanged
  by design; the fix is the recorded bounded-worker verification rule.
- The F3 §10 row stays open: the production shell, setup/library UI and C5
  acceptance harness land in F3-B, but the three original CC0-1.0 puzzles are
  human-gated under D54 and the human C5 walkthrough has not run.

## Sprint 3 triage (Codex-s3-20261020)

- BL-006 remains Open. Acceptance commands use the runtime's `APP_ORIGIN`;
  reconcile the specification key in a separate configuration maintenance change.
- BL-007 remains Open. Keep `pg@8.23.1`; trace the deprecated driver-property
  caller before upgrading. Do not suppress warnings in acceptance evidence.
- BL-008 remains Open. Action-major and runner-image changes belong in a separate
  CI maintenance change. Sprint 3 retains the existing package and action pins.
- BL-009 remains Open. Measure with an already-running worker and preserve the
  regular dispatch interval. No latency threshold is added by this sprint.

## Sprint 3 review triage (omp-review-s3-20261020)

- BL-012 to BL-022 are Open and non-blocking for PR #31. None of them
  contradicts the 20 positive scenarios or the failing negative control.
- BL-012 is pre-existing since PR #24 and is not a Sprint 3 regression.
- BL-013 to BL-020 are confined to the new shared services and are scheduled
  with the F1/F2 authentication and invitation acceptance work.
- BL-021 and BL-022 are wording corrections for the Sprint 3 summary and the
  Sprint 3 evidence document.

## Next-phase fold-in triage (Larry docs pass, 2026-10-20)

Every open item now has a named home in the remaining phases, so the nits land
with the work that touches their surface instead of drifting. No state changes:
each item stays `Open` until its fix actually lands.

- **Sprint 5 (F3 crossword):** BL-025 (obsolete lifecycle notice — same web
  shell surface F3 builds in), BL-026 and BL-027 (acceptance-script timezone
  and teardown fixes, while F3 extends those scripts), BL-024 (bounded-worker
  verification guidance for the F3 matrix runs).
- **Sprint 6 (F4 stabilization & hardening):** BL-012, BL-013, BL-016, BL-017,
  BL-018, BL-019 (the auth/session/invitation hardening bundle — the surface a
  contract review reads end to end), BL-004 and BL-023 (worker reliability:
  outbox dead-letter, expired rate-bucket cleanup), BL-009 (prompt outbox
  dispatch), BL-011 (HTTP parser-error contract), BL-033 (acceptance-script
  sweep-poll CI timing flake), BL-034 (sprint3-evidence restore pool-drain
  race), BL-035 to BL-038 (F3-B web polish and component-test coverage).
- **Standalone maintenance (no sprint):** BL-006 (amend spec §8 to the
  runtime's `APP_ORIGIN` — runtime, Compose and README already agree), BL-007
  (trace the deprecated pg driver-property caller before any pg major
  upgrade), BL-008 (CI action majors and runner-image review).

## Sprint 6 resolution (omp-s6-20261020)

All 20 assigned rows are Fixed on `feat/s6-stabilization-hardening`:
BL-004, BL-009, BL-011, BL-012, BL-013, BL-016, BL-017, BL-018, BL-019,
BL-023, BL-028, BL-029, BL-030, BL-031, BL-033, BL-034, BL-035, BL-036,
BL-037 and BL-038. These branch states become main's states only after
Matthew reviews and merges the draft PR.

Implementation [55e58f7](https://github.com/lewismatt/next-round/commit/55e58f7325e2c4a2bbefdb24683c9669b042c307)
and final source [cdbe150](https://github.com/lewismatt/next-round/commit/cdbe15064d8e88443fafc7b7a56dd61e96bb1527)
have [Sprint 6 evidence](sprint6-evidence.md): bounded-worker PostgreSQL 18.6/17.11
suites, process/restore/negative-control checks and compiled browser/HTTP smoke.
BL-037 now has five real loaded-component SSR regressions using existing pinned
tools; interaction/effect coverage remains a browser-smoke responsibility.
BL-034 also covers the same socket-drain correction in the touched worker fixture
(first full local run) and auth fixture (CI run 39493896293), where `57P01`
teardown failures persisted after passing assertions. Those failed runs remain
in the evidence record; they are not treated as passed gates.

New BL-039/040/041 stay Open. BL-006/007/008 remain standalone maintenance.
No CONTENT puzzle or future self-service session route is delivered here.
F3's §10 row and the human C5 walkthrough stay open, and full F4 release readiness
is not claimed.

## Mop-up burn-down (Larry, 2026-10-20)

All fourteen remaining Open rows (BL-006/007/008, BL-039/040/041,
BL-042–BL-049) are resolved in the mop-up maintenance chunk on branch
`feat/mopup-backlog`: coded dead-letter diagnostics, structured worker
module-skip warnings, shared-budget invitation regressions, durable
listener-kill and real-socket parser regressions, state-derived crossword
completedWords, the result-only Finished badge, the manifest-name title
fallback, the phone-width header fix, recovering-cycle sweep provenance,
the admin worker-health surface (migration 0003), spec §8 alignment, the
pg deprecation investigation (no caller in the pinned tree), the Node 24
CI action majors, and the missing drizzle snapshots for 0002/0003
(drizzle-kit reports no schema changes against the completed chain).
The backlog now stands at 50 Fixed / 0 Open. CONTENT (D54) and the human
C5 walkthrough remain Matthew's open tracks; no §10 row is closed by
this chunk and full F4 release readiness is not claimed.

Adjudication of the independent PR #36 review (Larry, 2026-10-20): all
four findings in PR #37 were verified genuine against the reviewed head
and are fixed on this branch — BL-051 (heartbeat cadence decoupled from
the reconciliation interval), BL-052 (outstanding-cap test isolation),
BL-053 (24-hour heartbeat-row retention at worker startup) and BL-054
(this file's BL-050 row schema and the count above). With those rows the
branch stands at 54 Fixed / 0 Open; main's integrated counts change only
when Matthew merges.

## Playtest deploy triage (Larry, 2026-10-20)

- BL-055 logged from the first live playtest deployment on smallpc: the
  stock Docker image never registers the crossword module because the
  runtime layout and the registration check disagree on the client bundle
  path. The playtest stack runs with an in-container symlink workaround;
  the module registers and serves.
- The backlog now stands at 54 Fixed / 1 Open.

## Local playtest feature-testing triage (codex-local-feature-test-20261021)

- BL-055–BL-057 integrated through PR #38 (`817d4dfe`); historical feature-test evidence above is retained.
- BL-058–BL-060 fixed in [PR #39](https://github.com/lewismatt/next-round/pull/39); code/browser and live proxy/anti-spoof evidence: `docs/playtest-2026-10-21.md`.
- Close-out branch: **60 Fixed / 0 Open**. Main remains **57 Fixed / 3 Open** until this PR is integrated. No acceptance row closed.
- T2/T8 residual browser checks completed. Live 50-outstanding cap not filled; D54 and human C5 remain explicitly open.

## Independent F4 close-out review (codex-review-pr40-20261021)

- Reviewed PR #40 at exact head `c3676e97236dac68749d08ae5bfa7760018060c0`,
  base `c840972108661e532294a9657d84f5af665af802`. BL-061–BL-063 are
  non-blocking documentation nits, logged without fixing the reviewed change.
  This findings branch has **60 Fixed / 3 Open**; main remains **60 Fixed /
  0 Open** until the findings are integrated.
- Separate blocking review finding: the bundled-content tests pin grid-only
  identities, not complete import documents. Running the unchanged committed
  test/parser against temporary copies showed, for each of the three puzzles,
  a one-byte grid mutation fails but a one-byte clue mutation and a one-byte
  permission-note mutation each pass all four tests. The claimed full-file
  attestation drift protection is not established. The reviewer made no fix.
- All three actual documents pass the compiled import parser, match the
  supplied identity pins, and carry the exact attested CC0-1.0 rights wording.
  Byte equality with the external authoring-kit originals remains unverified:
  the originals were not available in the checkout/local files or the Notion
  Page 08/Design records and content/session searches. Original kit JSONs or
  independently supplied whole-file hashes are required for that comparison.
- Exact-head local verification passed: `pnpm build` (14 browser artifacts),
  `pnpm exec vitest run games/crossword/src apps/web/src/crossword-setup.test.ts --maxWorkers=2`
  (100 tests in five files), `pnpm typecheck`, `pnpm lint` (zero warnings),
  and `pnpm check:spdx` (142 tracked source files), using Node 24.22.0 and
  pnpm 12.14.0 after a frozen-lockfile install. The initial Corepack-only
  build invocation failed because nested scripts could not find `pnpm`;
  enabling the temporary toolchain's pnpm shim resolved the environment issue.
- Run and jobs APIs independently confirmed CI run `39668689569`, attempt 1,
  completed/success on the exact reviewed head, with all five jobs successful
  (build/verification, PostgreSQL 18.6-alpine, PostgreSQL 17-alpine, deployment
  image Argon2 runtime, Caddy WebSocket upgrade). No local PostgreSQL suite,
  deployment, merge, or acceptance closure was performed.

## F4 review corrections (codex-f4-corrections-20261021)

- At Matthew's direction, PR #40 incorporates this review log and fixes
  BL-061–BL-063. The amended branch has **63 Fixed / 0 Open**; the independent
  review section above records the original findings, not the amended state.
  Backlog-only PR #41 is superseded by the amended PR #40.
- B1's drift-protection gap is repaired: the bundled tests now pin raw-file
  SHA-256 digests separately from grid identity, compare the complete rights
  blocks, and enumerate the actual content directory instead of checking a
  constant's length. No puzzle bytes or runtime identity semantics changed.
- Copied amended tests passed unchanged (4/4). All twelve one-byte negative
  controls failed at the raw-file digest assertion: grid, clue, rights and
  formatting changes in each of the three copied files. Actual content files
  were never mutated; all temporary sandboxes were removed. Two initial
  harness assertions about diagnostic display failed because Vitest truncates
  and colorizes source excerpts; the product correctly rejected the mutations.
  The completed controls used the emitted full expected digest.
- Compiled import smoke passed for all three actual files with unchanged
  identities and exact attested rights. Targeted crossword/setup tests passed
  100/100 in five files; build (14-artifact browser scan), typecheck,
  zero-warning lint and SPDX (142 tracked source files) passed on the amended
  source with Node 24.22.0 / pnpm 12.14.0.
- Original external kit JSONs/independent whole-file hashes remain unavailable.
  The file pins freeze the reviewed `c3676e97` bytes, not an independently
  verified kit baseline. README and F4 review now state this explicitly;
  provenance sign-off still requires the external comparison. No merge,
  deployment or F3/F4 acceptance closure is claimed.


## Independent Node security-pin review (codex-review-pr43-20261024)

- PR #43 reviewed at `3bbbdc17d60dbcbdfba9c5b22d0d2807e3b3cb90`, base `98786fe6dd2a5b198cf12aee7174a15030398e4e`; [review](https://github.com/lewismatt/next-round/pull/43#pullrequestreview-5638966952) recommends changes and holds merge.
- Blocking P2: `scripts/image-notices.mjs:15` still targets Node 24.22.0, so the documented `node scripts/image-notices.mjs --check` exits 1 at line 39 on Node v24.22.1 before invoking Docker. The updated image inventory references an old OCI material with amd64 digest `ec857ea6...`, contradicting its declared `2dd9a4f...` variant. Update the generator, regenerate and commit the actual inventory/material set, and pass `--check` before a fresh review.
- Non-blocking BL-071 records the stale current README image description. This review makes no runtime or generator fixes. The reviewed six-file PR is unchanged.
- CI run [40110466339](https://github.com/lewismatt/next-round/actions/runs/40110466339) independently verified completed/success, all five jobs green for the reviewed head. Logs confirm synthetic merge `2e96f9c` of head `3bbbdc17` into base `98786fe6`, Node v24.22.1 and the new Docker index/amd64 digests. Gates include build/typecheck/lint/SPDX, unit tests, PostgreSQL 18.6/17 integrations, image Argon2/module registration and Caddy upgrade. The general test job reports 283 passed / 128 database-dependent skipped; separate DB jobs provide integration coverage. CI does not execute the failing image-notices check.
- No fresh local broad test suite, inventory regeneration, merge, deployment or acceptance closure. Next: adjudicate the review, amend PR #43, and independently review the amended head with green CI. This findings-only branch has 63 Fixed / 3 Open rows; BL-066–BL-070 remain reserved by the independent Phase B scoping record.


## PR #43 amended-head review and integration

- Fresh review of `0a09cf322f9f21ecfd686f229e173b37697a3bc1` found the P2 image-notices blocker and P3 / BL-071 resolved. [Review 5639060753](https://github.com/lewismatt/next-round/pull/43#pullrequestreview-5639060753) recommends merge. The earlier review above is historical.
- Verified all 1,416 material content hashes and complete reference coverage with no unreferenced materials; all 88 Node OS package versions match regenerated dpkg evidence. Independently fetched the immutable Docker registry index, verified its SHA-256 and compared its complete manifests with the stored OCI material. Generator/deployment/index/amd64/source pins agree; README corrected; `git diff --check` passes.
- Full Docker notices regeneration/check passed on the author's host per the amendment evidence (3 images / 173 OS packages / 0 unresolved). The review host has no Docker; its check reaches Docker then returns ENOENT, so no independent full Docker regeneration is claimed.
- CI [40112537094](https://github.com/lewismatt/next-round/actions/runs/40112537094) independently verified completed/success, all five jobs. Logs confirm synthetic merge `c10ca8f` of the reviewed head into `98786fe6` and correct deployment image digests. No redundant local application suite or deployment.
- PR #43 merged under Matthew's explicit conditional authorization as `e7c7d3960bc6486fe44788b5f7f403409a04fa50`; GitHub confirms merged head `0a09cf32`. This findings-only PR remains ready for independent documentation review. Updated branch counts: 64 Fixed / 2 Open (reserved Phase B entries not included).


## Cipher integration and repository clean-up (Larry, 2026-10-25)

- [PR #46](https://github.com/lewismatt/next-round/pull/46) merged at
  Matthew's word as `99f03082cfd7c088fdbfbf88d458a844eb404a90`: the external
  Cipher module is bundled via `scripts/fetch-cipher.sh` (fetched workspace
  package pinned to cipher `4fbbfee1`); registration in API and worker, the
  `install-bundled-games` entry, the web bundle input and match-creation
  settings are on main. Post-merge CI run
  [40171155547](https://github.com/lewismatt/next-round/actions/runs/40171155547)
  terminal SUCCESS, 5/5 jobs. No Cipher code is tracked in this repo;
  `games/cipher/` is gitignored.
- Repository clean-up at Matthew's direction, after verifying each
  branch's content against main: `design/ui-directions` (empty — its head
  was main itself; the UI redesign is to be redone), `sprint/trivia`,
  `chore/node-24.22.1-security-bump` and `docs/pr43-review-findings`
  (merged PRs #42/#43/#44), `docs/pr36-independent-review` (tip
  `c8be9513`; superseded — the review file is blob-identical on main and
  BL-051–BL-054 are Fixed), `docs/pr40-review-findings` (tip `e0df6428`;
  superseded — the review section is verbatim on main and BL-061–BL-063
  are Fixed) and `feat/cipher-platform-integration` (merged as PR #46)
  were deleted. The repository now carries a single branch, `main`, and
  no open PRs.
- A docs pass the same day trued up the README (Cipher section, monorepo
  structure, the required fetch step in the install and Docker flows),
  CONTRIBUTING's workflow commands, the Sprint T status header in
  `docs/trivia-design.md` and the status line in
  `games/crossword/README.md`. Backlog counts are unchanged by this pass:
  64 Fixed / 2 Open (BL-064, BL-065).


## Trivia extraction (Larry, 2026-10-25)

- At Matthew's direction, Trivia moved out of this repository into its own:
  [lewismatt/next-round-trivia](https://github.com/lewismatt/next-round-trivia),
  public, Apache-2.0, initial full-tree commit
  `8637d3281b43ad96c447d0319699c9eb738881be` (on a README-only Contents-API
  init commit, the empty-repository pattern used for Golden Ladder). The
  extraction is byte-faithful: every `src/` file, `content/starter.json`,
  and the LICENSE are blob-identical to core `f833971b`; the standalone
  scaffolding (root package, `scripts/fetch-core.sh` pinned to core
  `f833971b`, standalone tsconfig/vitest/CI) mirrors the Cipher and Golden
  Ladder module repos. `docs/trivia-design.md` moved with the module; the
  README links to it there. The new repo's CI run 40246862003 completed
  SUCCESS, and local verification before publishing was build, typecheck,
  and vitest 5/5 green.
- This PR is the core half: `games/trivia/` is no longer tracked and is
  gitignored; `scripts/fetch-trivia.sh` pins trivia `8637d328` and is run
  in all three CI jobs, the CONTRIBUTING workflow commands, and the README
  install and Docker flows, exactly where `scripts/fetch-cipher.sh` runs.
  Core keeps, unchanged, the registration shims
  (`apps/api/src/trivia-module.ts`, `apps/worker/src/trivia-module.ts`),
  the `install-bundled-games` entry, the web bundle input, and
  `apps/api/src/trivia-acceptance.integration.test.ts`. The root
  `tsconfig.json` project reference to `games/trivia` is removed, as with
  Cipher: the fetched package builds via its own `tsc -p` under
  `pnpm -r run build`.
- Dockerfile: the explicit `COPY games/trivia/package.json` line in the
  dependencies stage is removed so Trivia mirrors Cipher exactly. Traced
  mechanism: `pnpm install --frozen-lockfile` creates the
  `node_modules/@next-round/game-cipher` link from the lockfile's
  `games/cipher:` importer alone (verified locally with a
  dependencies-stage simulation — the link dangles until the builder
  stage's `COPY . .` materializes the fetched tree, which the CI image job
  fetches into the build context before `docker build`). The lockfile's
  `games/trivia:` importer therefore stays, updated only for the fetched
  package's added `vitest` devDependency (the standalone repo's test
  script, per the Cipher package shape).
- Backlog counts on this branch: 66 Fixed / 3 Open (BL-064, BL-065,
  BL-072). BL-064/BL-065 are untouched and remain Open.

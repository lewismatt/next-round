# Sprint 6: stabilization and hardening evidence

Agent: `omp-s6-20261020`. Base: `4a73e7957706be3e296bb655630981688949032c`.
Implementation: `55e58f7325e2c4a2bbefdb24683c9669b042c307`.
Production source and Retry-After regression: `cdbe15064d8e88443fafc7b7a56dd61e96bb1527`.

This review unit addresses the 20 assigned backlog rows. The branch marks them
Fixed; main does not gain those fixes until Matthew reviews and merges the draft
PR. No Master Spec §10 acceptance row is closed by this delivery.

## Scope and contracts

| Group | Rows                                           | Delivered behavior                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | BL-012, BL-013, BL-016, BL-017, BL-018, BL-019 | Origin-specific cookies across HTTP, optional guest authentication and WS; enabled-account reset rollback; safe session-bound redemption receipts; shared invitation budgets; nonrotating session reads; generic registration errors. |
| B     | BL-004, BL-023, BL-009, BL-011                 | Fenced dead letters, bounded indexed expiry cleanup, committed-insert wakeups with listener recovery, safe parser-error responses.                                                                                                    |
| C     | BL-033, BL-034, BL-037                         | Independent sweep-statistics collection; socket-close pool draining; real History/Admin component tests using installed React SSR and Vitest.                                                                                         |
| D     | BL-028, BL-029, BL-030, BL-031                 | Missing-client startup diagnostic on API and worker; catalog existence checks; documented import receipt nulls; explicit per-package Node types and pinned type dependencies.                                                         |
| E     | BL-035, BL-036, BL-038                         | Authorized puzzle title, manifest/preview names without Test Counter branches, retained crossword result progress/preset/attribution.                                                                                                 |

Registration and QR receipt recovery requires the original issued valid session.
A reset revokes the old sessions, so its exact retry requires signing in again as
the reset principal. The receipt never recreates credentials. Its request digest
is an HMAC keyed by the presented bearer; the stored safe receipt contains only a
session ID and optional destination, not plaintext credentials or passwords.
Transaction authority is rechecked before replay.

Invitation issuance has a shared PostgreSQL limit of 20 successful mints per
rolling hour and 50 outstanding invitations/live links per issuer. Outstanding
means pending unexpired invitation rows plus unrevoked links on unfinished
matches. Rotation credits its replaced link in the same transaction. Rate errors
include Retry-After; the capacity cap's 60-second value is a backoff hint, not a
promise that an invitation expires then. Expiry/revocation or match completion
must release capacity.

Migration `0002_worker_reliability` adds dead-letter columns and indexes, expiry
indexes and a transactional outbox insert trigger. The worker listens before its
startup drain, coalesces wakeups and reconnects after listener loss. Eight attempts
bound failed delivery and crash-exhausted claims. Terminal updates and logging
are fenced; parked rows stay inspectable. The periodic sweep remains the recovery
path for missed notifications and delayed retries. Each sweep removes at most
500 expired rate rows and 500 expired nonaccepted guest invitations. Accepted
guest invitations remain for existing receipt recovery.

Parser errors return safe INVALID_REQUEST envelopes with the parser's client
status (400, 413 or 415), without echoing body snippets. Import receipts keep the
shared table with null match/revision columns under `game.resource.import`.
Consumers must filter by scope. See [operations](operations.md) for listener
connection budgets, dead-letter inspection and deliberate operator replay.

## Local verification

Node `24.22.0`, pnpm `12.14.0`; disposable Docker PostgreSQL `18.6` and `17.11`.
No PostgreSQL 16 run is used as supported-major evidence. Full suites and composed
CLI runs were sequential, with `--maxWorkers=2` on every full local Vitest run.

| Check                                                                                                                        | Source                   | Observed result                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                             | final dependency state   | Pass; only existing baseline `@types/node@24.10.8` pins added to packages needing them.                                                                                      |
| `pnpm build`                                                                                                                 | `cdbe150`                | Pass; 14 browser artifacts, server-secret/bundle check clean.                                                                                                                |
| `pnpm typecheck`                                                                                                             | `cdbe150`                | Pass across the workspace.                                                                                                                                                   |
| `pnpm lint`                                                                                                                  | `cdbe150`                | Pass with zero warnings.                                                                                                                                                     |
| `pnpm check:spdx`                                                                                                            | `cdbe150`                | Pass; 132 tracked source files.                                                                                                                                              |
| `TEST_DATABASE_URL=... pnpm vitest run --maxWorkers=2`                                                                       | `55e58f7`                | 29 files, 381 tests pass on each of PG18.6 and PG17.11; both processes exit 0.                                                                                               |
| `TEST_DATABASE_URL=... pnpm vitest run apps/api/src/auth.integration.test.ts apps/web/src/page-views.test.ts --maxWorkers=2` | `cdbe150`                | 2 files, 9 tests pass on each major, including positive Retry-After assertions after the final source change.                                                                |
| `PG_MAJOR=18 PG_TOOL_IMAGE=postgres:18.6-alpine TEST_DATABASE_URL=... pnpm test:sprint4`                                     | `55e58f7` compiled build | Exit 0: two-process recovery/version checks, 20 production platform scenarios, restore/readiness/clean teardown, required negative control and nine real CLI/game scenarios. |
| `PG_MAJOR=17 PG_TOOL_IMAGE=postgres:17.11-alpine TEST_DATABASE_URL=... pnpm test:sprint4`                                    | `55e58f7` compiled build | Same composed checks pass, exit 0.                                                                                                                                           |

Both negative controls returned `positiveExit:0, negativeExit:1` at
`consumer-visible private marker must be viewer-specific`. Their deliberate
assertion failures are required evidence, not ignored test failures.

The focused changed-area suites include real PostgreSQL cookie/session/reset
and receipt checks, catalog HTTP behavior, worker concurrency/fencing/exhaustion,
committed dispatch versus rollback, bounded cleanup and guest preservation. Parser
regressions cover empty, malformed and oversized JSON. The five React SSR cases
exercise loaded History result links, escaped refresh errors without losing
result access, actual Admin privilege exclusion, installed default/toggle state
and busy mutation controls. SSR does not exercise effects or hydration.

## Steady-worker measurements

The Sprint 2 component commits after the worker is already running, at its
unchanged 10000 ms recovery interval. These are observed samples, not percentiles
or a new acceptance latency threshold.

| Server  | Normal commit-to-refetch, nodes A/B (ms) | Missed-wakeup recovery, A/B (ms) | API listener reconnection-to-refetch, A/B (ms) |
| ------- | ---------------------------------------- | -------------------------------- | ---------------------------------------------- |
| PG18.6  | 79.926 / 76.538                          | 7831.724 / 9353.797              | 375.774 / 294.154                              |
| PG17.11 | 75.867 / 78.905                          | 7912.457 / 9387.274              | 321.563 / 320.951                              |

A separate throwaway probe launched the compiled worker in another OS process,
set periodic recovery to 600000 ms, inserted a committed outbox effect, terminated
its dedicated listener backend, waited for a different listener PID and inserted
another effect. Final successful run: 57 ms ordinary delivery, 43 ms after
reconnection, exit 0 through cleanup. The prior probe printed 65/37 ms but then
failed its own pool teardown; that run is not reported as a passing process.
The probe was removed after use.

BL-033's statistics poll now includes a valid sweep logged after both consumer
refetches finish. It gives collection a separate 60-second budget while preserving
the 25-second refresh bound, timestamped measurements and 10000 ms cadence.
BL-034's remaining teardown race was the outer acceptance runner, not the already
fixed restore child. Pool draining now awaits removed clients' socket end events
before dropping databases. The same pattern fixes the observed touched worker
fixture teardown race.

## Compiled browser and HTTP smoke

The compiled API served the built web application over real HTTP against PG18.6.
A disposable fixture seeded only a finished result, its public attribution
metadata and departed membership, with private state and resource snapshot null.
It created no puzzle grid, clues, imported resource or CONTENT deliverable.

Observed in Chromium:

- Registered sign-in and retained result retrieval through the result-only
  fallback. Header shows the stored title. Completed words `2 / 8`, preset,
  title, author, attribution, license and source render beside the score table.
- No original name is recovered from absent snapshot members; the score row
  uses `Participant 1`. No solution/resource request is made by the result view.
- History links navigate to that retained result. Actual Admin controls disable
  and re-enable the installed module through production HTTP. The library stays
  empty; no import action was taken.
- Desktop/light and 390px/dark screenshots captured. No browser runtime errors.
  Phone shell overflow and the stale result-only phase badge are logged separately
  as BL-041 and BL-040; no phone gameplay or human C5 walkthrough is claimed.

A compiled real-HTTP probe also sent empty and malformed JSON to logout; both
returned safe 400 INVALID_REQUEST responses without the private parser marker.
The temporary API/seed probe was removed after use.

## Failures retained in the record

- Initial build failed because a new test helper passed `unknown` as Fastify's
  inject payload. Encoding the test payload as JSON fixed the typing error.
- Initial targeted run: 67 passed, two worker fixtures failed PostgreSQL parameter
  inference by reusing one parameter as UUID and text. Explicit casts fixed them.
- First full PG18 run: all 381 assertions passed but an unhandled `57P01` in the
  worker recovery fixture made the run fail. Socket-close draining fixed teardown;
  the subsequent full PG18/17 matrix exited cleanly. PG17 had not run in that
  failed chained command.
- The first browser seed probe violated the deferred module/default-version FK
  because its two seed inserts were separate transactions. One seed transaction
  fixed the fixture. The first browser navigation also overtook an in-flight
  login; after the session settled, the actual result/history/admin smoke passed.
- Existing pg driver deprecation warnings remain BL-007; they were not suppressed.
- CI run [39493896293](https://github.com/lewismatt/next-round/actions/runs/39493896293)
  on `8d60400`, attempt 1, finished with 3/5 successful jobs. Both database jobs
  passed all 87 API assertions but failed on auth-fixture `57P01` teardown (two unhandled errors on
  PG18, one on PG17). The auth fixture now uses the same socket-close drain before
  termination/DROP. No assertion or production timeout was weakened, and this
  failed head was not rerun. The superseded docs head `015459d` had its earlier CI
  run cancelled; neither run is a green gate.
  After that fixture correction, the focused auth suite passed all four tests
  on each supported major, with clean teardown. Build, typecheck, zero-warning
  lint and SPDX (132 sources) also passed again.

CI evidence belongs to the draft PR and Page 08, verified from terminal API state
on the exact final PR head. Local results above do not substitute for that gate.
A known timing/pool-drain CI flake may be rerun only once, with both attempts
retained in that record.

## F4 review and remaining gates

The [game-author guide's simultaneous-trivia paper review](../README.md#second-game-contract-review-simultaneous-trivia)
maps manifests/private resources, authorized views, simultaneous obligations,
revision conflicts, stable deadlines and pruned results to SDK
`next-round-game/0.1`. It identifies explicit conflict UX as a future game's proof
obligation. No SDK change is required by that design; it is not an implemented
second game or universal compatibility claim.

CONTENT remains Matthew's D54 track. The three rights-reviewed CC0 puzzles and the
human C5 walkthrough are still open, so F3 §10 stays open. BL-006/007/008 and the
future S3 self-service routes are unchanged. New BL-039 records the missing admin
worker/pending-age health surface. Alongside BL-040/041, it remains open. This
sprint does not claim full F4 release readiness, deployment or production backup
certification. Matthew alone decides review and merge; the PR stays draft.

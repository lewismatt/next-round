# Sprint 3 platform acceptance

Base: integrated `main` at `140918cf9d6e17fc8873e583b17c6ac6d21648f8`.
One draft PR; merge remains Matthew's decision. The user approved implementing
missing production shared services required by H1–H6 after the initial audit.
Master specification v1.2 §10 remains the acceptance contract.

## F0-B

[F0 feasibility evidence](f0-feasibility.md) records the exact commands and
preset reconciliation. Node 24.22.0 and pnpm 12.14.0 were used.

- Frozen install passed without changing direct dependency pins.
- `node scripts/f0-acceptance.mjs database-only`: 12 tests passed on PostgreSQL
  18.6 and 17.11. Application writes and pg-boss enqueue commit and roll back
  together. The uncoupled control leaves the job committed after application
  rollback, demonstrating why the transaction adapter matters.
- `node scripts/f0-acceptance.mjs preset-only`: pinned shadcn 4.22.0 generated
  preset `b7kBs9lVB5` successfully in 58.65 seconds. Generated manifests,
  components configuration, theme and fonts were inspected. Neutral base-color
  metadata is reconciled; approved Lucide and exact dependency pins are retained.
- The integrated-platform deployment image built; native Argon2id accepted the
  correct password and rejected a wrong password inside the image.
- Compose-pinned Caddy completed a WebSocket upgrade and frame exchange through
  the repository Caddyfile using host networking. A bridge-network attempt first
  failed with a TCP timeout; product configuration was not changed to hide it.

## Integrated-platform recovery measurements

These runs used the compiled integrated platform before the new Sprint 3 shared
services, not a mock server. Commands:

```sh
TEST_DATABASE_URL=postgresql://... node scripts/sprint2-acceptance.mjs
```

Both runs retained the default 10000 ms interval and an already-running worker.
Values below are the two API processes' individual observations in milliseconds.

| PostgreSQL | API PIDs     | Normal command to refetch | Missed wakeup to refetch | Listener recovery to refetch | Sweep SQL wait / query count |
| ---------- | ------------ | ------------------------- | ------------------------ | ---------------------------- | ---------------------------- |
| 18.6       | 80446, 80497 | 5936.589, 5934.685        | 1658.797, 3450.166       | 300.857, 326.000             | 6.167, 6.488 / 6 each        |
| 17.11      | 80435, 80484 | 5928.364, 5880.108        | 1615.647, 3488.034       | 373.567, 314.222             | 11.772, 12.600 / 6 each      |

The missed-wakeup runs kept listener PIDs unchanged: 515/517 on PG18 and
482/484 on PG17. Listener fault recovery produced new PIDs 523/524 and 490/491.
The runner also proved caller-private views, safe invalidation metadata,
unsubscribe without leaving, explicit leave revocation, pinned-version behavior,
and startup refusal for missing referenced code/assets.

BL-006–BL-009 remain Open. Their explicit Sprint 3 triage is in
[the authoritative backlog](BACKLOG.md#sprint-3-triage-codex-s3-20261020).
No warning suppression, dependency upgrade, configuration-key cutover or outbox
latency fix is included as unrelated work.

## H-2 production acceptance (H1–H6)

Full production H1–H6 platform acceptance was executed against PostgreSQL 18.6
and 17.11 using two compiled API processes, a compiled background worker, real
HTTP commands, and live WebSocket clients. Command:

```sh
TEST_DATABASE_URL=postgresql://... node scripts/sprint3-evidence.mjs
```

Both runs executed all 20 requirement scenarios (positive pass) and rejected the
intentionally broken private-view fixture with exit code 1 at the exact positive
assertion (`consumer-visible private marker must be viewer-specific`).

| Scenario / Requirement        | Checks                                                               | PostgreSQL 18.6 | PostgreSQL 17.11 |
| ----------------------------- | -------------------------------------------------------------------- | --------------- | ---------------- |
| Lifecycle & private view      | Create, join, start, action, viewer-specific view                    | pass (167 ms)   | pass (168 ms)    |
| WS view & reconnect           | 2 API WS sessions, snapshot receipt, reconnect view                  | pass (9151 ms)  | pass (9027 ms)   |
| Retry & deadline retention    | Exact replay revision, note retains dueAt/gen, worker ACK            | pass (695 ms)   | pass (732 ms)    |
| H1: Token rate limit          | 10 invalid attempts share cluster IP budget; 11th 429                | pass (68 ms)    | pass (69 ms)     |
| H1: Registration invite       | 7-day expiry, single parallel consumption, destination               | pass (420 ms)   | pass (395 ms)    |
| H1: Registration expiry       | Expired 7-day token rejected by redemption                           | pass (287 ms)   | pass (272 ms)    |
| H1: Sign-in QR                | 15-minute expiry, authenticates principal, expired rejected          | pass (83 ms)    | pass (79 ms)     |
| H1: Password reset            | 30-minute expiry, reissue revokes, redemptions revoke sessions       | pass (884 ms)   | pass (963 ms)    |
| H1: Guest invite expiry       | 15-minute expiry, expired returns TOKEN_INVALID                      | pass (142 ms)   | pass (141 ms)    |
| H2: Guest session lifetime    | 30-day idle expiry, 180-day absolute expiry persisted                | pass (73 ms)    | pass (74 ms)     |
| H1: Guest invite revocation   | Revocation blocks redemption, permission removal blocks              | pass (109 ms)   | pass (101 ms)    |
| H2: Guest idle/absolute       | Idle expiry rejects, absolute independently rejects                  | pass (136 ms)   | pass (130 ms)    |
| H1: Capacity & join limits    | Targeted invite, late join, 8-player capacity, full/finished         | pass (1324 ms)  | pass (1378 ms)   |
| H2: Guest resume & scope      | Bound match resume, name imitation denied, catalog denied            | pass (340 ms)   | pass (330 ms)    |
| H3: Chat lifecycle & privacy  | Durable/idempotent chat, WS wakeup, revocation, solo 404             | pass (15675 ms) | pass (15626 ms)  |
| H4: Inbox, sync & attribution | turn_missed notification, 2-session read sync, guest exclusion       | pass (29020 ms) | pass (29015 ms)  |
| H5: Backup & restore          | pg_dump/pg_restore into isolated DB, counts verified, API ready      | pass (5349 ms)  | pass (5050 ms)   |
| H5: Recovery, retry, migrate  | Live sweep recovery, worker outbox retry, module migration 500/0.2.0 | pass (25379 ms) | pass (25659 ms)  |
| H6: Retention maintenance     | Preview counts, manifest guard, execution purges state, leaderboard  | pass (270 ms)   | pass (243 ms)    |
| Negative control              | Broken private-view fixture rejected with exit code 1                | pass (exit 1)   | pass (exit 1)    |

All 20 positive cases and the negative control passed on both PostgreSQL 18.6 and 17.11.

An independent review re-ran the same command on 2026-10-20 against both
PostgreSQL majors and reproduced the result: 20/20 scenarios pass and the
negative control exits 1 at `consumer-visible private marker must be
viewer-specific`.

## Scope of this evidence

- These 20 scenarios cover the Sprint 3 shared services and the H-2 platform
  acceptance chunk. They do **not** close the Master Spec v1.2 §10 F2
  acceptance rows, which carry the same H1–H6 identifiers and additionally
  require the Test Counter game, the development panel and the F1
  browser-shell journey. The F1 acceptance rows also remain open.
- Backup and restore here is an operator-run verification
  (`scripts/sprint3-operations.mjs`): it dumps and restores a disposable
  database with `pg_dump`/`pg_restore` and starts the compiled API against the
  restored copy. It is not a platform backup service and it does not establish
  production recoverability. See [operations.md](operations.md).

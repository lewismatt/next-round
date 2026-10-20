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

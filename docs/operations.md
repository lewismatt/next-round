# Operations recovery and maintenance evidence

This runbook describes the Sprint 3 maintenance checks. It does not record a check as passed until an operator runs it and retains the output.

## Restore a PostgreSQL backup

Build the workspace before launching the restore check. Use a disposable PostgreSQL 17 or 18 instance with permission to create and drop databases. `TEST_DATABASE_URL` must point to a populated, non-production database. The runner creates a new database on that server, restores a custom-format `pg_dump` archive into it, compares row counts and content fingerprints for principals, matches, results, career contributions and audit records, then starts the compiled API against the restored database and checks `/api/v1/health/ready`. It drops the temporary database on exit.

```sh
pnpm build
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/next_round' node scripts/sprint3-operations.mjs
```

The runner uses local `pg_dump` and `pg_restore` when available. If either command is unavailable or fails, it runs the matching PostgreSQL client from Docker. Set `PG_TOOL_IMAGE` to choose the client image or `PG_TOOL_HOST` when Docker must use a different database hostname. Set `PG_DUMP_BIN` or `PG_RESTORE_BIN` to select non-default local client paths.

The database URL must be reachable from both the host and the Docker client container when Docker fallback is used. The restore runner writes the temporary database name and restored row counts to stdout. It never prints the database URL.

Do not point this runner at production. It creates and drops a database on the server named by `TEST_DATABASE_URL`.

## Match migration and retention

Run the production API acceptance suite after building. The suite must exercise migration rollback when a registered hook throws or returns invalid data, migration commit through the API, worker retry and renderer retention. It must also exercise preview counts, stale and expired plan rejection, repeated execute, active-match preservation, career leaderboard changes after result deletion and retention of disabled members.

```sh
pnpm build
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/next_round' pnpm test:sprint3
```

`TEST_DATABASE_URL` must identify a disposable PostgreSQL server with database create/drop privileges. The acceptance runner owns its test databases. Keep the command output and PostgreSQL server version with the change evidence. A zero exit status is evidence only for the cases the runner reports; it does not establish production backup recoverability beyond the restore check above.

For an operator-run migration, the API accepts `POST /api/v1/admin/matches/:id/migrate` with `commandId`, `expectedRevision` and `targetVersion`. The request requires the authenticated administrator's CSRF token and the configured application origin. The destination module version must be installed and provide a `migrate` server hook. The transaction rechecks administrator authority, expected revision and the command receipt before writing state, audit and live invalidation records.
Migration supports lobby, active and finished matches with retained state. Finished results and career contributions are migrated in the same transaction; pruned state cannot be migrated.

Retention preview accepts a non-empty unique `scope` array, the current integer `policyVersion` and an ISO-8601 `cutoff`. It returns exact target counts, a fifteen-minute expiry and a one-use confirmation value. Execute the returned plan with `POST /api/v1/admin/retention-plans/:id/execute`. Execution rejects a changed policy, changed target manifest, expired plan or invalid confirmation.

The supported scopes are:

- `chat`: remove undeleted chat messages for finished matches with `finished_at` at or before the cutoff.
- `privateState`: set `matches.state` and `resource_snapshot` to null for finished matches at or before the cutoff when state is present. Preserve match results.
- `results`: remove `match_results`, `participant_results` and `career_contributions` for finished matches whose result `finished_at` is at or before the cutoff. Keep the finished match row as a replay-resistant tombstone and clear its state and resource snapshot.
- `notifications`: remove notifications created at or before the cutoff when they have no match or their match is finished.

Active and lobby matches are never retention targets. Disabled principals are not deleted by these scopes.

## Outbox delivery and expiry maintenance

Apply reviewed migration `0002_worker_reliability` before starting this worker.
Each worker opens one dedicated `LISTEN next_round_outbox` connection in addition
to its query and pg-boss pools. Transactional insert notifications wake the
already-running worker. `DATABASE_DIRECT_URL` selects the dedicated listener
connection when configured (otherwise `DATABASE_URL`). The 10000 ms recovery
sweep still handles missed wakeups, retry availability and process restarts.
Budget the extra connection when sizing
PostgreSQL. Notifications contain no row payload or private data.

Outbox claims use 30-second leases and attempt fencing. After eight attempts a
failed row is parked with `dead_lettered_at` and a sanitized `last_error_code`.
Parked rows remain durable and are excluded from dispatch. Diagnose the code and
schema before replaying an effect; changing application code does not itself
unpark a row. Never delete a row to hide a failed effect.

Inspect failures and pending age with operator database access:

```sql
SELECT id, topic, attempts, dead_lettered_at, last_error_code
FROM next_round.outbox
WHERE dead_lettered_at IS NOT NULL
ORDER BY dead_lettered_at;

SELECT min(created_at) AS oldest_pending_at
FROM next_round.outbox
WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
```

The same picture is available without SQL at `GET /api/v1/admin/health`
(admin session required), rendered in the Admin page's Worker health
section: worker heartbeats with age (`stale` past 30 seconds — three
missed heartbeats at the worker's fixed 10-second heartbeat cadence,
which is independent of the reconciliation interval), the oldest pending
outbox age, the oldest overdue pending deadline age, and the parked
effects with topic, attempts and error code. Workers write a heartbeat
row at startup, on every sweep and every 10 seconds on a dedicated timer
(migration `0003_worker_heartbeats`); a gracefully stopped worker deletes
its row, a crashed one shows up as a heartbeat going stale, and rows
older than 24 hours are pruned at the next worker startup. The endpoint
exposes metadata only, never payload contents.

After repairing the cause, stop all worker processes and wait for them to exit
before resetting any attempt counter. This prevents an old in-flight claim from
matching a reused attempt number. An operator can then deliberately retry a parked
effect by resetting its attempts, dead-letter/error markers, lease and
`available_at` in one reviewed SQL update, and restart the workers. Match deadline
and live invalidation effects retain their deduplication identity. Startup and
periodic sweeps discover the retry even though the insert trigger does not fire
on updates. This is an operator procedure, not a new administrative API.

Each recovery sweep deletes at most 500 expired rate-budget rows and 500 expired
nonaccepted guest invitations, using expiry indexes and bounded row locking.
Accepted guest invitations remain available for session-bound receipt recovery.
Cleanup never deletes current rolling-window budget rows.

## Public internet testing

The hardened baseline keeps five Compose services and named volumes. It adds
one independently generated `RUNTIME_DATABASE_PASSWORD`; follow the
[existing-volume cutover](../README.md#database-migrations-and-upgrades) with
all writers stopped. Back up first, preserve the existing bootstrap password
and previous compatible image, and do not delete a volume to fix migration
failure. Bootstrap credentials stay in postgres/migrate; API/worker use
non-superuser `next_round_runtime`, which still owns all application data.

Before announcing the URL, Matthew performs these operator checks:

- Use invitation-only test accounts, synthetic/non-sensitive content and a
  unique administrator password. Finish first-admin setup privately, remove
  `SETUP_TOKEN`, then recreate API. No extra proxy login gate is enabled.
- Keep `deploy/.env` mode 0600, outside Git/build contexts, public tickets and
  unencrypted backups. Keep an access-controlled encrypted recovery copy with
  database recovery material; retain Caddy data/config and the matching image.
- Verify from outside the host over **IPv4 and IPv6**: only Caddy TCP 80/443
  is public for this stack; API 3000, PostgreSQL 5432 and Caddy admin 2019
  are unreachable. Restrict SSH to existing administrative access.
  Docker-published ports can bypass UFW; UFW status alone is not proof.
- Confirm the public certificate and HTTP-to-HTTPS redirect, one enforced CSP,
  working same-origin WSS, sanitized logs, and a tested backup/restore using the
  existing runbook. No HSTS preload or unrelated-subdomain policy is added.
- Monitor memory, disk/WAL/table growth and pending worker age. Compose limits
  and log rotation contain local consumption, not volumetric DDoS. Patch the
  host and periodically review runtime/image advisories: digest-pinned is not
  permanently patched. Test and record pin/notices changes before deployment.

### Reproducible disposable stack proof

Use the pinned Node/pnpm toolchain, Docker Compose with `!override` support and
at least 4 GiB available RAM. Install/build the workspace and Chromium first:

```sh
sh scripts/fetch-cipher.sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium
```

Build `next-round-app:security-baseline` from the untouched Git revision being
upgraded, in a separate worktree after its pinned Cipher fetch. Record that
revision as `BASELINE_SHA`, then build the hardened image with the normal
Compose build command and run:

```sh
node scripts/ci/stack-security-smoke.mjs --baseline-image=next-round-app:security-baseline --baseline-ref="$BASELINE_SHA" --postgres-major=18
node scripts/ci/stack-security-smoke.mjs --baseline-image=next-round-app:security-baseline --baseline-ref="$BASELINE_SHA" --postgres-major=17
```

The runner requires both baseline arguments. It owns unique disposable projects
and volumes, binds test Caddy only to loopback 8080/8443, and fails rather than
stopping an existing port occupant. Local test certificate exceptions are scoped
to test clients. It exercises fresh setup and a populated-volume upgrade,
runtime privilege/data/checksum preservation, container/network containment,
HTTP/cookie/Origin/CSRF boundaries, real WS limits/longevity and compiled
Chromium game/theme/CSP behavior. CI runs both majors sequentially using the
exact PR base (or previous main commit) as baseline. This is local stack
evidence, not a penetration test or proof of the deployed host's firewall.

### Public-exposure blocker: stalled HTTP/1.1 uploads (2026-10-25)

On the pinned stock Caddy 2.11.7, the configured 30-second body-read timeout
does not reliably close a stalled HTTP/1.1 request. In the disposable HTTPS
stack, a login POST declaring a 100,000-byte body and sending only `{` remained
open beyond 45 seconds. This reproduces [upstream Caddy issue #8165](https://github.com/caddyserver/caddy/issues/8165).
Adding `Connection: close`, an error handler or `abort` to the stock Caddyfile
did not disconnect the probe. Do not treat a header timeout, HTTP/2-only probe,
larger request body or a configured timeout as passing this gate. Keep public
exposure blocked until a fixed upstream release is pinned and the exact
stalled-body scenario disconnects within the configured bound. The stock
five-service Compose deployment and image pin remain unchanged; no custom
proxy image or older Caddy release is authorized by this handoff.

Local full-stack runs on 2026-10-26 used baseline image
`next-round-app:security-baseline` from `f833971b432cc5f88617cd64900ca61b8de1a03f`:

```sh
node scripts/ci/stack-security-smoke.mjs --baseline-image=next-round-app:security-baseline --baseline-ref=f833971b432cc5f88617cd64900ca61b8de1a03f --postgres-major=18
node scripts/ci/stack-security-smoke.mjs --baseline-image=next-round-app:security-baseline --baseline-ref=f833971b432cc5f88617cd64900ca61b8de1a03f --postgres-major=17
```

Both PostgreSQL majors completed fresh setup and populated baseline-volume
upgrade scenarios. Role cutover, data and migration-ledger preservation, worker
processing, container/network containment, cookie and request denials,
Chromium/CSP behavior, and WebSocket survival beyond 60 seconds plus 1008 abuse
closure/peer invalidation passed. Both runs exited nonzero only because the
stalled partial HTTP/1.1 body remained open for 45 seconds. These are disposable
loopback tests, not external scans or live-host verification.

### Dependency audit disposition

The 2026-10-25 `pnpm audit --prod` run exits 1: four moderate and four low
findings, representing four `fast-uri` advisories in each of locked 3.x/4.x.
No high/critical finding was reported. Advisories:
[encoded schemes](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
[host canonicalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr),
[relative-path equivalence](https://github.com/advisories/GHSA-xhq7-xmqj-769h),
[suffix scheme injection](https://github.com/advisories/GHSA-333x-w4r6-6crp).
They affect URI normalization/host policy/suffix serialization, not a demonstrated
Next Round exploit. Inspected app code does not call `fast-uri` directly;
locked uses are in Fastify/AJV/Swagger schema tooling. The module schema
compiler rejects unsupported `$ref` keywords and installed module code is trusted.
No attacker-controlled URI-to-render/outbound-policy path was found in that
inspection; this is not an exhaustive reachability proof. BL-075 tracks a
reviewed update to patched 3.1.9/4.2.3 with lockfile/notices regeneration.
Do not call this audit clean. Public exposure remains blocked on any newly
identified reachable high/critical runtime issue.


## Evidence record

Record evidence after running the checks. Do not fill this table from expected behavior or code inspection.

| Check                                | PostgreSQL version | Command                                                           | Result / artifact                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production API and worker acceptance | 18.6, 17.11        | `pnpm test:sprint3`                                               | 2026-10-20: pass, 20/20 scenarios; negative control exits 1 at `consumer-visible private marker must be viewer-specific`                                                                                                                                             |
| Backup and restore with readiness    | 18.6, 17.11        | `node scripts/sprint3-operations.mjs`                             | 2026-10-20: pass, custom-format dump restored into an isolated database, row counts and fingerprints compared, compiled API ready against the restored copy                                                                                                          |
| Sprint 4 composed operations replay  | 18.6, 17.11        | `PG_MAJOR=18` (or `17`) `TEST_DATABASE_URL=... pnpm test:sprint4` | 2026-10-20, source `2f9043f`: pass, including the reused real dump/restore/readiness scenario, two-node recovery/version checks, 20 platform scenarios, required failing negative control and nine CLI/game scenarios. See [Sprint 4 evidence](sprint4-evidence.md). |

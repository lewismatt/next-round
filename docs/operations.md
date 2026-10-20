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

## Evidence record

Record evidence after running the checks. Do not fill this table from expected behavior or code inspection.

| Check                                | PostgreSQL version | Command                                                           | Result / artifact                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production API and worker acceptance | 18.6, 17.11        | `pnpm test:sprint3`                                               | 2026-10-20: pass, 20/20 scenarios; negative control exits 1 at `consumer-visible private marker must be viewer-specific`                                                                                                                                             |
| Backup and restore with readiness    | 18.6, 17.11        | `node scripts/sprint3-operations.mjs`                             | 2026-10-20: pass, custom-format dump restored into an isolated database, row counts and fingerprints compared, compiled API ready against the restored copy                                                                                                          |
| Sprint 4 composed operations replay  | 18.6, 17.11        | `PG_MAJOR=18` (or `17`) `TEST_DATABASE_URL=... pnpm test:sprint4` | 2026-10-20, source `2f9043f`: pass, including the reused real dump/restore/readiness scenario, two-node recovery/version checks, 20 platform scenarios, required failing negative control and nine CLI/game scenarios. See [Sprint 4 evidence](sprint4-evidence.md). |

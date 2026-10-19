# Transaction authority (F1-AUTH)

Match actions receive the authenticated session locator, rather than a principal
ID alone. They discover affected members, lock the acting and affected principals
in UUID order, then lock the match/membership and recheck the session before
reading a receipt or applying an action. A changed member set restarts the whole
transaction rather than acquiring a new principal lock out of order. Deadlocks
and serialization failures retry at most three attempts with the same command.

`transaction-authority.ts` supplies the common principal lock and current-session
checks. Revocation, auth-epoch mismatch, database-clock expiry, disabled accounts,
guest match scope and administrator role are checked against current rows. Account
disable locks the actor, target and administrator candidates together before
account/session/invitation writes; logout and CSRF rotation use the same
principal-first order. Idle refresh cannot extend an already expired session.
Future permission/reset/token/lifecycle writers must follow this order too.

Catalog and schema routes require authentication. Catalog/schema probes require
registration; an active guest may fetch only its match's exact pinned manifest.
Protected manifest responses use `no-store`; immutable declared browser assets
keep their public caching contract. Schema probes require origin and CSRF checks.

## Verification and boundaries

`pnpm --filter @next-round/api test:integration` uses real PostgreSQL:

- F1-01: preauthenticated actions wait behind disable, auth-epoch reset, expiry
  and logout barriers, then fail without state/receipt writes. Protected HTTP
  reads also deny the invalid session.
- F1-01/F1-04: an action that holds affected principals finishes before disable
  or auth-epoch reset. An identical receipt retry after revocation is denied.
- F1-01: stale administrator permissions cannot disable another account.
- F1-02/H2 boundary: anonymous catalog denial, registered catalog access, and
  guest denial outside an active exact pinned manifest, including schema probes.
- F1-05: the existing two-device conflict test observes waits at either the new
  principal lock or the match lock, then verifies one accepted transition.

CI runs these cases on PostgreSQL 18.6 and 17. Reset tests exercise the required
auth-epoch writer protocol directly; they do not prove a reset HTTP endpoint,
which remains H1 work. Production live/reconnect denial remains F1-09. Principal
status reducer effects, absent lifecycle commands, deadline reconciliation and
final projections retain their existing later acceptance gates. This change does
not establish full F1-01 acceptance or integration until reviewed and merged.

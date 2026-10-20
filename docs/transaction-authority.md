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
Match create/join/start/leave/action writers follow the same principal-first
order, current-session recheck and bounded retry protocol. New joins currently
admit registered principals to instance-visible matches; invite/link redemption
and new guest admission remain separate work.

## Final results (F1-06)

Action and lifecycle finalization share `final-results.ts`. The platform checks
the `FinalResult` envelope and validates `final.data` against the module's
`resultSchema` before writing transition effects. Final participants must cover
the match's member identities exactly once, including departed members. Career
output must cover eligible registered participants exactly once with finite,
nonnegative safe-integer metrics. Invalid output returns `MODULE_FAILURE`
without exposing result values.

Raw results, participant scores/contributions/name snapshots, career
contributions, state, event, deadlines and receipt commit together. Projection
inserts use the same transaction client and database uniqueness constraints.
Metric versions follow the pinned manifest's `resultVersion`; contribution
visibility comes from the match's policy snapshot, with solo forced to owner.
Only exclusion reasons shared by every participant enter the match-wide reason
list. Guest-only exclusions remain on their participant rows.

Receipt replay precedes revision and closed-match checks. A competing completion
at the old revision gets `STALE_REVISION`; an exact accepted-command retry
returns its receipt without adding another result or win.

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
- F1-LIFECYCLE: create, join, start, leave, exact receipt replay, rejoin period
  creation, and read revocation after leave run through HTTP on PostgreSQL 18.
- F1-06: overlapping completions, exact retry, deferred commit failure and
  rollback of all final effects, final departure, guest attribution, policy
  snapshot visibility and invalid final/career outputs.

CI runs these cases on PostgreSQL 18.6 and 17. Reset tests exercise the required
auth-epoch writer protocol directly; they do not prove a reset HTTP endpoint,
which remains H1 work. Production live/reconnect denial remains F1-09. Principal
status reducer effects and deadline reconciliation retain their later acceptance
gates. Lifecycle integration passes on PostgreSQL 18.6 and 17; full F1-01
acceptance remains open.

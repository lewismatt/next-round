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

## Durable effects (Sprint 1: F1-07 / F1-08)

Create, lifecycle, action and deadline transitions share one state/event/result
and effects persistence path. Exact receipt replay and expected-revision checks
precede deadline reconciliation. An authorized command at the current revision
reads `clock_timestamp()` after locking the match. If pending deadlines are due,
their transitions commit first; the user intent receives `STALE_REVISION`
without a receipt or gameplay effect. System events use the same sorted
principal-first locks and retry membership discovery if a join raced the lock.

The complete emitted deadline set is validated before any status change.
Duplicate keys, reuse of consumed/cancelled identities, or re-emitting the fired
identity fail with `MODULE_FAILURE` and roll back the whole transaction.
Retained pending identities keep their stored due time, event UUID, scheduling
outbox row and obligation notification. New identities create a scheduling
effect; omission cancels an identity, except that the applied deadline event
consumes its own identity. Snapshot timestamps use canonical UTC milliseconds.
Due identities are processed in stored due-time/key order; newly emitted
deadlines are not a historical catch-up loop.

`match-effects.ts` writes `deadline.schedule` and `live.invalidate` outbox rows
in the state transaction. It also materializes deduplicated action/result
notifications, supersedes unread completed obligations, creates one
`turn_missed` per expired obligation/recipient, and advances inbox/home counters.
Voluntary completion never creates a missed-turn notification. Notification
payloads and invalidations contain IDs/revisions, not notes or private state.

The worker claims bounded outbox batches with `SKIP LOCKED` and 30-second
leases. Monotonically incremented `attempts` fence acknowledgements and retry
updates; timestamps are not round-tripped through JavaScript as lease tokens.
Scheduling uses the stored deadline event UUID as the pg-boss job ID, because
`singletonKey` alone does not deduplicate a standard queue. Effect success
followed by acknowledgement loss can safely redeliver. Retry backoff is bounded
at 60 seconds; undelivered rows remain inspectable. Cancelled/consumed job
wakeups are harmless rather than requiring queue deletion.

Startup and periodic bounded sweeps process overdue deadlines and pending
outbox effects even if scheduling never ran. PostgreSQL `next_round_live`
notifications are post-commit wakeups; the API listener, authorized WebSocket
fanout and per-node recovery sweep are Sprint 2, not supplied by this worker.
Both processes must load the same pinned modules; Test Counter requires
`NEXT_ROUND_ENABLE_TEST_COUNTER=true` on each. Failure injection uses test-local
reducers, SQL triggers and database wrappers, never production clock/fault routes.

BL-001 aligns stale-before-closed precedence across command paths. BL-002
explicitly checks for a server before invoking career hooks. BL-003 repairs a
missing snapshot `statsVisibility` only from that match's immutable
`policy_version`, inside finalization; explicit invalid values or an invalid
original policy fail closed. Current defaults never broaden historical privacy.


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
- F1-07: due command/worker overlap, timeout commit before stale rejection,
  retained identity/time across notes and late join, fresh generation,
  cancellation versus consumption, malformed output rollback and policy backfill.
- F1-08: worker startup recovers unscheduled effects, lease expiry and lost
  acknowledgements redeliver safely, and PostgreSQL wakeups contain only safe IDs.

CI runs these cases on PostgreSQL 18.6 and 17. Reset tests exercise the required
auth-epoch writer protocol directly; they do not prove a reset HTTP endpoint,
which remains H1 work. Production live/reconnect denial remains F1-09. Principal
status reducer effects retain their later acceptance gates. Compiled API/worker
restart smoke checks on PostgreSQL 18.6 and 17.11 prove retained deadlines and
notes, overdue-once processing, cancellation/replacement and post-commit wakeups.
Full F1 acceptance remains open.

# ADR 0001: Preserve pending deadline identity

Status: Accepted. Specification clarification only; runtime acceptance remains unverified.

Date: 2026-10-19

Sources: [audit finding M-8](https://github.com/lewismatt/next-round/issues/1), [master specification sections 2, 5 and 10](../spec/master-spec.md), [canonical Notion specification](https://app.notion.com/p/3fd972a22c75816eb745fdf71d2b6fc7).

## Problem

`Transition.deadlines` is a complete replacement set, but `RuleContext` does not expose existing deadline rows. Test Counter's note and active join reducers emit the same key/generation with a time recomputed from `ctx.now`. Treating that output as replacement rows would extend the current turn after each note or join.

## Decision

The platform reconciles the desired active set by `(matchId, key, generation)` under the match lock. An existing pending identity retains its stored `dueAt`, event ID and scheduling deduplication identity, unless it is being consumed by the applied deadline event. A different valid emitted time for a retained identity is ignored. New identities use the emitted time. When the applied event is `{kind:"deadline", deadline}`, the consuming transition marks that omitted pending identity consumed rather than cancelled. It MUST NOT appear in the output. Other omitted pending identities are cancelled. An empty set from a deadline event consumes the fired identity and cancels the others; otherwise an empty set cancels all pending identities. Rescheduling requires a never-used generation for the key.

Validate the complete output before any status change or other row change. Duplicate keys, reuse of consumed/cancelled identities and re-emission of the identity being consumed are invalid module output (`MODULE_FAILURE`), with no partial commit. Retention creates no new scheduling or obligation-notification effect; scheduling retry and overdue reconciliation remain available. Snapshots and due checks use stored times.

The alternative is to add active deadlines to `RuleContext` and require every reducer to return the original time. Platform preservation avoids a required SDK field and prevents unrelated actions from moving the authoritative timer. The platform already owns the locked deadline rows and their event/job identities. No SDK signature, package pin, schema migration or gameplay policy changes.

## Consequences and verification

Reducers retain an obligation by returning its key/generation. They must emit a fresh generation to change its time. Module-private state must not assume that a newly emitted time replaced the stored time for a retained identity.

Master-spec F1-07 now requires notes/late join at later server times to preserve stored/snapshot time and event/scheduling/notification identity, including a changed emitted time. It also requires fresh-generation replacement, cancellation, invalid-output rollback, restart and lost-scheduling cases on PostgreSQL 18 and 17. F1-08 continues to own general restart recovery.

This change synchronizes specification text and the SDK comment. Test Counter reducers are intentionally unchanged: their retained identities are covered by the selected platform semantics. The real match/deadline transaction service is still an F1 prerequisite. No pure reducer test or simulated diff is evidence that platform preservation, job delivery or PostgreSQL acceptance passes. M-8 specification review does not complete F1, F2 or the blocked H-2 platform acceptance.

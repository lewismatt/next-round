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

| ID     | State | Found in                        | Location                                                        | Issue                                                                                                                                                                                                                                                                                        | Notes                                                        |
|--------|-------|---------------------------------|-----------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|
| BL-001 | Fixed | PR #27 review (Larry, 2026-10-19) | `packages/platform/src/match-service.ts` | Lifecycle and action commands now check stale revision before closed state, after authorization and receipt replay. | [Sprint 1](https://github.com/lewismatt/next-round/tree/feat/s1-durable-effects); PostgreSQL regression covers both paths and outsider denial. |
| BL-002 | Fixed | PR #27 review (Larry, 2026-10-19) | `packages/platform/src/final-results.ts` (`prepareFinalResult`) | Replaced the server non-null assertion with an explicit `MODULE_FAILURE` guard before the career hook. | [Sprint 1](https://github.com/lewismatt/next-round/tree/feat/s1-durable-effects); no accidental TypeError fallback. |
| BL-003 | Fixed | PR #27 review (Larry, 2026-10-19) | `packages/platform/src/final-results.ts` (`persistFinalResult`) | Missing snapshot `statsVisibility` is backfilled transactionally from the match's pinned immutable policy version, never current defaults. Invalid original policies/explicit values still fail closed. | [Sprint 1](https://github.com/lewismatt/next-round/tree/feat/s1-durable-effects); PostgreSQL regression proves historical owner visibility and rollback on invalid policy. |
| BL-004 | Open | PR #28 retro review (Larry, 2026-10-19) | `apps/worker/src/worker.ts` (`deliverOutboxRow`) | Permanently failing outbox rows (invalid payload / unknown topic) are released with capped exponential backoff and retried forever — no max-attempts or dead-letter state. Payloads are platform-generated today, so unreachable in practice; schema drift would leave a zombie row erroring every ≤60s indefinitely. | Consider a max-attempts threshold that parks the row and logs once at ERROR instead of retrying forever. |
| BL-005 | Open | PR #28 retro review (Larry, 2026-10-19) | `apps/worker/src/worker.ts` (constructor) | `LIVE_RECONCILE_INTERVAL_MS` is parsed with `Number(...)` and never validated: a non-numeric value yields NaN, making `setInterval` fire ~every 1ms in a reconcile spin; a `0` option value also falls through to env/default silently. | Validate at startup: finite positive integer within a sane range, fail fast with a clear error otherwise. |

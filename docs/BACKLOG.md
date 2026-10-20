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
| BL-001 | Open  | PR #27 review (Larry, 2026-10-19) | `packages/platform/src/match-service.ts` (`actOnce` vs `runLifecycleCommandOnce`) | Check-order asymmetry: the action path returns `STALE_REVISION` before `MATCH_CLOSED` on a stale revision; the lifecycle path keeps the old order (`MATCH_CLOSED` first). Both are refresh-safe, but the two paths should agree on one order. | Decide one order, apply to both, pin with a test.            |
| BL-002 | Open  | PR #27 review (Larry, 2026-10-19) | `packages/platform/src/final-results.ts` (`prepareFinalResult`) | `registered.server!` non-null assertion: a missing server throws `TypeError`, which the surrounding try/catch converts to `MODULE_FAILURE`. Safe only by accident — make it an explicit guard. | One-line explicit check preferred.                           |
| BL-003 | Open  | PR #27 review (Larry, 2026-10-19) | `packages/platform/src/final-results.ts` (`persistFinalResult`) | If a match's `policy_snapshot` ever lacks `statsVisibility`, finalization fails closed with `MODULE_FAILURE`. Fail-closed is correct, but there is no explicit backfill/assertion for rows predating the snapshot field. | Verify backfill or add a defensive default + test.          |

# AGENTS.md — Implementation Agent Entrypoint & Protocol

Welcome to **Next Round**. All automated agents working in this repository MUST strictly follow this operational protocol.

## Authority & Canonical References

- **Planning Hub:** [Next Round — Planning Hub](https://app.notion.com/p/Next-Round-Planning-Hub-3fd972a22c7581f689b3dde8783df72d)
- **Work Tracker & Handoffs:** [08 — Agent Handoff & Work Tracker](https://app.notion.com/p/3fd972a22c7581eca2f7fe7fb46d593b)
- **Agent Workflow:** [Next Round — Pick Up Work and Hand Off](https://app.notion.com/p/3fd972a22c7581fba1b4c3b455608ea0)
- **Authoritative Specification:** [docs/spec/master-spec.md](docs/spec/master-spec.md) (Master Specification v1.2, Apache-2.0)

## Mandatory Agent Workflow

Every session MUST execute this 4-step loop:

1. **Reconstruct actual state:**
   - Fetch [Page 08 (Work Tracker)](https://app.notion.com/p/3fd972a22c7581eca2f7fe7fb46d593b) freshly. Check the current handoff, active claims, blockers, and queue.
   - Verify local git branch, commit HEAD, and remote repository status (`lewismatt/next-round`). Never rely solely on chat memory or historical summaries.

2. **Pick and claim the next logical chunk:**
   - Honor the user's requested scope. For a review or maintenance request, claim a bounded review/maintenance chunk instead of starting a queued feature.
   - Take the earliest `Ready` dependency-satisfied chunk in the queue.
   - **BEFORE EDITING CODE**, update Page 08 to claim the chunk: set status to `In progress`, record agent ID, UTC claimed-at timestamp, working branch, and intended deliverable.
   - Re-fetch Page 08 to ensure no conflicting claims exist.

3. **Implement and verify:**
   - Work on the designated branch.
   - Adhere to the approved architectural boundaries (pure reducers for games, platform owns database/auth/transactions, native WS for invalidations, HTTPS for commands).
   - Direct package pins must match the baseline table; no floating versions or unrecorded dependencies.
   - Run gates appropriate to the scope:
     - Pure rules/schemas: unit tests (`pnpm test`).
     - Transactions/concurrency: real PostgreSQL instances (majors 18 and 17).
     - Browser builds: verify no server code is leaked into web bundles (`pnpm build`).

4. **Finish with a durable handoff:**
   - Update Page 08 before concluding the turn/session.
   - Record exact exit evidence (commands run, tested commit SHA, database versions, pass/fail results).
   - If acceptance criteria are met and integrated, set chunk to `Done` and promote eligible dependent chunks to `Ready`. If incomplete or blocked, record exact status (`In progress` or `Blocked` with concrete unblock conditions).
   - A merged acceptance subset is not a passed acceptance row. Retain unchecked sentences and missing prerequisite services explicitly; use `Review` for a ready change awaiting integration.
   - Append a structured session handoff entry using the template in Page 08.

## Inviolable Architectural Invariants

- **Game Isolation**: Modules implement `GameServer<S, V>` with pure synchronous `transition(ctx, state, event)` and `view(ctx, state, viewer)`. Game code NEVER receives direct database access, network sockets, or filesystem handles.
- **Client Bundling**: Game client code is mounted via `GameBridge`. Browser builds MUST NEVER traverse or bundle server exports or secret credentials.
- **Error Privacy**: Error responses and logs MUST NEVER contain passwords, tokens, hidden solution data, or unescaped reducer internal state.
- **Transactions & Concurrency**: All match state transitions are serialized via PostgreSQL transactions with optimistic revision concurrency (`expectedRevision`).
- **Jobs & Schedules**: Background work, deadline checks, and outbox sweeps use `pg-boss` and transactional deduplication keys.

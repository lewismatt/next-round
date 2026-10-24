<!-- SPDX-License-Identifier: Apache-2.0 -->

# Trivia — Second Game Module (Sprint T)

**Status:** Implemented in [PR #42](https://github.com/lewismatt/next-round/pull/42),
awaiting independent review and integration. Implements the README second-game
review against SDK `next-round-game/0.1` with **no contract change**.
Sprint T proves that contract against a second real game (Option A, 2026-10-23);
it does not declare a general SDK compatibility guarantee.

## Game shape

A private-answer trivia match. Lobby → active rounds → finished.

- Each round reveals one question to all enabled members at once. Every
  enabled member submits an answer privately before a single, stable round
  deadline.
- At the deadline, the deadline event closes the round, scores the answers,
  and reveals the explanation, correct choice and all accepted submissions.
  Until that transition, each member can see only their own submission.
- After the last round, the match finishes with per-member scores, outcome,
  eligibility, and public attribution.

## Reducer state (JSON, pure `transition`/`view`)

- Platform-pinned `settings`: `rounds` (1–20, bounded by bank size) and
  `secondsPerRound` (1–300). Solo supports one player; group supports 2–8.
- The platform pins `resourceId`, identity, version and private resource snapshot.
  The draft's redundant `bankIdentity` setting was removed: the public catalog
  deliberately does not expose the bank digest. No platform/SDK change is needed.
- State contains current `answers` keyed by member ID, fixed `roundMemberIds`,
  `roundIndex`, per-member `scores`, and closed-round `reveals`.
- `generation`/`dueAt` identify the round deadline; suspension retains remaining
  milliseconds and restores the same round with a fresh deadline generation.
  The platform owns `phase`; the reducer returns it with each transition.
- No wall-clock reads in the reducer: deadlines arrive as platform `deadline`
  events; `now` comes from `RuleContext`.

## Event handling (maps to the SDK's `GameEvent`)

- `create` / `join` / `start`: standard lifecycle. `start` deals the first
  round and sets its deadline; the deadline is part of the returned
  `Transition.deadlines` set.
- `action` (`submit`, payload `{roundIndex, choice}`): records the actor's
  zero-based choice for the specified round. The round index prevents a delayed
  explicit retry from answering a different question.
  Rules, enforced in the reducer:
  - One answer per member per round. A duplicate command's receipt replays
    before transition; a new command **cannot replace** an accepted answer.
  - The round deadline is **stable**: individual submissions never move it.
  - A submission at an overdue deadline receives the platform's reconciled
    revision (the round is already closed by the deadline event).
- `deadline`: closes the current round — scores answers, exposes the
  explanation, advances to the next round (new deadline) or finishes.
- `leave`: a member who leaves is gone; disconnect never leaves (platform
  semantics, not the module's).
- `principal_status` (disabled): removes the member's obligations — they are
  no longer in `needsActionFrom` — without inventing an answer for them.
  If all members are disabled, the round suspends with progress preserved
  explicitly (round state and answers are kept, not discarded).
- Late joiners and members who leave/rejoin start at the **next** round.
  Disabled members retain accepted answers; reactivation restores obligations
  only if they are still in the current roster. If no enabled active members
  remain, progress pauses; a reactivation or join restores remaining time.
- `finish` (host-ended): produces `final` from closed-round scores only, with no
  reveal or score for the still-private current round.

## Privacy rules (the load-bearing part)

- `view` returns the current question and **only the viewer's own
  submission**. It never contains the answer key, the question bank, other
  members' pre-reveal submissions, or any answer digest.
- Post-reveal views contain the round's submissions and explanation — that
  information is public only after the deadline event closes the round.
- `final` stores per-member scores, outcome, eligibility, and public
  attribution. `resultView` needs no answer bank and no retained
  submissions. `career` metrics derive from `final` only.
- Errors use safe rule codes and never embed submitted answers.

## Concurrency and conflict UX (explicit, per the paper review)

- `needsActionFrom` contains **all eligible enabled members** still awaiting
  submission — simultaneous, not turn-based; late joiners wait for the next round.
- Each accepted submission goes through the shared transaction/revision path
  (`expectedRevision`).
- A stale submission cannot auto-replay: the client shows an authoritative
  refresh and an **explicit retry** of the user's intent. This UX is an
  acceptance item (T-A5), not a nicety — the serialized revision protocol
  requires it.

## Content: starter question bank

- Imported as an immutable server-private resource via `importResource`,
  pinned by exact module/assets and resource version.
- `games/trivia/content/starter.json` contains six original agent-drafted factual
  questions, released under CC0-1.0 with that provenance in `attribution`.
  No human review/attestation is claimed. A full question library is a separate
  CONTENT-track decision.
- The bank is never copied into a view or an invalidation.

## Client

- GameBridge client: question display, private answer input, countdown to
  the stable deadline, reveal screen, final standings.
- No server code in the browser bundle (build gate, same as crossword).
- The finished shell mounts the trivia client while private state is retained,
  so the final question's reveal is visible too. Standings remain platform-owned.
  After pruning, the bank-free result projection remains available, not the
  detailed question/answer history.
- Stale responses preserve the selected answer but require an explicit retry
  against the refreshed same round. An unknown transport result retains the
  original command ID **and revision** for receipt replay; it never auto-replays.


## Acceptance rows (Sprint T)

- **T-A1 (simultaneous submissions):** all enabled members submit in one
  round; each accepted once; a duplicate is replayed, never replaced.
- **T-A2 (deadline):** submissions never move the deadline; expiry closes
  the round, scores it, and reveals only the public explanation.
- **T-A3 (privacy):** pre-reveal views contain no key, bank, digest, or
  other members' answers; post-reveal views contain submissions +
  explanation; `final`/`resultView`/`career` need no bank.
- **T-A4 (membership):** disconnect never leaves; disabled members lose
  obligations with no invented answers; late joiners start next round;
  all-disabled suspension preserves round progress explicitly.
- **T-A5 (conflict UX):** a stale submission yields an authoritative
  refresh and an explicit retry; the client never auto-replays.
- **T-A6 (harness proof):** real-PostgreSQL tests for submission races,
  deadline expiring mid-submission, membership paths, view-leak checks,
  and results after private-state pruning.
- **T-A7 (SDK verdict):** a written verdict on whether SDK 0.1 holds
  unchanged under a second game, or what minor bump trivia forces.

## Out of scope

Real question library, matchmaking, per-question timers beyond the round
deadline, UI polish beyond the module client, and any SDK contract change
(unless T-A7 evidence forces one — then it is a finding, not a silent
change).

## Shipped rules and operator workflow

- Each correct answer earns one point at the deadline. Answering early never
  advances a round. Questions use bank order; repeat play is not exposure-ranked.
- Ties at a positive maximum score are co-wins; all-zero results have no winner.
  Completed group matches grant career contributions to enabled registered
  participants. Solo, guest, disabled and host-ended results carry explicit
  exclusions. A guest does not exclude registered peers.
- Leaving never erases an accepted answer or earned score. Disconnecting is not
  a leave. There is no automatic answer or score for a disabled/absent player.
- Import `games/trivia/content/starter.json` through **Admin → Trivia library**.
  Then **Start a game → Trivia**, choose Solo/Group, bank, rounds and duration.
  The server requires an imported resource; there is no automatic database seed
  or browser-embedded question bank.
- A custom bank uses exactly `format`, `title`, `attribution`, `license` and
  `questions`; each question has `id`, `prompt`, `choices`, `correctChoice`,
  `explanation`. IDs and choices must be unique, 2–8 choices/question,
  1–1000 questions/bank, CC0-1.0 only. Import errors contain no submitted text.
- Canonical SHA-256 covers all bank fields, including choice order, explanations
  and attribution. JSON property order/whitespace are immaterial. Catalog
  metadata contains title, question count and rights, never questions or hashes.

## SDK verdict and verification

**T-A7: SDK 0.1 holds unchanged for this implementation.** Existing private
resources, synchronous reducers, simultaneous obligations, desired deadlines,
membership events, GameBridge and final/career hooks cover the game. No SDK,
wire schema, platform transaction or database migration was required. Web-shell
integration preserves the existing stale error code and renders retained final
reveals; this is application integration, not a new bridge method.

Automated acceptance lives in `games/trivia/src/{content,server}.test.ts` and
`apps/api/src/trivia-acceptance.integration.test.ts`. The latter uses actual
PostgreSQL transactions and the production HTTP routes, not mocked reducers.

- T-A1/T-A2: a two-member same-revision race produces one success and one
  `STALE_REVISION`; explicit retry accepts the loser, duplicate receipt replay
  changes no revision, a new command cannot replace an answer. The original
  deadline survives submissions. Due reconciliation precedes a late action;
  round-index fencing rejects old intent.
- T-A3/T-A4: pre-reveal privacy, scoring/public reveals, late join/leave/rejoin,
  all-disabled pause/resume with preserved answers and actual pruned-state
  result/career reads are covered.
- T-A5: compiled browser against the real API/worker completed two rounds,
  including an induced stale action (revision 3, no automatic replay; explicit
  retry → revision 4, same deadline). A second browser scenario dropped a real
  committed response and its refresh: explicit retry reused exactly the same
  command ID/revision and recovered the receipt.
- Actual HTTP/native-WS harness disconnect/reconnect retained revision 2,
  active membership and the accepted choice. Browser setup, compact radio
  selection, deadline reveal, final-round reveal and platform standings were
  inspected on the compiled surface.
- Focused suite: 9/9 on PostgreSQL 18.6 and 17.11. Full workspace suite:
  **37 files / 411 tests on each major**, using `pnpm test --maxWorkers=2`.
- `pnpm install --frozen-lockfile`, `pnpm build` (15-artifact scan),
  `pnpm typecheck` and zero-warning `pnpm lint` pass with Node 24.22.0 /
  pnpm 12.14.0.
- `docker build --file deploy/Dockerfile --target app` and
  `scripts/ci/image-module-smoke.mjs` pass: both API and worker register Trivia,
  Crossword and opt-in Test Counter in a fresh stock image without layout repairs.

No merge, public deployment, production-stack change or human content sign-off
is claimed. The sprint remains **Review** until integrated.

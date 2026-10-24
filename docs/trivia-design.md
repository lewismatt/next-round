<!-- SPDX-License-Identifier: Apache-2.0 -->

# Trivia — Second Game Module: Design (Sprint T, T0)

**Status:** Design chunk (T0). Implements the README second-game paper review
("simultaneous trivia") against SDK `next-round-game/0.1` with **no contract
change**. Purpose of this sprint: prove the SDK generalizes to a second real
game before it is called stable (Option A, decided 2026-10-23).

## Game shape

A private-answer trivia match. Lobby → active rounds → finished.

- Each round reveals one question to all enabled members at once. Every
  enabled member submits an answer privately before a single, stable round
  deadline.
- At the deadline, the deadline event closes the round, scores the answers,
  and reveals only the now-public explanation (plus each member's own
  submission and the round's correct answer, which is public after reveal).
- After the last round, the match finishes with per-member scores, outcome,
  eligibility, and public attribution.

## Reducer state (JSON, pure `transition`/`view`)

- `settings`: `rounds` (number of rounds), `secondsPerRound`, `bankIdentity`
  (the imported resource identity of the question bank).
- `rounds`: one entry per round — `questionId`, `answers` keyed by member ID
  (`{ choice }`), `closed` flag, `correctChoice` (revealed only at close).
- `scores`: per-member running totals. `roundIndex`, `phase`.
- No wall-clock reads in the reducer: deadlines arrive as platform `deadline`
  events; `now` comes from `RuleContext`.

## Event handling (maps to the SDK's `GameEvent`)

- `create` / `join` / `start`: standard lifecycle. `start` deals the first
  round and sets its deadline; the deadline is part of the returned
  `Transition.deadlines` set.
- `action` (`submit`): records the actor's answer for the current round.
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
- Late joiners: start at the **next** round. This is the module's documented
  choice (the paper review leaves the choice to the module).
- `finish` (host-ended): produces `final` from the scores so far.

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

- `needsActionFrom` contains **all** enabled members still awaiting
  submission — simultaneous, not turn-based.
- Each accepted submission goes through the shared transaction/revision path
  (`expectedRevision`).
- A stale submission cannot auto-replay: the client shows an authoritative
  refresh and an **explicit retry** of the user's intent. This UX is an
  acceptance item (T-A5), not a nicety — the serialized revision protocol
  requires it.

## Content: starter question bank

- Imported as an immutable server-private resource via `importResource`,
  pinned by exact module/assets and resource version.
- The sprint ships a **small starter bank of original questions** with a
  provenance note in the bundle. A full question library is a CONTENT-track
  decision (Matthew's lane), not this sprint.
- The bank is never copied into a view or an invalidation.

## Client

- GameBridge client: question display, private answer input, countdown to
  the stable deadline, reveal screen, final standings.
- No server code in the browser bundle (build gate, same as crossword).

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

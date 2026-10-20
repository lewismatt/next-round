# Sprint 5 — crossword module foundation (F3-A)

Date: 2026-10-20. Agent: `omp-s5-20261020`.

- Base: `main` at `1feb4d79fd8676e3754b18230dc909fcccecf606`.
- Branch: `feat/s5-crossword-foundation`.
- Implementation: `a9f700c`.
- Scope: bounded subchunk **F3-A** of Sprint 5 — the crossword module and the
  platform substrate it needs. The remaining Sprint 5 scope is listed under
  "Scope, failures and remaining work".
- Node 24.22.0, pnpm 12.14.0; PostgreSQL 18.6-alpine and 17.11-alpine.
  One new workspace package (`@next-round/game-crossword@0.1.0`) and one new
  direct dependency pin (`@types/node@24.10.8`, already pinned at the root).
  No database migration, no new external runtime dependency, no change to an
  existing direct pin.

## Delivered behavior

### Crossword module (`games/crossword`)

- **Content/import contract (C1).** `src/content.ts` validates a
  `next-round.crossword/1` document: format, title/author lengths, language,
  difficulty, rights (allowlist `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, https
  `sourceUrl`, attribution, permission note), rectangular 3–25 grid of `#` and
  `A–Z`, one orthogonally connected open region, no one-cell entries, every
  open cell in both an across and a down entry, and exactly one non-empty clue
  per derived maximal entry of length two or more. Clue numbers are derived
  row-major and the supplied numbering is ignored. The identity is the
  SHA-256 of the canonical identity JSON over the uppercase rows.
- **Rules (C2–C4).** `src/server.ts` is a pure reducer over the pinned
  resource snapshot. It implements the locked settings (solo casual, quick and
  custom presets, bounded wrong/correct/turn budgets), turn counters that a
  correct word does not reset, the shared wrong budget across clues, the
  one-point-per-explicit-solve rule with crossings completing for zero points,
  whole-word submission with the documented normalization, rule rejections for
  malformed answers, conflicting crossings, already filled words and
  out-of-turn actions, solo reveals (letter, word, puzzle) with the assisted
  marking of every crossing word, multiplayer reveal rejection, exposure
  checks at start and at a late join, the external-knowledge declaration,
  match-wide monotonic career exclusions, the timeout removal flag and its
  clearing, disabled-player skipping, temporary acting-host authority,
  all-disabled suspension with preserved counters and a fresh remaining-time
  deadline on reactivation, and permanent host succession on explicit
  departure.
- **Authorized view.** The lobby publishes the title, dimensions and rights
  only: no clues, no grid shape, no board. After the start the view publishes
  the clue list, the accepted shared board, completed and assisted flags, the
  scores, the rotation, the acting host, the viewer's own wrong feedback and
  remaining budget, the turn deadline, the continue state and the public
  exclusion reasons. It never returns the resource object, an unsolved letter,
  another member's guess or another member's remaining budget.
- **Browser client.** `src/client.ts` renders the grid, both clue lists, the
  explicit word submission, cell typing, the private feedback, the timer, the
  pass/continue/reveal/declare controls and the score list. Drafts are local
  only; a cell letter is never sent as a guess. The client imports no server
  code, so `node:crypto` cannot reach the browser bundle.

### Platform substrate

- **Resources.** `packages/platform/src/resource-service.ts` stores versioned
  server-private content with separate public catalog metadata. An import
  validates the document against the module's declared import schema, calls
  the module's `importResource` hook, validates the returned metadata and data
  against the module's schemas, records the importer's exposure fact and
  writes an audit record. The same grid keeps one identity; identical content
  is a duplicate, changed clues or metadata create a new immutable version.
  Active match snapshots are never overwritten.
- **Facts.** `module_facts` rows are principal-scoped per resource identity.
  A module reads only the facts of the current or proposed members of its
  pinned resource, and a transition may only write facts for those members.
  Fact values are validated against the module's declared fact schemas.
- **Resource-bound matches.** A match pins one resource version and stores an
  immutable snapshot of the private content. Every resource-bound command
  locks the resource identity before the match row, so two overlapping matches
  on one puzzle cannot both observe an unrecorded exposure.
- **API.** `POST /api/v1/admin/games/:id/import` (administrator only, CSRF and
  exact Origin required, 1 MiB document limit, idempotent per `commandId`) and
  `GET /api/v1/games/:gameId/resources` (registered users only, keyset
  pagination, catalog metadata only — never the private data and never the
  solution-derived identity digest).

## Executed gates

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
node scripts/check-spdx.mjs

TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/next_round \
  pnpm exec vitest run --maxWorkers=2
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/next_round \
  pnpm exec vitest run --maxWorkers=2
```

| Gate                                    | Observed outcome                                                       |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Build                                   | Pass; 14 browser artifacts including `games/crossword/0.1.0/client.js` |
| Browser bundle check                    | Pass; no server fixture secret in any artifact                         |
| Typecheck                               | Pass; all 13 workspace projects                                        |
| Lint                                    | Pass; 0 warnings                                                       |
| SPDX headers                            | Pass; 111 tracked source files                                         |
| Crossword unit tests (PG independent)   | Pass; 87 tests (54 content, 3 manifest, 30 rules)                      |
| Crossword resource API integration test | Pass; 6 tests on PostgreSQL 18.6 and 17.11                             |
| Full workspace suite, PostgreSQL 18.6   | Pass; 26 files, 346 tests                                              |
| Full workspace suite, PostgreSQL 17.11  | Pass; 26 files, 346 tests                                              |

The API integration test runs against a disposable database created with
`CREATE DATABASE ... TEMPLATE template0`, migrated with the production
migration CLI, and dropped afterwards.

### Compiled API smoke run over real HTTP

The compiled API (`apps/api/dist/index.js`) was started against a disposable
PostgreSQL 18.6 database and driven with `fetch` over TCP:

```text
POST /api/v1/admin/games/crossword/import   -> 201
GET  /api/v1/games/crossword/resources      -> 200  (1 catalog entry, "Smoke Grid")
POST /api/v1/matches                        -> 201
GET  /api/v1/matches/:id                    -> 200  (lobby: clues null, board null)
POST /api/v1/matches/:id/start              -> 200
GET  /api/v1/matches/:id                    -> 200  (10 clues, first "First across")
POST /api/v1/matches/:id/actions            -> 200  (wrong guess)
POST /api/v1/matches/:id/actions            -> 200  (correct word, revision 3)
```

The snapshot body never contained the solution row (`ABCDE`), and the private
feedback showed only the requesting member's wrong guess
(`{lastWrongGuess:"XXXXX", remainingWrong:null, turnGeneration:1}`).

## Requirement-to-evidence map

| Requirement                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 content/import contract         | `games/crossword/src/content.test.ts` (54 tests): validation rejections, entry and clue derivation, row-major numbering, canonical identity digest, public metadata without solution or digest.                                                                                                                                                                                                                                                                                            |
| C1 import path                     | `apps/api/src/crossword-resource.integration.test.ts`: import 201, duplicate identity, new version on changed clues, rejected document 422 with reasons and nothing stored, non-admin 403, replayed command, conflicting command 409, catalog metadata without solution or identity.                                                                                                                                                                                                       |
| C2 settings and input              | `server.test.ts`: settings rejected when they do not match the mode, wrong budget shared across clues, correct does not reset the wrong count, turn ends at the limit, pass advances the rotation, malformed answer and conflicting crossing are rule rejections, crossing completion scores zero, one point once.                                                                                                                                                                         |
| C3 exposure and reveals            | `server.test.ts`: prior exposure and importer exposure exclude the match, the match's own exposure does not, declaration latches before the start, reveal marks both crossing words assisted, an assisted word scores zero, multiplayer reveals are rejected, repeated reveal of a filled cell is rejected, a revealed puzzle ends `revealed` with the earned points. Integration: exposure facts are persisted at the start and a second overlapping match latches `prior_exposure`.      |
| C4 inactivity and disabled members | `server.test.ts`: timeout flags the expired actor and advances the turn, the host's removal authority lists that actor, three wrong guesses never flag, the flag clears on the flagged member's next voluntary action, a disabled current player ends their obligation without points, a disabled host hands authority to the earliest enabled member, all-disabled play suspends and resumes with a fresh deadline, an explicit host departure transfers the host and excludes the match. |
| §3 resource endpoints              | `apps/api/src/routes/games.ts`: admin import and public catalog routes; integration test covers both, including the 1 MiB limit path and the catalog contents.                                                                                                                                                                                                                                                                                                                             |

## Interpretation decisions

- **Solo with a custom adjustment.** C1 fixes the modes (`solo`, `quick`,
  `custom`) and C2 fixes the settings presets (`solo_casual`, `quick`,
  `custom`). Because C2 states that any timer or other adjustment is custom, a
  solo match accepts the all-unlimited `solo_casual` preset or a custom
  adjustment; the custom preset keeps the match career-ineligible. The
  `custom` mode still requires two players.
- **Rights allowlist.** A license outside `CC0-1.0`, `CC-BY-4.0` and
  `CC-BY-SA-4.0` is rejected until an operator records a reviewed exception in
  the allowlist. An import cannot verify legality by itself, so the module
  never accepts an unverifiable license.
- **Import idempotency.** The import receipt is stored in `command_receipts`
  with a null match id, because the shared table's match columns are not
  meaningful for a content import.

## Scope, failures and remaining work

Delivered in this subchunk: the crossword module (content contract, rules,
authorized view, browser client) and the platform resource/fact substrate with
their unit and real-PostgreSQL integration evidence.

Not delivered, still open in Sprint 5:

- The three bundled original CC0-1.0 puzzles. They are a human deliverable
  under D54: an agent may draft the grid, fill and clues, but a puzzle counts
  only after the author of record reviewed and edited it, completed the
  solution/clue correctness review, played it cold and signed the CC0-1.0
  attestation. The F3 exit gate is unchanged.
- The setup and library UI in the shell, and the production Home, Games,
  History and Admin flows, plus the responsive light/dark and accessibility
  pass on the shell.
- The C5 acceptance harness, including the adversarial exposure fixtures
  (overlapping matches, rolled-back starts, late admission of an exposed
  player, declaration before start, reconnect and guest cases) and the full
  phone/keyboard journey. The rules those fixtures exercise are unit tested
  here, but the C5 acceptance rows are not closed.
- The second-game paper check against the SDK contract, which belongs to F4.

Two defects were found and fixed during this session: the connectivity check
used the enclosing loop column instead of the visited cell (a connected grid
with blocked cells was rejected as disconnected), and the match insert passed
the policy version as JSONB. Both are covered by the committed tests.

No deployment is claimed. No §10 acceptance row is closed by this delivery.

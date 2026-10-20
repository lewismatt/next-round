# Crossword Game Module (`games/crossword`)

Status: **Sprint 5 / F3-A delivered** (module foundation in
[PR #33](https://github.com/lewismatt/next-round/pull/33); not merged)

## Overview

The Crossword game module is the first full, production game in Next Round.
It provides collaborative and solo crossword puzzle gameplay with real-time clue solving, turn coordination, exposure tracking, and score accounting.

## What this module contains

| File              | Purpose                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/manifest.ts` | Module contract: modes, capabilities, settings, action payloads, state, authorized view, result and the import/metadata/data/facts resource schemas.                      |
| `src/content.ts`  | The C1 content contract: document validation, grid and clue derivation, row-major clue numbering, the rights allowlist and the SHA-256 puzzle identity. Server-side only. |
| `src/server.ts`   | The C2-C4 rules as a pure reducer over the pinned resource snapshot: turns, counters, scoring, reveals, exposure, disabled members and career exclusions.                 |
| `src/types.ts`    | The shared state, settings and authorized-view types used by the server and the browser client.                                                                           |
| `src/client.ts`   | The browser client: grid, clue lists, explicit word submission, cell typing, private feedback and the game controls. It imports no server code.                           |

## Content and import

A puzzle is a `next-round.crossword/1` JSON document with a rectangular grid of
`#` and `A–Z` cells and exactly one clue per derived entry. An administrator
imports it through `POST /api/v1/admin/games/crossword/import`; the platform
stores the private content, the public catalog metadata and the importer's
exposure fact. The same grid keeps one identity, and changed clues or metadata
create a new immutable content version. A match pins one resource version.

```json
{
  "format": "next-round.crossword/1",
  "title": "Example Grid",
  "author": "Next Round",
  "language": "en",
  "difficulty": "easy",
  "rights": {
    "license": "CC0-1.0",
    "sourceUrl": null,
    "attribution": "Next Round",
    "permissionNote": null
  },
  "rows": ["ABCDE", "FGHIJ", "KLMNO", "PQ#RS"],
  "clues": [
    { "direction": "across", "row": 0, "col": 0, "text": "First across" },
    { "direction": "down", "row": 0, "col": 0, "text": "First down" }
  ]
}
```

The example above is incomplete on purpose: every derived entry needs a clue.

## Milestone status

Per **Master Specification v1.2 §9** and **§10 (Build Slices and Acceptance Gates)**:

1. **Dependency order**: F1 (platform/SDK) and F2 (harness and the minimal Test
   Counter) are integrated, so the crossword module is unblocked.
2. **Delivered in F3-A**: the module implementation (`./manifest`, `./server`,
   `./client`), the content/import contract and the platform resource and fact
   substrate, with unit and real-PostgreSQL integration evidence.
3. **Still open in F3**: the three original CC0-1.0 author-verified puzzle
   packages (a human deliverable under D54), the adversarial exposure fixtures
   and multi-match isolation tests, the setup and library UI, and the
   production Home/Games/History/Admin flows.

## Specification Reference

- **Module ID**: `crossword`
- **SDK Contract**: `next-round-game/0.1`
- **Modes**:
  - `solo` (min 1, max 1)
  - `quick` (min 2, max 8)
  - `custom` (min 2, max 8)
- **Capabilities**: `chat: true`, `deadlines: true`, `solo: true`, `resources: true`, `careerStats: true`.
- **Governing Specs**:
  - `docs/spec/master-spec.md` §2 (Wire contracts and game SDK)
  - `docs/spec/master-spec.md` §9 (Approved crossword module — first full game, after the harness)
  - `docs/spec/master-spec.md` §10 (Build slices and acceptance gates, F2 / F3)
- **Delivery evidence**: `docs/sprint5-evidence.md`

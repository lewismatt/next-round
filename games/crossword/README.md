# Crossword Game Module (`games/crossword`)

Status: **Planned for Slice F3** (Gated after F2 Harness exit)

## Overview

The Crossword game module is the first full, production game in Next Round.
It provides collaborative and solo crossword puzzle gameplay with real-time clue solving, turn coordination, exposure tracking, and score accounting.

## Milestone Gating

Per **Master Specification v1.2 §9** and **§10 (Build Slices and Acceptance Gates)**:

1. **Strict Dependency Order**: Crossword implementation is explicitly gated until after the **F2 Harness and Minimal Test Game** slice exits.
2. **F2 Prerequisites**:
   - Platform/SDK transaction foundation (Slice F1).
   - Test harness (`@next-round/game-harness`) providing simulated registered/guest clients, clock controls, and fault injection hooks.
   - Minimal SDK test game (`@next-round/game-test-counter` / `test-counter@0.1.0`) validating private views, multiplayer modes, deadlines, retries, and career projections.
   - H1–H6 integration verification.
3. **F3 Deliverables**:
   - Crossword module implementation: `./manifest`, `./server`, `./client`, `./setup`.
   - Content authoring & rights review: three original CC0-1.0 author-verified puzzle packages imported via versioned JSON.
   - Adversarial exposure fixtures & multi-match isolation tests.
   - Responsive UI, keyboard navigation, light/dark accessibility.

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

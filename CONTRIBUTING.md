# Contributing to Next Round

Next Round is an open-source, self-hosted turn-based games platform licensed under the [Apache License, Version 2.0](LICENSE). We welcome contributions that align with our architectural boundaries and implementation standards.

## Code of Conduct and Licensing

All contributions are submitted under the terms of the Apache-2.0 license. By submitting a pull request, you certify that you have the right to submit the work and agree to license it under Apache-2.0.

Start new project-owned TypeScript/JavaScript files (including tests, declarations
and configuration) with `// SPDX-License-Identifier: Apache-2.0`; use
`/* SPDX-License-Identifier: Apache-2.0 */` for CSS. Keep a script's shebang
first. Run `pnpm check:spdx` after staging new files; CI checks tracked sources.
The check covers TS/TSX/JS/JSX/MJS/CJS/CSS, excluding preserved third-party materials.

Copied third-party sources retain their original licenses and attribution.
The existing shadcn component, utility and preset stylesheet use MIT headers;
their license is preserved in `third_party/shadcn-LICENSE.txt`.
Do not add Apache headers to upstream code or puzzle content by default.

Copied sources are registered in the provenance manifest
[`third_party/provenance.json`](third_party/provenance.json), not in the
checker. Every other source must carry the Apache-2.0 header. To add a copied
component, change only these three things:

1. Add the source file with its upstream license header on the first line
   (`// SPDX-License-Identifier: MIT`, or the `/* ... */` form for CSS), then a
   short "Derived from ..." comment pointing at the preserved license.
2. Preserve the upstream license and copyright text under `third_party/` and
   mention it in `THIRD_PARTY_NOTICES.md`.
3. Append an entry to `entries` in the manifest with exactly these fields:
   `path` (repo-relative, POSIX), `license` (a single SPDX identifier matching
   the header), `source` (https URL of the upstream project) and `attribution`
   (repo-relative path of the preserved license file from step 2, which must be
   tracked).

`pnpm check:spdx` reads and validates the manifest. It fails on a malformed
manifest, a duplicate `path`, an entry whose attribution file is missing, an
entry for an untracked or uncovered file, and a non-Apache-2.0 header that has
no manifest entry. Do not edit `scripts/check-spdx.mjs` to register a source.

Use syntax-appropriate SPDX comments for other new project source formats.
Existing reviewed SQL migrations are immutable and checksum-verified: do not
rewrite them just to add a header. JSON, lockfiles and generated output are
outside the source-header check; their applicable license still follows
project ownership or the preserved upstream terms.

## Architectural Boundaries

1. **Platform owns infrastructure**:
   - Identity, sessions, permissions, account authority.
   - Match lifecycle transactions, revision conflict control, deadlines, and durable background jobs (pg-boss).
   - Invalidation fanout via native WebSockets; command submissions and authoritative state via HTTPS.
   - Chat, notification delivery, result retention, and career statistics projections.

2. **Game modules own gameplay**:
   - Game manifests conforming to SDK specification `next-round-game/0.1`.
   - Synchronous, pure reducer transitions (`transition(ctx, state, event)`).
   - Authorized participant views (`view(ctx, state, viewer)`).
   - Module authority checks, scoring, and career contribution calculations.
   - Game modules MUST NOT access the database, network, wall clock, or filesystem directly.

3. **Client separation**:
   - Browser UI uses the typed bridge (`GameBridge`).
   - Browser bundles MUST NEVER import or traverse server-only exports.
   - Game client assets are served from immutable, versioned paths.

## Development Standards

- **Runtime & Tools**: Node.js 24 LTS, pnpm 12.14+, TypeScript 7+.
- **Database**: PostgreSQL (tested against 18.6 and 17.x). Use Drizzle ORM for schema definitions and reviewed SQL migrations.
- **Dependencies**: Use exact package pins and committed lockfiles. Floating `latest` dependencies are prohibited in releases.
- **Lint and format**: `pnpm lint` checks JavaScript tooling (`.js`, `.mjs`,
  `.cjs`) with ESLint 9 flat configuration and zero warnings. TypeScript/TSX
  remains checked by `pnpm typecheck`; this is not a TypeScript lint gate.
  Generated output and preserved `third_party` materials are excluded.
  Prettier uses `.prettierrc.json`; format only files you change to avoid
  unrelated repository-wide churn.
- **Testing**:
  - Pure validators and reducers are verified with deterministic unit tests (`vitest`).
  - Transactional lifecycle paths, concurrency, and recovery are verified against real PostgreSQL instances, not mocks.
  - End-to-end user journeys are verified via Playwright.
  - **Bounded workers for full local runs (BL-024)**: the harness transport-gate
    tests (for example the subscription-gate and replay-timeout cases in
    `packages/game-harness/src/client.test.ts`) assert tight wall-clock bounds
    against an in-process scripted transport. At Vitest's default parallelism,
    running the unit suite at the same time as the PostgreSQL integration
    matrices can starve the event loop and trip those bounds spuriously. For a
    full local verification (unit suite plus database matrices), bound the
    workers and record the exact command in the verification notes:
    ```bash
    pnpm vitest run --maxWorkers=2
    ```
    Do not "fix" a gate failure by widening the timeouts or suppressing the
    test; re-run bounded first. CI keeps the default parallelism.

## Workflow

1. Check open work and claims in the planning tracker before starting significant features.
2. Create focused branches from `main`.
3. Ensure all tests, typechecks, and builds pass cleanly:
   ```bash
   ./scripts/fetch-cipher.sh   # fetches the external Cipher workspace package
   ./scripts/fetch-trivia.sh   # fetches the external Trivia workspace package
   pnpm install --frozen-lockfile
   pnpm lint
   pnpm typecheck
   pnpm build
   pnpm test
   ```
4. Submit pull requests with clear descriptions of changed behavior, affected requirements, and verification evidence.

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
their license is preserved in `third_party/shadcn-LICENSE.txt`. Review and
document provenance before extending the check's explicit upstream file list.
Do not add Apache headers to upstream code or puzzle content by default.

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
- **Testing**:
  - Pure validators and reducers are verified with deterministic unit tests (`vitest`).
  - Transactional lifecycle paths, concurrency, and recovery are verified against real PostgreSQL instances, not mocks.
  - End-to-end user journeys are verified via Playwright.

## Workflow

1. Check open work and claims in the planning tracker before starting significant features.
2. Create focused branches from `main`.
3. Ensure all tests, typechecks, and builds pass cleanly:
   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build
   pnpm test
   ```
4. Submit pull requests with clear descriptions of changed behavior, affected requirements, and verification evidence.

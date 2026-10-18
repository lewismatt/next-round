# Contributing to Next Round

Next Round is an open-source, self-hosted turn-based games platform licensed under the [Apache License, Version 2.0](LICENSE). We welcome contributions that align with our architectural boundaries and implementation standards.

## Code of Conduct and Licensing

All contributions are submitted under the terms of the Apache-2.0 license. By submitting a pull request, you certify that you have the right to submit the work and agree to license it under Apache-2.0.

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

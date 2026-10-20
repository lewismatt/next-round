<!-- SPDX-License-Identifier: Apache-2.0 -->

# F0 package feasibility evidence

This is a status record, not a claim that unrun checks passed. The selected package pins and focused F0 requirements are in [master spec §1 and §10](spec/master-spec.md#1-exact-selected-pins). Do not treat version declarations or scaffold presence as runtime compatibility evidence.

## Observed in the checkout

- `node_modules/.pnpm/lock.yaml` records selected app resolutions: `react` and `react-dom` 19.3.1; `react-router` 8.4.0 resolves with React/React DOM 19.3.1; `@tanstack/react-query` 5.104.4 and `lucide-react` 1.59.0 resolve with React 19.3.1; `radix-ui` 1.8.1 resolves with React 19.3.1 and React DOM 19.3.1. Vite 8.3.4 resolves with `@vitejs/plugin-react` 6.1.2 and `@tailwindcss/vite` 4.3.3. This is lockfile resolution evidence for the repository graph, not evidence that a fresh preset's manifest or peer graph matches.
- The integration case supplies active node-postgres transaction session via `SendOptions.db`, writes an application proof row on that same session, enqueues through `PgBoss.send(..., { db })`, and checks both persisted outcomes. It also contains an uncoupled control that deliberately leaves the job committed when the application row rolls back. The orchestrator reports all 12 tests in this integration file passed on PostgreSQL 18 and 17 using `database-only`; the commit/rollback adapter assertions and uncoupled control therefore executed against both majors.
- `packages/db/src/migrations.integration.test.ts` already covers migration installation/idempotence and a retried pg-boss job. That retry case alone is not transaction-adapter evidence.
- The pinned generator produced `radix-nova`, neutral base color, Remix Icon, inverted-translucent menus, subtle menu accent, Instrument Sans and Geist Mono fonts, and radius 0. Existing Button/theme source is retained. `packages/ui/components.json` now records neutral rather than zinc to match the generated metadata; the existing CSS values already match the generated palette.
- Generated React and React DOM `^19.3.0`, Radix `^1.8.1`, and Vite `^8` ranges include the repository's exact pins. Keep the approved Lucide React 1.59.0 instead of adding the template's unused Remix Icon dependency. Fonts and menu settings match the repository. The generator output does not replace reviewed source or the frozen lockfile.

## Reproducible focused probe

The runner supports independent passes so PostgreSQL 17/18 can be exercised without repeating the network CLI generation. From the repository root:

```sh
TEST_DATABASE_URL=postgresql://... node scripts/f0-acceptance.mjs database-only
node scripts/f0-acceptance.mjs preset-only
```

Use `node scripts/f0-acceptance.mjs` with `TEST_DATABASE_URL` set to run both. Database mode requires an administrative connection permitting `CREATE DATABASE`; invoke it separately for PostgreSQL 18 and 17 and record exact server/image versions. Preset mode runs `pnpm dlx shadcn@4.22.0 init --preset b7kBs9lVB5 --base radix --template vite --monorepo --name next-round-f0-probe --yes` in a disposable temporary directory. The shadcn [CLI init documentation](https://ui.shadcn.com/docs/cli#init) documents `--name` project creation and `--yes` prompt suppression. The runner prints generated config, relevant package dependencies/peer declarations/engines, and theme/font CSS evidence, then removes the directory. It never changes existing UI source or manually decodes the preset. Compare generated ranges and peer declarations with the approved repository pins and lockfile resolutions; do not treat a template's package manifest as a replacement for those approved direct pins.

## Observed results and remaining evidence

- `node scripts/f0-acceptance.mjs database-only` passed all 12 integration tests on PostgreSQL `18.6` and `17.11`. The cases include committed application-row/job pairs, rolled-back pairs, and an uncoupled negative control. Server versions were read with `SHOW server_version`.
- `node scripts/f0-acceptance.mjs preset-only` completed in 58.65 seconds. The disposable generated project was not separately built. `pnpm build` passed for the actual repository and scanned 12 browser artifacts without a server fixture secret.
- The acceptance image `next-round-s3-runtime:acceptance` built from the integrated platform before the new shared services. Native Argon2id accepted the correct password and rejected the wrong password inside that image.
- Caddy `2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` completed a WebSocket upgrade and frame exchange through the repository Caddyfile. The host-network container used `CADDY_DOMAIN=http://localhost:58081` and `api:127.0.0.1`; verification command: `node scripts/ci/caddy-ws-client.mjs ws://localhost:58081/api/__ci/ws`. A bridge-network attempt first returned 502 with a host TCP timeout. Host networking avoided that environment restriction without changing product code.

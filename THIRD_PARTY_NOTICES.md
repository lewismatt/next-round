# Third-Party Notices and License Inventory

Next Round incorporates open-source software under various permissive licenses. Below is the inventory of direct baseline dependencies and container images as approved in Master Specification v1.2 (§1).

## Container Images

| Image | Tag | Digest (multi-arch index) | Upstream License | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `postgres` | `18.6-alpine` | `sha256:d8703cd7fba306b9fec9268ecedfa8a966846c053036a60e3635791957eb2f66` | PostgreSQL License | Primary persistence database engine |
| `caddy` | `2.11.7-alpine` | `sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229` | Apache-2.0 | TLS reverse proxy and native WebSocket termination |

## Direct Software Dependencies

### Runtime, HTTP & WebSockets
- `fastify` (v5.12.7) — MIT License
- `@fastify/websocket` (v11.3.4) — MIT License
- `@fastify/cookie` (v11.1.3) — MIT License
- `@fastify/rate-limit` (v11.2.1) — MIT License
- `@fastify/helmet` (v13.2.0) — MIT License
- `@fastify/static` (v10.1.6) — MIT License
- `@fastify/swagger` (v9.9.2) — MIT License
- `pino` (v9.6.0) — MIT License

### Contracts, Validation & Types
- `@sinclair/typebox` (v0.34.52) — MIT License
- `semver` (v7.8.5) — ISC License
- `typescript` (v7.0.2) — Apache-2.0 License

### Persistence & Durable Jobs
- `pg` (v8.23.1) — MIT License
- `drizzle-orm` (v0.45.4) — Apache-2.0 License
- `drizzle-kit` (v0.31.11) — Apache-2.0 License
- `pg-boss` (v12.38.0) — MIT License

### Cryptography, Identity & QR
- `argon2` (v0.45.1) — MIT License
- `qrcode` (v1.5.4) — MIT License

### Frontend Shell & UI Components
- `react` (v19.3.1) — MIT License
- `react-dom` (v19.3.1) — MIT License
- `vite` (v8.3.4) — MIT License
- `@vitejs/plugin-react` (v6.1.2) — MIT License
- `react-router` (v8.4.0) — MIT License
- `@tanstack/react-query` (v5.104.4) — MIT License
- `tailwindcss` (v4.3.3) — MIT License
- `@tailwindcss/vite` (v4.3.3) — MIT License
- `radix-ui` (v1.8.1) — MIT License
- `lucide-react` (v1.59.0) — ISC License
- `class-variance-authority` (v0.7.1) — Apache-2.0 License
- `clsx` (v2.1.1) — MIT License
- `tailwind-merge` (v3.7.0) — MIT License
- `@fontsource-variable/geist-mono` (v5.3.0) — OFL-1.1
- `@fontsource-variable/instrument-sans` (v5.3.0) — OFL-1.1

### Testing & Development Tooling
- `vitest` (v5.0.5) — MIT License
- `@playwright/test` (v1.64.1) — Apache-2.0 License
- `tsx` (v4.23.15) — MIT License

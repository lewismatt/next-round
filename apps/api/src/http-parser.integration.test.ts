// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";

// BL-047: BL-019's no-echo parser guarantee was previously evidenced with
// Fastify inject only. These tests drive the compiled server over a real
// listening socket: malformed and oversized bodies must still produce the
// structured error envelope and must never echo submitted input.
describe.skipIf(!testDatabaseUrl)("BL-047 body-parser errors over a real socket", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRoot: string;
  let baseUrl: string;

  beforeEach(async () => {
    databaseName = `next_round_parser_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    const databaseUrl = url.toString();
    await migrateDatabase({ connectionString: databaseUrl });
    databasePool = createDatabasePool({ connectionString: databaseUrl, max: 8 });
    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-parser-"));
    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot,
      databasePool,
      setupToken: randomBytes(32).toString("hex"),
      origin,
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    const disconnected: Array<Promise<void>> = [];
    databasePool?.on("remove", (client) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      client.once("end", resolve);
      disconnected.push(promise);
    });
    await databasePool?.end();
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    await rm(staticRoot, { recursive: true, force: true });
  }, 60_000);

  it("serves ordinary requests over the socket", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/live`);
    expect(response.status).toBe(200);
  }, 60_000);

  it("rejects malformed JSON with the structured envelope and no input echo", async () => {
    const marker = "parser-marker-secret-047";
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: `{"username":"${marker}","password":`,
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(marker);
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("INVALID_REQUEST");
  }, 60_000);

  it("rejects oversized bodies with the structured envelope and no input echo", async () => {
    const marker = "parser-marker-oversized-047";
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: `{"username":"${marker.repeat(60_000)}","password":"x"}`,
    });
    expect(response.status).toBe(413);
    const text = await response.text();
    expect(text).not.toContain(marker);
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("INVALID_REQUEST");
  }, 60_000);
});

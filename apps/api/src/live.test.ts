// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_CODES, LIVE_SUBPROTOCOL } from "@next-round/contracts";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

describe("Live Endpoint Pre-Upgrade Boundaries & Offline Options", () => {
  let app: FastifyInstance;
  let staticRoot: string;

  beforeEach(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-live-unit-"));
    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot,
      origin: "http://localhost:3000",
      enableLiveListener: false,
      checkDb: async () => true,
      checkRegistry: async () => true,
    });
  });

  afterEach(async () => {
    if (app) await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  });

  it("rejects request with wrong Origin with 403 FORBIDDEN", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/live",
      headers: {
        origin: "http://attacker.com",
        "sec-websocket-protocol": LIVE_SUBPROTOCOL,
      },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it("rejects request containing query parameters with 400 INVALID_REQUEST", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/live?token=secret-token",
      headers: {
        origin: "http://localhost:3000",
        "sec-websocket-protocol": LIVE_SUBPROTOCOL,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });

  it("rejects request with missing or incorrect subprotocol with 400 INVALID_REQUEST", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/live",
      headers: {
        origin: "http://localhost:3000",
        "sec-websocket-protocol": "unsupported.proto",
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });

  it("rejects request without session cookie with 401 AUTH_REQUIRED", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/live",
      headers: {
        origin: "http://localhost:3000",
        "sec-websocket-protocol": LIVE_SUBPROTOCOL,
      },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe(ERROR_CODES.AUTH_REQUIRED);
  });

});

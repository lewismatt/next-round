// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ERROR_CODES,
  SDK_IDENTIFIER,
  type GameManifest,
} from "@next-round/contracts";
import { GameRegistry } from "@next-round/platform";
import type { FastifyInstance } from "fastify";
import { parseGameAction, parseGameSettings } from "./game-input.js";
import { buildServer } from "./server.js";

let clientRoot: string;
const servers: FastifyInstance[] = [];

beforeEach(() => {
  clientRoot = mkdtempSync(path.join(tmpdir(), "next-round-games-api-"));
  writeFileSync(path.join(clientRoot, "client.js"), "export const clientFixture = true;\n");
  vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
  vi.stubEnv("SETUP_TOKEN", randomBytes(32).toString("hex"));
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("TRUST_PROXY", "");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  rmSync(clientRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function manifest(): GameManifest {
  return {
    id: "test-counter",
    name: "Test Counter",
    version: "0.1.0",
    sdk: SDK_IDENTIFIER,
    platformRange: ">=0.1.0 <1.0.0",
    stateVersion: 1,
    resultVersion: 1,
    description: "Manifest API fixture",
    modes: [
      { id: "solo", label: "Solo", minPlayersToStart: 1, maxPlayers: 1, lateJoin: false, rejoin: true },
      { id: "group", label: "Group", minPlayersToStart: 2, maxPlayers: 8, lateJoin: true, rejoin: true },
    ],
    capabilities: { chat: true, deadlines: true, solo: true, resources: false, careerStats: true },
    settingsSchema: {
      type: "object",
      properties: { target: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["target"],
      additionalProperties: false,
    },
    actionSchemas: {
      add: {
        type: "object",
        properties: { amount: { type: "integer", const: 1 } },
        required: ["amount"],
        additionalProperties: false,
      },
    },
    stateSchema: {},
    viewSchema: {},
    resultSchema: {},
    client: { entry: "./client.js", css: [] },
  };
}

function registry(): GameRegistry {
  const registry = new GameRegistry();
  registry.register(manifest(), undefined, { clientRoot });
  return registry;
}

function apiError(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected API validation to reject the input.");
}

describe("game manifest HTTP boundary", () => {
  it("serves the loaded manifest modes and the declared immutable client asset", async () => {
    const app = await buildServer({ logger: false, staticRoot: clientRoot, gameRegistry: registry() });
    servers.push(app);

    const list = await app.inject("/api/v1/games");
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].modes).toEqual([
      expect.objectContaining({ id: "solo", minPlayersToStart: 1, maxPlayers: 1 }),
      expect.objectContaining({ id: "group", minPlayersToStart: 2, maxPlayers: 8 }),
    ]);

    const detail = await app.inject("/api/v1/games/test-counter?version=0.1.0");
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({ id: "test-counter", version: "0.1.0" });

    const asset = await app.inject("/games/test-counter/0.1.0/client.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toBe("export const clientFixture = true;\n");
  });

  it("does not serve an undeclared client asset", async () => {
    writeFileSync(path.join(clientRoot, "server.js"), "export const secret = true;\n");
    const app = await buildServer({ logger: false, staticRoot: clientRoot, gameRegistry: registry() });
    servers.push(app);
    const response = await app.inject("/games/test-counter/0.1.0/server.js");
    expect(response.statusCode).toBe(404);
  });
});

describe("game input API boundary", () => {
  it("rejects unknown settings fields", () => {
    const error = apiError(() => parseGameSettings(
      registry(),
      "test-counter",
      "0.1.0",
      { target: 10, unknown: true },
    ));
    expect(error).toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    expect(error.details?.fields).toContain("/unknown");
  });

  it("rejects unknown action fields and action types", () => {
    const loaded = registry();
    const fieldError = apiError(() => parseGameAction(
      loaded,
      "test-counter",
      "0.1.0",
      "add",
      { amount: 1, unknown: true },
    ));
    expect(fieldError).toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    expect(fieldError.details?.fields).toContain("/unknown");

    const typeError = apiError(() => parseGameAction(
      loaded,
      "test-counter",
      "0.1.0",
      "unknown",
      { amount: 1 },
    ));
    expect(typeError).toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    expect(typeError.details?.fields).toEqual(["/type"]);
  });
});

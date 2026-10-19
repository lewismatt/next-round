// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from "node:fs";
import path from "node:path";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { AuthService, GameRegistry } from "@next-round/platform";
import type { FastifyPluginAsync } from "fastify";
import { parseGameAction, parseGameSettings } from "../game-input.js";
import { requireJsonMutation, requireSession } from "./auth.js";

export interface GameRoutesOptions {
  registry: GameRegistry;
}

interface GameManifestRoutesOptions extends GameRoutesOptions {
  authService: AuthService;
  origin: string;
}


export const gameManifestRoutes: FastifyPluginAsync<GameManifestRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.get("/games", async (request, reply) => {
    const session = await requireSession(request, options.authService, false);
    await options.authService.authorizeGame(session);
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: options.registry.list(),
      nextCursor: null,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.get("/games/:gameId", async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const { version } = request.query as { version?: string };
    const session = await requireSession(request, options.authService, false);
    await options.authService.authorizeGame(session, gameId, version);
    const registered = options.registry.getVersion(gameId, version);
    if (!registered) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, "Game module was not found.");
    }
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: registered.manifest,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post("/games/:gameId/settings", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    await options.authService.authorizeGame(session);
    const { gameId } = request.params as { gameId: string };
    const body = request.body as { version?: string; settings: unknown };
    const settings = parseGameSettings(
      options.registry,
      gameId,
      body.version,
      body.settings,
    );
    return reply.status(200).send({
      data: settings,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post("/games/:gameId/actions", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    await options.authService.authorizeGame(session);
    const { gameId } = request.params as { gameId: string };
    const body = request.body as {
      version?: string;
      type: string;
      payload: unknown;
    };
    const payload = parseGameAction(
      options.registry,
      gameId,
      body.version,
      body.type,
      body.payload,
    );
    return reply.status(200).send({
      data: payload,
      serverNow: new Date().toISOString(),
    });
  });
};

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

export const gameAssetRoutes: FastifyPluginAsync<GameRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.get("/games/:gameId/:version/*", async (request, reply) => {
    const params = request.params as {
      gameId: string;
      version: string;
      "*": string;
    };
    const asset = options.registry.getClientAsset(
      params.gameId,
      params.version,
      params["*"],
    );
    if (!asset) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, "Game client asset was not found.");
    }

    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .type(CONTENT_TYPE_BY_EXTENSION[path.extname(asset).toLowerCase()] ?? "application/octet-stream")
      .send(createReadStream(asset));
  });
};

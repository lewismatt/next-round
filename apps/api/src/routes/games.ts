// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  AdminGameParamsSchema,
  AdminGamePatchRequestSchema,
  ApiError,
  ERROR_CODES,
  type GameManifest,
  parseRequestBody,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import {
  getAdminGames,
  patchAdminGame,
  type AuthService,
  type GameRegistry,
} from "@next-round/platform";
import type { FastifyPluginAsync } from "fastify";
import { parseGameAction, parseGameSettings } from "../game-input.js";
import { requireJsonMutation, requireSession } from "./auth.js";

export interface GameRoutesOptions {
  registry: GameRegistry;
}

interface GameManifestRoutesOptions extends GameRoutesOptions {
  authService: AuthService;
  origin: string;
  databasePool: DatabasePool;
}

export interface AdminGameRoutesOptions {
  authService: AuthService;
  databasePool: DatabasePool;
  registry: GameRegistry;
  origin: string;
}


export const gameManifestRoutes: FastifyPluginAsync<GameManifestRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.get("/games", async (request, reply) => {
    const session = await requireSession(request, options.authService, false);
    await options.authService.authorizeGame(session);
    const list: GameManifest[] = [];
    const enabledModules = await options.databasePool.query<{ id: string; default_version: string }>(
      "SELECT id, default_version FROM next_round.modules WHERE enabled = true ORDER BY id ASC",
    );
    for (const row of enabledModules.rows) {
      const registered = options.registry.getVersion(row.id, row.default_version);
      if (!registered) {
        throw new ApiError(
          ERROR_CODES.MODULE_UNAVAILABLE,
          `Game module '${row.id}' default version '${row.default_version}' is unavailable.`,
        );
      }
      list.push(registered.manifest);
    }
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: list,
      nextCursor: null,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.get("/games/:gameId", async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const { version } = request.query as { version?: string };
    const session = await requireSession(request, options.authService, false);

    if (version !== undefined) {
      await options.authService.authorizeGame(session, gameId, version);
      const registered = options.registry.getVersion(gameId, version);
      if (!registered) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, "Game module was not found.");
      }
      return reply.status(200).header("Cache-Control", "no-store").send({
        data: registered.manifest,
        serverNow: new Date().toISOString(),
      });
    }
    await options.authService.authorizeGame(session);

    const moduleResult = await options.databasePool.query<{ enabled: boolean; default_version: string }>(
      "SELECT enabled, default_version FROM next_round.modules WHERE id = $1",
      [gameId],
    );
    const moduleRow = moduleResult.rows[0];
    if (!moduleRow || !moduleRow.enabled) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, "Game module was not found.");
    }
    const effectiveVersion = moduleRow.default_version;
    await options.authService.authorizeGame(session, gameId, effectiveVersion);
    const registered = options.registry.getVersion(gameId, effectiveVersion);
    if (!registered) {
      throw new ApiError(
        ERROR_CODES.MODULE_UNAVAILABLE,
        `Game module '${gameId}' default version '${effectiveVersion}' is unavailable.`,
      );
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

export const adminGameRoutes: FastifyPluginAsync<AdminGameRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.get("/admin/games", async (request, reply) => {
    const session = await requireSession(request, options.authService, false);
    if (!session.permissions.isAdmin) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Administrator access is required.");
    }
    const data = await getAdminGames(options.databasePool, options.registry, session);
    return reply.status(200).header("Cache-Control", "no-store").send({
      data,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.patch("/admin/games/:id", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const params = parseRequestBody(AdminGameParamsSchema, request.params);
    const input = parseRequestBody(AdminGamePatchRequestSchema, request.body);
    const session = await requireSession(request, options.authService, true);
    if (!session.permissions.isAdmin) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Administrator access is required.");
    }
    const data = await patchAdminGame(
      options.databasePool,
      options.registry,
      session,
      params.id,
      input,
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data,
      serverNow: new Date().toISOString(),
    });
  });
};

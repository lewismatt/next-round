// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  ERROR_CODES,
  PolicyV1Schema,
  parseRequestBody,
} from "@next-round/contracts";
import type { PolicyV1 } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import {
  SharedService,
  type AuthService,
  type AuthenticatedSession,
  type MatchService,
  type GameRegistry,
} from "@next-round/platform";
import type { FastifyPluginAsync } from "fastify";
import { requireJsonMutation, requireSession } from "./auth.js";

export interface SharedRoutesOptions {
  databasePool: DatabasePool;
  authService: AuthService;
  matchService: MatchService;
  registry: GameRegistry;
  origin: string;
  sharedService?: SharedService;
}

function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request is invalid.");
  return value;
}
function query(request: {
  query: unknown;
}): Record<string, string | undefined> {
  if (!request.query || typeof request.query !== "object") return {};
  const result = request.query as Record<string, unknown>;
  return {
    cursor: typeof result.cursor === "string" ? result.cursor : undefined,
    limit: typeof result.limit === "string" ? result.limit : undefined,
    unreadOnly:
      typeof result.unreadOnly === "string" ? result.unreadOnly : undefined,
  };
}
function session(
  request: Parameters<typeof requireSession>[0],
  options: SharedRoutesOptions,
  write = false,
): Promise<AuthenticatedSession> {
  return requireSession(request, options.authService, write);
}

export const sharedRoutes: FastifyPluginAsync<SharedRoutesOptions> = async (
  fastify,
  options,
) => {
  const service =
    options.sharedService ??
    new SharedService(options.databasePool, options.registry);
  fastify.get("/matches/:id/chat", async (request, reply) => {
    const params = request.params as { id: string };
    const q = query(request);
    const data = await service.listChat(
      await session(request, options),
      uuid(params.id),
      q.cursor,
      q.limit,
    );
    return reply.header("Cache-Control", "no-store").send(data);
  });
  fastify.post("/matches/:id/chat", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const params = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((key) => key !== "commandId" && key !== "text") ||
      typeof body.text !== "string"
    )
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request is invalid.");
    const commandId = uuid(body.commandId);
    const data = await service.sendChat(
      await session(request, options, true),
      uuid(params.id),
      { commandId, text: body.text },
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ data, serverNow: new Date().toISOString() });
  });
  fastify.get("/notifications", async (request, reply) => {
    const q = query(request);
    if (
      q.unreadOnly !== undefined &&
      q.unreadOnly !== "true" &&
      q.unreadOnly !== "false"
    )
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request is invalid.");
    return reply
      .header("Cache-Control", "no-store")
      .send(
        await service.notifications(
          await session(request, options),
          q.unreadOnly === "true",
          q.cursor,
          q.limit,
        ),
      );
  });
  fastify.post("/notifications/read", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const body = request.body as Record<string, unknown>;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(body.ids)
    )
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request is invalid.");
    const ids = body.ids.map(uuid);
    await service.markNotificationsRead(
      await session(request, options, true),
      ids,
    );
    return reply.status(204).send();
  });
  fastify.get("/games/:gameId/leaderboard", async (request, reply) => {
    const params = request.params as { gameId: string };
    const q = query(request);
    return reply
      .header("Cache-Control", "no-store")
      .send(
        await service.leaderboard(
          await session(request, options),
          params.gameId,
          q.cursor,
          q.limit,
        ),
      );
  });
  fastify.get("/admin/policy", async (request, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send({
        data: await service.policy(await session(request, options)),
        serverNow: new Date().toISOString(),
      });
  });
  fastify.put("/admin/policy", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const body = request.body as Record<string, unknown>;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some(
        (key) => key !== "expectedVersion" && key !== "policy",
      ) ||
      !Number.isSafeInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 1
    )
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request is invalid.");
    const policy = parseRequestBody(PolicyV1Schema, body.policy) as PolicyV1;
    const data = await service.updatePolicy(
      await session(request, options, true),
      Number(body.expectedVersion),
      policy,
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ data, serverNow: new Date().toISOString() });
  });
};

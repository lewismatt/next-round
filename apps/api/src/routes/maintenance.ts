// SPDX-License-Identifier: Apache-2.0
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import {
  executeAdminRetention,
  migrateAdminMatch,
  previewAdminRetention,
  type AuthService,
  type GameRegistry,
  type MatchService,
} from "@next-round/platform";
import type { FastifyPluginAsync } from "fastify";
import { requireJsonMutation, requireSession } from "./auth.js";

export interface MaintenanceRoutesOptions {
  databasePool: DatabasePool;
  authService: AuthService;
  matchService: MatchService;
  registry: GameRegistry;
  origin: string;
}

function serverNow(): string {
  return new Date().toISOString();
}

export const maintenanceRoutes: FastifyPluginAsync<
  MaintenanceRoutesOptions
> = async (fastify, options) => {
  fastify.post("/admin/matches/:id/migrate", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const params = request.params as { id?: unknown };
    const body = request.body as {
      commandId?: unknown;
      targetVersion?: unknown;
      expectedRevision?: unknown;
    };
    if (
      typeof params.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        params.id,
      ) ||
      typeof body?.commandId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.commandId,
      ) ||
      typeof body?.targetVersion !== "string" ||
      !body.targetVersion ||
      body.targetVersion.length > 128 ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        "The maintenance request is invalid.",
      );
    }
    const data = await migrateAdminMatch(
      options.databasePool,
      options.registry,
      session,
      params.id.toLowerCase(),
      body.targetVersion,
      body.expectedRevision as number,
      body.commandId,
    );
    return reply
      .status(200)
      .header("Cache-Control", "no-store")
      .send({ data, serverNow: serverNow() });
  });

  fastify.post("/admin/retention-plans", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const body = request.body as {
      scope?: unknown;
      policyVersion?: unknown;
      cutoff?: unknown;
    };
    const allowed = ["chat", "privateState", "results", "notifications"];
    if (
      !Array.isArray(body?.scope) ||
      !body.scope.length ||
      body.scope.some(
        (scope) => typeof scope !== "string" || !allowed.includes(scope),
      ) ||
      new Set(body.scope).size !== body.scope.length ||
      !Number.isSafeInteger(body.policyVersion) ||
      (body.policyVersion as number) < 1 ||
      typeof body.cutoff !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        body.cutoff,
      ) ||
      !Number.isFinite(Date.parse(body.cutoff))
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        "The maintenance request is invalid.",
      );
    }
    const data = await previewAdminRetention(
      options.databasePool,
      session,
      body.scope as Array<
        "chat" | "privateState" | "results" | "notifications"
      >,
      body.policyVersion as number,
      body.cutoff,
    );
    return reply
      .status(201)
      .header("Cache-Control", "no-store")
      .send({ data, serverNow: serverNow() });
  });

  fastify.post("/admin/retention-plans/:id/execute", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const params = request.params as { id?: unknown };
    const body = request.body as { confirmationId?: unknown };
    if (
      typeof params.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(params.id) ||
      typeof body?.confirmationId !== "string" ||
      body.confirmationId.length < 1 ||
      body.confirmationId.length > 256
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        "The maintenance request is invalid.",
      );
    }
    const data = await executeAdminRetention(
      options.databasePool,
      session,
      params.id,
      body.confirmationId,
    );
    return reply
      .status(200)
      .header("Cache-Control", "no-store")
      .send({ data, serverNow: serverNow() });
  });
};

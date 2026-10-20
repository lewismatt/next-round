// SPDX-License-Identifier: Apache-2.0
import {
  CreateMatchRequestSchema,
  MatchLifecycleCommandSchema,
  MatchActionRequestSchema,
  MatchParamsSchema,
  parseRequestBody,
  type MatchLifecycleCommand,
} from "@next-round/contracts";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import { UuidSchema } from "@next-round/contracts/auth";
import type { Json } from "@next-round/contracts";
import type { AuthService, MatchService } from "@next-round/platform";
import type { FastifyPluginAsync } from "fastify";
import { requireJsonMutation, requireSession } from "./auth.js";

export interface MatchRoutesOptions {
  authService: AuthService;
  matchService: MatchService;
  origin: string;
}

function matchIdFrom(input: unknown): string {
  return parseRequestBody(MatchParamsSchema, input).id;
}

function removalParams(input: unknown): { matchId: string; memberId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(
      ERROR_CODES.INVALID_REQUEST,
      "Match member parameters are invalid.",
    );
  }
  const params = input as Record<string, unknown>;
  return {
    matchId: parseRequestBody(MatchParamsSchema, { id: params.id }).id,
    memberId: parseRequestBody(UuidSchema, params.memberId),
  };
}
function joinRequest(value: unknown): {
  command: MatchLifecycleCommand;
  linkToken?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  if (
    Object.keys(value).some(
      (key) => !["commandId", "expectedRevision", "linkToken"].includes(key),
    )
  ) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  const command = parseRequestBody(MatchLifecycleCommandSchema, {
    commandId: "commandId" in value ? value.commandId : undefined,
    expectedRevision:
      "expectedRevision" in value ? value.expectedRevision : undefined,
  });
  const linkToken = "linkToken" in value ? value.linkToken : undefined;
  if (
    linkToken !== undefined &&
    (typeof linkToken !== "string" ||
      linkToken.length < 32 ||
      linkToken.length > 128)
  ) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  return {
    command,
    ...(typeof linkToken === "string" ? { linkToken } : {}),
  };
}

export const matchRoutes: FastifyPluginAsync<MatchRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.post("/matches", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const input = parseRequestBody(CreateMatchRequestSchema, request.body);
    const created = await options.matchService.create(session, input);
    return reply.status(201).header("Cache-Control", "no-store").send({
      data: created,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.get("/matches/:id", async (request, reply) => {
    const session = await requireSession(request, options.authService, false);
    const snapshot = await options.matchService.getSnapshot(
      matchIdFrom(request.params),
      session.principal.id,
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: snapshot,
      serverNow: snapshot.serverNow,
    });
  });

  fastify.post("/matches/:id/join", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const { command, linkToken } = joinRequest(request.body);
    const receipt = await options.matchService.join(
      matchIdFrom(request.params),
      session,
      command,
      linkToken,
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: receipt,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post("/matches/:id/start", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const input = parseRequestBody(MatchLifecycleCommandSchema, request.body);
    const receipt = await options.matchService.start(
      matchIdFrom(request.params),
      session,
      input,
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: receipt,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post("/matches/:id/finish", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const input = parseRequestBody(MatchLifecycleCommandSchema, request.body);
    const receipt = await options.matchService.finish(
      matchIdFrom(request.params),
      session,
      input,
    );
    return reply.header("Cache-Control", "no-store").send({
      data: receipt,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post("/matches/:id/leave", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const input = parseRequestBody(MatchLifecycleCommandSchema, request.body);
    const receipt = await options.matchService.leave(
      matchIdFrom(request.params),
      session,
      input,
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: receipt,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post(
    "/matches/:id/members/:memberId/remove",
    async (request, reply) => {
      requireJsonMutation(request, options.origin);
      const session = await requireSession(request, options.authService, true);
      const params = removalParams(request.params);
      const input = parseRequestBody(MatchLifecycleCommandSchema, request.body);
      const receipt = await options.matchService.removeMember(
        params.matchId,
        params.memberId,
        session,
        input,
      );
      return reply.status(200).header("Cache-Control", "no-store").send({
        data: receipt,
        serverNow: new Date().toISOString(),
      });
    },
  );

  fastify.get("/matches/:id/result", async (request, reply) => {
    const session = await requireSession(request, options.authService, false);
    const result = await options.matchService.getResult(
      matchIdFrom(request.params),
      session.principal.id,
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: result,
      serverNow: new Date().toISOString(),
    });
  });

  fastify.post("/matches/:id/actions", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const session = await requireSession(request, options.authService, true);
    const validatedAction = parseRequestBody(
      MatchActionRequestSchema,
      request.body,
    );
    // JsonSchema validated this unknown value before the type assertion.
    const payload = validatedAction.payload as Json;
    const receipt = await options.matchService.act(
      matchIdFrom(request.params),
      session,
      {
        commandId: validatedAction.commandId,
        expectedRevision: validatedAction.expectedRevision,
        type: validatedAction.type,
        payload,
      },
    );
    return reply.status(200).header("Cache-Control", "no-store").send({
      data: receipt,
      serverNow: new Date().toISOString(),
    });
  });
};

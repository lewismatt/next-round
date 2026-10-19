// SPDX-License-Identifier: Apache-2.0
import {
  MatchActionRequestSchema,
  MatchParamsSchema,
  parseRequestBody,
} from "@next-round/contracts";
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

export const matchRoutes: FastifyPluginAsync<MatchRoutesOptions> = async (
  fastify,
  options,
) => {
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
    const validatedAction = parseRequestBody(MatchActionRequestSchema, request.body);
    // JsonSchema validated this unknown value before the type assertion.
    const payload = validatedAction.payload as Json;
    const receipt = await options.matchService.act(
      matchIdFrom(request.params),
      session.principal.id,
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

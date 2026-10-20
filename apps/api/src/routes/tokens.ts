// SPDX-License-Identifier: Apache-2.0
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import {
  AdminUserParamsSchema,
  CommandIdRequestSchema,
  parseRequestBody,
  UuidSchema,
} from "@next-round/contracts/auth";
import type { AuthService, TokenService } from "@next-round/platform";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireJsonMutation, requireSession } from "./auth.js";

export interface TokenRoutesOptions {
  tokenService: TokenService;
  authService: AuthService;
  origin: string;
}

function parseRegistrationInvite(body: unknown): {
  commandId: string;
  matchId?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => key !== "commandId" && key !== "matchId",
    ) ||
    typeof value.commandId !== "string" ||
    (value.matchId !== undefined && typeof value.matchId !== "string")
  ) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  const { commandId, matchId } = value as {
    commandId: string;
    matchId?: string;
  };
  parseRequestBody(CommandIdRequestSchema, { commandId });
  if (matchId !== undefined) parseRequestBody(UuidSchema, matchId);
  return { commandId, ...(matchId ? { matchId } : {}) };
}

function tokenUrl(origin: string, path: string, token: string): string {
  const url = new URL(path, origin);
  url.hash = token;
  return url.toString();
}

export const tokenRoutes: FastifyPluginAsync<TokenRoutesOptions> = async (
  fastify,
  options,
) => {
  const { tokenService, authService, origin } = options;
  fastify.post("/invitations/registration", async (request, reply) => {
    requireJsonMutation(request, origin);
    const input = parseRegistrationInvite(request.body);
    const session = await requireSession(request, authService, true);
    const issued = await tokenService.issueRegistration(
      session,
      input.commandId,
      input.matchId,
    );
    return reply
      .status(201)
      .header("Cache-Control", "no-store")
      .send({
        data: {
          id: issued.id,
          url: tokenUrl(origin, "/register", issued.token),
          expiresAt: issued.expiresAt,
        },
        serverNow: new Date().toISOString(),
      });
  });
  const issue =
    (kind: "signin" | "reset") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireJsonMutation(request, origin);
      const params = parseRequestBody(AdminUserParamsSchema, request.params);
      const input = parseRequestBody(CommandIdRequestSchema, request.body);
      const session = await requireSession(request, authService, true);
      const issued = await tokenService.issueAccountToken(
        session,
        params.id,
        kind,
        input.commandId,
      );
      const path = kind === "signin" ? "/sign-in" : "/reset-password";
      return reply
        .status(201)
        .header("Cache-Control", "no-store")
        .send({
          data: {
            url: tokenUrl(origin, path, issued.token),
            expiresAt: issued.expiresAt,
          },
          serverNow: new Date().toISOString(),
        });
    };
  fastify.post("/admin/users/:id/sign-in-qr", issue("signin"));
  fastify.post("/admin/users/:id/reset", issue("reset"));
};

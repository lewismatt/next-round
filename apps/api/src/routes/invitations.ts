// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  ERROR_CODES,
  parseRequestBody,
  MatchLifecycleCommandSchema,
  MatchParamsSchema,
} from "@next-round/contracts";
import { UuidSchema } from "@next-round/contracts/auth";
import type { DatabasePool } from "@next-round/db";
import { TokenService } from "@next-round/platform";
import type {
  AuthService,
  AuthenticatedSession,
  MatchService,
  GameRegistry,
} from "@next-round/platform";
import {
  SESSION_COOKIE_NAME,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type { FastifyPluginAsync } from "fastify";
import { requireJsonMutation, requireSession, setAuthCookies } from "./auth.js";
function parseObject(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  return object;
}

function parseTargeted(value: unknown): {
  commandId: string;
  recipientPrincipalId: string;
} {
  const object = parseObject(value, ["commandId", "recipientPrincipalId"]);
  return {
    commandId: parseRequestBody(UuidSchema, object.commandId),
    recipientPrincipalId: parseRequestBody(
      UuidSchema,
      object.recipientPrincipalId,
    ),
  };
}

function parseGuest(value: unknown): {
  token: string;
  displayName: string;
  commandId: string;
} {
  const object = parseObject(value, ["token", "displayName", "commandId"]);
  if (
    typeof object.token !== "string" ||
    object.token.length < 32 ||
    object.token.length > 128 ||
    typeof object.displayName !== "string" ||
    object.displayName.length < 1 ||
    object.displayName.length > 40
  ) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  return {
    token: object.token,
    displayName: object.displayName,
    commandId: parseRequestBody(UuidSchema, object.commandId),
  };
}

function parseToken(value: unknown): string {
  const object = parseObject(value, ["token"]);
  if (
    typeof object.token !== "string" ||
    object.token.length < 32 ||
    object.token.length > 128
  ) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  }
  return object.token;
}

function parseLink(value: unknown): { commandId: string; rotate: boolean } {
  const object = parseObject(value, ["commandId", "rotate"]);
  const commandId = parseRequestBody(UuidSchema, object.commandId);
  if (object.rotate !== undefined && typeof object.rotate !== "boolean")
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.");
  return { commandId, rotate: object.rotate === true };
}

function matchId(value: unknown): string {
  return parseRequestBody(MatchParamsSchema, value).id;
}
function session(
  request: Parameters<typeof requireSession>[0],
  service: AuthService,
): Promise<AuthenticatedSession> {
  return requireSession(request, service, true);
}
export interface InvitationRouteService {
  listIncoming(session: AuthenticatedSession): Promise<unknown>;
  createMatchInvitation(
    matchId: string,
    session: AuthenticatedSession,
    recipientId: string,
  ): Promise<{ id: string; expiresAt: string }>;
  createGuestInvitation(
    matchId: string,
    session: AuthenticatedSession,
  ): Promise<{ id: string; url?: string; expiresAt: string }>;
  accept(
    id: string,
    session: AuthenticatedSession,
    input: { commandId: string; expectedRevision: number },
  ): Promise<unknown>;
  decline(id: string, session: AuthenticatedSession): Promise<void>;
  revoke(id: string, session: AuthenticatedSession): Promise<void>;
  createMatchLink(
    matchId: string,
    session: AuthenticatedSession,
    rotate?: boolean,
  ): Promise<{ url: string }>;
  revokeMatchLink(
    matchId: string,
    session: AuthenticatedSession,
  ): Promise<void>;
  resolve(token: string): Promise<unknown>;
  redeemGuest(
    input: { token: string; displayName: string; commandId: string },
    session?: AuthenticatedSession,
  ): Promise<{
    principal: {
      id: string;
      kind: "guest";
      displayName: string;
      username: null;
    };
    rawSessionToken?: string;
    csrfToken?: string;
    expiresAt: string;
    matchId: string;
    sessionRecovered: boolean;
  }>;
}

export interface InvitationRoutesOptions {
  databasePool: DatabasePool;
  authService: AuthService;
  matchService: MatchService;
  invitationService: InvitationRouteService;
  registry: GameRegistry;
  origin: string;
}

function parseCommandRevision(value: unknown): {
  commandId: string;
  expectedRevision: number;
} {
  const object = parseObject(value, ["commandId", "expectedRevision"]);
  const parsed = parseRequestBody(MatchLifecycleCommandSchema, object);
  return {
    commandId: parsed.commandId,
    expectedRevision: parsed.expectedRevision,
  };
}

function parseCreateGuest(value: unknown): void {
  const object = parseObject(value, ["commandId"]);
  parseRequestBody(UuidSchema, object.commandId);
}

function routeId(value: unknown): string {
  return parseRequestBody(MatchParamsSchema, value).id;
}

export const invitationRoutes: FastifyPluginAsync<
  InvitationRoutesOptions
> = async (fastify, options) => {
  const tokenService = new TokenService(options.databasePool, options.matchService);
  fastify.get("/invitations", async (request, reply) => {
    const current = await requireSession(request, options.authService, false);
    return reply
      .header("Cache-Control", "no-store")
      .send({
        data: await options.invitationService.listIncoming(current),
        serverNow: new Date().toISOString(),
      });
  });

  fastify.post("/matches/:id/invitations", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    const body = parseTargeted(request.body);
    const result = await options.invitationService.createMatchInvitation(
      matchId(request.params),
      current,
      body.recipientPrincipalId,
    );
    return reply
      .status(201)
      .header("Cache-Control", "no-store")
      .send({ data: result, serverNow: new Date().toISOString() });
  });

  fastify.post("/matches/:id/guest-invitations", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    parseCreateGuest(request.body);
    const result = await options.invitationService.createGuestInvitation(
      matchId(request.params),
      current,
    );
    return reply
      .status(201)
      .header("Cache-Control", "no-store")
      .send({ data: result, serverNow: new Date().toISOString() });
  });

  fastify.post("/invitations/:id/accept", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    const body = parseCommandRevision(request.body);
    const result = await options.invitationService.accept(
      routeId(request.params),
      current,
      body,
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: result, serverNow: new Date().toISOString() });
  });

  fastify.post("/invitations/:id/decline", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    await options.invitationService.decline(routeId(request.params), current);
    return reply.status(204).send();
  });

  fastify.delete("/invitations/:id", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    await options.invitationService.revoke(routeId(request.params), current);
    return reply.status(204).send();
  });

  fastify.post("/matches/:id/link", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    const body = parseLink(request.body);
    const result = await options.invitationService.createMatchLink(
      matchId(request.params),
      current,
      body.rotate,
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: result, serverNow: new Date().toISOString() });
  });

  fastify.delete("/matches/:id/link", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const current = await session(request, options.authService);
    await options.invitationService.revokeMatchLink(
      matchId(request.params),
      current,
    );
    return reply.status(204).send();
  });

  fastify.post("/match-links/resolve", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    const token = parseToken(request.body);
    return reply
      .header("Cache-Control", "no-store")
      .send({
        data: await options.invitationService.resolve(token),
        serverNow: new Date().toISOString(),
      });
  });

  fastify.post("/guest-invitations/redeem", async (request, reply) => {
    requireJsonMutation(request, options.origin);
    await tokenService.checkRedemptionLimit(request.ip);
    const body = parseGuest(request.body);
    const rawSession =
      request.cookies[SESSION_COOKIE_NAME] ??
      request.cookies[SESSION_DEV_COOKIE_NAME];
    let existingSession: AuthenticatedSession | undefined;
    if (rawSession) {
      try {
        existingSession = await options.authService.authenticate(rawSession);
      } catch {
        existingSession = undefined;
      }
    }
    const result = await options.invitationService.redeemGuest(
      body,
      existingSession,
    );
    if (result.rawSessionToken && result.csrfToken) {
      setAuthCookies(
        reply,
        options.origin,
        result.rawSessionToken,
        result.csrfToken,
        result.expiresAt,
      );
    }
    return reply.header("Cache-Control", "no-store").send({
      data: {
        principal: result.principal,
        ...(result.csrfToken ? { csrfToken: result.csrfToken } : {}),
        expiresAt: result.expiresAt,
        matchId: result.matchId,
        sessionRecovered: result.sessionRecovered,
      },
      serverNow: new Date().toISOString(),
    });
  });
};

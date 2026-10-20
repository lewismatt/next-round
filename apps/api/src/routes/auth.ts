// SPDX-License-Identifier: Apache-2.0
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import {
  AdminUserParamsSchema,
  AdminUserPatchRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RegisterRequestSchema,
  ResetRedeemRequestSchema,
  TokenRedeemRequestSchema,
  parseRequestBody,
  SetupRequestSchema,
} from "@next-round/contracts/auth";
import {
  SESSION_COOKIE_NAME,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type {
  AuthService,
  AuthenticatedSession,
  TokenService,
} from "@next-round/platform";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

const CSRF_COOKIE_NAME = "__Host-next-round-csrf";
const CSRF_DEV_COOKIE_NAME = "next-round-csrf";

export interface AuthRoutesOptions {
  authService: AuthService;
  tokenService: TokenService;
  origin: string;
}

function serverNow(): string {
  return new Date().toISOString();
}

export function requireJsonMutation(
  request: FastifyRequest,
  origin: string,
): void {
  if (request.headers.origin !== origin) {
    throw new ApiError(ERROR_CODES.FORBIDDEN, "Request origin is invalid.");
  }
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(
      ERROR_CODES.INVALID_REQUEST,
      "Content-Type must be application/json.",
    );
  }
}

function cookieSettings(origin: string): {
  sessionName: string;
  csrfName: string;
  secure: boolean;
} {
  const secure = new URL(origin).protocol === "https:";
  return {
    sessionName: secure ? SESSION_COOKIE_NAME : SESSION_DEV_COOKIE_NAME,
    csrfName: secure ? CSRF_COOKIE_NAME : CSRF_DEV_COOKIE_NAME,
    secure,
  };
}

export function setAuthCookies(
  reply: FastifyReply,
  origin: string,
  rawSessionToken: string,
  rawCsrfToken: string,
  expiresAt: string,
): void {
  const settings = cookieSettings(origin);
  const expires = new Date(expiresAt);
  const common = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: settings.secure,
    expires,
  };
  reply.setCookie(settings.sessionName, rawSessionToken, common);
  reply.setCookie(settings.csrfName, rawCsrfToken, common);
}

function clearAuthCookies(reply: FastifyReply, origin: string): void {
  const settings = cookieSettings(origin);
  reply.clearCookie(settings.sessionName, {
    path: "/",
    secure: settings.secure,
  });
  reply.clearCookie(settings.csrfName, { path: "/", secure: settings.secure });
}

export async function requireSession(
  request: FastifyRequest,
  service: AuthService,
  requireCsrf: boolean,
): Promise<AuthenticatedSession> {
  const rawSessionToken =
    request.cookies[SESSION_COOKIE_NAME] ??
    request.cookies[SESSION_DEV_COOKIE_NAME];
  const session = await service.authenticate(rawSessionToken);
  if (requireCsrf) {
    const header = request.headers["x-csrf-token"];
    service.verifyCsrf(session, Array.isArray(header) ? header[0] : header);
  }
  return session;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  options,
) => {
  const { authService, tokenService, origin } = options;

  fastify.get("/setup", async (_request, reply) => {
    return reply.status(200).send({
      data: { configured: await authService.isConfigured() },
      serverNow: serverNow(),
    });
  });

  fastify.post("/setup", async (request, reply) => {
    requireJsonMutation(request, origin);
    const input = parseRequestBody(SetupRequestSchema, request.body);
    const result = await authService.setup(input);
    return reply.status(201).send({ data: result, serverNow: serverNow() });
  });

  fastify.post("/auth/register", async (request, reply) => {
    requireJsonMutation(request, origin);
    await tokenService.checkRedemptionLimit(request.ip);
    const input = parseRequestBody(RegisterRequestSchema, request.body);
    const result = await authService.register(
      input.token,
      input.username,
      input.password,
      input.displayName,
      input.commandId,
    );
    setAuthCookies(
      reply,
      origin,
      result.rawSessionToken,
      result.rawCsrfToken,
      result.expiresAt,
    );
    return reply
      .status(201)
      .header("Cache-Control", "no-store")
      .send({
        data: {
          principal: result.principal,
          csrfToken: result.rawCsrfToken,
          expiresAt: result.expiresAt,
          destination: result.destination,
        },
        serverNow: serverNow(),
      });
  });

  fastify.post("/auth/qr/redeem", async (request, reply) => {
    requireJsonMutation(request, origin);
    await tokenService.checkRedemptionLimit(request.ip);
    const input = parseRequestBody(TokenRedeemRequestSchema, request.body);
    const result = await authService.redeemSignInToken(
      input.token,
      input.commandId,
    );
    setAuthCookies(
      reply,
      origin,
      result.rawSessionToken,
      result.rawCsrfToken,
      result.expiresAt,
    );
    return reply
      .status(200)
      .header("Cache-Control", "no-store")
      .send({
        data: {
          principal: result.principal,
          csrfToken: result.rawCsrfToken,
          expiresAt: result.expiresAt,
        },
        serverNow: serverNow(),
      });
  });
  fastify.post("/auth/reset/redeem", async (request, reply) => {
    requireJsonMutation(request, origin);
    await tokenService.checkRedemptionLimit(request.ip);
    const input = parseRequestBody(ResetRedeemRequestSchema, request.body);
    await authService.redeemResetToken(
      input.token,
      input.password,
      input.commandId,
    );
    return reply.status(204).send();
  });

  fastify.post("/auth/login", async (request, reply) => {
    requireJsonMutation(request, origin);
    const input = parseRequestBody(LoginRequestSchema, request.body);
      const result = await authService.login(
        input.username,
        input.password,
        request.ip,
      );
      setAuthCookies(
        reply,
        origin,
        result.rawSessionToken,
        result.rawCsrfToken,
        result.expiresAt,
      );
      return reply
        .status(200)
        .header("Cache-Control", "no-store")
        .send({
          data: {
            principal: result.principal,
            csrfToken: result.rawCsrfToken,
            expiresAt: result.expiresAt,
          },
          serverNow: serverNow(),
        });
  });

  fastify.get("/auth/session", async (request, reply) => {
    const session = await requireSession(request, authService, false);
    let rawCsrfToken =
      request.cookies[CSRF_COOKIE_NAME] ??
      request.cookies[CSRF_DEV_COOKIE_NAME];
    try {
      authService.verifyCsrf(session, rawCsrfToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== ERROR_CODES.FORBIDDEN)
        throw error;
      rawCsrfToken = await authService.rotateCsrf(session);
    }
    const rawSessionToken =
      request.cookies[SESSION_COOKIE_NAME] ??
      request.cookies[SESSION_DEV_COOKIE_NAME];
    if (!rawSessionToken || !rawCsrfToken) {
      throw new ApiError(
        ERROR_CODES.AUTH_REQUIRED,
        "Authentication is required.",
      );
    }
    setAuthCookies(
      reply,
      origin,
      rawSessionToken,
      rawCsrfToken,
      session.expiresAt,
    );
    return reply
      .status(200)
      .header("Cache-Control", "no-store")
      .send({
        data: {
          principal: session.principal,
          permissions: session.permissions,
          csrfToken: rawCsrfToken,
          expiresAt: session.expiresAt,
          guestMatchId: session.guestMatchId,
        },
        serverNow: serverNow(),
      });
  });

  fastify.post("/auth/logout", async (request, reply) => {
    requireJsonMutation(request, origin);
    parseRequestBody(LogoutRequestSchema, request.body);
    const session = await requireSession(request, authService, true);
    await authService.logout(session);
    clearAuthCookies(reply, origin);
    return reply.status(204).send();
  });

  fastify.patch("/admin/users/:id", async (request, reply) => {
    requireJsonMutation(request, origin);
    const params = parseRequestBody(AdminUserParamsSchema, request.params);
    const input = parseRequestBody(AdminUserPatchRequestSchema, request.body);
    const session = await requireSession(request, authService, true);
    const { disabled, role, canInviteRegistrations, canInviteGuests } = input;
    const updated = await authService.setUserDisabled(
      session,
      params.id,
      disabled,
      {
        ...(role === undefined ? {} : { role }),
        ...(canInviteRegistrations === undefined
          ? {}
          : { canInviteRegistrations }),
        ...(canInviteGuests === undefined ? {} : { canInviteGuests }),
      },
    );
    const { disabled: effectiveDisabled, ...principal } = updated;
    return reply
      .status(200)
      .header("Cache-Control", "no-store")
      .send({
        data: { principal, disabled: effectiveDisabled },
        serverNow: serverNow(),
      });
  });
};

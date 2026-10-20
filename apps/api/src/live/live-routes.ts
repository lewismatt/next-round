// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  ERROR_CODES,
  LIVE_SUBPROTOCOL,
} from "@next-round/contracts";
import {
  SESSION_COOKIE_NAME,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type { AuthService, AuthenticatedSession } from "@next-round/platform";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { LiveService } from "./live-service.js";

export interface LiveRoutesOptions {
  liveService: LiveService;
  authService: AuthService;
  origin: string;
}

interface RequestWithSession extends FastifyRequest {
  liveSession?: AuthenticatedSession;
}

export const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = async (
  fastify,
  options,
) => {
  const { liveService, authService, origin } = options;

  fastify.get(
    "/live",
    {
      websocket: true,
      preValidation: async (request: RequestWithSession, _reply) => {
        // 1. Reject query parameters (no token in query string per Spec §6)
        if (request.url.includes("?")) {
          throw new ApiError(
            ERROR_CODES.INVALID_REQUEST,
            "Query parameters are not permitted on the live endpoint.",
          );
        }

        // 2. Verify exact Origin before upgrade (Spec §6)
        if (request.headers.origin !== origin) {
          throw new ApiError(ERROR_CODES.FORBIDDEN, "Invalid origin.");
        }
        // 3. Verify required subprotocol before upgrade
        const rawProtocol = request.headers["sec-websocket-protocol"];
        const protocols = typeof rawProtocol === "string"
          ? rawProtocol.split(",").map((p) => p.trim())
          : [];
        if (!protocols.includes(LIVE_SUBPROTOCOL)) {
          throw new ApiError(
            ERROR_CODES.INVALID_REQUEST,
            `WebSocket subprotocol must include ${LIVE_SUBPROTOCOL}.`,
          );
        }
        // 4. Authenticate from session cookie before upgrade (no token in query string)
        const rawSessionToken = request.cookies[
          new URL(origin).protocol === "https:" ? SESSION_COOKIE_NAME : SESSION_DEV_COOKIE_NAME
        ];
        if (!rawSessionToken) {
          throw new ApiError(ERROR_CODES.AUTH_REQUIRED, "Authentication is required.");
        }

        const session = await authService.authenticate(rawSessionToken);
        request.liveSession = session;
      },
    },
    (socket: WebSocket, request: RequestWithSession) => {
      const session = request.liveSession;
      if (!session) {
        socket.close(4401, "Authentication required");
        return;
      }

      liveService.registerConnection(
        socket,
        session.principal.id,
        session.id,
      );
    },
  );
};

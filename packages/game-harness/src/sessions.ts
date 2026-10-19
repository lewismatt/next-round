// SPDX-License-Identifier: Apache-2.0
import { requestData, type HttpClientOptions } from "./client.js";
import type { SimulatedSession } from "./index.js";

interface SessionResponse {
  principal: {
    id: string;
    kind: "registered" | "guest";
    displayName: string;
    username: string | null;
  };
  csrfToken: string;
  matchId?: string;
}

async function authenticate(
  options: HttpClientOptions,
  route: string,
  body: unknown,
  kind: "registered" | "guest"
): Promise<SimulatedSession> {
  const { data, response } = await requestData<SessionResponse>(options, undefined, route, body);
  const principal = data?.principal;
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]);
  if (
    !principal || typeof principal.id !== "string" || !principal.id ||
    principal.kind !== kind || typeof principal.displayName !== "string" ||
    !(principal.username === null || typeof principal.username === "string") ||
    typeof data.csrfToken !== "string" || !data.csrfToken ||
    cookies.length === 0 || cookies.some((cookie) => !cookie || !cookie.includes("=")) ||
    (kind === "guest" && (typeof data.matchId !== "string" || !data.matchId))
  ) {
    throw new Error("Authentication response is missing a valid session.");
  }
  return {
    principalId: principal.id,
    kind: principal.kind,
    displayName: principal.displayName,
    username: principal.username,
    guestMatchId: kind === "guest" ? data.matchId! : null,
    cookie: cookies.join("; "),
    csrfToken: data.csrfToken,
  };
}

export async function authenticateRegistered(
  options: HttpClientOptions,
  credentials: { username: string; password: string }
): Promise<SimulatedSession> {
  return authenticate(options, "/auth/login", credentials, "registered");
}

export async function authenticateGuest(
  options: HttpClientOptions,
  invitation: { token: string; displayName: string }
): Promise<SimulatedSession> {
  return authenticate(options, "/guest-invitations/redeem", {
    ...invitation,
    commandId: crypto.randomUUID(),
  }, "guest");
}

// SPDX-License-Identifier: Apache-2.0
import type { GameManifest, Json } from "@next-round/contracts";
import type { CommandReceipt, MatchSnapshot } from "@next-round/game-client";

export interface Principal {
  id: string;
  kind: "registered" | "guest";
  displayName: string;
  username: string | null;
}

export interface SessionInfo {
  principal: Principal;
  permissions: {
    isAdmin: boolean;
    canInviteGuests: boolean;
    canInviteRegistrations: boolean;
  };
  csrfToken: string;
  expiresAt: string;
  guestMatchId: string | null;
}

export interface MatchCard {
  id: string;
  moduleId: string;
  moduleVersion: string;
  mode: string;
  phase: "lobby" | "active" | "finished";
  revision: number;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  displayName: string;
  text: string;
  createdAt: string;
}

export interface ChatPage {
  data: ChatMessage[];
  nextCursor: string | null;
  serverNow: string;
}

export interface InvitationPreview {
  matchId: string;
  title: string;
  moduleId: string;
  phase: "lobby" | "active" | "finished";
  requiresSignIn: boolean;
  revision: number;
}

export interface RegistrationDestination {
  matchId: string;
  invitationId: string;
}

export interface PendingInvitation {
  id: string;
  issuerId: string;
  matchId: string;
  matchRevision: number;
  expiresAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; unwrapData?: boolean } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "The service could not be reached. Try again when the connection is available.",
    );
  }

  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let code = "REQUEST_FAILED";
    let message = "The request could not be completed.";
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (typeof error === "object" && error !== null) {
        if ("code" in error && typeof error.code === "string")
          code = error.code;
        if ("message" in error && typeof error.message === "string")
          message = error.message;
      }
    }
    throw new ApiError(response.status, code, message);
  }
  if (
    init.unwrapData !== false &&
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload
  ) {
    return payload.data as T;
  }
  return payload as T;
}

export function getSession(): Promise<SessionInfo> {
  return request<SessionInfo>("/auth/session");
}

export function login(
  username: string,
  password: string,
): Promise<{ principal: Principal; csrfToken: string; expiresAt: string }> {
  return request("/auth/login", {
    method: "POST",
    body: { username, password },
  });
}

export function register(input: {
  token: string;
  username: string;
  password: string;
  displayName: string;
}): Promise<{
  principal: Principal;
  csrfToken: string;
  expiresAt: string;
  destination: RegistrationDestination | null;
}> {
  return request("/auth/register", {
    method: "POST",
    body: { ...input, commandId: crypto.randomUUID() },
  });
}

export function redeemSignInToken(
  token: string,
): Promise<{ principal: Principal; csrfToken: string; expiresAt: string }> {
  return request("/auth/qr/redeem", {
    method: "POST",
    body: { token, commandId: crypto.randomUUID() },
  });
}

export function redeemResetToken(
  token: string,
  password: string,
): Promise<void> {
  return request("/auth/reset/redeem", {
    method: "POST",
    body: { token, password, commandId: crypto.randomUUID() },
  });
}

export function redeemGuest(
  token: string,
  displayName: string,
): Promise<{
  principal: Principal;
  csrfToken?: string;
  expiresAt: string;
  matchId: string;
  sessionRecovered: boolean;
}> {
  return request("/guest-invitations/redeem", {
    method: "POST",
    body: { token, displayName, commandId: crypto.randomUUID() },
  });
}

export function logout(): Promise<void> {
  return request("/auth/logout", { method: "POST", body: {} });
}

export function resolveMatchLink(token: string): Promise<InvitationPreview> {
  return request("/match-links/resolve", { method: "POST", body: { token } });
}

export function getGames(): Promise<GameManifest[]> {
  return request("/games");
}

export function getGameManifest(
  gameId: string,
  version: string,
): Promise<GameManifest> {
  return request(
    `/games/${encodeURIComponent(gameId)}?version=${encodeURIComponent(version)}`,
  );
}

export async function getMatches(
  scope: "mine" | "open",
  phase?: "lobby" | "active" | "finished",
): Promise<MatchCard[]> {
  const matches: MatchCard[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ scope, limit: "100" });
    if (phase) query.set("phase", phase);
    if (cursor) query.set("cursor", cursor);
    const result = await request<{
      data: MatchCard[];
      nextCursor: string | null;
    }>(`/matches?${query.toString()}`, { unwrapData: false });
    matches.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return matches;
}

export function getMatch(matchId: string): Promise<MatchSnapshot> {
  return request(`/matches/${encodeURIComponent(matchId)}`);
}

export function getMatchResult(matchId: string): Promise<Json> {
  return request(`/matches/${encodeURIComponent(matchId)}/result`);
}

export function createMatch(input: {
  moduleId: string;
  mode: string;
  settings: Json;
  resourceId?: string;
  visibility: "invite" | "instance";
}): Promise<{ matchId: string; revision: number; commandId: string }> {
  return request("/matches", {
    method: "POST",
    body: { ...input, commandId: crypto.randomUUID() },
  });
}

export interface GameResourceEntry {
  resourceId: string;
  version: number;
  metadata: {
    title: string;
    author: string;
    language: string;
    difficulty: string;
    rows: number;
    cols: number;
    rights: {
      license: string;
      sourceUrl: string | null;
      attribution: string;
      permissionNote: string | null;
    };
  };
  createdAt: string;
}

/** Public resource catalog of one game; never carries solution material. */
export async function getGameResources(
  gameId: string,
): Promise<GameResourceEntry[]> {
  const entries: GameResourceEntry[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await request<{
      data: GameResourceEntry[];
      nextCursor: string | null;
    }>(`/games/${encodeURIComponent(gameId)}/resources?${query.toString()}`, {
      unwrapData: false,
    });
    entries.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return entries;
}

export interface LeaderboardEntry {
  rank: number;
  principalId: string;
  displayName: string;
  username: string;
  points: number;
  gamesPlayed: number;
  wins: number;
  averagePointsPerGame: number | null;
}

export async function getLeaderboard(
  gameId: string,
): Promise<LeaderboardEntry[]> {
  const entries: LeaderboardEntry[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await request<{
      data: LeaderboardEntry[];
      nextCursor: string | null;
    }>(`/games/${encodeURIComponent(gameId)}/leaderboard?${query.toString()}`, {
      unwrapData: false,
    });
    entries.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return entries;
}

export interface AdminGameVersionSummary {
  version: string;
  installedAt: string;
  hasServer: boolean;
  hasClientAssets: boolean;
  referenceCounts: {
    lobby: number;
    active: number;
    finished: number;
    total: number;
  };
}

export interface AdminGameSummary {
  id: string;
  enabled: boolean;
  defaultVersion: string;
  createdAt: string;
  updatedAt: string;
  versions: AdminGameVersionSummary[];
  referenceCounts: {
    lobby: number;
    active: number;
    finished: number;
    total: number;
  };
}

export function getAdminGames(): Promise<AdminGameSummary[]> {
  return request("/admin/games");
}

export function patchAdminGame(
  gameId: string,
  patch: { enabled?: boolean; defaultVersion?: string },
): Promise<AdminGameSummary> {
  return request(`/admin/games/${encodeURIComponent(gameId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export interface ImportReceipt {
  resourceId: string;
  identity: string;
  version: number;
  duplicate: boolean;
}

export function importGameResource(
  gameId: string,
  document: Json,
): Promise<ImportReceipt> {
  return request(`/admin/games/${encodeURIComponent(gameId)}/import`, {
    method: "POST",
    body: { commandId: crypto.randomUUID(), document },
  });
}

export function joinMatch(
  matchId: string,
  expectedRevision: number,
  linkToken?: string,
): Promise<CommandReceipt> {
  return request(`/matches/${encodeURIComponent(matchId)}/join`, {
    method: "POST",
    body: {
      commandId: crypto.randomUUID(),
      expectedRevision,
      ...(linkToken ? { linkToken } : {}),
    },
  });
}

export function acceptInvitation(
  invitationId: string,
  expectedRevision: number,
): Promise<CommandReceipt> {
  return request(`/invitations/${encodeURIComponent(invitationId)}/accept`, {
    method: "POST",
    body: { commandId: crypto.randomUUID(), expectedRevision },
  });
}

export function matchLifecycle(
  matchId: string,
  action: "start" | "leave" | "finish",
  expectedRevision: number,
): Promise<CommandReceipt> {
  return request(`/matches/${encodeURIComponent(matchId)}/${action}`, {
    method: "POST",
    body: { commandId: crypto.randomUUID(), expectedRevision },
  });
}

export function act(
  matchId: string,
  input: {
    type: string;
    payload: Json;
    commandId: string;
    expectedRevision: number;
  },
): Promise<CommandReceipt> {
  return request(`/matches/${encodeURIComponent(matchId)}/actions`, {
    method: "POST",
    body: input,
  });
}

export async function getChat(matchId: string): Promise<ChatPage> {
  return request(`/matches/${encodeURIComponent(matchId)}/chat?limit=100`, {
    unwrapData: false,
  });
}

export function sendChat(
  matchId: string,
  text: string,
): Promise<{ id: string; createdAt: string }> {
  return request(`/matches/${encodeURIComponent(matchId)}/chat`, {
    method: "POST",
    body: { commandId: crypto.randomUUID(), text },
  });
}

export function createMatchLink(matchId: string): Promise<{ url: string }> {
  return request(`/matches/${encodeURIComponent(matchId)}/link`, {
    method: "POST",
    body: { commandId: crypto.randomUUID() },
  });
}

export function createGuestInvite(
  matchId: string,
): Promise<{ id: string; url: string; expiresAt: string }> {
  return request(`/matches/${encodeURIComponent(matchId)}/guest-invitations`, {
    method: "POST",
    body: { commandId: crypto.randomUUID() },
  });
}

export function getIncomingInvitations(): Promise<PendingInvitation[]> {
  return request("/invitations");
}

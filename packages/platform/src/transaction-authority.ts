// SPDX-License-Identifier: Apache-2.0
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { AuthenticatedSession } from "./auth-service.js";

export type TransactionClient = Pick<DatabasePool, "query">;

/** Acquire every affected principal before session, account, token or match locks. */
export async function lockPrincipals(client: TransactionClient, ids: readonly string[]): Promise<void> {
  await client.query(
    `SELECT id FROM next_round.principals
      WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...new Set(ids.map((id) => id.toLowerCase()))].sort()],
  );
}

/** The request's session is a locator, never cached authorization. Caller holds principal locks. */
export async function recheckSession(
  client: TransactionClient,
  session: AuthenticatedSession,
  scope: { matchId?: string; registered?: boolean; admin?: boolean } = {},
): Promise<{ kind: string }> {
  const result = await client.query<{
    kind: string; guest_match_id: string | null; disabled: boolean;
    expired: boolean; role: string | null;
  }>(
    `SELECT p.kind, p.guest_match_id, p.disabled_at IS NOT NULL AS disabled,
            (s.revoked_at IS NOT NULL OR s.auth_epoch <> p.auth_epoch
             OR s.idle_expires_at <= clock_timestamp()
             OR s.absolute_expires_at <= clock_timestamp()) AS expired, a.role
       FROM next_round.sessions s
       JOIN next_round.principals p ON p.id = s.principal_id
       LEFT JOIN next_round.accounts a ON a.principal_id = p.id
      WHERE s.id = $1 AND p.id = $2
      FOR UPDATE OF s`,
    [session.id, session.principal.id],
  );
  const row = result.rows[0];
  if (!row || row.expired) throw new ApiError(ERROR_CODES.SESSION_EXPIRED, "Session has expired.");
  if (row.disabled) throw new ApiError(ERROR_CODES.ACCOUNT_DISABLED, "Account is disabled.");
  if ((scope.registered && row.kind !== "registered") || (scope.admin && row.role !== "admin")) {
    throw new ApiError(ERROR_CODES.FORBIDDEN, "Access is not permitted.");
  }
  if (row.kind === "guest" && scope.matchId && row.guest_match_id !== scope.matchId.toLowerCase()) {
    throw new ApiError(ERROR_CODES.NOT_FOUND, "Match was not found.");
  }
  return row;
}

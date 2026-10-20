// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import { generateCsrfToken, generateOpaqueSessionToken } from "./auth.js";
import type { AuthenticatedSession } from "./auth-service.js";
import type { MatchService } from "./match-service.js";
import { lockPrincipals, recheckSession } from "./transaction-authority.js";
import { chargeInvitationMint } from "./invitation-budget.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GUEST_INVITE_TTL_MS = 15 * 60 * 1000;
const tokenHash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest();

export interface InvitationCreated {
  id: string;
  url?: string;
  expiresAt: string;
}
export interface MatchLinkPreview {
  matchId: string;
  title: string;
  moduleId: string;
  phase: string;
  revision: number;
  requiresSignIn: true;
}

export class InvitationService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly matchService: MatchService,
    private readonly origin: string,
  ) {}

  async createMatchInvitation(
    matchId: string,
    session: AuthenticatedSession,
    recipientId: string,
  ): Promise<InvitationCreated> {
    return this.createInvitation(matchId, session, recipientId, false);
  }

  async redeemGuest(
    input: { token: string; displayName: string; commandId: string },
    existingSession?: AuthenticatedSession,
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
  }> {
    const displayName = input.displayName.trim();
    if (
      !displayName ||
      Array.from(displayName).length > 40 ||
      /[\p{Cc}<>]/u.test(displayName)
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        "Display name is invalid.",
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect();
      const sessionToken = generateOpaqueSessionToken();
      const csrfToken = generateCsrfToken();
      try {
        await client.query("BEGIN");
        const candidateResult = await client.query<{
          id: string;
          match_id: string;
          issuer_id: string;
          status: string;
          unexpired: boolean;
          consumed_by: string | null;
        }>(
          `SELECT id, match_id, issuer_id, status, consumed_by,
                  expires_at > clock_timestamp() AS unexpired
             FROM next_round.invitations
            WHERE token_hash = $1 AND kind = 'guest'`,
          [tokenHash(input.token)],
        );
        const candidate = candidateResult.rows[0];
        if (!candidate)
          throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");

        const reuseGuest =
          existingSession?.principal.kind === "guest" &&
          existingSession.guestMatchId?.toLowerCase() ===
            candidate.match_id.toLowerCase();
        const guestId = reuseGuest
          ? existingSession!.principal.id
          : randomUUID();
        const members = await client.query<{ principal_id: string }>(
          "SELECT principal_id FROM next_round.match_members WHERE match_id = $1",
          [candidate.match_id],
        );
        const principalIds = [
          guestId,
          candidate.issuer_id,
          ...(existingSession ? [existingSession.principal.id] : []),
          ...members.rows.map((row) => row.principal_id),
        ];
        await lockPrincipals(client, principalIds);

        const lockedResult = await client.query<{
          id: string;
          match_id: string;
          issuer_id: string;
          status: string;
          unexpired: boolean;
          consumed_by: string | null;
        }>(
          `SELECT id, match_id, issuer_id, status, consumed_by,
                  expires_at > clock_timestamp() AS unexpired
             FROM next_round.invitations
            WHERE id = $1 AND token_hash = $2 AND kind = 'guest'
            FOR UPDATE`,
          [candidate.id, tokenHash(input.token)],
        );
        const invitation = lockedResult.rows[0];
        if (!invitation)
          throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");

        if (
          invitation.id !== candidate.id ||
          invitation.match_id.toLowerCase() !==
            candidate.match_id.toLowerCase() ||
          invitation.issuer_id.toLowerCase() !==
            candidate.issuer_id.toLowerCase()
        ) {
          throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
        }

        if (invitation.status !== "pending" || !invitation.unexpired) {
          if (
            invitation.status === "accepted" &&
            existingSession?.principal.kind === "guest" &&
            existingSession.guestMatchId?.toLowerCase() ===
              invitation.match_id.toLowerCase() &&
            invitation.consumed_by?.toLowerCase() ===
              existingSession.principal.id.toLowerCase()
          ) {
            await recheckSession(client, existingSession, {
              matchId: invitation.match_id,
            });
            const member = await client.query(
              `SELECT 1 FROM next_round.match_members
                WHERE match_id = $1 AND principal_id = $2 AND status = 'active'`,
              [invitation.match_id, existingSession.principal.id],
            );
            if (member.rowCount) {
              await client.query("COMMIT");
              return {
                principal: {
                  id: existingSession.principal.id,
                  kind: "guest",
                  displayName: existingSession.principal.displayName,
                  username: null,
                },
                expiresAt: existingSession.expiresAt,
                matchId: invitation.match_id,
                sessionRecovered: true,
              };
            }
          }
          throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
        }

        if (existingSession) {
          await recheckSession(client, existingSession);
        }

        const inviter = await client.query<{ allowed: boolean }>(
          `SELECT a.can_invite_guests AND p.disabled_at IS NULL AS allowed
             FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id = p.id
            WHERE p.id = $1`,
          [invitation.issuer_id],
        );
        if (inviter.rows[0]?.allowed !== true) {
          throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
        }

        let principal: {
          id: string;
          kind: "guest";
          displayName: string;
          username: null;
        };
        let sessionRow: { id: string; idle_expires_at: Date };
        if (reuseGuest) {
          principal = {
            id: existingSession!.principal.id,
            kind: "guest",
            displayName: existingSession!.principal.displayName,
            username: null,
          };
          const refreshed = await client.query<{
            id: string;
            idle_expires_at: Date;
          }>(
            `UPDATE next_round.sessions
                SET token_hash = $2, csrf_hash = $3, last_seen_at = clock_timestamp(),
                    idle_expires_at = LEAST(clock_timestamp() + interval '30 days', absolute_expires_at)
              WHERE id = $1 AND principal_id = $4 AND revoked_at IS NULL
                AND absolute_expires_at > clock_timestamp()
              RETURNING id, idle_expires_at`,
            [
              existingSession!.id,
              sessionToken.tokenHash,
              csrfToken.csrfHash,
              guestId,
            ],
          );
          if (!refreshed.rowCount)
            throw new ApiError(
              ERROR_CODES.SESSION_EXPIRED,
              "Session has expired.",
            );
          sessionRow = refreshed.rows[0];
        } else {
          await client.query(
            `INSERT INTO next_round.principals (id, kind, display_name, guest_match_id)
             VALUES ($1, 'guest', $2, $3)`,
            [guestId, displayName, invitation.match_id],
          );
          const inserted = await client.query<{
            id: string;
            idle_expires_at: Date;
          }>(
            `INSERT INTO next_round.sessions
               (principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
             SELECT id, $2, $3, auth_epoch, clock_timestamp() + interval '30 days',
                    clock_timestamp() + interval '180 days'
               FROM next_round.principals WHERE id = $1
             RETURNING id, idle_expires_at`,
            [guestId, sessionToken.tokenHash, csrfToken.csrfHash],
          );
          principal = {
            id: guestId,
            kind: "guest",
            displayName,
            username: null,
          };
          sessionRow = inserted.rows[0];
        }
        const guestSession: AuthenticatedSession = {
          id: sessionRow.id,
          principal,
          permissions: {
            isAdmin: false,
            canInviteRegistrations: false,
            canInviteGuests: false,
          },
          guestMatchId: invitation.match_id,
          csrfHash: csrfToken.csrfHash,
          expiresAt: sessionRow.idle_expires_at.toISOString(),
        };
        const currentMatch = await client.query<{ revision: number }>(
          "SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1",
          [invitation.match_id],
        );
        if (!currentMatch.rows[0])
          throw new ApiError(ERROR_CODES.NOT_FOUND, "Match was not found.");
        const receipt = await this.matchService.joinInTransaction(
          client,
          invitation.match_id,
          guestSession,
          {
            commandId: input.commandId,
            expectedRevision: currentMatch.rows[0].revision,
          },
          invitation.id,
          "guest",
        );
        await client.query("COMMIT");
        return {
          principal,
          rawSessionToken: sessionToken.rawToken,
          csrfToken: csrfToken.rawToken,
          expiresAt: guestSession.expiresAt,
          matchId: receipt.matchId,
          sessionRecovered: false,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined;
        if (code !== "40001" && code !== "40P01") throw error;
        if (attempt === 2)
          throw new ApiError(
            ERROR_CODES.SERVICE_UNAVAILABLE,
            "Please retry this command.",
          );
        await delay(10 + Math.random() * 30);
      } finally {
        client.release();
      }
    }
  }
  async createGuestInvitation(
    matchId: string,
    session: AuthenticatedSession,
  ): Promise<InvitationCreated> {
    return this.createInvitation(matchId, session, null, true);
  }

  private async createInvitation(
    matchId: string,
    session: AuthenticatedSession,
    recipientId: string | null,
    guest: boolean,
  ): Promise<InvitationCreated> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const members = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.match_members WHERE match_id = $1",
        [matchId],
      );
      await lockPrincipals(client, [
        ...members.rows.map((row) => row.principal_id),
        session.principal.id,
        ...(recipientId ? [recipientId] : []),
      ]);
      await recheckSession(client, session, { matchId, registered: true });
      const match = await client.query<{ phase: string }>(
        "SELECT phase FROM next_round.matches WHERE id = $1 FOR UPDATE",
        [matchId],
      );
      if (guest) {
        const permission = await client.query<{ allowed: boolean }>(
          `SELECT a.can_invite_guests AND p.disabled_at IS NULL AS allowed
             FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id = p.id
            WHERE p.id = $1`,
          [session.principal.id],
        );
        if (permission.rows[0]?.allowed !== true)
          throw new ApiError(
            ERROR_CODES.FORBIDDEN,
            "Guest invitations are not permitted.",
          );
      }
      if (!match.rows[0] || match.rows[0].phase === "finished")
        throw new ApiError(ERROR_CODES.NOT_FOUND, "Match was not found.");
      if (
        !(await this.matchService.canInviteInTransaction(
          client,
          matchId,
          session.principal.id,
        ))
      ) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Match invitation access is not permitted.",
        );
      }
      if (recipientId) {
        const recipient = await client.query(
          "SELECT 1 FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id=p.id WHERE p.id=$1 AND p.kind='registered' AND p.disabled_at IS NULL FOR UPDATE OF p,a",
          [recipientId],
        );
        if (
          !recipient.rowCount ||
          recipientId.toLowerCase() === session.principal.id.toLowerCase()
        )
          throw new ApiError(
            ERROR_CODES.INVALID_REQUEST,
            "Invitation recipient is unavailable.",
          );
      }
      await chargeInvitationMint(client, session.principal.id);
      const token = randomBytes(32).toString("base64url");
      const expiry = new Date(
        Date.now() + (guest ? GUEST_INVITE_TTL_MS : INVITE_TTL_MS),
      ).toISOString();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO next_round.invitations (kind, issuer_id, recipient_id, match_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          guest ? "guest" : "member",
          session.principal.id,
          recipientId,
          matchId,
          tokenHash(token),
          expiry,
        ],
      );
      await client.query("COMMIT");
      const result: InvitationCreated = {
        id: inserted.rows[0].id,
        expiresAt: expiry,
      };
      if (guest)
        result.url = new URL(`/invite#${token}`, this.origin).toString();
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async decline(id: string, session: AuthenticatedSession): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session, { registered: true });
      const changed = await client.query(
        `UPDATE next_round.invitations SET status='declined' WHERE id=$1 AND kind='member' AND recipient_id=$2 AND status='pending'`,
        [id, session.principal.id],
      );
      if (!changed.rowCount)
        throw new ApiError(ERROR_CODES.NOT_FOUND, "Invitation was not found.");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(id: string, session: AuthenticatedSession): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidate = await client.query<{ issuer_id: string }>(
        "SELECT issuer_id FROM next_round.invitations WHERE id=$1",
        [id],
      );
      const issuer = candidate.rows[0]?.issuer_id;
      await lockPrincipals(client, [
        session.principal.id,
        ...(issuer ? [issuer] : []),
      ]);
      await recheckSession(client, session);
      const invitation = await client.query<{ issuer_id: string }>(
        "SELECT issuer_id FROM next_round.invitations WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (
        issuer &&
        invitation.rows[0]?.issuer_id.toLowerCase() !== issuer.toLowerCase()
      ) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, "Invitation was not found.");
      }
      const account = await client.query<{ is_admin: boolean }>(
        "SELECT role='admin' AS is_admin FROM next_round.accounts WHERE principal_id=$1",
        [session.principal.id],
      );
      if (
        invitation.rows[0] &&
        invitation.rows[0].issuer_id.toLowerCase() !==
          session.principal.id.toLowerCase() &&
        account.rows[0]?.is_admin !== true
      ) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Invitation revocation is not permitted.",
        );
      }
      await client.query(
        "UPDATE next_round.invitations SET status='revoked' WHERE id=$1 AND status='pending'",
        [id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async accept(
    id: string,
    session: AuthenticatedSession,
    input: { commandId: string; expectedRevision: number },
  ) {
    const result = await this.pool.query<{ match_id: string }>(
      "SELECT match_id FROM next_round.invitations WHERE id=$1 AND kind='member'",
      [id],
    );
    const matchId = result.rows[0]?.match_id;
    if (!matchId)
      throw new ApiError(ERROR_CODES.NOT_FOUND, "Invitation was not found.");
    return this.matchService.acceptInvitation(matchId, id, session, input);
  }

  async listIncoming(session: AuthenticatedSession) {
    const result = await this.pool.query(
      `SELECT i.id, i.issuer_id AS "issuerId", i.match_id AS "matchId",
              m.revision::integer AS "matchRevision", i.expires_at AS "expiresAt"
         FROM next_round.invitations i JOIN next_round.matches m ON m.id=i.match_id
        WHERE i.recipient_id=$1 AND i.kind='member' AND i.status='pending'
          AND i.expires_at>clock_timestamp()
        ORDER BY i.created_at`,
      [session.principal.id],
    );
    return result.rows;
  }

  async createMatchLink(
    matchId: string,
    session: AuthenticatedSession,
    rotate = false,
  ): Promise<{ url: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const members = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.match_members WHERE match_id=$1",
        [matchId],
      );
      await lockPrincipals(client, [
        ...members.rows.map((row) => row.principal_id),
        session.principal.id,
      ]);
      await recheckSession(client, session, { matchId, registered: true });
      const match = await client.query<{
        phase: string;
        host_member_id: string | null;
      }>(
        "SELECT phase,host_member_id FROM next_round.matches WHERE id=$1 FOR UPDATE",
        [matchId],
      );
      if (!match.rows[0] || match.rows[0].phase === "finished")
        throw new ApiError(ERROR_CODES.NOT_FOUND, "Match was not found.");
      if (
        !(await this.matchService.canInviteInTransaction(
          client,
          matchId,
          session.principal.id,
        )) ||
        !match.rows[0].host_member_id ||
        !(
          await client.query(
            "SELECT 1 FROM next_round.match_members WHERE id=$1 AND principal_id=$2 AND status='active'",
            [match.rows[0].host_member_id, session.principal.id],
          )
        ).rowCount
      ) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Only the host can manage this match link.",
        );
      }
      if (!rotate) {
        const existing = await client.query<{ token_hash: Buffer }>(
          "SELECT token_hash FROM next_round.match_links WHERE match_id=$1 AND revoked_at IS NULL",
          [matchId],
        );
        if (existing.rows[0])
          throw new ApiError(
            ERROR_CODES.RULE_REJECTED,
            "A match link already exists; rotate it explicitly.",
          );
      }
      await client.query(
        "UPDATE next_round.match_links SET revoked_at=clock_timestamp() WHERE match_id=$1 AND revoked_at IS NULL",
        [matchId],
      );
      await chargeInvitationMint(client, session.principal.id);
      const token = randomBytes(32).toString("base64url");
      await client.query(
        "INSERT INTO next_round.match_links(match_id,token_hash,issued_by) VALUES($1,$2,$3)",
        [matchId, tokenHash(token), session.principal.id],
      );
      await client.query("COMMIT");
      return { url: new URL(`/invite#${token}`, this.origin).toString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolve(token: string): Promise<MatchLinkPreview> {
    const result = await this.pool.query<{
      match_id: string;
      title: string;
      module_id: string;
      phase: string;
      revision: number;
    }>(
      `SELECT m.id AS match_id, m.module_id AS title, m.module_id, m.phase,
              m.revision::integer AS revision
         FROM next_round.match_links l JOIN next_round.matches m ON m.id=l.match_id
        WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND m.phase <> 'finished'`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row)
      throw new ApiError(ERROR_CODES.TOKEN_INVALID, "Token is invalid.");
    return {
      matchId: row.match_id,
      title: row.title,
      moduleId: row.module_id,
      phase: row.phase,
      revision: row.revision,
      requiresSignIn: true,
    };
  }

  async revokeMatchLink(
    matchId: string,
    session: AuthenticatedSession,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const members = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.match_members WHERE match_id=$1",
        [matchId],
      );
      await lockPrincipals(client, [
        ...members.rows.map((row) => row.principal_id),
        session.principal.id,
      ]);
      await recheckSession(client, session, { matchId, registered: true });
      const match = await client.query<{ host_member_id: string | null }>(
        "SELECT host_member_id FROM next_round.matches WHERE id=$1 FOR UPDATE",
        [matchId],
      );
      const account = await client.query<{ role: string }>(
        "SELECT role FROM next_round.accounts WHERE principal_id=$1",
        [session.principal.id],
      );
      const isAdmin = account.rows[0]?.role === "admin";
      const isHost =
        match.rows[0]?.host_member_id &&
        (
          await client.query(
            "SELECT 1 FROM next_round.match_members WHERE id=$1 AND principal_id=$2 AND status='active'",
            [match.rows[0].host_member_id, session.principal.id],
          )
        ).rowCount === 1;
      if (!match.rows[0] || (!isAdmin && !isHost)) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Only the host or an administrator can revoke this match link.",
        );
      }
      await client.query(
        "UPDATE next_round.match_links SET revoked_at=clock_timestamp() WHERE match_id=$1 AND revoked_at IS NULL",
        [matchId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

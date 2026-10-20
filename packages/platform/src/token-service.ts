// SPDX-License-Identifier: Apache-2.0
import crypto from "node:crypto";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import { lockPrincipals, recheckSession } from "./transaction-authority.js";
import type { AuthenticatedSession } from "./auth-service.js";
import type { MatchService } from "./match-service.js";
import { chargeInvitationMint } from "./invitation-budget.js";

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export interface IssuedToken {
  id: string;
  token: string;
  expiresAt: string;
}

function bearer(): { raw: string; digest: Buffer } {
  const raw = crypto.randomBytes(32).toString("hex");
  return {
    raw,
    digest: crypto.createHash("sha256").update(raw, "utf8").digest(),
  };
}

/** Issues opaque bearer tokens; only their SHA-256 digests are persisted. */
export class TokenService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly matchService: MatchService,
  ) {}

  async issueRegistration(
    actor: AuthenticatedSession,
    commandId: string,
    matchId?: string,
  ): Promise<IssuedToken> {
    if (
      actor.principal.kind !== "registered" ||
      (!actor.permissions.isAdmin && !actor.permissions.canInviteRegistrations)
    ) {
      throw new ApiError(
        ERROR_CODES.FORBIDDEN,
        "Registration invitations are not permitted.",
      );
    }
    const token = bearer();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const members = matchId
        ? await client.query<{ principal_id: string }>(
            "SELECT principal_id FROM next_round.match_members WHERE match_id=$1",
            [matchId],
          )
        : { rows: [] };
      await lockPrincipals(client, [
        actor.principal.id,
        ...members.rows.map((member) => member.principal_id),
      ]);
      await recheckSession(client, actor, { registered: true });
      const issuer = await client.query(
        `SELECT p.disabled_at, a.role, a.can_invite_registrations
           FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id=p.id
          WHERE p.id=$1`,
        [actor.principal.id],
      );
      const row = issuer.rows[0];
      if (
        !row ||
        row.disabled_at ||
        (row.role !== "admin" && !row.can_invite_registrations)
      ) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Registration invitations are not permitted.",
        );
      }
      if (
        matchId &&
        !(await this.matchService.canInviteInTransaction(
          client,
          matchId,
          actor.principal.id,
        ))
      ) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Match invitation is not permitted.",
        );
      }
      const requestHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            route: "POST /api/v1/invitations/registration",
            commandId: commandId.toLowerCase(),
            matchId: matchId?.toLowerCase() ?? null,
          }),
          "utf8",
        )
        .digest();
      const prior = await client.query(
        `SELECT 1 FROM next_round.command_receipts
          WHERE principal_id=$1 AND scope='token.registration.issue' AND command_id=$2`,
        [actor.principal.id, commandId],
      );
      if (prior.rowCount)
        throw new ApiError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "This command was already used; issued credentials cannot be recovered.",
        );
      await chargeInvitationMint(client, actor.principal.id);
      const expiresAt = new Date(Date.now() + 7 * DAY).toISOString();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO next_round.invitations(kind,issuer_id,match_id,token_hash,status,expires_at)
         VALUES ('registration',$1,$2,$3,'pending',$4) RETURNING id`,
        [actor.principal.id, matchId ?? null, token.digest, expiresAt],
      );
      await client.query(
        `INSERT INTO next_round.command_receipts
          (principal_id,scope,command_id,request_hash,match_id,committed_revision,safe_receipt)
         VALUES($1,'token.registration.issue',$2,$3,$4,NULL,$5::jsonb)`,
        [
          actor.principal.id,
          commandId,
          requestHash,
          matchId ?? null,
          JSON.stringify({ status: "issued" }),
        ],
      );
      await client.query(
        `INSERT INTO next_round.audit_log(actor_id,action,target_type,target_id,safe_metadata)
         VALUES($1,'registration_token.issued','invitation',$2,$3::jsonb)`,
        [
          actor.principal.id,
          inserted.rows[0]!.id,
          JSON.stringify({ commandId, matchId: matchId ?? null }),
        ],
      );
      await client.query("COMMIT");
      return { id: inserted.rows[0]!.id, token: token.raw, expiresAt };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async issueAccountToken(
    actor: AuthenticatedSession,
    principalId: string,
    kind: "signin" | "reset",
    commandId: string,
  ): Promise<IssuedToken> {
    if (!actor.permissions.isAdmin || actor.principal.kind !== "registered") {
      throw new ApiError(
        ERROR_CODES.FORBIDDEN,
        "Administrator access is required.",
      );
    }
    const issued = bearer();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [actor.principal.id, principalId]);
      await recheckSession(client, actor, { registered: true, admin: true });
      const current = await client.query(
        `SELECT p.disabled_at FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id=p.id
          WHERE p.id=$1 FOR UPDATE OF p,a`,
        [principalId],
      );
      if (!current.rowCount || current.rows[0]!.disabled_at)
        throw new ApiError(ERROR_CODES.NOT_FOUND, "User was not found.");
      const actorCheck = await client.query(
        `SELECT p.disabled_at,a.role FROM next_round.principals p JOIN next_round.accounts a ON a.principal_id=p.id WHERE p.id=$1`,
        [actor.principal.id],
      );
      if (
        !actorCheck.rowCount ||
        actorCheck.rows[0]!.disabled_at ||
        actorCheck.rows[0]!.role !== "admin"
      )
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Administrator access is required.",
        );
      const requestHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            route: `POST /api/v1/admin/users/:id/${kind}`,
            commandId: commandId.toLowerCase(),
            principalId: principalId.toLowerCase(),
          }),
          "utf8",
        )
        .digest();
      const prior = await client.query(
        `SELECT 1 FROM next_round.command_receipts
          WHERE principal_id=$1 AND scope=$2 AND command_id=$3`,
        [actor.principal.id, `token.account.${kind}.issue`, commandId],
      );
      if (prior.rowCount)
        throw new ApiError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "This command was already used; issued credentials cannot be recovered.",
        );
      if (kind === "reset")
        await client.query(
          "UPDATE next_round.auth_tokens SET revoked_at=now() WHERE principal_id=$1 AND kind='reset' AND revoked_at IS NULL AND used_at IS NULL",
          [principalId],
        );
      const expiry = new Date(
        Date.now() + (kind === "reset" ? 30 * MINUTE : 15 * MINUTE),
      );
      const stored = await client.query<{ id: string }>(
        `INSERT INTO next_round.auth_tokens(kind,token_hash,principal_id,issuer_id,expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [kind, issued.digest, principalId, actor.principal.id, expiry],
      );
      await client.query(
        `INSERT INTO next_round.command_receipts
          (principal_id,scope,command_id,request_hash,match_id,committed_revision,safe_receipt)
         VALUES($1,$2,$3,$4,NULL,NULL,$5::jsonb)`,
        [
          actor.principal.id,
          `token.account.${kind}.issue`,
          commandId,
          requestHash,
          JSON.stringify({ status: "issued" }),
        ],
      );
      await client.query(
        `INSERT INTO next_round.audit_log(actor_id,action,target_type,target_id,safe_metadata)
         VALUES($1,$2,'principal',$3,$4::jsonb)`,
        [
          actor.principal.id,
          `${kind}_token.issued`,
          principalId,
          JSON.stringify({ commandId }),
        ],
      );
      await client.query("COMMIT");
      return {
        id: stored.rows[0]!.id,
        token: issued.raw,
        expiresAt: expiry.toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Enforces the cluster-shared spec token budget for a trusted caller-derived key. */
  async checkRedemptionLimit(addressKey: string): Promise<void> {
    const keyHash = crypto
      .createHash("sha256")
      .update(addressKey, "utf8")
      .digest();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea,'hex'),0))",
        [keyHash],
      );
      const budget = await client.query<{ count: number; retry_after_seconds: number }>(
        `SELECT COALESCE(sum(count),0)::integer AS count,
                GREATEST(1,ceil(extract(epoch FROM (
                  min(window_start)+interval '1 minute'-clock_timestamp()
                ))))::integer AS retry_after_seconds
           FROM next_round.rate_buckets
          WHERE key_hash=$1 AND window_start > clock_timestamp()-interval '1 minute'`,
        [keyHash],
      );
      if (budget.rows[0]!.count >= 10) {
        throw new ApiError(ERROR_CODES.RATE_LIMITED, "Too many token attempts.", {
          details: { retryAfterSeconds: budget.rows[0]!.retry_after_seconds },
        });
      }
      await client.query(
        "DELETE FROM next_round.rate_buckets WHERE key_hash=$1 AND expires_at<=clock_timestamp()",
        [keyHash],
      );
      await client.query(
        `INSERT INTO next_round.rate_buckets(key_hash,window_start,count,expires_at)
         SELECT $1,t,1,t+interval '1 minute' FROM (SELECT clock_timestamp() AS t) stamp
         ON CONFLICT (key_hash,window_start) DO UPDATE SET count=next_round.rate_buckets.count+1`,
        [keyHash],
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

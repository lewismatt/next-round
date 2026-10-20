// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import {
  ApiError,
  ERROR_CODES,
  parseJsonSchemaValue,
  PolicyV1Schema,
  type PolicyV1,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { AuthenticatedSession } from "./auth-service.js";
import type { GameRegistry } from "./registry.js";
import { lockPrincipals, recheckSession } from "./transaction-authority.js";

const now = () => new Date().toISOString();
const invalid = () =>
  new ApiError(ERROR_CODES.INVALID_REQUEST, "Request is invalid.");
const notFound = () =>
  new ApiError(ERROR_CODES.NOT_FOUND, "Resource was not found.");
function cursorDecode(
  value?: string,
): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const item = JSON.parse(decoded) as { t?: unknown; id?: unknown };
    if (
      typeof item.t !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.t) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(item.id),
      )
    )
      throw invalid();
    const date = new Date(item.t);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== item.t)
      throw invalid();
    return { createdAt: item.t, id: item.id as string };
  } catch {
    throw invalid();
  }
}
function cursorEncode(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id })).toString(
    "base64url",
  );
}
function pageSize(input?: string): number {
  if (input === undefined) return 25;
  if (!/^(?:[1-9]\d?|100)$/.test(input)) throw invalid();
  return Number(input);
}

export interface SharedList<T> {
  data: T[];
  nextCursor: string | null;
  serverNow: string;
}
export class SharedService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly registry: GameRegistry,
  ) {}

  async listChat(
    session: AuthenticatedSession,
    matchId: string,
    cursor?: string,
    limit?: string,
  ) {
    const marker = cursorDecode(cursor);
    const size = pageSize(limit);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session, { matchId });
      const membership = await client.query(
        `SELECT 1 FROM next_round.matches m JOIN next_round.match_members mm ON mm.match_id=m.id
         WHERE m.id=$1 AND mm.principal_id=$2 AND mm.status='active'`,
        [matchId, session.principal.id],
      );
      if (!membership.rows[0]) throw notFound();
      const access = await client.query<{
        text: string;
        id: string;
        sender_id: string;
        display_name: string;
        created_at: Date;
      }>(
        `SELECT c.id, c.text, c.sender_id, p.display_name, c.created_at
         FROM next_round.chat_messages c JOIN next_round.match_members mm ON mm.match_id=c.match_id AND mm.principal_id=$2 AND mm.status='active'
         JOIN next_round.matches m ON m.id=c.match_id JOIN next_round.principals p ON p.id=c.sender_id
         WHERE c.match_id=$1 AND c.deleted_at IS NULL AND ($3::timestamptz IS NULL OR (c.created_at,c.id) < ($3::timestamptz,$4::uuid))
           AND (m.policy_snapshot->>'rejoinChat'='full' OR c.created_at >= mm.chat_from_at)
         ORDER BY c.created_at DESC,c.id DESC LIMIT $5`,
        [
          matchId,
          session.principal.id,
          marker?.createdAt ?? null,
          marker?.id ?? null,
          size + 1,
        ],
      );
      const rows = access.rows.slice(0, size);
      const oldest = rows[rows.length - 1];
      const nextCursor =
        access.rows.length > size && oldest
          ? cursorEncode(oldest.created_at.toISOString(), oldest.id)
          : null;
      const data = rows
        .reverse()
        .map((row) => ({
          id: row.id,
          senderId: row.sender_id,
          displayName: row.display_name,
          text: row.text,
          createdAt: row.created_at.toISOString(),
        }));
      await client.query("COMMIT");
      return { data, nextCursor, serverNow: now() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async sendChat(
    session: AuthenticatedSession,
    matchId: string,
    input: { commandId: string; text: string },
  ) {
    const textLength = [...input.text].length;
    if (
      textLength < 1 ||
      textLength > 2000 ||
      Buffer.byteLength(input.text, "utf8") > 8192
    )
      throw invalid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session, { matchId });
      const match = await client.query<{ chat_revision: string }>(
        `SELECT chat_revision::text FROM next_round.matches WHERE id=$1 FOR UPDATE`,
        [matchId],
      );
      const member = await client.query<{ id: string; access_epoch: number }>(
        `SELECT id,access_epoch FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2 AND status='active' FOR UPDATE`,
        [matchId, session.principal.id],
      );
      if (!match.rows[0] || !member.rows[0]) throw notFound();
      const prior = await client.query<{
        id: string;
        created_at: Date;
        command_id: string;
        text: string;
      }>(
        `SELECT id,created_at,command_id,text FROM next_round.chat_messages WHERE match_id=$1 AND sender_id=$2 AND command_id=$3`,
        [matchId, session.principal.id, input.commandId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].text !== input.text)
          throw new ApiError(
            ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "Command ID was already used.",
          );
        await client.query("COMMIT");
        return {
          id: prior.rows[0].id,
          createdAt: prior.rows[0].created_at.toISOString(),
        };
      }
      const created = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO next_round.chat_messages(id,match_id,sender_id,command_id,membership_epoch,text) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
        [
          randomUUID(),
          matchId,
          session.principal.id,
          input.commandId,
          member.rows[0].access_epoch,
          input.text,
        ],
      );
      const rev = await client.query<{ chat_revision: string }>(
        `UPDATE next_round.matches SET chat_revision=chat_revision+1 WHERE id=$1 RETURNING chat_revision::text`,
        [matchId],
      );
      await client.query(
        `INSERT INTO next_round.outbox(id,topic,aggregate_id,aggregate_revision,dedupe_key,safe_payload,available_at,attempts) VALUES($1,'live.invalidate',$2,$3,$4,$5::jsonb,clock_timestamp(),0)`,
        [
          randomUUID(),
          matchId,
          rev.rows[0]!.chat_revision,
          `chat:${matchId}:${rev.rows[0]!.chat_revision}`,
          JSON.stringify({
            scope: { kind: "chat", id: matchId },
            revision: Number(rev.rows[0]!.chat_revision),
          }),
        ],
      );
      await client.query("COMMIT");
      return {
        id: created.rows[0]!.id,
        createdAt: created.rows[0]!.created_at.toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async notifications(
    session: AuthenticatedSession,
    unreadOnly: boolean,
    cursor?: string,
    limit?: string,
  ) {
    const marker = cursorDecode(cursor),
      size = pageSize(limit);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session);
      const result = await client.query<{
        id: string;
        match_id: string | null;
        kind: string;
        safe_payload: unknown;
        created_at: Date;
        read_at: Date | null;
      }>(
        `SELECT id,match_id,kind,safe_payload,created_at,read_at FROM next_round.notifications
         WHERE principal_id=$1 AND superseded_at IS NULL AND ($2::boolean=false OR read_at IS NULL)
          AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
          AND ($5::uuid IS NULL OR match_id=$5) ORDER BY created_at DESC,id DESC LIMIT $6`,
        [
          session.principal.id,
          unreadOnly,
          marker?.createdAt ?? null,
          marker?.id ?? null,
          session.principal.kind === "guest" ? session.guestMatchId : null,
          size + 1,
        ],
      );
      const rows = result.rows.slice(0, size);
      await client.query("COMMIT");
      return {
        data: rows.map((r) => ({
          id: r.id,
          matchId: r.match_id,
          kind: r.kind,
          payload: r.safe_payload,
          createdAt: r.created_at.toISOString(),
          readAt: r.read_at?.toISOString() ?? null,
        })),
        nextCursor:
          result.rows.length > size
            ? cursorEncode(
                rows[rows.length - 1]!.created_at.toISOString(),
                rows[rows.length - 1]!.id,
              )
            : null,
        serverNow: now(),
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async markNotificationsRead(session: AuthenticatedSession, ids: string[]) {
    if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length)
      throw invalid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      const scope =
        session.principal.kind === "guest" ? session.guestMatchId : null;
      await recheckSession(client, session, scope ? { matchId: scope } : {});
      const updated = await client.query(
        `UPDATE next_round.notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE principal_id=$1 AND id=ANY($2::uuid[]) AND (read_at IS NULL) AND ($3::uuid IS NULL OR match_id=$3)`,
        [session.principal.id, ids, scope],
      );
      const found = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM next_round.notifications WHERE principal_id=$1 AND id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR match_id=$3)`,
        [session.principal.id, ids, scope],
      );
      if (found.rows[0]!.n !== ids.length) throw invalid();
      if (updated.rowCount) {
        const rev = await client.query<{ revision: string }>(
          `UPDATE next_round.principals SET inbox_revision=inbox_revision+1 WHERE id=$1 RETURNING inbox_revision::text AS revision`,
          [session.principal.id],
        );
        await client.query(
          `INSERT INTO next_round.outbox(id,topic,aggregate_id,aggregate_revision,dedupe_key,safe_payload,available_at,attempts) VALUES($1,'live.invalidate',$2,$3,$4,$5::jsonb,clock_timestamp(),0)`,
          [
            randomUUID(),
            session.principal.id,
            rev.rows[0]!.revision,
            `inbox:${session.principal.id}:${rev.rows[0]!.revision}`,
            JSON.stringify({
              scope: {
                kind: "notifications",
                principalId: session.principal.id,
              },
              revision: Number(rev.rows[0]!.revision),
            }),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async policy(session: AuthenticatedSession) {
    if (!session.permissions.isAdmin || session.principal.kind !== "registered")
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Access is not permitted.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session, { registered: true, admin: true });
      const r = await client.query<{ version: string; policy: PolicyV1 }>(
        `SELECT p.version::text,p.policy FROM next_round.instance_policy p JOIN next_round.instance_singleton s ON s.current_policy_version=p.version WHERE s.id=true`,
      );
      if (!r.rows[0]) throw notFound();
      await client.query("COMMIT");
      return { version: Number(r.rows[0].version), policy: r.rows[0].policy };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async updatePolicy(
    session: AuthenticatedSession,
    expectedVersion: number,
    policy: PolicyV1,
  ) {
    if (!session.permissions.isAdmin || session.principal.kind !== "registered")
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Access is not permitted.");
    const valid = parseJsonSchemaValue(PolicyV1Schema, policy);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session, { registered: true, admin: true });
      const r = await client.query<{ version: string }>(
        `SELECT current_policy_version::text AS version FROM next_round.instance_singleton WHERE id=true FOR UPDATE`,
      );
      if (!r.rows[0] || Number(r.rows[0].version) !== expectedVersion)
        throw new ApiError(ERROR_CODES.STALE_REVISION, "Policy changed.");
      const version = expectedVersion + 1;
      await client.query(
        `INSERT INTO next_round.instance_policy(version,instance_name,policy,changed_by) SELECT $1,instance_name,$2::jsonb,$3 FROM next_round.instance_policy WHERE version=$4`,
        [version, JSON.stringify(valid), session.principal.id, expectedVersion],
      );
      await client.query(
        `UPDATE next_round.instance_singleton SET current_policy_version=$1 WHERE id=true`,
        [version],
      );
      await client.query(
        `INSERT INTO next_round.audit_log(id,actor_id,action,target_type,target_id,safe_metadata) VALUES($1,$2,'policy.update','policy','instance',$3::jsonb)`,
        [randomUUID(), session.principal.id, JSON.stringify({ version })],
      );
      await client.query("COMMIT");
      return { version, policy: valid };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async leaderboard(
    session: AuthenticatedSession,
    gameId: string,
    cursor?: string,
    limit?: string,
  ) {
    if (!this.registry.getVersion(gameId)) throw notFound();
    const size = pageSize(limit);
    // Rank order is descending points; username then principal UUID deterministically breaks ties.
    let afterPoints: string | null = null,
      afterUsername: string | null = null,
      afterId: string | null = null;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
          p?: unknown;
          u?: unknown;
          id?: unknown;
        };
        if (
          typeof c.p !== "string" ||
          !Number.isSafeInteger(Number(c.p)) ||
          typeof c.u !== "string" ||
          typeof c.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            c.id,
          )
        )
          throw invalid();
        afterPoints = c.p;
        afterUsername = c.u;
        afterId = c.id;
      } catch {
        throw invalid();
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      const current = await recheckSession(client, session, {
        registered: true,
      });
      if (current.kind === "guest")
        throw new ApiError(ERROR_CODES.FORBIDDEN, "Access is not permitted.");
      const result = await client.query<{
        principal_id: string;
        display_name: string;
        username: string;
        points: string;
        played: string;
        wins: string;
        rank: string;
      }>(
        `WITH totals AS (SELECT c.principal_id,sum(c.points)::bigint points,sum(c.played)::bigint played,sum(c.wins)::bigint wins
            FROM next_round.career_contributions c JOIN next_round.principals eligible ON eligible.id=c.principal_id AND eligible.disabled_at IS NULL
            WHERE c.module_id=$1 AND c.visibility='instance' GROUP BY c.principal_id),
          ranked AS (SELECT t.*,dense_rank() OVER(ORDER BY points DESC)::bigint rank FROM totals t)
         SELECT r.principal_id,p.display_name,a.username,r.points::text,r.played::text,r.wins::text,r.rank::text FROM ranked r JOIN next_round.principals p ON p.id=r.principal_id JOIN next_round.accounts a ON a.principal_id=p.id
         WHERE ($2::bigint IS NULL OR (r.points<$2 OR (r.points=$2 AND (a.username,r.principal_id::text)>($3,$4)))) ORDER BY r.points DESC,a.username,r.principal_id LIMIT $5`,
        [gameId, afterPoints, afterUsername, afterId, size + 1],
      );
      const rows = result.rows.slice(0, size);
      const safeInteger = (value: string) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number))
          throw new ApiError(
            ERROR_CODES.INTERNAL_ERROR,
            "Leaderboard is unavailable.",
          );
        return number;
      };
      const data = rows.map((r) => {
        const points = safeInteger(r.points),
          played = safeInteger(r.played),
          wins = safeInteger(r.wins);
        return {
          rank: safeInteger(r.rank),
          principalId: r.principal_id,
          displayName: r.display_name,
          username: r.username,
          points,
          gamesPlayed: played,
          wins,
          averagePointsPerGame: played === 0 ? null : points / played,
        };
      });
      await client.query("COMMIT");
      return {
        data,
        nextCursor:
          result.rows.length > size
            ? Buffer.from(
                JSON.stringify({
                  p: rows[rows.length - 1]!.points,
                  u: rows[rows.length - 1]!.username,
                  id: rows[rows.length - 1]!.principal_id,
                }),
              ).toString("base64url")
            : null,
        serverNow: now(),
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

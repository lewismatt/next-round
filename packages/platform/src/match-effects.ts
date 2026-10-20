// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { ApiError, ERROR_CODES, type Deadline, type Json, type Member } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { Transition } from "@next-round/game-sdk";

type Transaction = Pick<DatabasePool, "query">;
export interface StoredDeadline extends Deadline { eventId: string; status: string }

function moduleFailure(): ApiError {
  return new ApiError(ERROR_CODES.MODULE_FAILURE, "The game module could not process this match.");
}

export async function readDeadlines(
  client: Transaction, matchId: string, desired: readonly Deadline[] = [],
): Promise<StoredDeadline[]> {
  const result = await client.query<StoredDeadline>(
    `SELECT key, generation::float8 AS generation,
            to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dueAt",
            event_id AS "eventId", status
       FROM next_round.match_deadlines d
      WHERE match_id = $1 AND (status = 'pending' OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS wanted(key text, generation bigint)
         WHERE wanted.key = d.key AND wanted.generation = d.generation
      )) ORDER BY due_at, key`,
    [matchId, JSON.stringify(desired.map(({ key, generation }) => ({ key, generation })))],
  );
  return result.rows;
}

async function outbox(client: Transaction, topic: string, aggregateId: string, revision: number,
  dedupeKey: string, payload: Json): Promise<void> {
  await client.query(
    `INSERT INTO next_round.outbox (topic, aggregate_id, aggregate_revision, dedupe_key, safe_payload)
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (dedupe_key) DO NOTHING`,
    [topic, aggregateId, revision, dedupeKey, JSON.stringify(payload)],
  );
}

/** Validate the complete desired set before any pending identity changes status. */
export async function validateDeadlines(
  client: Transaction, matchId: string, desired: Deadline[], fired?: StoredDeadline,
): Promise<StoredDeadline[]> {
  const keys = new Set<string>();
  for (const deadline of desired) {
    if (!deadline || typeof deadline.key !== "string" || !deadline.key.length ||
        keys.has(deadline.key) || !Number.isSafeInteger(deadline.generation) || deadline.generation < 0 ||
        typeof deadline.dueAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deadline.dueAt) ||
        !Number.isFinite(Date.parse(deadline.dueAt)) ||
        new Date(deadline.dueAt).toISOString() !== deadline.dueAt) throw moduleFailure();
    keys.add(deadline.key);
    if (fired && fired.key === deadline.key && fired.generation === deadline.generation) throw moduleFailure();
  }
  // Read only pending rows and emitted identities, not the match's entire turn history.
  const stored = await readDeadlines(client, matchId, desired);
  for (const deadline of desired) {
    const prior = stored.find((row) => row.key === deadline.key && row.generation === deadline.generation);
    if (prior && prior.status !== "pending") throw moduleFailure();
  }
  return stored;
}

/** Called only while all affected principals and the match are locked, in the state transaction. */
export async function persistMatchEffects(
  client: Transaction,
  matchId: string,
  revision: number,
  eventId: string,
  now: string,
  members: readonly Member[],
  transition: Transition<Json>,
  stored: StoredDeadline[],
  fired?: StoredDeadline,
): Promise<void> {
  const changedInboxes = new Set<string>();
  async function notification(principalId: string, kind: string, dedupeKey: string, payload: Json): Promise<void> {
    const result = await client.query(
      `INSERT INTO next_round.notifications (principal_id, match_id, kind, dedupe_key, safe_payload)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (principal_id, dedupe_key) DO NOTHING
       RETURNING principal_id`,
      [principalId, matchId, kind, dedupeKey, JSON.stringify(payload)],
    );
    if (result.rowCount) changedInboxes.add(principalId);
  }
  const pending: StoredDeadline[] = [];
  const added: StoredDeadline[] = [];
  for (const prior of stored) {
    if (prior.status !== "pending") continue;
    const consumed = fired?.eventId === prior.eventId;
    const retained = !consumed && transition.deadlines.some((d) => d.key === prior.key && d.generation === prior.generation);
    if (retained) { pending.push(prior); continue; }
    await client.query(
      `UPDATE next_round.match_deadlines SET status = $4
        WHERE match_id = $1 AND key = $2 AND generation = $3 AND status = 'pending'`,
      [matchId, prior.key, prior.generation, consumed ? "consumed" : "cancelled"],
    );
    // Include already-read obligations in timeout attribution, but supersede unread only.
    const obligations = await client.query<{ principal_id: string }>(
      `SELECT principal_id FROM next_round.notifications
        WHERE match_id = $1 AND kind = 'action_required' AND safe_payload->>'eventId' = $2
          AND superseded_at IS NULL`,
      [matchId, prior.eventId],
    );
    const superseded = await client.query<{ principal_id: string }>(
      `UPDATE next_round.notifications SET superseded_at = $3::timestamptz
        WHERE match_id = $1 AND kind = 'action_required' AND safe_payload->>'eventId' = $2
          AND read_at IS NULL AND superseded_at IS NULL RETURNING principal_id`,
      [matchId, prior.eventId, now],
    );
    for (const row of superseded.rows) changedInboxes.add(row.principal_id);
    if (consumed) {
      for (const row of obligations.rows) {
        await notification(row.principal_id, "turn_missed", `missed:${prior.eventId}`,
          { matchId, eventId: prior.eventId });
      }
    }
  }
  for (const desired of transition.deadlines) {
    if (pending.some((row) => row.key === desired.key && row.generation === desired.generation)) continue;
    const deadline = { ...desired, eventId: randomUUID(), status: "pending" };
    pending.push(deadline);
    added.push(deadline);
    await client.query(
      `INSERT INTO next_round.match_deadlines (match_id, key, generation, due_at, status, event_id)
       VALUES ($1, $2, $3, $4::timestamptz, 'pending', $5)`,
      [matchId, deadline.key, deadline.generation, deadline.dueAt, deadline.eventId],
    );
    await outbox(client, "deadline.schedule", matchId, revision, `deadline:${deadline.eventId}`,
      { matchId, key: deadline.key, generation: deadline.generation, dueAt: deadline.dueAt, eventId: deadline.eventId });
  }
  const active = members.filter((member) => member.status === "active" && !member.disabled &&
    transition.needsActionFrom.includes(member.id));
  // End obligations for members who no longer need action (including untimed turns).
  const superseded = await client.query<{ principal_id: string }>(
    `UPDATE next_round.notifications SET superseded_at = $3::timestamptz
      WHERE match_id = $1 AND kind = 'action_required' AND read_at IS NULL AND superseded_at IS NULL
        AND NOT (safe_payload->>'memberId' = ANY($2::text[])) RETURNING principal_id`,
    [matchId, active.map((member) => member.id), now],
  );
  for (const row of superseded.rows) changedInboxes.add(row.principal_id);
  for (const member of active) {
    if (pending.length) {
      for (const deadline of added) {
        await notification(member.principalId, "action_required", `action:${deadline.eventId}:${member.id}`,
          { matchId, memberId: member.id, eventId: deadline.eventId });
      }
    } else {
      const prior = await client.query(
        `SELECT 1 FROM next_round.notifications WHERE match_id = $1 AND principal_id = $2
          AND kind = 'action_required' AND superseded_at IS NULL AND NOT (safe_payload ? 'eventId')`,
        [matchId, member.principalId],
      );
      if (!prior.rowCount) await notification(member.principalId, "action_required", `action:${eventId}:${member.id}`,
        { matchId, memberId: member.id });
    }
  }
  if (transition.phase === "finished") {
    for (const member of members) await notification(member.principalId, "result", `result:${matchId}`,
      { matchId, revision });
  }
  for (const principalId of changedInboxes) {
    const result = await client.query<{ revision: number }>(
      `UPDATE next_round.principals SET inbox_revision = inbox_revision + 1 WHERE id = $1
       RETURNING inbox_revision::float8 AS revision`, [principalId],
    );
    await outbox(client, "live.invalidate", principalId, result.rows[0].revision,
      `inbox:${principalId}:${result.rows[0].revision}`,
      { scope: { kind: "notifications", principalId }, revision: result.rows[0].revision });
  }
  for (const member of members) {
    const result = await client.query<{ revision: number }>(
      `UPDATE next_round.principals SET home_revision = home_revision + 1 WHERE id = $1
       RETURNING home_revision::float8 AS revision`, [member.principalId],
    );
    await outbox(client, "live.invalidate", member.principalId, result.rows[0].revision,
      `home:${member.principalId}:${result.rows[0].revision}`,
      { scope: { kind: "home", principalId: member.principalId }, revision: result.rows[0].revision });
  }
  await outbox(client, "live.invalidate", matchId, revision, `match:${matchId}:${revision}`,
    { scope: { kind: "match", id: matchId }, revision });
}

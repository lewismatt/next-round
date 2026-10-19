// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ApiError,
  ERROR_CODES,
  parseJsonSchemaValue,
  type CommandReceipt,
  type FinalResult,
  type Json,
  type Member,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { RuleContext } from "@next-round/game-sdk";
import type { GameRegistry, RegisteredGameVersion } from "./registry.js";

type MatchPhase = "lobby" | "active" | "finished";

interface MatchRow {
  id: string;
  module_id: string;
  module_version: string;
  mode: string;
  phase: MatchPhase;
  revision: number;
  state: Json | null;
  settings: Json;
  host_member_id: string | null;
  viewer_member_id: string;
  members: Member[];
  deadlines: Array<{ key: string; generation: number; dueAt: string }>;
}

interface ResultRow {
  id: string;
  module_id: string;
  module_version: string;
  mode: string;
  revision: number;
  settings: Json;
  host_member_id: string | null;
  raw_result: FinalResult;
  members: Member[];
}

interface ActionMatchRow {
  id: string;
  module_id: string;
  module_version: string;
  state_version: number;
  mode: string;
  phase: MatchPhase;
  revision: number;
  state: Json | null;
  settings: Json;
  host_member_id: string | null;
  viewer_member_id: string;
}

export interface MatchActionInput {
  commandId: string;
  expectedRevision: number;
  type: string;
  payload: Json;
}

export interface MatchSnapshot {
  id: string;
  moduleId: string;
  moduleVersion: string;
  revision: number;
  phase: MatchPhase;
  mode: string;
  settings: Json;
  hostMemberId: string | null;
  members: Member[];
  deadlines: Array<{ key: string; generation: number; dueAt: string }>;
  serverNow: string;
  capabilities: {
    canStart: boolean;
    canLeave: boolean;
    canInvite: boolean;
    canFinish: boolean;
    canChat: boolean;
    canAct: boolean;
  };
  game: Json;
}

function notFound(): ApiError {
  return new ApiError(ERROR_CODES.NOT_FOUND, "Match was not found.");
}

function moduleUnavailable(): ApiError {
  return new ApiError(ERROR_CODES.MODULE_UNAVAILABLE, "Game module is not available.");
}

function moduleFailure(): ApiError {
  return new ApiError(ERROR_CODES.MODULE_FAILURE, "The game module could not process this match.");
}

const MATCH_ACTION_SCOPE = "match.action";
const MATCH_ACTION_ROUTE = "POST /api/v1/matches/:id/actions";

interface CommandReceiptRow {
  request_hash: Buffer | Uint8Array | string;
  match_id: string | null;
  committed_revision: number | null;
  safe_receipt: Json;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/** Route, normalized command fields, and expectedRevision. Never log this string. */
function hashMatchAction(matchId: string, input: MatchActionInput): Buffer {
  return createHash("sha256").update(canonicalJson({
    route: MATCH_ACTION_ROUTE,
    matchId: matchId.toLowerCase(),
    commandId: input.commandId.toLowerCase(),
    expectedRevision: input.expectedRevision,
    type: input.type,
    payload: input.payload,
  })).digest();
}

function sameRequestHash(expected: Buffer, stored: Buffer | Uint8Array | string): boolean {
  const actual = typeof stored === "string"
    ? Buffer.from(stored.startsWith("\\x") ? stored.slice(2) : stored, "hex")
    : Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function registeredVersion(
  registry: GameRegistry,
  moduleId: string,
  moduleVersion: string,
): RegisteredGameVersion & { server: NonNullable<RegisteredGameVersion["server"]> } {
  const registered = registry.getVersion(moduleId, moduleVersion);
  if (!registered?.server) throw moduleUnavailable();
  return registered as RegisteredGameVersion & {
    server: NonNullable<RegisteredGameVersion["server"]>;
  };
}

function context(
  match: {
    id: string;
    module_version: string;
    mode: string;
    phase: MatchPhase;
    revision: number;
    settings: Json;
    host_member_id: string | null;
  },
  members: readonly Member[],
  now: string,
  eventId: string,
  actor: { principalId: string; memberId: string } | null,
): RuleContext {
  return {
    matchId: match.id,
    moduleVersion: match.module_version,
    mode: match.mode,
    phase: match.phase,
    revision: match.revision,
    now,
    eventId,
    actor,
    members,
    hostMemberId: match.host_member_id,
    settings: match.settings,
    resource: null,
    facts: [],
  };
}

const MEMBERS_JSON_SQL = `
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', mm.id,
        'principalId', mm.principal_id,
        'kind', p.kind,
        'displayName', p.display_name,
        'status', mm.status,
        'joinOrdinal', mm.join_ordinal::integer,
        'disabled', p.disabled_at IS NOT NULL,
        'accessEpoch', mm.access_epoch::integer
      ) ORDER BY mm.join_ordinal
    ),
    '[]'::jsonb
  )
    FROM next_round.match_members mm
    JOIN next_round.principals p ON p.id = mm.principal_id
   WHERE mm.match_id = m.id`;

export class MatchService {
  constructor(
    private readonly pool: DatabasePool,
    private readonly registry: GameRegistry,
  ) {}

  async getSnapshot(matchId: string, principalId: string): Promise<MatchSnapshot> {
    const result = await this.pool.query<MatchRow>(
      `SELECT m.id, m.module_id, m.module_version, m.mode, m.phase,
              m.revision::integer AS revision, m.state, m.settings, m.host_member_id,
              viewer.id AS viewer_member_id,
              (${MEMBERS_JSON_SQL}) AS members,
              COALESCE(
                (SELECT jsonb_agg(
                   jsonb_build_object(
                     'key', d.key,
                     'generation', d.generation::integer,
                     'dueAt', d.due_at
                   ) ORDER BY d.due_at, d.key, d.generation
                 )
                   FROM next_round.match_deadlines d
                  WHERE d.match_id = m.id AND d.status = 'pending'),
                '[]'::jsonb
              ) AS deadlines
         FROM next_round.matches m
         JOIN next_round.match_members viewer
           ON viewer.match_id = m.id
          AND viewer.principal_id = $2
          AND viewer.status = 'active'
        WHERE m.id = $1`,
      [matchId, principalId],
    );
    const match = result.rows[0];
    if (!match) throw notFound();
    if (match.state === null) throw moduleUnavailable();

    const registered = registeredVersion(this.registry, match.module_id, match.module_version);
    const serverNow = new Date().toISOString();
    const ctx = context(match, match.members, serverNow, randomUUID(), null);

    let game: Json;
    let authority;
    try {
      game = parseJsonSchemaValue(
        registered.manifest.viewSchema,
        registered.server.view(ctx, match.state, {
          principalId,
          memberId: match.viewer_member_id,
          access: "active",
        }),
      );
      authority = registered.server.authority(ctx, match.state, match.viewer_member_id);
    } catch {
      throw moduleFailure();
    }

    return {
      id: match.id,
      moduleId: match.module_id,
      moduleVersion: match.module_version,
      revision: match.revision,
      phase: match.phase,
      mode: match.mode,
      settings: match.settings,
      hostMemberId: match.host_member_id,
      members: match.members,
      deadlines: match.deadlines,
      serverNow,
      capabilities: {
        canStart: authority.canStart,
        canLeave: true,
        canInvite: false,
        canFinish: authority.canFinish,
        canChat: true,
        canAct: match.phase === "active",
      },
      game,
    };
  }

  async getResult(matchId: string, principalId: string): Promise<Json> {
    const result = await this.pool.query<ResultRow>(
      `SELECT m.id, m.module_id, m.module_version, m.mode,
              m.revision::integer AS revision, m.settings, m.host_member_id,
              r.raw_result,
              (${MEMBERS_JSON_SQL}) AS members
         FROM next_round.matches m
         JOIN next_round.match_results r ON r.match_id = m.id
         JOIN next_round.match_members viewer
           ON viewer.match_id = m.id
          AND viewer.principal_id = $2
        WHERE m.id = $1 AND m.phase = 'finished'`,
      [matchId, principalId],
    );
    const match = result.rows[0];
    if (!match) throw notFound();

    const registered = registeredVersion(this.registry, match.module_id, match.module_version);
    try {
      return registered.server.resultView(
        context(
          { ...match, phase: "finished" },
          match.members,
          new Date().toISOString(),
          randomUUID(),
          null,
        ),
        match.raw_result,
        principalId,
      );
    } catch {
      throw moduleFailure();
    }
  }

  async act(
    matchId: string,
    principalId: string,
    input: MatchActionInput,
  ): Promise<CommandReceipt> {
    // PostgreSQL UUIDs are case-insensitive and returned in lowercase. Use the
    // same representation for receipt comparisons and response identities.
    matchId = matchId.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const matchResult = await client.query<ActionMatchRow>(
        `SELECT m.id, m.module_id, m.module_version, m.state_version, m.mode, m.phase,
                m.revision::integer AS revision, m.state, m.settings, m.host_member_id,
                viewer.id AS viewer_member_id
           FROM next_round.matches m
           JOIN next_round.match_members viewer
             ON viewer.match_id = m.id
            AND viewer.principal_id = $2
            AND viewer.status = 'active'
          WHERE m.id = $1
          FOR UPDATE OF m, viewer`,
        [matchId, principalId],
      );
      const match = matchResult.rows[0];
      if (!match) throw notFound();
      // An identical retry is already stale against the revision this command committed.
      const requestHash = hashMatchAction(matchId, input);
      const existingReceipt = await client.query<CommandReceiptRow>(
        `SELECT request_hash, match_id, committed_revision::integer AS committed_revision,
                safe_receipt
           FROM next_round.command_receipts
          WHERE principal_id = $1 AND scope = $2 AND command_id = $3`,
        [principalId, MATCH_ACTION_SCOPE, input.commandId],
      );
      const prior = existingReceipt.rows[0];
      if (prior) {
        const committedRevision = prior.committed_revision;
        if (
          prior.match_id !== matchId ||
          committedRevision === null ||
          !sameRequestHash(requestHash, prior.request_hash)
        ) {
          throw new ApiError(
            ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "This command was already used with a different request.",
          );
        }
        await client.query("COMMIT");
        const stored = prior.safe_receipt;
        const commandId = stored && typeof stored === "object" && !Array.isArray(stored) &&
          typeof stored.commandId === "string"
          ? stored.commandId
          : input.commandId;
        return {
          commandId,
          matchId,
          committedRevision,
          replayed: true,
          outcome: "accepted",
        };
      }
      if (match.phase === "finished") {
        throw new ApiError(ERROR_CODES.MATCH_CLOSED, "Match is closed.");
      }
      if (match.revision !== input.expectedRevision) {
        throw new ApiError(ERROR_CODES.STALE_REVISION, "Refresh this match before acting.", {
          details: { currentRevision: match.revision },
        });
      }
      if (match.state === null) throw moduleUnavailable();

      const registered = registeredVersion(this.registry, match.module_id, match.module_version);
      const actionSchema = registered.manifest.actionSchemas[input.type];
      if (!actionSchema) {
        throw new ApiError(
          ERROR_CODES.INVALID_REQUEST,
          "Action type is not defined by the game module.",
          { details: { fields: ["/type"] } },
        );
      }
      const payload = parseJsonSchemaValue(actionSchema, input.payload);

      const membersResult = await client.query<Member>(
        `SELECT mm.id, mm.principal_id AS "principalId", p.kind,
                p.display_name AS "displayName", mm.status,
                mm.join_ordinal::integer AS "joinOrdinal",
                (p.disabled_at IS NOT NULL) AS disabled,
                mm.access_epoch::integer AS "accessEpoch"
           FROM next_round.match_members mm
           JOIN next_round.principals p ON p.id = mm.principal_id
          WHERE mm.match_id = $1
          ORDER BY mm.join_ordinal`,
        [matchId],
      );
      const members = membersResult.rows;
      const now = new Date().toISOString();
      const eventId = randomUUID();
      const ctx = context(match, members, now, eventId, {
        principalId,
        memberId: match.viewer_member_id,
      });

      let transition;
      try {
        transition = registered.server.transition(ctx, match.state, {
          kind: "action",
          type: input.type,
          payload,
        });
      } catch {
        throw moduleFailure();
      }
      if (!transition.ok) {
        throw new ApiError(
          ERROR_CODES.RULE_REJECTED,
          "The game did not accept this action.",
          { details: { ruleCode: `${match.module_id}/RULE_REJECTED` } },
        );
      }

      let state: Json;
      try {
        state = parseJsonSchemaValue(registered.manifest.stateSchema, transition.value.state);
      } catch {
        throw moduleFailure();
      }

      const committedRevision = match.revision + 1;
      await client.query(
        `UPDATE next_round.matches
            SET state = $2::jsonb,
                phase = $3,
                host_member_id = $4,
                revision = $5,
                needs_action_from = $6::uuid[],
                started_at = CASE
                  WHEN $3 = 'active' THEN COALESCE(started_at, $7::timestamptz)
                  ELSE started_at
                END,
                finished_at = CASE
                  WHEN $3 = 'finished' THEN $7::timestamptz
                  ELSE finished_at
                END,
                updated_at = $7::timestamptz
          WHERE id = $1`,
        [
          matchId,
          JSON.stringify(state),
          transition.value.phase,
          transition.value.hostMemberId,
          committedRevision,
          transition.value.needsActionFrom,
          now,
        ],
      );
      await client.query(
        `INSERT INTO next_round.match_events
           (match_id, revision, event_id, actor_id, kind, safe_metadata)
         VALUES ($1, $2, $3, $4, 'action', $5::jsonb)`,
        [matchId, committedRevision, eventId, principalId, JSON.stringify({ type: input.type })],
      );

      const desiredDeadlines = transition.value.deadlines.map((deadline) => ({
        key: deadline.key,
        generation: deadline.generation,
      }));
      await client.query(
        `UPDATE next_round.match_deadlines d
            SET status = 'cancelled'
          WHERE d.match_id = $1
            AND d.status = 'pending'
            AND NOT EXISTS (
              SELECT 1
                FROM jsonb_to_recordset($2::jsonb) AS wanted(key text, generation bigint)
               WHERE wanted.key = d.key AND wanted.generation = d.generation
            )`,
        [matchId, JSON.stringify(desiredDeadlines)],
      );
      for (const deadline of transition.value.deadlines) {
        await client.query(
          `INSERT INTO next_round.match_deadlines
             (match_id, key, generation, due_at, status, event_id)
           VALUES ($1, $2, $3, $4, 'pending', $5)
           ON CONFLICT (match_id, key, generation) DO NOTHING`,
          [matchId, deadline.key, deadline.generation, deadline.dueAt, randomUUID()],
        );
      }

      if (transition.value.final) {
        const eligibilityReasons = [
          ...new Set(
            transition.value.final.participants.flatMap(
              (participant) => participant.exclusionReasons,
            ),
          ),
        ];
        await client.query(
          `INSERT INTO next_round.match_results
             (match_id, module_id, module_version, result_version, outcome, raw_result,
              eligibility_reasons, finished_revision, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz)`,
          [
            matchId,
            match.module_id,
            match.module_version,
            registered.manifest.resultVersion,
            transition.value.final.outcome,
            JSON.stringify(transition.value.final),
            JSON.stringify(eligibilityReasons),
            committedRevision,
            now,
          ],
        );
      }

      const receipt: CommandReceipt = {
        commandId: input.commandId,
        matchId,
        committedRevision,
        replayed: false,
        outcome: "accepted",
      };
      await client.query(
        `INSERT INTO next_round.command_receipts
           (principal_id, scope, command_id, request_hash, match_id,
            committed_revision, safe_receipt)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          principalId,
          MATCH_ACTION_SCOPE,
          input.commandId,
          requestHash,
          matchId,
          committedRevision,
          JSON.stringify(receipt),
        ],
      );
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ApiError,
  ERROR_CODES,
  parseJsonSchemaValue,
  type CommandReceipt,
  type CreateMatchRequest,
  type CreateMatchResponse,
  type FinalResult,
  type Json,
  type MatchLifecycleCommand,
  type Member,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { GameEvent, RuleContext, Transition } from "@next-round/game-sdk";
import type { GameRegistry, RegisteredGameVersion } from "./registry.js";
import type { AuthenticatedSession } from "./auth-service.js";
import { lockPrincipals, recheckSession } from "./transaction-authority.js";
import { prepareFinalResult, persistFinalResult } from "./final-results.js";
import { persistMatchEffects, readDeadlines, validateDeadlines, type StoredDeadline } from "./match-effects.js";

type MatchPhase = "lobby" | "active" | "finished";

interface ServerGameVersion extends RegisteredGameVersion {
  server: NonNullable<RegisteredGameVersion["server"]>;
}

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

interface LifecycleMatchRow extends Omit<ActionMatchRow, "viewer_member_id"> {
  visibility: "invite" | "instance" | "private";
}

export interface MatchActionInput {
  commandId: string;
  expectedRevision: number;
  type: string;
  payload: Json;
}

export interface DeadlineInput {
  matchId: string;
  key: string;
  generation: number;
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
const MATCH_CREATE_SCOPE = "match.create";
const MATCH_LIFECYCLE_SCOPE = "match.lifecycle";
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

type LifecycleKind = "join" | "start" | "leave";

function hashLifecycleCommand(
  kind: LifecycleKind,
  matchId: string,
  input: MatchLifecycleCommand,
): Buffer {
  return createHash("sha256").update(canonicalJson({
    route: `POST /api/v1/matches/:id/${kind}`,
    matchId: matchId.toLowerCase(),
    commandId: input.commandId.toLowerCase(),
    expectedRevision: input.expectedRevision,
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
): ServerGameVersion {
  const registered = registry.getVersion(moduleId, moduleVersion);
  if (!registered?.server) throw moduleUnavailable();
  return registered as ServerGameVersion;
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

  async create(
    session: AuthenticatedSession,
    input: CreateMatchRequest,
  ): Promise<CreateMatchResponse> {
    if (session.principal.kind !== "registered") {
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Registered accounts are required to create matches.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPrincipals(client, [session.principal.id]);
      await recheckSession(client, session, { registered: true });
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${session.principal.id}:${MATCH_CREATE_SCOPE}:${input.commandId.toLowerCase()}`,
      ]);
      const requestHash = createHash("sha256").update(canonicalJson({
        route: "POST /api/v1/matches",
        commandId: input.commandId.toLowerCase(),
        moduleId: input.moduleId,
        mode: input.mode,
        settings: input.settings as Json,
        resourceId: input.resourceId ?? null,
        visibility: input.visibility,
      })).digest();
      const prior = await client.query<CommandReceiptRow>(
        `SELECT request_hash, match_id, committed_revision::integer AS committed_revision, safe_receipt
           FROM next_round.command_receipts
          WHERE principal_id = $1 AND scope = $2 AND command_id = $3`,
        [session.principal.id, MATCH_CREATE_SCOPE, input.commandId],
      );
      if (prior.rows[0]) {
        if (!sameRequestHash(requestHash, prior.rows[0].request_hash) || !prior.rows[0].match_id) {
          throw new ApiError(ERROR_CODES.IDEMPOTENCY_CONFLICT, "This command was already used with a different request.");
        }
        const stored = prior.rows[0].safe_receipt;
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw moduleFailure();
        await client.query("COMMIT");
        return stored as unknown as CreateMatchResponse;
      }

      const moduleResult = await client.query<{ version: string; state_version: number }>(
        `SELECT mv.version, mv.state_version
           FROM next_round.modules m
           JOIN next_round.module_versions mv
             ON mv.module_id = m.id AND mv.version = m.default_version
          WHERE m.id = $1 AND m.enabled = true
          FOR SHARE OF m, mv`,
        [input.moduleId],
      );
      const module = moduleResult.rows[0];
      const registered = module && registeredVersion(this.registry, input.moduleId, module.version);
      if (!registered) throw moduleUnavailable();
      if (input.resourceId) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "This game does not support resource-based matches.");
      }
      const mode = registered.manifest.modes.find((candidate) => candidate.id === input.mode);
      if (!mode) throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Match mode is not supported.");
      const settings = parseJsonSchemaValue(registered.manifest.settingsSchema, input.settings);
      const policyResult = await client.query<{ current_policy_version: number; policy: Json }>(
        `SELECT s.current_policy_version::integer, p.policy
           FROM next_round.instance_singleton s
           JOIN next_round.instance_policy p ON p.version = s.current_policy_version
          WHERE s.id = true`,
      );
      const currentPolicy = policyResult.rows[0];
      if (!currentPolicy) throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, "Instance setup is incomplete.");

      const matchId = randomUUID();
      const memberId = randomUUID();
      const eventId = randomUUID();
      const now = await this.databaseNow(client);
      const members: Member[] = [{
        id: memberId,
        principalId: session.principal.id,
        kind: "registered",
        displayName: session.principal.displayName,
        status: "active",
        joinOrdinal: 1,
        disabled: false,
        accessEpoch: 0,
      }];
      const matchContext = context({
        id: matchId,
        module_version: module.version,
        mode: input.mode,
        phase: "lobby",
        revision: 0,
        settings,
        host_member_id: memberId,
      }, members, now, eventId, { principalId: session.principal.id, memberId });
      let transition;
      try {
        transition = registered.server.transition(matchContext, null, { kind: "create" });
      } catch {
        throw moduleFailure();
      }
      if (!transition.ok) throw new ApiError(ERROR_CODES.RULE_REJECTED, "The game did not accept this match.");
      if (transition.value.phase !== "lobby" || transition.value.final !== null || transition.value.hostMemberId !== memberId) {
        throw moduleFailure();
      }
      let state: Json;
      try {
        state = parseJsonSchemaValue(registered.manifest.stateSchema, transition.value.state);
      } catch {
        throw moduleFailure();
      }
      const visibility = mode.maxPlayers === 1 ? "private" : input.visibility;
      await client.query(
        `INSERT INTO next_round.matches
           (id, module_id, module_version, state_version, mode, phase, creator_id,
            host_member_id, settings, visibility, policy_version, policy_snapshot,
            revision, state, needs_action_from)
         VALUES ($1, $2, $3, $4, $5, 'lobby', $6, NULL, $7::jsonb, $8, $9,
                 $10::jsonb, 0, $11::jsonb, $12::uuid[])`,
        [matchId, input.moduleId, module.version, module.state_version, input.mode,
          session.principal.id, JSON.stringify(settings), visibility,
          currentPolicy.current_policy_version, JSON.stringify(currentPolicy.policy),
          JSON.stringify(state), transition.value.needsActionFrom],
      );
      await client.query(
        `INSERT INTO next_round.match_members (id, match_id, principal_id, join_ordinal)
         VALUES ($1, $2, $3, 1)`,
        [memberId, matchId, session.principal.id],
      );
      await client.query("UPDATE next_round.matches SET host_member_id = $2 WHERE id = $1", [matchId, memberId]);
      await client.query(
        `INSERT INTO next_round.member_periods (member_id, access_epoch)
         VALUES ($1, 0)`,
        [memberId],
      );
      await client.query(
        `INSERT INTO next_round.match_events (match_id, revision, event_id, actor_id, kind, safe_metadata)
         VALUES ($1, 0, $2, $3, 'create', '{}'::jsonb)`,
        [matchId, eventId, session.principal.id],
      );
      await this.persistTransition(client, {
        id: matchId, module_id: input.moduleId, module_version: module.version,
        state_version: module.state_version, mode: input.mode, phase: "lobby",
        revision: -1, state: null, settings, host_member_id: memberId,
      }, members, registered, transition.value, { kind: "create" }, eventId, now,
      session.principal.id, true);
      const receipt: CreateMatchResponse = { matchId, revision: 0, commandId: input.commandId };
      await client.query(
        `INSERT INTO next_round.command_receipts
           (principal_id, scope, command_id, request_hash, match_id, committed_revision, safe_receipt)
         VALUES ($1, $2, $3, $4, $5, 0, $6::jsonb)`,
        [session.principal.id, MATCH_CREATE_SCOPE, input.commandId, requestHash, matchId, JSON.stringify(receipt)],
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

  join(
    matchId: string,
    session: AuthenticatedSession,
    input: MatchLifecycleCommand,
  ): Promise<CommandReceipt> {
    return this.runLifecycleCommand("join", matchId, session, input);
  }

  start(
    matchId: string,
    session: AuthenticatedSession,
    input: MatchLifecycleCommand,
  ): Promise<CommandReceipt> {
    return this.runLifecycleCommand("start", matchId, session, input);
  }

  leave(
    matchId: string,
    session: AuthenticatedSession,
    input: MatchLifecycleCommand,
  ): Promise<CommandReceipt> {
    return this.runLifecycleCommand("leave", matchId, session, input);
  }

  private async runLifecycleCommand(
    kind: LifecycleKind,
    matchId: string,
    session: AuthenticatedSession,
    input: MatchLifecycleCommand,
  ): Promise<CommandReceipt> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runLifecycleCommandOnce(kind, matchId, session, input);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "40001" && code !== "40P01") throw error;
        if (attempt === 2) {
          throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, "Please retry this command.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 30));
      }
    }
  }

  private async runLifecycleCommandOnce(
    kind: LifecycleKind,
    matchId: string,
    session: AuthenticatedSession,
    input: MatchLifecycleCommand,
  ): Promise<CommandReceipt> {
    matchId = matchId.toLowerCase();
    const principalId = session.principal.id.toLowerCase();
    const client = await this.pool.connect();
    let committedTimeouts = false;
    try {
      await client.query("BEGIN");
      const discovered = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.match_members WHERE match_id = $1",
        [matchId],
      );
      const lockedPrincipalIds = new Set([
        principalId,
        ...discovered.rows.map((row) => row.principal_id.toLowerCase()),
      ]);
      await lockPrincipals(client, [...lockedPrincipalIds]);
      const currentSession = await recheckSession(client, session, { matchId });
      const matchResult = await client.query<LifecycleMatchRow>(
        `SELECT id, module_id, module_version, state_version, mode, phase,
                revision::integer AS revision, state, settings, host_member_id, visibility
           FROM next_round.matches
          WHERE id = $1
          FOR UPDATE`,
        [matchId],
      );
      const match = matchResult.rows[0];
      if (!match) throw notFound();

      const membersResult = await client.query<Member>(
        `SELECT mm.id, mm.principal_id AS "principalId", p.kind,
                p.display_name AS "displayName", mm.status,
                mm.join_ordinal::integer AS "joinOrdinal",
                (p.disabled_at IS NOT NULL) AS disabled,
                mm.access_epoch::integer AS "accessEpoch"
           FROM next_round.match_members mm
           JOIN next_round.principals p ON p.id = mm.principal_id
          WHERE mm.match_id = $1
          ORDER BY mm.join_ordinal
          FOR UPDATE OF mm, p`,
        [matchId],
      );
      const persistedMembers = membersResult.rows;
      if (persistedMembers.some((member) => !lockedPrincipalIds.has(member.principalId.toLowerCase()))) {
        // A join committed after principal discovery. Retry with its principal
        // included so lifecycle hooks never run without holding every member lock.
        throw Object.assign(new Error("Retry membership discovery"), { code: "40001" });
      }

      const requestHash = hashLifecycleCommand(kind, matchId, input);
      const receiptResult = await client.query<CommandReceiptRow>(
        `SELECT request_hash, match_id, committed_revision::integer AS committed_revision,
                safe_receipt
           FROM next_round.command_receipts
          WHERE principal_id = $1 AND scope = $2 AND command_id = $3`,
        [principalId, MATCH_LIFECYCLE_SCOPE, input.commandId],
      );
      const prior = receiptResult.rows[0];
      if (prior) {
        if (
          prior.match_id !== matchId ||
          prior.committed_revision === null ||
          !sameRequestHash(requestHash, prior.request_hash)
        ) {
          throw new ApiError(
            ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "This command was already used with a different request.",
          );
        }
        const stored = prior.safe_receipt;
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw moduleFailure();
        const commandId = typeof stored.commandId === "string" ? stored.commandId : input.commandId;
        await client.query("COMMIT");
        return {
          commandId,
          matchId,
          committedRevision: prior.committed_revision,
          replayed: true,
          outcome: "accepted",
        };
      }

      const caller = persistedMembers.find((member) => member.principalId.toLowerCase() === principalId);
      if (kind !== "join" && caller?.status !== "active") throw notFound();
      if (kind === "join" && (caller?.status === "removed" ||
          (!caller && (currentSession.kind !== "registered" || match.visibility !== "instance")))) throw notFound();
      // Revision conflict takes precedence over closed state on every command path.
      if (match.revision !== input.expectedRevision) {
        throw new ApiError(ERROR_CODES.STALE_REVISION, "Refresh this match before continuing.", {
          details: { currentRevision: match.revision },
        });
      }
      if (match.phase === "finished") {
        throw new ApiError(ERROR_CODES.MATCH_CLOSED, "Match is closed.");
      }
      const now = await this.databaseNow(client);
      if (await this.reconcileDue(client, match, persistedMembers, now)) {
        await client.query("COMMIT");
        committedTimeouts = true;
        throw new ApiError(ERROR_CODES.STALE_REVISION, "Refresh this match before continuing.", {
          details: { currentRevision: match.revision },
        });
      }
      if (match.state === null) throw moduleUnavailable();
      if (currentSession.kind !== "registered" && currentSession.kind !== "guest") throw moduleFailure();

      const registered = registeredVersion(this.registry, match.module_id, match.module_version);
      const mode = registered.manifest.modes.find((candidate) => candidate.id === match.mode);
      if (!mode) throw moduleFailure();
      let state: Json;
      try {
        state = parseJsonSchemaValue(registered.manifest.stateSchema, match.state);
      } catch {
        throw moduleFailure();
      }

      const existingMember = persistedMembers.find(
        (member) => member.principalId.toLowerCase() === principalId,
      );
      let member: Member | undefined;
      let members = persistedMembers;
      let rejoin = false;
      if (kind === "join") {
        if (existingMember?.status === "active") {
          throw new ApiError(ERROR_CODES.RULE_REJECTED, "You already joined this match.");
        }
        if (existingMember?.status === "removed") throw notFound();
        if (existingMember) {
          if (!mode.rejoin || (match.phase === "active" && !mode.lateJoin)) {
            throw new ApiError(ERROR_CODES.MATCH_CLOSED, "This match no longer accepts returning players.");
          }
          rejoin = true;
          const existingPeriod = await client.query(
            `SELECT 1 FROM next_round.member_periods
              WHERE member_id = $1 AND access_epoch = $2`,
            [existingMember.id, existingMember.accessEpoch],
          );
          const accessEpoch = existingPeriod.rowCount ? existingMember.accessEpoch + 1 : existingMember.accessEpoch;
          member = { ...existingMember, accessEpoch, status: "active" };
          members = persistedMembers.map((candidate) => candidate.id === member!.id ? member! : candidate);
        } else {
          if (currentSession.kind !== "registered" || match.visibility !== "instance") throw notFound();
          if (match.phase === "active" && !mode.lateJoin) {
            throw new ApiError(ERROR_CODES.MATCH_CLOSED, "This match no longer accepts new players.");
          }
          member = {
            id: randomUUID(),
            principalId,
            kind: "registered",
            displayName: session.principal.displayName,
            status: "active",
            joinOrdinal: persistedMembers.reduce((maximum, candidate) => Math.max(maximum, candidate.joinOrdinal), 0) + 1,
            disabled: false,
            accessEpoch: 0,
          };
          members = [...persistedMembers, member];
        }
        const activeCount = persistedMembers.filter((candidate) => candidate.status === "active").length;
        if (activeCount >= mode.maxPlayers) {
          throw new ApiError(ERROR_CODES.CAPACITY_REACHED, "This match is full.");
        }
      } else {
        if (!existingMember || existingMember.status !== "active") throw notFound();
        member = existingMember;
      }
      if (!member) throw moduleFailure();

      // The reducer receives the database time captured after the match lock.
      const eventId = randomUUID();
      const ctx = context(match, members, now, eventId, { principalId, memberId: member.id });
      let transition;
      try {
        if (kind === "start" && !registered.server.authority(ctx, state, member.id).canStart) {
          throw new ApiError(ERROR_CODES.FORBIDDEN, "Only the match host can start this match.");
        }
        transition = registered.server.transition(
          ctx,
          state,
          kind === "join"
            ? { kind: "join", memberId: member.id, rejoin }
            : kind === "start"
              ? { kind: "start" }
              : { kind: "leave", memberId: member.id, reason: "left" },
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw moduleFailure();
      }
      if (!transition.ok) {
        throw new ApiError(ERROR_CODES.RULE_REJECTED, "The game did not accept this command.", {
          details: { ruleCode: `${match.module_id}/RULE_REJECTED` },
        });
      }
      if (!transition.value ||
          (kind !== "leave" && transition.value.final !== null) ||
          (kind === "start" && transition.value.phase !== "active") ||
          (kind === "join" && transition.value.phase !== match.phase)) throw moduleFailure();
      if (
        kind === "leave" && transition.value.hostMemberId === member.id &&
        transition.value.phase !== "finished"
      ) throw moduleFailure();

      if (kind === "join") {
        if (rejoin) {
          await client.query(
            `UPDATE next_round.match_members
                SET status = 'active', joined_at = $3::timestamptz, departed_at = NULL,
                    chat_from_at = $3::timestamptz, access_epoch = $4
              WHERE match_id = $1 AND id = $2`,
            [matchId, member.id, now, member.accessEpoch],
          );
          await client.query(
            `INSERT INTO next_round.member_periods (member_id, access_epoch)
             VALUES ($1, $2)`,
            [member.id, member.accessEpoch],
          );
        } else {
          await client.query(
            `INSERT INTO next_round.match_members
               (id, match_id, principal_id, status, join_ordinal, access_epoch)
             VALUES ($1, $2, $3, 'active', $4, 0)`,
            [member.id, matchId, principalId, member.joinOrdinal],
          );
          await client.query(
            `INSERT INTO next_round.member_periods (member_id, access_epoch)
             VALUES ($1, 0)`,
            [member.id],
          );
        }
      } else if (kind === "leave") {
        await client.query(
          `UPDATE next_round.match_members
              SET status = 'left', departed_at = $3::timestamptz,
                  access_epoch = access_epoch + 1
            WHERE match_id = $1 AND id = $2 AND status = 'active'`,
          [matchId, member.id, now],
        );
        await client.query(
          `UPDATE next_round.member_periods
              SET departed_at = $3::timestamptz, departure_reason = 'left'
            WHERE member_id = $1 AND access_epoch = $2 AND departed_at IS NULL`,
          [member.id, member.accessEpoch, now],
        );
      }

      const committedRevision = await this.persistTransition(
        client, match, members, registered, transition.value,
        kind === "join" ? { kind: "join", memberId: member.id, rejoin } :
          kind === "start" ? { kind: "start" } : { kind: "leave", memberId: member.id, reason: "left" },
        eventId, now, principalId,
      );

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
        [principalId, MATCH_LIFECYCLE_SCOPE, input.commandId, requestHash, matchId,
          committedRevision, JSON.stringify(receipt)],
      );
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      if (!committedTimeouts) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }


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
                     'dueAt', to_char(d.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
        canLeave: match.phase !== "finished",
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
    session: AuthenticatedSession,
    input: MatchActionInput,
  ): Promise<CommandReceipt> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.actOnce(matchId, session, input);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "40001" && code !== "40P01") throw error;
        if (attempt === 2) throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, "Please retry this command.");
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 30));
      }
    }
  }

  private async actOnce(
    matchId: string,
    session: AuthenticatedSession,
    input: MatchActionInput,
  ): Promise<CommandReceipt> {
    const principalId = session.principal.id;
    // PostgreSQL UUIDs are case-insensitive and returned in lowercase. Use the
    // same representation for receipt comparisons and response identities.
    matchId = matchId.toLowerCase();
    const client = await this.pool.connect();
    let committedTimeouts = false;
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.match_members WHERE match_id = $1",
        [matchId],
      );
      const principalIds = [principalId, ...candidates.rows.map((row) => row.principal_id)];
      await lockPrincipals(client, principalIds);
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
      // Session and guest scope must be current even for a receipt replay.
      await recheckSession(client, session, { matchId });
      if (!match) throw notFound();
      const currentMembers = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM next_round.match_members WHERE match_id = $1",
        [matchId],
      );
      if (currentMembers.rows.some((row) => !principalIds.includes(row.principal_id))) {
        // A join committed between discovery and the match lock. Restart without
        // acquiring a new principal out of order while holding the match lock.
        throw Object.assign(new Error("Retry membership discovery"), { code: "40001" });
      }
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
      if (match.revision !== input.expectedRevision) {
        throw new ApiError(ERROR_CODES.STALE_REVISION, "Refresh this match before acting.", {
          details: { currentRevision: match.revision },
        });
      }
      if (match.phase === "finished") {
        throw new ApiError(ERROR_CODES.MATCH_CLOSED, "Match is closed.");
      }
      const now = await this.databaseNow(client);
      const deadlineMembers = await this.loadMembers(client, matchId);
      if (await this.reconcileDue(client, match, deadlineMembers, now)) {
        await client.query("COMMIT");
        committedTimeouts = true;
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

      const members = deadlineMembers;
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

      const committedRevision = await this.persistTransition(
        client, match, members, registered, transition.value,
        { kind: "action", type: input.type, payload }, eventId, now, principalId,
      );

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
      if (!committedTimeouts) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async databaseNow(client: Pick<DatabasePool, "query">): Promise<string> {
    const result = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    return result.rows[0].now.toISOString();
  }

  private async loadMembers(client: Pick<DatabasePool, "query">, matchId: string): Promise<Member[]> {
    const result = await client.query<Member>(
      `SELECT mm.id, mm.principal_id AS "principalId", p.kind,
              p.display_name AS "displayName", mm.status,
              mm.join_ordinal::integer AS "joinOrdinal",
              (p.disabled_at IS NOT NULL) AS disabled, mm.access_epoch::integer AS "accessEpoch"
         FROM next_round.match_members mm JOIN next_round.principals p ON p.id = mm.principal_id
        WHERE mm.match_id = $1 ORDER BY mm.join_ordinal`, [matchId],
    );
    return result.rows;
  }

  /** Shared state/event/result/deadline/effects commit path for commands and system events. */
  private async persistTransition(
    client: Pick<DatabasePool, "query">,
    match: Omit<ActionMatchRow, "viewer_member_id">,
    members: readonly Member[],
    registered: ServerGameVersion,
    transition: Transition<Json>,
    event: GameEvent,
    eventId: string,
    now: string,
    actorId: string | null,
    created = false,
    fired?: StoredDeadline,
  ): Promise<number> {
    if (!transition || !Array.isArray(transition.deadlines) ||
        !Array.isArray(transition.needsActionFrom) || !Array.isArray(transition.facts) ||
        !["lobby", "active", "finished"].includes(transition.phase) ||
        (match.phase === "active" && transition.phase === "lobby") ||
        (match.phase === "finished") ||
        (transition.hostMemberId !== null && !members.some((m) => m.id === transition.hostMemberId)) ||
        new Set(transition.needsActionFrom).size !== transition.needsActionFrom.length ||
        transition.needsActionFrom.some((id) => !members.some((m) => m.id === id && m.status === "active" && !m.disabled))) {
      throw moduleFailure();
    }
    let state: Json;
    try { state = parseJsonSchemaValue(registered.manifest.stateSchema, transition.state); }
    catch { throw moduleFailure(); }
    const final = prepareFinalResult(registered, transition, members);
    const stored = await validateDeadlines(client, match.id, transition.deadlines, fired);
    const revision = match.revision + 1;
    if (!Number.isSafeInteger(revision)) throw moduleFailure();
    await client.query(
      `UPDATE next_round.matches SET state = $2::jsonb, phase = $3, host_member_id = $4,
              revision = $5, needs_action_from = $6::uuid[],
              started_at = CASE WHEN $3 = 'active' THEN COALESCE(started_at, $7::timestamptz) ELSE started_at END,
              finished_at = CASE WHEN $3 = 'finished' THEN $7::timestamptz ELSE finished_at END,
              updated_at = $7::timestamptz WHERE id = $1`,
      [match.id, JSON.stringify(state), transition.phase, transition.hostMemberId,
        revision, transition.needsActionFrom, now],
    );
    if (!created) await client.query(
      `INSERT INTO next_round.match_events (match_id, revision, event_id, actor_id, kind, safe_metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [match.id, revision, eventId, actorId, event.kind,
        JSON.stringify(event.kind === "action" ? { type: event.type } :
          event.kind === "join" ? { rejoin: event.rejoin } : {})],
    );
    await persistMatchEffects(client, match.id, revision, eventId, now, members, transition, stored, fired);
    await persistFinalResult(client, match, registered.manifest.resultVersion, final, revision, now);
    // Keep the locked in-memory row current when several originally-due identities are consumed.
    Object.assign(match, { revision, state, phase: transition.phase, host_member_id: transition.hostMemberId });
    return revision;
  }

  private async reconcileDue(
    client: Pick<DatabasePool, "query">,
    match: Omit<ActionMatchRow, "viewer_member_id">,
    members: readonly Member[],
    now: string,
  ): Promise<number> {
    const due = (await readDeadlines(client, match.id)).filter(
      (row) => row.status === "pending" && Date.parse(row.dueAt) <= Date.parse(now),
    );
    let applied = 0;
    // Snapshot the due set: do not simulate historical turns for newly-created obligations.
    for (const deadline of due) {
      if (match.phase === "finished") break;
      const pending = await client.query(
        `SELECT 1 FROM next_round.match_deadlines
          WHERE match_id = $1 AND key = $2 AND generation = $3 AND status = 'pending'`,
        [match.id, deadline.key, deadline.generation],
      );
      if (!pending.rowCount) continue;
      const registered = registeredVersion(this.registry, match.module_id, match.module_version);
      const event: GameEvent = { kind: "deadline", deadline: {
        key: deadline.key, generation: deadline.generation, dueAt: deadline.dueAt,
      } };
      let transition;
      try {
        transition = registered.server.transition(
          context(match, members, now, deadline.eventId, null), match.state, event,
        );
      } catch { throw moduleFailure(); }
      if (!transition.ok) throw moduleFailure();
      await this.persistTransition(client, match, members, registered, transition.value,
        event, deadline.eventId, now, null, false, deadline);
      applied += 1;
    }
    return applied;
  }

  async processDeadline(input: DeadlineInput): Promise<number> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const discovered = await client.query<{ principal_id: string }>(
          "SELECT principal_id FROM next_round.match_members WHERE match_id = $1", [input.matchId],
        );
        const principalIds = discovered.rows.map((row) => row.principal_id);
        await lockPrincipals(client, principalIds);
        const result = await client.query<Omit<ActionMatchRow, "viewer_member_id">>(
          `SELECT id, module_id, module_version, state_version, mode, phase,
                  revision::integer AS revision, state, settings, host_member_id
             FROM next_round.matches WHERE id = $1 FOR UPDATE`, [input.matchId],
        );
        const match = result.rows[0];
        if (!match || match.phase === "finished") { await client.query("COMMIT"); return 0; }
        const members = await this.loadMembers(client, match.id);
        if (members.some((member) => !principalIds.includes(member.principalId))) {
          throw Object.assign(new Error("Retry membership discovery"), { code: "40001" });
        }
        const now = await this.databaseNow(client);
        const requested = await client.query(
          `SELECT 1 FROM next_round.match_deadlines WHERE match_id = $1 AND key = $2
            AND generation = $3 AND status = 'pending' AND due_at <= $4::timestamptz`,
          [match.id, input.key, input.generation, now],
        );
        const applied = requested.rowCount ? await this.reconcileDue(client, match, members, now) : 0;
        await client.query("COMMIT");
        return applied;
      } catch (error) {
        await client.query("ROLLBACK");
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "40001" && code !== "40P01") throw error;
        if (attempt === 2) throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, "Please retry this command.");
        await delay(10 + Math.random() * 30);
      } finally { client.release(); }
    }
  }
}

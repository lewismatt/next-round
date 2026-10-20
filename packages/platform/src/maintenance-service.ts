// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ApiError,
  ERROR_CODES,
  FinalResultSchema,
  parseJsonSchemaValue,
  parseRequestBody,
  type FinalResult,
  type Json,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { CareerMetric } from "@next-round/game-sdk";
import type { AuthenticatedSession } from "./auth-service.js";
import type { GameRegistry } from "./registry.js";
import { lockPrincipals, recheckSession } from "./transaction-authority.js";

type Tx = Pick<DatabasePool, "query">;
type RetentionScope = "chat" | "privateState" | "results" | "notifications";
const SCOPES: readonly RetentionScope[] = [
  "chat",
  "privateState",
  "results",
  "notifications",
];
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RETENTION_PLAN_KIND = "retention.v1";

function invalid(): ApiError {
  return new ApiError(
    ERROR_CODES.INVALID_REQUEST,
    "The maintenance request is invalid.",
  );
}
function unavailable(): ApiError {
  return new ApiError(
    ERROR_CODES.MODULE_FAILURE,
    "The game module could not process this match.",
  );
}
function hashConfirmation(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export interface MatchMigrationResult {
  matchId: string;
  moduleId: string;
  fromVersion: string;
  targetVersion: string;
  revision: number;
}

/** Migrate a match only through the explicitly installed destination server's reviewed hook. */
export async function migrateAdminMatch(
  pool: DatabasePool,
  registry: GameRegistry,
  session: AuthenticatedSession,
  matchId: string,
  targetVersion: string,
  expectedRevision: number,
  commandId: string,
): Promise<MatchMigrationResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw invalid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const membersBefore = await client.query<{ principal_id: string }>(
      `SELECT principal_id FROM next_round.match_members WHERE match_id = $1 ORDER BY principal_id`,
      [matchId],
    );
    const principalIds = [
      ...new Set([
        session.principal.id,
        ...membersBefore.rows.map((row) => row.principal_id),
      ]),
    ];
    await lockPrincipals(client, principalIds);
    await recheckSession(client, session, { admin: true, registered: true });
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ matchId, targetVersion, expectedRevision }))
      .digest();
    const prior = await client.query<{
      request_hash: Buffer;
      match_id: string;
      safe_receipt: MatchMigrationResult;
    }>(
      `SELECT request_hash, match_id, safe_receipt FROM next_round.command_receipts
        WHERE principal_id = $1 AND scope = 'admin.match.migrate' AND command_id = $2`,
      [session.principal.id, commandId],
    );
    if (prior.rows[0]) {
      if (
        prior.rows[0].match_id !== matchId ||
        !timingSafeEqual(requestHash, prior.rows[0].request_hash)
      ) {
        throw new ApiError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "This command was already used with a different request.",
        );
      }
      await client.query("COMMIT");
      return prior.rows[0].safe_receipt;
    }
    const selected = await client.query<{
      id: string;
      module_id: string;
      module_version: string;
      state_version: number;
      phase: string;
      revision: number;
      state: Json | null;
      settings: Json;
      mode: string;
      policy_snapshot: Json;
    }>(
      `SELECT id, module_id, module_version, state_version, phase, revision, state, settings, mode, policy_snapshot
          FROM next_round.matches WHERE id = $1 FOR UPDATE`,
      [matchId],
    );
    const match = selected.rows[0];
    const membersAfter = await client.query<{ principal_id: string }>(
      `SELECT principal_id FROM next_round.match_members WHERE match_id = $1 ORDER BY principal_id`,
      [matchId],
    );
    if (
      JSON.stringify(membersAfter.rows.map((row) => row.principal_id)) !==
      JSON.stringify(membersBefore.rows.map((row) => row.principal_id))
    ) {
      throw new ApiError(
        ERROR_CODES.STALE_REVISION,
        "Match membership changed during maintenance.",
      );
    }
    if (!match)
      throw new ApiError(ERROR_CODES.NOT_FOUND, "Match was not found.");
    if (Number(match.revision) !== expectedRevision) {
      throw new ApiError(
        ERROR_CODES.STALE_REVISION,
        "Refresh this match before continuing.",
        {
          details: { currentRevision: Number(match.revision) },
        },
      );
    }
    if (match.module_version === targetVersion) throw invalid();
    const destination = registry.getVersion(match.module_id, targetVersion);
    const source = registry.getVersion(match.module_id, match.module_version);
    if (
      !source?.server ||
      !destination?.server?.migrate ||
      match.state === null
    )
      throw unavailable();
    const targetMeta = await client.query<{
      state_version: number;
      result_version: number;
    }>(
      `SELECT state_version, result_version FROM next_round.module_versions
        WHERE module_id = $1 AND version = $2`,
      [match.module_id, targetVersion],
    );
    if (!targetMeta.rows[0]) throw invalid();
    let priorResult: FinalResult | null = null;
    if (match.phase === "finished") {
      const row = await client.query<{ raw_result: Json }>(
        `SELECT raw_result FROM next_round.match_results WHERE match_id = $1`,
        [matchId],
      );
      if (!row.rows[0]) throw unavailable();
      priorResult = parseRequestBody(
        FinalResultSchema,
        row.rows[0].raw_result,
      ) as FinalResult;
      parseJsonSchemaValue(source.manifest.resultSchema, priorResult.data);
    }
    let migrated: { state: Json; settings: Json; result: FinalResult | null };
    let migratedParticipants: Array<{
      memberId: string;
      principalId: string;
      score: number;
      contribution: unknown;
      win: boolean;
      careerEligible: boolean;
      exclusionReasons: string[];
      displayName: string;
    }> | null = null;
    let migratedCareer: Array<CareerMetric & { principalId: string }> = [];
    let resultVisibility: "owner" | "instance" | null = null;
    let migratedEligibilityReasons: string[] = [];
    try {
      migrated = destination.server.migrate({
        fromVersion: match.module_version,
        fromStateVersion: match.state_version,
        toStateVersion: targetMeta.rows[0].state_version,
        state: match.state,
        settings: match.settings,
        result: priorResult,
      }) as typeof migrated;
      if (
        !migrated ||
        migrated.state === null ||
        (match.phase === "finished"
          ? !migrated.result
          : migrated.result !== null)
      )
        throw unavailable();
      parseJsonSchemaValue(destination.manifest.stateSchema, migrated.state);
      parseJsonSchemaValue(
        destination.manifest.settingsSchema,
        migrated.settings,
      );
      if (migrated.result !== null) {
        migrated.result = parseRequestBody(
          FinalResultSchema,
          migrated.result,
        ) as FinalResult;
        parseJsonSchemaValue(
          destination.manifest.resultSchema,
          migrated.result.data,
        );
        const rows = await client.query<{
          member_id: string;
          principal_id: string;
          kind: string;
          display_name_snapshot: string;
        }>(
          `SELECT pr.member_id, pr.principal_id, p.kind, pr.display_name_snapshot
              FROM next_round.participant_results pr
              JOIN next_round.principals p ON p.id = pr.principal_id
             WHERE pr.match_id = $1 ORDER BY pr.member_id`,
          [matchId],
        );
        const participantById = new Map(
          rows.rows.map((row) => [row.member_id, row]),
        );
        if (participantById.size !== migrated.result.participants.length)
          throw unavailable();
        const eligible = new Map<string, { principalId: string }>();
        const seenParticipants = new Set<string>();
        migratedParticipants = [];
        for (const participant of migrated.result.participants) {
          const prior = participantById.get(participant.memberId);
          if (
            !prior ||
            seenParticipants.has(participant.memberId) ||
            !Number.isSafeInteger(participant.score) ||
            participant.score < -2147483648 ||
            participant.score > 2147483647 ||
            (participant.careerEligible &&
              (prior.kind !== "registered" ||
                participant.exclusionReasons.length !== 0))
          ) {
            throw unavailable();
          }
          seenParticipants.add(participant.memberId);
          migratedParticipants.push({
            ...participant,
            principalId: prior.principal_id,
            displayName: prior.display_name_snapshot,
          });
          if (participant.careerEligible)
            eligible.set(participant.memberId, {
              principalId: prior.principal_id,
            });
        }
        if (seenParticipants.size !== participantById.size) throw unavailable();
        const participants = migrated.result.participants;
        migratedEligibilityReasons =
          participants.length === 0
            ? []
            : [...new Set(participants[0].exclusionReasons)].filter((reason) =>
                participants.every((participant) =>
                  participant.exclusionReasons.includes(reason),
                ),
              );
        const metrics = destination.server.career(migrated.result);
        if (!Array.isArray(metrics)) throw unavailable();
        const seenMetrics = new Set<string>();
        for (const metric of metrics) {
          const participant = metric && eligible.get(metric.memberId);
          if (
            !participant ||
            seenMetrics.has(metric.memberId) ||
            ![metric.points, metric.played, metric.wins].every(
              (value) => Number.isSafeInteger(value) && value >= 0,
            )
          ) {
            throw unavailable();
          }
          seenMetrics.add(metric.memberId);
          migratedCareer.push({
            ...metric,
            principalId: participant.principalId,
          });
        }
        if (seenMetrics.size !== eligible.size) throw unavailable();
        const existingVisibility = await client.query<{ visibility: string }>(
          `SELECT visibility FROM next_round.career_contributions WHERE match_id = $1 LIMIT 1`,
          [matchId],
        );
        const snapshotVisibility =
          match.policy_snapshot &&
          typeof match.policy_snapshot === "object" &&
          !Array.isArray(match.policy_snapshot)
            ? match.policy_snapshot.statsVisibility
            : undefined;
        const visibility =
          existingVisibility.rows[0]?.visibility ??
          (match.mode === "solo" ? "owner" : snapshotVisibility);
        if (visibility !== "owner" && visibility !== "instance")
          throw unavailable();
        resultVisibility = visibility;
      }
    } catch {
      throw unavailable();
    }
    const nextRevision = Number(match.revision) + 1;
    if (!Number.isSafeInteger(nextRevision)) throw unavailable();
    await client.query(
      `UPDATE next_round.matches SET module_version = $2, state_version = $3,
         state = $4::jsonb, settings = $5::jsonb, revision = $6, updated_at = clock_timestamp()
        WHERE id = $1`,
      [
        matchId,
        targetVersion,
        targetMeta.rows[0].state_version,
        JSON.stringify(migrated.state),
        JSON.stringify(migrated.settings),
        nextRevision,
      ],
    );
    if (migrated.result !== null) {
      await client.query(
        `UPDATE next_round.match_results SET module_version = $2, result_version = $3,
           outcome = $4, raw_result = $5::jsonb, eligibility_reasons = $6::jsonb
          WHERE match_id = $1`,
        [
          matchId,
          targetVersion,
          targetMeta.rows[0].result_version,
          migrated.result.outcome,
          JSON.stringify(migrated.result),
          JSON.stringify(migratedEligibilityReasons),
        ],
      );
      await client.query(
        `DELETE FROM next_round.participant_results WHERE match_id = $1`,
        [matchId],
      );
      await client.query(
        `INSERT INTO next_round.participant_results
          (match_id, member_id, principal_id, score, contribution, win, career_eligible,
           exclusion_reasons, display_name_snapshot)
         SELECT $1, p."memberId", p."principalId", p.score, p.contribution, p.win,
                p."careerEligible", p."exclusionReasons", p."displayName"
           FROM jsonb_to_recordset($2::jsonb) AS p(
             "memberId" uuid, "principalId" uuid, score integer, contribution jsonb,
             win boolean, "careerEligible" boolean, "exclusionReasons" jsonb, "displayName" text)`,
        [matchId, JSON.stringify(migratedParticipants)],
      );
      await client.query(
        `DELETE FROM next_round.career_contributions WHERE match_id = $1`,
        [matchId],
      );
      if (migratedCareer.length > 0) {
        await client.query(
          `INSERT INTO next_round.career_contributions
            (match_id, principal_id, module_id, metric_version, points, played, wins, visibility)
           SELECT $1, c."principalId", $2, $3, c.points, c.played, c.wins, $4
             FROM jsonb_to_recordset($5::jsonb) AS c(
               "principalId" uuid, points bigint, played bigint, wins bigint)`,
          [
            matchId,
            match.module_id,
            targetMeta.rows[0].result_version,
            resultVisibility,
            JSON.stringify(migratedCareer),
          ],
        );
      }
    }
    await client.query(
      `INSERT INTO next_round.match_events (match_id, revision, event_id, actor_id, kind, safe_metadata)
       VALUES ($1, $2, $3, $4, 'admin.migrate', $5::jsonb)`,
      [
        matchId,
        nextRevision,
        randomUUID(),
        session.principal.id,
        JSON.stringify({
          fromVersion: match.module_version,
          targetVersion,
          commandId,
        }),
      ],
    );
    await client.query(
      `INSERT INTO next_round.audit_log (actor_id, action, target_type, target_id, safe_metadata)
       VALUES ($1, 'match.migrated', 'match', $2, $3::jsonb)`,
      [
        session.principal.id,
        matchId,
        JSON.stringify({
          fromVersion: match.module_version,
          targetVersion,
          revision: nextRevision,
        }),
      ],
    );
    await client.query(
      `INSERT INTO next_round.outbox (topic, aggregate_id, aggregate_revision, dedupe_key, safe_payload)
       VALUES ('live.invalidate', $1, $2, $3, $4::jsonb) ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        matchId,
        nextRevision,
        `match:${matchId}:${nextRevision}`,
        JSON.stringify({
          scope: { kind: "match", id: matchId },
          revision: nextRevision,
        }),
      ],
    );
    const receipt: MatchMigrationResult = {
      matchId,
      moduleId: match.module_id,
      fromVersion: match.module_version,
      targetVersion,
      revision: nextRevision,
    };
    await client.query(
      `INSERT INTO next_round.command_receipts
        (principal_id, scope, command_id, request_hash, match_id, committed_revision, safe_receipt)
       VALUES ($1, 'admin.match.migrate', $2, $3, $4, $5, $6::jsonb)`,
      [
        session.principal.id,
        commandId,
        requestHash,
        matchId,
        nextRevision,
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

export interface RetentionPlanPreview {
  id: string;
  counts: Record<RetentionScope, number>;
  policyVersion: number;
  cutoff: string;
  expiresAt: string;
  confirmationId: string;
  scope: RetentionScope[];
}
interface PlanTarget {
  scope: RetentionScope;
  id: string;
  updatedAt?: string;
}

async function collectTargets(
  client: Tx,
  scopes: readonly RetentionScope[],
  cutoff: string,
): Promise<PlanTarget[]> {
  const targets: PlanTarget[] = [];
  if (scopes.includes("chat")) {
    const rows = await client.query<{ id: string }>(
      `SELECT c.id::text AS id FROM next_round.chat_messages c
        JOIN next_round.matches m ON m.id = c.match_id
       WHERE m.phase = 'finished' AND m.finished_at <= $1::timestamptz AND c.deleted_at IS NULL
       ORDER BY c.id`,
      [cutoff],
    );
    targets.push(
      ...rows.rows.map((row) => ({ scope: "chat" as const, id: row.id })),
    );
  }
  if (scopes.includes("privateState")) {
    const rows = await client.query<{ id: string; updated_at: string }>(
      `SELECT id::text AS id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM next_round.matches
        WHERE phase = 'finished' AND finished_at <= $1::timestamptz AND state IS NOT NULL
        ORDER BY id`,
      [cutoff],
    );
    targets.push(
      ...rows.rows.map((row) => ({
        scope: "privateState" as const,
        id: row.id,
        updatedAt: row.updated_at,
      })),
    );
  }
  if (scopes.includes("results")) {
    const rows = await client.query<{ id: string; updated_at: string }>(
      `SELECT r.match_id::text AS id,
              to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM next_round.match_results r
         JOIN next_round.matches m ON m.id = r.match_id
        WHERE m.phase = 'finished' AND r.finished_at <= $1::timestamptz
        ORDER BY r.match_id`,
      [cutoff],
    );
    targets.push(
      ...rows.rows.map((row) => ({
        scope: "results" as const,
        id: row.id,
        updatedAt: row.updated_at,
      })),
    );
  }
  if (scopes.includes("notifications")) {
    const rows = await client.query<{ id: string }>(
      `SELECT n.id::text AS id FROM next_round.notifications n
        LEFT JOIN next_round.matches m ON m.id = n.match_id
       WHERE n.created_at <= $1::timestamptz AND (n.match_id IS NULL OR m.phase = 'finished')
       ORDER BY n.id`,
      [cutoff],
    );
    targets.push(
      ...rows.rows.map((row) => ({
        scope: "notifications" as const,
        id: row.id,
      })),
    );
  }
  return targets;
}

async function targetPrincipals(
  client: Tx,
  targets: readonly PlanTarget[],
): Promise<string[]> {
  const chatIds = targets
    .filter((item) => item.scope === "chat")
    .map((item) => item.id);
  const notificationIds = targets
    .filter((item) => item.scope === "notifications")
    .map((item) => item.id);
  const resultIds = targets
    .filter((item) => item.scope === "results")
    .map((item) => item.id);
  const result = await client.query<{ principal_id: string }>(
    `SELECT principal_id FROM (
       SELECT sender_id AS principal_id FROM next_round.chat_messages WHERE id = ANY($1::uuid[])
       UNION
       SELECT principal_id FROM next_round.notifications WHERE id = ANY($2::uuid[])
       UNION
       SELECT principal_id FROM next_round.participant_results WHERE match_id = ANY($3::uuid[])
       UNION
       SELECT principal_id FROM next_round.career_contributions WHERE match_id = ANY($3::uuid[])
     ) affected ORDER BY principal_id`,
    [chatIds, notificationIds, resultIds],
  );
  return result.rows.map((row) => row.principal_id);
}

async function targetMatchIds(
  client: Tx,
  targets: readonly PlanTarget[],
): Promise<string[]> {
  const chatIds = targets
    .filter((item) => item.scope === "chat")
    .map((item) => item.id);
  const notificationIds = targets
    .filter((item) => item.scope === "notifications")
    .map((item) => item.id);
  const directMatchIds = targets
    .filter((item) => item.scope === "privateState" || item.scope === "results")
    .map((item) => item.id);
  const result = await client.query<{ id: string }>(
    `SELECT id FROM (
       SELECT id FROM next_round.matches WHERE id = ANY($1::uuid[])
       UNION
       SELECT match_id AS id FROM next_round.chat_messages WHERE id = ANY($2::uuid[])
       UNION
       SELECT match_id AS id FROM next_round.notifications WHERE id = ANY($3::uuid[]) AND match_id IS NOT NULL
     ) affected ORDER BY id`,
    [directMatchIds, chatIds, notificationIds],
  );
  return result.rows.map((row) => row.id);
}

export async function previewAdminRetention(
  pool: DatabasePool,
  session: AuthenticatedSession,
  scope: RetentionScope[],
  policyVersion: number,
  cutoff: string,
): Promise<RetentionPlanPreview> {
  if (
    !Number.isSafeInteger(policyVersion) ||
    policyVersion < 1 ||
    !Array.isArray(scope) ||
    scope.length === 0 ||
    scope.some((x) => !SCOPES.includes(x)) ||
    new Set(scope).size !== scope.length ||
    typeof cutoff !== "string" ||
    !ISO_DATETIME_PATTERN.test(cutoff) ||
    !Number.isFinite(Date.parse(cutoff))
  )
    throw invalid();
  const normalizedCutoff = new Date(cutoff).toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPrincipals(client, [session.principal.id]);
    await recheckSession(client, session, { admin: true, registered: true });
    const current = await client.query<{ version: number; now: Date | string }>(
      `SELECT s.current_policy_version AS version, clock_timestamp() AS now
         FROM next_round.instance_singleton s
         JOIN next_round.instance_policy p ON p.version = s.current_policy_version
        WHERE s.id = true FOR SHARE OF s`,
    );
    if (Number(current.rows[0]?.version) !== policyVersion) throw invalid();
    const targets = await collectTargets(client, scope, normalizedCutoff);
    const counts = Object.fromEntries(
      SCOPES.map((name) => [
        name,
        targets.filter((item) => item.scope === name).length,
      ]),
    ) as Record<RetentionScope, number>;
    const id = randomUUID();
    const confirmationId = randomBytes(32).toString("base64url");
    const expires = new Date(
      new Date(current.rows[0].now).getTime() + 15 * 60 * 1000,
    ).toISOString();
    const manifest = { scope, cutoff: normalizedCutoff, targets };
    await client.query(
      `INSERT INTO next_round.maintenance_plans
        (id, kind, actor_id, policy_version, target_manifest, counts, confirmation_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::timestamptz)`,
      [
        id,
        RETENTION_PLAN_KIND,
        session.principal.id,
        current.rows[0].version,
        JSON.stringify(manifest),
        JSON.stringify(counts),
        hashConfirmation(confirmationId),
        expires,
      ],
    );
    await client.query(
      `INSERT INTO next_round.audit_log (actor_id, action, target_type, target_id, safe_metadata)
       VALUES ($1, 'retention.previewed', 'maintenance_plan', $2, $3::jsonb)`,
      [
        session.principal.id,
        id,
        JSON.stringify({
          counts,
          policyVersion,
          cutoff: normalizedCutoff,
          scope,
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      id,
      counts,
      policyVersion: Number(current.rows[0].version),
      cutoff: normalizedCutoff,
      expiresAt: expires,
      confirmationId,
      scope: [...scope],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function executeAdminRetention(
  pool: DatabasePool,
  session: AuthenticatedSession,
  planId: string,
  confirmationId: string,
): Promise<{
  id: string;
  executed: boolean;
  counts: Record<RetentionScope, number>;
}> {
  if (!confirmationId || confirmationId.length > 256) throw invalid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidateResult = await client.query<{
      actor_id: string;
      target_manifest: {
        scope: RetentionScope[];
        cutoff: string;
        targets: PlanTarget[];
      };
    }>(
      `SELECT actor_id, target_manifest FROM next_round.maintenance_plans
        WHERE id = $1 AND kind = $2`,
      [planId, RETENTION_PLAN_KIND],
    );
    const candidate = candidateResult.rows[0];
    const affectedPrincipals =
      candidate?.actor_id === session.principal.id
        ? await targetPrincipals(client, candidate.target_manifest.targets)
        : [];
    await lockPrincipals(client, [session.principal.id, ...affectedPrincipals]);
    await recheckSession(client, session, { admin: true, registered: true });
    const selected = await client.query<{
      actor_id: string;
      policy_version: number;
      target_manifest: {
        scope: RetentionScope[];
        cutoff: string;
        targets: PlanTarget[];
      };
      counts: Record<RetentionScope, number>;
      confirmation_hash: Buffer;
      expired: boolean;
      executed_at: Date | string | null;
    }>(
      `SELECT actor_id, policy_version, target_manifest, counts, confirmation_hash,
              expires_at <= clock_timestamp() AS expired, executed_at
         FROM next_round.maintenance_plans WHERE id = $1 AND kind = $2 FOR UPDATE`,
      [planId, RETENTION_PLAN_KIND],
    );
    const plan = selected.rows[0];
    if (!plan || plan.actor_id !== session.principal.id)
      throw new ApiError(
        ERROR_CODES.NOT_FOUND,
        "Maintenance plan was not found.",
      );
    if (
      !candidate ||
      JSON.stringify(candidate.target_manifest) !==
        JSON.stringify(plan.target_manifest)
    )
      throw invalid();
    const suppliedHash = hashConfirmation(confirmationId);
    if (!timingSafeEqual(plan.confirmation_hash, suppliedHash))
      throw new ApiError(ERROR_CODES.FORBIDDEN, "Confirmation is invalid.");
    if (plan.executed_at) {
      await client.query("COMMIT");
      return { id: planId, executed: false, counts: plan.counts };
    }
    if (plan.expired) throw invalid();
    const matchIds = await targetMatchIds(client, plan.target_manifest.targets);
    await client.query(
      `SELECT id FROM next_round.matches WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [matchIds],
    );
    const current = await client.query<{ version: number }>(
      `SELECT s.current_policy_version AS version
         FROM next_round.instance_singleton s
         JOIN next_round.instance_policy p ON p.version = s.current_policy_version
        WHERE s.id = true FOR SHARE OF s`,
    );
    if (Number(current.rows[0]?.version) !== Number(plan.policy_version))
      throw invalid();
    const targets = await collectTargets(
      client,
      plan.target_manifest.scope,
      plan.target_manifest.cutoff,
    );
    if (
      JSON.stringify(targets) !== JSON.stringify(plan.target_manifest.targets)
    )
      throw invalid();
    for (const item of plan.target_manifest.targets) {
      if (item.scope === "chat")
        await client.query(
          `DELETE FROM next_round.chat_messages WHERE id = $1`,
          [item.id],
        );
      else if (item.scope === "privateState")
        await client.query(
          `UPDATE next_round.matches SET state = NULL, resource_snapshot = NULL, state_pruned_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1 AND phase = 'finished'`,
          [item.id],
        );
      else if (item.scope === "results") {
        await client.query(
          `DELETE FROM next_round.career_contributions WHERE match_id = $1`,
          [item.id],
        );
        await client.query(
          `DELETE FROM next_round.participant_results WHERE match_id = $1`,
          [item.id],
        );
        await client.query(
          `DELETE FROM next_round.match_results WHERE match_id = $1`,
          [item.id],
        );
        // Retain the finished match row as a replay-resistant minimal tombstone; remove sensitive snapshots.
        await client.query(
          `UPDATE next_round.matches SET state = NULL, resource_snapshot = NULL,
          state_pruned_at = COALESCE(state_pruned_at, clock_timestamp()), updated_at = clock_timestamp()
          WHERE id = $1 AND phase = 'finished'`,
          [item.id],
        );
      } else if (item.scope === "notifications")
        await client.query(
          `DELETE FROM next_round.notifications WHERE id = $1`,
          [item.id],
        );
    }
    await client.query(
      `UPDATE next_round.maintenance_plans SET executed_at = clock_timestamp() WHERE id = $1`,
      [planId],
    );
    await client.query(
      `INSERT INTO next_round.audit_log (actor_id, action, target_type, target_id, safe_metadata)
       VALUES ($1, 'retention.executed', 'maintenance_plan', $2, $3::jsonb)`,
      [
        session.principal.id,
        planId,
        JSON.stringify({
          counts: plan.counts,
          policyVersion: plan.policy_version,
          cutoff: plan.target_manifest.cutoff,
        }),
      ],
    );
    await client.query("COMMIT");
    return { id: planId, executed: true, counts: plan.counts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  ERROR_CODES,
  FinalResultSchema,
  parseJsonSchemaValue,
  parseRequestBody,
  type FinalResult,
  type Json,
  type Member,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { CareerMetric, Transition } from "@next-round/game-sdk";
import type { RegisteredGameVersion } from "./registry.js";

function moduleFailure(): ApiError {
  return new ApiError(ERROR_CODES.MODULE_FAILURE, "The game module could not process this match.");
}

interface PreparedFinal {
  result: FinalResult;
  participants: Array<FinalResult["participants"][number] & {
    principalId: string;
    displayName: string;
  }>;
  career: Array<CareerMetric & { principalId: string }>;
  eligibilityReasons: string[];
}

/** Validate all module output before the caller writes any final transition effects. */
export function prepareFinalResult(
  registered: RegisteredGameVersion,
  transition: Transition<Json>,
  members: readonly Member[],
): PreparedFinal | null {
  try {
    if (!transition || !["lobby", "active", "finished"].includes(transition.phase) ||
        (transition.phase !== "finished" && transition.final !== null)) {
      throw moduleFailure();
    }
    if (transition.phase !== "finished") return null;
    if (transition.deadlines.length !== 0 || transition.needsActionFrom.length !== 0) {
      throw moduleFailure();
    }
    const result = parseRequestBody(FinalResultSchema, transition.final) as FinalResult;
    parseJsonSchemaValue(registered.manifest.resultSchema, result.data);
    const memberById = new Map(members.map((member) => [member.id, member]));
    const seen = new Set<string>();
    const participants: PreparedFinal["participants"] = [];
    for (const participant of result.participants) {
      const member = memberById.get(participant.memberId);
      if (!member || seen.has(member.id) ||
          !Number.isSafeInteger(participant.score) ||
          participant.score < -2147483648 || participant.score > 2147483647 ||
          (participant.careerEligible &&
            (member.kind !== "registered" || participant.exclusionReasons.length !== 0))) {
        throw moduleFailure();
      }
      seen.add(member.id);
      participants.push({
        ...participant,
        principalId: member.principalId,
        displayName: member.displayName,
      });
    }
    // Departed and removed members retain their per-match attribution too.
    if (seen.size !== members.length) throw moduleFailure();
    const eligible = new Map(participants.filter((participant) => participant.careerEligible)
      .map((participant) => [participant.memberId, participant]));
    const metrics = registered.server!.career(result);
    if (!Array.isArray(metrics)) throw moduleFailure();
    const career: PreparedFinal["career"] = [];
    const seenMetrics = new Set<string>();
    for (const metric of metrics) {
      const participant = metric && eligible.get(metric.memberId);
      if (!participant || seenMetrics.has(metric.memberId) ||
          ![metric.points, metric.played, metric.wins]
            .every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw moduleFailure();
      }
      seenMetrics.add(metric.memberId);
      career.push({ ...metric, principalId: participant.principalId });
    }
    if (seenMetrics.size !== eligible.size) throw moduleFailure();
    // Only reasons shared by every participant describe a match-wide exclusion.
    const eligibilityReasons = result.participants.length === 0 ? [] :
      [...new Set(result.participants[0].exclusionReasons)].filter((reason) =>
        result.participants.every((participant) => participant.exclusionReasons.includes(reason)));
    return { result, participants, career, eligibilityReasons };
  } catch {
    // Never expose schema errors, reducer internals, or private result data.
    throw moduleFailure();
  }
}

/** Called inside the same locked transaction as state, event, deadline and receipt writes. */
export async function persistFinalResult(
  client: Pick<DatabasePool, "query">,
  match: { id: string; module_id: string; module_version: string; mode: string },
  resultVersion: number,
  prepared: PreparedFinal | null,
  revision: number,
  now: string,
): Promise<void> {
  if (!prepared) return;
  const policy = await client.query<{ visibility: string }>(
    `SELECT policy_snapshot->>'statsVisibility' AS visibility
       FROM next_round.matches WHERE id = $1`,
    [match.id],
  );
  const visibility = match.mode === "solo" ? "owner" : policy.rows[0]?.visibility;
  if (visibility !== "owner" && visibility !== "instance") throw moduleFailure();
  await client.query(
    `INSERT INTO next_round.match_results
       (match_id, module_id, module_version, result_version, outcome, raw_result,
        eligibility_reasons, finished_revision, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz)`,
    [match.id, match.module_id, match.module_version, resultVersion,
      prepared.result.outcome, JSON.stringify(prepared.result),
      JSON.stringify(prepared.eligibilityReasons), revision, now],
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
    [match.id, JSON.stringify(prepared.participants)],
  );
  if (prepared.career.length !== 0) {
    await client.query(
      `INSERT INTO next_round.career_contributions
         (match_id, principal_id, module_id, metric_version, points, played, wins, visibility)
       SELECT $1, c."principalId", $2, $3, c.points, c.played, c.wins, $4
         FROM jsonb_to_recordset($5::jsonb) AS c(
           "principalId" uuid, points bigint, played bigint, wins bigint)`,
      [match.id, match.module_id, resultVersion, visibility, JSON.stringify(prepared.career)],
    );
  }
}

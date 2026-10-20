// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import type { DatabasePool } from "@next-round/db";
import type { GameRegistry } from "./registry.js";

export interface ModuleReferenceReport {
  moduleId: string;
  version: string;
  isDefault: boolean;
  matchCounts: {
    lobby: number;
    active: number;
    finished: number;
    total: number;
  };
  resultCount: number;
  hasServer: boolean;
  hasClientAssets: boolean;
  missing: string[];
}

export interface ModuleRetentionReadinessResult {
  ready: boolean;
  referencedVersions: ModuleReferenceReport[];
  errors: string[];
}

interface RawReferenceRow {
  module_id: string;
  version: string;
  is_default: boolean;
  count_lobby: number;
  count_active: number;
  count_finished: number;
  count_total: number;
  count_results: number;
}

/**
 * Inspects all module versions referenced by the database (live matches, finished history,
 * match results, and module default versions) and verifies that runtime/renderer assets
 * (server code and client browser assets) are present in the GameRegistry and on disk.
 *
 * Per Master Spec §8 & §10:
 * - Unreferenced module_versions metadata rows do NOT fail readiness (safe metadata retention).
 * - Referenced versions (including finished history) MUST have server code and client assets.
 * - Missing required code/assets fails with actionable safe references (no secrets leaked).
 * - Never silently falls back to a different version.
 */
export async function checkModuleRetentionReadiness(
  pool: DatabasePool,
  registry: GameRegistry,
): Promise<ModuleRetentionReadinessResult> {
  const result = await pool.query<RawReferenceRow>(
    `SELECT
       ref.module_id,
       ref.version,
       CASE WHEN m_def.id IS NOT NULL THEN true ELSE false END AS is_default,
       COALESCE(mc.lobby, 0)::integer AS count_lobby,
       COALESCE(mc.active, 0)::integer AS count_active,
       COALESCE(mc.finished, 0)::integer AS count_finished,
       COALESCE(mc.total, 0)::integer AS count_total,
       COALESCE(rc.total, 0)::integer AS count_results
     FROM (
       SELECT id AS module_id, default_version AS version FROM next_round.modules
       UNION
       SELECT module_id, module_version AS version FROM next_round.matches
       UNION
       SELECT module_id, module_version AS version FROM next_round.match_results
     ) ref
     LEFT JOIN next_round.modules m_def
       ON m_def.id = ref.module_id AND m_def.default_version = ref.version
     LEFT JOIN (
       SELECT
         module_id,
         module_version AS version,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE phase = 'lobby') AS lobby,
         COUNT(*) FILTER (WHERE phase = 'active') AS active,
         COUNT(*) FILTER (WHERE phase = 'finished') AS finished
       FROM next_round.matches
       GROUP BY module_id, module_version
     ) mc ON mc.module_id = ref.module_id AND mc.version = ref.version
     LEFT JOIN (
       SELECT
         module_id,
         module_version AS version,
         COUNT(*) AS total
       FROM next_round.match_results
       GROUP BY module_id, module_version
     ) rc ON rc.module_id = ref.module_id AND rc.version = ref.version
     ORDER BY ref.module_id, ref.version`,
  );
  const rows = result.rows;

  const referencedVersions: ModuleReferenceReport[] = [];
  const errors: string[] = [];

  for (const row of rows) {
    const regVersion = registry.getVersion(row.module_id, row.version);
    const missing: string[] = [];

    let hasServer = false;
    let hasClientAssets = false;

    if (!regVersion) {
      missing.push("server implementation");
      missing.push("client assets");
    } else {
      if (regVersion.server) {
        hasServer = true;
      } else {
        missing.push("server implementation");
      }

      if (!regVersion.clientAssets || regVersion.clientAssets.size === 0) {
        missing.push("client assets");
      } else {
        let allAssetsExist = true;
        for (const [publicPath, diskPath] of regVersion.clientAssets.entries()) {
          try {
            if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
              missing.push(`client asset "${publicPath}"`);
              allAssetsExist = false;
            }
          } catch {
            missing.push(`client asset "${publicPath}"`);
            allAssetsExist = false;
          }
        }
        if (allAssetsExist) {
          hasClientAssets = true;
        }
      }
    }

    const report: ModuleReferenceReport = {
      moduleId: row.module_id,
      version: row.version,
      isDefault: row.is_default,
      matchCounts: {
        lobby: Number(row.count_lobby),
        active: Number(row.count_active),
        finished: Number(row.count_finished),
        total: Number(row.count_total),
      },
      resultCount: Number(row.count_results),
      hasServer,
      hasClientAssets,
      missing,
    };
    referencedVersions.push(report);

    if (missing.length > 0) {
      const summaryParts: string[] = [];
      if (row.is_default) summaryParts.push(`default version for "${row.module_id}"`);
      if (row.count_total > 0) {
        summaryParts.push(
          `${row.count_total} match${row.count_total === 1 ? "" : "es"} (lobby: ${row.count_lobby}, active: ${row.count_active}, finished: ${row.count_finished})`,
        );
      }
      if (row.count_results > 0) {
        summaryParts.push(`${row.count_results} match result${row.count_results === 1 ? "" : "s"}`);
      }
      const referenceSummary = summaryParts.join("; ") || "referenced";

      const message = `Module retention check failed: module version "${row.module_id}@${row.version}" is required by database references but missing: ${missing.join(", ")}. References: ${referenceSummary}.`;
      errors.push(message);
    }
  }

  return {
    ready: errors.length === 0,
    referencedVersions,
    errors,
  };
}

/**
 * Strict retention verification: verifies readiness and throws an Error with actionable
 * safe references if any database-referenced module version is missing server code or client assets.
 */
export async function verifyModuleRetentionReadiness(
  pool: DatabasePool,
  registry: GameRegistry,
): Promise<ModuleRetentionReadinessResult> {
  const result = await checkModuleRetentionReadiness(pool, registry);
  if (!result.ready) {
    throw new Error(result.errors.join("\n"));
  }
  return result;
}

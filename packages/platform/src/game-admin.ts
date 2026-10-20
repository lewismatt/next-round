// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { AuthenticatedSession } from "./auth-service.js";
import type { GameRegistry, RegisteredGameVersion } from "./registry.js";
import { lockPrincipals, recheckSession, type TransactionClient } from "./transaction-authority.js";

export interface AdminGameVersionSummary {
  version: string;
  installedAt: string;
  hasServer: boolean;
  hasClientAssets: boolean;
  referenceCounts: {
    lobby: number;
    active: number;
    finished: number;
    total: number;
  };
}

export interface AdminGameSummary {
  id: string;
  enabled: boolean;
  defaultVersion: string;
  createdAt: string;
  updatedAt: string;
  versions: AdminGameVersionSummary[];
  referenceCounts: {
    lobby: number;
    active: number;
    finished: number;
    total: number;
  };
}

interface ModuleRow {
  id: string;
  enabled: boolean;
  default_version: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VersionRow {
  module_id: string;
  version: string;
  installed_at: Date | string;
  count_lobby: number;
  count_active: number;
  count_finished: number;
  count_total: number;
}

function checkClientAssetsExist(regVer: RegisteredGameVersion | undefined): boolean {
  if (!regVer?.clientAssets || regVer.clientAssets.size === 0) {
    return false;
  }
  for (const diskPath of regVer.clientAssets.values()) {
    try {
      if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function fetchAdminGames(
  client: TransactionClient,
  registry: GameRegistry,
): Promise<AdminGameSummary[]> {
  const modulesResult = await client.query<ModuleRow>(
    `SELECT id, enabled, default_version, created_at, updated_at
       FROM next_round.modules
      ORDER BY id ASC`,
  );

  if (modulesResult.rows.length === 0) {
    return [];
  }

  const versionsResult = await client.query<VersionRow>(
    `SELECT
       mv.module_id,
       mv.version,
       mv.installed_at,
       COALESCE(mc.lobby, 0)::integer AS count_lobby,
       COALESCE(mc.active, 0)::integer AS count_active,
       COALESCE(mc.finished, 0)::integer AS count_finished,
       COALESCE(mc.total, 0)::integer AS count_total
     FROM next_round.module_versions mv
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
     ) mc ON mc.module_id = mv.module_id AND mc.version = mv.version
     ORDER BY mv.module_id ASC, mv.installed_at ASC, mv.version ASC`,
  );

  const versionsByModule = new Map<string, AdminGameVersionSummary[]>();
  for (const v of versionsResult.rows) {
    const regVer = registry.getVersion(v.module_id, v.version);
    const hasServer = !!regVer?.server;
    const hasClientAssets = checkClientAssetsExist(regVer);
    const versionSummary: AdminGameVersionSummary = {
      version: v.version,
      installedAt: new Date(v.installed_at).toISOString(),
      hasServer,
      hasClientAssets,
      referenceCounts: {
        lobby: Number(v.count_lobby),
        active: Number(v.count_active),
        finished: Number(v.count_finished),
        total: Number(v.count_total),
      },
    };
    const list = versionsByModule.get(v.module_id) ?? [];
    list.push(versionSummary);
    versionsByModule.set(v.module_id, list);
  }

  return modulesResult.rows.map((m) => {
    const versions = versionsByModule.get(m.id) ?? [];
    const totalRef = versions.reduce(
      (acc, v) => ({
        lobby: acc.lobby + v.referenceCounts.lobby,
        active: acc.active + v.referenceCounts.active,
        finished: acc.finished + v.referenceCounts.finished,
        total: acc.total + v.referenceCounts.total,
      }),
      { lobby: 0, active: 0, finished: 0, total: 0 },
    );

    return {
      id: m.id,
      enabled: m.enabled,
      defaultVersion: m.default_version,
      createdAt: new Date(m.created_at).toISOString(),
      updatedAt: new Date(m.updated_at).toISOString(),
      versions,
      referenceCounts: totalRef,
    };
  });
}

/**
 * Lists all installed game modules with durable status, installed versions, and reference counts.
 * Per Master Spec §3 (GET /admin/games).
 * Rechecks administrator authority under the shared transaction locks.
 */
export async function getAdminGames(
  pool: DatabasePool,
  registry: GameRegistry,
  session: AuthenticatedSession,
): Promise<AdminGameSummary[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPrincipals(client, [session.principal.id]);
    await recheckSession(client, session, { admin: true, registered: true });
    const games = await fetchAdminGames(client, registry);
    await client.query("COMMIT");
    return games;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Updates a game module's enabled status or default version.
 * Per Master Spec §3 (PATCH /admin/games/:id):
 * - Can select only installed compatible versions as default_version.
 * - Disable blocks new match creation while existing matches finish.
 * - Rechecks caller session under transaction lock and locks module row FOR UPDATE.
 * - Validates selected exact server and actual assets on disk before durable update.
 */
export async function patchAdminGame(
  pool: DatabasePool,
  registry: GameRegistry,
  session: AuthenticatedSession,
  id: string,
  patch: { enabled?: boolean; defaultVersion?: string },
): Promise<AdminGameSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPrincipals(client, [session.principal.id]);
    await recheckSession(client, session, { admin: true, registered: true });

    const existing = await client.query<ModuleRow>(
      `SELECT id, enabled, default_version, created_at, updated_at
         FROM next_round.modules
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, `Game module '${id}' was not found.`);
    }

    const currentModule = existing.rows[0];

    if (patch.defaultVersion !== undefined) {
      const verCheck = await client.query(
        `SELECT 1 FROM next_round.module_versions WHERE module_id = $1 AND version = $2`,
        [id, patch.defaultVersion],
      );
      if (verCheck.rows.length === 0) {
        throw new ApiError(
          ERROR_CODES.INVALID_REQUEST,
          `Version '${patch.defaultVersion}' is not an installed version of module '${id}'.`,
          { details: { fields: ["/defaultVersion"] } },
        );
      }

      const regVer = registry.getVersion(id, patch.defaultVersion);
      if (!regVer || !regVer.server) {
        throw new ApiError(
          ERROR_CODES.INVALID_REQUEST,
          `Version '${patch.defaultVersion}' does not have a server implementation in the game registry.`,
          { details: { fields: ["/defaultVersion"] } },
        );
      }
      if (!checkClientAssetsExist(regVer)) {
        throw new ApiError(
          ERROR_CODES.INVALID_REQUEST,
          `Version '${patch.defaultVersion}' is missing client assets on disk.`,
          { details: { fields: ["/defaultVersion"] } },
        );
      }
    } else if (patch.enabled === true && !currentModule.enabled) {
      const regVer = registry.getVersion(id, currentModule.default_version);
      if (!regVer || !regVer.server) {
        throw new ApiError(
          ERROR_CODES.INVALID_REQUEST,
          `Default version '${currentModule.default_version}' does not have a server implementation in the game registry.`,
          { details: { fields: ["/enabled"] } },
        );
      }
      if (!checkClientAssetsExist(regVer)) {
        throw new ApiError(
          ERROR_CODES.INVALID_REQUEST,
          `Default version '${currentModule.default_version}' is missing client assets on disk.`,
          { details: { fields: ["/enabled"] } },
        );
      }
    }

    if (patch.enabled !== undefined || patch.defaultVersion !== undefined) {
      await client.query(
        `UPDATE next_round.modules
            SET enabled = COALESCE($2, enabled),
                default_version = COALESCE($3, default_version),
                updated_at = NOW()
          WHERE id = $1`,
        [id, patch.enabled ?? null, patch.defaultVersion ?? null],
      );
    }

    const all = await fetchAdminGames(client, registry);
    const updated = all.find((g) => g.id === id);
    if (!updated) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, `Game module '${id}' was not found.`);
    }

    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// SPDX-License-Identifier: Apache-2.0
import type { GameManifest } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";

/** Install trusted operator-supplied code; preserve administrator choices and
 * immutable version metadata on subsequent starts. The default/version FK is
 * deferred so a fresh installation is committed atomically. */
export async function installGameVersion(
  pool: DatabasePool,
  manifest: GameManifest,
  hashes: { serverHash: string; clientHash: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO next_round.modules (id, default_version) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [manifest.id, manifest.version],
    );
    await client.query(
      `INSERT INTO next_round.module_versions
         (module_id, version, manifest, server_hash, client_hash, sdk_contract, state_version, result_version)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
       ON CONFLICT (module_id, version) DO NOTHING`,
      [manifest.id, manifest.version, JSON.stringify(manifest), hashes.serverHash,
        hashes.clientHash, manifest.sdk, manifest.stateVersion, manifest.resultVersion],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

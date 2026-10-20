// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  ERROR_CODES,
  parseJsonSchemaValue,
  type Json,
} from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import { ResourceImportError } from "@next-round/game-sdk";
import type { Fact, Resource } from "@next-round/game-sdk";
import { createHash } from "node:crypto";
import type { AuthenticatedSession } from "./auth-service.js";
import type { GameRegistry } from "./registry.js";
import { canonicalJson, sameRequestHash } from "./request-hash.js";
import {
  lockPrincipals,
  recheckSession,
  type TransactionClient,
} from "./transaction-authority.js";

/**
 * Shared resources and facts (Master Spec §2 "Shared resources and facts").
 *
 * Resources are versioned, server-private content with public catalog
 * metadata. A match pins one immutable resource version and snapshot. Facts
 * are principal-scoped records attached to one resource identity, so exposure
 * and career rules stay truthful across matches.
 */

const MAX_IMPORT_DOCUMENT_BYTES = 1024 * 1024;
const MAX_IMPORT_ERRORS = 25;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const IMPORT_SCOPE = "game.resource.import";
/** Version of the platform's resource contract (import, metadata, data, facts). */
const RESOURCE_SCHEMA_VERSION = 1;

export interface ImportedResource {
  resourceId: string;
  identity: string;
  version: number;
  duplicate: boolean;
}

export interface ResourceCatalogEntry {
  resourceId: string;
  version: number;
  metadata: Json;
  createdAt: string;
}

export interface ResourceCatalogPage {
  entries: ResourceCatalogEntry[];
  nextCursor: string | null;
}

export interface PinnedResource {
  identityId: string;
  identity: string;
  version: number;
  data: Json;
}

function moduleUnavailable(): ApiError {
  return new ApiError(
    ERROR_CODES.MODULE_UNAVAILABLE,
    "Game module is not available.",
  );
}

function moduleFailure(): ApiError {
  return new ApiError(
    ERROR_CODES.MODULE_FAILURE,
    "The game module could not process this resource.",
  );
}

/**
 * Serializes every command bound to one resource identity. The identity row is
 * locked before the match row so two overlapping matches cannot both observe
 * an unrecorded exposure.
 */
export async function lockResourceIdentity(
  client: TransactionClient,
  identityId: string,
): Promise<void> {
  await client.query(
    "SELECT id FROM next_round.resource_identities WHERE id = $1 FOR UPDATE",
    [identityId],
  );
}

export async function loadResourceById(
  client: TransactionClient,
  moduleId: string,
  resourceId: string,
): Promise<PinnedResource | null> {
  const result = await client.query<{
    identity_id: string;
    identity: string;
    version: number;
    private_data: Json;
  }>(
    `SELECT r.identity_id, ri.identity, r.version, r.private_data
       FROM next_round.module_resources r
       JOIN next_round.resource_identities ri ON ri.id = r.identity_id
      WHERE r.id = $1 AND ri.module_id = $2 AND r.hidden_at IS NULL`,
    [resourceId, moduleId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    identityId: row.identity_id,
    identity: row.identity,
    version: row.version,
    data: row.private_data,
  };
}

/** Loads the pinned resource of a match together with its identity row. */
export async function loadMatchResource(
  client: TransactionClient,
  matchId: string,
): Promise<{ resource: Resource | null; identityId: string | null }> {
  const result = await client.query<{
    resource_id: string | null;
    resource_snapshot: Json | null;
    resource_identity_id: string | null;
    resource_identity: string | null;
    resource_version: number | null;
  }>(
    `SELECT m.resource_id, m.resource_snapshot, r.identity_id AS resource_identity_id,
            ri.identity AS resource_identity, r.version AS resource_version
       FROM next_round.matches m
       LEFT JOIN next_round.module_resources r ON r.id = m.resource_id
       LEFT JOIN next_round.resource_identities ri ON ri.id = r.identity_id
      WHERE m.id = $1`,
    [matchId],
  );
  const row = result.rows[0];
  if (!row || !row.resource_id || !row.resource_snapshot) {
    return { resource: null, identityId: null };
  }
  return {
    identityId: row.resource_identity_id,
    resource: {
      id: row.resource_id,
      identity: row.resource_identity ?? "",
      version: row.resource_version ?? 1,
      data: row.resource_snapshot,
    },
  };
}

/**
 * Loads the facts a module may read for one match: only the facts of the
 * current or proposed members, scoped to the match's pinned resource identity.
 */
export async function loadMatchFacts(
  client: TransactionClient,
  matchId: string,
  principalIds: readonly string[],
): Promise<Fact[]> {
  if (principalIds.length === 0) return [];
  const result = await client.query<{
    principal_id: string;
    fact_key: string;
    value: Json;
  }>(
    `SELECT f.principal_id, f.fact_key, f.value
       FROM next_round.matches m
       JOIN next_round.module_resources r ON r.id = m.resource_id
       JOIN next_round.module_facts f ON f.identity_id = r.identity_id
      WHERE m.id = $1 AND f.principal_id = ANY($2::uuid[])`,
    [matchId, [...principalIds]],
  );
  return result.rows.map((row) => ({
    principalId: row.principal_id,
    key: row.fact_key,
    value: row.value,
  }));
}

/**
 * Writes the facts a transition produced. Facts may only target the
 * principals of the match and are validated against the module's declared
 * fact schemas.
 */
export async function persistMatchFacts(
  client: TransactionClient,
  matchId: string,
  facts: readonly { principalId: string; key: string; value: Json }[],
  memberPrincipalIds: readonly string[],
  factSchemas?: Record<string, unknown>,
): Promise<void> {
  if (facts.length === 0) return;
  const allowed = new Set(memberPrincipalIds.map((id) => id.toLowerCase()));
  for (const fact of facts) {
    if (!allowed.has(fact.principalId.toLowerCase())) throw moduleFailure();
    const schema = factSchemas?.[fact.key];
    if (schema) parseJsonSchemaValue(schema, fact.value);
  }
  const identityResult = await client.query<{ identity_id: string }>(
    `SELECT r.identity_id
       FROM next_round.matches m
       JOIN next_round.module_resources r ON r.id = m.resource_id
      WHERE m.id = $1`,
    [matchId],
  );
  const identityId = identityResult.rows[0]?.identity_id;
  if (!identityId) throw moduleFailure();
  for (const fact of facts) {
    await client.query(
      `INSERT INTO next_round.module_facts
         (identity_id, principal_id, fact_key, value)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (identity_id, principal_id, fact_key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
      [identityId, fact.principalId, fact.key, JSON.stringify(fact.value)],
    );
  }
}

/**
 * Imports a versioned content document for a module. The module validates the
 * document and returns the private data, the public catalog metadata and the
 * importer's exposure facts. The importer is always recorded as exposed, even
 * for a duplicate identity.
 *
 * Receipt scope `game.resource.import` is not a match command: match_id and
 * committed_revision are intentionally NULL. Consumers must select by scope,
 * not assume every command receipt identifies a match/revision. The safe
 * receipt is admin-only and excludes the imported document.
 */
export async function importModuleResource(
  pool: DatabasePool,
  registry: GameRegistry,
  session: AuthenticatedSession,
  moduleId: string,
  input: { commandId: string; document: Json },
): Promise<ImportedResource> {
  const document = input.document;
  const serialized = JSON.stringify(document ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_IMPORT_DOCUMENT_BYTES) {
    throw new ApiError(
      ERROR_CODES.INVALID_REQUEST,
      "The imported document is larger than 1 MiB.",
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPrincipals(client, [session.principal.id]);
    await recheckSession(client, session, { admin: true, registered: true });

    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          route: "POST /api/v1/admin/games/:id/import",
          moduleId,
          document,
        }),
      )
      .digest();
    const prior = await client.query<{
      request_hash: Buffer | Uint8Array | string;
      safe_receipt: Json;
    }>(
      `SELECT request_hash, safe_receipt
         FROM next_round.command_receipts
        WHERE principal_id = $1 AND scope = $2 AND command_id = $3`,
      [session.principal.id, IMPORT_SCOPE, input.commandId],
    );
    if (prior.rows[0]) {
      if (!sameRequestHash(requestHash, prior.rows[0].request_hash)) {
        throw new ApiError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "This command was already used with a different request.",
        );
      }
      const stored = prior.rows[0].safe_receipt;
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
        throw moduleFailure();
      }
      await client.query("COMMIT");
      return stored as unknown as ImportedResource;
    }

    const moduleResult = await client.query<{ default_version: string }>(
      `SELECT default_version FROM next_round.modules
        WHERE id = $1 AND enabled = true FOR SHARE`,
      [moduleId],
    );
    const version = moduleResult.rows[0]?.default_version;
    if (!version) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, "Game module was not found.");
    }
    const registered = registry.getVersion(moduleId, version);
    if (!registered?.server) throw moduleUnavailable();
    const schemas = registered.manifest.resourceSchemas;
    if (!schemas?.import || !registered.server.importResource) {
      throw new ApiError(
        ERROR_CODES.INVALID_REQUEST,
        "This game does not accept imported resources.",
      );
    }

    const validatedDocument = parseJsonSchemaValue(schemas.import, document);
    const now = new Date().toISOString();
    let imported;
    try {
      imported = registered.server.importResource(validatedDocument, {
        principalId: session.principal.id,
        now,
      });
    } catch (error) {
      if (error instanceof ResourceImportError) {
        throw new ApiError(
          ERROR_CODES.RULE_REJECTED,
          "The imported document was rejected.",
          { details: { errors: error.errors.slice(0, MAX_IMPORT_ERRORS) } },
        );
      }
      throw moduleFailure();
    }
    const metadata = parseJsonSchemaValue(schemas.metadata, imported.metadata);
    const data = parseJsonSchemaValue(schemas.data, imported.data);

    const identityResult = await client.query<{ id: string }>(
      `INSERT INTO next_round.resource_identities (module_id, identity)
       VALUES ($1, $2)
       ON CONFLICT (module_id, identity) DO UPDATE SET identity = EXCLUDED.identity
       RETURNING id`,
      [moduleId, imported.identity],
    );
    const identityId = identityResult.rows[0]?.id;
    if (!identityId) throw moduleFailure();
    await lockResourceIdentity(client, identityId);

    const existingResult = await client.query<{
      id: string;
      version: number;
      public_metadata: Json;
      private_data: Json;
    }>(
      `SELECT id, version, public_metadata, private_data
         FROM next_round.module_resources
        WHERE identity_id = $1
        ORDER BY version DESC
        FOR UPDATE`,
      [identityId],
    );
    const existing = existingResult.rows[0];
    // PostgreSQL normalizes jsonb key order, so compare canonical encodings.
    const duplicate =
      existing !== undefined &&
      canonicalJson(existing.public_metadata) === canonicalJson(metadata) &&
      canonicalJson(existing.private_data) === canonicalJson(data);

    let resourceId: string;
    let resourceVersion: number;
    if (duplicate) {
      resourceId = existing.id;
      resourceVersion = existing.version;
    } else {
      resourceVersion = (existing?.version ?? 0) + 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO next_round.module_resources
           (identity_id, version, public_metadata, private_data, schema_version, imported_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         RETURNING id`,
        [
          identityId,
          resourceVersion,
          JSON.stringify(metadata),
          JSON.stringify(data),
          RESOURCE_SCHEMA_VERSION,
          session.principal.id,
        ],
      );
      resourceId = inserted.rows[0]?.id ?? "";
      if (!resourceId) throw moduleFailure();
    }

    const factSchemas = (schemas.facts ?? {}) as Record<string, unknown>;
    for (const fact of imported.importerFacts) {
      const factSchema = factSchemas[fact.key];
      if (factSchema) {
        parseJsonSchemaValue(factSchema, fact.value);
      }
      await client.query(
        `INSERT INTO next_round.module_facts
           (identity_id, principal_id, fact_key, value)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (identity_id, principal_id, fact_key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
        [identityId, session.principal.id, fact.key, JSON.stringify(fact.value)],
      );
    }

    await client.query(
      `INSERT INTO next_round.audit_log
         (actor_id, action, target_type, target_id, safe_metadata)
       VALUES ($1, 'game.resource.import', 'module_resource', $2, $3::jsonb)`,
      [
        session.principal.id,
        resourceId,
        JSON.stringify({ moduleId, version, duplicate }),
      ],
    );

    const receipt: ImportedResource = {
      resourceId,
      identity: imported.identity,
      version: resourceVersion,
      duplicate,
    };
    await client.query(
      `INSERT INTO next_round.command_receipts
         (principal_id, scope, command_id, request_hash, match_id,
          committed_revision, safe_receipt)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5::jsonb)`,
      [
        session.principal.id,
        IMPORT_SCOPE,
        input.commandId,
        requestHash,
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

/**
 * Lists the public catalog of one module. Catalog metadata never contains the
 * private data or the solution-derived identity digest.
 */
export async function listModuleResources(
  pool: DatabasePool,
  moduleId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ResourceCatalogPage> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const result = await pool.query<{
    id: string;
    version: number;
    public_metadata: Json;
    created_at: Date | string;
  }>(
    `SELECT r.id, r.version, r.public_metadata, r.created_at
       FROM next_round.module_resources r
       JOIN next_round.resource_identities ri ON ri.id = r.identity_id
      WHERE ri.module_id = $1 AND r.hidden_at IS NULL
        AND ($2::timestamptz IS NULL OR (r.created_at, r.id) > ($2::timestamptz, $3::uuid))
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT $4`,
    [
      moduleId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const last = rows[rows.length - 1];
  return {
    entries: rows.map((row) => ({
      resourceId: row.id,
      version: row.version,
      metadata: row.public_metadata,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            createdAt: new Date(last.created_at).toISOString(),
            id: last.id,
          })
        : null,
  };
}

interface ResourceCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: ResourceCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): ResourceCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

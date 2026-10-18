import { sql } from "drizzle-orm";
import {
  pgSchema,
  uuid,
  text,
  timestamp,
  bigint,
  boolean,
  integer,
  jsonb,
  customType,
  primaryKey,
  foreignKey,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * PostgreSQL schema: `next_round`
 */
export const nextRound = pgSchema("next_round");

/**
 * Custom bytea column type for binary data (hashes, tokens).
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * 1. principals
 * Unified identity for registered users and ephemeral guests.
 */
export const principals = nextRound.table(
  "principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    authEpoch: bigint("auth_epoch", { mode: "number" }).notNull().default(0),
    inboxRevision: bigint("inbox_revision", { mode: "number" }).notNull().default(0),
    homeRevision: bigint("home_revision", { mode: "number" }).notNull().default(0),
    guestMatchId: uuid("guest_match_id").references((): AnyPgColumn => matches.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("principals_kind_check", sql`${table.kind} IN ('registered', 'guest')`),
    check(
      "principals_guest_match_check",
      sql`(${table.kind} = 'guest' AND ${table.guestMatchId} IS NOT NULL) OR (${table.kind} = 'registered' AND ${table.guestMatchId} IS NULL)`
    ),
  ]
);

/**
 * 2. accounts
 * Registered principal credentials and profile settings.
 */
export const accounts = nextRound.table(
  "accounts",
  {
    principalId: uuid("principal_id")
      .primaryKey()
      .references(() => principals.id),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("member"),
    canInviteRegistrations: boolean("can_invite_registrations").notNull().default(false),
    canInviteGuests: boolean("can_invite_guests").notNull().default(false),
    theme: text("theme").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("accounts_role_check", sql`${table.role} IN ('admin', 'member')`),
    check("accounts_theme_check", sql`${table.theme} IN ('light', 'dark', 'system')`),
  ]
);

/**
 * 3. instance_policy
 * Versioned site configuration and retention policies.
 */
export const instancePolicy = nextRound.table("instance_policy", {
  version: bigint("version", { mode: "number" }).primaryKey(),
  instanceName: text("instance_name").notNull(),
  policy: jsonb("policy").notNull(),
  changedBy: uuid("changed_by")
    .notNull()
    .references(() => principals.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Singleton pointer for current instance policy.
 */
export const instanceSingleton = nextRound.table(
  "instance_singleton",
  {
    id: boolean("id").primaryKey().default(true),
    currentPolicyVersion: bigint("current_policy_version", { mode: "number" })
      .notNull()
      .references(() => instancePolicy.version),
    configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("instance_singleton_id_check", sql`${table.id} = true`)]
);

/**
 * 4. sessions
 * Active opaque authenticated sessions with rolling idle expiry.
 */
export const sessions = nextRound.table(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    tokenHash: bytea("token_hash").notNull().unique(),
    csrfHash: bytea("csrf_hash").notNull(),
    authEpoch: bigint("auth_epoch", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_principal_id_idx").on(table.principalId),
    index("sessions_idle_expires_at_idx").on(table.idleExpiresAt),
    index("sessions_absolute_expires_at_idx").on(table.absoluteExpiresAt),
  ]
);

/**
 * 5. auth_tokens
 * Single-use tokens for passwordless sign-in and password resets.
 */
export const authTokens = nextRound.table(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    tokenHash: bytea("token_hash").notNull().unique(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => principals.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("auth_tokens_kind_check", sql`${table.kind} IN ('signin', 'reset')`),
    index("auth_tokens_principal_kind_idx").on(table.principalId, table.kind),
  ]
);

/**
 * 6. rate_buckets
 * Shared rate-limiting buckets keyed by hashed client identifiers.
 */
export const rateBuckets = nextRound.table(
  "rate_buckets",
  {
    keyHash: bytea("key_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.keyHash, table.windowStart] })]
);

/**
 * 7. audit_log
 * Operator-level administrative change audit records.
 */
export const auditLog = nextRound.table("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => principals.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  safeMetadata: jsonb("safe_metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 8. modules
 * Registered game modules installed on the platform.
 */
export const modules = nextRound.table("modules", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  defaultVersion: text("default_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 9. module_versions
 * Pinned immutable versions and manifests for installed games.
 */
export const moduleVersions = nextRound.table(
  "module_versions",
  {
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id),
    version: text("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    serverHash: text("server_hash").notNull(),
    clientHash: text("client_hash").notNull(),
    sdkContract: text("sdk_contract").notNull(),
    stateVersion: integer("state_version").notNull(),
    resultVersion: integer("result_version").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.moduleId, table.version] })]
);

/**
 * 10. resource_identities
 * Stable identity rows for puzzle content exposure tracking.
 */
export const resourceIdentities = nextRound.table(
  "resource_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id),
    identity: text("identity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("resource_identities_module_identity_idx").on(table.moduleId, table.identity)]
);

/**
 * 11. module_resources
 * Versioned private game content data and public catalog metadata.
 */
export const moduleResources = nextRound.table(
  "module_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => resourceIdentities.id),
    version: integer("version").notNull(),
    publicMetadata: jsonb("public_metadata").notNull(),
    privateData: jsonb("private_data").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    importedBy: uuid("imported_by").references(() => principals.id),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("module_resources_identity_version_idx").on(table.identityId, table.version)]
);

/**
 * 12. module_facts
 * Principal-scoped module facts (e.g. puzzle exposure / seen).
 */
export const moduleFacts = nextRound.table(
  "module_facts",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => resourceIdentities.id),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    factKey: text("fact_key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.identityId, table.principalId, table.factKey] })]
);

/**
 * 13. matches
 * Central match state, revisioning, settings, and lifecycle phase.
 */
export const matches = nextRound.table(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: text("module_id").notNull(),
    moduleVersion: text("module_version").notNull(),
    stateVersion: integer("state_version").notNull(),
    mode: text("mode").notNull(),
    phase: text("phase").notNull().default("lobby"),
    creatorId: uuid("creator_id")
      .notNull()
      .references((): AnyPgColumn => principals.id),
    hostMemberId: uuid("host_member_id"),
    resourceId: uuid("resource_id").references(() => moduleResources.id),
    resourceSnapshot: jsonb("resource_snapshot"),
    settings: jsonb("settings").notNull(),
    visibility: text("visibility").notNull(),
    policyVersion: bigint("policy_version", { mode: "number" })
      .notNull()
      .references(() => instancePolicy.version),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    state: jsonb("state"),
    statePrunedAt: timestamp("state_pruned_at", { withTimezone: true }),
    chatRevision: bigint("chat_revision", { mode: "number" }).notNull().default(0),
    needsActionFrom: uuid("needs_action_from")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("matches_phase_check", sql`${table.phase} IN ('lobby', 'active', 'finished')`),
    check("matches_visibility_check", sql`${table.visibility} IN ('invite', 'instance', 'private')`),
    check("matches_revision_check", sql`${table.revision} >= 0`),
    foreignKey({
      columns: [table.moduleId, table.moduleVersion],
      foreignColumns: [moduleVersions.moduleId, moduleVersions.version],
      name: "matches_module_version_fk",
    }),
    index("matches_phase_module_idx").on(table.phase, table.moduleId),
    index("matches_updated_at_idx").on(table.updatedAt),
  ]
);

/**
 * 14. match_members
 * Seats and participation status within a specific match.
 */
export const matchMembers = nextRound.table(
  "match_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    status: text("status").notNull().default("active"),
    joinOrdinal: bigint("join_ordinal", { mode: "number" }).notNull(),
    accessEpoch: bigint("access_epoch", { mode: "number" }).notNull().default(0),
    chatFromAt: timestamp("chat_from_at", { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    departedAt: timestamp("departed_at", { withTimezone: true }),
  },
  (table) => [
    check("match_members_status_check", sql`${table.status} IN ('active', 'left', 'removed')`),
    uniqueIndex("match_members_match_principal_idx").on(table.matchId, table.principalId),
    uniqueIndex("match_members_match_join_ordinal_idx").on(table.matchId, table.joinOrdinal),
  ]
);

/**
 * 15. member_periods
 * Participation and rejoin historical intervals for members.
 */
export const memberPeriods = nextRound.table(
  "member_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => matchMembers.id),
    accessEpoch: bigint("access_epoch", { mode: "number" }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    departureReason: text("departure_reason"),
  },
  (table) => [uniqueIndex("member_periods_member_epoch_idx").on(table.memberId, table.accessEpoch)]
);

/**
 * 16. invitations
 * Invitations for registration, direct match join, or guest admission.
 */
export const invitations = nextRound.table(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => principals.id),
    recipientId: uuid("recipient_id").references(() => principals.id),
    matchId: uuid("match_id").references(() => matches.id),
    tokenHash: bytea("token_hash").unique(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedBy: uuid("consumed_by").references(() => principals.id),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("invitations_kind_check", sql`${table.kind} IN ('registration', 'member', 'guest')`),
    check("invitations_status_check", sql`${table.status} IN ('pending', 'accepted', 'declined', 'revoked')`),
    index("invitations_recipient_status_idx").on(table.recipientId, table.status),
    index("invitations_issuer_status_idx").on(table.issuerId, table.status),
  ]
);

/**
 * 17. match_links
 * Reusable match join links with single live active token per match.
 */
export const matchLinks = nextRound.table(
  "match_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    tokenHash: bytea("token_hash").notNull().unique(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => principals.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("match_links_live_match_idx")
      .on(table.matchId)
      .where(sql`${table.revokedAt} IS NULL`),
  ]
);

/**
 * 18. command_receipts
 * Idempotency receipts for accepted mutating commands.
 */
export const commandReceipts = nextRound.table(
  "command_receipts",
  {
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    scope: text("scope").notNull(),
    commandId: uuid("command_id").notNull(),
    requestHash: bytea("request_hash").notNull(),
    matchId: uuid("match_id").references(() => matches.id),
    committedRevision: bigint("committed_revision", { mode: "number" }),
    safeReceipt: jsonb("safe_receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.scope, table.commandId] })]
);

/**
 * 19. match_events
 * Audit trail of accepted match transitions and system actions.
 */
export const matchEvents = nextRound.table(
  "match_events",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    revision: bigint("revision", { mode: "number" }).notNull(),
    eventId: uuid("event_id").notNull().unique(),
    actorId: uuid("actor_id").references(() => principals.id),
    kind: text("kind").notNull(),
    safeMetadata: jsonb("safe_metadata").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.matchId, table.revision] })]
);

/**
 * 20. match_deadlines
 * Durable match timeout obligations and countdown timer states.
 */
export const matchDeadlines = nextRound.table(
  "match_deadlines",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    key: text("key").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    eventId: uuid("event_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("match_deadlines_status_check", sql`${table.status} IN ('pending', 'consumed', 'cancelled')`),
    primaryKey({ columns: [table.matchId, table.key, table.generation] }),
    index("match_deadlines_due_at_pending_idx")
      .on(table.dueAt)
      .where(sql`${table.status} = 'pending'`),
  ]
);

/**
 * 21. outbox
 * Transactionally enqueued events for notifications, invalidations, and async tasks.
 */
export const outbox = nextRound.table(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topic: text("topic").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateRevision: bigint("aggregate_revision", { mode: "number" }),
    dedupeKey: text("dedupe_key").notNull().unique(),
    safePayload: jsonb("safe_payload").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("outbox_available_at_pending_idx")
      .on(table.availableAt)
      .where(sql`${table.deliveredAt} IS NULL`),
  ]
);

/**
 * 22. chat_messages
 * Ephemeral in-match messages scoped to participation epoch.
 */
export const chatMessages = nextRound.table(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => principals.id),
    commandId: uuid("command_id").notNull(),
    membershipEpoch: bigint("membership_epoch", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("chat_messages_match_sender_command_idx").on(table.matchId, table.senderId, table.commandId),
    index("chat_messages_match_created_id_idx").on(table.matchId, table.createdAt, table.id),
  ]
);

/**
 * 23. notifications
 * User inbox notifications for invitations, turns, and results.
 */
export const notifications = nextRound.table(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    matchId: uuid("match_id").references(() => matches.id),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    safePayload: jsonb("safe_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "notifications_kind_check",
      sql`${table.kind} IN ('invitation', 'action_required', 'turn_missed', 'result')`
    ),
    uniqueIndex("notifications_principal_dedupe_idx").on(table.principalId, table.dedupeKey),
    index("notifications_principal_read_created_idx").on(table.principalId, table.readAt, table.createdAt),
  ]
);

/**
 * 24. match_results
 * Immutable match outcomes, scores, and resolution records.
 */
export const matchResults = nextRound.table(
  "match_results",
  {
    matchId: uuid("match_id")
      .primaryKey()
      .references(() => matches.id),
    moduleId: text("module_id").notNull(),
    moduleVersion: text("module_version").notNull(),
    resultVersion: integer("result_version").notNull(),
    outcome: text("outcome").notNull(),
    rawResult: jsonb("raw_result").notNull(),
    eligibilityReasons: jsonb("eligibility_reasons").notNull(),
    finishedRevision: bigint("finished_revision", { mode: "number" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.moduleId, table.moduleVersion],
      foreignColumns: [moduleVersions.moduleId, moduleVersions.version],
      name: "match_results_module_version_fk",
    }),
  ]
);

/**
 * 25. participant_results
 * Per-member scores, achievements, and career eligibility outcomes.
 */
export const participantResults = nextRound.table(
  "participant_results",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => matchMembers.id),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    score: integer("score").notNull(),
    contribution: jsonb("contribution").notNull(),
    win: boolean("win").notNull(),
    careerEligible: boolean("career_eligible").notNull(),
    exclusionReasons: jsonb("exclusion_reasons").notNull(),
    displayNameSnapshot: text("display_name_snapshot").notNull(),
  },
  (table) => [primaryKey({ columns: [table.matchId, table.memberId] })]
);

/**
 * 26. career_contributions
 * Aggregated leaderboard contribution records for eligible registered users.
 */
export const careerContributions = nextRound.table(
  "career_contributions",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id),
    metricVersion: integer("metric_version").notNull(),
    points: bigint("points", { mode: "number" }).notNull().default(0),
    played: bigint("played", { mode: "number" }).notNull().default(0),
    wins: bigint("wins", { mode: "number" }).notNull().default(0),
    visibility: text("visibility").notNull(),
  },
  (table) => [
    check("career_contributions_visibility_check", sql`${table.visibility} IN ('owner', 'instance')`),
    primaryKey({ columns: [table.matchId, table.principalId] }),
  ]
);

/**
 * 27. maintenance_plans
 * Operator-approved migration and maintenance plans.
 */
export const maintenancePlans = nextRound.table("maintenance_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => principals.id),
  policyVersion: bigint("policy_version", { mode: "number" })
    .notNull()
    .references(() => instancePolicy.version),
  targetManifest: jsonb("target_manifest").notNull(),
  counts: jsonb("counts").notNull(),
  confirmationHash: bytea("confirmation_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * All tables object for Drizzle client initialization.
 */
export const tables = {
  principals,
  accounts,
  instancePolicy,
  instanceSingleton,
  sessions,
  authTokens,
  rateBuckets,
  auditLog,
  modules,
  moduleVersions,
  resourceIdentities,
  moduleResources,
  moduleFacts,
  matches,
  matchMembers,
  memberPeriods,
  invitations,
  matchLinks,
  commandReceipts,
  matchEvents,
  matchDeadlines,
  outbox,
  chatMessages,
  notifications,
  matchResults,
  participantResults,
  careerContributions,
  maintenancePlans,
};

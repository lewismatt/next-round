CREATE SCHEMA "next_round";
--> statement-breakpoint
CREATE TABLE "next_round"."accounts" (
	"principal_id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"can_invite_registrations" boolean DEFAULT false NOT NULL,
	"can_invite_guests" boolean DEFAULT false NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_username_unique" UNIQUE("username"),
	CONSTRAINT "accounts_role_check" CHECK ("next_round"."accounts"."role" IN ('admin', 'member')),
	CONSTRAINT "accounts_theme_check" CHECK ("next_round"."accounts"."theme" IN ('light', 'dark', 'system'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"safe_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"principal_id" uuid NOT NULL,
	"issuer_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_tokens_kind_check" CHECK ("next_round"."auth_tokens"."kind" IN ('signin', 'reset'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."career_contributions" (
	"match_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"metric_version" integer NOT NULL,
	"points" bigint DEFAULT 0 NOT NULL,
	"played" bigint DEFAULT 0 NOT NULL,
	"wins" bigint DEFAULT 0 NOT NULL,
	"visibility" text NOT NULL,
	CONSTRAINT "career_contributions_match_id_principal_id_pk" PRIMARY KEY("match_id","principal_id"),
	CONSTRAINT "career_contributions_visibility_check" CHECK ("next_round"."career_contributions"."visibility" IN ('owner', 'instance'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"membership_epoch" bigint NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "next_round"."command_receipts" (
	"principal_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"command_id" uuid NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"match_id" uuid,
	"committed_revision" bigint,
	"safe_receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_principal_id_scope_command_id_pk" PRIMARY KEY("principal_id","scope","command_id")
);
--> statement-breakpoint
CREATE TABLE "next_round"."instance_policy" (
	"version" bigint PRIMARY KEY NOT NULL,
	"instance_name" text NOT NULL,
	"policy" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."instance_singleton" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"current_policy_version" bigint NOT NULL,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_singleton_id_check" CHECK ("next_round"."instance_singleton"."id" = true)
);
--> statement-breakpoint
CREATE TABLE "next_round"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"issuer_id" uuid NOT NULL,
	"recipient_id" uuid,
	"match_id" uuid,
	"token_hash" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_kind_check" CHECK ("next_round"."invitations"."kind" IN ('registration', 'member', 'guest')),
	CONSTRAINT "invitations_status_check" CHECK ("next_round"."invitations"."status" IN ('pending', 'accepted', 'declined', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."maintenance_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"policy_version" bigint NOT NULL,
	"target_manifest" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"confirmation_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."match_deadlines" (
	"match_id" uuid NOT NULL,
	"key" text NOT NULL,
	"generation" bigint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_deadlines_match_id_key_generation_pk" PRIMARY KEY("match_id","key","generation"),
	CONSTRAINT "match_deadlines_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "match_deadlines_status_check" CHECK ("next_round"."match_deadlines"."status" IN ('pending', 'consumed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."match_events" (
	"match_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"safe_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_events_match_id_revision_pk" PRIMARY KEY("match_id","revision"),
	CONSTRAINT "match_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "next_round"."match_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"issued_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "next_round"."match_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"join_ordinal" bigint NOT NULL,
	"access_epoch" bigint DEFAULT 0 NOT NULL,
	"chat_from_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"departed_at" timestamp with time zone,
	CONSTRAINT "match_members_status_check" CHECK ("next_round"."match_members"."status" IN ('active', 'left', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."match_results" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"module_version" text NOT NULL,
	"result_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"raw_result" jsonb NOT NULL,
	"eligibility_reasons" jsonb NOT NULL,
	"finished_revision" bigint NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" text NOT NULL,
	"module_version" text NOT NULL,
	"state_version" integer NOT NULL,
	"mode" text NOT NULL,
	"phase" text DEFAULT 'lobby' NOT NULL,
	"creator_id" uuid NOT NULL,
	"host_member_id" uuid,
	"resource_id" uuid,
	"resource_snapshot" jsonb,
	"settings" jsonb NOT NULL,
	"visibility" text NOT NULL,
	"policy_version" bigint NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"state" jsonb,
	"state_pruned_at" timestamp with time zone,
	"chat_revision" bigint DEFAULT 0 NOT NULL,
	"needs_action_from" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_phase_check" CHECK ("next_round"."matches"."phase" IN ('lobby', 'active', 'finished')),
	CONSTRAINT "matches_visibility_check" CHECK ("next_round"."matches"."visibility" IN ('invite', 'instance', 'private')),
	CONSTRAINT "matches_revision_check" CHECK ("next_round"."matches"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "next_round"."member_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"access_epoch" bigint NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"departed_at" timestamp with time zone,
	"departure_reason" text
);
--> statement-breakpoint
CREATE TABLE "next_round"."module_facts" (
	"identity_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_facts_identity_id_principal_id_fact_key_pk" PRIMARY KEY("identity_id","principal_id","fact_key")
);
--> statement-breakpoint
CREATE TABLE "next_round"."module_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"public_metadata" jsonb NOT NULL,
	"private_data" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"imported_by" uuid,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."module_versions" (
	"module_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"server_hash" text NOT NULL,
	"client_hash" text NOT NULL,
	"sdk_contract" text NOT NULL,
	"state_version" integer NOT NULL,
	"result_version" integer NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_versions_module_id_version_pk" PRIMARY KEY("module_id","version")
);
--> statement-breakpoint
CREATE TABLE "next_round"."modules" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_id" uuid NOT NULL,
	"match_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"safe_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "notifications_kind_check" CHECK ("next_round"."notifications"."kind" IN ('invitation', 'action_required', 'turn_missed', 'result'))
);
--> statement-breakpoint
CREATE TABLE "next_round"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_revision" bigint,
	"dedupe_key" text NOT NULL,
	"safe_payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "next_round"."participant_results" (
	"match_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"contribution" jsonb NOT NULL,
	"win" boolean NOT NULL,
	"career_eligible" boolean NOT NULL,
	"exclusion_reasons" jsonb NOT NULL,
	"display_name_snapshot" text NOT NULL,
	CONSTRAINT "participant_results_match_id_member_id_pk" PRIMARY KEY("match_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "next_round"."principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"auth_epoch" bigint DEFAULT 0 NOT NULL,
	"inbox_revision" bigint DEFAULT 0 NOT NULL,
	"home_revision" bigint DEFAULT 0 NOT NULL,
	"guest_match_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_kind_check" CHECK ("next_round"."principals"."kind" IN ('registered', 'guest')),
	CONSTRAINT "principals_guest_match_check" CHECK (("next_round"."principals"."kind" = 'guest' AND "next_round"."principals"."guest_match_id" IS NOT NULL) OR ("next_round"."principals"."kind" = 'registered' AND "next_round"."principals"."guest_match_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "next_round"."rate_buckets" (
	"key_hash" "bytea" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_buckets_key_hash_window_start_pk" PRIMARY KEY("key_hash","window_start")
);
--> statement-breakpoint
CREATE TABLE "next_round"."resource_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" text NOT NULL,
	"identity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_round"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"csrf_hash" "bytea" NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- Reviewed ordering: create the composite host FK's unique target before
-- adding foreign keys; Drizzle otherwise emits unique indexes after them.
CREATE UNIQUE INDEX "match_members_match_id_id_idx" ON "next_round"."match_members" USING btree ("match_id","id");--> statement-breakpoint
ALTER TABLE "next_round"."accounts" ADD CONSTRAINT "accounts_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."audit_log" ADD CONSTRAINT "audit_log_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."auth_tokens" ADD CONSTRAINT "auth_tokens_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."auth_tokens" ADD CONSTRAINT "auth_tokens_issuer_id_principals_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."career_contributions" ADD CONSTRAINT "career_contributions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."career_contributions" ADD CONSTRAINT "career_contributions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."career_contributions" ADD CONSTRAINT "career_contributions_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "next_round"."modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."chat_messages" ADD CONSTRAINT "chat_messages_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."chat_messages" ADD CONSTRAINT "chat_messages_sender_id_principals_id_fk" FOREIGN KEY ("sender_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."command_receipts" ADD CONSTRAINT "command_receipts_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."command_receipts" ADD CONSTRAINT "command_receipts_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."instance_policy" ADD CONSTRAINT "instance_policy_changed_by_principals_id_fk" FOREIGN KEY ("changed_by") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."instance_singleton" ADD CONSTRAINT "instance_singleton_current_policy_version_instance_policy_version_fk" FOREIGN KEY ("current_policy_version") REFERENCES "next_round"."instance_policy"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."invitations" ADD CONSTRAINT "invitations_issuer_id_principals_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."invitations" ADD CONSTRAINT "invitations_recipient_id_principals_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."invitations" ADD CONSTRAINT "invitations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."invitations" ADD CONSTRAINT "invitations_consumed_by_principals_id_fk" FOREIGN KEY ("consumed_by") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."maintenance_plans" ADD CONSTRAINT "maintenance_plans_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."maintenance_plans" ADD CONSTRAINT "maintenance_plans_policy_version_instance_policy_version_fk" FOREIGN KEY ("policy_version") REFERENCES "next_round"."instance_policy"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_deadlines" ADD CONSTRAINT "match_deadlines_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_events" ADD CONSTRAINT "match_events_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_links" ADD CONSTRAINT "match_links_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_links" ADD CONSTRAINT "match_links_issued_by_principals_id_fk" FOREIGN KEY ("issued_by") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_members" ADD CONSTRAINT "match_members_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_members" ADD CONSTRAINT "match_members_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_results" ADD CONSTRAINT "match_results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."match_results" ADD CONSTRAINT "match_results_module_version_fk" FOREIGN KEY ("module_id","module_version") REFERENCES "next_round"."module_versions"("module_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."matches" ADD CONSTRAINT "matches_creator_id_principals_id_fk" FOREIGN KEY ("creator_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."matches" ADD CONSTRAINT "matches_resource_id_module_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "next_round"."module_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."matches" ADD CONSTRAINT "matches_policy_version_instance_policy_version_fk" FOREIGN KEY ("policy_version") REFERENCES "next_round"."instance_policy"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."matches" ADD CONSTRAINT "matches_module_version_fk" FOREIGN KEY ("module_id","module_version") REFERENCES "next_round"."module_versions"("module_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."matches" ADD CONSTRAINT "matches_host_member_fk" FOREIGN KEY ("id","host_member_id") REFERENCES "next_round"."match_members"("match_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."member_periods" ADD CONSTRAINT "member_periods_member_id_match_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "next_round"."match_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."module_facts" ADD CONSTRAINT "module_facts_identity_id_resource_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "next_round"."resource_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."module_facts" ADD CONSTRAINT "module_facts_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."module_resources" ADD CONSTRAINT "module_resources_identity_id_resource_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "next_round"."resource_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."module_resources" ADD CONSTRAINT "module_resources_imported_by_principals_id_fk" FOREIGN KEY ("imported_by") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."module_versions" ADD CONSTRAINT "module_versions_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "next_round"."modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."modules" ADD CONSTRAINT "modules_default_version_fk" FOREIGN KEY ("id","default_version") REFERENCES "next_round"."module_versions"("module_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."notifications" ADD CONSTRAINT "notifications_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."notifications" ADD CONSTRAINT "notifications_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."participant_results" ADD CONSTRAINT "participant_results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "next_round"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."participant_results" ADD CONSTRAINT "participant_results_member_id_match_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "next_round"."match_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."participant_results" ADD CONSTRAINT "participant_results_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."principals" ADD CONSTRAINT "principals_guest_match_id_matches_id_fk" FOREIGN KEY ("guest_match_id") REFERENCES "next_round"."matches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."resource_identities" ADD CONSTRAINT "resource_identities_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "next_round"."modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_round"."sessions" ADD CONSTRAINT "sessions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "next_round"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_tokens_principal_kind_idx" ON "next_round"."auth_tokens" USING btree ("principal_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_match_sender_command_idx" ON "next_round"."chat_messages" USING btree ("match_id","sender_id","command_id");--> statement-breakpoint
CREATE INDEX "chat_messages_match_created_id_idx" ON "next_round"."chat_messages" USING btree ("match_id","created_at","id");--> statement-breakpoint
CREATE INDEX "invitations_recipient_status_idx" ON "next_round"."invitations" USING btree ("recipient_id","status");--> statement-breakpoint
CREATE INDEX "invitations_issuer_status_idx" ON "next_round"."invitations" USING btree ("issuer_id","status");--> statement-breakpoint
CREATE INDEX "match_deadlines_due_at_pending_idx" ON "next_round"."match_deadlines" USING btree ("due_at") WHERE "next_round"."match_deadlines"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "match_links_live_match_idx" ON "next_round"."match_links" USING btree ("match_id") WHERE "next_round"."match_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "match_members_match_principal_idx" ON "next_round"."match_members" USING btree ("match_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_members_match_join_ordinal_idx" ON "next_round"."match_members" USING btree ("match_id","join_ordinal");--> statement-breakpoint
CREATE INDEX "matches_phase_module_idx" ON "next_round"."matches" USING btree ("phase","module_id");--> statement-breakpoint
CREATE INDEX "matches_updated_at_idx" ON "next_round"."matches" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "member_periods_member_epoch_idx" ON "next_round"."member_periods" USING btree ("member_id","access_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "module_resources_identity_version_idx" ON "next_round"."module_resources" USING btree ("identity_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_principal_dedupe_idx" ON "next_round"."notifications" USING btree ("principal_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_principal_read_created_idx" ON "next_round"."notifications" USING btree ("principal_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "outbox_available_at_pending_idx" ON "next_round"."outbox" USING btree ("available_at") WHERE "next_round"."outbox"."delivered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_identities_module_identity_idx" ON "next_round"."resource_identities" USING btree ("module_id","identity");--> statement-breakpoint
CREATE INDEX "sessions_principal_id_idx" ON "next_round"."sessions" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "sessions_idle_expires_at_idx" ON "next_round"."sessions" USING btree ("idle_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_at_idx" ON "next_round"."sessions" USING btree ("absolute_expires_at");
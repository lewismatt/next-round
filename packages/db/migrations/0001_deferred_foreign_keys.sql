-- Drizzle models these relationships but cannot encode PostgreSQL deferrability.
-- Keep the foreign keys in schema.ts and the generated snapshots: this overlay
-- changes only their timing, so later generation does not drop the relationships.
-- Any later migration recreating one must restore these attributes in its
-- reviewed SQL. RESTRICT deletes remain immediate; insert/update references
-- are checked at commit, permitting atomic registry and guest/match/host inserts.
ALTER TABLE "next_round"."principals"
  ALTER CONSTRAINT "principals_guest_match_id_matches_id_fk"
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "next_round"."modules"
  ALTER CONSTRAINT "modules_default_version_fk"
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "next_round"."matches"
  ALTER CONSTRAINT "matches_host_member_fk"
  DEFERRABLE INITIALLY DEFERRED;
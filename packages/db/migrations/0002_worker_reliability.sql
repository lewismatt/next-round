ALTER TABLE next_round.outbox ADD COLUMN dead_lettered_at timestamptz, ADD COLUMN last_error_code text;
--> statement-breakpoint
DROP INDEX next_round.outbox_available_at_pending_idx;
--> statement-breakpoint
CREATE INDEX outbox_available_at_pending_idx ON next_round.outbox (available_at) WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
--> statement-breakpoint
CREATE INDEX rate_buckets_expires_at_idx ON next_round.rate_buckets (expires_at);
--> statement-breakpoint
CREATE FUNCTION next_round.notify_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('next_round_outbox', ''); RETURN NULL; END $$;
--> statement-breakpoint
CREATE TRIGGER outbox_insert_wakeup AFTER INSERT ON next_round.outbox FOR EACH STATEMENT EXECUTE FUNCTION next_round.notify_outbox_insert();
--> statement-breakpoint
CREATE INDEX invitations_guest_expiry_idx ON next_round.invitations (expires_at) WHERE kind = 'guest' AND status <> 'accepted';

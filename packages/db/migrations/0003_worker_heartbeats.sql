CREATE TABLE next_round.worker_heartbeats (
	worker_id text PRIMARY KEY NOT NULL,
	started_at timestamp with time zone NOT NULL,
	last_seen_at timestamp with time zone NOT NULL
);

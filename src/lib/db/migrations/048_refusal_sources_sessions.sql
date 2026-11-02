-- 048_refusal_sources_sessions — distinguish Jev/upstream cache rows and block inbound sessions.
ALTER TABLE refusal_guards ADD COLUMN source TEXT NOT NULL DEFAULT 'upstream';
ALTER TABLE refusal_guards ADD COLUMN error_code TEXT;
ALTER TABLE refusal_guards ADD COLUMN error_status INTEGER;

CREATE TABLE IF NOT EXISTS refusal_session_blocks (
  session_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_request_id TEXT,
  fingerprint TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_refusal_session_last_seen ON refusal_session_blocks(last_seen_at);

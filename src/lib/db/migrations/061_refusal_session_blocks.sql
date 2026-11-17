-- 059_refusal_session_blocks — a caller session the provider refused once is
-- never sent upstream again. Keyed by the root Claude Code session (sub-agents
-- of a refused session share the block). Permanent until an operator lifts it.

CREATE TABLE IF NOT EXISTS refusal_session_blocks (
  session_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_request_id TEXT,
  account_id TEXT,
  model TEXT,
  preview TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_refusal_session_last_seen ON refusal_session_blocks(last_seen_at);

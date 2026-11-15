ALTER TABLE usage_logs ADD COLUMN usage_account_id TEXT;

CREATE TABLE account_lifetime_usage_archive (
  account_id TEXT PRIMARY KEY,
  total_cost REAL NOT NULL,
  total_tokens INTEGER NOT NULL
);

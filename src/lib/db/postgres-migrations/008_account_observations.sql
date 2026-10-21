-- Tickets are allocated before an asynchronous observation is persisted.
-- Per-field revisions reject older completions without replacing other observations.
ALTER TABLE accounts ADD COLUMN observation_versions jsonb NOT NULL DEFAULT '{}';
CREATE SEQUENCE account_observation_seq OWNED BY accounts.observation_versions;

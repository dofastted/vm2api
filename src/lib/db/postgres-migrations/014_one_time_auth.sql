CREATE TABLE oauth_pkce_sessions (
  kind text NOT NULL CHECK (kind IN ('anthropic', 'codex')),
  id_hash text NOT NULL,
  resource_id text NOT NULL,
  encrypted_session text NOT NULL,
  expires_at timestamptz NOT NULL,
  claim_id text,
  PRIMARY KEY (kind, id_hash)
);
CREATE INDEX oauth_pkce_sessions_expiry ON oauth_pkce_sessions (expires_at);

CREATE TABLE shell_tickets (
  purpose text NOT NULL CHECK (purpose IN ('slot', 'node')),
  ticket_hash text NOT NULL,
  resource_id text NOT NULL,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (purpose, ticket_hash)
);
CREATE INDEX shell_tickets_expiry ON shell_tickets (expires_at);

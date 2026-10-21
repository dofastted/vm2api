CREATE TABLE panel_sessions (
  token_hash text COLLATE "C" PRIMARY KEY,
  username text COLLATE "C" NOT NULL,
  role text COLLATE "C" NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX idx_panel_sessions_username ON panel_sessions (username);
CREATE INDEX idx_panel_sessions_expires_at ON panel_sessions (expires_at);

-- Adds player accounts to a stats database created before them. Run it once:
--   npx wrangler d1 execute sevens-out-stats --remote -c server/cloudflare/wrangler.jsonc --file server/d1/migrations/0001-accounts.sql --yes
-- A second run stops at the ALTER TABLE (duplicate column). Fresh databases use schema.sql, which already has all of this.
ALTER TABLE players ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS players_user ON players (user_id);

-- Player accounts: one user per player, signed in with passkeys (WebAuthn).
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY, -- 16 hex, random; also the WebAuthn user handle
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT PRIMARY KEY, -- credential id, base64url
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,    -- SPKI, base64url
  alg          INTEGER NOT NULL, -- COSE algorithm: -7 ES256, -257 RS256
  sign_count   INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,             -- JSON array
  synced       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);

-- Only SHA-256 of a session token is stored. Sessions slide: expires_at moves on when used.
CREATE TABLE IF NOT EXISTS sessions (
  hash         TEXT PRIMARY KEY, -- SHA-256 hex of the token
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- WebAuthn challenges, single use: deleted when taken.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('create', 'signin', 'add')),
  user_id    TEXT, -- 'add': the signed-in user
  name       TEXT, -- 'create': the new player's name
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_expires ON auth_challenges (expires_at);

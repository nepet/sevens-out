-- Sevens Out statistics and player accounts (D1). Load with: npm run db:schema (remote) or tests/e2e/d1-setup.mjs (local).
-- A database created before accounts gets them from server/d1/migrations/0001-accounts.sql instead (once).
-- One row per game; players and turns are replaced whenever the game is recorded again.
CREATE TABLE IF NOT EXISTS games (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('online', 'phone')),
  mode         TEXT NOT NULL CHECK (mode IN ('dice', 'score')),
  room_code    TEXT,
  status       TEXT NOT NULL CHECK (status IN ('playing', 'over', 'abandoned')),
  early        INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER,
  finished_at  INTEGER,
  rounds       INTEGER,
  player_count INTEGER NOT NULL,
  loser        TEXT,
  top_score    INTEGER,
  margin       INTEGER,
  sheet        TEXT
);
CREATE INDEX IF NOT EXISTS games_finished ON games (status, finished_at);
CREATE INDEX IF NOT EXISTS games_started ON games (status, started_at);

CREATE TABLE IF NOT EXISTS players (
  game_id     TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  score       INTEGER NOT NULL,
  lost        INTEGER NOT NULL,
  sevens_outs INTEGER NOT NULL,
  shots       INTEGER NOT NULL,
  turns       INTEGER NOT NULL,
  user_id     TEXT, -- the player's account, if any; no foreign key, so the row outlives a deleted account
  PRIMARY KEY (game_id, idx)
);
CREATE INDEX IF NOT EXISTS players_name ON players (name_key);
CREATE INDEX IF NOT EXISTS players_user ON players (user_id);

CREATE TABLE IF NOT EXISTS turns (
  game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  round   INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  pts     INTEGER NOT NULL,
  rolls   INTEGER,
  starter INTEGER NOT NULL,
  mark    INTEGER,
  PRIMARY KEY (game_id, round, idx)
);

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

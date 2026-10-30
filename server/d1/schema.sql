-- Sevens Out statistics and player accounts (D1). Load with: npm run db:schema (remote) or tests/e2e/d1-setup.mjs (local).
-- A database created before accounts gets them from server/d1/migrations/0001-accounts.sql instead (once),
-- one created before the rooms from 0002-rooms.sql, and one created before 42/18 and Schocken from 0003-kinds.sql.
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
  sheet        TEXT,
  kind         TEXT NOT NULL DEFAULT 'sevens' CHECK (kind IN ('sevens', '4218', 'schocken')) -- the game: Sevens Out, 42/18, Schocken
);
CREATE INDEX IF NOT EXISTS games_finished ON games (status, finished_at);
CREATE INDEX IF NOT EXISTS games_started ON games (status, started_at);
CREATE INDEX IF NOT EXISTS games_kind ON games (kind, status, finished_at);

CREATE TABLE IF NOT EXISTS players (
  game_id     TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  score       INTEGER NOT NULL, -- Sevens Out: points; 42/18: coasters; Schocken: coasters in the last half played
  lost        INTEGER NOT NULL,
  sevens_outs INTEGER NOT NULL, -- turns with the game's top throw: a Sevens Out, a 42/18, a Schock out
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
  pts     INTEGER NOT NULL, -- Sevens Out: points; 42/18: the throw's points (0 = no 42); Schocken: the throw's worth in coasters
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

-- Online rooms for the admin page: one row per room, written by the room as things happen (server/core/room.js track).
-- A code can come back once its room is gone, so rows key on the room's own id.
CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT PRIMARY KEY, -- 16 hex, made with the room
  code           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  active_at      INTEGER NOT NULL, -- the room's last change (a move, a seat, a message)
  closed_at      INTEGER,
  close_reason   TEXT CHECK (close_reason IN ('empty', 'expired', 'admin', 'gone')),
  phase          TEXT NOT NULL CHECK (phase IN ('lobby', 'playing', 'over')),
  mode           TEXT,
  pairing        TEXT,
  round          INTEGER,
  seats          INTEGER NOT NULL,
  connected      INTEGER NOT NULL, -- seats with a phone connected
  watching       INTEGER NOT NULL, -- spectators connected
  signed_in      INTEGER NOT NULL DEFAULT 0, -- seats taken by a player account
  host           TEXT,             -- the host's seat name
  names          TEXT,             -- JSON array of the seat names
  game_id        TEXT,             -- the room's current game in games, if any
  first_start_at INTEGER,
  games_started  INTEGER NOT NULL DEFAULT 0,
  games_finished INTEGER NOT NULL DEFAULT 0,
  connects       INTEGER NOT NULL DEFAULT 0, -- phones that said hello
  rejoins        INTEGER NOT NULL DEFAULT 0, -- of those, phones that got their seat back
  spectators     INTEGER NOT NULL DEFAULT 0, -- of those, phones that came to watch
  chat           INTEGER NOT NULL DEFAULT 0, -- chat messages sent
  peak           INTEGER NOT NULL DEFAULT 0, -- most phones connected at once
  kind           TEXT                        -- the game chosen in the lobby: sevens, 4218, schocken
);
CREATE INDEX IF NOT EXISTS rooms_open ON rooms (closed_at, active_at);
CREATE INDEX IF NOT EXISTS rooms_created ON rooms (created_at);

-- A room's timeline: created, joined, left, kicked, watching, started, over, undone, reopened, closed.
CREATE TABLE IF NOT EXISTS room_events (
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT, -- JSON
  PRIMARY KEY (room_id, seq)
);

-- Switches the owner can flip (server/d1/accounts.js partyConfig): party_owner and party_for (16-hex player IDs),
-- party_age, party_on ('0' | '1'). Written by hand with wrangler d1 execute, never from the repo; no rows = off.
CREATE TABLE IF NOT EXISTS flags (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

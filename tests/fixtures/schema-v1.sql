-- Frozen copy of server/d1/schema.sql before accounts (migration 0001), for tests/accounts-store.test.js. Don't edit.
-- Sevens Out statistics (D1). Load with: npm run db:schema (remote) or tests/e2e/d1-setup.mjs (local).
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
  PRIMARY KEY (game_id, idx)
);
CREATE INDEX IF NOT EXISTS players_name ON players (name_key);

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

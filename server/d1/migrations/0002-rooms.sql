-- Adds the rooms (the admin page's live and past rooms) to a stats database created before them. Run it once:
--   npx wrangler d1 execute sevens-out-stats --remote -c server/cloudflare/wrangler.jsonc --file server/d1/migrations/0002-rooms.sql --yes
-- It is safe to run again. Fresh databases use schema.sql, which already has all of this.
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
  peak           INTEGER NOT NULL DEFAULT 0  -- most phones connected at once
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

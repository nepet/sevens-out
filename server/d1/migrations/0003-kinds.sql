-- Adds the game (Sevens Out, 42/18, Schocken) to games and rooms in a stats database created before them. Run it once:
--   npx wrangler d1 execute sevens-out-stats --remote -c server/cloudflare/wrangler.jsonc --file server/d1/migrations/0003-kinds.sql --yes
-- Run it before deploying the Worker that writes the column. Running it again fails with "duplicate column name"
-- and changes nothing. Fresh databases use schema.sql, which already has all of this. Every game recorded before is Sevens Out.
ALTER TABLE games ADD COLUMN kind TEXT NOT NULL DEFAULT 'sevens' CHECK (kind IN ('sevens', '4218', 'schocken'));
CREATE INDEX IF NOT EXISTS games_kind ON games (kind, status, finished_at);
ALTER TABLE rooms ADD COLUMN kind TEXT;

-- Adds the flags table (switches the owner can flip) to a stats database created before it. Run it once:
--   npx wrangler d1 execute sevens-out-stats --remote -c server/cloudflare/wrangler.jsonc --file server/d1/migrations/0004-flags.sql --yes
-- Run it before deploying the Worker that reads it. Running it again changes nothing. Fresh databases use schema.sql.
CREATE TABLE IF NOT EXISTS flags (
  name       TEXT PRIMARY KEY, -- party_owner, party_for (16-hex player IDs), party_age, party_on ('0' | '1')
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

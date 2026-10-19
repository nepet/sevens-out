# Admin page (statistics)

A page only the owner can open, showing how Sevens Out is played: activity over time, game facts and
records, a leaderboard by player name, and the recent games with their score sheets.

## How it works

- **Online games:** each room (Durable Object) records its game in the D1 database `sevens-out-stats`
  when it starts, ends, is undone out of game over, or is abandoned. A failed write is kept in the room's
  storage (`pendingStats`) and retried from the alarm for up to a day; players never wait for it.
  When an empty room is removed, waiting statistics are kept and retried; the room's storage is cleared
  only once nothing is waiting.
- **One-phone games:** when a game on one phone ends, the page sends a summary to `POST /report` on the
  game Worker. It waits in `localStorage['sevens-out-reports']` until the server accepts or refuses it
  (offline or a busy server: it is sent on a later visit). A refused report is dropped and never sent
  again; that includes one the server refuses as too large (413), not only one that breaks the rules.
  The server checks it against the rules (`server/core/stats.js`, `checkReport`, which also refuses
  player names that aren't strings) and stores it once per game.
- **The page:** a separate Worker, `sevens-out-admin`, reads the same database. Cloudflare Access signs the
  owner in; the Worker checks the Access token (`server/admin/access.js`: a string `kid`, numeric `exp`
  and `nbf`) and the email itself as well.
- **Recent games:** `/api/games?before=` takes an opaque cursor, `<finishedAt>_<id>`, which is the `next`
  of the previous page. It is not a timestamp.
- Statistics start when this went live. The self-hosted Node server records nothing.

## Setup (once)

1. Create the database and load the schema:
   `npx wrangler d1 create sevens-out-stats` (put the id in both `wrangler.jsonc` files), then `npm run db:schema`.
2. Deploy the game Worker (`npm run worker:deploy`) and the admin Worker (`npm run admin:deploy`).
3. In the Cloudflare dashboard, open **Zero Trust** and finish the onboarding: pick a team name and the
   Free plan. (Cloudflare may ask for a payment method even on the Free plan.)
4. **Workers & Pages → sevens-out-admin → Settings → Domains & Routes**: enable Cloudflare Access for
   the `workers.dev` URL (or, on the Worker's **Access** tab, choose "Protect this Worker behind Access").
   Edit the policy it creates so that it only includes your email address.
5. **Zero Trust → Access → Applications →** the new application: copy the **Application Audience (AUD) Tag**.
6. In `server/admin/wrangler.jsonc` set `ACCESS_TEAM` (the `<team>` in `<team>.cloudflareaccess.com`) and
   `ACCESS_AUD`. Store your email as a secret (never in the repo):
   `npx wrangler secret put ADMIN_EMAIL -c server/admin/wrangler.jsonc`. Deploy again: `npm run admin:deploy`.
7. Check: opening the admin URL asks you to sign in; after signing in the page loads.

## Never put the game Worker behind Access

Players would get a login screen. If you ever turn on the account-wide "all Workers private" setting in
Cloudflare, give `sevens-out` a bypass.

## Day to day

- **Fake or test games:** filter by source (online / one phone), open the game and use **Delete game**.
- **Local development:** `npm run worker:dev` and `npm run admin:dev` (port 8789, no sign-in on localhost).
  - Keep `admin:dev` on localhost. Never add `--ip 0.0.0.0`: the no-sign-in mode trusts the `127.0.0.1` / `localhost` host name.
  - Both share the local database in `.wrangler/dev`. Load the schema into it first:
    `npx wrangler d1 execute sevens-out-stats --local --persist-to .wrangler/dev -c server/cloudflare/wrangler.jsonc --file server/d1/schema.sql`.
    (`node tests/e2e/d1-setup.mjs` only prepares `.wrangler/e2e` for the browser tests; `worker:dev` and `admin:dev` don't use it.)
- **Tests:** `npm run test:admin` runs the admin page's browser tests against `wrangler dev`.
  Don't run `test:worker` and `test:admin` at the same time: both reset `.wrangler/e2e`.
- **What is stored:** player names and game details. No IP addresses or device ids. Records stay until deleted.

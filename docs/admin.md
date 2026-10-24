# Admin page (statistics)

A page only the owner can open, showing how Sevens Out, 42/18 and Schocken are played: the online rooms (open now,
live, and closed), activity over time, how the app is used, game facts and records, a leaderboard by player name,
and the recent games with their score sheets.

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
- **Games:** every game is recorded with its kind (`games.kind`: `sevens`, `4218`, `schocken`). The **Game** filter
  shows Sevens Out by default, or 42/18, Schocken or all games together. Points mean something different in each game
  (Sevens Out: pips; 42/18: the throw's points, 0 = no 42; Schocken: what the throw is worth in coasters), so the facts
  about points (points per turn, the spread, the biggest turn, the closest finish) need one game. The "top throw" column
  is a Sevens Out, a 42/18 or a Schock out. A score in 42/18 and Schocken is coasters (Schocken: in the last half played).
  The rooms part of **Usage** counts every room, whatever its game; the open and closed rooms show each room's game.
- **The page:** a separate Worker, `sevens-out-admin`, reads the same database. Cloudflare Access signs the
  owner in; the Worker checks the Access token (`server/admin/access.js`: a string `kid`, numeric `exp`
  and `nbf`) and the email itself as well.
- **Recent games:** `/api/games?before=` takes an opaque cursor, `<finishedAt>_<id>`, which is the `next`
  of the previous page. It is not a timestamp.
- **Rooms:** each room keeps a row in `rooms` and a timeline in `room_events` (made, joined, left, removed, came to
  watch, game started, game over, undone, back to the lobby, closed). It writes when seats, connections, the
  round or the game change, and at most once a minute for moves and chat alone. The writes are best effort: a
  failed one is healed by the next, and its timeline events wait in memory for it.
- **Live rooms and closing them:** the admin Worker reaches the game Worker through the service binding `GAME`
  (entrypoint `AdminApi` in `server/cloudflare/worker.js`, which the internet can't reach). For every open room that
  may be busy (someone connected, or a change within the hour) the list asks the room itself; the others show their
  row, so a page left open doesn't wake every quiet room (each look is a Durable Object request). An open room's
  dialog always asks, and follows it every 3 seconds: who is connected, the seats, the round and the dice. A row
  whose room has gone is closed as "gone". **Close room** sends every phone in the room home ("Room ABCDE was closed."), counts an unfinished
  game as abandoned and deletes the room. **Close idle rooms** does that for every open room with nobody
  connected and no change for 6 hours (by their rows, then asking each room once more). The live view never shows tokens or chat text (only how many messages there are).
- **Usage** (by period; rooms by when they were made): the room funnel (made, 2+ players, started, finished),
  lobby time, how long rooms are used, reconnects per player, chat and spectators, how rooms closed; when games
  are played (weekday × hour, in the viewer's time zone); players per game; new and returning players; player
  accounts; how starters and the others score, and how often players stop before the limit.
- Statistics start when this went live, and rooms when the rooms tables did. The self-hosted Node server records nothing.

## Setup (once)

1. Create the database and load the schema:
   `npx wrangler d1 create sevens-out-stats` (put the id in both `wrangler.jsonc` files), then `npm run db:schema`.
   A database made before the rooms gets them once with `npm run db:rooms` (safe to run again), and one made before
   42/18 and Schocken were recorded gets `games.kind` and `rooms.kind` once with `npm run db:kinds` (a second run fails
   with "duplicate column name" and changes nothing). Every game recorded before is Sevens Out.
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

## Adding the rooms to a live setup (once)

1. `npm run db:rooms`: the `rooms` and `room_events` tables. Until they exist, the rooms' writes fail quietly and games are unaffected.
2. `npm run worker:deploy`: rooms start writing, and the `AdminApi` entrypoint exists.
3. `npm run admin:deploy`: the admin Worker with the `GAME` binding. Deploy it after the game Worker, so the
   entrypoint it binds to exists.
4. Push the page: phones in a closed room then go home with "Room ABCDE was closed." (an older page shows the server's
   message and then "There's no room with the code").

## Adding 42/18 and Schocken to a live setup (once)

1. `npm run db:kinds`: `games.kind` and `rooms.kind`. Do it first: a Worker that records 42/18 and Schocken writes the
   column, and until it exists every stats write fails (and waits for a retry) and every room write fails quietly.
2. `npm run worker:deploy`, then `npm run admin:deploy`.
3. Push the page: it then sends finished one-phone 42/18 and Schocken games too. (An older Worker refuses those reports,
   and the page drops them; that is why the Worker goes first.)

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
- **What is stored:** player names and game details; for rooms, seat names, counts (phones, reconnects, spectators,
  chat messages) and the timeline. No IP addresses, device ids or chat text. Records stay until deleted.

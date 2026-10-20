# Sevens Out

A dice game for 2–6 players, played on phones. It has two ways to play together:

- **On one phone (pass-and-play):** a static page on GitHub Pages.
- **Online:** everyone uses their own phone and joins a room by code. A small room server holds the game. It runs as a Cloudflare Worker with Durable Objects (option 4) or as a self-hosted Node server (option 5), using the same code.

Each mode works either with dice in the app or with real dice, where players enter their scores.

## The repo

```
index.html                 the page: markup, CSS, UI script (pass-and-play + online client)
engine.js                  the rules engine, shared by the page and both servers
server/core/room.js        one game room: seats, host, turn authority, persistence, protocol (no runtime code)
server/core/stats.js       game summaries for the statistics, and the rule check for one-phone reports
server/core/accounts.js    player accounts: the /auth handler (Fetch API) and resolveSession for rooms (no runtime code)
server/core/webauthn.js    passkey checks with WebCrypto only (registration, sign-in, DER, base64url)
server/d1/                 schema.sql (stats + accounts), db.js (D1 adapter), write.js (store/replace/delete a game),
                           accounts.js (account store), migrations/0001-accounts.sql (once, for the pre-accounts live database)
server/admin/              the owner's admin page: worker.js, access.js (Access token check), queries.js, page.html, wrangler.jsonc
server/cloudflare/         option 4: worker.js (Worker + Durable Object adapter), wrangler.jsonc
server/node/               option 5 and local dev: server.js (HTTP + rooms + JSON files + /auth), ws.js (built-in WebSocket server),
                           sqlite.js (DATA_DIR/sevens-out.db with the D1 interface)
tests/                     node:test unit tests (engine, room, node server, worker adapter, stats, accounts)
tests/e2e/                 Playwright browser tests (local modes, two-phone online play, passkey accounts)
deploy/                    option 5: docker-compose.yml + Caddyfile, systemd unit
docs/self-hosting.md       how to run option 5
docs/admin.md              admin page: how it works, setup with Cloudflare Access
docs/accounts.md           player accounts with passkeys: how they work, the domain caveat, what is stored, setup
Dockerfile                 option 5 container
.github/workflows/test.yml CI: unit + browser tests on every push
```

- **No build step and no framework.** GitHub Pages serves `index.html` and `engine.js` straight from `main`. The servers import `engine.js` directly.
- **No runtime npm packages.** The servers use only Node built-ins or the Workers runtime. `package.json` holds dev tools only: Playwright and wrangler.
- **The only external resource is Google Fonts:** Big Shoulders Display, Bungee and Instrument Sans, each with a system fallback.
- **`engine.js` works in both worlds.** It's a classic script that sets `globalThis.SevensEngine`, so the page loads it with `<script src>` and the servers with `import '../../engine.js'`. Keep it free of `import` and `export`.

## Commands

```
npm install                       # dev tools
npx playwright install chromium   # browser for the e2e tests (once)
npm run dev                       # Node server on http://localhost:8788 (page + online rooms)
npm run test:unit                 # engine, room, node server, worker adapter (fast)
npm run test:e2e                  # browser tests against the Node server
npm test                          # both
npm run worker:dev                # Worker locally on :8787 (wrangler dev)
npm run test:worker               # online, players and account browser tests against wrangler dev
npm run worker:deploy             # deploy option 4
npm run test:admin                # admin page browser tests (wrangler dev for both Workers, local D1)
npm run admin:dev                 # admin Worker locally on :8789 (no sign-in on localhost)
npm run admin:deploy              # deploy the admin Worker
npm run db:schema                 # load server/d1/schema.sql into the remote D1 database (fresh database)
npm run db:accounts               # once: add the accounts tables and players.user_id to the live database
```

## Deploy

- **The page** is served by GitHub Pages from `main`, at the repo root. A push deploys it within about a minute. Check it with `gh api repos/<owner>/sevens-out/pages/builds/latest --jq .status`.
- **The room server (option 4)** deploys with `npm run worker:deploy`, which needs `npx wrangler login` once.
  - **Order:** when the page depends on a new engine behaviour, deploy the Worker (`npm run worker:deploy`) before pushing the page. A new page with an old Worker breaks online play; an old cached page with a new Worker is fine.
  - **Database changes go first:** a migration (`npm run db:accounts`) runs before the Worker that needs it. The Worker writes `players.user_id`, so stats writes fail (and wait for a retry) until it exists. The page probes `GET /auth/config` and hides accounts on an old Worker.
  - `ALLOWED_ORIGINS` in `server/cloudflare/wrangler.jsonc` must list the page origin, for example `https://<owner>.github.io`.
  - The page finds the server through `<meta name="sevens-out-server" content="wss://sevens-out.<subdomain>.workers.dev">` in `index.html`.
  - An empty `content` hides online play; `same-origin` means "this host", which is what the Node server sets when it serves the page.
  - `?server=wss://…` in the page URL overrides the meta tag, which is useful for testing.
- **The admin page** is the separate Worker `sevens-out-admin` behind Cloudflare Access; see `docs/admin.md`. Never put the game Worker `sevens-out` behind Access.
- **Option 4 by hand:** see `docs/cloudflare.md` (account, subdomain, login, dashboard, limits, troubleshooting).
- **Option 5:** see `docs/self-hosting.md`.

## Game rules (source of truth)

These rules were agreed with the owner. Don't change them unless asked.

1. **Dice and pairs.** A turn uses 6 dice. After each roll, any pairs that add up to 7 (1+6, 2+5, 3+4) may be set aside. Only such pairs can be set aside. All other dice are rolled again.
2. **Roll limit.** The round's starter may roll up to 3 times (`MAX_ROLLS`) and can stop after any roll. The number of rolls the starter used becomes the limit (`game.mark`) for everyone else that round. Everyone else may also stop earlier.
3. **Scoring.** When a player stops, the pips on the dice still on the table are added to the player's score (higher is worse). Clearing all six dice scores 0 and triggers the "Sevens Out!" celebration.
   - **Find the 7s yourself** (dice mode, the default, `game.pairing: 'manual'`): pairs the player didn't set aside stay on the table and count.
   - **The app finds them** (`game.pairing: 'auto'`): all remaining 7-pairs come out automatically first.
4. **Turn order.** Players take turns in seating order, starting from the round's starter.
5. **Who starts a round.**
   - First round: chosen on the setup screen or in the lobby, or picked at random.
   - After that: the player with the highest total starts.
   - **Tie:** whoever reached that score first, worked out by replaying the score sheet in playing order (`reachedAt`). A 0-point turn does not count as reaching the score again.
   - **Still tied** (for example everyone on 0): the next of the tied players after the last starter.
6. **Ending.** When any player reaches **101 or more** (`LIMIT`), the current round is played to the end. Then the highest score loses.
   - **Tie for highest:** the player who played later in that last round loses.

### Scoreboard mode ("Real dice, scores here")

- **Entering a turn:** each turn the player enters the pips left on the table (0–36). The starter also enters the rolls used (1–3).
- **Undo:** reverts the last entry, dropped die or correction, using snapshots in `game.history` (capped at 40).
- **Dice on the floor:** one counter is shared by the table (`game.drops`), and each drop counts against the player whose turn it is. The third drop means that player pays a round of shots: it triggers the skull takeover, is recorded in `game.shots`, and resets the counter.
- **Corrections:** tap a player's line in the score list to edit any past round. The engine rebuilds the totals (`recalc`) and re-applies the starter and 101 rules wherever the game stands. A game ended early stays over.
  - While nothing has been played in the new round, a correction re-applies the starter and 101 rules to the finished rounds (the round restarts with the right starter, or the game ends); dropped dice don't close that window; shots from a removed empty round move to the finished round.

### Dice mode extras

- **Pairs of 7** is chosen on the setup screen or in the lobby.
  - **Find them yourself** (default): nothing is set aside after a roll. The player taps two dice that add up to 7. The page doesn't highlight pairs or offer "Set aside all 7s" (`takeall` is refused with `by_hand`), and "On the table" shows every pip on the table.
  - **Missed 7s:** rolling on or stopping with a 7-pair still on the table emits `missed` (before `rolled` on a roll). Every phone then shows the "Need glasses?" joke: the missed dice get a pair of glasses and a sad trombone plays. Taps go through it, the next roll clears it, and otherwise it goes after about 3 s.
  - **The app finds them:** rolling sets all 7-pairs aside. The page then shows the dice lying still for about 0.7 s and flies each pair into the rack.
  - Games saved before the choice existed have no `pairing` field and keep the automatic behaviour (`byHand(g)` is false).
- A pair from the current roll can be put back before the next roll.

## Architecture

### The engine (`engine.js`)

`apply(state, action, { rng }) -> { state, events }`, or `{ error, state }` when the action isn't allowed.

- **It is pure:** it never mutates its input, and it has no DOM, storage or network code.
- **Dice:** they come from `crypto.getRandomValues` with rejection sampling. On a server, the server rolls.
- **Read-only helpers are exported too:** `active`, `byHand`, `finalPenalty`, `pairable`, `canRoll`, `matchPairs`, `tiedForStart`, `roundRecap` (summary of the round just finished, for the race between rounds) and others.

**Actions:**

| Group | Actions |
|---|---|
| Setup | `start {names, starter, mode, pairing?, seats?}` (`pairing` defaults to `manual`) |
| Dice turn | `roll`, `pair {a, b}`, `unpair {index}`, `takeall`, `stop` (alias `end`) |
| Scoreboard turn | `score {pts, rolls?}` |
| Table | `drop`, `undo`, `edit {player, values: {roundNo: pts}}` |
| Flow | `nextround` (only for games saved between rounds, the old `roundEnd` phase), `endearly` |

**Rounds move on by themselves:** the action that books the last turn of a round (`stop`/`end`, `score`) also starts the next round, unless someone is at 101. Ending early before anyone has played in the new round drops that empty round first.

**Events** (for animations and messages): `started`, `rolled {auto, values}`, `paired {pairs}`, `unpaired`, `missed {player, how: 'roll'|'stop', pairs: [[a, b]..]}` (pip values), `sevensOut {player}`, `turn`, `roundEnd {round, next}` (always followed by `started` in the same action), `gameOver {loser}`, `dropped {drops}`, `shots {player}`, `undone {msg}`, `edited`, `ended`.

### State

The page saves the phone's own game to `localStorage['sevens-out-v1']`. Online games live on the server and are never saved there.

```js
state = {
  phase: 'setup' | 'play' | 'over',   // 'roundEnd' only in games saved before rounds moved on by themselves
  setup: { names: [..], starter, mode: 'dice' | 'score', pairing: 'manual' | 'auto' },   // pass-and-play setup screen
  game: {
    mode, pairing?, players: [{ name, score }], seats?: [seatId..],   // pairing missing = auto (old saves); seats only online
    round, starter, order: [playerIdx..], pos,                    // whose turn: order[pos]
    mark,                                                         // roll limit set by this round's starter
    rounds: [{ no, starter, mark, results: { [playerIdx]: { pts, rolls } } }],   // the score sheet
    turn: { dice: [{ id, value, held }], rolls, maxRolls, pairs: [{ a, b, roll }], cleared },
    ending, crosser, next, loser, early, last,
    history: [..], drops, shots: [{ player, round }]
  },
  stats: { id, startedAt, owner?, ownerId? }                      // one-phone games only, for the statistics; owner = the signed-in player's line, ownerId = their player ID
}
```

**Saved games survive reloads, so changes must not break old saves.** When you add a field, read it with a default (for example `g.drops || 0`).

Other storage keys, all per device:
- `sevens-out-sound`: `off` | `jackpot` | `bandit`
- `sevens-out-look`: `pub` | `vegas`
- `sevens-out-shake`: `1` | `0`
- `sevens-out-name`: the name last used online
- `sevens-out-online`: `{code, token, name, server}`, used to rejoin a room after a reload or a locked screen
- `sevens-out-reports`: `{queue, sent}`, finished one-phone games waiting to be sent to `POST /report` until the server accepts or refuses them
- `sevens-out-account`: `{[authBase]: {token, id, name}}`, the signed-in player per server, so a `?server=` override never touches the real one (an old single `{token, id, name, server}` reads as one entry)

### The page (`index.html`)

The script is one IIFE. Every `render()` rebuilds `#app.innerHTML` from template strings.

**The slim header** (`header(g)`) tops the play screens: the menu button, "Round N · M rolls max" (or "<Name> sets the limit (max 3)", "Game over" at the end; `.rnd`), the room chip online (`netChip()`), and when someone is at 101 a one-line `.alert` ("Anna is at 104. Last round: the highest score loses.").

**The dice turn** (`viewPlay()`), top to bottom: header, score list, the player's line (`h2.who` with "Roll 1 of 2" and the roll slots in `.rolls`), the leather table (`.tray.table`: "On the table N" in `.tval`, the dice, and along its bottom edge `.rackrow` with the set-aside pairs in `.rack`; a pair from this roll is a `button.pair[data-act=unpair]`, and `takeall` sits there with automatic pairing), one `.hint` line, and the pinned leather bar:
- Before the first roll: Roll alone, full width ("Roll 6 dice / 3 rolls left").
- After a roll: Stop about 40% (outline, "Stop / take +N"; the first tap arms it, `ui.armed`, and it turns into "Confirm stop · +N") and Roll about 60% (brass, "Roll 4 dice / 2 rolls left" or "last roll"). Buttons are `.btn.two` (`.stop`, `.go`) with a `<b>` and a `<small>` line.
- No rolls left (or all six dice out): one full-width "End turn · +N".
- Rolling or setting aside 7s: Roll is disabled as "Rolling…" (no `data-act`).
- Not this phone's turn: the bar holds the waiting note ("Waiting for Ben to roll") with the pulse. The host covering for an offline player gets the controls.
- **On the leather:** `render()` sets `html.felt` while the dice turn shows. The page background becomes the leather, and inside `#app` (and the race card) the tokens are remapped to ink on leather (`--ink` = `--on-leather`, `--brass` = `--stitch`, `--danger` = `--on-leather-danger`, …), so the list, chips and buttons follow in every look. Both turn screens use it (`.felt-turn`); corrections and game over stay on paper.
- **Small phones:** the bar is always pinned. The table grows into free height and shrinks first on a short screen (`--die` also follows the height; a `max-height: 700px` block tightens the spacing), then the page scrolls under the bar. The score list is never hidden.

**The real-dice turn** (`viewScore()`), top to bottom: header, score list, the player line (`h2.who` and `.rolls`: "Starts the round · up to 3 rolls" or "Up to N rolls"), the leather table (`.tray.table`: "Pips left on the table", the entry in `.entry`, the 12-key `.pad`), the starter's "Rolls used" 1/2/3 (`.rollpick`), "Dice on the floor" as one `.floor` row (three slots, "Die dropped"), a `.hintrow` (the hint and the small Undo link, `data-act="undo"`), and the pinned leather bar with "Save · Anna +12" (`data-act="commit"`, disabled as "Enter the pips left" or "Choose the rolls used" until ready). A phone that may not enter gets the floor row, the hint and the waiting note in the bar, with no keypad. Keys, rolls buttons and Die dropped are at least 44 px tall. With six players on 375×667 the keypad is longer than the screen, so the page scrolls under the pinned bar; Save and the complete list stay reachable.

**Corrections** (`viewEdit()`) stay on paper: header, list, the player's rows with steppers, and a pinned bar with Cancel (`ecancel`, about 40%) and Save changes (`esave`, about 60%).

**Game over** (`viewOver()`) stays on paper: header, verdict and reason, the list sorted by total, the shots summary, a small Undo link (scoreboard games) and the pinned bar with Play again (`again`), "Play again with this room" for the online host (`oreopen`) or the waiting note. The score sheet is in the game menu.

**The score list** (`board(g, cur)`, one `lineHtml(g, i, opts)` per player) sits at the top of the play screens (dice turn, real-dice keypad, corrections) and under the verdict at game over:
- During play and corrections the lines follow this round's playing order (`g.order`), with the current player (or the player being corrected) highlighted. At game over they are sorted by total, highest first (equal totals keep seating order), and the loser's line says "Loses".
- Each line: ▶ marker, name (a die mark for the round's starter, `you` online, and online the `#tag` of the other signed-in players, which gives way first to a long name), a bar towards 101 with the last 15 hatched, the total, and this round's `+N`, `now` or `–`. Offline and rounds of shots paid add a small second row.
- Real-dice mode: seated players tap a line to correct that player's scores (`data-act="edit"`). A line's `::after` makes its hit area 44 px tall, also in the dense list (neighbouring areas overlap, so the effective height there is the 32 px row pitch).
- Rows are about 36 px (`--rowh`), 30 px with 5–6 players (`section.board.dense`; the race card copies `dense`, so it starts exactly over the list).
- DOM, relied on by the tests and the race between rounds: `section.board` → `.bhead` → `ol.lines` → `li.pl[data-id]` (classes `now`, `wait`, `over`, `lost`, `editable`) with `.mk`, `.nm`, `.trk > .fill`, `.num`, `.dl` and an optional `.pl-sub`; then `p.bfoot`. `lineHtml` depends only on its arguments (and the room's connections), so the race can reuse it.

**The game menu, the bottom sheet and the bottom bar:**
- **Game menu:** the menu button (`menuButton()`, `data-act="menu"`) sits at the top left of the play screens (dice, real dice, corrections, game over) and the lobby. It opens a bottom sheet with the score sheet (`sheet(g)`, a fold open by default), How to play (`rules()`), Sound / Look / Shake (`settingsBlock()`), New game (one phone, during play) or Leave room (online) with their in-page confirmations (`quitBlock()`), and Developer (`devBlock()`, folded). Nothing sits under the play screens any more; home and the online entry keep `footer()` (the settings only).
- **Bottom sheet:** one layer outside `#app` (`.sheet-layer` → `.sheet-backdrop` + `section.sheet[role=dialog]` with `.sheet-grab`, `.sheet-head` (`#sheet-h`, `.sheet-close`) and `.sheet-body`). Kinds are registered in `SHEETS` as `{title, ok(), body()}`; `openSheet(kind, from)` shows one (`ui.sheet`), `closeSheet()` hides it and gives the focus back to the opener (`from` = its `[data-act, data-id]`, kept in `ui.sheetFrom`). Every `render()` rebuilds only the body (`renderSheet()`), keeping its scroll position and the focused control, and closes the sheet when `ok()` says it doesn't belong on the new screen. While it is open `#app` is `inert`, Escape, the close button and a backdrop tap (`data-act="sheetclose"`) close it, Tab stays inside, and the keypad keys and shake to roll are ignored. Reduced motion: no slide. `newyes`, `oleaveyes`, `endyes` and the `dev*` actions close it first.
- **Bottom bar:** `bar(inner, {leather})` returns a `.bar` (`.bar.leather` for the turn screens), pinned to the bottom with `position: sticky` and padded by the safe area. Put it last in a view; `render()` then gives `#app` the class `has-bar`, so the bar reaches the bottom edge (nothing after `#app` may add height: the `#acct-live` region sits at the top). The dice turn uses it; real dice, corrections and game over are next.

**Events and actions:**
- Clickable elements carry `data-act` (and optionally `data-id`). One document click listener calls `handle(action, id, el)`, for elements in `#app` and in the sheet.
- Game changes go through `dispatch(action)`. Locally, it applies the engine. Online, it sends `{t:'act', action}` and waits for the server.
- New states are shown through `show()` or `present()`. When the events include `rolled` or `paired`, the page plays the tumble → pause → fly-out animation first, in order, through a queue. This works the same way for the player and for everyone watching. Other changes show at once.
- A `roundEnd` event always goes through the queue, with reduced motion too: `present()` plays the round's Sevens Out celebration or missed-7 joke first, then `playRace(recap, swap)`, which switches to the new state under the race's curtain. States that arrive meanwhile wait in the queue, so the race is never cut off. While it plays, `ui.race` makes the page busy: game actions and shake to roll are ignored.
- Online, `canAct()` decides whether this phone may move:
  - it's this phone's seat's turn, or
  - this phone is the host and the current player is offline.
  - Other players see a "Waiting for …" note instead of the controls.

**Data actions:**
- **Setup:** `add`, `remove`, `randstart`, `mode`, `pairing`, `start`, `me` ("This is me")
- **Dice:** `roll`, `die`, `unpair`, `takeall`, `stop`, `end`
- **Scoreboard:** `key`, `back`, `clear`, `rolls`, `commit`, `undo`, `drop`
- **Corrections:** `edit`, `estep`, `esave`, `ecancel`
- **Flow:** `again`, `new`/`newyes`/`newno`, `menu`, `sheetclose`
- **Developer:** `endearly`/`endyes`/`endno`, `devconfetti`, `devdoom`, `devmiss`, `devround`
- **Settings:** `sound`, `look`, `shake`
- **Online:** `online`, `oback`, `ocreate`, `ojoin`, `omode`, `opairing`, `ostarter`, `ostart`, `oreopen`, `okick`, `ocopy`, `oshare`, `oleave`/`oleaveyes`/`oleaveno`
- **Account:** `acreate`, `asignin`, `arename`/`arenamesave`/`arenamecancel`, `aadd`, `asignout`, `adelete`/`adeleteyes`/`adeleteno`

**Debugging:** `window.SevensDebug` gives read-only `state`, `net`, `busy` and `account` views (`busy` is also true during the race between rounds; `account` is `{available, signedIn, id, name}`, never the token). The tests use it.

### The room server (`server/core/room.js` + adapters)

One `Room` per room code holds the authoritative game.

**Wire protocol** (JSON over WebSocket at `/room/<CODE>`; codes are 5 characters from `A–Z` without `I`/`O` and `2–9`):

| Direction | Message |
|---|---|
| client → server | `{t:'hello', name, token?, create?, session?}` (`session`: the account token when signed in) |
| client → server | `{t:'act', action}` |
| client → server | `{t:'lobby', op:'settings'\|'start'\|'reopen'\|'rename'\|'kick'\|'leave', …}` |
| client → server | `{t:'ping'}` |
| server → client | `{t:'welcome', seat, token, user?}` (`user`: the player ID the server resolved; `null`: a guest, or the session has ended; left out: the accounts database couldn't be reached, or an old server. The page drops its account only on `null`) |
| server → client | `{t:'room', rev, room:{code, phase:'lobby'\|'game', host, settings:{mode, pairing, starter}, seats:[{id,name,connected,user}]}, state, events}` |
| server → client | `{t:'error', code, message}` |
| server → client | `{t:'pong'}` |

**Statistics** (`server/core/stats.js`, D1 via `server/d1/`):
- Rooms record their game through the optional `stats` adapter: `playing` on start, `over` whenever an action leaves the game over, `playing` again when undo leaves game over, `abandoned` on reopen mid-game or when the room expires. Each game has a 16-hex `id`; a new record replaces the old one.
- The Cloudflare adapter writes to D1 and keeps failed writes in `pendingStats`, retried from the alarm (1 min doubling to 1 h, dropped after 24 h). Writes in one room run one after another. When an empty room is removed, `pendingStats` stays and is retried; storage is cleared only once nothing is waiting.
- `POST /report` takes a finished one-phone game, with an optional `owner` (line index) and `Authorization: Bearer <token>`: the line counts for the signed-in player only when the session is valid and the line carries the player's name (case and spaces ignored). `checkReport` rebuilds it with the engine (dice games: full rules; scoreboard games skip the starter and 101-round checks because corrections can change past rounds). 10 per minute per IP, 16 KB max.
- The admin page reads the same database. `/api/games?before=` takes the opaque cursor `<finishedAt>_<id>`.

**Player accounts** (`server/core/accounts.js`, `server/core/webauthn.js`, store in `server/d1/accounts.js`; see `docs/accounts.md`):
- `/auth/*` on both servers: `config` (probe), `options` → `create` | `signin` | `passkeys` (add), `me` (GET, PATCH name, DELETE), `passkeys/<id>` (DELETE; ends the player's other sessions), `signout[?everywhere=1]`. The route table is in the file header.
- A passkey belongs to the page's hostname (RP ID). The server takes the allowed origins from `ALLOWED_ORIGINS` (empty or `*`: any, for development) and checks challenge, origin, RP ID hash, user presence, signature and the sign counter. Registration trusts the browser's `getPublicKey()` (attestation `none`).
- Player IDs are 16 hex chars (8 random bytes, also the WebAuthn user handle), the tag is the first 4, the handle `<id>-<name>`. Sessions: 32 random bytes, only the SHA-256 is stored, 180 days sliding. Challenges: single use, 5 minutes.
- Rooms get an `accounts` adapter (`{ resolve(session) }`); a failure counts as "unknown", never as signed out. Rate limit: 120 requests per minute per IP (`AUTH_LIMIT`), the probe excluded; `AUTH_NO_LIMIT=1` switches it off on localhost for the browser tests.

**What `hello` does:**
- A connection says `hello` once; another one gets `bad_message`.
- With a matching token, the player gets their seat back.
- With a valid `session`, the signed-in player gets the seat that is theirs (`seat.user`) back from any phone, in the lobby or mid-game, without a token. A new seat sits under the player name. A guest seat whose token comes with a session is linked to the player (and renamed in the lobby). A player never takes two seats. An invalid session plays as a guest.
- With `create` and no room yet, the player creates the room and becomes host. If the room exists, the answer is `room_taken`, and the page tries a new code.
- Joining in the lobby adds a seat (up to 6). During a game, a newcomer joins as a spectator.

**Authority:**

| Actions | Who may make them |
|---|---|
| `roll`, `pair`, `unpair`, `takeall`, `stop`, `score` | The current player's seat. The host may make them when that player is offline. |
| `drop`, `undo`, `edit`, `nextround` | Any seated player |
| `endearly`, `start`, `reopen`, `kick` | The host |

- **Host fallback:** if the host is offline, the first connected seat acts as host.
- **Tokens:** they are never broadcast. Seat IDs are public.
- **Revisions:** every change increments `rev`. A client only animates events when `rev` is exactly one more than the last one it saw; otherwise it just shows the new state.
- **Expiry:** rooms are deleted after 14 days without activity. The Worker uses a Durable Object alarm, and the Node server sweeps its files.

**Adapters:**
- **Cloudflare (`server/cloudflare/worker.js`):** one Durable Object per room via `idFromName(code)`.
  - It uses the WebSocket Hibernation API, and each socket's seat lives in its attachment.
  - The room data is stored in the object's storage under `room`.
  - An origin allowlist comes from `ALLOWED_ORIGINS`.
  - `/auth/*` uses the `STATS` D1 database; without it accounts are off (`/auth/config` answers 404).
- **Node (`server/node/server.js`):**
  - Accounts live in `DATA_DIR/sevens-out.db` (`node:sqlite`). Its rate limit takes the client IP from `X-Forwarded-For` only when the proxy connects from this machine or a private network.
  - Rooms are kept in memory while someone is connected, and messages for a room are handled one at a time.
  - Each room is a JSON file in `DATA_DIR`, written atomically.
  - The server pings sockets every 30 s and drops dead ones.

**To add an action:**
1. Add it to `engine.js`.
2. Classify it in `room.js` (`TURN_ACTIONS`, `TABLE_ACTIONS` or `HOST_ACTIONS`).
3. Dispatch it from the page.
4. Add tests at each layer.

## Features worth knowing

- **Looks.** "Pub table" follows the system's light/dark setting. "Vegas" is dark-only and scoped under `html:root[data-look="vegas"]`. All colours are CSS custom properties.
- **Sounds.** They are synthesized with Web Audio and unlocked on the first tap.
- **Shake to roll.**
  - **When the switch shows:** only when the page is the top-level window and the phone has a coarse pointer.
  - **iPhone permission:** iOS needs `DeviceMotionEvent.requestPermission()` called directly inside a tap.
  - **What counts as a shake:** 3 jolts above 14 m/s² within 900 ms, then a 1.5 s cool-down.
  - **Where it works:** in dice mode, when this phone may roll.
- **Between rounds: the race to 101.** When a round's last turn is booked, every phone plays the same race (about 5 s), built from the new state with `E.roundRecap`:
  - **What happens:** if the score list is scrolled away (real-dice players scroll down to Save), the page first scrolls it back into view. Then the list lifts and grows in place ("After round N · Race to 101"), and the rest of the screen fades away. The bars move from each player's total at the start of the round by the round's points while the totals count up, then the lines reorder by total (highest on top, ties in the finished round's order).
  - **The round's best moment** pops up as a badge, the first that applies: Sevens Out with the first roll, Sevens Out, a round of shots paid, new on top, into the danger zone (86 or more), Ouch (a turn of 20 or more). Nothing applies, no badge.
  - **The curtain:** a leather curtain drops with "Round N+1", "<Name> starts" ("You start" on that player's own phone online; spectators see the name) and the reason ("Highest score: 64", "Tied on 40, got there first", "Tied on 40, next in turn"). The new round is swapped in underneath, then the curtain slides down and away. "<Name> starts" and the reason are fully shown about 1 s before it leaves.
  - **Skipping:** a tap on it, Escape, Enter or Space ends it at once.
  - **Sound:** `sound.round()` plays a short sting as the curtain drops, in the jackpot or old-bandit flavour, and nothing when the sound is off.
  - **The game menu** closes when the race starts (`playRace()`), so a phone with its menu open never misses it.
  - **Online:** every phone plays it from the same events. A phone that reloads or reconnects meanwhile just shows the new round. A correction emits only `edited`, so it never plays the race, and a correction screen open on another phone stays open when the round moves on. Leaving the room bumps `net.session`, and changes still queued from that room are dropped, so the phone's own saved game stays as it was.
  - **Saving:** a one-phone game saves the new state as soon as the race starts, so a reload mid-race keeps the last turn.
  - **Fallback:** without `E.roundRecap` (an old engine.js in the cache) or when anything in the race fails, the new state shows at once, without a race, and the page is never left busy. A one-phone game that such an old engine leaves in `roundEnd` moves on with `nextround`.
  - **DOM:** `.race` (fixed, outside `#app`) → `.race-card` (the list's `.bhead` and `li.pl` lines from `lineHtml`, plus `.race-badge`) and `.race-curtain` (`.race-round`, `.race-starter`, `.race-why`).
- **Your player.** An optional account with a passkey, in a panel on the home screen above "Not at the same table?". Guests can ignore it.
  - **When it shows:** the browser has `PublicKeyCredential`, a server is configured, the page is the top-level window on a hostname (WebAuthn refuses IP addresses; `localhost` works), and `GET /auth/config` answered `{ok: true}`. The probe runs once per page load and never holds up the first render. If it failed (offline, a 5xx), it runs again when the page becomes visible or the phone comes online; a 404 means no accounts there.
  - **Signed out:** a name field (from `sevens-out-name`) with "Create player", and "Sign in with a passkey" (a discoverable passkey, so no name to type).
  - **Signed in:** the name with its tag (`#` + the first 4 hex of the player ID), Rename, and a fold with "Add a passkey on this device", "Sign out" and "Delete player" (confirmed in the page).
  - **Session:** a bearer token from `/auth`, kept in `sevens-out-account`. On load the page checks it with `GET /auth/me`: a new name is taken over, a 401 signs the phone out quietly, and network trouble keeps it. Create, sign-in and rename also write `sevens-out-name`.
  - **Passkey hygiene:** after Delete the page calls `PublicKeyCredential.signalAllAcceptedCredentials` with no IDs, and a sign-in with a deleted player's passkey calls `signalUnknownCredential`, so password managers can hide them.
  - **Options fetched ahead:** Safari opens a passkey prompt only shortly after the tap, so the page keeps `/auth/options` sets ready: `signin` and `create` while the signed-out panel shows, `add` once its fold is open (home screen only, never during a prompt). A set is used once and is fresh for 4 minutes (challenges live 5); a fresh one is fetched in the background. A tap with a fresh set calls `navigator.credentials.*` before anything waits; without one it fetches first. A `create` set has no name: the page names the passkey `<name> #<tag>` and sends `name` to `/auth/create`.
  - While a passkey prompt is open (`ui.account.busy`), the panel's buttons are `aria-disabled` (so focus stays) and `handle()` ignores account actions. The hint is announced from `#acct-live`, a visually hidden live region outside `#app` that survives redraws.
  - **Online:** the online entry says "Playing as <name> #tag" instead of the name field, and `hello` carries `session` (only when the account belongs to the room server). If the server answers `welcome.user === null` to a hello with a session, the session has ended: the phone drops the account quietly and plays on as a guest in that seat. The lobby seats and the score list show `#tag` for seats with `user`.
  - **One phone:** when signed in, each setup row shows "You" (the first line whose name is the player name, case and spaces ignored) or "This is me", which puts the player name on that line (swapping names with the old "You" line). At start, `state.stats.owner` is that line and `ownerId` the player ID; the report carries `owner`, and its queue item keeps `ownerId`. It goes out with the bearer token only while that same player is signed in to the same server (signed out or someone else by then: a guest game).
- **Developer menu** (in the game menu, and on home). Play confetti, Play shots alarm, Play missed 7, Play round change (the race for the round just finished, or made-up points before there is one), and End game now (host only when online).
- **Reduced motion.** Rolls are instant, pairs are set aside without flying, there's no confetti, the shots takeover is shortened, and the missed-7 joke appears without moving. The race between rounds shows the grown list with its final totals, order and badge at once. The curtain then appears without sliding, and the whole race takes about 2.5 s.

## Conventions

- **Phones first.** 390 px wide, 16 px gutters, no sideways scrolling. Check both looks and light/dark.
- **Colours only through the CSS tokens.** The shots takeover is the deliberate exception.
  - **`color-mix()`** needs plain-token fallbacks in an `@supports not (color:color-mix(in srgb,red 50%,blue))` block after it, for Safari before 16.2. A plain declaration placed before it doesn't work: one with `var()` inside falls back to `unset`, not to the declaration before it.
- **No `alert()` or `confirm()`.** Confirmations are built into the page.
- **Copy is short, plain and active.** Errors say how to fix the problem.
- **Artwork stays original.** No branded characters, logos or trademarked designs.
- **The servers trust nothing from clients.** Validate in the engine and in `room.js`, never only in the page.

## Testing

- **Unit tests (`node --test`):**
  - `engine.test.js` plays many seeded random games in both modes and checks every rule against the score sheet, plus the specific cases.
  - `room.test.js` covers the protocol with in-memory connections.
  - `node-server.test.js` starts the real server and talks to it over WebSockets.
  - `worker.test.js` runs the Durable Object adapter against a stand-in runtime, including hibernation.
  - `d1.test.js`, `stats.test.js`, `queries.test.js`, `access.test.js` and `admin.test.js` cover the statistics: the D1 adapter and writes, summaries and `checkReport`, the admin queries, the Access token check and the admin Worker.
  - `webauthn.test.js`, `accounts-store.test.js`, `accounts.test.js` and `sqlite.test.js` cover accounts: passkey checks, the store and the migration, the `/auth` handler's ceremonies and refusals, and the Node database.
  - `tests/fake-d1.js` is a D1 stand-in on `node:sqlite`, `tests/games.js` builds deterministic finished games, and `tests/authenticator.js` is a software passkey (real WebCrypto keys) for the account tests.
- **Browser tests (`@playwright/test`):**
  - Separate browser contexts act as separate phones.
  - The tests read state through `window.SevensDebug` or `localStorage`.
  - Use `contextOptions: { reducedMotion: 'reduce' }` for instant rolls.
  - To fix the dice, stub `crypto.getRandomValues` for 1-byte arrays (`fixDice` in `tests/e2e/helpers.js`). With normal motion the tumbling dice use the same calls, so the fixed faces only hold with reduced motion.
  - To load the page with a changed `engine.js` or CSS (an old cached engine, a browser without `color-mix()`), serve the changed file through `page.route`, as the tests in `local.spec.js` do.
  - After a round's last turn, the race plays for about 2.5 s even with reduced motion. Tests that act right after a round ends call `skipRace(page)` (helpers.js): it waits for a Sevens Out or missed-7 joke that plays first, taps the race away, then waits until the page is idle.
  - Settings, New game, Leave room and the developer buttons live in the game menu on play screens and in the lobby: `openMenu(page, fold?)` opens it (and a fold: `sheet`, `rules`, `dev`), `closeMenu(page)` closes it with Escape. The sheet covers the game, so close it before tapping the game again.
  - `TARGET=worker` points online play at `wrangler dev` through the `?server=` override.
  - **Passkeys** (`account.spec.js`): `addAuthenticator(page)` adds a CDP virtual authenticator that says yes at once; `credentials` and `copyCredential` read a passkey and copy it to another phone (a synced passkey). WebAuthn refuses IP addresses, so these tests open `localUrl()` (`http://localhost:8790`), not the config's `127.0.0.1`. The virtual authenticator can't press Cancel; a cancelled prompt is a stubbed `navigator.credentials.create`. The page fetches passkey options ahead, so the test Node server runs with a high `AUTH_LIMIT` (every test phone is 127.0.0.1).
  - `tests/e2e/admin.spec.js` tests the admin page (`npm run test:admin`). Don't run it together with `test:worker`: both reset `.wrangler/e2e`.

Invariants to keep after rule changes:
- Rolls stay within the round's `mark`.
- Totals equal the score sheet.
- Each starter follows the highest-score rule, including the got-there-first tie-break.
- The game ends at the end of the first round in which anyone is at 101 or more, and the loser follows the tie rule.
- Online, every phone shows the same state.

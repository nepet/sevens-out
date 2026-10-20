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
server/d1/                 schema.sql (stats database), db.js (D1 adapter), write.js (store/replace/delete a game)
server/admin/              the owner's admin page: worker.js, access.js (Access token check), queries.js, page.html, wrangler.jsonc
server/cloudflare/         option 4: worker.js (Worker + Durable Object adapter), wrangler.jsonc
server/node/               option 5 and local dev: server.js (HTTP + rooms + JSON files), ws.js (built-in WebSocket server)
tests/                     node:test unit tests (engine, room, node server, worker adapter)
tests/e2e/                 Playwright browser tests (local modes and two-phone online play)
deploy/                    option 5: docker-compose.yml + Caddyfile, systemd unit
docs/self-hosting.md       how to run option 5
docs/admin.md              admin page: how it works, setup with Cloudflare Access
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
npm run test:worker               # online browser tests against wrangler dev
npm run worker:deploy             # deploy option 4
npm run test:admin                # admin page browser tests (wrangler dev for both Workers, local D1)
npm run admin:dev                 # admin Worker locally on :8789 (no sign-in on localhost)
npm run admin:deploy              # deploy the admin Worker
npm run db:schema                 # load server/d1/schema.sql into the remote D1 database
```

## Deploy

- **The page** is served by GitHub Pages from `main`, at the repo root. A push deploys it within about a minute. Check it with `gh api repos/<owner>/sevens-out/pages/builds/latest --jq .status`.
- **The room server (option 4)** deploys with `npm run worker:deploy`, which needs `npx wrangler login` once.
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
  - **Find them yourself** (default): nothing is set aside after a roll. The player taps two dice that add up to 7. The page doesn't highlight pairs or offer "Set aside all 7s" (`takeall` is refused with `by_hand`), and "Counts if you stop" shows every pip on the table.
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
  stats: { id, startedAt }                                        // one-phone games only, for the statistics
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

### The page (`index.html`)

The script is one IIFE. Every `render()` rebuilds `#app.innerHTML` from template strings.

**The score list** (`board(g, cur)`, one `lineHtml(g, i, opts)` per player) sits at the top of every game screen:
- During play and corrections the lines follow this round's playing order (`g.order`), with the current player (or the player being corrected) highlighted. At game over they are sorted by total, highest first (equal totals keep seating order), and the loser's line says "Loses".
- Each line: ▶ marker, name (a die mark for the round's starter, `you` online), a bar towards 101 with the last 15 hatched, the total, and this round's `+N`, `now` or `–`. Offline and rounds of shots paid add a small second row.
- Real-dice mode: seated players tap a line to correct that player's scores (`data-act="edit"`).
- DOM, relied on by the tests and the race between rounds: `section.board` → `.bhead` → `ol.lines` → `li.pl[data-id]` (classes `now`, `wait`, `over`, `lost`, `editable`) with `.mk`, `.nm`, `.trk > .fill`, `.num`, `.dl` and an optional `.pl-sub`; then `p.bfoot`. `lineHtml` depends only on its arguments (and the room's connections), so the race can reuse it.

**Events and actions:**
- Clickable elements carry `data-act` (and optionally `data-id`). One document click listener calls `handle(action, id, el)`.
- Game changes go through `dispatch(action)`. Locally, it applies the engine. Online, it sends `{t:'act', action}` and waits for the server.
- New states are shown through `show()` or `present()`. When the events include `rolled` or `paired`, the page plays the tumble → pause → fly-out animation first, in order, through a queue. This works the same way for the player and for everyone watching. Other changes show at once.
- A `roundEnd` event always goes through the queue, with reduced motion too: `present()` plays the round's Sevens Out celebration or missed-7 joke first, then `playRace(recap, swap)`, which switches to the new state under the race's curtain. States that arrive meanwhile wait in the queue, so the race is never cut off. While it plays, `ui.race` makes the page busy: game actions and shake to roll are ignored.
- Online, `canAct()` decides whether this phone may move:
  - it's this phone's seat's turn, or
  - this phone is the host and the current player is offline.
  - Other players see a "Waiting for …" note instead of the controls.

**Data actions:**
- **Setup:** `add`, `remove`, `randstart`, `mode`, `pairing`, `start`
- **Dice:** `roll`, `die`, `unpair`, `takeall`, `stop`, `end`
- **Scoreboard:** `key`, `back`, `clear`, `rolls`, `commit`, `undo`, `drop`
- **Corrections:** `edit`, `estep`, `esave`, `ecancel`
- **Flow:** `again`, `new`/`newyes`/`newno`
- **Developer:** `endearly`/`endyes`/`endno`, `devconfetti`, `devdoom`, `devmiss`, `devround`
- **Settings:** `sound`, `look`, `shake`
- **Online:** `online`, `oback`, `ocreate`, `ojoin`, `omode`, `opairing`, `ostarter`, `ostart`, `oreopen`, `okick`, `ocopy`, `oshare`, `oleave`/`oleaveyes`/`oleaveno`

**Debugging:** `window.SevensDebug` gives read-only `state`, `net` and `busy` views (`busy` is also true during the race between rounds). The tests use it.

### The room server (`server/core/room.js` + adapters)

One `Room` per room code holds the authoritative game.

**Wire protocol** (JSON over WebSocket at `/room/<CODE>`; codes are 5 characters from `A–Z` without `I`/`O` and `2–9`):

| Direction | Message |
|---|---|
| client → server | `{t:'hello', name, token?, create?}` |
| client → server | `{t:'act', action}` |
| client → server | `{t:'lobby', op:'settings'\|'start'\|'reopen'\|'rename'\|'kick'\|'leave', …}` |
| client → server | `{t:'ping'}` |
| server → client | `{t:'welcome', seat, token}` |
| server → client | `{t:'room', rev, room:{code, phase:'lobby'\|'game', host, settings:{mode, pairing, starter}, seats:[{id,name,connected}]}, state, events}` |
| server → client | `{t:'error', code, message}` |
| server → client | `{t:'pong'}` |

**Statistics** (`server/core/stats.js`, D1 via `server/d1/`):
- Rooms record their game through the optional `stats` adapter: `playing` on start, `over` whenever an action leaves the game over, `playing` again when undo leaves game over, `abandoned` on reopen mid-game or when the room expires. Each game has a 16-hex `id`; a new record replaces the old one.
- The Cloudflare adapter writes to D1 and keeps failed writes in `pendingStats`, retried from the alarm (1 min doubling to 1 h, dropped after 24 h). Writes in one room run one after another. When an empty room is removed, `pendingStats` stays and is retried; storage is cleared only once nothing is waiting.
- `POST /report` takes a finished one-phone game; `checkReport` rebuilds it with the engine (dice games: full rules; scoreboard games skip the starter and 101-round checks because corrections can change past rounds). 10 per minute per IP, 16 KB max.
- The admin page reads the same database. `/api/games?before=` takes the opaque cursor `<finishedAt>_<id>`.

**What `hello` does:**
- With a matching token, the player gets their seat back.
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
- **Node (`server/node/server.js`):**
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
  - **The curtain:** a leather curtain drops with "Round N+1", "<Name> starts" ("You start" on that player's own phone online; spectators see the name) and the reason ("Highest score: 64", "Tied on 40, got there first", "Tied on 40, next in turn"). The new round is swapped in underneath, and the curtain lifts on it.
  - **Skipping:** a tap on it, Escape, Enter or Space ends it at once.
  - **Sound:** `sound.round()` plays a short sting as the curtain drops, in the jackpot or old-bandit flavour, and nothing when the sound is off.
  - **Online:** every phone plays it from the same events. A phone that reloads or reconnects meanwhile just shows the new round. A correction emits only `edited`, so it never plays the race. Leaving the room bumps `net.session`, and changes still queued from that room are dropped, so the phone's own saved game stays as it was.
  - **Saving:** a one-phone game saves the new state as soon as the race starts, so a reload mid-race keeps the last turn.
  - **DOM:** `.race` (fixed, outside `#app`) → `.race-card` (the list's `.bhead` and `li.pl` lines from `lineHtml`, plus `.race-badge`) and `.race-curtain` (`.race-round`, `.race-starter`, `.race-why`).
- **Developer menu.** Play confetti, Play shots alarm, Play missed 7, Play round change (the race for the round just finished, or made-up points before there is one), and End game now (host only when online).
- **Reduced motion.** Rolls are instant, pairs are set aside without flying, there's no confetti, the shots takeover is shortened, and the missed-7 joke appears without moving. The race between rounds shows the grown list with its final totals, order and badge at once. The curtain then appears without sliding, and the whole race takes about 2.5 s.

## Conventions

- **Phones first.** 390 px wide, 16 px gutters, no sideways scrolling. Check both looks and light/dark.
- **Colours only through the CSS tokens.** The shots takeover is the deliberate exception.
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
  - `tests/fake-d1.js` is a D1 stand-in on `node:sqlite`, and `tests/games.js` builds deterministic finished games.
- **Browser tests (`@playwright/test`):**
  - Separate browser contexts act as separate phones.
  - The tests read state through `window.SevensDebug` or `localStorage`.
  - Use `contextOptions: { reducedMotion: 'reduce' }` for instant rolls.
  - To fix the dice, stub `crypto.getRandomValues` for 1-byte arrays (`fixDice` in `tests/e2e/helpers.js`).
  - After a round's last turn, the race plays for about 2.5 s even with reduced motion. Tests that act right after a round ends call `skipRace(page)` (helpers.js): it waits for a Sevens Out or missed-7 joke that plays first, taps the race away, then waits until the page is idle.
  - `TARGET=worker` points online play at `wrangler dev` through the `?server=` override.
  - `tests/e2e/admin.spec.js` tests the admin page (`npm run test:admin`). Don't run it together with `test:worker`: both reset `.wrangler/e2e`.

Invariants to keep after rule changes:
- Rolls stay within the round's `mark`.
- Totals equal the score sheet.
- Each starter follows the highest-score rule, including the got-there-first tie-break.
- The game ends at the end of the first round in which anyone is at 101 or more, and the loser follows the tie rule.
- Online, every phone shows the same state.

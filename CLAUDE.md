# Sevens Out

Dice games for 2–12 players, played on phones: **Sevens Out** (the default), **42/18** (Zweiundvierzig-Achtzehn, `game.kind: '4218'`) and **Schocken** (`game.kind: 'schocken'`). The app has two ways to play together:

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
server/d1/                 schema.sql (stats + accounts + rooms), db.js (D1 adapter), write.js (store/replace/delete a game, write a room),
                           accounts.js (account store), migrations/0001-accounts.sql, 0002-rooms.sql (once each, for the live database)
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
npm run db:rooms                  # once: add the rooms tables (admin page's live and past rooms) to the live database
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
  - It reaches live rooms through the service binding `GAME` → the game Worker's `AdminApi` entrypoint, so deploy the game Worker first. Rooms need `npm run db:rooms` first (until then their row writes fail quietly; games are unaffected).
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
   - First round: chosen on Who's playing or in the lobby, or picked at random.
   - After that: the player with the highest total starts.
   - **Tie:** whoever reached that score first, worked out by replaying the score sheet in playing order (`reachedAt`). A 0-point turn does not count as reaching the score again.
   - **Still tied** (for example everyone on 0): the next of the tied players after the last starter.
6. **Ending.** When any player reaches **101 or more** (`LIMIT`), the current round is played to the end. Then the highest score loses.
   - **Tie for highest:** the player who played later in that last round loses.

### 42/18 (`game.kind: '4218'`)

The most common pub rules, chosen for the first version (refine with the owner):

1. **Dice and rolls.** A turn uses 5 dice (`FT_DICE`). After each roll the player keeps at least one die and may roll the rest again, as long as dice are left, so at most 5 rolls (`FT_ROLLS`); the player can stop after any roll. Rolling again needs a die kept from this roll (`keep {id}`; `roll` without one is refused with `keep_one`). A die kept in this roll can go back (`unkeep`); earlier ones stay.
2. **The throw.** It needs a 4 and a 2 (the "42"). The other three dice are its points, 3 to 18 (`throwPts`); 42/18 (three 6s) is the best and emits `perfect`. Without a 4 and a 2 it is "no 42", stored as 0 points, the worst.
3. **The round.** Everyone plays one turn in seating order from the starter. The lowest throw loses the round and takes a coaster (`roundLoser`; stored in `rd.loser`). Tie: more rolls lose, then the later player.
4. **Who starts.** Round 1 as in Sevens Out; after that the round's loser.
5. **Ending.** The first to 3 coasters (`COASTERS`) loses. A player's `score` is their coasters, so higher is worse in both games.
6. **Real dice:** each player enters the points (3–18, or No 42) and the rolls used (1–5, everyone: they break ties). Undo, dice on the floor and corrections work as in Sevens Out; a correction counts the coasters again (`ftRecalc`).
7. **Not yet:** the statistics skip 42/18 (no report, no room record), so the D1 schema is unchanged.

### Schocken (`game.kind: 'schocken'`)

Common pub rules with the blind throw, chosen for the first version (refine with the owner):

1. **Dice and rolls.** A turn uses 3 dice (`SK_DICE`), up to 3 rolls; the round's starter sets the limit for everyone else (`game.mark`, as in Sevens Out). After each roll the player sets aside any dice (`keep {id}`, none is fine) and rolls the rest, or stops. A die set aside in this roll can go back (`unkeep`).
2. **Turning 6s** (`flip`): two 6s from the same roll may become one 1, three 6s two 1s (`canFlip`). The other 6 goes back into the cup: it can't be set aside (`flip_back`), and stopping is refused until it is rolled (`flip_roll`). Not on the last roll. Putting a turned 1 back undoes the turn.
3. **Throws, best first** (`skThrow`): Schock out (1-1-1, all coasters, emits `schockOut`), Schock 6 to 2 (1-1-x, x coasters), General (three of a kind, 3), Straight (three in a row, 2), then any other throw (1), read as a number from the highest die (665 … 221). A General or Straight counts only from one roll ("from the hand": every die from the same roll, none turned, `skHand`); built, it is a number. Tie: fewer rolls win, then the earlier player (`skBetter`).
4. **Blind** (`blind`): instead of rolling, the player rolls blind; the turn ends at once with the cup down. The engine rolls those dice only when the round's last turn is booked (`revealed`), so no phone ever holds the secret. When the round's highest or lowest throw was blind, the coasters double.
5. **Coasters.** The round's lowest throw takes as many coasters as the highest is worth: from the pot of 13 (`SK_POT`, `game.pot`) while it has some (what's left, if less), then from the player with the highest throw. Schock out hands the loser every coaster. Once the pot is empty, players without coasters sit out the half (`skInPlay`, `game.order` holds only those in play). A player's `score` is their coasters in the current half.
6. **Halves.** Whoever holds all 13 loses the half (`halfOver`, `game.halves`). Two halves; the same loser twice loses the game, two different losers play a final (`game.half: 3`) and its loser loses. The round's loser starts the next round (also the next half and the final).
7. **Real dice:** each player enters the three dice (1–6), the rolls used (1–3 for the starter, up to the limit for the others), "From one roll" for a General or Straight from more than one roll, and Blind. Undo, dice on the floor and Ending early work as in Sevens Out (ending early: the most coasters lose; right after a half, its loser). **No corrections yet** (`edit` is refused; the list lines aren't tappable).
8. **Not yet:** the statistics skip Schocken; local rule variants (Jule 4-2-1, covered last throws, Schock out from the hand above a built one).

### Scoreboard mode ("Real dice, scores here")

- **Entering a turn:** each turn the player enters the pips left on the table (0–36). The starter also enters the rolls used (1–3).
- **Undo:** reverts the last entry, dropped die or correction, using snapshots in `game.history` (capped at 40).
- **Dice on the floor:** one counter is shared by the table (`game.drops`), and each drop counts against the player whose turn it is. The third drop means that player pays a round of shots: it triggers the skull takeover, is recorded in `game.shots`, and resets the counter.
- **Corrections:** tap a player's line in the score list to edit any past round. The engine rebuilds the totals (`recalc`) and re-applies the starter and 101 rules wherever the game stands. A game ended early stays over.
  - While nothing has been played in the new round, a correction re-applies the starter and 101 rules to the finished rounds (the round restarts with the right starter, or the game ends); dropped dice don't close that window; shots from a removed empty round move to the finished round.

### Dice mode extras

- **Pairs of 7** is chosen in the Play sheet ("The app finds the 7s" switch) or in the lobby.
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
| Setup | `start {names, starter, mode, pairing?, seats?, kind?}` (`pairing` defaults to `manual`; `kind: '4218'` starts 42/18, `'schocken'` Schocken) |
| Dice turn | `roll`, `pair {a, b}`, `unpair {index}`, `takeall`, `stop` (alias `end`); 42/18: `roll`, `keep {id}`, `unkeep {id}`, `stop`; Schocken also `flip`, `blind` |
| Scoreboard turn | `score {pts, rolls?}` (42/18: `pts` 0 or 3–18, `rolls` always; Schocken: `score {dice: [a, b, c], rolls, hand?, blind?}`) |
| Table | `drop`, `undo`, `edit {player, values: {roundNo: pts}}` |
| Flow | `nextround` (only for games saved between rounds, the old `roundEnd` phase), `endearly` |

**Rounds move on by themselves:** the action that books the last turn of a round (`stop`/`end`, `score`) also starts the next round, unless someone is at 101. Ending early before anyone has played in the new round drops that empty round first.

**Events** (for animations and messages): `started`, `rolled {auto, values}`, `paired {pairs}`, `unpaired`, `missed {player, how: 'roll'|'stop', pairs: [[a, b]..]}` (pip values), `sevensOut {player}`, `turn`, `roundEnd {round, next}` (always followed by `started` in the same action; 42/18 adds `loser`), `gameOver {loser}`, 42/18's `kept {id, value}`, `unkept {id, value}` and `perfect {player}`, Schocken's `flipped {ids, back}`, `unkept {…, flip}`, `revealed {player, values}`, `schockOut {player}`, `halfOver {half, loser}` (and `turn {blind: true}`), `dropped {drops}`, `shots {player}`, `undone {msg}`, `edited`, `ended`.

### State

The page saves the phone's own game to `localStorage['sevens-out-v1']`. Online games live on the server and are never saved there.

```js
state = {
  phase: 'setup' | 'play' | 'over',   // 'roundEnd' only in games saved before rounds moved on by themselves
  setup: { names: [..], starter, kind?, mode: 'dice' | 'score', pairing: 'manual' | 'auto', where? },   // kind: 'sevens' | '4218' (missing = sevens)   // the Play sheet and Who's playing; where: 'table' | 'phones' (missing = table)
  game: {
    kind?, mode, pairing?, players: [{ name, score }], seats?: [seatId..],   // kind '4218' = 42/18 (score = coasters, no pairing), 'schocken' = Schocken (score = coasters this half); pairing missing = auto (old saves); seats only online
    half?, pot?, halves?,                                         // Schocken: 1 | 2 | 3 (the final), coasters left in the pot, each half's loser
    round, starter, order: [playerIdx..], pos,                    // whose turn: order[pos]
    mark,                                                         // roll limit set by this round's starter
    rounds: [{ no, starter, mark, results: { [playerIdx]: { pts, rolls } }, loser? }],   // the score sheet (loser: 42/18, who took the coaster)
                                                                  // Schocken: results {dice (null while blind), hand, rolls, pts = worth, blind?, kept?},
                                                                  // and half, loser, high, take, from ('pot'|'player'|'all'), pot, after (coasters), halfLost?
    turn: { …, flip? },                                           // Schocken: dice carry from (the roll) and flipped; flip {roll, ids, back}
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
- `sevens-out-online`: `{code, token, name, server, seen}`, used to rejoin a room after a reload or a locked screen (`seen`: the last chat message id this phone has read)
- `sevens-out-seats`: `{"<server> <code>": token}`, the seat tokens of the last 8 rooms this phone sat in, kept after Leave room, so joining a room again with its code takes the same seat back (mid-game the server keeps the seat of a player who leaves)
- `sevens-out-reports`: `{queue, sent}`, finished one-phone games waiting to be sent to `POST /report` until the server accepts or refuses them
- `sevens-out-account`: `{[authBase]: {token, id, name}}`, the signed-in player per server, so a `?server=` override never touches the real one (an old single `{token, id, name, server}` reads as one entry)

### The page (`index.html`)

The script is one IIFE. Every `render()` rebuilds `#app.innerHTML` from template strings. Layers that must outlive a redraw live outside `#app`: the bottom sheet (`.sheet-layer`), the race (`.race`), the shots alarm (`.doom`) and `#acct-live`.

**Routing** (`render()`): online, the room's screens (connecting, lobby, game); else the Profile screen (`ui.screen === 'profile'`), home (`onHome()`), and while `state.phase === 'setup'` Who's playing (`'players'`); otherwise the phone's own game. `ui.screen` is `null`/`'home'` | `'players'` | `'profile'` (`homeScreen()` returns `ui.screen || 'home'`).
- A saved one-phone game opens straight into the game.
- `onHome()` is true during setup, and also over a saved game in play when `ui.screen === 'home'`: a `?join=` landing, a failed join, or Back from the Profile screen. Play there goes back to the saved game.

**Building blocks:**
- **Bottom bar** (`bar(inner, {leather})`): a `.bar` with the screen's main action, `position: sticky` at the bottom and padded by `env(safe-area-inset-bottom)`.
  - Every play screen has one: the dice turn (Stop | Roll | rack), real dice (Save), corrections (Cancel | Save changes), game over (Play again), Who's playing (Start game) and the lobby (Start).
  - A phone that may not act gets the waiting note in it instead.
  - The turn screens use the C4 footer: `.bar.leather.c4bar` (dice) and `.bar.leather.c4save` (real dice), leather-deep with a 28 px top radius (`.bar:is(.c4bar,.c4save)`).
- The bar (or home's `.felt-home`) is the last child of `#app`; `render()` then gives `#app` the class `has-bar` (min-height of the screen), so it reaches the bottom edge. Nothing after `#app` may add height (`#acct-live` sits at the top).
- **Bottom sheet:** one layer outside `#app` (`.sheet-layer` → `.sheet-backdrop[data-act=sheetclose]` + `section.sheet[role=dialog][aria-modal]` with `.sheet-grab`, `.sheet-head` (`h2#sheet-h`, `.sheet-close`), `.sheet-body` and two focus guards).
  - Kinds are registered in `SHEETS` as `{title, ok(), body()}` (`title` may be a function): `menu` (the game menu), `play` (the Play sheet), `settings` (the Settings sheet), `join` (the Join sheet) and `chat` (the table talk, online only; `ok()` needs the room and `net.chat.ready`). `openSheet(kind, from)` shows one (`ui.sheet`); `closeSheet()` hides it and gives the focus back to the opener (`from` = its `[data-act, data-id]`, kept in `ui.sheetFrom`). Closing the Join or Play sheet clears `ui.hint`.
  - Every `render()` rebuilds only the body (`renderSheet()`), keeping its scroll position, the focused control and a focused text field (id and caret), and closes the sheet when `ok()` says it doesn't belong on the new screen.
  - While it is open, `#app` is `inert` and the page doesn't scroll (`html.sheet-open`). Escape, the close button and a backdrop tap close it, and Tab stays inside. The keypad keys and shake to roll are ignored.
  - **The chat sheet** keeps its foot (`.sheet-foot` with `#chattext`) as the same element across redraws, so the draft keeps its focus, caret and a word being composed; only the reactions, the log and the hint are swapped, and the log stays at the bottom while the reader is there.
  - Reduced motion: no slide. Stacking: above the bar, below the race, the shots alarm, the missed-7 joke and confetti.
  - `newyes`, `oleaveyes`, `endyes` and the `dev*` actions close it first. The race between rounds closes it too.
- **Game menu** (sheet kind `menu`, title "Game menu"): opened by the menu button (`menuButton()`, `button.menubtn[data-act=menu]`, top left of the dice turn, real dice, corrections, game over and the lobby). It holds the score sheet (`sheet(g)`, a fold open by default; only with a game), How to play (`rules()`), Sound and Look (`settingsBlock()`, with Shake where it shows), New game (one phone, during play) or Leave room (online) with their in-page confirmations (`quitBlock()`), and Developer (`devBlock()`, folded). Nothing sits under the play screens.
- **The turn screens' header** (`chipHeader(g, cur)`, `header.top.chiprow`): the menu button on the left and the score chip on the right (see "The score chip"), then the chat button (`chatButton()`, see "Table talk"; only online, once the server speaks chat). Online, while the room isn't connected, the room chip (`netChip()`, "Room ABCDE · Reconnecting…") sits under that row in `.roomrow`.
- **Under it** (`turnHead(g, cur, eyebrow)`, `div.turnhead.c4`, centred): the eyebrow (`p.eyebrow`, `--brass-text` caps), the big name (`h2.who`, 48 px Big Shoulders, `you` online), when someone is at 101 one `.alert` line ("Anna is at 104. Last round: the highest score loses."), and online once the server speaks chat the message feed (`feedArea()`, `div.feed`, two lines high, empty or not; see "Table talk").
- **The slim header** (`header(g)`) tops corrections and game over: the menu button, "Round N · M rolls max" ("Game over" at the end; `p.rnd`), the room chip online (`netChip()`, only while not connected once the chat button shows), the chat button at the right end, and during play the 101 `.alert` line.
- **On the leather** (`html.felt`): `render()` sets it on home (with `html.felt-home`, leather-deep) and while a turn screen shows (`#app > .felt-turn`). The page background becomes the leather, and inside `#app` (and the race card) the tokens are remapped to ink on leather (`--ink` = `--on-leather`, `--brass` and `--brass-text` = `--stitch`, `--danger` = `--on-leather-danger`, …), so everything drawn with tokens follows in every look. Corrections, game over, Who's playing, the Profile screen and the lobby stay on paper.

**Home and what opens from it** (only while no game is shown):
- **Home** (`viewHome()`, `.felt-home`):
  - The header (`header.home-head`, 48 px): on the left the Settings button (`button.menubtn[data-act=settings][aria-label=Settings]`, sliders icon); on the right the profile chip (`profileChip()`, `button.profile-chip[data-act=profile]`). Signed in, the chip shows the name and an avatar initial, with `aria-label` "Your player: <name>"; signed out, "Sign in" and the person icon. It is left out when accounts aren't available.
  - In the middle: the big title, two tilted dice and one line.
  - At the bottom (`.home-go`): Play (`button.play[data-act=play]`, opens the Play sheet), then, only with `onlineAvailable()`, the code row (`.code-row`: `#ocode` with the hidden label "Room code", placeholder "Got a room code?", maxlength 5, capitals; and an outline Join, `ojoin`), and under it the hint (`p.hint.home-hint`).
- **Joining** (`ojoin`): it only ever joins the code shown, never creates a room.
  - A bad or missing code gives "Enter the 5-character room code." under the code row, focuses `#ocode` and opens no sheet.
  - A signed-in player joins at once. A guest gets the **Join sheet** (kind `join`, `joinSheet()`, title "Join room <CODE>" from `ui.joinCode`): the name field (`#oname`, from `sevens-out-name`), the hint, and Join pinned in `.sheet-foot`. Join without a name asks for one. Enter in `#ocode` or in the sheet's name field joins.
  - `?join=CODE` opens home with the code filled in, and for a guest also the Join sheet with the name focused. It never joins by itself.
  - Join closes the Join sheet before it connects, so room errors (`no_room`, `room_full`, `kicked`) always land on home with the hint under the code row and the code kept.
  - A join sends the seat token kept for that room in `sevens-out-seats`, so a guest who left mid-game gets their seat back and plays on.
- **Settings sheet** (kind `settings`, title "Settings", only on home): Sound, Look and Shake (`settingsBlock()`, segmented rows) with the shake hint (`.shake-hint`), then How to play and Developer as folds.
- **Play sheet** (sheet kind `play`, `playBody()`, title "New game"; on home and Who's playing):
  - "Game": Sevens Out / 42/18 / Schocken (`button.opt[data-act=kind][data-id=0|1|2]`, the place in `KINDS`, in `.cards.three` → `state.setup.kind`; a game an old cached `engine.js` lacks is left out, `hasFT()`, `hasSK()`). Only Sevens Out has the 7s switch.
  - "Where is everyone?" At this table / Own phones (`button.opt[data-act=where][data-id=0|1]` → `state.setup.where`, `'table'` | `'phones'`, missing = table; left out without online).
  - Dice: In the app / Real dice (`opt[data-act=mode][data-id=0|1]`).
  - For dice in the app, the switch "The app finds the 7s" (`pairSwitch()`, `button.switch[role=switch][data-act=pairing]`: no `data-id` toggles, 0/1 sets manual/auto).
  - Choices write to `state.setup` (saved at once). Pinned at its bottom (`.sheet-foot`, with `.hint`): "Next: who's playing" (`players`; "Done" when opened from Who's playing) or, for own phones, "Create room" (`ocreate`), with a name field (`#oname`) above it only for a guest without a saved name (`sevens-out-name`). A signed-in player plays under the player name. Enter in that name field creates the room.
- **Who's playing** (`viewPlayers()`, `ui.screen === 'players'`): a back button (`.menubtn[data-act=home][aria-label=Back]`), `h1#players-h`, "Random starter" (`randstart`), and the players card (`.pcard`). Each row (`.prow`) has:
  - a starter die (`input[type=radio][name=starter]#starter-N` drawn as `.mkdie`, `aria-label` "<Name> starts" or "Let <Name> start", kept current by `syncStarters()`),
  - the name field (`#name-N`), "You"/"This is me" (`me`) when signed in,
  - remove (`remove`, `aria-label` "Remove <Name>", only above 2 players).
  - "Add player" (`add`) is inside the card. Under it: the hint "The die marks who starts round 1." (or the last `ui.hint`), a compact mode row (`data-act="play"`, "Dice in the app · You find the 7s", "Real dice · Scores here") that opens the Play sheet, and Start game pinned in the bar (`start`).
  - Play again and New game (`toSetup()`) land here with the last players and mode. `play`, `players` and `where` clear `ui.hint`.
- **Creating a room** (`ocreate`, from the Play sheet): the server creates every room as dice / find the 7s yourself / starter 0. `netStart` keeps the chosen `state.setup` mode and pairing in `net.createWith`; on the `welcome` for the room this phone created (`net.creating`), the page sends `{t:'lobby', op:'settings', mode?, pairing?}` with only the values that differ from those defaults (nothing for dice / manual). The lobby may show the defaults for a moment. No protocol change.
- **Profile** (`viewProfile()`, `ui.screen === 'profile'`, opened by the profile chip), on paper: a Back chevron (`.menubtn[data-act=home][aria-label=Back]`, always back to home) and `section.acct` (`.in` / `.out`) filling the screen (`#app.profile-on`). Opening it focuses `#profile-h`.
  - **Signed in:** an 88 px brass avatar with the initial, `h1#profile-h` with the name and the muted `#tag`, the line "Your games count for you on any phone where you sign in.", a card of 60 px rows (`.rowbtn`: icon, label, sub-line, chevron): Rename (`arename`, in place), "Add a passkey on this phone" (`aadd`) and Sign out (`asignout`); then the hint, and "Delete player" (`adelete`, `--danger`, confirmed in the page) at the bottom.
  - **Signed out:** an empty avatar (person icon), `h1` "Keep your scores", the same line, the name field (`#aname`), "Sign in with a passkey" (`asignin`, primary) and "New player" (`acreate`), then the hint.

**The lobby** (`viewLobby()`; Settings starts with Game, `okind` 0/1/2, host only, which sends `{op:'settings', kind}`): the slim header with the menu (Leave room is in it), "Room" (the connection chip only while not connected) and the chat button at the right end; a card with the room code large (`.roomcode`) and "Share invite" (`oshare` when the phone has a share sheet, else `ocopy`; a failed share copies, a failed copy shows the link `#olink` selected, `ui.showLink`, reset when the phone leaves or starts a room); the seats under "Players · n of 12" (`#seats-h`; `ul.seats` → `li.seat`: online dot (`--ok`), name, `#tag`, `you`, Host, and for the host a remove button `okick[data-seat]`); Settings rows for everyone, changeable only by the host: Dice (`omode` 0/1), for dice in the app the same switch as the Play sheet (`button.switch[data-act=opairing]`), Who starts (`ostarter`, -1 = random). The pinned bar: the host's "Start · N players" (`ostart`, disabled under 2 as "Waiting for one more player"), the others "Waiting for <host> to start."

**The score chip** (in `chipHeader()`): `button.scorechip[data-act=scores][aria-expanded]` with every player's name and total in one line, in this round's playing order (`span.sc-p`, the current player `.now` in `--brass-text`, bold), an `aria-label` "Scores: Anna 34, Ben 50, …", and a chevron. Online, once the server speaks chat, the chat button shows the connection only when it is lost (a red `.chat-dot`); with an old server the chip keeps its dot (`.sc-dot`, `--ok`, `--danger` while not connected).
- **Fitting one line:** names shorten to their first 3 letters from 4 players (letters 2–3 sit in `.sc-mid`, the rest is hidden in `.sc-rest`, so `textContent` keeps the full name; the `aria-label` always has the full names). `fitChip()` runs after every render, on resize and when the fonts load: it adds `short` when the names overflow, then `tight` and `tiny` (smaller type, no chevron), then `mini` (names down to their first letter), then `micro` (smaller type and gaps, for the chat button online) while it still overflows. Offline, six 3-digit totals fit whole at 375 px in both looks (Vegas needs `mini`) and at 320 px (`mini`); online, next to the chat button, they need `micro` at 320 px; the chip-fit tests check every name and total lies inside the chip's box.
- **7 to 12 players** (more than `CHIP_ALL` = 6, class `crowd`): the chip shows the current player (`.sc-p.now`, name in `.sc-n` + total), the leader by total when that's someone else (the first in playing order with the top total), and `span.sc-more` "+N more" (N = the others), then the chevron. A name that doesn't fit ends in "…" (`.sc-n`, ellipsis); `fitChip()` adds `tight` and `tiny` while a name is cut. It stays on one line at 320 px with 3-digit totals and long names, also next to the chat button online (12 players). The `aria-label` still lists every player and total.
- **The list:** a tap toggles `ui.scoresOpen`, which shows the full score list (`board()`, the same `section.board` DOM) in `div.scores-pop#scores` under the chip row, over the mat. The chip again, Escape, or a tap on the mat closes it (the focus goes back to the chip); that tap does nothing else, while Enter or Space on a focused die or key closes it and acts. Bar and menu taps act with it open, and tapping the chip doesn't disarm Stop. `render()` resets `ui.scoresOpen` whenever no chip is shown, and game over resets it.
- **List height:** `fitScores()` (run from `fitChip()`) gives `.scores-pop` a `max-height` that ends at the mat's bottom or the pinned bar, whichever is higher; a longer list (12 lines on a small phone, or tappable 44 px rows) scrolls inside it, and its scroll survives a redraw. The race resets it to the top first (`listInView()`).
- **The rule:** up to 6 players the chip shows every total at all times; from 7 it shows the current player and the leader, and the full list is one tap away. In real-dice mode corrections start from a line in that list.

**The dice turn** (`viewPlay()`): `chipHeader`, then `section.turn.felt-turn.diceturn` with `turnHead` and the mat, then the C4 bar.
- **The eyebrow:** "Round 4 · Roll 1 of 2" after a roll, "Round 4 · Up to 2 rolls" before the first, "Round 1 · Anna sets the limit" while the round's limit isn't set.
- **The mat** (`.mat`, edge to edge, the whole free area between the header and the bar): the dice layer `.dice` and, at its bottom, `.mat-foot` with the one `.hint` line, centred, and with automatic pairing "Set aside all 7s" (`takeall`) next to it. See "The dice on the mat".
- **The bar** (`.bar.leather.c4bar`, a grid `1fr 104px 1fr`):
  - **Left** (`.c4left`): before the first roll the plain text "Up to N rolls" (`p.barnote`, not a button); after a roll Stop (`button.btn.stopc[data-act=stop]`, outline, "Stop" / "+N"); empty when no rolls are left. The first tap on Stop arms it (`ui.armed`): it reads "Confirm" / "+N", and the hint says "Everyone gets N rolls. Tap again to stop." (the starter) or "You have N rolls left. Tap again to stop.", one line even at 375 px.
  - **Centre:** the round Roll button (`button.btn.primary.rollbtn`, a 104 px circle, "Roll" / "N dice"). With no rolls left or all six dice out it becomes End (`end`, "End" / "+N"). While rolling or setting aside 7s it is disabled with "…" ("Rolling" for screen readers) and no `data-act`.
  - **Right** (`.rackcell > .rack`): the set-aside pairs as mini dice, with "set aside" under them, or "7s land here" while it's empty. A pair from this roll is a `button.pair[data-act=unpair]` at least 44×44 px, labelled "Put a and b back on the table"; older pairs are `span.pair[role=img]`. With three pairs (`.rackcell.full`) the minis are 16 px, so they fit at 375 px.
  - **Not this phone's turn:** `.c4bar.wait`: the waiting note ("Waiting for Ben to roll") with the pulse spans the first two columns, and the rack cell stays (read-only), so watchers see the pairs fly in. The host covering for an offline player gets the controls.
- **Fit:** at 375×667 with six players and the 101 alert the chip stays on one line (with twelve, at 375×667 and 320×568, the crowd chip does too), six dice fit on the mat apart, and Stop, Roll and the rack are on screen without scrolling; online with the feed area too (the mat is 72 px shorter, the dice keep their size).

**The dice on the mat** ("the dice on the mat" section of the script):
- **Each roll** places the dice still on the table at random spots inside the mat (`layoutDice(n, w, h, die, rng, {bottom, fixed})`, pure; `x`, `y` are the die's centre as fractions of the mat, `rot` a tilt from −20° to 20°).
  - Each die's rotated box stays 8 px (`MAT_EDGE`) inside the mat and above the foot (`matFoot(g)`: 64 px for the hint, 114 px with automatic pairing).
  - On a short phone whose page is longer than the screen (320×568 online, with the feed area), the part of the mat under the pinned bar is off-limits too: the foot grows to cover it (`matUnderBar()`, measured with the page at the top, never from the reader's scroll), as long as six dice still fit above it in the 3 × 2 grid; otherwise the whole mat as before.
  - No overlap: an exact separating-axis test on the rotated squares with a gap of `matGap(die)` (max(6 px, 12 % of the die)).
  - Best-candidate sampling spreads the dice over the mat; after 40 failed tries a jittered grid (3 × 2 for six) takes over.
  - Before the first roll the mat is empty; the first throw brings the dice in.
- **The die size** (`matDie(w, h, bottom)`): min(22 % of the width, height / 4.2, a size where six dice fill at most ~30 % of the free area), clamped to 48–92 px; set inline as `--die` on `.dice`.
- **Stable spots:** `ui.layout` keeps the spots by the key `<game>:<round>:<player>:<rolls>` (the game is `state.stats.id`, or the seats online; the last 4 keys). Redraws, taps, a selected die, a pair put back (its dice return to their spots) and a remote state update never move the dice. A new roll draws new spots for the rolled dice only; while rolling the key is `rolls + 1`, so the dice are thrown onto the spots the result keeps. Online, each phone draws its own layout; nothing goes over the wire. `resetUi()` clears `ui.layout`.
- **`placeDice()`** runs after every `render()` (before paint), on resize and when the fonts load: it measures the mat and sets `--die`, inline `left`/`top` (% of the mat) and `--rot` on each `.die[data-id]`. A width change reuses the fractions while they fit; a height-only change keeps the pixel spots while they fit; otherwise the dice that still fit stay and the rest get new spots (`spotsFit()`, `fixed`).
- **The DOM:** `.dice` is the mat's dice layer; each die is `.die[data-id]` (`button` when it can be tapped) with `aria-label="Die showing N"`, absolutely positioned, in `t.dice` order (stable Tab order). Held dice aren't drawn.
- **Motion:** the rolled dice are thrown in from just above the mat's top edge (`animation: throw .5s`, staggered by 40 ms, faces flickering); the tumble wait is `throwTime(n)`. Then the pause and the fly-out of the pairs into the rack cell (`flyNext()`, the target is `.rackcell .rack .pair:last-child .die.mini`; `ui.reveal` keeps the lit pair and the hidden landing minis across redraws). Reduced motion: the dice appear in place.

**The real-dice turn** (`viewScore()`): `chipHeader`, then `section.turn.felt-turn.keyturn` with `turnHead` and `div.mat.keymat`, then `.bar.leather.c4save`.
- **The eyebrow:** "Round 4 · Starts the round · up to 3 rolls" for the starter, otherwise "Round 4 · Up to 2 rolls".
- **The mat** (a flex column centred in the free height, no box): the entry row (`.entry-top`: "Pips left on the table" and "0–36" on the left, the big `.entry` on the right), the 12-key `.pad`, the starter's "Rolls used" 1/2/3 (`.rollpick`), "Dice on the floor" as one `.floor` row (`floorRow()`: three slots, "Die dropped", "3rd one pays the shots"), and the `.hintrow` (the hint and the small Undo link, `data-act="undo"`; it always keeps its 44 px, so the keypad never jumps).
- **The bar:** "Save · Anna +12" (`data-act="commit"`, 56 px, disabled as "Enter the pips left" or "Choose the rolls used" until ready).
- A phone that may not enter (`.keymat.watch`) gets the floor row and the hint row near the bar, and the waiting note in the bar, with no keypad.
- Keys, rolls buttons and Die dropped are at least 44 px tall. A tap on the keypad while the list is open only closes the list.
- With three players it fits a 390×844 phone without scrolling, Rolls used and Undo included, online with the feed area too. At 375×667 online, the starter's hint row and Undo scroll under the pinned bar (the feed area takes 72 px); Save stays pinned. With six players on 375×667 the mat is longer than the screen, so the page scrolls under the pinned bar; Save stays pinned and the chip shows all six totals. With twelve, the same, and the list over the mat scrolls inside itself.

**Schocken's turns** (`viewPlaySK()`, `viewScoreSK()`, 42/18's frame, `section.skturn`): the eyebrow is "1st half · Pot 9 · Roll 1 of 3" (`skEyebrow`); under the name `p.tobeat` (`skStandLine()`) shows "To beat: Anna · Schock 3 in 2 rolls" or "Low Ben 532 · High Anna Sch 3" and "· N blind". A tap on a die sets it aside into `.tray`; next to the tray `button.sktool[data-act=flip]` ("6 → 1", when `canFlip`) and `[data-act=blind]` (Blind, armed first: "Sure?"). The throw cell shows `skShort()` ("Sch 4", "Gen 5", "St 456", "653", "blind") and "lowest now" / "highest now" / "beats the low". Real dice: a 1–6 keypad (`.skpad`), the entry as three minis, Rolls used up to the limit, the switches From one roll (`skhand`, only for a General or Straight) and Blind (`skblind`). The score list (`.board.sk`) lists the players sitting out last ("out"), its head says "1st half · pot 9"; the race uses `BADGE_SK`, `WHY_SK`, and a lost half drops the curtain as "Second half" or "The final"; the score sheet marks each half (`tr.halfrow`) and the loser's cell `+N`.

**42/18's turns** (`viewPlayFT()`, `viewScoreFT()`, same frame and classes as Sevens Out's): a tap on a die on the mat keeps it; kept dice lie in `.tray` at the mat's foot (`button.die[data-act=unkeep]` for this roll's, 44 px); the bar is Stop | Roll ("keep one" until a die is kept) | `.rackcell.throwcell` with the throw so far ("42+15", "no 42") and whether it "beats it" or is the "lowest now" (`.low`). Under the name on both turn screens, `p.tobeat` (`toBeatLine()`) shows the round's lowest throw so far ("To beat: Ben · 42 + 7 in 2 rolls", or "First throw of the round…"), on every phone; with real dice the hint compares the entered throw (`beats()`: a tie on points and rolls goes against the current player). Real dice: the keypad for the points, `No 42` (`data-act=no42`), Rolls used for everyone. The score list (`.board.ft`), the race (`BADGE_FT`, `WHY_FT`, the totals are coasters to 3), game over and the score sheet (`td.lc`: the round's loser) follow `isFT(g)`.

**Corrections** (`viewEdit()`), on paper: opened from a line in the chip's list (or the list at game over). The slim header, the full list, the player's rows with steppers, and a pinned bar with Cancel (`ecancel`, about 40%) and Save changes (`esave`, about 60%). Back on the turn, the chip shows closed.

**Game over** (`viewOver()`), on paper: the slim header, verdict and reason, the full list sorted by total, the shots summary, a small Undo link (scoreboard games) and the pinned bar with, on one phone, Home (`home`, about 40%: drops the finished game and goes home, where online play starts) and Play again (`again`, about 60%), "Play again with this room" for the online host (`oreopen`) or the waiting note. The score sheet is in the game menu.

**The score list** (`board(g, cur)`, one `lineHtml(g, i, opts)` per player) opens from the score chip on the turn screens and sits on the page in corrections and under the verdict at game over:
- During play and corrections the lines follow this round's playing order (`g.order`), with the current player (or the player being corrected) highlighted; players still to play are dimmed (only their names in Vegas, whose LED numbers stay lit). At game over they are sorted by total, highest first (equal totals keep seating order), and the loser's line says "Loses".
- Each line: ▶ marker, name (a die mark for the round's starter, `you` online, and online the `#tag` of the other signed-in players, which gives way first to a long name), a bar towards 101 with the last 15 hatched, the total, and this round's `+N`, `now` or `–`. Offline and rounds of shots paid add a small second row.
- Real-dice mode: seated players tap a line to correct that player's scores (`data-act="edit"`).
- Rows are about 36 px (`--rowh`), 30 px with 5–6 players (`section.board.dense`), 26 px with 7–12 (`.denser`, smaller type), and real 44 px rows when the lines are tappable (`.tall`, replaces `dense`/`denser`); `listClass(g)` picks the class. The race card copies it, so it starts exactly over the list. From 7 lines the race card also gets `crowd`: the grown rows share the screen down to 26 px (tappable ones too), so all twelve lines stay on a 320×568 screen. Game over and corrections show the whole list on the page, which scrolls under the pinned bar.
- DOM, relied on by the tests and the race between rounds: `section.board` → `.bhead` → `ol.lines` → `li.pl[data-id]` (classes `now`, `wait`, `over`, `lost`, `editable`) with `.mk`, `.nm`, `.trk > .fill`, `.num`, `.dl` and an optional `.pl-sub`; then `p.bfoot`. `lineHtml` depends only on its arguments (and the room's connections), so the race can reuse it.

**Events and actions:**
- Clickable elements carry `data-act` (and optionally `data-id`). One document click listener calls `handle(action, id, el)`, for elements in `#app` and in the sheet.
- Game changes go through `dispatch(action)`. Locally, it applies the engine. Online, it sends `{t:'act', action}` and waits for the server.
- New states are shown through `show()` or `present()`. When the events include `rolled` or `paired`, the page plays the throw → pause → fly-out animation first, in order, through a queue. This works the same way for the player and for everyone watching. Other changes show at once.
- A `roundEnd` event always goes through the queue, with reduced motion too: `present()` plays the round's Sevens Out celebration or missed-7 joke first, then `playRace(recap, swap)`, which switches to the new state under the race's curtain. States that arrive meanwhile wait in the queue, so the race is never cut off. While it plays, `ui.race` makes the page busy: game actions and shake to roll are ignored.
- Online, `canAct()` decides whether this phone may move:
  - it's this phone's seat's turn, or
  - this phone is the host and the current player is offline.
  - Other players see a "Waiting for …" note instead of the controls.

**Data actions:**
- **Home:** `home` (Back), `settings` (the Settings sheet), `profile` (the profile chip), `play` (opens the Play sheet), `where`, `mode`, `pairing`, `players` (Next: who's playing)
- **Setup (Who's playing):** `add`, `remove`, `randstart`, `start`, `me` ("This is me")
- **Dice:** `roll`, `die`, `unpair`, `takeall`, `stop`, `end`
- **Scoreboard:** `key`, `back`, `clear`, `rolls`, `commit`, `undo`, `drop`
- **Turn screens:** `scores` (the score chip)
- **Table talk:** `chat` (the chat button), `creact` (a quick reaction, `data-id` = its index), `csend` (Send). All three work during the race.
- **Corrections:** `edit`, `estep`, `esave`, `ecancel`
- **Flow:** `again`, `home` (at game over on one phone), `new`/`newyes`/`newno`, `menu`, `sheetclose`
- **Developer:** `endearly`/`endyes`/`endno`, `devconfetti`, `devdoom`, `devmiss`, `devround`
- **Settings:** `sound`, `look`, `shake`
- **Online:** `ocreate`, `ojoin`, `omode`, `opairing`, `ostarter`, `ostart`, `oreopen`, `okick`, `ocopy`, `oshare`, `oleave`/`oleaveyes`/`oleaveno`
- **Account:** `acreate`, `asignin`, `arename`/`arenamesave`/`arenamecancel`, `aadd`, `asignout`, `adelete`/`adeleteyes`/`adeleteno`

**Debugging:** `window.SevensDebug` gives read-only `state`, `net`, `busy` and `account` views (`busy` is also true during the race between rounds; `account` is `{available, signedIn, id, name}`, never the token), plus `layout` (`layoutDice`) and `dieSize` (`matDie`), so tests check the mat with the page's own code, `chat` (`{ready, unread, log}`), and `sounds` (the table sounds played since the page loaded, `"roll:pub"`, …, newest last; nothing while the sound is off). The tests use it.

### The room server (`server/core/room.js` + adapters)

One `Room` per room code holds the authoritative game.

**Wire protocol** (JSON over WebSocket at `/room/<CODE>`; codes are 5 characters from `A–Z` without `I`/`O` and `2–9`):

| Direction | Message |
|---|---|
| client → server | `{t:'hello', name, token?, create?, session?}` (`session`: the account token when signed in) |
| client → server | `{t:'act', action}` |
| client → server | `{t:'lobby', op:'settings'\|'start'\|'reopen'\|'rename'\|'kick'\|'leave', …}` |
| client → server | `{t:'chat', text}` (seated phones and spectators; 1 to 140 characters, control characters and runs of spaces cleaned, bidi controls U+202A–U+202E and U+2066–U+2069 removed (from names too); nothing but zero-width characters counts as empty; more than 8 per 10 s per sender: `rate`; before hello: `not_seated`) |
| client → server | `{t:'ping'}` |
| server → client | `{t:'welcome', seat, token, user?, viewer?}` (`viewer`: a spectator's own id, `w` + 8 hex, with `seat: null`; `user`: the player ID the server resolved; `null`: a guest, or the session has ended; left out: the accounts database couldn't be reached, or an old server. The page drops its account only on `null`) |
| server → client | `{t:'room', rev, room:{code, phase:'lobby'\|'game', host, settings:{kind, mode, pairing, starter}, seats:[{id,name,connected,user}]}, state, events}` (`kind`: `'sevens'` \| `'4218'` \| `'schocken'`, missing in rooms saved before) |
| server → client | `{t:'chat', msg:{id, at, from, seat, name, user, text}}` to every phone (`from`: the seat ID or the spectator's `viewer`; `seat`: `null` for a spectator; `id`: `data.chatSeq`, counting up) |
| server → client | `{t:'chat', log:[msg..]}` right after `welcome`, to seated phones and spectators: the last 50 messages |
| server → client | `{t:'error', code, message}` (`closed`: the owner closed the room from the admin page; the socket then closes with 4410 and the page goes home with "Room ABCDE was closed.") |
| server → client | `{t:'pong'}` |

- **Chat:** the last 50 messages (`CHAT_KEEP`) live in `data.chat` with the counter `data.chatSeq`, saved with the room; the rate-limit times are kept in memory only. Chat never bumps `rev`, so it never triggers game animations. Spectators chat under the name they joined with (or their player name).
- **Net interface:** `bind(conn, seatId, info?)` and `infoOf(conn)`. A spectator has no seat, so `bind(conn, null, {viewer, name, user})` keeps their identity with the connection: in the Worker's socket attachment (it survives hibernation), on the Node socket as `ws.info`.

**Statistics** (`server/core/stats.js`, D1 via `server/d1/`):
- Rooms record their game through the optional `stats` adapter: `playing` on start, `over` whenever an action leaves the game over, `playing` again when undo leaves game over, `abandoned` on reopen mid-game or when the room expires. Each game has a 16-hex `id`; a new record replaces the old one.
- The Cloudflare adapter writes to D1 and keeps failed writes in `pendingStats`, retried from the alarm (1 min doubling to 1 h, dropped after 24 h). Writes in one room run one after another. When an empty room is removed, `pendingStats` stays and is retried; storage is cleared only once nothing is waiting.
- `POST /report` takes a finished one-phone game, with an optional `owner` (line index) and `Authorization: Bearer <token>`: the line counts for the signed-in player only when the session is valid and the line carries the player's name (case and spaces ignored). `checkReport` rebuilds it with the engine (dice games: full rules; scoreboard games skip the starter and 101-round checks because corrections can change past rounds). 10 per minute per IP, 32 KB max (`MAX_REPORT_BYTES`; a long, low-scoring game of 12 fits).
- The admin page reads the same database. `/api/games?before=` takes the opaque cursor `<finishedAt>_<id>`.

**Rooms for the admin page** (`sessions` adapter in `room.js`, `rooms` + `room_events` in D1, `server/admin/`; see `docs/admin.md`):
- Each room has its own id `data.rid` (16 hex; a room saved before gets one on its first write), counters in `data.tally` (`connects`, `rejoins`, `spectators`, `chat`, `games`, `finished`, `peak`, `firstStart`) and a timeline counter `data.evSeq` (at most 500 events).
- `track({force, closed})` sends `sessionRow()` and the new timeline events (`note(kind, detail)`): at once for seats, connections, lobby changes, a new round, game start/over/undo and closing; at most once a minute (`TRACK_EVERY_MS`) for moves and chat alone. A failed call keeps the events in memory for the next one; tracking never breaks play. Writes in one room run one after another.
- Closing: the last player leaving the lobby (`empty`), expiry (`expired`, `expire()`), or the owner (`shutdown(rid)`, reason `admin`: abandoned stats, `error closed` + close 4410 to every phone, storage removed). `shutdown` with another room's `rid` (a reused code) does nothing.
- `adminView()`: the public room, watchers, the game state with an empty `history`, the chat count and the connection count; never tokens or chat text.
- `AdminApi` (named `WorkerEntrypoint` in `server/cloudflare/worker.js`): `room(code)` and `close(code, rid)`, via the Durable Object's RPC methods `adminView()` and `adminClose(rid)`. The admin Worker marks a row whose room has gone `gone`. Its open-rooms list only asks rooms that may be busy (someone connected or active within the hour); each ask is a Durable Object request.
- The Node server has no `sessions` adapter (it records nothing).

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
- Joining in the lobby adds a seat (up to 12, `MAX_SEATS`; the 13th gets `room_full`, and the page says "A room holds up to 12 players."). A random starter is drawn without modulo bias. During a game, a newcomer joins as a spectator.

**Authority:**

| Actions | Who may make them |
|---|---|
| `roll`, `pair`, `unpair`, `takeall`, `keep`, `unkeep`, `flip`, `blind`, `stop`, `score` | The current player's seat. The host may make them when that player is offline. |
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
  - With `STATS`, rooms also write their `rooms` row and timeline (see "Rooms for the admin page"); `AdminApi` is the admin Worker's way in.
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

- **Looks.** Chosen in the Settings sheet (home) or the game menu. "Pub table" follows the system's light/dark setting. "Vegas" is dark-only and scoped under `html:root[data-look="vegas"]`. All colours are CSS custom properties.
- **Sounds.** Chosen in the Settings sheet (home) or the game menu. They are synthesized with Web Audio and unlocked on the first tap. The Sound setting (`off` | `jackpot` | `bandit`) switches everything off and picks the flavour of the Sevens Out fanfare and the round sting.
  - **Table sounds** follow the look (`sound.cue(name, …args, {delay})` → `TABLE[name][look]`): Pub table is a leather cup, felt, bone dice and wood; Vegas is an arcade cabinet (blips, coins, a points counter). Choosing a look plays its roll.
  - **The moments:** `roll` (with the throw: cup rattle, then one landing per die at the throw's timing, 350 ms + 40 ms apart; with reduced motion it lands at once), `nope` (not a 7; picking a die up or putting it down is silent), `pair` (a pair lands in the rack, timed to the fly-out; in Vegas its pitch rises with the pair's place), `unpair`, `bars` (the race between rounds, with motion only: a tick for each step as the totals count up, fast then slowing, and a slide when the lines change places; booking a turn is silent), `floor` (a dropped die), `undo`, `over` (game over or ended early, after the fanfare or the trombone), and online only `yourturn` (only on the phone whose turn it now is, including the first turn of a game; never after the race between rounds, whose curtain says who starts) and `knock` (someone sits down in the lobby).
  - Online, every phone plays the same table sounds from the same events (a watcher hears the roll too); a phone that skipped a revision hears nothing for it.
- **Shake to roll.**
  - **When the setting shows** (Off/On in the Settings sheet and the game menu): only when the page is the top-level window and the phone has a coarse pointer.
  - **iPhone permission:** iOS needs `DeviceMotionEvent.requestPermission()` called directly inside a tap. The result shows as a hint line (`.shake-hint`) under the settings in the Settings sheet and in the game menu (`ui.shakeNote`, cleared when the sheet closes).
  - **What counts as a shake:** 3 jolts above 14 m/s² within 900 ms, then a 1.5 s cool-down.
  - **Where it works:** in dice mode, when this phone may roll.
- **Between rounds: the race to 101.** When a round's last turn is booked, every phone plays the same race (about 5 s), built from the new state with `E.roundRecap`:
  - **What happens:** if the score chip (or the list) is scrolled away (real-dice players on a short phone scroll down to Save), the page first scrolls it back into view (`listInView()`). On the turn screens with the list closed, the race card starts exactly over the score chip, clipped to its height, and grows down from it to the full list (`.race-card.from-chip`, solid leather-deep); with the list open, or on a screen that shows the list, it lifts and grows in place ("After round N · Race to 101"). The rest of the screen fades away (`#app.racing-c4` on the turn screens, the chip hidden). The bars move from each player's total at the start of the round by the round's points while the totals count up, then the lines reorder by total (highest on top, ties in the finished round's order).
  - **The round's best moment** pops up as a badge, the first that applies: Sevens Out with the first roll, Sevens Out, a round of shots paid, new on top, into the danger zone (86 or more), Ouch (a turn of 20 or more). Nothing applies, no badge.
  - **The curtain:** a leather curtain drops with "Round N+1", "<Name> starts" ("You start" on that player's own phone online; spectators see the name) and the reason ("Highest score: 64", "Tied on 40, got there first", "Tied on 40, next in turn"). The new round is swapped in underneath, then the curtain slides down and away. "<Name> starts" and the reason are fully shown about 1 s before it leaves.
  - **Skipping:** a tap on it, Escape, Enter or Space ends it at once.
  - **Sound:** `sound.round()` plays a short sting as the curtain drops, in the jackpot or old-bandit flavour, and nothing when the sound is off.
  - **The game menu** closes when the race starts (`playRace()`), so a phone with its menu open never misses it.
  - **Online:** every phone plays it from the same events. A phone that reloads or reconnects meanwhile just shows the new round. A correction emits only `edited`, so it never plays the race, and a correction screen open on another phone stays open when the round moves on. Leaving the room bumps `net.session`, and changes still queued from that room are dropped, so the phone's own saved game stays as it was.
  - **Saving:** a one-phone game saves the new state as soon as the race starts, so a reload mid-race keeps the last turn.
  - **Fallback:** without `E.roundRecap` (an old engine.js in the cache) or when anything in the race fails, the new state shows at once, without a race, and the page is never left busy. A one-phone game that such an old engine leaves in `roundEnd` moves on with `nextround`.
  - **DOM:** `.race` (fixed, outside `#app`) → `.race-card` (the list's `.bhead` and `li.pl` lines from `lineHtml`, plus `.race-badge`) and `.race-curtain` (`.race-round`, `.race-starter`, `.race-why`).
- **Your player.** An optional account with a passkey, on the Profile screen (the profile chip at the top right of home opens it). Guests can ignore it.
  - **When it shows:** the browser has `PublicKeyCredential`, a server is configured, the page is the top-level window on a hostname (WebAuthn refuses IP addresses; `localhost` works), and `GET /auth/config` answered `{ok: true}`. The probe runs once per page load and never holds up the first render. If it failed (offline, a 5xx), it runs again when the page becomes visible or the phone comes online; a 404 means no accounts there.
  - **Signed out:** "Keep your scores" (`section.acct.out`) with one line, a name field (`#aname`, from `sevens-out-name`), "Sign in with a passkey" (`asignin`, primary; a discoverable passkey, so no name to type) and "New player" (`acreate`; with an empty name it asks for one in the hint, then creates).
  - **Signed in:** the name with its tag (`#` + the first 4 hex of the player ID), an 88 px avatar initial, and rows (`.rowbtn`, 60 px) Rename (`arename`, in place), "Add a passkey on this phone" (`aadd`) and "Sign out" (`asignout`), with "Delete player" (`adelete`, confirmed in the page) at the bottom.
  - **Session:** a bearer token from `/auth`, kept in `sevens-out-account`. On load the page checks it with `GET /auth/me`: a new name is taken over, a 401 signs the phone out quietly, and network trouble keeps it. Create, sign-in and rename also write `sevens-out-name`.
  - **Passkey hygiene:** after Delete the page calls `PublicKeyCredential.signalAllAcceptedCredentials` with no IDs, and a sign-in with a deleted player's passkey calls `signalUnknownCredential`, so password managers can hide them.
  - **Options fetched ahead:** Safari opens a passkey prompt only shortly after the tap, so the page keeps `/auth/options` sets ready: `signin` and `create` while the signed-out Profile screen shows, `add` when signed in (only while the Profile screen shows, never during a prompt). A set is used once and is fresh for 4 minutes (challenges live 5); a fresh one is fetched in the background. A tap with a fresh set calls `navigator.credentials.*` before anything waits; without one it fetches first. A `create` set has no name: the page names the passkey `<name> #<tag>` and sends `name` to `/auth/create`.
  - While a passkey prompt is open (`ui.account.busy`), the Profile screen's buttons are `aria-disabled` (so focus stays) and `handle()` ignores account actions. The hint is announced from `#acct-live`, a visually hidden live region outside `#app` that survives redraws.
  - **Online:** a signed-in player joins from home's code row at once and creates a room from the Play sheet with no name field, and `hello` carries `session` (only when the account belongs to the room server). If the server answers `welcome.user === null` to a hello with a session, the session has ended: the phone drops the account quietly and plays on as a guest in that seat. The lobby seats and the score list show `#tag` for seats with `user`.
  - **One phone:** when signed in, each Who's playing row shows "You" (the first line whose name is the player name, case and spaces ignored) or "This is me", which puts the player name on that line (swapping names with the old "You" line). At start, `state.stats.owner` is that line and `ownerId` the player ID; the report carries `owner`, and its queue item keeps `ownerId`. It goes out with the bearer token only while that same player is signed in to the same server (signed out or someone else by then: a guest game).
- **Table talk.** Online chat, for seated players and spectators alike (`chatButton()`, `chatBody()`, the feed, `REACTIONS`).
  - **The button** (`button.menubtn.chatbtn[data-act=chat]`): the right end of the turn-screen header (after the score chip), the slim header and the lobby. It shows only once the room has sent its chat log (`net.chat.ready`), so an old server has no chat and keeps the dot in the score chip. `ready` resets only when the phone joins or leaves a room, so a dropped socket keeps the button and an open chat. Connected with nothing new it is the plain icon. Unread messages (others' messages since the chat was last open) are a green badge with the number (`.chat-badge`, `--ok` with `--ok-ink` text, 4.5:1 in every look; "9+" above 9). Not connected: a small red dot (`.chat-dot`, `--danger`), the badge staying. The `aria-label` is "Chat[, N new][, reconnecting]".
  - **The sheet** (kind `chat`, title "Chat"): 13 quick reactions (7 emoji, 6 short phrases; ordinary messages, one tap each; the sheet stays open), the log (newest at the bottom; `you`, the `#tag` of signed-in players, "watching" for spectators), and the text field (`#chattext`, 140 characters, Enter sends) with Send pinned. Too fast or refused: the hint in the sheet ("Slow down a little."), never a room error or the game's hint. `rate` always goes there; `not_seated` and `bad_message` do while a sent message waits for its echo (`net.chat.pending`, emptied by the echo, a refusal or a new socket), and a refused typed line comes back into the field. Send keeps the field focused (the press never takes the focus), so the phone keyboard stays up. Not connected: "Not connected right now. Reconnecting…". The draft lives in `ui.chatDraft`.
  - **Reading:** opening the chat reads everything (`chatRead()`). `net.chat.seen` is the last message id read, saved in `sevens-out-online`; after a reconnect or reload the log replaces the list, so nothing shows twice, and only newer messages from others count as unread. This phone's ids in the room (its seat, and each spectator `viewer` id it was given) stay in `net.chat.mine`, so a spectator who comes back under a new id still knows their own messages. A phone that never saw the room starts at zero.
  - **The feed** (`feedArea()` on the turns, `feedBox()` on paper, `feedLines()`): others' messages, the newest two (`FEED_KEEP`), each for 4 s from when it showed (`FEED_MS`). A new one takes the top line at full strength; the one before moves down to the second line, fainter (`.feed-line.old`, opacity .65); a third pushes the oldest out. Text is 16 px, an emoji in it 22 px (each emoji in its own `span.emo`, a box one line high, after `esc()`, so a long run can be cut by the ellipsis), and a line of only a few emoji (`.feed-msg.big`) shows them at 30 px; each line is one line (34 px), cut with an ellipsis.
    - **On the turns** it sits under the name (under the 101 alert when that shows), and the eyebrow stays. Online once the room speaks chat, the area (`div.feed`) is always there and two lines high (68 px), empty or not, so a message coming or going never moves the dice, the mat, the keypad, the entry or the bar. One-phone games and an old server have no area and look as before.
    - **On paper** (lobby, corrections, game over) the same lines float in a box under the slim header (`.feed.under`, absolute, over the content, taking no taps), only while it has a message.
    - It holds during the race between rounds (`ui.feed.held`) and then shows only messages younger than 5 s (`FEED_FRESH_MS`); it shows nothing while the chat is open (opening clears it). `#chat-live` (`aria-live=polite`, outside `#app`) reads each one out; the feed itself is `aria-hidden`. Your own messages never show in it, and a message shows once (`ui.feed.last`: the highest id taken, so a reconnect's replay doesn't show it again). Redraws keep each line's place in its fade (negative `animation-delay`). Reduced motion: the lines appear and go in place. Names and texts sit in `<bdi>` in the log and the feed, so right-to-left text can't reorder "Name · text".
  - **Turns:** when this phone may start to act (`canAct()` turns true) an open chat closes and Roll gets the focus; the draft waits.
- **Developer menu** (in the game menu, and in home's Settings sheet). Play confetti, Play shots alarm, Play missed 7, Play round change (the race for the round just finished, or made-up points before there is one), and End game now (host only when online; only in the game menu, never in home's Settings sheet over a saved game).
- **Reduced motion.** Rolls are instant (no throw: the dice appear in their spots), pairs are set aside without flying, there's no confetti, the shots takeover is shortened, and the missed-7 joke appears without moving. The race between rounds shows the grown list with its final totals, order and badge at once. The curtain then appears without sliding, and the whole race takes about 2.5 s.

## Conventions

- **Phones first.** 390 px wide, 16 px gutters, no sideways scrolling, tap targets at least 44 px. The main action of every play screen sits in the pinned bottom bar. Check 390×844 and 375×667, both looks and light/dark.
- **Colours only through the CSS tokens.** The shots takeover is the deliberate exception.
  - Small brass-coloured text uses `--brass-text` (darker than `--brass` in Pub table light, so it keeps 4.5:1 on paper; `--stitch` on the leather). `--brass` is for fills, borders and large text. `--ok` is the online dot and the chat button's unread badge, with `--ok-ink` for the badge's number.
  - **`color-mix()`** needs plain-token fallbacks in an `@supports not (color:color-mix(in srgb,red 50%,blue))` block after it, for Safari before 16.2. A plain declaration placed before it doesn't work: one with `var()` inside falls back to `unset`, not to the declaration before it.
- **No `alert()` or `confirm()`.** Confirmations are built into the page.
- **Copy is short, plain and active.** Errors say how to fix the problem.
- **Artwork stays original.** No branded characters, logos or trademarked designs.
- **The servers trust nothing from clients.** Validate in the engine and in `room.js`, never only in the page.

## Testing

- **Unit tests (`node --test`):**
  - `engine.test.js` plays many seeded random games in both modes and checks every rule against the score sheet, plus the specific cases; `fortytwo.test.js` and `schocken.test.js` do the same for 42/18 and Schocken.
  - `room.test.js` covers the protocol with in-memory connections.
  - `node-server.test.js` starts the real server and talks to it over WebSockets.
  - `worker.test.js` runs the Durable Object adapter against a stand-in runtime, including hibernation.
  - `d1.test.js`, `stats.test.js`, `queries.test.js`, `access.test.js` and `admin.test.js` cover the statistics: the D1 adapter and writes, summaries and `checkReport`, the admin queries, the Access token check and the admin Worker.
  - `webauthn.test.js`, `accounts-store.test.js`, `accounts.test.js` and `sqlite.test.js` cover accounts: passkey checks, the store and the migration, the `/auth` handler's ceremonies and refusals, and the Node database.
  - `tests/fake-d1.js` is a D1 stand-in on `node:sqlite`, `tests/games.js` builds deterministic finished games, and `tests/authenticator.js` is a software passkey (real WebCrypto keys) for the account tests.
- **Browser tests (`@playwright/test`):**
  - `fortytwo.spec.js`: 42/18's dice turn, real dice, the fit on a small phone and two phones online; `schocken.spec.js` the same for Schocken (turning 6s, blind, halves).
  - Separate browser contexts act as separate phones.
  - The tests read state through `window.SevensDebug` or `localStorage`.
  - Use `contextOptions: { reducedMotion: 'reduce' }` for instant rolls.
  - To fix the dice, stub `crypto.getRandomValues` for 1-byte arrays (`fixDice` in `tests/e2e/helpers.js`). With normal motion the tumbling dice use the same calls, so the fixed faces only hold with reduced motion.
  - To load the page with a changed `engine.js` or CSS (an old cached engine, a browser without `color-mix()`), serve the changed file through `page.route`, as the tests in `local.spec.js` do.
  - After a round's last turn, the race plays for about 2.5 s even with reduced motion. Tests that act right after a round ends call `skipRace(page)` (helpers.js): it waits for a Sevens Out or missed-7 joke that plays first, taps the race away, then waits until the page is idle.
  - **Getting to a screen** (helpers.js): `startLocal(page, {names, mode, pairing, starter})` goes home → Play sheet → Who's playing → Start; `toPlayers(page, {mode, pairing})` stops at Who's playing; `openProfile(page)` taps the profile chip and opens the Profile screen (needs `localUrl()`); `openSettings(page, fold?)` opens home's Settings sheet (Sound, Look, Shake, and the folds `rules` and `dev`); `enterScore(page, pts, rolls?)` saves a real-dice turn (it closes an open score list first).
  - **The score chip:** `openScores(page)` opens the full list from the chip on a turn screen, `closeScores(page)` closes it with Escape, `editLine(page, i)` opens corrections from player i's line (from the chip's list, or the list at game over), and `stopPts(page)` reads the "+N" on Stop or End.
  - Settings, New game, Leave room and the developer buttons live in the game menu on play screens and in the lobby: `openMenu(page, fold?)` opens it (and a fold: `sheet`, `rules`, `dev`), `closeMenu(page)` closes it with Escape. The sheet covers the game, so close it before tapping the game again.
  - **Fake room:** `fakeRoom(page, {room, state, seat, viewer, log})` (helpers.js) stands in for the room server with `page.routeWebSocket`: it answers `hello` with welcome (with `viewer` for a spectator), the chat log (only when `log` is given; left out = an old server without chat) and the room, and returns `push(m)`, `close()` (the page reconnects), `hellos()`, `sent()` (the page's other messages) and `set(o)` (new answers for the next hellos). Set it up before `goto`. It is for the chat, feed and chip-fit tests that need exact messages or a 12-player room. The feed tests time the lines with `page.clock` (install it before `goto`; `runFor` moves the time on).
  - **Layout checks:** `chipFits(page)` checks the score chip's content sits inside it on one line at 44 px; `noSideScroll(page)`; the dice-turn and real-dice describes in `local.spec.js` have `onScreen(page, sel)` (inside the screen without scrolling) and `barAtBottom(page)`. They run at 390×844 and 375×667 (`page.setViewportSize`).
  - **The dice on the mat:** tests seed `Math.random` (`seedRandom` in `local.spec.js`) and check the rendered dice (inside the mat by 8 px, above the hint, no overlap of the rotated squares) with the page's own `SevensDebug.layout` and `dieSize`.
  - **Old saves:** to test one, put a hand-written JSON string in `localStorage['sevens-out-v1']` with `addInitScript` before `goto` (see "a literal save from an older page" in `local.spec.js`).
  - `TARGET=worker` points online play at `wrangler dev` through the `?server=` override.
  - **Passkeys** (`account.spec.js`): `addAuthenticator(page)` adds a CDP virtual authenticator that says yes at once; `credentials` and `copyCredential` read a passkey and copy it to another phone (a synced passkey). WebAuthn refuses IP addresses, so these tests open `localUrl()` (`http://localhost:8790`), not the config's `127.0.0.1`. The virtual authenticator can't press Cancel; a cancelled prompt is a stubbed `navigator.credentials.create`. The page fetches passkey options ahead, so the test Node server runs with a high `AUTH_LIMIT` (every test phone is 127.0.0.1).
  - `tests/e2e/admin.spec.js` tests the admin page (`npm run test:admin`). Don't run it together with `test:worker`: both reset `.wrangler/e2e`.

Invariants to keep after rule changes:
- Rolls stay within the round's `mark`.
- Totals equal the score sheet.
- Each starter follows the highest-score rule, including the got-there-first tie-break.
- The game ends at the end of the first round in which anyone is at 101 or more, and the loser follows the tie rule.
- Online, every phone shows the same state.

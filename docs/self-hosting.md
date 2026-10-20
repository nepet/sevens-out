# Self-hosting the room server (option 5)

The Cloudflare Worker (option 4) and the Node server share all game and room code (`engine.js`, `server/core/room.js`). Only the thin adapter differs, so moving from Cloudflare to your own server is a deployment change, not a rewrite.

## What you run

`node server/node/server.js` is one process that:

- serves the page (`/` and `/engine.js`) with online play pointed at itself (`same-origin`), so no extra configuration is needed,
- serves the rooms as WebSockets at `/room/<CODE>`,
- keeps each room as a JSON file in `DATA_DIR` and deletes rooms after 14 days without activity,
- keeps player accounts in the SQLite file `DATA_DIR/sevens-out.db` (built into Node as `node:sqlite`),
- answers `/health` with `ok`.

It needs Node 22.13 or newer and **no npm packages**: the WebSocket server is built in (`server/node/ws.js`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8788` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to listen on (use `127.0.0.1` behind a proxy) |
| `DATA_DIR` | `./data` | Where room files and `sevens-out.db` are kept. Back up the whole folder: the database holds player accounts. Copy it with the server stopped, or `sevens-out.db-wal` may hold changes not yet in `sevens-out.db`. |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated page origins allowed to connect, e.g. `https://game.example.com,https://<owner>.github.io` |
| `AUTH_LIMIT` | `60` | Player-account requests per minute per client IP. The IP comes from `X-Forwarded-For` when the proxy connects from this machine or a private network. |

Browsers need HTTPS (and therefore WSS) for shake-to-roll on iPhone and for mixed-content rules, so always put a TLS proxy in front.

## Docker + Caddy (recommended)

1. Point a DNS name, for example `game.example.com`, at the server.
2. Put that name in `deploy/Caddyfile`.
3. Run `docker compose -f deploy/docker-compose.yml up -d --build`.

Caddy obtains the certificate and passes WebSockets through. Open `https://game.example.com` and play.

## Plain Node + systemd

1. Copy the repo to `/opt/sevens-out` and create a `sevens` user.
2. Install the unit: `sudo cp deploy/sevens-out.service /etc/systemd/system/ && sudo systemctl enable --now sevens-out`.
3. Put Caddy in front with `reverse_proxy localhost:8788`.

## A home server instead of a VPS

Run the same Docker setup on a Raspberry Pi, and expose it with Cloudflare Tunnel instead of opening ports. The tunnel gives you HTTPS, so you don't need Caddy in that case.

## Keeping GitHub Pages as the page

If you want the GitHub Pages site to use your server instead of the Worker:
- set `<meta name="sevens-out-server" content="wss://game.example.com">` in `index.html`,
- add `https://<owner>.github.io` to `ALLOWED_ORIGINS`.

## Moving running rooms from Cloudflare

You don't need to. Rooms are short-lived (a game night), so switch the server URL between game nights. Any room still on Cloudflare expires there after 14 days.

## Option 4 or option 5?

The code is the same, so the choice is only about operations:

| | Cloudflare (4) | Self-hosted (5) |
|---|---|---|
| Cost | Free plan covers this easily | About €4–6/month for a small VPS, or a home server |
| Setup | `wrangler login`, `npm run worker:deploy` | DNS, Docker, Caddy |
| Upkeep | None | OS updates, backups, uptime |
| Control | Cloudflare account and limits | Everything is yours |

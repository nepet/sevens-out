# Player accounts (passkeys)

Players can create a **player** with a passkey. A player has a name and a fixed **player ID** (16 hex
characters). The page shows the name with a short **tag**, the ID's first 4 characters (`Anna #3f9a`), so
two people called Anna stay apart. The **handle** `<id>-<name>` names a player in full.

Signing in is optional. Guests play exactly as before.

## What a player gets

- **Online:** a signed-in player sits in a room under their player name, and the seat remembers their
  player ID. They get their seat back from any phone where they are signed in, even in the middle of a
  game (a guest who lost the room's token can only watch).
- **Statistics:** online games record the player ID for each signed-in seat. A one-phone game credits the
  phone owner's line when it carries their player name. The admin page counts signed-in players by ID
  and guests by name.

## How it works

- **Passkeys (WebAuthn):** discoverable credentials, so signing in is one tap plus Face ID or a fingerprint,
  with no name to type. iCloud Keychain and Google Password Manager sync them, so a new phone of the same
  kind just works. Other devices can sign in with the system's "use a phone" QR code, then
  "Add a passkey on this device".
- **The server:** the game server answers `/auth/*` (`server/core/accounts.js`). Both the Worker and the Node
  server run the same code. It checks every passkey with WebCrypto (`server/core/webauthn.js`), with no npm
  packages: challenge, origin, RP ID, user presence and signature, plus the sign counter where the device
  keeps one. Registration uses attestation `none`.
- **Sessions:** a successful sign-in returns a random token. The page keeps it in
  `localStorage['sevens-out-account']` and sends it as `Authorization: Bearer …` (HTTP) and as `session`
  in the room's `hello`.
  - The server stores only its SHA-256 hash.
  - A session lasts 180 days and is extended when used.
  - Safari may clear a site's storage after a week without a visit. The player then signs in again with one Face ID.
- **Storage:** tables `users`, `passkeys`, `sessions` and `auth_challenges`, plus `players.user_id`, in the
  same D1 database as the statistics (`server/d1/schema.sql`). The Node server keeps the same tables in
  `DATA_DIR/sevens-out.db`.
- **Limits:** 120 account requests per minute per IP: `AUTH_LIMIT` on the Worker, the `AUTH_LIMIT`
  environment variable on Node. The page's `GET /auth/config` probe isn't counted. Behind a proxy, Node
  takes the client's IP from `X-Forwarded-For`, but only when the proxy connects from the same machine or a
  private network (as Caddy does in `deploy/`). Challenges are single use and expire after 5 minutes.
- **Lost phone:** removing a passkey (`DELETE /auth/passkeys/<id>`) ends every other session of that player.
  `POST /auth/signout?everywhere=1` ends all of them.
- **Accounts unreachable:** if a room can't check a session (the database is down), the player plays as a
  guest and `welcome` leaves out `user`, so the phone keeps its session.

## The domain matters

A passkey belongs to the page's host name (`<owner>.github.io` for GitHub Pages, `localhost` when testing).
The server accepts the origins in `ALLOWED_ORIGINS` and checks each passkey against that origin's host name.

- **Moving the page** to another domain leaves existing passkeys behind. Players would have to create a
  new player, unless the old domain lists the new one as a related origin (`/.well-known/webauthn`).
  Decide on a custom domain before many people sign up.
- **IP addresses** can't hold passkeys. Open the page as `http://localhost:…`, not `http://127.0.0.1:…`,
  when testing. The page hides the panel on an IP address.

## What is stored

A player's name, their passkeys' public keys, when each passkey was created and last used, and session
hashes. No email, no IP addresses, no device names.

**Delete player** removes the player, their passkeys and their sessions. Their statistics keep the name
and lose the player ID. The passkey itself stays on the phone until the player removes it in the phone's
passwords app. If they sign in with it later, the page explains that the player was deleted (and, where
the browser supports it, tells the phone the passkey is gone).

## Setup

- **Fresh database:** `npm run db:schema` creates everything.
- **The live database from before accounts:** run the migration once, before deploying the Worker:
  `npm run db:accounts`. Running it twice fails at the `ALTER TABLE` and changes nothing.
- **Local development (`npm run worker:dev`):** load the schema into `.wrangler/dev` (see [admin.md](admin.md)).
  If that database predates accounts, run the migration against it:
  `npx wrangler d1 execute sevens-out-stats --local --persist-to .wrangler/dev -c server/cloudflare/wrangler.jsonc --file server/d1/migrations/0001-accounts.sql`.
- **Tests:** `tests/authenticator.js` is a software passkey for the unit tests. The browser tests use Chromium's
  virtual authenticator (`addAuthenticator` in `tests/e2e/helpers.js`).

/*
 * Player accounts with passkeys, independent of where they run (Fetch API Request/Response, WebCrypto).
 *
 *   handleAuth(request, { db, origins, now, limit }) -> Response for /auth/*
 *     db: the { all, batch } interface (server/d1/db.js on D1, server/node/sqlite.js on Node)
 *     origins: allowed page origins, or null = any (development); passkeys belong to the origin's hostname
 *     limit(request) -> Promise<boolean>: false answers 429 (optional)
 *   resolveSession(db, token, now) -> { id, name } | null    for rooms (the `session` in hello)
 *   originsFrom(ALLOWED_ORIGINS) -> string[] | null
 *
 * Routes (JSON; a session is `Authorization: Bearer <token>`):
 *   GET    /auth/config              -> { ok }                       the page's feature probe
 *   POST   /auth/options             { purpose: create|signin|add, name? } -> { challengeId, challenge, user?, exclude? }
 *   POST   /auth/create              { challengeId, credential }    -> { token, player }
 *   POST   /auth/signin              { challengeId, credential }    -> { token, player }
 *   POST   /auth/passkeys            { challengeId, credential }    -> { passkey }   (session)
 *   DELETE /auth/passkeys/<id>                                      -> 204           (session; never the last one)
 *   GET    /auth/me                                                 -> { player, passkeys }
 *   PATCH  /auth/me                  { name }                       -> { player }
 *   DELETE /auth/me                                                 -> 204           (deletes the player)
 *   POST   /auth/signout                                            -> 204
 * player = { id, name, tag, handle }: id is 16 hex chars, tag its first 4, handle `${id}-${name}`.
 * Errors answer { error: code }.
 */
import { b64url, verifyRegistration, verifyAssertion, WebAuthnError } from './webauthn.js';
import * as store from '../d1/accounts.js';

export const MAX_AUTH_BODY = 8 * 1024;
export const PLAYER_ID_RE = /^[0-9a-f]{16}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;
const RP_NAME = 'Sevens Out';

const hexOf = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
const randomHex = n => hexOf(crypto.getRandomValues(new Uint8Array(n)));
const bytesOfHex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const sha256Hex = async s => hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
export const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
export const playerOf = ({ id, name }) => ({ id, name, tag: id.slice(0, 4), handle: `${id}-${name}` });
const userHandleOf = id => b64url.encode(bytesOfHex(id));

export function originsFrom(list) {
  const all = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
  return !all.length || all.includes('*') ? null : all;
}

export async function resolveSession(db, token, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return store.sessionUser(db, await sha256Hex(token), now);
}

class Refusal extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const refuse = (status, code) => { throw new Refusal(status, code); };

export async function handleAuth(request, { db, origins = null, now = Date.now, limit = null }) {
  const origin = request.headers.get('Origin');
  const allowed = !!origin && (!origins || origins.includes(origin));
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (allowed) Object.assign(headers, {
    'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
    'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400', vary: 'Origin'
  });
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  // a page on another origin never gets an answer it could read; requests without Origin (same origin GET, tools) pass
  if (origin && !allowed) return reply(403, { error: 'origin' });
  if (request.method === 'OPTIONS') return reply(204);
  try {
    if (limit && !(await limit(request))) refuse(429, 'rate_limited');
    const r = await route(request, { db, origins, now: now() });
    return reply(r.status || 200, r.body);
  } catch (err) {
    if (err instanceof Refusal) return reply(err.status, { error: err.code });
    if (err instanceof WebAuthnError) return reply(400, { error: 'passkey', detail: err.code });
    console.error('auth', err);
    return reply(503, { error: 'storage' });
  }
}

async function readJson(request) {
  if (+(request.headers.get('content-length') || 0) > MAX_AUTH_BODY) refuse(413, 'too_large');
  const text = await request.text();
  if (text.length > MAX_AUTH_BODY) refuse(413, 'too_large');
  let body;
  try { body = JSON.parse(text); } catch { refuse(400, 'not_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'not_json');
  return body;
}

async function signedIn(request, db, now) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  const hash = m && await sha256Hex(m[1]);
  const user = hash && await store.sessionUser(db, hash, now);
  if (!user) refuse(401, 'signed_out');
  return { user, hash };
}

async function newSession(userId, now) {
  const token = randomHex(32);
  return { token, session: { hash: await sha256Hex(token), userId, now, expiresAt: now + store.SESSION_TTL_MS } };
}

async function challengeFor(db, body, purpose, now) {
  if (typeof body.challengeId !== 'string' || !CHALLENGE_ID_RE.test(body.challengeId)) refuse(400, 'challenge');
  const c = await store.takeChallenge(db, body.challengeId, now);
  if (!c || c.purpose !== purpose) refuse(400, 'challenge');
  return c;
}

async function route(request, { db, origins, now }) {
  const path = new URL(request.url).pathname, method = request.method;
  const at = (m, p) => method === m && path === p;

  if (at('GET', '/auth/config')) return { body: { ok: true } };

  if (at('POST', '/auth/options')) {
    const body = await readJson(request);
    const purpose = body.purpose;
    if (!['create', 'signin', 'add'].includes(purpose)) refuse(400, 'purpose');
    await store.purgeExpired(db, now); // ceremonies are rare, so this is a cheap place to tidy up
    const c = { id: randomHex(16), challenge: b64url.encode(crypto.getRandomValues(new Uint8Array(32))), purpose, expiresAt: now + store.CHALLENGE_TTL_MS };
    const out = { challengeId: c.id, challenge: c.challenge, rp: { name: RP_NAME } };
    if (purpose === 'create') {
      const name = cleanName(body.name);
      if (!name) refuse(400, 'name');
      Object.assign(c, { userId: randomHex(8), name });
    } else if (purpose === 'add') {
      const { user } = await signedIn(request, db, now);
      Object.assign(c, { userId: user.id, name: user.name });
      out.exclude = (await store.listPasskeys(db, user.id)).map(k => k.id);
    }
    if (c.userId) out.user = { id: userHandleOf(c.userId), name: `${c.name} #${c.userId.slice(0, 4)}`, displayName: c.name };
    await store.putChallenge(db, c);
    return { body: out };
  }

  if (at('POST', '/auth/create')) {
    const body = await readJson(request);
    const c = await challengeFor(db, body, 'create', now);
    const key = await verifyRegistration({ credential: body.credential, challenge: c.challenge, origins });
    if (await store.getPasskey(db, key.credentialId)) refuse(409, 'passkey_taken');
    const { token, session } = await newSession(c.userId, now);
    await store.createUser(db, { id: c.userId, name: c.name, now, passkey: passkeyRow(key), session });
    return { body: { token, player: playerOf({ id: c.userId, name: c.name }) } };
  }

  if (at('POST', '/auth/signin')) {
    const body = await readJson(request);
    const c = await challengeFor(db, body, 'signin', now);
    const id = body.credential && body.credential.id;
    const key = typeof id === 'string' && id.length <= 1400 ? await store.getPasskey(db, id) : null;
    if (!key) refuse(404, 'unknown_passkey');
    const r = await verifyAssertion({ credential: body.credential, challenge: c.challenge, origins, publicKey: key.publicKey, alg: key.alg, signCount: key.signCount });
    if (r.userHandle && r.userHandle !== userHandleOf(key.userId)) refuse(403, 'wrong_player');
    const user = await store.getUser(db, key.userId);
    if (!user) refuse(404, 'unknown_passkey');
    await store.touchPasskey(db, key.id, { signCount: r.signCount, synced: r.synced, now });
    const { token, session } = await newSession(user.id, now);
    await store.createSession(db, session);
    return { body: { token, player: playerOf(user) } };
  }

  if (at('POST', '/auth/passkeys')) {
    const { user } = await signedIn(request, db, now);
    const body = await readJson(request);
    const c = await challengeFor(db, body, 'add', now);
    if (c.userId !== user.id) refuse(400, 'challenge');
    const key = await verifyRegistration({ credential: body.credential, challenge: c.challenge, origins });
    if (await store.getPasskey(db, key.credentialId)) refuse(409, 'passkey_taken');
    await store.addPasskey(db, user.id, passkeyRow(key), now);
    return { body: { passkey: passkeyView(await store.getPasskey(db, key.credentialId)) } };
  }

  const del = /^\/auth\/passkeys\/([A-Za-z0-9_-]{1,1400})$/.exec(path);
  if (method === 'DELETE' && del) {
    const { user } = await signedIn(request, db, now);
    if (await store.deletePasskey(db, user.id, del[1])) return { status: 204 };
    const key = await store.getPasskey(db, del[1]);
    refuse(key && key.userId === user.id ? 409 : 404, key && key.userId === user.id ? 'last_passkey' : 'not_found');
  }

  if (path === '/auth/me') {
    const { user } = await signedIn(request, db, now);
    if (method === 'GET') return { body: { player: playerOf(user), passkeys: (await store.listPasskeys(db, user.id)).map(passkeyView) } };
    if (method === 'PATCH') {
      const name = cleanName((await readJson(request)).name);
      if (!name) refuse(400, 'name');
      await store.renameUser(db, user.id, name, now);
      return { body: { player: playerOf({ id: user.id, name }) } };
    }
    if (method === 'DELETE') { await store.deleteUser(db, user.id); return { status: 204 }; }
  }

  if (at('POST', '/auth/signout')) {
    const { hash } = await signedIn(request, db, now);
    await store.deleteSession(db, hash);
    return { status: 204 };
  }

  refuse(404, 'not_found');
}

const passkeyRow = k => ({ id: k.credentialId, publicKey: k.publicKey, alg: k.alg, signCount: k.signCount, transports: k.transports, synced: k.synced });
const passkeyView = k => ({ id: k.id, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, synced: k.synced });

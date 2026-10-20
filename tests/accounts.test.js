// The /auth handler (server/core/accounts.js): full passkey ceremonies with a software authenticator
// (tests/authenticator.js) against the real store on node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './fake-d1.js';
import { fromD1 } from '../server/d1/db.js';
import { softAuthenticator } from './authenticator.js';
import { handleAuth, resolveSession, originsFrom } from '../server/core/accounts.js';
import { b64url } from '../server/core/webauthn.js';

const ORIGIN = 'https://me.github.io';
const MIN = 60_000, DAY = 24 * 60 * MIN;

function server({ origins = [ORIGIN], limit = null } = {}) {
  const d1 = fakeD1(), db = fromD1(d1);
  const clock = { t: 1_700_000_000_000 };
  const call = async (method, path, { body, token, origin = ORIGIN, headers = {} } = {}) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await handleAuth(new Request(`https://api.example${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
      { db, origins, now: () => clock.t, limit });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { d1, db, clock, call };
}

async function createPlayer(s, auth, name = 'Anna') {
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'create', name } });
  assert.equal(o.status, 200);
  const credential = await auth.create({ challenge: o.body.challenge, userId: o.body.user.id });
  const r = await s.call('POST', '/auth/create', { body: { challengeId: o.body.challengeId, credential } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function signIn(s, auth, over = {}) {
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'signin' } });
  const credential = await auth.get({ challenge: o.body.challenge, ...over });
  return s.call('POST', '/auth/signin', { body: { challengeId: o.body.challengeId, credential } });
}

test('create a player, then sign in with the same passkey on another visit', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'create', name: '  Anna   Lee ' } });
  assert.match(o.body.challengeId, /^[0-9a-f]{32}$/);
  assert.equal(o.body.user.displayName, 'Anna Lee');
  const id = Buffer.from(b64url.decode(o.body.user.id)).toString('hex');
  assert.equal(o.body.user.name, `Anna Lee #${id.slice(0, 4)}`, 'the passkey list tells two Annas apart');

  const credential = await auth.create({ challenge: o.body.challenge, userId: o.body.user.id });
  const created = await s.call('POST', '/auth/create', { body: { challengeId: o.body.challengeId, credential } });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.player, { id, name: 'Anna Lee', tag: id.slice(0, 4), handle: `${id}-Anna Lee` });
  assert.match(created.body.token, /^[0-9a-f]{64}$/);
  assert.equal(s.d1.raw.prepare('SELECT hash FROM sessions').get().hash.length, 64);
  assert.notEqual(s.d1.raw.prepare('SELECT hash FROM sessions').get().hash, created.body.token, 'only the hash is stored');

  const me = await s.call('GET', '/auth/me', { token: created.body.token });
  assert.equal(me.body.player.id, id);
  assert.equal(me.body.passkeys.length, 1);
  assert.equal(me.body.passkeys[0].synced, true);

  s.clock.t += DAY;
  const back = await signIn(s, auth);
  assert.equal(back.status, 200);
  assert.equal(back.body.player.id, id);
  assert.notEqual(back.body.token, created.body.token, 'each sign-in gets its own session');
  assert.equal((await s.call('GET', '/auth/me', { token: back.body.token })).body.passkeys[0].lastUsedAt, s.clock.t);
  assert.deepEqual(await resolveSession(s.db, back.body.token, s.clock.t), { id, name: 'Anna Lee' });
  assert.equal(await resolveSession(s.db, 'nope', s.clock.t), null);
});

test('challenges: single use, right purpose, unexpired', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'create', name: 'Anna' } });
  const credential = await auth.create({ challenge: o.body.challenge, userId: o.body.user.id });
  assert.equal((await s.call('POST', '/auth/signin', { body: { challengeId: o.body.challengeId, credential } })).body.error, 'challenge', 'wrong purpose');
  // that attempt used the challenge up
  assert.equal((await s.call('POST', '/auth/create', { body: { challengeId: o.body.challengeId, credential } })).body.error, 'challenge');

  const o2 = await s.call('POST', '/auth/options', { body: { purpose: 'create', name: 'Anna' } });
  const c2 = await auth.create({ challenge: o2.body.challenge, userId: o2.body.user.id });
  s.clock.t += 5 * MIN + 1;
  assert.equal((await s.call('POST', '/auth/create', { body: { challengeId: o2.body.challengeId, credential: c2 } })).body.error, 'challenge', 'expired');
  assert.equal((await s.call('POST', '/auth/create', { body: { challengeId: 'x', credential: c2 } })).body.error, 'challenge');
});

test('passkey checks are enforced: origin, challenge, signature, owner', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const { player } = await createPlayer(s, auth);

  const o = await s.call('POST', '/auth/options', { body: { purpose: 'signin' } });
  const evil = await auth.get({ challenge: o.body.challenge, origin: 'https://evil.example' });
  const r = await s.call('POST', '/auth/signin', { body: { challengeId: o.body.challengeId, credential: evil } });
  assert.deepEqual([r.status, r.body], [400, { error: 'passkey', detail: 'origin' }]);

  const o2 = await s.call('POST', '/auth/options', { body: { purpose: 'signin' } });
  const stale = await auth.get({ challenge: o.body.challenge });
  assert.equal((await s.call('POST', '/auth/signin', { body: { challengeId: o2.body.challengeId, credential: stale } })).body.detail, 'challenge');

  const wrongOwner = await signIn(s, auth, { userHandle: b64url.encode(new Uint8Array(8)) });
  assert.deepEqual([wrongOwner.status, wrongOwner.body.error], [403, 'wrong_player']);

  const stranger = await softAuthenticator({ origin: ORIGIN });
  await stranger.create({ challenge: 'x' }); // a passkey the server never saw
  assert.deepEqual((await signIn(s, stranger)).body, { error: 'unknown_passkey' });

  const o3 = await s.call('POST', '/auth/options', { body: { purpose: 'signin' } });
  const forged = await auth.get({ challenge: o3.body.challenge });
  forged.signature = (await stranger.get({ challenge: o3.body.challenge })).signature;
  assert.equal((await s.call('POST', '/auth/signin', { body: { challengeId: o3.body.challengeId, credential: forged } })).body.detail, 'signature');
  assert.equal((await signIn(s, auth)).body.player.id, player.id, 'the real passkey still works');
});

test('a sign counter that goes backwards is refused', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN, counter: true });
  await createPlayer(s, auth);
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'signin' } });
  const replayed = await auth.get({ challenge: o.body.challenge }); // counter 1, held back
  assert.equal((await signIn(s, auth)).status, 200); // counter 2
  assert.equal((await s.call('POST', '/auth/signin', { body: { challengeId: o.body.challengeId, credential: replayed } })).body.detail, 'counter');
});

test('add a passkey on another device, list it, delete it but never the last one', async () => {
  const s = server(), phone = await softAuthenticator({ origin: ORIGIN }), tablet = await softAuthenticator({ origin: ORIGIN, alg: -257, synced: false });
  const { token, player } = await createPlayer(s, phone);
  assert.equal((await s.call('POST', '/auth/options', { body: { purpose: 'add' } })).status, 401, 'adding needs a session');
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'add' }, token });
  assert.equal(o.body.exclude.length, 1, 'the page asks the device not to make a second passkey for this player');
  assert.equal(o.body.user.displayName, 'Anna');
  const credential = await tablet.create({ challenge: o.body.challenge, userId: o.body.user.id });
  const added = await s.call('POST', '/auth/passkeys', { body: { challengeId: o.body.challengeId, credential }, token });
  assert.equal(added.status, 200);
  assert.equal(added.body.passkey.synced, false);
  assert.equal((await signIn(s, tablet)).body.player.id, player.id);

  // someone else's add challenge can't be used with this session
  const other = await createPlayer(s, await softAuthenticator({ origin: ORIGIN }), 'Ben');
  const o2 = await s.call('POST', '/auth/options', { body: { purpose: 'add' }, token: other.token });
  const c2 = await tablet.create({ challenge: o2.body.challenge, userId: o2.body.user.id });
  assert.equal((await s.call('POST', '/auth/passkeys', { body: { challengeId: o2.body.challengeId, credential: c2 }, token })).body.error, 'challenge');

  const keys = (await s.call('GET', '/auth/me', { token })).body.passkeys;
  assert.equal(keys.length, 2);
  assert.equal((await s.call('DELETE', `/auth/passkeys/${keys[0].id}`, { token: other.token })).status, 404, 'not yours');
  assert.equal((await s.call('DELETE', `/auth/passkeys/${keys[0].id}`, { token })).status, 204);
  const last = await s.call('DELETE', `/auth/passkeys/${keys[1].id}`, { token });
  assert.deepEqual([last.status, last.body.error], [409, 'last_passkey']);
});

test('the same passkey can only be registered once', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const { token } = await createPlayer(s, auth);
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'add' }, token });
  const credential = await auth.create({ challenge: o.body.challenge, userId: o.body.user.id });
  credential.id = auth.credentials[0].id; // a device that ignores excludeCredentials and reuses the id
  credential.authenticatorData = b64url.encode(rewriteCredId(b64url.decode(credential.authenticatorData), b64url.decode(credential.id)));
  assert.equal((await s.call('POST', '/auth/passkeys', { body: { challengeId: o.body.challengeId, credential }, token })).status, 409);
});
// replace the credential id inside attested authenticator data (same length)
function rewriteCredId(ad, id) { const out = ad.slice(); out.set(id, 55); return out; }

test('rename, sign out, delete the player', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const { token, player } = await createPlayer(s, auth);
  assert.equal((await s.call('PATCH', '/auth/me', { body: { name: '' }, token })).body.error, 'name');
  const renamed = await s.call('PATCH', '/auth/me', { body: { name: 'Annie\u0007 ' }, token });
  assert.deepEqual(renamed.body.player, { id: player.id, name: 'Annie', tag: player.tag, handle: `${player.id}-Annie` });

  const second = (await signIn(s, auth)).body.token;
  assert.equal((await s.call('POST', '/auth/signout', { token })).status, 204);
  assert.equal((await s.call('GET', '/auth/me', { token })).status, 401, 'signed out');
  assert.equal((await s.call('GET', '/auth/me', { token: second })).status, 200, 'other sessions stay');

  s.d1.raw.prepare("INSERT INTO games (id, source, mode, status, player_count) VALUES ('0123456789abcdef', 'online', 'dice', 'over', 2)").run();
  s.d1.raw.prepare("INSERT INTO players (game_id, idx, name, name_key, score, lost, sevens_outs, shots, turns, user_id) VALUES ('0123456789abcdef', 0, 'Annie', 'annie', 50, 0, 0, 0, 5, ?)").run(player.id);
  assert.equal((await s.call('DELETE', '/auth/me', { token: second })).status, 204);
  assert.equal((await s.call('GET', '/auth/me', { token: second })).status, 401);
  assert.equal((await signIn(s, auth)).body.error, 'unknown_passkey');
  assert.deepEqual({ ...s.d1.raw.prepare('SELECT name, user_id FROM players').get() }, { name: 'Annie', user_id: null }, 'stats keep the name');
});

test('sessions expire after 180 days without use and slide when used', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const { token } = await createPlayer(s, auth);
  s.clock.t += 170 * DAY;
  assert.equal((await s.call('GET', '/auth/me', { token })).status, 200);
  s.clock.t += 170 * DAY;
  assert.equal((await s.call('GET', '/auth/me', { token })).status, 200, 'the visit 170 days in moved the expiry');
  s.clock.t += 181 * DAY;
  assert.equal((await s.call('GET', '/auth/me', { token })).status, 401);
});

test('origins, CORS, methods, sizes, bad input, rate limit and storage errors', async () => {
  const s = server();
  const pre = await s.call('OPTIONS', '/auth/me');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal((await s.call('GET', '/auth/config', { origin: 'https://evil.example' })).status, 403);
  const plain = await s.call('GET', '/auth/config', { origin: null });
  assert.deepEqual([plain.status, plain.body, plain.headers.get('access-control-allow-origin')], [200, { ok: true }, null]);
  assert.equal((await s.call('GET', '/auth/nothing')).status, 404);
  assert.equal((await s.call('PUT', '/auth/me', { token: 'f'.repeat(64) })).status, 401);
  assert.equal((await s.call('POST', '/auth/options', { body: 'x'.repeat(9000) })).status, 413);
  assert.equal((await s.call('POST', '/auth/options', { body: '{' })).body.error, 'not_json');
  assert.equal((await s.call('POST', '/auth/options', { body: [] })).body.error, 'not_json');
  assert.equal((await s.call('POST', '/auth/options', { body: { purpose: 'root' } })).body.error, 'purpose');
  assert.equal((await s.call('POST', '/auth/options', { body: { purpose: 'create', name: ' \n ' } })).body.error, 'name');
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'signin' } });
  assert.equal((await s.call('POST', '/auth/signin', { body: { challengeId: o.body.challengeId, credential: 5 } })).body.error, 'unknown_passkey');
  const o2 = await s.call('POST', '/auth/options', { body: { purpose: 'create', name: 'A' } });
  assert.equal((await s.call('POST', '/auth/create', { body: { challengeId: o2.body.challengeId, credential: { id: '!!' } } })).body.error, 'passkey');
  assert.equal((await s.call('GET', '/auth/me', { headers: { Authorization: 'Bearer abc' } })).status, 401);

  const limited = server({ limit: async () => false });
  assert.equal((await limited.call('GET', '/auth/config')).status, 429);
  assert.equal((await limited.call('OPTIONS', '/auth/config')).status, 204, 'preflights are not counted');

  s.d1.down = true;
  assert.deepEqual((await s.call('POST', '/auth/options', { body: { purpose: 'signin' } })).body, { error: 'storage' });
});

test('development: no allowlist accepts any origin, and passkeys belong to its hostname', async () => {
  const s = server({ origins: null }), auth = await softAuthenticator({ origin: 'http://localhost:8788' });
  const { player } = await createPlayer(s, auth);
  assert.equal((await signIn(s, auth)).body.player.id, player.id);
  const elsewhere = await softAuthenticator({ origin: 'http://localhost:8788' });
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'create', name: 'B' } });
  const c = await elsewhere.create({ challenge: o.body.challenge, rpId: 'example.com' });
  assert.equal((await s.call('POST', '/auth/create', { body: { challengeId: o.body.challengeId, credential: c } })).body.detail, 'rp_id');
  assert.equal(originsFrom(''), null);
  assert.equal(originsFrom('*'), null);
  assert.deepEqual(originsFrom(' https://a.io, https://b.io '), ['https://a.io', 'https://b.io']);
});

test('removing a passkey ends the player\'s other sessions; sign out everywhere ends all', async () => {
  const s = server(), phone = await softAuthenticator({ origin: ORIGIN }), lost = await softAuthenticator({ origin: ORIGIN });
  const { token } = await createPlayer(s, phone);
  const o = await s.call('POST', '/auth/options', { body: { purpose: 'add' }, token });
  await s.call('POST', '/auth/passkeys', { body: { challengeId: o.body.challengeId, credential: await lost.create({ challenge: o.body.challenge, userId: o.body.user.id }) }, token });
  const lostToken = (await signIn(s, lost)).body.token;
  const keep = (await signIn(s, phone)).body.token;
  assert.equal((await s.call('DELETE', `/auth/passkeys/${lost.credentials[0].id}`, { token: keep })).status, 204);
  assert.equal((await s.call('GET', '/auth/me', { token: lostToken })).status, 401, 'the lost phone is signed out');
  assert.equal((await s.call('GET', '/auth/me', { token })).status, 401);
  assert.equal((await s.call('GET', '/auth/me', { token: keep })).status, 200, 'this phone stays signed in');
  const other = (await signIn(s, phone)).body.token;
  assert.equal((await s.call('POST', '/auth/signout?everywhere=1', { token: keep })).status, 204);
  assert.equal((await s.call('GET', '/auth/me', { token: other })).status, 401);
  assert.equal((await s.call('GET', '/auth/me', { token: keep })).status, 401);
});

test('a game rewritten for a room that still remembers a deleted player drops the player ID', async () => {
  const s = server(), auth = await softAuthenticator({ origin: ORIGIN });
  const { token, player } = await createPlayer(s, auth);
  const { writeRecord } = await import('../server/d1/write.js');
  const rec = id => ({
    game: { id: '0123456789abcdef', source: 'online', mode: 'dice', status: 'over', early: 0, player_count: 2 },
    players: [0, 1].map(i => ({ game_id: '0123456789abcdef', idx: i, name: ['Anna', 'Ben'][i], name_key: ['anna', 'ben'][i], score: 0, lost: 0, sevens_outs: 0, shots: 0, turns: 0, user_id: i ? null : id })),
    turns: []
  });
  await writeRecord(s.db, rec(player.id));
  assert.equal(s.d1.raw.prepare('SELECT user_id FROM players WHERE idx = 0').get().user_id, player.id);
  await s.call('DELETE', '/auth/me', { token });
  await writeRecord(s.db, rec(player.id));
  assert.equal(s.d1.raw.prepare('SELECT user_id FROM players WHERE idx = 0').get().user_id, null);
});

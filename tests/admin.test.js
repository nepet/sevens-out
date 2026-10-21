// The admin Worker: sign-in check, routes and API, with a D1 stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// let `import PAGE from './page.html'` load the file as text, as wrangler does
register('data:text/javascript,' + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith('.html')) {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')) };
    }
    return next(url, ctx);
  }`));

const { fakeD1 } = await import('./fake-d1.js');
const { fromD1 } = await import('../server/d1/db.js');
const { writeRecord, writeRoom } = await import('../server/d1/write.js');
const { summarize } = await import('../server/core/stats.js');
const { quickGame } = await import('./games.js');
const { handle } = await import('../server/admin/worker.js');

const ID = 'abcdefabcdefabcd';
const local = (path, init) => new Request(`http://127.0.0.1:8789${path}`, init);
async function devEnv() {
  const d1 = fakeD1();
  await writeRecord(fromD1(d1), summarize(quickGame(['Anna', 'Ben']), { id: ID, source: 'phone', startedAt: Date.now() - 60_000, finishedAt: Date.now(), status: 'over' }));
  return { STATS: d1, ADMIN_DEV_NO_ACCESS: '1' };
}

test('locally (dev mode on 127.0.0.1) the page and the API answer', async () => {
  const env = await devEnv();
  const page = await handle(local('/'), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const s = await (await handle(local('/api/stats?period=all'), env)).json();
  assert.equal(s.activity.games, 1);
  const list = await (await handle(local('/api/games'), env)).json();
  assert.deepEqual(list.games.map(g => g.id), [ID]);
  const one = await handle(local(`/api/games/${ID}`), env);
  assert.equal((await one.json()).sheet.players[0], 'Anna');
  assert.equal((await handle(local('/api/games/ffffffffffffffff'), env)).status, 404);
  assert.equal((await handle(local('/api/games/nope'), env)).status, 404);
  assert.equal((await handle(local('/api/nothing'), env)).status, 404);
  assert.equal((await handle(local(`/api/games/${ID}`, { method: 'DELETE' }), env)).status, 204);
  assert.equal((await handle(local(`/api/games/${ID}`), env)).status, 404);
  env.STATS.down = true;
  const broken = await handle(local('/api/stats'), env);
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: 'server' });
});

// a real-looking Access setup with a locally made key
const TEAM = 'sevens', AUD = 'aud-123', OWNER = 'Owner@Example.com';
const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const pair = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
const keys = [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' }];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
async function token(email) {
  const t = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1' }), body = b64({ aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, email, exp: t + 600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const live = (headers = {}) => new Request('https://sevens-out-admin.example.workers.dev/', { headers });

test('on the internet only the owner gets in', async () => {
  const env = { ...(await devEnv()), ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: 'owner@example.com' };
  const deps = { keys: async () => keys };
  assert.equal((await handle(live(), env, deps)).status, 403, 'dev mode does not count off 127.0.0.1');
  assert.equal((await handle(live({ 'Cf-Access-Jwt-Assertion': await token('someone@example.com') }), env, deps)).status, 403);
  assert.equal((await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), env, deps)).status, 200);
  const pasted = { ...env, ADMIN_EMAIL: 'owner@example.com\n' }; // a secret pasted with a line break
  assert.equal((await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), pasted, deps)).status, 200);
  const blank = await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), { ...env, ADMIN_EMAIL: ' \n' }, deps);
  assert.equal(blank.status, 500, 'a blank ADMIN_EMAIL is missing configuration');
  const unconfigured = await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), { STATS: env.STATS }, deps);
  assert.equal(unconfigured.status, 500);
  const noKeys = await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), env, { keys: async () => { throw new Error('down'); } });
  assert.equal(noKeys.status, 503);
});

// ----- rooms, with a stand-in for the game Worker's AdminApi -----
const R1 = '1111111111111111', R2 = '2222222222222222', R3 = '3333333333333333';
const row = o => ({ code: 'K7QPM', created_at: Date.now() - 3_600_000, active_at: Date.now() - 3_600_000, phase: 'lobby', seats: 2, connected: 0, watching: 0,
  signed_in: 0, names: '["Anna","Ben"]', games_started: 0, games_finished: 0, connects: 2, rejoins: 0, spectators: 0, chat: 0, peak: 2, ...o });
function fakeGame(rooms) {
  const closed = [];
  return {
    closed,
    room: async code => rooms[code] || null,
    close: async (code, id) => { const v = rooms[code]; if (!v || v.id !== id) return false; delete rooms[code]; closed.push(code); return true; }
  };
}
const view = (id, { connected = false, updated = Date.now() - 2 * 3_600_000, phase = 'game' } = {}) => ({
  id, rev: 5, created: 0, updated, connections: connected ? 1 : 0, watching: [], chat: 0,
  room: { code: 'x', phase, host: 's1', settings: {}, seats: [{ id: 's1', name: 'Anna', connected }, { id: 's2', name: 'Ben', connected: false }] },
  state: phase === 'game' ? { phase: 'play', game: { round: 3, players: [] } } : null
});

test('rooms: open rooms that may be busy get a live look; a room that has gone is closed; one room opens with its live game', async () => {
  const env = await devEnv();
  const db = fromD1(env.STATS);
  const R4 = '4444444444444444';
  await writeRoom(db, row({ id: R1, code: 'AAAAA', connected: 1, active_at: Date.now() - 3 * 3_600_000 }), [{ seq: 1, at: 1, kind: 'created', detail: { name: 'Anna' } }]);
  await writeRoom(db, row({ id: R2, code: 'BBBBB', active_at: Date.now() - 3 * 3_600_000 })); // nobody there for 3 hours: not woken
  await writeRoom(db, row({ id: R3, code: 'CCCCC', active_at: Date.now() }));
  await writeRoom(db, row({ id: R4, code: 'DDDDD', connected: 2, active_at: Date.now() - 2 * 3_600_000 }));
  const asked = [];
  env.GAME = fakeGame({ AAAAA: view(R1, { connected: true }), BBBBB: view(R2), CCCCC: view('ffffffffffffffff') }); // CCCCC's code now belongs to another room
  const ask = env.GAME.room;
  env.GAME.room = code => { asked.push(code); return ask(code); };

  const list = await (await handle(local('/api/rooms'), env)).json();
  assert.deepEqual(asked.sort(), ['AAAAA', 'CCCCC', 'DDDDD']);
  const [a, b] = ['AAAAA', 'BBBBB'].map(c => list.rooms.find(r => r.code === c));
  assert.equal(list.rooms.length, 2);
  assert.deepEqual([a.phase, a.round, a.connected, a.live.connections], ['playing', 3, 1, 1]);
  assert.deepEqual([b.phase, b.live], ['lobby', null], 'what the row says');
  assert.equal(list.live, true);
  const closed = await (await handle(local('/api/rooms?status=closed'), env)).json();
  assert.deepEqual(closed.rooms.map(r => [r.code, r.closeReason]).sort(), [['CCCCC', 'gone'], ['DDDDD', 'gone']]);

  const one = await (await handle(local(`/api/rooms/${R2}`), env)).json();
  assert.equal(one.live.state.game.round, 3, 'one room always gets a live look');
  assert.deepEqual((await (await handle(local(`/api/rooms/${R1}`), env)).json()).events.map(e => e.kind), ['created']);
  assert.equal((await handle(local('/api/rooms/ffffffffffffffff'), env)).status, 404);

  // the game Worker can't be asked: the page still gets the rows
  env.GAME = { room: async () => { throw new Error('down'); } };
  const down = await (await handle(local('/api/rooms'), env)).json();
  const busy = r => r.code === 'AAAAA';
  assert.deepEqual([down.rooms.length, down.live, down.rooms.find(busy).liveError], [2, false, 'unreachable']);
  delete env.GAME;
  const unbound = await (await handle(local('/api/rooms'), env)).json();
  assert.deepEqual([unbound.binding, unbound.rooms.find(busy).liveError], [false, 'no_binding']);
  assert.equal((await handle(local(`/api/rooms/${R1}/close`, { method: 'POST' }), env)).status, 503);
  assert.equal((await handle(local('/api/rooms/close-idle', { method: 'POST' }), env)).status, 503);
});

test('rooms: closing one room, and closing every idle room after asking each once more', async () => {
  const env = await devEnv();
  const db = fromD1(env.STATS);
  const ids = ['a', 'b', 'c', 'd', 'e'].map(ch => ch.repeat(16)), two = Date.now() - 2 * 3_600_000;
  await writeRoom(db, row({ id: ids[0], code: 'AAAAA', active_at: two }));
  await writeRoom(db, row({ id: ids[1], code: 'BBBBB', active_at: two }));
  await writeRoom(db, row({ id: ids[2], code: 'CCCCC', active_at: two }));
  await writeRoom(db, row({ id: ids[3], code: 'DDDDD' }));
  await writeRoom(db, row({ id: ids[4], code: 'EEEEE', active_at: two }));
  env.GAME = fakeGame({
    AAAAA: view(ids[0], { updated: two }),                        // idle for two hours
    BBBBB: view(ids[1], { connected: true, updated: two }),       // the row is behind: someone is connected
    CCCCC: view(ids[2], { updated: Date.now() - 60_000 }),        // the row is behind: active a minute ago
    DDDDD: view(ids[3], { phase: 'lobby' })                        // EEEEE: gone
  });
  const one = await handle(local(`/api/rooms/${ids[3]}/close`, { method: 'POST' }), env);
  assert.deepEqual(await one.json(), { closed: 'closed' });
  assert.deepEqual(env.GAME.closed, ['DDDDD']);
  await db.batch([['UPDATE rooms SET closed_at = 1 WHERE id = ?', [ids[3]]]]); // what the room itself writes when it closes
  assert.deepEqual(await (await handle(local(`/api/rooms/${ids[3]}/close`, { method: 'POST' }), env)).json(), { closed: 'already' });

  assert.equal((await handle(local('/api/rooms/close-idle?hours=6'), env)).status, 404, 'POST only');
  assert.deepEqual(await (await handle(local('/api/rooms/close-idle?hours=6', { method: 'POST' }), env)).json(), { closed: 0, hours: 6 });
  assert.deepEqual(await (await handle(local('/api/rooms/close-idle?hours=1', { method: 'POST' }), env)).json(), { closed: 1, hours: 1 });
  assert.deepEqual(env.GAME.closed, ['DDDDD', 'AAAAA']);
  const closed = await (await handle(local('/api/rooms?status=closed'), env)).json();
  assert.ok(closed.rooms.some(r => r.code === 'EEEEE' && r.closeReason === 'gone'));
  assert.equal((await handle(local('/api/rooms/9999999999999999/close', { method: 'POST' }), env)).status, 404);
});

test('usage answers with the filters', async () => {
  const env = await devEnv();
  const u = await (await handle(local('/api/usage?period=all'), env)).json();
  assert.equal(u.sizes[0].players, 2);
  assert.equal(u.when.length, 7);
});

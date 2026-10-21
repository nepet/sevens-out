// The Cloudflare adapter against a stand-in Durable Object runtime.
// (The real runtime is exercised by `npm run test:worker`, which runs the browser tests against `wrangler dev`.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fakeD1 } from './fake-d1.js';
import { diceGame, scoreGame } from './games.js';
import { sheetOf } from '../server/core/stats.js';
import { softAuthenticator } from './authenticator.js';

// resolve `cloudflare:workers` to a minimal DurableObject base class
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }') };
    return next(spec, ctx);
  }`));

// stand-ins for the Workers runtime globals the adapter uses
class FakeWS {
  constructor() { this.readyState = 1; this.att = null; this.inbox = []; }
  send(s) { if (this.readyState === 1) this.inbox.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  serializeAttachment(v) { this.att = structuredClone(v); }
  deserializeAttachment() { return structuredClone(this.att); }
}
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS(); } };
const NodeResponse = globalThis.Response;
globalThis.Response = class {
  constructor(body, init = {}) { this.status = init.status || 200; this.webSocket = init.webSocket; this.body = body; this.headers = new Headers(init.headers); }
  text() { return Promise.resolve(this.body); }
  json() { return Promise.resolve(JSON.parse(this.body)); }
};

const { default: worker, GameRoom } = await import('../server/cloudflare/worker.js');

function fakeCtx() {
  const kv = new Map(), sockets = [];
  const ctx = {
    kv, alarm: null,
    storage: {
      get: async k => structuredClone(kv.get(k)),
      put: async (k, v) => { kv.set(k, structuredClone(v)); },
      delete: async k => { kv.delete(k); },
      deleteAll: async () => { kv.clear(); },
      setAlarm: async t => { ctx.alarm = t; }
    },
    acceptWebSocket: ws => sockets.push(ws),
    getWebSockets: () => sockets
  };
  return ctx;
}

async function connect(obj, code) {
  const res = await obj.fetch(new Request(`https://x/room/${code}`, { headers: { Upgrade: 'websocket' } }));
  assert.equal(res.status, 101);
  return obj.ctx.getWebSockets().at(-1); // the server side the DO accepted
}
const say = (obj, ws, m) => obj.webSocketMessage(ws, JSON.stringify(m));
const last = (ws, t) => [...ws.inbox].reverse().find(m => m.t === t);

test('routing: health, bad paths, non-WebSocket requests and the origin allowlist', async () => {
  const seen = [];
  const env = { ALLOWED_ORIGINS: 'https://me.github.io', ROOMS: { idFromName: n => `id:${n}`, get: id => ({ fetch: () => { seen.push(id); return new Response(null, { status: 101 }); } }) } };
  assert.equal((await worker.fetch(new Request('https://x/health'), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://x/room/abc'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://x/room/K7QPM'), env)).status, 426);
  const ws = h => new Request('https://x/room/K7QPM', { headers: { Upgrade: 'websocket', ...h } });
  assert.equal((await worker.fetch(ws({ Origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(ws({ Origin: 'https://me.github.io' }), env)).status, 101);
  assert.deepEqual(seen, ['id:K7QPM'], 'one Durable Object per room code');
});

test('a room in a Durable Object: create, join, play, and it survives hibernation', async () => {
  const ctx = fakeCtx();
  let obj = new GameRoom(ctx, {});
  const a = await connect(obj, 'K7QPM'), b = await connect(obj, 'K7QPM');
  await say(obj, a, { t: 'hello', name: 'Anna', create: true });
  await say(obj, b, { t: 'hello', name: 'Ben' });
  assert.equal(last(b, 'room').room.seats.length, 2);
  await say(obj, a, { t: 'lobby', op: 'start' });
  assert.ok(ctx.alarm > Date.now(), 'saving schedules the cleanup alarm');

  // hibernation: the object is rebuilt, sockets and their attachments stay
  obj = new GameRoom(ctx, {});
  await say(obj, a, { t: 'act', action: { type: 'roll' } });
  const m = last(b, 'room');
  assert.equal(m.state.game.turn.rolls, 1);
  assert.equal(m.events[0].type, 'rolled');

  // a closed socket shows that player offline to the others
  b.readyState = 3;
  await obj.webSocketClose(b, 1001);
  assert.equal(last(a, 'room').room.seats[1].connected, false);
});

test('the cleanup alarm deletes rooms that have not been used for two weeks', async () => {
  const ctx = fakeCtx(), obj = new GameRoom(ctx, {});
  const a = await connect(obj, 'ABCDE');
  await say(obj, a, { t: 'hello', name: 'Anna', create: true });
  const room = ctx.kv.get('room');
  room.updated = Date.now() - 15 * 24 * 3600 * 1000;
  ctx.kv.set('room', room);
  const later = new GameRoom(ctx, {});
  await later.alarm();
  assert.equal(ctx.kv.size, 0);
});

test('a spectator keeps their identity across hibernation, and the log replays after the rebuild', async () => {
  const ctx = fakeCtx();
  let obj = new GameRoom(ctx, {});
  const a = await connect(obj, 'K7QPM'), b = await connect(obj, 'K7QPM'), c = await connect(obj, 'K7QPM');
  await say(obj, a, { t: 'hello', name: 'Anna', create: true });
  await say(obj, b, { t: 'hello', name: 'Ben' });
  await say(obj, a, { t: 'lobby', op: 'start' });
  await say(obj, c, { t: 'hello', name: 'Dan' });
  const viewer = last(c, 'welcome').viewer;
  assert.match(viewer, /^w[0-9a-f]{8}$/);

  obj = new GameRoom(ctx, {}); // hibernation: the sockets and their attachments stay
  await say(obj, c, { t: 'chat', text: 'hello table' });
  const msg = last(a, 'chat').msg;
  assert.equal(msg.from, viewer);
  assert.equal(msg.name, 'Dan');
  assert.equal(msg.seat, null);

  obj = new GameRoom(ctx, {});
  const d = await connect(obj, 'K7QPM');
  await say(obj, d, { t: 'hello', name: 'Eve' });
  assert.deepEqual(last(d, 'chat').log.map(m => m.text), ['hello table']);
});

const DAY = 24 * 3600 * 1000;
const gameRow = d1 => d1.raw.prepare('SELECT id, status, loser FROM games').all().map(r => ({ ...r }));
async function startedGame(env) {
  const ctx = fakeCtx(), obj = new GameRoom(ctx, env);
  const a = await connect(obj, 'K7QPM'), b = await connect(obj, 'K7QPM');
  await say(obj, a, { t: 'hello', name: 'Anna', create: true });
  await say(obj, b, { t: 'hello', name: 'Ben' });
  await say(obj, a, { t: 'lobby', op: 'start' });
  return { ctx, obj, a, b };
}
const duePending = ctx => { const p = ctx.kv.get('pendingStats'); for (const e of Object.values(p)) e.at = 0; ctx.kv.set('pendingStats', p); };

test('statistics: games go to D1, and a failed write is retried from the alarm', async () => {
  const d1 = fakeD1(), env = { STATS: d1 };
  const { ctx, a } = await startedGame(env);
  assert.deepEqual(gameRow(d1).map(r => r.status), ['playing']);

  d1.down = true;
  await say(new GameRoom(ctx, env), a, { t: 'act', action: { type: 'endearly' } });
  assert.equal(last(a, 'room').state.phase, 'over', 'players see the result although D1 is down');
  assert.equal(Object.keys(ctx.kv.get('pendingStats')).length, 1);
  assert.ok(ctx.alarm <= Date.now() + 61_000, 'a retry is scheduled within a minute');

  d1.down = false;
  duePending(ctx);
  const woken = new GameRoom(ctx, env); // after hibernation
  await woken.alarm();
  assert.deepEqual(gameRow(d1).map(r => r.status), ['over']);
  assert.equal(ctx.kv.get('pendingStats'), undefined);
  assert.ok(ctx.alarm > Date.now() + 13 * DAY, 'back to the expiry alarm');
});

test('statistics: an older record waiting for a retry never replaces a newer one', async () => {
  const d1 = fakeD1(), env = { STATS: d1 };
  d1.down = true;
  const { ctx, obj, a } = await startedGame(env);       // "playing" fails and waits
  d1.down = false;
  await say(obj, a, { t: 'act', action: { type: 'endearly' } }); // "over" is written
  assert.equal(ctx.kv.get('pendingStats'), undefined, 'the newer record replaced the waiting one');
  await obj.alarm();
  assert.deepEqual(gameRow(d1).map(r => r.status), ['over']);
});

test('statistics: a write that keeps failing is given up after a day', async () => {
  const d1 = fakeD1(), env = { STATS: d1 };
  d1.down = true;
  const { ctx, obj } = await startedGame(env);
  const p = ctx.kv.get('pendingStats');
  for (const e of Object.values(p)) { e.at = 0; e.since = Date.now() - 25 * 3600 * 1000; }
  ctx.kv.set('pendingStats', p);
  await obj.alarm();
  assert.equal(ctx.kv.get('pendingStats'), undefined);
  assert.ok(ctx.kv.get('room'), 'the room itself is untouched');
});

test('statistics: an expired room with an unfinished game is recorded as abandoned, then deleted', async () => {
  const d1 = fakeD1(), env = { STATS: d1 };
  const { ctx } = await startedGame(env);
  const room = ctx.kv.get('room');
  room.updated = Date.now() - 15 * DAY;
  ctx.kv.set('room', room);
  await new GameRoom(ctx, env).alarm();
  assert.deepEqual(gameRow(d1).map(r => r.status), ['abandoned']);
  assert.equal(ctx.kv.size, 0);
});

test('statistics: a waiting write survives the room being removed when everyone leaves', async () => {
  const d1 = fakeD1(), env = { STATS: d1 };
  const { ctx, obj, a, b } = await startedGame(env);
  d1.down = true;
  await say(obj, a, { t: 'act', action: { type: 'endearly' } });
  d1.down = false; // only the later steps matter now; the waiting write stays until the alarm
  await say(obj, a, { t: 'lobby', op: 'reopen' });
  await say(obj, a, { t: 'lobby', op: 'leave' });
  await say(obj, b, { t: 'lobby', op: 'leave' });
  assert.equal(ctx.kv.has('room'), false, 'the room is gone');
  assert.equal(Object.keys(ctx.kv.get('pendingStats')).length, 1, 'the waiting write is kept');
  assert.ok(ctx.alarm <= Date.now() + 61_000, 'a retry is scheduled');

  duePending(ctx);
  await new GameRoom(ctx, env).alarm();
  assert.deepEqual(gameRow(d1).map(r => r.status), ['over']);
  assert.equal(ctx.kv.size, 0);
});

test('statistics: a waiting write without the STATS binding is dropped, not retried in a loop', async () => {
  const d1 = fakeD1(), env = { STATS: d1 };
  d1.down = true;
  const { ctx } = await startedGame(env);   // "playing" fails and waits
  duePending(ctx);
  const unbound = new GameRoom(ctx, {});     // the binding was removed in a later deploy
  await unbound.alarm();
  assert.equal(ctx.kv.get('pendingStats'), undefined, 'the waiting write is dropped');
  assert.ok(ctx.alarm > Date.now() + 13 * DAY, 'only the expiry alarm is set');

  // with no room left either, the storage is cleared
  ctx.kv.set('pendingStats', { x: { rec: {}, since: 0, tries: 0, at: 0 } });
  ctx.kv.delete('room');
  ctx.alarm = null;
  await new GameRoom(ctx, {}).alarm();
  assert.equal(ctx.kv.size, 0);
  assert.equal(ctx.alarm, null, 'no alarm is set');
});

const ORIGIN = 'https://me.github.io';
function reportEnv(d1 = fakeD1()) {
  const hits = new Map();
  return {
    ALLOWED_ORIGINS: ORIGIN, STATS: d1,
    REPORT_LIMIT: { limit: async ({ key }) => { hits.set(key, (hits.get(key) || 0) + 1); return { success: hits.get(key) <= 10 }; } }
  };
}
const reportBody = (s, id = '0123456789abcdef') => JSON.stringify({ id, mode: s.game.mode, startedAt: Date.now() - 600_000, finishedAt: Date.now() - 1000, sheet: sheetOf(s.game) });
const post = (body, headers = {}) => new Request('https://x/report', { method: 'POST', body, headers: { Origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers } });

test('report: a one-phone game is checked and stored; the same game again replaces it', async () => {
  const env = reportEnv();
  let res = await worker.fetch(post(reportBody(diceGame(3))), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  res = await worker.fetch(post(reportBody(scoreGame(4))), env);
  assert.equal(res.status, 204);
  const rows = env.STATS.raw.prepare('SELECT source, mode, status FROM games').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [{ source: 'phone', mode: 'score', status: 'over' }]);
});

test('report: preflight, wrong origin, wrong method, size, bad input', async () => {
  const env = reportEnv();
  const pre = await worker.fetch(new Request('https://x/report', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.equal((await worker.fetch(post(reportBody(diceGame(3)), { Origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://x/report', { headers: { Origin: ORIGIN } }), env)).status, 405);
  assert.equal((await worker.fetch(post('x'.repeat(33 * 1024)), env)).status, 413);
  assert.equal((await worker.fetch(post('not json'), env)).status, 400);
  const refused = await worker.fetch(post(JSON.stringify({ id: 'nope' })), env);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, 'id');
  assert.equal(env.STATS.raw.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0);
});

test('report: rate limit, D1 down, and no database configured', async () => {
  const env = reportEnv();
  const body = reportBody(diceGame(5));
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(post(body), env)).status, 204);
  assert.equal((await worker.fetch(post(body), env)).status, 429);
  assert.equal((await worker.fetch(post(body, { 'CF-Connecting-IP': '198.51.100.1' }), env)).status, 204, 'the limit is per IP');
  env.STATS.down = true;
  assert.equal((await worker.fetch(post(body, { 'CF-Connecting-IP': '198.51.100.2' }), env)).status, 503);
  assert.equal((await worker.fetch(post(body), { ALLOWED_ORIGINS: ORIGIN })).status, 404);
});

test('auth: routed to the accounts handler on D1, limited per IP, off without a database', async () => {
  const hits = new Map();
  const env = { ALLOWED_ORIGINS: ORIGIN, STATS: fakeD1(), AUTH_LIMIT: { limit: async ({ key }) => { hits.set(key, (hits.get(key) || 0) + 1); return { success: hits.get(key) <= 3 }; } } };
  const call = async (method, path, body, headers = {}) => {
    const res = await worker.fetch(new Request(`https://x${path}`, { method, body: body && JSON.stringify(body), headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.5', ...headers } }), env);
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
  const auth = await softAuthenticator({ origin: ORIGIN });
  const o = await call('POST', '/auth/options', { purpose: 'create', name: 'Anna' });
  assert.equal(o.headers.get('access-control-allow-origin'), ORIGIN);
  const credential = await auth.create({ challenge: o.body.challenge, userId: o.body.user.id });
  const created = await call('POST', '/auth/create', { challengeId: o.body.challengeId, credential });
  assert.equal(created.status, 200);
  assert.equal(env.STATS.raw.prepare('SELECT name FROM users').get().name, 'Anna');
  assert.equal((await call('GET', '/auth/me', null, { Authorization: `Bearer ${created.body.token}` })).body.player.name, 'Anna');
  // a room in this Worker resolves the session against the same database
  const obj = new GameRoom(fakeCtx(), env), ws = await connect(obj, 'K7QPM');
  await say(obj, ws, { t: 'hello', session: created.body.token, create: true });
  assert.equal(last(ws, 'welcome').user, created.body.player.id);
  assert.equal((await call('GET', '/auth/me')).status, 429, 'the fourth counted request from this IP');
  assert.equal((await call('GET', '/auth/config')).status, 200, 'the probe is not counted');
  env.AUTH_NO_LIMIT = '1';
  assert.equal((await call('GET', '/auth/me')).status, 429, 'the test switch works on localhost only');
  const local = await worker.fetch(new Request('http://127.0.0.1:8787/auth/me', { headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.5' } }), env);
  assert.equal(local.status, 401);
  assert.equal((await call('GET', '/auth/config', null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await worker.fetch(new Request('https://x/auth/config'), { ALLOWED_ORIGINS: ORIGIN })).status, 404, 'no database, no accounts');
});

test('report: a signed-in phone owner\'s line counts for them, only under their player name', async () => {
  const env = reportEnv();
  const auth = await softAuthenticator({ origin: ORIGIN });
  const call = async (path, body, headers = {}) => {
    const res = await worker.fetch(new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body), headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.6', ...headers } }), env);
    return res.body ? JSON.parse(res.body) : null;
  };
  const s = diceGame(3), name = s.game.players[1].name, none = s.game.players.map(() => null);
  const o = await call('/auth/options', { purpose: 'create', name });
  const created = await call('/auth/create', { challengeId: o.challengeId, credential: await auth.create({ challenge: o.challenge, userId: o.user.id }) });
  const bearer = { Authorization: `Bearer ${created.token}` };
  const pre = await worker.fetch(new Request('https://x/report', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  const send = async (owner, headers, id) => {
    const body = { ...JSON.parse(reportBody(s, id)), owner };
    const res = await worker.fetch(post(JSON.stringify(body), headers), env);
    assert.equal(res.status, 204);
    return env.STATS.raw.prepare('SELECT user_id FROM players WHERE game_id = ? ORDER BY idx').all(id).map(r => r.user_id);
  };
  assert.deepEqual(await send(1, bearer, 'aaaaaaaaaaaaaaa1'), none.map((_, i) => (i === 1 ? created.player.id : null)));
  assert.deepEqual(await send(0, bearer, 'aaaaaaaaaaaaaaa2'), none, 'someone else\'s line');
  assert.deepEqual(await send(1, {}, 'aaaaaaaaaaaaaaa3'), none, 'not signed in');
  assert.deepEqual(await send(1, { Authorization: `Bearer ${'0'.repeat(64)}` }, 'aaaaaaaaaaaaaaa4'), none, 'an ended session');
  assert.deepEqual(await send(7, bearer, 'aaaaaaaaaaaaaaa5'), none, 'no such line');
});

test.after(() => { globalThis.Response = NodeResponse; });

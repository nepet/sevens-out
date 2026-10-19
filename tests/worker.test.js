// The Cloudflare adapter against a stand-in Durable Object runtime.
// (The real runtime is exercised by `npm run test:worker`, which runs the browser tests against `wrangler dev`.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fakeD1 } from './fake-d1.js';

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
globalThis.Response = class { constructor(body, init = {}) { this.status = init.status || 200; this.webSocket = init.webSocket; this.body = body; } text() { return Promise.resolve(this.body); } };

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

test.after(() => { globalThis.Response = NodeResponse; });

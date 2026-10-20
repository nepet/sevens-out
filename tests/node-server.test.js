// The self-hosted Node server, end to end over real WebSockets (Node's built-in client).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { softAuthenticator } from './authenticator.js';

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir;

async function startServer() {
  proc = spawn(process.execPath, ['server/node/server.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, AUTH_LIMIT: '12' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
async function stopServer() { if (proc) { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); proc = null; } }

before(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'sevens-')); await startServer(); });
after(async () => { await stopServer(); await rm(dataDir, { recursive: true, force: true }); });

// a tiny client that remembers every message and lets a test wait for one
function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room/${code}`);
  const inbox = [], waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data); inbox.push(m);
    for (const w of waiters.splice(0)) if (!w.test(m)) waiters.push(w); else w.resolve(m);
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const next = test => new Promise((resolve, reject) => {
    const hit = inbox.find(test); if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error('timed out waiting for a message')), 4000);
    waiters.push({ test, resolve: m => { clearTimeout(t); resolve(m); } });
  });
  const send = async m => { await opened; ws.send(JSON.stringify(m)); };
  const closed = new Promise(r => { ws.onclose = r; });
  return { ws, inbox, next, send, closed, clear: () => inbox.splice(0) };
}

test('serves the page pointed at itself, plus engine.js, and nothing else', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /<meta name="sevens-out-server" content="same-origin">/);
  assert.match(html, /<script src="engine.js"><\/script>/);
  const js = await fetch(`${BASE}/engine.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${BASE}/package.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/../server/core/room.js`)).status, 404);
});

test('two phones create, join and play a turn over WebSockets', async () => {
  const a = client('ABCDE');
  await a.send({ t: 'hello', name: 'Anna', create: true });
  const wa = await a.next(m => m.t === 'welcome');
  const b = client('ABCDE');
  await b.send({ t: 'hello', name: 'Ben' });
  await b.next(m => m.t === 'welcome');
  await a.next(m => m.t === 'room' && m.room.seats.length === 2);
  await a.send({ t: 'lobby', op: 'start' });
  await b.next(m => m.t === 'room' && m.room.phase === 'game');
  await a.send({ t: 'act', action: { type: 'roll' } });
  const rolled = await b.next(m => m.t === 'room' && m.events && m.events.some(e => e.type === 'rolled'));
  assert.equal(rolled.state.game.turn.rolls, 1);
  await b.send({ t: 'act', action: { type: 'roll' } });
  assert.equal((await b.next(m => m.t === 'error')).code, 'not_your_turn');
  a.ws.close(); b.ws.close();
  await Promise.all([a.closed, b.closed]);
  assert.ok(wa.token);
});

test('a room survives a server restart (state on disk) and a token gets the seat back', async () => {
  const a = client('FGHJK');
  await a.send({ t: 'hello', name: 'Anna', create: true });
  const { token } = await a.next(m => m.t === 'welcome');
  const b = client('FGHJK');
  await b.send({ t: 'hello', name: 'Ben' });
  await a.next(m => m.t === 'room' && m.room.seats.length === 2);
  await a.send({ t: 'lobby', op: 'start' });
  await a.next(m => m.t === 'room' && m.room.phase === 'game');
  assert.ok((await readdir(dataDir)).includes('FGHJK.json'));
  await stopServer();
  await startServer();
  const a2 = client('FGHJK');
  await a2.send({ t: 'hello', token });
  const m = await a2.next(x => x.t === 'room');
  assert.equal(m.room.phase, 'game');
  assert.equal(m.state.phase, 'play');
  a2.ws.close();
  await a2.closed;
});

test('big messages and bad paths are refused', async () => {
  const a = client('MNPQR');
  await a.send({ t: 'hello', name: 'x'.repeat(9000), create: true });
  await a.closed; // over maxPayload: the server closes the socket
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/room/abc`);
  await new Promise(r => { bad.onerror = r; bad.onclose = r; });
  assert.notEqual(bad.readyState, WebSocket.OPEN);
});

// /auth over real HTTP; X-Forwarded-For from this machine stands for a client behind the proxy
const authCall = async (method, p, { body, token, ip = '198.51.100.7', origin } = {}) => {
  const headers = { 'x-forwarded-for': ip };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

test('player accounts: create and sign in with a passkey, kept across a restart', async () => {
  const auth = await softAuthenticator({ origin: BASE });
  assert.deepEqual((await authCall('GET', '/auth/config')).body, { ok: true });
  const o = await authCall('POST', '/auth/options', { body: { purpose: 'create', name: 'Anna' } });
  const credential = await auth.create({ challenge: o.body.challenge, userId: o.body.user.id });
  const created = await authCall('POST', '/auth/create', { body: { challengeId: o.body.challengeId, credential } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok((await readdir(dataDir)).includes('sevens-out.db'));
  await stopServer();
  await startServer();
  assert.equal((await authCall('GET', '/auth/me', { token: created.body.token })).body.player.name, 'Anna');
  const s = await authCall('POST', '/auth/options', { body: { purpose: 'signin' } });
  const assertion = await auth.get({ challenge: s.body.challenge });
  const back = await authCall('POST', '/auth/signin', { body: { challengeId: s.body.challengeId, credential: assertion } });
  assert.equal(back.body.player.id, created.body.player.id);
});

test('player accounts: CORS, body size and the per-IP limit', async () => {
  const pre = await authCall('OPTIONS', '/auth/me', { origin: 'https://game.example' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://game.example', 'no allowlist: any origin (development)');
  const big = await fetch(`${BASE}/auth/options`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.8' }, body: 'x'.repeat(20_000) });
  assert.equal(big.status, 413);
  for (let i = 0; i < 20; i++) assert.equal((await authCall('GET', '/auth/config', { ip: '198.51.100.9' })).status, 200, 'the probe is never limited');
  const codes = [];
  for (let i = 0; i < 13; i++) codes.push((await authCall('GET', '/auth/me', { ip: '198.51.100.9' })).status);
  assert.deepEqual([codes[0], codes[11], codes[12]], [401, 401, 429]);
  assert.equal((await authCall('GET', '/auth/me', { ip: '198.51.100.10' })).status, 401, 'the limit is per client');
});

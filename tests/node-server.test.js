// The self-hosted Node server, end to end over real WebSockets (Node's built-in client).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir;

async function startServer() {
  proc = spawn(process.execPath, ['server/node/server.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'pipe' });
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

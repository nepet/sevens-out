#!/usr/bin/env node
/*
 * Option 5 (and local development): the same rooms on a plain Node server.
 *
 *   node server/node/server.js        # http://localhost:8788   (no npm packages needed)
 *
 * Serves the page (with online play pointed at itself) and the WebSocket rooms on one port.
 * Rooms are kept as JSON files in DATA_DIR, player accounts in DATA_DIR/sevens-out.db. Put Caddy or another TLS proxy in front for HTTPS.
 *
 * Player accounts answer at /auth/* (server/core/accounts.js), like on the Worker.
 *
 * Environment:
 *   PORT=8788  HOST=0.0.0.0  DATA_DIR=./data  ALLOWED_ORIGINS=https://example.com,https://other.org
 *   AUTH_LIMIT=60   account requests per minute per IP
 */
import http from 'node:http';
import { readFile, writeFile, rename, unlink, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.js';
import { openDatabase } from './sqlite.js';
import '../../engine.js';
import { Room, CODE_RE, ROOM_TTL_MS } from '../core/room.js';
import { handleAuth, originsFrom, resolveSession, MAX_AUTH_BODY } from '../core/accounts.js';

const E = globalThis.SevensEngine;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = +(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const AUTH_LIMIT = +(process.env.AUTH_LIMIT || 60);

// the only files the page needs
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/engine.js': 'engine.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// ----- file storage, one JSON file per room -----
function fileStorage(code) {
  const file = path.join(DATA_DIR, `${code}.json`);
  return {
    async get() { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } },
    async put(data) { const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(data)); await rename(tmp, file); },
    async remove() { try { await unlink(file); } catch {} }
  };
}

// ----- rooms in memory while someone is connected -----
const rooms = new Map(); // code -> { room, sockets:Set, chain:Promise }
function getRoom(code) {
  let r = rooms.get(code);
  if (r) return r;
  const sockets = new Set();
  const net = {
    send: (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    conns: () => [...sockets].filter(ws => ws.readyState === 1),
    seatOf: ws => ws.seat || null,
    bind: (ws, seat) => { ws.seat = seat; },
    close: (ws, code, reason) => { try { ws.close(code, reason); } catch {} }
  };
  const accounts = { resolve: session => resolveSession(db, session) };
  r = { room: new Room({ engine: E, storage: fileStorage(code), net, accounts }), sockets, chain: Promise.resolve() };
  rooms.set(code, r);
  return r;
}
// one message at a time per room, like a Durable Object
const serial = (r, fn) => (r.chain = r.chain.then(fn).catch(err => console.error('room error', err)));

// ----- /auth: the shared handler speaks Request/Response -----
// behind a proxy on this machine (deploy/Caddyfile), the client is the last X-Forwarded-For entry
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return fwd.length && /^(127\.|::1$|::ffff:127\.)/.test(peer) ? fwd[fwd.length - 1] : peer;
}
const hits = new Map(); // ip -> { n, until }, a fixed one-minute window
function authLimit(ip, pathname) {
  if (pathname === '/auth/config') return true; // the page's probe isn't counted
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.until <= now) hits.set(ip, h = { n: 0, until: now + 60_000 });
  return ++h.n <= AUTH_LIMIT;
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of hits) if (h.until <= now) hits.delete(ip); }, 60_000).unref();

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);
async function auth(req, res, pathname) {
  const ip = clientIp(req), chunks = [];
  let size = 0;
  // keep one byte past the limit so the handler answers 413; the rest is read and dropped
  for await (const c of req) { if (size <= MAX_AUTH_BODY) chunks.push(c.subarray(0, MAX_AUTH_BODY + 1 - size)); size += c.length; }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(new URL(req.url, `http://${req.headers.host || 'localhost'}`), {
    method: req.method, headers: Object.entries(req.headers).filter(([k, v]) => typeof v === 'string' && !HOP.has(k)), body: hasBody ? Buffer.concat(chunks) : undefined
  });
  const r = await handleAuth(request, { db, origins: originsFrom(process.env.ALLOWED_ORIGINS), limit: async () => authLimit(ip, pathname) });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

// ----- HTTP: the page + health -----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/auth/')) {
    try { return await auth(req, res, url.pathname); }
    catch (err) { console.error('auth', err); if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); return res.end(); }
  }
  const file = STATIC[url.pathname];
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  try {
    let body = await readFile(path.join(ROOT, file), 'utf8');
    // served from here, the page plays online against this same server
    if (file === 'index.html') body = body.replace(/(<meta name="sevens-out-server" content=")[^"]*(")/, '$1same-origin$2');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Server error');
  }
});

// ----- WebSocket: /room/<CODE> -----
const clients = new Set();
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/room\/([A-Z0-9]{5})$/);
  const origin = req.headers.origin || '';
  if (!m || !CODE_RE.test(m[1]) || (ALLOWED.length && !ALLOWED.includes('*') && !ALLOWED.includes(origin))) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
  }
  const ws = acceptUpgrade(req, socket, { maxPayload: 8192 });
  if (!ws) return;
  const code = m[1], r = getRoom(code);
  r.sockets.add(ws); clients.add(ws);
  ws.seat = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => { if (!isBinary) serial(r, () => r.room.message(ws, data, code)); });
  ws.on('close', () => {
    r.sockets.delete(ws); clients.delete(ws);
    serial(r, async () => {
      await r.room.closed(ws);
      if (!r.sockets.size && rooms.get(code) === r) rooms.delete(code); // reloaded from disk when someone comes back
    });
  });
  if (head && head.length) ws.onData(head);
});

// drop dead connections (phones that vanished without closing)
setInterval(() => {
  for (const ws of clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30_000).unref();

// delete room files nobody has touched for two weeks
async function sweep() {
  try {
    for (const f of await readdir(DATA_DIR)) {
      if (!f.endsWith('.json') || rooms.has(f.slice(0, -5))) continue;
      const p = path.join(DATA_DIR, f), s = await stat(p);
      if (Date.now() - s.mtimeMs > ROOM_TTL_MS) await unlink(p);
    }
  } catch {}
}
setInterval(sweep, 60 * 60 * 1000).unref();

await mkdir(DATA_DIR, { recursive: true });
const db = openDatabase(path.join(DATA_DIR, 'sevens-out.db'));
await sweep();
server.listen(PORT, HOST, () => console.log(`Sevens Out on http://localhost:${PORT}  (rooms in ${DATA_DIR})`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); for (const ws of clients) ws.close(1001, 'server restart'); db.close(); process.exit(0); });

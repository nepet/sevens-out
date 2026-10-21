/*
 * Option 4: Cloudflare Worker + one Durable Object per room.
 *
 *   GET /health            -> "ok"
 *   GET /room/<CODE> (WS)  -> the room's Durable Object
 *   POST /report           -> stores a finished one-phone game (see server/core/stats.js checkReport)
 *   /auth/*                -> player accounts with passkeys (server/core/accounts.js), stored in the same D1
 *
 * The Durable Object uses the WebSocket Hibernation API, so an idle room costs nothing and survives
 * hibernation: each socket remembers its seat in its attachment, and the room data lives in storage.
 *
 * Statistics: when env.STATS (D1) is bound, each room records its games (server/core/stats.js);
 * a failed write waits in the object's storage under `pendingStats` and is retried from the alarm.
 */
import { DurableObject } from 'cloudflare:workers';
import '../../engine.js';
import { Room, CODE_RE, ROOM_TTL_MS } from '../core/room.js';
import { fromD1 } from '../d1/db.js';
import { writeRecord } from '../d1/write.js';
import { checkReport, summarize, nameKey, MAX_REPORT_BYTES } from '../core/stats.js';
import { handleAuth, originsFrom, resolveSession } from '../core/accounts.js';

const E = globalThis.SevensEngine;

const RETRY_FIRST_MS = 60_000, RETRY_MAX_MS = 3_600_000, RETRY_GIVE_UP_MS = 24 * 3_600_000;

function originAllowed(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length || allowed.includes('*')) return true;
  return allowed.includes(request.headers.get('Origin') || '');
}

// CORS for the page, which runs on another origin (GitHub Pages)
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !originAllowed(request, env)) return {};
  return {
    'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400', vary: 'Origin'
  };
}

// a signed-in phone owner's line (body.owner) counts for them when that line carries their player name;
// anything else stores the game as before, without a player
async function reportOwner(request, env, body, state) {
  const m = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '');
  const players = state.game.players, i = body.owner;
  if (!m || !Number.isInteger(i) || i < 0 || i >= players.length) return [];
  try {
    const user = await resolveSession(fromD1(env.STATS), m[1]);
    if (!user || nameKey(players[i].name) !== nameKey(user.name)) return [];
    return players.map((_, k) => (k === i ? user.id : null));
  } catch (err) { console.error('report owner', err); return []; }
}

// POST /report: a finished one-phone game, checked against the rules, then stored like an online game
async function report(request, env) {
  const cors = corsHeaders(request, env);
  const reply = (status, error) => error
    ? new Response(JSON.stringify({ error }), { status, headers: { ...cors, 'content-type': 'application/json' } })
    : new Response(null, { status, headers: cors });
  if (!originAllowed(request, env)) return reply(403, 'origin'); // also refuses a missing Origin when an allowlist is set
  if (request.method === 'OPTIONS') return reply(204);
  if (request.method !== 'POST') return reply(405, 'method');
  if (!env.STATS) return reply(404, 'stats_off');
  if (env.REPORT_LIMIT) {
    const { success } = await env.REPORT_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return reply(429, 'rate_limited');
  }
  if (+(request.headers.get('content-length') || 0) > MAX_REPORT_BYTES) return reply(413, 'too_large');
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return reply(413, 'too_large');
  let body;
  try { body = JSON.parse(text); } catch { return reply(400, 'not_json'); }
  const r = checkReport(body, E);
  if (r.error) return reply(400, r.error);
  const users = await reportOwner(request, env, body, r.state);
  const rec = summarize(r.state, { id: body.id, source: 'phone', startedAt: body.startedAt, finishedAt: body.finishedAt, status: 'over', users });
  try { await writeRecord(fromD1(env.STATS), rec); }
  catch (err) { console.error('report write failed', err); return reply(503, 'storage'); }
  return reply(204);
}

// /auth/*: accounts need the database; without it the page's probe (GET /auth/config) gets 404 and hides them
function auth(request, env) {
  if (!env.STATS) return new Response(JSON.stringify({ error: 'accounts_off' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const url = new URL(request.url);
  // the probe on every page load isn't counted; AUTH_NO_LIMIT=1 switches the limit off for local browser tests only
  const free = url.pathname === '/auth/config' || (env.AUTH_NO_LIMIT === '1' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  const limit = env.AUTH_LIMIT && !free
    ? async req => (await env.AUTH_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'unknown' })).success
    : null;
  return handleAuth(request, { db: fromD1(env.STATS), origins: originsFrom(env.ALLOWED_ORIGINS), limit });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/report') return report(request, env);
    if (url.pathname.startsWith('/auth/')) return auth(request, env);
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{5})$/);
    if (!m || !CODE_RE.test(m[1])) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!originAllowed(request, env)) return new Response('Origin not allowed', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = {
      get: () => ctx.storage.get('room'),
      put: async data => {
        await ctx.storage.put('room', data);
        await this.scheduleAlarm();
      },
      // statistics still waiting for a retry outlive the room; the alarm cleans up afterwards
      remove: async () => {
        await ctx.storage.delete('room');
        if (env && env.STATS && await ctx.storage.get('pendingStats')) await this.scheduleAlarm();
        else await ctx.storage.deleteAll();
      }
    };
    const net = {
      send: (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch {} },
      conns: () => ctx.getWebSockets().filter(ws => ws.readyState === 1),
      seatOf: ws => (ws.deserializeAttachment() || {}).seat || null,
      bind: (ws, seat, info) => ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), seat, ...(info !== undefined ? { info } : {}) }),
      infoOf: ws => (ws.deserializeAttachment() || {}).info || null,
      close: (ws, code, reason) => { try { ws.close(code, reason); } catch {} }
    };
    const stats = env && env.STATS ? { record: rec => this.recordStats(rec) } : null;
    const accounts = env && env.STATS ? { resolve: session => resolveSession(fromD1(env.STATS), session) } : null;
    this.room = new Room({ engine: E, storage, net, stats, accounts });
  }

  async fetch(request) {
    const code = new URL(request.url).pathname.split('/').pop();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ code, seat: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const { code } = ws.deserializeAttachment() || {};
    await this.room.message(ws, typeof message === 'string' ? message : '', code);
  }

  async webSocketClose(ws, code) {
    // finish the closing handshake; reserved codes (1005, 1006, 1015) can't be sent back
    const reply = code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1000;
    try { ws.close(reply, 'bye'); } catch {}
    await this.room.closed(ws);
  }

  async webSocketError(ws) {
    await this.room.closed(ws);
  }

  // the alarm retries waiting statistics and deletes rooms nobody has used for two weeks
  async alarm() {
    if (this.env && this.env.STATS) await this.retryStats();
    else if (await this.ctx.storage.get('pendingStats')) {
      // the binding is gone, so the writes can never be retried; drop them instead of waking up again at once
      console.error('stats: no STATS binding, dropping waiting writes');
      await this.ctx.storage.delete('pendingStats');
    }
    await this.room.load();
    if (this.room.data && !this.room.expired()) return this.scheduleAlarm();
    if (this.room.data) {
      await this.room.expire(); // an unfinished game counts as abandoned
      await this.ctx.storage.delete('room');
      this.room.data = null;
    }
    if (await this.ctx.storage.get('pendingStats')) return this.scheduleAlarm();
    await this.ctx.storage.deleteAll();
  }

  // the earlier of: room expiry, the next statistics retry (only with the STATS binding)
  async scheduleAlarm() {
    const times = [];
    const room = await this.ctx.storage.get('room');
    if (room) times.push(room.updated + ROOM_TTL_MS + 60_000);
    if (this.env && this.env.STATS) for (const e of Object.values((await this.ctx.storage.get('pendingStats')) || {})) times.push(e.at);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
  }

  // ----- statistics -----
  // writes run one after another, so an older record never lands after a newer one
  serialStats(fn) {
    const run = (this.statsChain || Promise.resolve()).then(fn);
    this.statsChain = run.catch(() => {});
    return run;
  }
  async updatePending(fn) {
    const p = (await this.ctx.storage.get('pendingStats')) || {};
    fn(p);
    if (Object.keys(p).length) await this.ctx.storage.put('pendingStats', p);
    else await this.ctx.storage.delete('pendingStats');
  }
  recordStats(rec) {
    return this.serialStats(async () => {
      const id = rec.game.id;
      try {
        await writeRecord(fromD1(this.env.STATS), rec);
        await this.updatePending(p => { delete p[id]; });
      } catch (err) {
        console.error('stats write failed', err);
        const now = Date.now();
        await this.updatePending(p => {
          const old = p[id];
          p[id] = { rec, since: old ? old.since : now, tries: old ? old.tries : 0, at: now + RETRY_FIRST_MS };
        });
        await this.scheduleAlarm();
      }
    });
  }
  retryStats() {
    return this.serialStats(async () => {
      const now = Date.now(), p = (await this.ctx.storage.get('pendingStats')) || {};
      for (const [id, e] of Object.entries(p)) {
        if (e.at > now) continue;
        try {
          await writeRecord(fromD1(this.env.STATS), e.rec);
          delete p[id];
        } catch (err) {
          if (now - e.since > RETRY_GIVE_UP_MS) { console.error('stats: giving up on game', id, err); delete p[id]; continue; }
          e.tries++;
          e.at = now + Math.min(RETRY_FIRST_MS * 2 ** e.tries, RETRY_MAX_MS);
        }
      }
      await this.updatePending(q => { for (const k of Object.keys(q)) delete q[k]; Object.assign(q, p); });
    });
  }
}

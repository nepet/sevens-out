/*
 * Option 4: Cloudflare Worker + one Durable Object per room.
 *
 *   GET /health            -> "ok"
 *   GET /room/<CODE> (WS)  -> the room's Durable Object
 *
 * The Durable Object uses the WebSocket Hibernation API, so an idle room costs nothing and survives
 * hibernation: each socket remembers its seat in its attachment, and the room data lives in storage.
 */
import { DurableObject } from 'cloudflare:workers';
import '../../engine.js';
import { Room, CODE_RE, ROOM_TTL_MS } from '../core/room.js';

const E = globalThis.SevensEngine;

function originAllowed(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length || allowed.includes('*')) return true;
  return allowed.includes(request.headers.get('Origin') || '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
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
        await ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS + 60_000);
      },
      remove: () => ctx.storage.deleteAll()
    };
    const net = {
      send: (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch {} },
      conns: () => ctx.getWebSockets().filter(ws => ws.readyState === 1),
      seatOf: ws => (ws.deserializeAttachment() || {}).seat || null,
      bind: (ws, seat) => ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), seat }),
      close: (ws, code, reason) => { try { ws.close(code, reason); } catch {} }
    };
    this.room = new Room({ engine: E, storage, net });
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

  // delete rooms nobody has used for two weeks
  async alarm() {
    await this.room.load();
    if (!this.room.data || this.room.expired()) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(this.room.data.updated + ROOM_TTL_MS + 60_000);
  }
}

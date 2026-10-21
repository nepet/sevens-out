/*
 * The owner's admin page: statistics from the stats database (D1, server/d1/schema.sql).
 *
 *   GET    /                  the page (page.html)
 *   GET    /api/stats         activity, facts, records, leaderboard   (?period=&source=&mode=&tz=)
 *   GET    /api/games         recent finished games, 20 per page       (?source=&mode=&before=)
 *   GET    /api/games/<id>    one game with its score sheet
 *   DELETE /api/games/<id>    delete a game
 *   GET    /api/usage         how the app is used: rooms, when people play, new and returning players  (?period=&source=&mode=&tz=)
 *   GET    /api/rooms         open rooms with a live look into each (?status=open), or closed rooms, 30 per page (?status=closed&before=)
 *   GET    /api/rooms/<id>    one room: its row, timeline, games and (while open) the live game
 *   POST   /api/rooms/<id>/close   close a room: every phone is sent home, an unfinished game counts as abandoned
 *   POST   /api/rooms/close-idle   close every open room nobody is connected to and nothing happened in for ?hours= (default 6)
 *
 * Live rooms come from the game Worker through the service binding GAME (its AdminApi entrypoint);
 * without it the page shows what the rooms last wrote to the database, and closing is unavailable.
 *
 * Cloudflare Access protects the whole Worker; every request is checked here as well (access.js),
 * including the signed-in email against the ADMIN_EMAIL secret. See docs/admin.md.
 */
import PAGE from './page.html';
import { accessKeys, verifyAccess } from './access.js';
import { parseFilters, stats, recentGames, gameDetail, usage, parseRoomFilters, roomList, roomDetail } from './queries.js';
import { fromD1 } from '../d1/db.js';
import { deleteGame, markRoomGone } from '../d1/write.js';

const HOUR = 3_600_000, IDLE_HOURS = 6;
// the list only wakes rooms that may be busy: someone connected, or a change within the hour (each look is a Durable Object request)
const LOOK_WITHIN = HOUR;
const mayBeBusy = row => row.connected > 0 || row.watching > 0 || Date.now() - row.activeAt < LOOK_WITHIN;

const SECURITY = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY, 'content-type': 'application/json' } });
const text = (body, status) => new Response(body, { status, headers: { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' } });

async function signIn(request, env, keys) {
  const host = new URL(request.url).hostname;
  if (env.ADMIN_DEV_NO_ACCESS === '1' && (host === '127.0.0.1' || host === 'localhost')) return null;
  const owner = (env.ADMIN_EMAIL || '').trim().toLowerCase(); // a pasted secret may end in a line break
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !owner) return text('The admin page is not set up yet. See docs/admin.md.', 500);
  let jwks;
  try { jwks = await keys(env.ACCESS_TEAM); } catch (err) { console.error('access keys', err); return text('Sign-in is unavailable. Try again in a minute.', 503); }
  const r = await verifyAccess(request.headers.get('Cf-Access-Jwt-Assertion'), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD, keys: jwks });
  if (!r.ok || !r.email || r.email.toLowerCase() !== owner) return text('Forbidden', 403);
  return null;
}

export async function handle(request, env, { keys = team => accessKeys(team) } = {}) {
  const refused = await signIn(request, env, keys);
  if (refused) return refused;
  const url = new URL(request.url), method = request.method, db = fromD1(env.STATS);
  try {
    if (url.pathname === '/' && method === 'GET') return new Response(PAGE, { headers: { ...SECURITY, 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/api/stats' && method === 'GET') return json(await stats(db, parseFilters(url.searchParams)));
    if (url.pathname === '/api/games' && method === 'GET') return json(await recentGames(db, parseFilters(url.searchParams)));
    const m = url.pathname.match(/^\/api\/games\/([0-9a-f]{16})$/);
    if (m && method === 'GET') {
      const g = await gameDetail(db, m[1]);
      return g ? json(g) : json({ error: 'not_found' }, 404);
    }
    if (m && method === 'DELETE') {
      await deleteGame(db, m[1]);
      return new Response(null, { status: 204, headers: SECURITY });
    }
    if (url.pathname === '/api/usage' && method === 'GET') return json(await usage(db, parseFilters(url.searchParams)));
    if (url.pathname === '/api/rooms' && method === 'GET') return json(await rooms(db, env, parseRoomFilters(url.searchParams)));
    if (url.pathname === '/api/rooms/close-idle' && method === 'POST') return closeIdle(db, env, url.searchParams.get('hours'));
    const r = url.pathname.match(/^\/api\/rooms\/([0-9a-f]{16})(\/close)?$/);
    if (r && !r[2] && method === 'GET') {
      const room = await roomDetail(db, r[1]);
      if (!room) return json({ error: 'not_found' }, 404);
      return json(await withLive(db, env, room, true));
    }
    if (r && r[2] && method === 'POST') return closeRoom(db, env, r[1]);
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('admin', err);
    return json({ error: 'server' }, 500);
  }
}

// ----- rooms -----
// the live room behind a row: { view } (null when the room is gone), or { error } when the game Worker can't be asked
async function look(env, row) {
  if (!env.GAME) return { error: 'no_binding' };
  try {
    const view = await env.GAME.room(row.code);
    return { view: view && (!view.id || view.id === row.id) ? view : null }; // a reused code is another room
  } catch (err) { console.error('admin room', row.code, err); return { error: 'unreachable' }; }
}
// a row merged with what the room says now; a room that has gone without closing its row gets it closed
async function withLive(db, env, row, full = false) {
  if (row.closedAt) return { ...row, live: null };
  const l = await look(env, row);
  if (l.error) return { ...row, live: null, liveError: l.error };
  if (!l.view) {
    await markRoomGone(db, row.id);
    return { ...row, closedAt: Date.now(), closeReason: 'gone', connected: 0, watching: 0, live: null };
  }
  const v = l.view, seats = v.room.seats, g = v.state && v.state.game;
  return {
    ...row, phase: v.room.phase === 'lobby' ? 'lobby' : v.state && v.state.phase === 'over' ? 'over' : 'playing',
    round: g ? g.round : null, seats: seats.length, names: seats.map(s => s.name), connected: seats.filter(s => s.connected).length,
    watching: v.watching.length, activeAt: v.updated,
    live: full ? v : { connections: v.connections }
  };
}
async function rooms(db, env, f) {
  const list = await roomList(db, f);
  if (f.status !== 'open') return list;
  const all = await Promise.all(list.rooms.map(row => (mayBeBusy(row) ? withLive(db, env, row) : { ...row, live: null })));
  return { rooms: all.filter(r => !r.closedAt), next: null, live: !all.some(r => r.liveError), binding: !!env.GAME };
}
async function closeRoom(db, env, id) {
  const [row] = await db.all('SELECT id, code, closed_at AS closedAt FROM rooms WHERE id = ?', [id]);
  if (!row) return json({ error: 'not_found' }, 404);
  if (row.closedAt) return json({ closed: 'already' });
  if (!env.GAME) return json({ error: 'no_binding' }, 503);
  let done;
  try { done = await env.GAME.close(row.code, row.id); }
  catch (err) { console.error('admin close', row.code, err); return json({ error: 'unreachable' }, 503); }
  if (!done) await markRoomGone(db, row.id);
  return json({ closed: done ? 'closed' : 'gone' });
}
// open rooms with nobody connected (no player, no spectator) and no change for `hours`: picked by their rows,
// then each one asked once more before it is closed
async function closeIdle(db, env, hoursRaw) {
  if (!env.GAME) return json({ error: 'no_binding' }, 503);
  const hours = /^\d{1,4}$/.test(hoursRaw || '') && +hoursRaw >= 1 ? +hoursRaw : IDLE_HOURS, before = Date.now() - hours * HOUR;
  const rows = (await roomList(db, { status: 'open' })).rooms.filter(r => !r.connected && !r.watching && r.activeAt < before);
  let closed = 0;
  for (const row of rows) {
    try {
      const l = await look(env, row);
      if (l.error) continue;
      if (!l.view) { await markRoomGone(db, row.id); continue; }
      if (l.view.connections || l.view.updated >= before) continue;
      if (await env.GAME.close(row.code, row.id)) closed++; else await markRoomGone(db, row.id);
    } catch (err) { console.error('admin close idle', row.code, err); }
  }
  return json({ closed, hours });
}

export default { fetch: (request, env) => handle(request, env) };

/*
 * The owner's admin page: statistics from the stats database (D1, server/d1/schema.sql).
 *
 *   GET    /                  the page (page.html)
 *   GET    /api/stats         activity, facts, records, leaderboard   (?period=&source=&mode=&tz=)
 *   GET    /api/games         recent finished games, 20 per page       (?source=&mode=&before=)
 *   GET    /api/games/<id>    one game with its score sheet
 *   DELETE /api/games/<id>    delete a game
 *
 * Cloudflare Access protects the whole Worker; every request is checked here as well (access.js),
 * including the signed-in email against the ADMIN_EMAIL secret. See docs/admin.md.
 */
import PAGE from './page.html';
import { accessKeys, verifyAccess } from './access.js';
import { parseFilters, stats, recentGames, gameDetail } from './queries.js';
import { fromD1 } from '../d1/db.js';
import { deleteGame } from '../d1/write.js';

const SECURITY = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY, 'content-type': 'application/json' } });
const text = (body, status) => new Response(body, { status, headers: { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' } });

async function signIn(request, env, keys) {
  const host = new URL(request.url).hostname;
  if (env.ADMIN_DEV_NO_ACCESS === '1' && (host === '127.0.0.1' || host === 'localhost')) return null;
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !env.ADMIN_EMAIL) return text('The admin page is not set up yet. See docs/admin.md.', 500);
  let jwks;
  try { jwks = await keys(env.ACCESS_TEAM); } catch (err) { console.error('access keys', err); return text('Sign-in is unavailable. Try again in a minute.', 503); }
  const r = await verifyAccess(request.headers.get('Cf-Access-Jwt-Assertion'), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD, keys: jwks });
  if (!r.ok || !r.email || r.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return text('Forbidden', 403);
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
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('admin', err);
    return json({ error: 'server' }, 500);
  }
}

export default { fetch: (request, env) => handle(request, env) };

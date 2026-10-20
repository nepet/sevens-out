/*
 * Every statistics query for the admin page. Each function takes the database interface from
 * server/d1/db.js ({ all, batch }) and filters from parseFilters(); values are always bound parameters.
 * Only finished games (status 'over') count, except the abandoned-games tile.
 */
const DAY = 86_400_000, ABANDONED_AFTER = 14 * DAY;
const PERIODS = { '7d': 7, '30d': 30, '12m': 365, all: null };
export const PAGE_SIZE = 20;

export function parseFilters(q, now = Date.now()) {
  const period = Object.hasOwn(PERIODS, q.get('period')) ? q.get('period') : '30d';
  const days = PERIODS[period];
  const source = ['online', 'phone'].includes(q.get('source')) ? q.get('source') : null;
  const mode = ['dice', 'score'].includes(q.get('mode')) ? q.get('mode') : null;
  const tzRaw = q.get('tz') || '';
  const tz = /^-?\d{1,3}$/.test(tzRaw) && Math.abs(+tzRaw) <= 840 ? +tzRaw : 0;
  // paging cursor "<finishedAt>_<id>", the `next` of the previous page of recentGames()
  const cursor = /^(\d{1,15})_([0-9a-f]{16})$/.exec(q.get('before') || '');
  const before = cursor ? { at: +cursor[1], id: cursor[2] } : null;
  return { period, since: days ? now - days * DAY : 0, source, mode, tz, before, now };
}

// finished games matching the filters (alias g)
function finished(f, since = f.since) {
  const sql = ["g.status = 'over'", 'g.finished_at >= ?'], params = [since];
  if (f.source) { sql.push('g.source = ?'); params.push(f.source); }
  if (f.mode) { sql.push('g.mode = ?'); params.push(f.mode); }
  return { sql: sql.join(' AND '), params };
}
const one = async (db, sql, params) => (await db.all(sql, params))[0] || {};
const orNull = v => (v === undefined ? null : v);
const record = r => (r && r.gameId ? { ...r } : null);
// one person: a signed-in player by player ID, a guest by name
const WHO = "COALESCE('u:' || p.user_id, 'n:' || p.name_key)";
const tagOf = userId => (userId ? userId.slice(0, 4) : null);

export async function stats(db, f) {
  const w = finished(f);
  const bucket = f.period === '7d' || f.period === '30d' ? 'day' : 'week';
  const local = "(g.finished_at / 1000) - ? * 60, 'unixepoch'";
  const bucketSql = bucket === 'day' ? `strftime('%Y-%m-%d', ${local})` : `date(${local}, 'weekday 0', '-6 days')`;
  const joinPlayers = 'FROM players p JOIN games g ON g.id = p.game_id';
  const joinTurns = 'FROM turns t JOIN games g ON g.id = t.game_id';
  const [totals, players, series, abandoned, turnFacts, shots, limits, spread, biggest, longest, closest, board] = await Promise.all([
    one(db, `SELECT COUNT(*) AS games, AVG(g.player_count) AS avgPlayers, AVG(g.rounds) AS avgRounds,
             AVG(CASE WHEN g.started_at IS NOT NULL THEN (g.finished_at - g.started_at) / 60000.0 END) AS avgMinutes,
             COALESCE(SUM(g.early), 0) AS early
             FROM games g WHERE ${w.sql}`, w.params),
    one(db, `SELECT COUNT(DISTINCT ${WHO}) AS n ${joinPlayers} WHERE ${w.sql}`, w.params),
    db.all(`SELECT ${bucketSql} AS bucket, SUM(g.source = 'online') AS online, SUM(g.source = 'phone') AS phone
            FROM games g WHERE ${w.sql} GROUP BY bucket ORDER BY bucket`, [f.tz, ...w.params]),
    f.source === 'phone' ? { n: 0 } : one(db,
      `SELECT COUNT(*) AS n FROM games g WHERE g.source = 'online' AND g.started_at >= ?
       AND (g.status = 'abandoned' OR (g.status = 'playing' AND g.started_at < ?))${f.mode ? ' AND g.mode = ?' : ''}`,
      [f.since, f.now - ABANDONED_AFTER, ...(f.mode ? [f.mode] : [])]),
    one(db, `SELECT COUNT(*) AS turns, COALESCE(SUM(t.pts = 0), 0) AS sevensOuts, AVG(t.pts) AS avgPoints ${joinTurns} WHERE ${w.sql}`, w.params),
    one(db, `SELECT COALESCE(SUM(p.shots), 0) AS n ${joinPlayers} WHERE ${w.sql}`, w.params),
    db.all(`SELECT t.rolls AS rolls, COUNT(*) AS n ${joinTurns} WHERE ${w.sql} AND t.starter = 1 AND t.rolls IS NOT NULL GROUP BY t.rolls`, w.params),
    db.all(`SELECT t.pts AS pts, COUNT(*) AS n ${joinTurns} WHERE ${w.sql} GROUP BY t.pts ORDER BY t.pts`, w.params),
    one(db, `SELECT t.pts AS pts, t.game_id AS gameId, p.name AS name ${joinTurns}
             JOIN players p ON p.game_id = t.game_id AND p.idx = t.idx
             WHERE ${w.sql} ORDER BY t.pts DESC, g.finished_at DESC LIMIT 1`, w.params),
    one(db, `SELECT g.rounds AS rounds, g.id AS gameId FROM games g WHERE ${w.sql} ORDER BY g.rounds DESC, g.finished_at DESC LIMIT 1`, w.params),
    one(db, `SELECT g.margin AS margin, g.id AS gameId, g.loser AS loser FROM games g WHERE ${w.sql} AND g.early = 0
             ORDER BY g.margin ASC, g.finished_at DESC LIMIT 1`, w.params),
    db.all(`SELECT ${WHO} AS who, p.user_id AS userId, p.name AS name, COUNT(*) AS games, SUM(p.lost) AS losses,
            SUM(p.sevens_outs) AS sevensOuts, SUM(p.shots) AS shots
            ${joinPlayers} WHERE ${w.sql} GROUP BY who, p.name`, w.params)
  ]);
  const limitCounts = { 1: 0, 2: 0, 3: 0 };
  for (const l of limits) if (l.rolls in limitCounts) limitCounts[l.rolls] = l.n;
  return {
    filters: { period: f.period, source: f.source, mode: f.mode },
    bucket,
    activity: {
      games: totals.games || 0, abandoned: abandoned.n || 0, players: players.n || 0,
      avgPlayers: orNull(totals.avgPlayers), avgRounds: orNull(totals.avgRounds), avgMinutes: orNull(totals.avgMinutes),
      series: series.map(s => ({ bucket: s.bucket, online: s.online, phone: s.phone }))
    },
    facts: {
      turns: turnFacts.turns || 0, sevensOuts: turnFacts.sevensOuts || 0, avgPoints: orNull(turnFacts.avgPoints),
      shots: shots.n || 0, early: totals.early || 0, limits: limitCounts,
      spread: spread.map(s => ({ pts: s.pts, n: s.n })),
      records: { biggestTurn: record(biggest), longestGame: record(longest), closestFinish: record(closest) }
    },
    leaderboard: leaderboard(board)
  };
}

// one row per person (player ID, else name), shown with its most used spelling; players carry their tag
function leaderboard(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const e = byKey.get(r.who) || { tag: tagOf(r.userId), spellings: [], games: 0, losses: 0, sevensOuts: 0, shots: 0 };
    e.spellings.push([r.name, r.games]);
    e.games += r.games; e.losses += r.losses; e.sevensOuts += r.sevensOuts; e.shots += r.shots;
    byKey.set(r.who, e);
  }
  return [...byKey.values()].map(e => ({
    name: e.spellings.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0], tag: e.tag,
    games: e.games, losses: e.losses, lossRate: e.losses / e.games, sevensOuts: e.sevensOuts, shots: e.shots
  })).sort((a, b) => b.games - a.games || (a.name < b.name ? -1 : 1) || ((a.tag || '') < (b.tag || '') ? -1 : 1));
}

export async function recentGames(db, f) {
  const w = finished(f, 0);
  const rows = await db.all(
    `SELECT g.id AS id, g.source AS source, g.mode AS mode, g.finished_at AS finishedAt, g.loser AS loser, g.early AS early, g.rounds AS rounds
     FROM games g WHERE ${w.sql}${f.before ? ' AND (g.finished_at < ? OR (g.finished_at = ? AND g.id < ?))' : ''}
     ORDER BY g.finished_at DESC, g.id DESC LIMIT ?`,
    [...w.params, ...(f.before ? [f.before.at, f.before.at, f.before.id] : []), PAGE_SIZE + 1]);
  const games = rows.slice(0, PAGE_SIZE);
  const players = games.length
    ? await db.all(`SELECT game_id AS gameId, idx, name, score, lost, user_id AS userId FROM players WHERE game_id IN (${games.map(() => '?').join(', ')}) ORDER BY idx`, games.map(g => g.id))
    : [];
  return {
    games: games.map(g => ({
      id: g.id, source: g.source, mode: g.mode, finishedAt: g.finishedAt, loser: g.loser, early: !!g.early, rounds: g.rounds,
      players: players.filter(p => p.gameId === g.id).map(p => ({ idx: p.idx, name: p.name, tag: tagOf(p.userId), score: p.score, lost: !!p.lost }))
    })),
    next: rows.length > PAGE_SIZE ? `${games[games.length - 1].finishedAt}_${games[games.length - 1].id}` : null
  };
}

export async function gameDetail(db, id) {
  const [g] = await db.all('SELECT * FROM games WHERE id = ?', [id]);
  if (!g) return null;
  const players = await db.all('SELECT idx, name, score, lost, sevens_outs AS sevensOuts, shots, user_id AS userId FROM players WHERE game_id = ? ORDER BY idx', [id]);
  return {
    id: g.id, source: g.source, mode: g.mode, status: g.status, roomCode: g.room_code, early: !!g.early,
    startedAt: g.started_at, finishedAt: g.finished_at, rounds: g.rounds, loser: g.loser,
    sheet: g.sheet ? JSON.parse(g.sheet) : null,
    players: players.map(p => ({ idx: p.idx, name: p.name, tag: tagOf(p.userId), score: p.score, lost: !!p.lost, sevensOuts: p.sevensOuts, shots: p.shots }))
  };
}

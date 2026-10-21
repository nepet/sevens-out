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

// ----- rooms (written by the rooms themselves, server/core/room.js sessionRow) -----
export const ROOMS_PAGE = 30, OPEN_MAX = 100;
const ROOM_ID_RE = /^[0-9a-f]{16}$/;
const roomOut = r => ({
  id: r.id, code: r.code, createdAt: r.created_at, activeAt: r.active_at, closedAt: r.closed_at, closeReason: r.close_reason,
  phase: r.phase, mode: r.mode, pairing: r.pairing, round: r.round, seats: r.seats, connected: r.connected, watching: r.watching,
  signedIn: r.signed_in, host: r.host, names: r.names ? JSON.parse(r.names) : [], gameId: r.game_id, firstStartAt: r.first_start_at,
  gamesStarted: r.games_started, gamesFinished: r.games_finished, connects: r.connects, rejoins: r.rejoins,
  spectators: r.spectators, chat: r.chat, peak: r.peak
});

export function parseRoomFilters(q) {
  const status = q.get('status') === 'closed' ? 'closed' : 'open';
  const cursor = /^(\d{1,15})_([0-9a-f]{16})$/.exec(q.get('before') || '');
  return { status, before: cursor ? { at: +cursor[1], id: cursor[2] } : null };
}

// open rooms, most recently active first (all of them, up to OPEN_MAX); closed rooms newest closed first, paged
export async function roomList(db, f) {
  if (f.status === 'open') {
    const rows = await db.all('SELECT * FROM rooms WHERE closed_at IS NULL ORDER BY active_at DESC, id DESC LIMIT ?', [OPEN_MAX]);
    return { rooms: rows.map(roomOut), next: null };
  }
  const rows = await db.all(
    `SELECT * FROM rooms WHERE closed_at IS NOT NULL${f.before ? ' AND (closed_at < ? OR (closed_at = ? AND id < ?))' : ''}
     ORDER BY closed_at DESC, id DESC LIMIT ?`,
    [...(f.before ? [f.before.at, f.before.at, f.before.id] : []), ROOMS_PAGE + 1]);
  const page = rows.slice(0, ROOMS_PAGE), lastRow = page[page.length - 1];
  return { rooms: page.map(roomOut), next: rows.length > ROOMS_PAGE ? `${lastRow.closed_at}_${lastRow.id}` : null };
}

export async function roomDetail(db, id) {
  if (!ROOM_ID_RE.test(id)) return null;
  const [r] = await db.all('SELECT * FROM rooms WHERE id = ?', [id]);
  if (!r) return null;
  const events = await db.all('SELECT seq, at, kind, detail FROM room_events WHERE room_id = ? ORDER BY seq', [id]);
  const games = await db.all(
    "SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, loser, rounds FROM games WHERE room_code = ? AND source = 'online' AND started_at >= ? ORDER BY started_at",
    [r.code, r.created_at]);
  return { ...roomOut(r), events: events.map(e => ({ seq: e.seq, at: e.at, kind: e.kind, detail: e.detail ? JSON.parse(e.detail) : null })), games };
}

// ----- usage: how the app is used, for the period (rooms by when they were made, games by when they finished) -----
const WEEKDAYS = 7, HOURS = 24;
export async function usage(db, f) {
  const w = finished(f);
  const local = col => `(${col} / 1000) - ? * 60, 'unixepoch'`;
  const roomsSince = f.since;
  const [funnel, rows, heat, sizes, firsts, days, accounts, turns, stops] = await Promise.all([
    one(db, `SELECT COUNT(*) AS created, SUM(seats >= 2) AS twoPlus, SUM(games_started > 0) AS started, SUM(games_finished > 0) AS finished,
             SUM(spectators > 0) AS watched, SUM(chat > 0) AS chatted, SUM(signed_in > 0) AS signedIn,
             AVG(CASE WHEN first_start_at IS NOT NULL THEN (first_start_at - created_at) / 60000.0 END) AS lobbyMinutes,
             AVG((COALESCE(closed_at, active_at) - created_at) / 60000.0) AS roomMinutes,
             AVG(games_started) AS gamesPerRoom, AVG(CASE WHEN games_started > 0 THEN rejoins * 1.0 / seats END) AS rejoinsPerSeat,
             AVG(seats) AS seats, SUM(chat) AS messages
             FROM rooms WHERE created_at >= ?`, [roomsSince]),
    db.all('SELECT close_reason AS reason, COUNT(*) AS n FROM rooms WHERE created_at >= ? AND closed_at IS NOT NULL GROUP BY close_reason', [roomsSince]),
    db.all(`SELECT CAST(strftime('%w', ${local('COALESCE(g.started_at, g.finished_at)')}) AS INTEGER) AS dow,
            CAST(strftime('%H', ${local('COALESCE(g.started_at, g.finished_at)')}) AS INTEGER) AS hour, COUNT(*) AS n
            FROM games g WHERE ${w.sql} GROUP BY dow, hour`, [f.tz, f.tz, ...w.params]),
    db.all(`SELECT g.player_count AS players, COUNT(*) AS n FROM games g WHERE ${w.sql} GROUP BY g.player_count ORDER BY g.player_count`, w.params),
    // new or returning: when each person in the period played their first finished game ever
    one(db, `SELECT COUNT(*) AS people, SUM(first >= ?) AS fresh FROM (
               SELECT ${WHO} AS who, MIN(g2.finished_at) AS first FROM players p JOIN games g2 ON g2.id = p.game_id
               WHERE g2.status = 'over' AND ${WHO} IN (SELECT DISTINCT ${WHO} FROM players p JOIN games g ON g.id = p.game_id WHERE ${w.sql})
               GROUP BY who)`, [f.since, ...w.params]),
    one(db, `SELECT COUNT(*) AS people, SUM(d >= 2) AS twoDays, SUM(n >= 5) AS fiveGames FROM (
               SELECT ${WHO} AS who, COUNT(DISTINCT strftime('%Y-%m-%d', ${local('g.finished_at')})) AS d, COUNT(*) AS n
               FROM players p JOIN games g ON g.id = p.game_id WHERE ${w.sql} GROUP BY who)`, [f.tz, ...w.params]),
    one(db, `SELECT (SELECT COUNT(*) FROM users) AS total, (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS fresh,
             (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_used_at >= ?) AS active,
             (SELECT COUNT(*) FROM passkeys) AS passkeys, (SELECT COALESCE(SUM(synced), 0) FROM passkeys) AS synced`, [f.since, f.since]),
    db.all(`SELECT t.starter AS starter, COUNT(*) AS n, AVG(t.pts) AS avg, SUM(t.pts = 0) AS zero ${'FROM turns t JOIN games g ON g.id = t.game_id'}
            WHERE ${w.sql} GROUP BY t.starter`, w.params),
    // dice games: players after the starter who stopped before the round's limit, and what that scored
    db.all(`SELECT t.rolls AS rolls, t.mark AS mark, COUNT(*) AS n, AVG(t.pts) AS avg FROM turns t JOIN games g ON g.id = t.game_id
            WHERE ${w.sql} AND g.mode = 'dice' AND t.starter = 0 AND t.rolls IS NOT NULL AND t.mark IS NOT NULL GROUP BY t.rolls, t.mark`, w.params)
  ]);
  const grid = Array.from({ length: WEEKDAYS }, () => Array(HOURS).fill(0));
  for (const h of heat) if (h.dow >= 0 && h.dow < WEEKDAYS && h.hour >= 0 && h.hour < HOURS) grid[h.dow][h.hour] = h.n;
  const closed = { empty: 0, expired: 0, admin: 0, gone: 0 };
  for (const r of rows) if (r.reason in closed) closed[r.reason] = r.n;
  const turnOf = s => { const t = turns.find(x => x.starter === s); return t ? { turns: t.n, avgPoints: t.avg, sevensOuts: t.zero } : { turns: 0, avgPoints: null, sevensOuts: 0 }; };
  const early = stops.filter(s => s.rolls < s.mark), full = stops.filter(s => s.rolls >= s.mark);
  const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
  const avgOf = xs => (sum(xs, 'n') ? xs.reduce((a, x) => a + x.avg * x.n, 0) / sum(xs, 'n') : null);
  return {
    filters: { period: f.period, source: f.source, mode: f.mode },
    rooms: {
      created: funnel.created || 0, twoPlus: funnel.twoPlus || 0, started: funnel.started || 0, finished: funnel.finished || 0,
      watched: funnel.watched || 0, chatted: funnel.chatted || 0, signedIn: funnel.signedIn || 0, messages: funnel.messages || 0,
      lobbyMinutes: orNull(funnel.lobbyMinutes), roomMinutes: orNull(funnel.roomMinutes), gamesPerRoom: orNull(funnel.gamesPerRoom),
      rejoinsPerSeat: orNull(funnel.rejoinsPerSeat), seats: orNull(funnel.seats), closed
    },
    when: grid,
    sizes: sizes.map(s => ({ players: s.players, n: s.n })),
    people: { total: firsts.people || 0, fresh: firsts.fresh || 0, twoDays: days.twoDays || 0, fiveGames: days.fiveGames || 0 },
    accounts: { total: accounts.total || 0, fresh: accounts.fresh || 0, active: accounts.active || 0, passkeys: accounts.passkeys || 0, synced: accounts.synced || 0 },
    turns: { starter: turnOf(1), others: turnOf(0) },
    stops: { early: sum(early, 'n'), full: sum(full, 'n'), earlyAvg: avgOf(early), fullAvg: avgOf(full) }
  };
}

/*
 * Game statistics, independent of where they run (no runtime code, like room.js).
 *
 *   summarize(state, meta) -> { game, players, turns }
 *     rows for the stats database (server/d1/schema.sql) from an engine state;
 *     meta = { id, source: 'online'|'phone', roomCode?, startedAt?, finishedAt?, status: 'playing'|'over'|'abandoned' }
 *
 *   checkReport(report, engine, now) -> { ok: true, state } | { error }
 *     validates a finished one-phone game sent by the page and rebuilds it with the engine's own
 *     helpers, ready for summarize (the loser is computed here, never trusted)
 */

export const GAME_ID_RE = /^[0-9a-f]{16}$/;
export const MAX_REPORT_BYTES = 16 * 1024;

export const nameKey = name => String(name).replace(/\s+/g, ' ').trim().toLowerCase();

export function sheetOf(g) {
  return {
    players: g.players.map(p => p.name),
    rounds: g.rounds.map(rd => ({ no: rd.no, starter: rd.starter, mark: rd.mark ?? null, results: rd.results })),
    shots: (g.shots || []).map(s => ({ player: s.player, round: s.round })),
    early: !!g.early
  };
}

export function summarize(state, { id, source, roomCode = null, startedAt = null, finishedAt = null, status }) {
  const g = state.game, n = g.players.length;
  const game = {
    id, source, mode: g.mode === 'score' ? 'score' : 'dice', room_code: roomCode, status, early: 0,
    started_at: startedAt, finished_at: null, rounds: null, player_count: n,
    loser: null, top_score: null, margin: null, sheet: null
  };
  if (status !== 'over') return { game, players: [], turns: [] };

  const turns = [], per = g.players.map(() => ({ turns: 0, sevens: 0, shots: 0 }));
  for (const rd of g.rounds) {
    for (const [k, r] of Object.entries(rd.results)) {
      const idx = +k;
      turns.push({ game_id: id, round: rd.no, idx, pts: r.pts, rolls: r.rolls ?? null, starter: idx === rd.starter ? 1 : 0, mark: rd.mark ?? null });
      per[idx].turns++;
      if (r.pts === 0) per[idx].sevens++;
    }
  }
  for (const s of g.shots || []) if (per[s.player]) per[s.player].shots++;
  const sorted = g.players.map(p => p.score).sort((a, b) => b - a);
  Object.assign(game, {
    early: g.early ? 1 : 0,
    finished_at: finishedAt,
    rounds: g.rounds.filter(rd => Object.keys(rd.results).length).length,
    loser: g.players[g.loser] ? g.players[g.loser].name : null,
    top_score: sorted[0],
    margin: sorted[0] - sorted[1],
    sheet: JSON.stringify(sheetOf(g))
  });
  const players = g.players.map((p, i) => ({
    game_id: id, idx: i, name: p.name, name_key: nameKey(p.name), score: p.score,
    lost: i === g.loser ? 1 : 0, sevens_outs: per[i].sevens, shots: per[i].shots, turns: per[i].turns
  }));
  return { game, players, turns };
}

const MAX_ROUNDS = 300, MAX_SHOTS = 200;
const MAX_GAME_MS = 14 * 24 * 60 * 60 * 1000, CLOCK_SLACK_MS = 10 * 60 * 1000;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);

// Scoreboard games skip the starter and "ended at the first 101" checks: corrections and undo
// can change past rounds after their starters were chosen (see the admin stats plan, "Deviations").
export function checkReport(r, E, now = Date.now()) {
  const bad = error => ({ error });
  if (!isObj(r)) return bad('report');
  if (typeof r.id !== 'string' || !GAME_ID_RE.test(r.id)) return bad('id');
  if (r.mode !== 'dice' && r.mode !== 'score') return bad('mode');
  if (!isInt(r.finishedAt, 1, now + CLOCK_SLACK_MS)) return bad('finishedAt');
  if (r.startedAt !== null && !isInt(r.startedAt, r.finishedAt - MAX_GAME_MS, r.finishedAt)) return bad('startedAt');
  const sh = r.sheet;
  if (!isObj(sh) || !Array.isArray(sh.players) || !Array.isArray(sh.rounds) || !Array.isArray(sh.shots)) return bad('sheet');
  const n = sh.players.length;
  if (n < 2 || n > E.MAX_PLAYERS) return bad('players');
  if (sh.players.some(nm => typeof nm !== 'string')) return bad('names');
  const names = sh.players.map(cleanName);
  if (names.some(nm => !nm)) return bad('names');
  if (sh.rounds.length < 1 || sh.rounds.length > MAX_ROUNDS) return bad('rounds');
  if (sh.shots.length > MAX_SHOTS) return bad('shots');
  const dice = r.mode === 'dice', early = sh.early === true;
  const top = g => Math.max(...g.players.map(p => p.score));

  // rebuild the game round by round; the engine's own helpers decide starters and the loser
  const g = { mode: r.mode, players: names.map(name => ({ name, score: 0 })), rounds: [], starter: 0, order: [], shots: [], early, loser: null };
  for (let ri = 0; ri < sh.rounds.length; ri++) {
    const rd = sh.rounds[ri], no = ri + 1, last = ri === sh.rounds.length - 1;
    if (!isObj(rd) || rd.no !== no || !isInt(rd.starter, 0, n - 1) || !isObj(rd.results)) return bad(`round ${no}`);
    if (dice && ri > 0 && rd.starter !== E.nextStarter(g)) return bad(`round ${no}: wrong starter`);
    const order = E.orderFrom(rd.starter, n);
    const firstMissing = order.findIndex(p => !has(rd.results, p));
    const count = firstMissing < 0 ? n : firstMissing;
    if (Object.keys(rd.results).length !== count) return bad(`round ${no}: turns out of order`);
    if (count < n && !(last && early)) return bad(`round ${no}: incomplete`);
    const mark = count ? (isObj(rd.results[rd.starter]) ? rd.results[rd.starter].rolls : null) : null;
    if (count && (!isInt(mark, 1, E.MAX_ROLLS) || rd.mark !== mark)) return bad(`round ${no}: roll limit`);
    const results = {};
    for (const p of order.slice(0, count)) {
      const t = rd.results[p];
      if (!isObj(t) || !isInt(t.pts, 0, E.MAX_PIPS)) return bad(`round ${no}: points`);
      if (p !== rd.starter && (dice ? !isInt(t.rolls, 1, mark) : t.rolls !== null)) return bad(`round ${no}: rolls`);
      results[p] = { pts: t.pts, rolls: p === rd.starter ? mark : t.rolls };
      g.players[p].score += t.pts;
    }
    g.rounds.push({ no, starter: rd.starter, mark, results });
    g.starter = rd.starter;
    g.order = order;
    if (dice && !early && !last && top(g) >= E.LIMIT) return bad(`round ${no}: the game should have ended`);
  }
  if (!early && top(g) < E.LIMIT) return bad('nobody reached 101');
  for (const s of sh.shots) {
    if (!isObj(s) || !isInt(s.player, 0, n - 1) || !isInt(s.round, 1, g.rounds.length)) return bad('shots');
    g.shots.push({ player: s.player, round: s.round });
  }
  g.loser = E.highestLater(g);
  return { ok: true, state: { phase: 'over', game: g } };
}

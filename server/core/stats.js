/*
 * Game statistics, independent of where they run (no runtime code, like room.js).
 *
 *   summarize(state, meta) -> { game, players, turns }
 *     rows for the stats database (server/d1/schema.sql) from an engine state, for every game (games.kind);
 *     meta = { id, source: 'online'|'phone', roomCode?, startedAt?, finishedAt?, status: 'playing'|'over'|'abandoned',
 *             users?: [playerId|null per player] }   signed-in players' IDs (server/core/accounts.js)
 *
 *   checkReport(report, engine, now) -> { ok: true, state } | { error }
 *     validates a finished one-phone game sent by the page and rebuilds it with the engine's own
 *     helpers, ready for summarize (the loser is computed here, never trusted); report.kind picks the game
 *     ('4218', 'schocken'; missing = Sevens Out)
 */

export const GAME_ID_RE = /^[0-9a-f]{16}$/;
export const MAX_REPORT_BYTES = 32 * 1024; // room for a long, low-scoring game of 12

export const KINDS = ['sevens', '4218', 'schocken'];
export const kindOf = g => (KINDS.includes(g.kind) ? g.kind : 'sevens');
// a turn with the game's top throw, counted per player (players.sevens_outs): Sevens Out clears all six dice (0 points),
// 42/18 is 18 points, a Schock out is worth all 13 coasters
const TOP = { sevens: r => r.pts === 0, '4218': r => r.pts === 18, schocken: r => r.pts === 13 };

export const nameKey = name => String(name).replace(/\s+/g, ' ').trim().toLowerCase();

export function sheetOf(g) {
  return {
    players: g.players.map(p => p.name),
    // 42/18 and Schocken: the round's loser; Schocken: the half it belongs to (3 = the final)
    rounds: g.rounds.map(rd => ({ no: rd.no, starter: rd.starter, mark: rd.mark ?? null, results: rd.results,
      ...(rd.loser != null ? { loser: rd.loser } : {}), ...(rd.half ? { half: rd.half } : {}) })),
    shots: (g.shots || []).map(s => ({ player: s.player, round: s.round })),
    early: !!g.early
  };
}

export function summarize(state, { id, source, roomCode = null, startedAt = null, finishedAt = null, status, users = [] }) {
  const g = state.game, n = g.players.length, kind = kindOf(g), isTop = TOP[kind];
  const game = {
    id, source, kind, mode: g.mode === 'score' ? 'score' : 'dice', room_code: roomCode, status, early: 0,
    started_at: startedAt, finished_at: null, rounds: null, player_count: n,
    loser: null, top_score: null, margin: null, sheet: null
  };
  if (status !== 'over') return { game, players: [], turns: [] };

  const turns = [], per = g.players.map(() => ({ turns: 0, sevens: 0, shots: 0 }));
  for (const rd of g.rounds) {
    for (const [k, r] of Object.entries(rd.results)) {
      const idx = +k;
      if (r.pts == null) continue; // Schocken: a blind cup that never came up (the game ended early)
      turns.push({ game_id: id, round: rd.no, idx, pts: r.pts, rolls: r.rolls ?? null, starter: idx === rd.starter ? 1 : 0, mark: rd.mark ?? null });
      per[idx].turns++;
      if (isTop(r)) per[idx].sevens++;
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
    lost: i === g.loser ? 1 : 0, sevens_outs: per[i].sevens, shots: per[i].shots, turns: per[i].turns, user_id: users[i] || null
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
  const kind = r.kind === undefined ? 'sevens' : r.kind;
  if (!KINDS.includes(kind)) return bad('kind');
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
  const rebuild = kind === '4218' ? rebuildFT : kind === 'schocken' ? rebuildSK : rebuildSevens;
  const g = rebuild(E, sh.rounds, { mode: r.mode, players: names.map(name => ({ name, score: 0 })), rounds: [], starter: 0, order: [], shots: [], early: sh.early === true, loser: null });
  if (g.error) return g;
  for (const s of sh.shots) {
    if (!isObj(s) || !isInt(s.player, 0, n - 1) || !isInt(s.round, 1, g.rounds.length)) return bad('shots');
    g.shots.push({ player: s.player, round: s.round });
  }
  return { ok: true, state: { phase: 'over', game: g } };
}

// the turns booked in a round: a prefix of its playing order (the rest only when the game ended in it)
function booked(rd, order) {
  const firstMissing = order.findIndex(p => !has(rd.results, p));
  const count = firstMissing < 0 ? order.length : firstMissing;
  return Object.keys(rd.results).length === count ? count : -1;
}
const isRound = (rd, no, n) => isObj(rd) && rd.no === no && isInt(rd.starter, 0, n - 1) && isObj(rd.results);
const highest = g => Math.max(...g.players.map(p => p.score));

// Sevens Out: the engine's own helpers decide starters and the loser
function rebuildSevens(E, rounds, g) {
  const bad = error => ({ error }), n = g.players.length, dice = g.mode === 'dice', early = g.early;
  for (let ri = 0; ri < rounds.length; ri++) {
    const rd = rounds[ri], no = ri + 1, last = ri === rounds.length - 1;
    if (!isRound(rd, no, n)) return bad(`round ${no}`);
    if (dice && ri > 0 && rd.starter !== E.nextStarter(g)) return bad(`round ${no}: wrong starter`);
    const order = E.orderFrom(rd.starter, n), count = booked(rd, order);
    if (count < 0) return bad(`round ${no}: turns out of order`);
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
    if (dice && !early && !last && highest(g) >= E.LIMIT) return bad(`round ${no}: the game should have ended`);
  }
  if (!early && highest(g) < E.LIMIT) return bad('nobody reached 101');
  g.loser = E.highestLater(g);
  return g;
}

// 42/18: the lowest throw of a round takes a coaster and starts the next; a 42/18 puts the player out, and the last
// player left loses at once. Scoreboard games may start a round with another player (a correction changes the round's
// loser afterwards) and go on past 3 coasters (a correction mid-round); who is out can't be corrected.
function rebuildFT(E, rounds, g) {
  const bad = error => ({ error }), n = g.players.length, dice = g.mode === 'dice', early = g.early;
  g.kind = E.FT;
  let over = false, lastLoser = null;
  for (let ri = 0; ri < rounds.length; ri++) {
    const rd = rounds[ri], no = ri + 1, last = ri === rounds.length - 1;
    if (over) return bad(`round ${no}: the game should have ended`);
    if (!isRound(rd, no, n)) return bad(`round ${no}`);
    const plays = E.ftPlays(g, no);
    if (!plays.includes(rd.starter)) return bad(`round ${no}: wrong starter`);
    if (dice && ri > 0 && rd.starter !== lastLoser) return bad(`round ${no}: wrong starter`);
    const order = E.orderFrom(rd.starter, n).filter(i => plays.includes(i)), count = booked(rd, order);
    if (count < 0) return bad(`round ${no}: turns out of order`);
    const results = {}, round = { no, starter: rd.starter, mark: null, results };
    g.rounds.push(round); g.starter = rd.starter; g.order = order;
    for (let k = 0; k < count; k++) {
      const p = order[k], t = rd.results[p];
      if (!isObj(t) || !(t.pts === 0 || isInt(t.pts, E.FT_MIN, E.FT_MAX))) return bad(`round ${no}: points`);
      if (!isInt(t.rolls, 1, E.FT_ROLLS)) return bad(`round ${no}: rolls`);
      results[p] = { pts: t.pts, rolls: t.rolls };
      if (t.pts === E.FT_MAX) g.players[p].out = no;
      const left = E.ftLeft(g);
      if (left.length === 1) { // everyone else is out: the game ends with this turn
        if (!last || k !== count - 1 || early) return bad(`round ${no}: the game should have ended`);
        g.left = true; g.loser = left[0]; over = true;
      }
    }
    if (over) continue;
    if (count < order.length) {
      if (!(last && early)) return bad(`round ${no}: incomplete`);
      continue;
    }
    lastLoser = round.loser = E.roundLoser(round, n);
    g.players[lastLoser].score++;
    if (dice && !early && !last && highest(g) >= E.COASTERS) return bad(`round ${no}: the game should have ended`);
  }
  if (g.left) return g;
  if (early) g.loser = E.highestLater(g, E.ftLeft(g));
  else if (highest(g) < E.COASTERS) return bad('nobody has 3 coasters');
  else g.loser = E.ftGameLoser(g, lastLoser);
  return g;
}

// Schocken: the round's lowest throw takes as many coasters as the highest is worth, from the pot while it has some,
// then from the highest; whoever holds all 13 loses the half, and two halves (or a final) decide the game. The round's
// loser starts the next. There are no corrections, so both modes follow every rule; a General or a Straight "from
// the hand" is taken on trust, as with real dice.
function rebuildSK(E, rounds, g) {
  const bad = error => ({ error }), n = g.players.length, early = g.early, POT = E.SK_POT;
  Object.assign(g, { kind: E.SK, half: 1, pot: POT, halves: [] });
  let over = false, starter = isRound(rounds[0], 1, n) ? rounds[0].starter : 0;
  const orderOf = s => { const inn = E.skInPlay(g); return E.orderFrom(s, n).filter(i => inn.includes(i)); };
  for (let ri = 0; ri < rounds.length; ri++) {
    const rd = rounds[ri], no = ri + 1, last = ri === rounds.length - 1;
    if (over) return bad(`round ${no}: the game should have ended`);
    if (!isRound(rd, no, n)) return bad(`round ${no}`);
    if (rd.starter !== starter) return bad(`round ${no}: wrong starter`);
    const order = orderOf(starter), count = booked(rd, order);
    if (count < 0) return bad(`round ${no}: turns out of order`);
    if (count < order.length && !(last && early)) return bad(`round ${no}: incomplete`);
    const results = {}, round = { no, starter, half: g.half, mark: null, results };
    g.rounds.push(round); g.starter = starter; g.order = order;
    let down = false; // a blind cup that never came up: only when the game ended early in this round
    for (let k = 0; k < count; k++) {
      const p = order[k], t = rd.results[p];
      if (!isObj(t) || !isInt(t.rolls, 1, k === 0 ? E.MAX_ROLLS : round.mark)) return bad(`round ${no}: rolls`);
      if (k === 0) round.mark = t.rolls;
      const blind = t.blind === true;
      if (t.dice == null) {
        if (!blind || !(last && early)) return bad(`round ${no}: dice`);
        results[p] = { dice: null, hand: null, rolls: t.rolls, blind: true };
        down = true;
        continue;
      }
      if (!Array.isArray(t.dice) || t.dice.length !== E.SK_DICE || !t.dice.every(v => isInt(v, 1, 6))) return bad(`round ${no}: dice`);
      const dice = t.dice.slice().sort((x, y) => y - x), hand = t.rolls === 1 || t.hand === true;
      results[p] = { dice, hand, rolls: t.rolls, pts: E.skThrow(dice, hand).worth, ...(blind ? { blind: true } : {}) };
    }
    if (count < order.length || down) continue;
    // the cups come up: the lowest throw takes coasters (doubled when the highest or the lowest was blind)
    const { high: H, low: L } = E.skExtremes(round, order), best = E.skThrow(results[H].dice, results[H].hand);
    const worth = best.worth * (results[H].blind || results[L].blind ? 2 : 1), pl = g.players;
    let take, from;
    if (best.cat === 'out') { take = POT - pl[L].score; from = 'all'; pl.forEach(x => { x.score = 0; }); g.pot = 0; pl[L].score = POT; }
    else if (g.pot > 0) { take = Math.min(worth, g.pot); from = 'pot'; g.pot -= take; pl[L].score += take; }
    else { take = Math.min(worth, pl[H].score); from = 'player'; pl[H].score -= take; pl[L].score += take; }
    Object.assign(round, { loser: L, high: H, take, from, pot: g.pot, after: pl.map(x => x.score) });
    starter = L;
    if (pl[L].score < POT) continue;
    round.halfLost = L; g.halves.push(L);
    const h = g.halves;
    if (h.length === 3 || (h.length === 2 && h[0] === h[1])) { g.loser = L; over = true; continue; }
    g.half++; g.pot = POT; pl.forEach(x => { x.score = 0; });
  }
  if (over) return early ? bad('ended early after the end') : g;
  if (!early) return bad('unfinished');
  // ended early: between rounds the engine has already drawn up the next round's order
  const fin = g.rounds[g.rounds.length - 1];
  if (fin.loser != null) g.order = orderOf(starter);
  g.loser = highest(g) > 0 || !g.halves.length ? E.highestLater(g) : g.halves[g.halves.length - 1];
  return g;
}

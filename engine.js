/*
 * Sevens Out rules engine, for the three games: Sevens Out (the default), 42/18 (game.kind '4218') and Schocken
 * (game.kind 'schocken').
 *
 * Pure game logic: no DOM, no storage, no network. The same file runs
 *   - in the page, loaded with a classic <script src="engine.js">, and
 *   - on the servers (Cloudflare Worker and Node), loaded with `import './engine.js'`.
 * Both read it from globalThis.SevensEngine.
 *
 * The one entry point for changing a game is apply(state, action) -> { state, events } or { error }.
 * It never mutates its input. See CLAUDE.md for the rules and the action list.
 */
(function (root) {
  'use strict';

  const MAX_ROLLS = 3, LIMIT = 101, DICE = 6, MAX_PLAYERS = 12, MAX_PIPS = 36, HISTORY = 40;

  const clone = o => JSON.parse(JSON.stringify(o));
  const orderFrom = (s, n) => Array.from({ length: n }, (_, k) => (s + k) % n);
  const isScore = g => !!g && g.mode === 'score';
  // dice games where the player finds and sets aside the 7-pairs by hand (games saved before this existed paired automatically)
  const byHand = g => !!g && !isScore(g) && g.pairing === 'manual';

  // fair die from crypto (rejection sampling keeps 1..6 uniform)
  function rnd6() {
    const c = root.crypto;
    if (c && c.getRandomValues) {
      const b = new Uint8Array(1);
      for (;;) { c.getRandomValues(b); if (b[0] < 252) return b[0] % 6 + 1; }
    }
    return Math.floor(Math.random() * 6) + 1;
  }

  // ---------- read-only helpers (also used by the page) ----------
  const active = t => t.dice.filter(d => d.held === null);
  const sumActive = t => active(t).reduce((s, d) => s + (d.value || 0), 0);
  function maxPairs(t) {
    const c = [0, 0, 0, 0, 0, 0, 0];
    active(t).forEach(d => { if (d.value) c[d.value]++; });
    return Math.min(c[1], c[6]) + Math.min(c[2], c[5]) + Math.min(c[3], c[4]);
  }
  // what is added to the score if the player stops now (all remaining 7-pairs come out first)
  const finalPenalty = t => sumActive(t) - 7 * maxPairs(t);
  function pairable(t) {
    const act = active(t).filter(d => d.value);
    const s = new Set();
    act.forEach(d => { if (act.some(e => e.value + d.value === 7)) s.add(d.id); });
    return s;
  }
  const canRoll = t => t.rolls < t.maxRolls && active(t).length > 0;
  function matchPairs(t) {
    const act = active(t).filter(d => d.value), used = new Set(), out = [];
    for (const d of act) {
      if (used.has(d.id)) continue;
      const m = act.find(e => !used.has(e.id) && e.id !== d.id && e.value + d.value === 7);
      if (m) { used.add(d.id); used.add(m.id); out.push([d.id, m.id]); }
    }
    return out;
  }
  const current = g => g.order[g.pos];

  // replay the score sheet in playing order: when did each player arrive at their current score?
  // a turn that adds 0 doesn't change the score, so it doesn't count as reaching it again
  function reachedAt(g) {
    const n = g.players.length, at = Array(n).fill(-1);
    let seq = 0;
    for (const rd of g.rounds) {
      for (const p of orderFrom(rd.starter, n)) {
        const r = rd.results[p]; if (!r) continue;
        seq++;
        if (r.pts > 0) at[p] = seq;
      }
    }
    return at;
  }
  // highest score starts; on a tie, whoever reached that score first; if they got there at the
  // same moment (nobody has scored yet), the next of them after the last starter
  function tiedForStart(g) {
    const max = Math.max(...g.players.map(p => p.score));
    const tied = g.players.map((_, i) => i).filter(i => g.players[i].score === max);
    const at = reachedAt(g), first = Math.min(...tied.map(i => at[i]));
    return { max, tied, early: tied.filter(i => at[i] === first) };
  }
  function nextStarter(g) {
    const n = g.players.length, { early } = tiedForStart(g);
    if (early.length === 1) return early[0];
    for (let k = 1; k <= n; k++) { const i = (g.starter + k) % n; if (early.includes(i)) return i; }
    return early[0];
  }
  // what the round just finished did: totals before/after, points, its best moment and why the next
  // round starts as it does. Built from the score sheet and g.shots only; the finished round is the
  // one before the last (the engine starts the next round in the same action that books the last turn)
  function roundRecap(g) {
    if (isFT(g)) return ftRecap(g);
    if (isSK(g)) return skRecap(g);
    if (g.rounds.length < 2) return null;
    const n = g.players.length, fin = g.rounds.length - 2, rd = g.rounds[fin];
    const order = orderFrom(rd.starter, n);
    const pts = Array.from({ length: n }, (_, i) => (rd.results[i] ? rd.results[i].pts : 0));
    const after = Array(n).fill(0);
    for (let k = 0; k <= fin; k++) for (let i = 0; i < n; i++) if (g.rounds[k].results[i]) after[i] += g.rounds[k].results[i].pts;
    const before = after.map((a, i) => a - pts[i]);
    const first = f => order.find(f);
    const booked = i => !!rd.results[i];
    const topAfter = Math.max(...after), topBefore = Math.max(...before);
    const alone = after.filter(a => a === topAfter).length === 1;
    const danger = LIMIT - 15, ouch = 20, big = Math.max(...pts);
    let best = null;
    const pick = (kind, player, value = null) => { if (player !== undefined) best = { kind, player, value }; return player !== undefined; };
    pick('firstRoll', first(i => booked(i) && pts[i] === 0 && rd.results[i].rolls === 1)) ||
    pick('sevensOut', first(i => booked(i) && pts[i] === 0)) ||
    pick('shots', first(i => (g.shots || []).some(x => x.player === i && x.round === rd.no))) ||
    (alone && pick('newTop', first(i => after[i] === topAfter && before[i] !== topBefore))) ||
    (() => { const p = first(i => before[i] < danger && after[i] >= danger); return pick('danger', p, p === undefined ? null : LIMIT - after[p]); })() ||
    (big >= ouch && pick('ouch', first(i => pts[i] === big), big));
    const t = tiedForStart({ players: after.map(score => ({ score })), rounds: g.rounds.slice(0, fin + 1), starter: rd.starter });
    const reason = { kind: t.tied.length === 1 ? 'highest' : t.early.length === 1 ? 'first' : 'turn', score: t.max };
    return { round: rd.no, next: g.rounds[fin + 1].starter, order, pts, before, after, best, reason };
  }
  // the highest score loses; on a tie the player later in this round's order loses (only `among` can: 42/18 skips who is out)
  function highestLater(g, among = g.order) {
    let L = null;
    for (const i of g.order) if (among.includes(i) && (L === null || g.players[i].score >= g.players[L].score)) L = i;
    return L;
  }

  // ---------- 42/18 (Zweiundvierzig-Achtzehn), the second game ----------
  // Five dice; after each roll the player keeps at least one die and may roll the rest again, as long as dice are left
  // (so at most five rolls, FT_ROLLS), or stop. A throw counts
  // when it holds a 4 and a 2 (the 42): the other three dice are its points, 3 to 18 (42/18, three 6s, is the best).
  // Without a 4 and a 2 it is "no 42" (0 points), the worst. The lowest throw loses the round and takes a coaster
  // (a tie: more rolls lose, then the later player); the round's loser starts the next one. The first to COASTERS loses.
  // A player's `score` is their coasters, so higher is worse in both games.
  // Whoever throws 42/18 is out at once: safe for the rest of the game (`players[i].out`, the round it was thrown in);
  // the others play on without them, and the last player left loses.
  const FT = '4218', FT_DICE = 5, FT_ROLLS = FT_DICE, COASTERS = 3, FT_MIN = 3, FT_MAX = 18;
  const isFT = g => !!g && g.kind === FT;
  const ftPts = v => v === 0 || intIn(v, FT_MIN, FT_MAX);
  // the points of a throw: the three dice besides a 4 and a 2, or 0 without them
  function throwPts(values) {
    const v = values.slice(), a = v.indexOf(4);
    if (a < 0) return 0;
    v.splice(a, 1);
    const b = v.indexOf(2);
    if (b < 0) return 0;
    v.splice(b, 1);
    return v.reduce((s, x) => s + (x || 0), 0);
  }
  // who plays round `no`: everyone not out before it (a player out in this round played in it)
  const ftPlays = (g, no) => g.players.map((_, i) => i).filter(i => g.players[i].out == null || g.players[i].out >= no);
  const ftOrder = (g, starter, no) => { const inn = ftPlays(g, no); return orderFrom(starter, g.players.length).filter(i => inn.includes(i)); };
  const ftDone = (g, rd) => Object.keys(rd.results).length === ftPlays(g, rd.no).length;
  const ftLeft = g => g.players.map((_, i) => i).filter(i => g.players[i].out == null);
  // the dice show 42/18: the roll that shows it ends the turn (the player is out); a game saved before that can only end it
  const ftPerfect = t => t.rolls > 0 && throwPts(t.dice.map(d => d.value)) === FT_MAX;
  // the round's loser: the lowest throw; on a tie the one who needed more rolls, then the later player in the round's order
  function roundLoser(rd, n) {
    let L = null;
    for (const p of orderFrom(rd.starter, n)) {
      const r = rd.results[p];
      if (!r) continue;
      const l = L === null ? null : rd.results[L];
      if (!l || r.pts < l.pts || (r.pts === l.pts && (r.rolls || 0) >= (l.rolls || 0))) L = p;
    }
    return L;
  }
  // most coasters loses; normally the player who just took the last one, else (ended early, corrections) as in Sevens Out
  function ftGameLoser(g, last) {
    const max = Math.max(...g.players.map(p => p.score));
    return last != null && g.players[last].score === max ? last : highestLater(g, ftLeft(g));
  }
  // what the round just finished did, in the shape of roundRecap (the totals are coasters: the loser's goes up by one);
  // results: the round's throws, reason: why the loser lost (and so starts)
  function ftRecap(g) {
    if (g.rounds.length < 2) return null;
    const n = g.players.length, fin = g.rounds.length - 2, rd = g.rounds[fin];
    const order = orderFrom(rd.starter, n), L = rd.loser != null ? rd.loser : roundLoser(rd, n);
    const after = Array(n).fill(0);
    for (let k = 0; k <= fin; k++) {
      const r = g.rounds[k];
      if (ftDone(g, r)) after[r.loser != null ? r.loser : roundLoser(r, n)]++;
    }
    const pts = after.map((_, i) => (i === L ? 1 : 0)), before = after.map((a, i) => a - pts[i]);
    const res = rd.results, low = res[L];
    const first = f => order.find(f);
    let best = null;
    const pick = (kind, player, value = null) => { if (player !== undefined) best = { kind, player, value }; return player !== undefined; };
    pick('perfect', first(i => res[i] && res[i].pts === FT_MAX)) ||
    pick('shots', first(i => (g.shots || []).some(x => x.player === i && x.round === rd.no))) ||
    (after[L] === COASTERS - 1 && pick('lastCoaster', L, after[L])) ||
    (low.pts === 0 && pick('no42', L));
    const tied = order.filter(i => res[i] && res[i].pts === low.pts);
    const others = tied.filter(i => i !== L);
    const reason = { kind: !others.length ? 'low' : others.every(i => (res[i].rolls || 0) < (low.rolls || 0)) ? 'rolls' : 'later', score: low.pts };
    return { round: rd.no, next: g.rounds[fin + 1].starter, order, pts, before, after, best, reason, results: res, kind: FT };
  }

  // ---------- Schocken, the third game ----------
  // Three dice, up to three rolls; the round's starter sets the limit for everyone else (as in Sevens Out). After each
  // roll the player sets aside any dice (setting none aside is fine) and rolls the rest, or stops. Two 6s from the same
  // roll may be turned into one 1 (three 6s into two 1s): the other 6 goes back into the cup, so the player rolls again.
  // Throws, best first: Schock out (1-1-1, all the coasters), Schock 6 to 2 (1-1-x, x coasters), General (three of a kind,
  // 3), Straight (three in a row, 2), then any other throw (1), read as a number from the highest die (665 down to 221).
  // A General or a Straight counts only from one roll ("from the hand": nothing set aside, nothing turned), else it's a
  // number. A tie: fewer rolls win, then the earlier player. Blind: instead of rolling, the player may roll blind; the cup
  // stays down until the round ends and the turn ends (the dice are rolled when the round's cups come up, which is the
  // same chance as rolling them earlier, and keeps the secret off every phone). When the round's highest or lowest throw
  // was blind, its coasters double.
  // The round's lowest throw takes coasters, as many as the highest throw is worth: from the pot (13 coasters) while it
  // has some, then from the player with the highest throw. Once the pot is empty, players without coasters are out of
  // the half. Whoever holds all 13 loses the half. Two halves; two different losers play a final. The round's loser
  // starts the next round. A player's `score` is their coasters in the current half.
  const SK = 'schocken', SK_DICE = 3, SK_POT = 13;
  const isSK = g => !!g && g.kind === SK;
  // a throw: its category, its rank (higher is better) and what it is worth in coasters; dice are three values 1..6
  function skThrow(dice, hand) {
    const [a, b, c] = dice.slice().sort((x, y) => y - x);
    if (a === 1) return { cat: 'out', value: 1, dice: [a, b, c], rank: 4000, worth: SK_POT };
    if (b === 1 && c === 1) return { cat: 'schock', value: a, dice: [a, b, c], rank: 3000 + a, worth: a };
    if (hand && a === b && b === c) return { cat: 'general', value: a, dice: [a, b, c], rank: 2000 + a, worth: 3 };
    if (hand && a === b + 1 && b === c + 1) return { cat: 'straight', value: a, dice: [a, b, c], rank: 1000 + a, worth: 2 };
    return { cat: 'number', value: a * 100 + b * 10 + c, dice: [a, b, c], rank: a * 100 + b * 10 + c, worth: 1 };
  }
  const skOf = r => (r && r.dice ? skThrow(r.dice, r.hand) : null);
  // is result a (at place ia in the round's order) better than b (at ib)? Higher rank, then fewer rolls, then earlier
  function skBetter(a, ia, b, ib) {
    const x = skOf(a).rank, y = skOf(b).rank;
    if (x !== y) return x > y;
    if ((a.rolls || 0) !== (b.rolls || 0)) return (a.rolls || 0) < (b.rolls || 0);
    return ia < ib;
  }
  // the highest and the lowest of the round's revealed throws so far (blind ones are still under the cup)
  function skExtremes(rd, order) {
    let high = null, low = null;
    order.forEach((p, k) => {
      const r = rd.results[p];
      if (!r || !r.dice) return;
      if (high === null || skBetter(r, k, rd.results[order[high]], high)) high = k;
      if (low === null || !skBetter(r, k, rd.results[order[low]], low)) low = k;
    });
    return { high: high === null ? null : order[high], low: low === null ? null : order[low] };
  }
  // who plays in the current half: the two losers in the final; once the pot is empty only those holding coasters
  function skInPlay(g) {
    const all = g.players.map((_, i) => i);
    if (g.half === 3) return all.filter(i => g.halves.includes(i));
    return g.pot > 0 ? all : all.filter(i => g.players[i].score > 0);
  }
  const skOrder = (g, starter) => { const inn = skInPlay(g); return orderFrom(starter, g.players.length).filter(i => inn.includes(i)); };
  // the dice on the turn as a throw: from the hand when all three came from the same roll and none was turned
  const skHand = t => !t.dice.some(d => d.flipped) && t.dice.every(d => d.from === t.dice[0].from);
  // two 6s from this roll may be turned into a 1 (not on the last roll: the other 6 must be rolled again)
  // (a 6 set aside in this roll counts too: turning puts it back first)
  const skSixes = t => t.dice.filter(d => (d.held === null || d.held === t.rolls) && !d.flipped && d.value === 6 && d.from === t.rolls);
  const canFlip = t => t.rolls > 0 && t.rolls < t.maxRolls && !(t.flip && t.flip.roll === t.rolls) && skSixes(t).length >= 2;
  // what the round just finished did, in the shape of roundRecap: the totals are coasters (they can go down: the highest
  // throw pays them once the pot is empty), results: the round's throws, half: the half it ended (and what comes next)
  function skRecap(g) {
    if (g.rounds.length < 2) return null;
    const n = g.players.length, fin = g.rounds.length - 2, rd = g.rounds[fin];
    if (!rd.after) return null;
    const order = orderFrom(rd.starter, n).filter(i => rd.results[i]);
    const prev = fin > 0 && g.rounds[fin - 1].half === rd.half ? g.rounds[fin - 1] : null;
    const before = prev && prev.after ? prev.after.slice() : Array(n).fill(0), after = rd.after.slice();
    const pts = after.map((a, i) => a - before[i]), res = rd.results, L = rd.loser, H = rd.high;
    const first = f => order.find(f);
    let best = null;
    const pick = (kind, player, value = null) => { if (player !== undefined) best = { kind, player, value }; return player !== undefined; };
    pick('schockOut', first(i => skOf(res[i]).cat === 'out')) ||
    (rd.halfLost != null && pick('half', L, rd.half)) ||
    ((res[H].blind || res[L].blind) && pick('blind', res[H].blind ? H : L, rd.take)) ||
    (skOf(res[H]).cat === 'schock' && pick('schock', H, skOf(res[H]).value)) ||
    pick('shots', first(i => (g.shots || []).some(x => x.player === i && x.round === rd.no)));
    const reason = { kind: rd.from === 'pot' ? 'pot' : rd.from === 'all' ? 'all' : 'paid', score: rd.take, low: res[L], high: H };
    return { round: rd.no, next: g.rounds[fin + 1].starter, order, pts, before, after, best, reason, results: res, kind: SK,
      half: rd.halfLost != null ? { lost: rd.half, next: g.rounds[fin + 1].half } : null, pot: rd.pot };
  }

  // ---------- constructors ----------
  function blank() { return { phase: 'setup', setup: { names: ['', ''], starter: 0, mode: 'dice', pairing: 'manual' }, game: null }; }
  function newTurn(maxRolls) {
    return { dice: Array.from({ length: DICE }, (_, id) => ({ id, value: null, held: null })), rolls: 0, maxRolls, pairs: [] };
  }
  function newGame(names, starter, mode, pairing) {
    return {
      mode: mode === 'score' ? 'score' : 'dice', pairing: pairing === 'auto' ? 'auto' : 'manual', history: [],
      players: names.map(name => ({ name, score: 0 })),
      round: 1, starter, order: orderFrom(starter, names.length), pos: 0,
      mark: null, ending: false, crosser: null, next: null, loser: null, last: null,
      rounds: [{ no: 1, starter, results: {} }],
      turn: newTurn(MAX_ROLLS),
      drops: 0, shots: []
    };
  }
  // 42/18: no pairs and no roll limit set by the starter (everyone rolls while dice are left: one is kept per roll)
  function ftTurn() {
    return { dice: Array.from({ length: FT_DICE }, (_, id) => ({ id, value: null, held: null })), rolls: 0, maxRolls: FT_ROLLS, pairs: [] };
  }
  function newFTGame(names, starter, mode) {
    return {
      kind: FT, mode: mode === 'score' ? 'score' : 'dice', history: [],
      players: names.map(name => ({ name, score: 0 })),
      round: 1, starter, order: orderFrom(starter, names.length), pos: 0,
      mark: null, ending: false, crosser: null, next: null, loser: null, last: null,
      rounds: [{ no: 1, starter, results: {} }],
      turn: ftTurn(),
      drops: 0, shots: []
    };
  }

  // Schocken: three dice; each remembers the roll it was last rolled in (from), to tell a throw from the hand
  function skTurn(maxRolls) {
    return { dice: Array.from({ length: SK_DICE }, (_, id) => ({ id, value: null, held: null, from: null })), rolls: 0, maxRolls, pairs: [], flip: null };
  }
  function newSKGame(names, starter, mode) {
    return {
      kind: SK, mode: mode === 'score' ? 'score' : 'dice', history: [],
      players: names.map(name => ({ name, score: 0 })),
      round: 1, starter, order: orderFrom(starter, names.length), pos: 0,
      mark: null, ending: false, crosser: null, next: null, loser: null, last: null,
      half: 1, pot: SK_POT, halves: [],
      rounds: [{ no: 1, starter, half: 1, results: {} }],
      turn: skTurn(MAX_ROLLS),
      drops: 0, shots: []
    };
  }

  // ---------- internal mutators (work on a private copy) ----------
  function hold(t, a, b) { t.dice[a].held = t.rolls; t.dice[b].held = t.rolls; t.pairs.push({ a, b, roll: t.rolls }); }
  // by hand, rolling on or stopping with a 7-pair still on the table misses it (the page makes fun of that)
  function checkMissed(g, ev, how) {
    const t = g.turn, ps = byHand(g) ? matchPairs(t) : [];
    if (ps.length) ev.push({ type: 'missed', player: current(g), how, pairs: ps.map(([a, b]) => [t.dice[a].value, t.dice[b].value]) });
  }
  function checkCleared(s, ev) {
    const g = s.game, t = g.turn;
    if (t.rolls > 0 && active(t).length === 0 && !t.cleared) {
      t.cleared = true;
      ev.push({ type: 'sevensOut', player: current(g) });
    }
  }
  // the round is complete and nobody is at 101: the next round starts at once, with the starter the
  // score sheet gives; with `ev` (a turn finished the round) the change is announced as roundEnd + started
  function startNextRound(s, ev) {
    const g = s.game, done = g.round, next = nextStarter(g);
    g.round++; g.starter = next; g.next = null;
    g.order = orderFrom(next, g.players.length); g.pos = 0; g.mark = null; g.last = null;
    g.rounds.push({ no: g.round, starter: next, results: {} });
    g.turn = newTurn(MAX_ROLLS);
    s.phase = 'play';
    if (ev) ev.push({ type: 'roundEnd', round: done, next }, { type: 'started', starter: next });
  }
  // between rounds: a new round has started, but nobody has played in it yet (dropped dice don't count)
  const betweenRounds = s => s.phase === 'play' && s.game.rounds.length > 1 && !Object.keys(s.game.rounds[s.game.rounds.length - 1].results).length;
  // step back from the empty new round to the end of the finished round (corrections, ending early);
  // shots paid in the empty round move to the finished one, so the sheet never points at a missing round
  function dropEmptyRound(g) {
    const gone = g.rounds.pop(), rd = g.rounds[g.rounds.length - 1];
    g.round = rd.no; g.starter = rd.starter; g.order = isFT(g) ? ftOrder(g, rd.starter, rd.no) : orderFrom(rd.starter, g.players.length);
    g.mark = rd.mark; g.pos = g.order.length;
    g.shots = (g.shots || []).map(x => x.round === gone.no ? { player: x.player, round: rd.no } : x);
  }
  // book a finished turn and move on (both modes)
  function recordTurn(s, pts, rolls, ev) {
    const g = s.game, p = current(g);
    g.players[p].score += pts;
    const rd = g.rounds[g.rounds.length - 1];
    rd.results[p] = { pts, rolls };
    if (g.pos === 0) { g.mark = rolls; rd.mark = rolls; }
    g.last = { player: p, pts, rolls, total: g.players[p].score };
    if (!g.ending && g.players[p].score >= LIMIT) { g.ending = true; g.crosser = p; }
    ev.push({ type: 'turn', player: p, pts, rolls });
    g.pos++;
    if (g.pos < g.order.length) { g.turn = newTurn(g.mark); return; }
    if (g.ending) {
      g.loser = highestLater(g); s.phase = 'over';
      ev.push({ type: 'gameOver', loser: g.loser });
    } else startNextRound(s, ev);
  }
  // rebuild totals from the score sheet and re-apply the round rules to wherever the game stands now;
  // between rounds that is the end of the finished round, as if the new round hadn't started yet
  function recalc(s) {
    const g = s.game, n = g.players.length, between = betweenRounds(s), shots = g.shots;
    if (between) dropEmptyRound(g);
    g.players.forEach(pl => { pl.score = 0; });
    let crosser = null;
    for (const rd of g.rounds) for (const p of orderFrom(rd.starter, n)) {
      const r = rd.results[p]; if (!r) continue;
      g.players[p].score += r.pts;
      if (crosser === null && g.players[p].score >= LIMIT) crosser = p;
    }
    g.last = null;
    if (s.phase === 'play' && !between) { g.ending = crosser !== null; g.crosser = crosser; return; }
    if (s.phase === 'over' && g.early) { g.loser = highestLater(g); return; }
    if (crosser !== null) {
      g.ending = true; g.crosser = crosser; g.loser = highestLater(g); g.next = null;
      s.phase = 'over';
    } else {
      // the next round (re)starts with the right starter; a restarted round keeps the shots paid in it
      g.ending = false; g.crosser = null; g.loser = null;
      if (between) g.shots = shots;
      startNextRound(s);
    }
  }
  // ----- 42/18 -----
  // book a finished turn; the round's last turn hands out the coaster and starts the next round with its loser
  function ftRecord(s, pts, rolls, ev) {
    const g = s.game, p = current(g), rd = g.rounds[g.rounds.length - 1];
    rd.results[p] = { pts, rolls };
    g.last = { player: p, pts, rolls, total: g.players[p].score };
    if (pts === FT_MAX) { g.players[p].out = rd.no; ev.push({ type: 'perfect', player: p }); }
    ev.push({ type: 'turn', player: p, pts, rolls });
    g.pos++;
    const left = ftLeft(g);
    if (left.length === 1) { // everyone else is out: the last player left loses, without finishing the round
      g.ending = true; g.loser = left[0]; g.left = true; s.phase = 'over';
      ev.push({ type: 'gameOver', loser: g.loser });
      return;
    }
    if (g.pos < g.order.length) { g.turn = ftTurn(); return; }
    const L = roundLoser(rd, g.players.length);
    rd.loser = L; g.players[L].score++;
    if (g.players.some(pl => pl.score >= COASTERS)) {
      g.ending = true; g.loser = ftGameLoser(g, L); s.phase = 'over';
      ev.push({ type: 'gameOver', loser: g.loser });
    } else ftNextRound(s, L, ev);
  }
  function ftNextRound(s, starter, ev) {
    const g = s.game, done = g.round;
    g.round++; g.starter = starter; g.next = null;
    g.order = ftOrder(g, starter, g.round); g.pos = 0; g.mark = null; g.last = null;
    g.rounds.push({ no: g.round, starter, results: {} });
    g.turn = ftTurn();
    s.phase = 'play';
    if (ev) ev.push({ type: 'roundEnd', round: done, next: starter, loser: starter }, { type: 'started', starter });
  }
  // corrections: the coasters are counted again from the sheet, and the round rules re-applied where the game stands
  // (as recalc does for Sevens Out: between rounds the next round restarts with the corrected loser, or the game ends)
  function ftRecalc(s) {
    const g = s.game, n = g.players.length, between = betweenRounds(s), shots = g.shots;
    if (between) dropEmptyRound(g);
    g.players.forEach(pl => { pl.score = 0; });
    for (const rd of g.rounds) {
      if (ftDone(g, rd)) { rd.loser = roundLoser(rd, n); g.players[rd.loser].score++; }
      else delete rd.loser;
    }
    g.last = null;
    const full = g.players.some(pl => pl.score >= COASTERS);
    if (s.phase === 'play' && !between) { g.ending = full; return; }
    if (s.phase === 'over' && g.early) { g.loser = highestLater(g, ftLeft(g)); return; }
    if (s.phase === 'over' && g.left) return; // the last player left still loses (a 42/18 can't be corrected)
    const L = g.rounds[g.rounds.length - 1].loser;
    if (full) { g.ending = true; g.loser = ftGameLoser(g, L); s.phase = 'over'; }
    else {
      g.ending = false; g.loser = null;
      if (between) g.shots = shots;
      ftNextRound(s, L);
    }
  }
  // 42/18's own actions; drop, undo and endearly are the same as in Sevens Out (apply handles them)
  function applyFT(s, action, rng, fail, ev) {
    const g = s.game, inPlay = s.phase === 'play', t = g.turn;
    switch (action.type) {
      case 'roll': {
        if (!inPlay || isScore(g)) return fail('phase');
        if (!canRoll(t)) return fail('no_rolls');
        if (ftPerfect(t)) return fail('perfect');
        if (t.rolls > 0 && !t.dice.some(d => d.held === t.rolls)) return fail('keep_one');
        active(t).forEach(d => { d.value = rng(); });
        t.rolls++;
        ev.push({ type: 'rolled', player: current(g), roll: t.rolls, values: t.dice.map(d => d.value), auto: [] });
        if (ftPerfect(t)) ftRecord(s, FT_MAX, t.rolls, ev); // 42/18: out at once, so the roll ends the turn
        break;
      }
      case 'keep': {
        if (!inPlay || isScore(g) || !t.rolls) return fail('phase');
        const d = t.dice[action.id];
        if (!d || d.held !== null || !d.value) return fail('bad_die');
        d.held = t.rolls;
        ev.push({ type: 'kept', id: d.id, value: d.value });
        break;
      }
      case 'unkeep': {
        if (!inPlay || isScore(g)) return fail('phase');
        const d = t.dice[action.id];
        if (!d || d.held === null || d.held !== t.rolls) return fail('locked');
        d.held = null;
        ev.push({ type: 'unkept', id: d.id, value: d.value });
        break;
      }
      case 'stop': case 'end': {
        if (!inPlay || isScore(g) || !t.rolls) return fail('phase');
        ftRecord(s, throwPts(t.dice.map(d => d.value)), t.rolls, ev);
        break;
      }
      case 'score': {
        if (!inPlay || !isScore(g)) return fail('phase');
        if (!ftPts(action.pts)) return fail('pts');
        if (!intIn(action.rolls, 1, FT_ROLLS)) return fail('rolls');
        snapshot(s, `${g.players[current(g)].name}'s entry was removed. Enter it again.`);
        ftRecord(s, action.pts, action.rolls, ev);
        break;
      }
      case 'edit': {
        if (!isScore(g) || s.phase === 'setup') return fail('phase');
        const p = action.player;
        if (!intIn(p, 0, g.players.length - 1) || !action.values || typeof action.values !== 'object') return fail('bad_edit');
        const changes = [];
        for (const rd of g.rounds) {
          const r = rd.results[p], v = action.values[rd.no];
          if (!r || v == null) continue;
          if (!ftPts(v)) return fail('pts');
          if (v !== r.pts && (v === FT_MAX || r.pts === FT_MAX)) return fail('perfect_fixed'); // who is out stays: Undo instead
          if (v !== r.pts) changes.push([rd, v]);
        }
        if (!changes.length) return fail('no_change');
        snapshot(s, `The score corrections for ${g.players[p].name} were undone.`);
        changes.forEach(([rd, v]) => { s.game.rounds[rd.no - 1].results[p].pts = v; });
        ftRecalc(s);
        ev.push({ type: 'edited', player: p });
        break;
      }
      default: return fail('unknown_action'); // pair, unpair, takeall: there are no pairs in 42/18
    }
    return { state: s, events: ev };
  }

  // ----- Schocken -----
  // book a finished turn (a blind one has no dice yet: they are rolled when the round ends)
  function skRecord(s, res, rng, ev) {
    const g = s.game, p = current(g), rd = g.rounds[g.rounds.length - 1];
    if (res.dice) res.pts = skThrow(res.dice, res.hand).worth;
    rd.results[p] = res;
    if (g.pos === 0) { g.mark = res.rolls; rd.mark = res.rolls; }
    g.last = { player: p, pts: res.pts == null ? null : res.pts, rolls: res.rolls, total: g.players[p].score };
    if (res.dice && skThrow(res.dice, res.hand).cat === 'out') ev.push({ type: 'schockOut', player: p });
    // a blind cup stays down: nobody sees the throw, the thrower neither, until the round's cups come up
    ev.push(!res.dice ? { type: 'turn', player: p, pts: null, rolls: res.rolls, blind: true } : { type: 'turn', player: p, pts: res.pts, rolls: res.rolls });
    g.pos++;
    if (g.pos < g.order.length) { g.turn = skTurn(g.mark); return; }
    if (skLift(g, ev)) return;
    skEndRound(s, rng, ev);
  }
  // real dice: once every turn is booked, the blind cups come up one by one in the round's order, and each blind
  // player enters the throw (g.lifting; the current player is the one lifting). False when no cup is left down
  function skLift(g, ev) {
    const rd = g.rounds[g.rounds.length - 1];
    const k = isScore(g) ? g.order.findIndex(p => rd.results[p] && rd.results[p].blind && !rd.results[p].dice) : -1;
    if (k < 0) { delete g.lifting; return false; }
    g.lifting = true; g.pos = k;
    ev.push({ type: 'lift', player: g.order[k] });
    return true;
  }
  // the round's cups come up: blind dice are rolled, the lowest throw takes coasters, and a half (or the game) may end
  function skEndRound(s, rng, ev) {
    const g = s.game, rd = g.rounds[g.rounds.length - 1], order = g.order;
    for (const p of order) {
      const r = rd.results[p];
      if (!r.blind || r.dice) continue;
      r.dice = r.kept.concat(Array.from({ length: SK_DICE - r.kept.length }, () => rng())).sort((x, y) => y - x);
      r.pts = skThrow(r.dice, r.hand).worth;
      ev.push({ type: 'revealed', player: p, values: r.dice.slice() });
      if (skThrow(r.dice, r.hand).cat === 'out') ev.push({ type: 'schockOut', player: p });
    }
    const { high: H, low: L } = skExtremes(rd, order);
    const top = skOf(rd.results[H]);
    const worth = top.worth * (rd.results[H].blind || rd.results[L].blind ? 2 : 1);
    let take, from;
    if (top.cat === 'out') { // Schock out: the loser takes every coaster, and with them the half
      take = SK_POT - g.players[L].score; from = 'all';
      g.players.forEach(pl => { pl.score = 0; });
      g.pot = 0; g.players[L].score = SK_POT;
    } else if (g.pot > 0) { take = Math.min(worth, g.pot); from = 'pot'; g.pot -= take; g.players[L].score += take; }
    else { take = Math.min(worth, g.players[H].score); from = 'player'; g.players[H].score -= take; g.players[L].score += take; }
    Object.assign(rd, { loser: L, high: H, take, from, pot: g.pot, after: g.players.map(pl => pl.score) });
    if (g.players[L].score < SK_POT) {
      ev.push({ type: 'roundEnd', round: g.round, next: L, loser: L, high: H, take });
      return skNextRound(s, L, ev);
    }
    // L holds all the coasters: the half is lost
    rd.halfLost = L;
    g.halves.push(L);
    const done = g.halves.length === 3 || (g.halves.length === 2 && g.halves[0] === g.halves[1]);
    if (done) {
      g.loser = L; g.ending = true; s.phase = 'over';
      ev.push({ type: 'halfOver', half: g.half, loser: L }, { type: 'gameOver', loser: L });
      return;
    }
    ev.push({ type: 'roundEnd', round: g.round, next: L, loser: L, high: H, take }, { type: 'halfOver', half: g.half, loser: L });
    g.half++; g.pot = SK_POT;
    g.players.forEach(pl => { pl.score = 0; });
    skNextRound(s, L, ev);
  }
  function skNextRound(s, starter, ev) {
    const g = s.game;
    g.round++; g.starter = starter; g.next = null;
    g.order = skOrder(g, starter); g.pos = 0; g.mark = null; g.last = null; delete g.lifting;
    g.rounds.push({ no: g.round, starter, half: g.half, results: {} });
    g.turn = skTurn(MAX_ROLLS);
    s.phase = 'play';
    if (ev) ev.push({ type: 'started', starter });
  }
  // Schocken's own actions; drop and undo are the same as in Sevens Out (apply handles them)
  function applySK(s, action, rng, fail, ev) {
    const g = s.game, inPlay = s.phase === 'play', t = g.turn;
    const dice = inPlay && !isScore(g);
    switch (action.type) {
      case 'roll': {
        if (!dice) return fail('phase');
        if (!canRoll(t)) return fail('no_rolls');
        t.rolls++;
        active(t).forEach(d => { d.value = rng(); d.from = t.rolls; });
        ev.push({ type: 'rolled', player: current(g), roll: t.rolls, values: t.dice.map(d => d.value), auto: [] });
        break;
      }
      case 'keep': {
        if (!dice || !t.rolls) return fail('phase');
        const d = t.dice[action.id];
        if (!d || d.held !== null || !d.value) return fail('bad_die');
        if (t.flip && t.flip.roll === t.rolls && t.flip.back === d.id) return fail('flip_back'); // the other 6 goes back into the cup
        d.held = t.rolls;
        ev.push({ type: 'kept', id: d.id, value: d.value });
        break;
      }
      case 'unkeep': {
        if (!dice) return fail('phase');
        const d = t.dice[action.id];
        if (!d || d.held === null || d.held !== t.rolls) return fail('locked');
        if (d.flipped) { // a turned 6 goes back as a 6, and so does the whole turn of this roll
          t.flip.ids.forEach(id => { const x = t.dice[id]; x.value = 6; x.held = null; delete x.flipped; });
          t.flip = null;
          ev.push({ type: 'unkept', id: d.id, value: 6, flip: true });
          break;
        }
        d.held = null;
        ev.push({ type: 'unkept', id: d.id, value: d.value });
        break;
      }
      case 'flip': {
        if (!dice || !t.rolls) return fail('phase');
        if (!canFlip(t)) return fail('no_sixes');
        const six = skSixes(t), n = six.length >= 3 ? 2 : 1, ids = six.slice(0, n).map(d => d.id);
        six.forEach(d => { d.held = null; });
        ids.forEach(id => { const x = t.dice[id]; x.value = 1; x.held = t.rolls; x.flipped = true; });
        t.flip = { roll: t.rolls, ids, back: six[n].id };
        ev.push({ type: 'flipped', ids, back: six[n].id });
        break;
      }
      case 'stop': case 'end': {
        if (!dice || !t.rolls) return fail('phase');
        if (t.flip && t.flip.roll === t.rolls) return fail('flip_roll'); // a turned 6 means rolling the other one again
        skRecord(s, { dice: t.dice.map(d => d.value).sort((x, y) => y - x), hand: skHand(t), rolls: t.rolls }, rng, ev);
        break;
      }
      case 'blind': {
        if (!dice) return fail('phase');
        if (!canRoll(t)) return fail('no_rolls');
        const kept = t.dice.filter(d => d.held !== null);
        skRecord(s, { dice: null, kept: kept.map(d => d.value), hand: kept.length === 0, rolls: t.rolls + 1, blind: true }, rng, ev);
        break;
      }
      case 'score': {
        if (!inPlay || !isScore(g)) return fail('phase');
        const v = action.dice, p = current(g), okDice = Array.isArray(v) && v.length === SK_DICE && v.every(x => intIn(x, 1, 6));
        if (g.lifting) { // a blind cup comes up: its throw, from one roll or not (the rolls were given with the blind turn)
          const r = g.rounds[g.rounds.length - 1].results[p];
          if (!okDice) return fail('dice');
          snapshot(s, `${g.players[p].name}'s blind throw was removed. Enter it again.`);
          r.dice = v.slice().sort((x, y) => y - x); r.hand = r.rolls === 1 || action.hand === true; r.pts = skThrow(r.dice, r.hand).worth;
          ev.push({ type: 'revealed', player: p, values: r.dice.slice() });
          if (skThrow(r.dice, r.hand).cat === 'out') ev.push({ type: 'schockOut', player: p });
          g.pos = g.order.length;
          if (!skLift(g, ev)) skEndRound(s, rng, ev);
          break;
        }
        if (!intIn(action.rolls, 1, g.pos === 0 ? MAX_ROLLS : g.mark)) return fail('rolls');
        // blind: the cup stays down, so there are no dice to enter yet
        const blind = action.blind === true && v == null;
        if (!blind && !okDice) return fail('dice');
        snapshot(s, `${g.players[p].name}'s entry was removed. Enter it again.`);
        const res = blind ? { dice: null, hand: null, rolls: action.rolls, blind: true }
          : { dice: v.slice().sort((x, y) => y - x), hand: action.rolls === 1 || action.hand === true, rolls: action.rolls };
        if (!blind && action.blind === true) res.blind = true; // a blind throw entered at once (a page from before the cups came up)
        skRecord(s, res, rng, ev);
        break;
      }
      case 'endearly': {
        if (s.phase !== 'play') return fail('phase');
        if (betweenRounds(s)) { // back to the round just finished; shots paid in the empty round move to it
          const gone = g.rounds.pop(), rd = g.rounds[g.rounds.length - 1];
          g.round = rd.no; g.starter = rd.starter;
          g.shots = (g.shots || []).map(x => x.round === gone.no ? { player: x.player, round: rd.no } : x);
        }
        // the most coasters lose; right after a half nobody holds any, so its loser does
        const max = Math.max(...g.players.map(p => p.score));
        g.loser = max > 0 || !g.halves.length ? highestLater(g) : g.halves[g.halves.length - 1];
        g.early = true; s.phase = 'over';
        ev.push({ type: 'ended', loser: g.loser });
        break;
      }
      default: return fail('unknown_action'); // pair, unpair, takeall: no pairs; edit: corrections aren't in Schocken yet
    }
    return { state: s, events: ev };
  }

  // scoreboard mode: every entry can be undone
  function snapshot(s, msg) {
    const g = s.game, copy = clone(g);
    delete copy.history;
    g.history = (g.history || []).concat([JSON.stringify({ phase: s.phase, game: copy, msg })]).slice(-HISTORY);
  }
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const FT_OWN = new Set(['roll', 'keep', 'unkeep', 'pair', 'unpair', 'takeall', 'stop', 'end', 'score', 'edit', 'nextround']);
  const SK_OWN = new Set([...FT_OWN, 'flip', 'blind', 'endearly']);
  function cleanName(n, i) {
    const s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 16);
    return s || `Player ${i + 1}`;
  }

  // ---------- the reducer ----------
  /**
   * apply(state, action, { rng }) -> { state, events } on success, { error, state } when the action isn't allowed.
   * Events describe what happened, so a screen can animate it: rolled, paired, unpaired, missed, sevensOut, turn,
   * roundEnd, gameOver, dropped, shots, undone, edited, started, ended; in 42/18 also kept, unkept and perfect (a 42/18 throw).
   * A 42/18 game starts with `start {kind:'4218'}` and plays with roll, keep {id}, unkeep {id}, stop and score {pts, rolls}.
   * A Schocken game starts with `start {kind:'schocken'}` and plays with roll, keep {id}, unkeep {id}, flip, blind, stop and
   * score {dice, rolls, hand?, blind?}; its own events are flipped, revealed, schockOut and halfOver.
   * The turn that completes a round also starts the next one: roundEnd is always followed by started.
   */
  function apply(state, action, opts) {
    const rng = (opts && opts.rng) || rnd6;
    const fail = error => ({ error, state });
    if (!state || !action || typeof action.type !== 'string') return fail('bad_action');
    const s = clone(state), ev = [], g = s.game;
    const inPlay = s.phase === 'play' && g;
    const t = g && g.turn;
    if (isFT(g) && FT_OWN.has(action.type)) return applyFT(s, action, rng, fail, ev);
    if (isSK(g) && SK_OWN.has(action.type)) return applySK(s, action, rng, fail, ev);

    switch (action.type) {
      case 'start': {
        const names = Array.isArray(action.names) ? action.names : [];
        if (names.length < 2 || names.length > MAX_PLAYERS) return fail('players');
        const starter = intIn(action.starter, 0, names.length - 1) ? action.starter : 0;
        s.game = action.kind === FT ? newFTGame(names.map(cleanName), starter, action.mode)
          : action.kind === SK ? newSKGame(names.map(cleanName), starter, action.mode)
          : newGame(names.map(cleanName), starter, action.mode, action.pairing);
        if (Array.isArray(action.seats)) s.game.seats = action.seats.slice(0, names.length);
        s.phase = 'play';
        ev.push({ type: 'started', starter });
        break;
      }

      // ----- dice mode -----
      case 'roll': {
        if (!inPlay || isScore(g)) return fail('phase');
        if (!canRoll(t)) return fail('no_rolls');
        checkMissed(g, ev, 'roll');
        active(t).forEach(d => { d.value = rng(); });
        t.rolls++;
        const auto = action.auto === false || byHand(g) ? [] : matchPairs(t);
        auto.forEach(([a, b]) => hold(t, a, b));
        ev.push({ type: 'rolled', player: current(g), roll: t.rolls, values: t.dice.map(d => d.value), auto });
        checkCleared(s, ev);
        break;
      }
      case 'pair': {
        if (!inPlay || isScore(g) || !t.rolls) return fail('phase');
        const a = t.dice[action.a], b = t.dice[action.b];
        if (!a || !b || a === b || a.held !== null || b.held !== null || a.value + b.value !== 7) return fail('not_seven');
        hold(t, a.id, b.id);
        ev.push({ type: 'paired', pairs: [[a.id, b.id]] });
        checkCleared(s, ev);
        break;
      }
      case 'takeall': {
        if (!inPlay || isScore(g) || !t.rolls) return fail('phase');
        if (byHand(g)) return fail('by_hand');
        const ps = matchPairs(t);
        if (!ps.length) return fail('nothing');
        ps.forEach(([a, b]) => hold(t, a, b));
        ev.push({ type: 'paired', pairs: ps });
        checkCleared(s, ev);
        break;
      }
      case 'unpair': {
        if (!inPlay || isScore(g)) return fail('phase');
        const pr = t.pairs[action.index];
        if (!pr || pr.roll !== t.rolls || t.rolls >= t.maxRolls) return fail('locked');
        t.dice[pr.a].held = null; t.dice[pr.b].held = null; t.pairs.splice(action.index, 1);
        ev.push({ type: 'unpaired', values: [t.dice[pr.a].value, t.dice[pr.b].value] });
        break;
      }
      case 'stop': case 'end': {
        if (!inPlay || isScore(g) || !t.rolls) return fail('phase');
        // a pair the player missed counts against them when they find the 7s by hand
        if (!byHand(g)) matchPairs(t).forEach(([a, b]) => hold(t, a, b));
        else checkMissed(g, ev, 'stop');
        checkCleared(s, ev);
        recordTurn(s, sumActive(t), t.rolls, ev);
        break;
      }

      // ----- scoreboard mode -----
      case 'score': {
        if (!inPlay || !isScore(g)) return fail('phase');
        const isStarter = g.pos === 0;
        if (!intIn(action.pts, 0, MAX_PIPS)) return fail('pts');
        if (isStarter && !intIn(action.rolls, 1, MAX_ROLLS)) return fail('rolls');
        const p = current(g);
        snapshot(s, `${g.players[p].name}'s entry was removed. Enter it again.`);
        if (action.pts === 0) ev.push({ type: 'sevensOut', player: p });
        recordTurn(s, action.pts, isStarter ? action.rolls : null, ev);
        break;
      }
      case 'drop': {
        if (!inPlay || !isScore(g)) return fail('phase');
        const p = current(g);
        snapshot(s, 'The last dropped die was taken back.');
        g.drops = (g.drops || 0) + 1;
        if (g.drops >= 3) {
          g.drops = 0;
          g.shots = (g.shots || []).concat([{ player: p, round: g.round }]);
          ev.push({ type: 'shots', player: p });
        } else ev.push({ type: 'dropped', player: p, drops: g.drops });
        break;
      }
      case 'undo': {
        if (!g || !isScore(g) || !g.history || !g.history.length) return fail('nothing');
        const rest = g.history.slice(), snap = JSON.parse(rest.pop());
        s.phase = snap.phase; s.game = snap.game; s.game.history = rest;
        ev.push({ type: 'undone', msg: snap.msg || null });
        // a snapshot taken between rounds by an older version: move on at once
        if (s.phase === 'roundEnd') { startNextRound(s); ev.push({ type: 'started', starter: s.game.starter }); }
        break;
      }
      case 'edit': {
        if (!g || !isScore(g) || s.phase === 'setup') return fail('phase');
        const p = action.player;
        if (!intIn(p, 0, g.players.length - 1) || !action.values || typeof action.values !== 'object') return fail('bad_edit');
        const changes = [];
        for (const rd of g.rounds) {
          const r = rd.results[p], v = action.values[rd.no];
          if (!r || v == null) continue;
          if (!intIn(v, 0, MAX_PIPS)) return fail('pts');
          if (v !== r.pts) changes.push([rd, v]);
        }
        if (!changes.length) return fail('no_change');
        snapshot(s, `The score corrections for ${g.players[p].name} were undone.`);
        changes.forEach(([rd, v]) => { s.game.rounds[rd.no - 1].results[p].pts = v; });
        recalc(s);
        ev.push({ type: 'edited', player: p });
        break;
      }

      // ----- flow -----
      // only games saved between rounds by older versions wait in 'roundEnd'; rounds now move on by themselves
      case 'nextround': {
        if (s.phase !== 'roundEnd' || !g) return fail('phase');
        startNextRound(s);
        ev.push({ type: 'started', starter: g.starter });
        break;
      }
      case 'endearly': {
        if (!g || (s.phase !== 'play' && s.phase !== 'roundEnd')) return fail('phase');
        if (betweenRounds(s)) dropEmptyRound(g);   // the last round is the one just finished
        g.loser = highestLater(g, isFT(g) ? ftLeft(g) : g.order); g.early = true; s.phase = 'over';   // 42/18: never a player who is out
        ev.push({ type: 'ended', loser: g.loser });
        break;
      }
      default:
        return fail('unknown_action');
    }
    return { state: s, events: ev };
  }

  root.SevensEngine = Object.freeze({
    MAX_ROLLS, LIMIT, DICE, MAX_PLAYERS, MAX_PIPS,
    apply, blank, newGame, newTurn, rnd6, clone, orderFrom, isScore, byHand,
    active, sumActive, maxPairs, finalPenalty, pairable, canRoll, matchPairs, current,
    reachedAt, tiedForStart, nextStarter, highestLater, roundRecap,
    FT, FT_DICE, FT_ROLLS, COASTERS, FT_MIN, FT_MAX, isFT, throwPts, roundLoser, ftPlays, ftLeft, ftPerfect, ftGameLoser,
    SK, SK_DICE, SK_POT, isSK, skThrow, skBetter, skExtremes, skInPlay, skHand, canFlip
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

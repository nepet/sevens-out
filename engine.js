/*
 * Sevens Out rules engine.
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

  const MAX_ROLLS = 3, LIMIT = 101, DICE = 6, MAX_PLAYERS = 6, MAX_PIPS = 36, HISTORY = 40;

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
  // the highest score loses; on a tie the player later in this round's order loses
  function highestLater(g) {
    let L = null;
    for (const i of g.order) if (L === null || g.players[i].score >= g.players[L].score) L = i;
    return L;
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
    g.round = rd.no; g.starter = rd.starter; g.order = orderFrom(rd.starter, g.players.length);
    g.mark = rd.mark; g.pos = g.players.length;
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
  // scoreboard mode: every entry can be undone
  function snapshot(s, msg) {
    const g = s.game, copy = clone(g);
    delete copy.history;
    g.history = (g.history || []).concat([JSON.stringify({ phase: s.phase, game: copy, msg })]).slice(-HISTORY);
  }
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  function cleanName(n, i) {
    const s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 16);
    return s || `Player ${i + 1}`;
  }

  // ---------- the reducer ----------
  /**
   * apply(state, action, { rng }) -> { state, events } on success, { error, state } when the action isn't allowed.
   * Events describe what happened, so a screen can animate it: rolled, paired, unpaired, missed, sevensOut, turn,
   * roundEnd, gameOver, dropped, shots, undone, edited, started, ended.
   * The turn that completes a round also starts the next one: roundEnd is always followed by started.
   */
  function apply(state, action, opts) {
    const rng = (opts && opts.rng) || rnd6;
    const fail = error => ({ error, state });
    if (!state || !action || typeof action.type !== 'string') return fail('bad_action');
    const s = clone(state), ev = [], g = s.game;
    const inPlay = s.phase === 'play' && g;
    const t = g && g.turn;

    switch (action.type) {
      case 'start': {
        const names = Array.isArray(action.names) ? action.names : [];
        if (names.length < 2 || names.length > MAX_PLAYERS) return fail('players');
        const starter = intIn(action.starter, 0, names.length - 1) ? action.starter : 0;
        s.game = newGame(names.map(cleanName), starter, action.mode, action.pairing);
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
        g.loser = highestLater(g); g.early = true; s.phase = 'over';
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
    reachedAt, tiedForStart, nextStarter, highestLater
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

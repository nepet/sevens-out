// Deterministic finished games for the stats tests (same generator as engine.test.js).
import assert from 'node:assert/strict';
import '../engine.js';

const E = globalThis.SevensEngine;

function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return (x % 6) + 1; };
}
function must(state, action, opts) {
  const r = E.apply(state, action, opts);
  assert.ok(!r.error, `${action.type} failed: ${r.error}`);
  return r.state;
}
export function diceGame(seed, n = 2 + (seed % 5)) {
  const rng = seeded(seed);
  let s = must(E.blank(), { type: 'start', names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter: seed % n, mode: 'dice' });
  while (s.phase !== 'over') {
    const t = s.game.turn;
    s = t.rolls === 0 || (E.canRoll(t) && rng() > 2) ? must(s, { type: 'roll' }, { rng }) : must(s, { type: 'stop' });
  }
  return s;
}
export function scoreGame(seed, n = 2 + (seed % 5)) {
  const rng = seeded(seed);
  let s = must(E.blank(), { type: 'start', names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter: 0, mode: 'score' });
  while (s.phase !== 'over') {
    if (rng() === 6) s = must(s, { type: 'drop' });
    const pts = (rng() - 1) * 7; // 0, 7, ... 35
    s = must(s, { type: 'score', pts, rolls: s.game.pos === 0 ? 1 + (rng() % 3) : undefined });
  }
  return s;
}
export { must };

// a game between rounds as older versions saved it: phase 'roundEnd' at the end of the finished round,
// before the empty next round existed, with the next starter in `next`
export function legacyRoundEnd(state) {
  const s = E.clone(state), g = s.game, gone = g.rounds.pop(), rd = g.rounds.at(-1);
  assert.ok(s.phase === 'play' && rd && !Object.keys(gone.results).length, 'not between rounds');
  Object.assign(g, { round: rd.no, starter: rd.starter, order: E.orderFrom(rd.starter, g.players.length), mark: rd.mark, pos: g.players.length, next: gone.starter });
  s.phase = 'roundEnd';
  return s;
}

// a scoreboard game with chosen names: the first player starts every round with 36 and loses in round 3,
// everyone else enters `others` points per turn
export function quickGame(names, others = 5) {
  let s = must(E.blank(), { type: 'start', names, starter: 0, mode: 'score' });
  while (s.phase !== 'over') {
    s = s.game.pos === 0 ? must(s, { type: 'score', pts: 36, rolls: 2 }) : must(s, { type: 'score', pts: others });
  }
  return s;
}

// a finished 42/18 game: dice games keep the 4s and 2s first; real dice now and then throw a 42/18, so players go out
// and some games end with one player left
export function ftGame(seed, n = 2 + (seed % 5), mode = seed % 2 ? 'dice' : 'score') {
  const rng = seeded(seed);
  let s = must(E.blank(), { type: 'start', kind: E.FT, names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter: seed % n, mode });
  while (s.phase !== 'over') {
    if (mode === 'score') {
      if (rng() === 6 && rng() === 6) s = must(s, { type: 'drop' });
      const pts = rng() === 6 && rng() > 3 ? 18 : rng() === 1 ? 0 : 2 + rng() + rng();
      s = must(s, { type: 'score', pts, rolls: rng() % 5 + 1 });
      s.game.history = []; // no undo here, and the snapshots make every step slower
      continue;
    }
    const t = s.game.turn;
    if (t.rolls && (!E.canRoll(t) || E.ftPerfect(t) || rng() === 6)) { s = must(s, { type: 'stop' }); continue; }
    if (t.rolls) {
      const table = E.active(t).sort((a, b) => [4, 2].includes(b.value) - [4, 2].includes(a.value));
      for (const d of table.slice(0, Math.min(table.length, 1 + (rng() % 3)))) s = must(s, { type: 'keep', id: d.id });
      if (!E.canRoll(s.game.turn) || E.ftPerfect(s.game.turn)) { s = must(s, { type: 'stop' }); continue; }
    }
    s = must(s, { type: 'roll' }, { rng });
  }
  return s;
}

// a finished Schocken game: dice games set aside 1s, turn 6s and roll blind now and then; real dice enter random throws,
// some blind (their cups come up when the round's last turn is booked)
export function skGame(seed, n = 2 + (seed % 5), mode = seed % 2 ? 'dice' : 'score') {
  const rng = seeded(seed);
  let s = must(E.blank(), { type: 'start', kind: E.SK, names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter: seed % n, mode });
  while (s.phase !== 'over') {
    const g = s.game, t = g.turn, pick = rng();
    if (mode === 'score') {
      const dice = [rng(), rng(), rng()];
      if (g.lifting) { s = must(s, { type: 'score', dice, hand: pick > 3 }); s.game.history = []; continue; }
      const rolls = 1 + (rng() % (g.pos === 0 ? 3 : g.mark));
      s = pick === 6 ? must(s, { type: 'score', rolls, blind: true }) : must(s, { type: 'score', dice, rolls, hand: pick > 3 });
      s.game.history = []; // no undo here, and the snapshots make every step slower
      continue;
    }
    if (t.rolls === 0 || (pick > 1 && E.canRoll(t))) {
      if (pick === 6 && E.canRoll(t)) s = must(s, { type: 'blind' }, { rng });
      else if (E.canFlip(t) && pick > 3) s = must(s, { type: 'flip' }, { rng });
      else {
        t.dice.forEach(d => { if (d.held === null && d.value === 1 && t.rolls) s = must(s, { type: 'keep', id: d.id }); });
        s = E.canRoll(s.game.turn) ? must(s, { type: 'roll' }, { rng }) : must(s, { type: 'stop' }, { rng });
      }
    } else if (t.flip && t.flip.roll === t.rolls) s = must(s, { type: 'roll' }, { rng });
    else s = must(s, { type: 'stop' }, { rng });
  }
  return s;
}

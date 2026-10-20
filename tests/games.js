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

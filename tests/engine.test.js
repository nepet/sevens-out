// Rules engine tests: run with `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { checkReport, sheetOf } from '../server/core/stats.js';
import { legacyRoundEnd } from './games.js';

const E = globalThis.SevensEngine;

// deterministic dice: a seeded generator, or a fixed list of faces
function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return (x % 6) + 1; };
}
const faces = list => { let i = 0; return () => list[i++ % list.length]; };
function must(state, action, opts) {
  const r = E.apply(state, action, opts);
  assert.ok(!r.error, `${action.type} failed: ${r.error}`);
  return r;
}
const start = (n, starter = 0, mode = 'dice', pairing) =>
  must(E.blank(), { type: 'start', names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter, mode, pairing }).state;

// replay a finished game's score sheet and check every rule against it
function checkSheet(g) {
  const n = g.players.length, scores = Array(n).fill(0), at = Array(n).fill(-1);
  let seq = 0, prev = null, order = [];
  g.rounds.forEach((rd, ri) => {
    if (ri) {
      const mx = Math.max(...scores), tied = scores.map((_, i) => i).filter(i => scores[i] === mx);
      const first = Math.min(...tied.map(i => at[i])), early = tied.filter(i => at[i] === first);
      let exp = early[0];
      if (early.length > 1) for (let k = 1; k <= n; k++) { const i = (prev + k) % n; if (early.includes(i)) { exp = i; break; } }
      assert.equal(rd.starter, exp, `round ${rd.no} starter`);
    }
    const mark = rd.results[rd.starter]?.rolls;
    order = E.orderFrom(rd.starter, n);
    for (const p of order) {
      const r = rd.results[p]; if (!r) continue;
      if (g.mode === 'dice') { assert.ok(r.rolls >= 1 && r.rolls <= mark, 'rolls within the mark'); assert.ok(r.pts >= 0 && r.pts <= 36); }
      seq++; if (r.pts > 0) at[p] = seq; scores[p] += r.pts;
    }
    if (ri < g.rounds.length - 1) assert.ok(Math.max(...scores) < E.LIMIT, 'game should have ended earlier');
    prev = rd.starter;
  });
  assert.deepEqual(scores, g.players.map(p => p.score), 'totals match the sheet');
  return { scores, order };
}

test('random dice games follow every rule, with the 7s found by hand or by the app', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = seeded(seed), n = 2 + (seed % 5), pairing = seed % 2 ? 'manual' : 'auto';
    let s = start(n, seed % n, 'dice', pairing);
    let guard = 0;
    while (s.phase !== 'over' && guard++ < 5000) {
      const t = s.game.turn;
      // by hand, the player spots most pairs but now and then misses one
      const seen = pairing === 'manual' && t.rolls > 0 ? E.matchPairs(t).filter(() => rng() > 1) : [];
      // rolling on or stopping with a 7-pair still on the table is called out, by hand only
      const left7 = pairing === 'manual' ? E.matchPairs(t).map(([a, b]) => [t.dice[a].value, t.dice[b].value]) : [];
      const missed = (r, how) => assert.deepEqual(r.events.filter(e => e.type === 'missed'),
        left7.length ? [{ type: 'missed', player: E.current(s.game), how, pairs: left7 }] : [], `missed on ${how}`);
      if (seen.length) s = must(s, { type: 'pair', a: seen[0][0], b: seen[0][1] }).state;
      else if (t.rolls === 0 || (E.canRoll(t) && rng() > 2)) { const r = must(s, { type: 'roll' }, { rng }); missed(r, 'roll'); s = r.state; }
      else {
        const left = E.sumActive(t), r = must(s, { type: 'stop' });
        assert.equal(r.events.find(e => e.type === 'turn').pts, pairing === 'manual' ? left : E.finalPenalty(t), 'what stays on the table counts');
        missed(r, 'stop');
        s = r.state;
      }
    }
    assert.equal(s.phase, 'over');
    const { scores, order } = checkSheet(s.game);
    assert.ok(Math.max(...scores) >= E.LIMIT);
    let L = null; for (const i of order) if (L === null || scores[i] >= scores[L]) L = i;
    assert.equal(s.game.loser, L, 'loser is the highest score, later player on a tie');
  }
});

test('the app can set 7-pairs aside automatically, and clearing all six is a Sevens Out', () => {
  let s = start(2, 0, 'dice', 'auto');
  const r = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 5, 3, 4]) });
  assert.equal(r.events[0].type, 'rolled');
  assert.equal(r.events[0].auto.length, 3);
  assert.ok(r.events.some(e => e.type === 'sevensOut' && e.player === 0));
  s = must(r.state, { type: 'stop' }).state;
  assert.equal(s.game.rounds[0].results[0].pts, 0);
  assert.equal(s.game.mark, 1, 'starter used one roll, so the limit is 1');
  assert.equal(s.game.turn.maxRolls, 1);
});

test('a pair from the current roll can be put back and paired by hand', () => {
  let s = start(2, 0, 'dice', 'auto');
  s = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 2, 3, 3]) }).state;
  assert.equal(s.game.turn.pairs.length, 1);
  s = must(s, { type: 'unpair', index: 0 }).state;
  assert.equal(s.game.turn.pairs.length, 0);
  assert.ok(E.apply(s, { type: 'pair', a: 2, b: 3 }).error, '2+2 is not 7');
  s = must(s, { type: 'pair', a: 0, b: 1 }).state;
  assert.equal(E.finalPenalty(s.game.turn), 10);
  s = must(s, { type: 'stop' }).state;
  assert.equal(s.game.players[0].score, 10);
});

test('by default the 7s are found by hand, and a missed pair counts when the player stops', () => {
  let s = start(2);
  assert.equal(s.game.pairing, 'manual');
  const r = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 5, 3, 3]) });
  assert.deepEqual(r.events[0].auto, [], 'nothing is set aside for the player');
  assert.equal(r.state.game.turn.pairs.length, 0);
  assert.equal(E.apply(r.state, { type: 'takeall' }).error, 'by_hand');
  s = must(r.state, { type: 'pair', a: 0, b: 1 }).state;
  s = must(s, { type: 'stop' }).state;
  assert.equal(s.game.players[0].score, 2 + 5 + 3 + 3, 'the 2 and 5 were missed');
});

test('by hand, a 7-pair left on the table is called out when the player rolls on or stops', () => {
  let s = start(2);
  let r = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 5, 3, 3]) });
  assert.ok(!r.events.some(e => e.type === 'missed'), 'nothing to miss before the first roll');
  s = must(r.state, { type: 'pair', a: 0, b: 1 }).state;
  r = must(s, { type: 'roll' }, { rng: faces([4, 1, 3, 6]) });
  assert.deepEqual(r.events.map(e => e.type), ['missed', 'rolled'], 'called out before the dice are rolled away');
  assert.deepEqual(r.events[0], { type: 'missed', player: 0, how: 'roll', pairs: [[2, 5]] });
  r = must(r.state, { type: 'stop' });
  assert.deepEqual(r.events[0], { type: 'missed', player: 0, how: 'stop', pairs: [[4, 3], [1, 6]] });
  assert.equal(r.state.game.players[0].score, 14, 'the missed pairs still count');
  s = must(r.state, { type: 'roll' }, { rng: faces([1, 1, 3, 3, 4, 2]) }).state;
  s = must(s, { type: 'pair', a: 2, b: 4 }).state;
  r = must(s, { type: 'stop' });
  assert.ok(!r.events.some(e => e.type === 'missed'), 'nothing left that makes 7');
});

test('nothing is called missed when the app finds the 7s, or in an old save', () => {
  for (const s of [start(2, 0, 'dice', 'auto'), (() => { const o = start(2); delete o.game.pairing; return o; })()]) {
    const r = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 5, 3, 3]) });
    const u = must(r.state, { type: 'unpair', index: 0 });
    for (const a of [{ type: 'roll' }, { type: 'stop' }]) assert.ok(!must(u.state, a, { rng: faces([2, 2]) }).events.some(e => e.type === 'missed'), a.type);
  }
});

test('by hand, setting aside all three pairs is a Sevens Out', () => {
  let s = start(2);
  s = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 5, 3, 4]) }).state;
  s = must(s, { type: 'pair', a: 0, b: 1 }).state;
  s = must(s, { type: 'pair', a: 3, b: 2 }).state;
  const r = must(s, { type: 'pair', a: 4, b: 5 });
  assert.ok(r.events.some(e => e.type === 'sevensOut' && e.player === 0));
  s = must(r.state, { type: 'stop' }).state;
  assert.equal(s.game.rounds[0].results[0].pts, 0);
});

test('a game saved before the 7s could be found by hand keeps setting them aside automatically', () => {
  const s = start(2);
  delete s.game.pairing;
  const r = must(s, { type: 'roll' }, { rng: faces([1, 6, 2, 5, 3, 3]) });
  assert.equal(r.state.game.turn.pairs.length, 2);
  assert.equal(must(r.state, { type: 'stop' }).state.game.players[0].score, 6);
});

test('the input state is never mutated and bad actions are refused', () => {
  const s = start(3), before = JSON.stringify(s);
  E.apply(s, { type: 'roll' });
  assert.equal(JSON.stringify(s), before);
  assert.equal(E.apply(s, { type: 'stop' }).error, 'phase', 'cannot stop before rolling');
  assert.equal(E.apply(s, { type: 'score', pts: 3 }).error, 'phase', 'not a scoreboard game');
  assert.equal(E.apply(s, { type: 'nope' }).error, 'unknown_action');
});

// scoreboard helpers
const score = (s, pts, rolls) => must(s, { type: 'score', pts, rolls }).state;

test('random scoreboard games follow every rule', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = seeded(seed * 7), n = 2 + (seed % 5);
    let s = start(n, 0, 'score'), guard = 0;
    while (s.phase !== 'over' && guard++ < 3000) {
      const pts = (rng() - 1) * 5 + (rng() - 1); // 0..30
      s = score(s, pts, s.game.pos === 0 ? 1 + (rng() % 3) : undefined);
    }
    checkSheet(s.game);
  }
});

test('tie for the lead: whoever reached the score first starts', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);
  assert.deepEqual([s.game.round, s.game.starter], [2, 1]);
  s = score(s, 0, 2); s = score(s, 10);       // Ben stays on 20, Anna climbs to 20
  assert.deepEqual(s.game.players.map(p => p.score), [20, 20]);
  assert.deepEqual([s.game.round, s.game.starter], [3, 1], 'Ben got to 20 first');
  s = score(s, 5, 1); s = score(s, 5);        // Ben 25 first, then Anna 25
  assert.deepEqual([s.game.round, s.game.starter], [4, 1]);
});

test('a tie when nobody has scored passes the start to the next player', () => {
  let s = start(3, 1, 'score');
  s = score(s, 0, 1); s = score(s, 0); s = score(s, 0);
  assert.deepEqual([s.game.round, s.game.starter], [2, 2]);
});

test('reaching 101 finishes the round, and a tie at the top goes against the later player', () => {
  let s = start(2, 0, 'score');
  s.game.players = [{ name: 'A', score: 0 }, { name: 'B', score: 0 }];
  for (let i = 0; i < 2; i++) { s = score(s, 36, 3); s = score(s, 36); }
  s = score(s, 30, 1);                         // A 102: round continues
  assert.equal(s.phase, 'play');
  assert.ok(s.game.ending);
  s = score(s, 30);                            // B 102 as well: tie, B played later
  assert.equal(s.phase, 'over');
  assert.equal(s.game.loser, 1);
});

test('dropped dice: the third pays a round of shots, and undo takes it back', () => {
  let s = start(2, 0, 'score');
  s = must(s, { type: 'drop' }).state;
  s = must(s, { type: 'drop' }).state;
  const r = must(s, { type: 'drop' });
  assert.ok(r.events.some(e => e.type === 'shots' && e.player === 0));
  assert.equal(r.state.game.drops, 0);
  assert.equal(r.state.game.shots.length, 1);
  const u = must(r.state, { type: 'undo' });
  assert.equal(u.state.game.drops, 2);
  assert.equal(u.state.game.shots.length, 0);
  assert.equal(u.events[0].msg, 'The last dropped die was taken back.');
});

test('corrections recompute totals, the next starter and the 101 rule', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);
  s = must(s, { type: 'edit', player: 1, values: { 1: 5 } }).state;
  assert.deepEqual(s.game.players.map(p => p.score), [10, 5]);
  assert.deepEqual([s.game.round, s.game.starter], [2, 0]);
  assert.equal(E.apply(s, { type: 'edit', player: 1, values: { 1: 40 } }).error, 'pts');
  assert.equal(E.apply(s, { type: 'edit', player: 1, values: { 1: 5 } }).error, 'no_change');
  s = score(s, 30, 1); s = score(s, 0);
  s = must(s, { type: 'edit', player: 0, values: { 1: 36, 2: 36 } }).state; // A 72 between rounds
  assert.deepEqual([s.game.round, s.game.starter], [3, 0]);
  s = score(s, 30, 1); s = score(s, 0);       // A 102 -> over
  assert.equal(s.phase, 'over');
  s = must(s, { type: 'edit', player: 0, values: { 3: 10 } }).state;        // back to 82 -> the next round starts
  assert.deepEqual([s.phase, s.game.round], ['play', 4]);
  s = must(s, { type: 'undo' }).state;
  assert.equal(s.phase, 'over');
});

// ---------- rounds move on by themselves ----------
test('the next round starts by itself when the last player of a round finishes', () => {
  let s = start(3, 0, 'score');
  s = score(s, 12, 2); s = score(s, 30);
  const r = must(s, { type: 'score', pts: 4 });
  assert.deepEqual(r.events.map(e => e.type), ['turn', 'roundEnd', 'started']);
  assert.deepEqual(r.events[1], { type: 'roundEnd', round: 1, next: 1 });
  const g = r.state.game;
  assert.equal(r.state.phase, 'play');
  assert.deepEqual([g.round, g.starter, g.pos, g.mark, g.next, g.last], [2, 1, 0, null, null, null]);
  assert.deepEqual(g.order, [1, 2, 0]);
  assert.deepEqual(g.rounds.at(-1), { no: 2, starter: 1, results: {} });
  assert.equal(g.turn.maxRolls, 3);
});

test('a dice round that ends with a Sevens Out announces it before the round change', () => {
  // the app finds the 7s, but P2 rolls without setting them aside, so all six come out when P2 stops
  let s = start(2, 0, 'dice', 'auto');
  s = must(s, { type: 'roll' }, { rng: faces([2]) }).state;
  s = must(s, { type: 'stop' }).state;                                        // P1 leaves 12 after one roll
  s = must(s, { type: 'roll', auto: false }, { rng: faces([1, 6, 2, 5, 3, 4]) }).state;
  const r = must(s, { type: 'stop' });
  assert.deepEqual(r.events.map(e => e.type), ['sevensOut', 'turn', 'roundEnd', 'started']);
  assert.equal(r.events[0].player, 1);
  assert.deepEqual(r.events.slice(-2), [{ type: 'roundEnd', round: 1, next: 0 }, { type: 'started', starter: 0 }]);
  assert.deepEqual([r.state.phase, r.state.game.round, r.state.game.starter], ['play', 2, 0]);
  assert.deepEqual(r.state.game.rounds[0].results, { 0: { pts: 12, rolls: 1 }, 1: { pts: 0, rolls: 1 } });
});

test('nextround only moves on a game saved between rounds', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);
  assert.equal(E.apply(s, { type: 'nextround' }).error, 'phase');
  const old = legacyRoundEnd(s);
  assert.equal(old.phase, 'roundEnd');
  const r = must(old, { type: 'nextround' });
  assert.deepEqual(r.events.map(e => e.type), ['started']);
  assert.deepEqual(r.state, s);
});

test('a correction in a game saved between rounds moves it on to the next round', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);
  const r = must(legacyRoundEnd(s), { type: 'edit', player: 1, values: { 1: 5 } });
  assert.deepEqual(r.events.map(e => e.type), ['edited']);
  assert.deepEqual([r.state.phase, r.state.game.round, r.state.game.starter, r.state.game.next], ['play', 2, 0, null]);
  assert.deepEqual(r.state.game.rounds[1], { no: 2, starter: 0, results: {} });
});

test('a correction before anyone plays the new round re-applies the starter rule', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);                 // B leads, B starts round 2
  assert.equal(s.game.starter, 1);
  const r = must(s, { type: 'edit', player: 1, values: { 1: 5 } });
  assert.deepEqual(r.events.map(e => e.type), ['edited']);
  const g = r.state.game;
  assert.equal(r.state.phase, 'play');
  assert.deepEqual([g.round, g.starter, g.rounds.length], [2, 0, 2]);
  assert.deepEqual(g.order, [0, 1]);
  assert.deepEqual(g.rounds[1], { no: 2, starter: 0, results: {} });
});

test('dropped dice before anyone plays the new round keep the correction window open, and a restarted round keeps them', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);                 // B starts round 2
  for (let i = 0; i < 4; i++) s = must(s, { type: 'drop' }).state;   // B pays a round of shots, and one more die falls
  const g = must(s, { type: 'edit', player: 1, values: { 1: 5 } }).state.game;
  assert.deepEqual([g.round, g.starter, g.drops], [2, 0, 1]);
  assert.deepEqual(g.shots, [{ player: 1, round: 2 }]);
});

test('a correction before anyone plays the new round can end the game, and shots move to the finished round', () => {
  let s = start(2, 0, 'score');
  for (let i = 0; i < 3; i++) { s = score(s, 30, 1); s = score(s, 20); }   // A 90, B 60, round 4 starts with A
  s = must(s, { type: 'drop' }).state; s = must(s, { type: 'drop' }).state; s = must(s, { type: 'drop' }).state;
  assert.deepEqual(s.game.shots, [{ player: 0, round: 4 }]);
  const r = must(s, { type: 'edit', player: 0, values: { 1: 36, 2: 36, 3: 36 } });  // A 108
  const g = r.state.game;
  assert.equal(r.state.phase, 'over');
  assert.deepEqual([g.round, g.rounds.length, g.loser, g.crosser, g.ending, !!g.early], [3, 3, 0, 0, true, false]);
  assert.deepEqual(g.shots, [{ player: 0, round: 3 }]);
});

test('a correction at game over that takes everyone below 101 starts the next round', () => {
  let s = start(2, 0, 'score');
  for (let i = 0; i < 3; i++) { s = score(s, 36, 1); s = score(s, 0); }     // A 108 in round 3: over
  assert.equal(s.phase, 'over');
  const r = must(s, { type: 'edit', player: 0, values: { 3: 10 } });         // A 82
  assert.equal(r.state.phase, 'play');
  assert.deepEqual([r.state.game.round, r.state.game.starter], [4, 0]);
  assert.equal(must(r.state, { type: 'undo' }).state.phase, 'over');
});

test('undo right after a round ends goes back into that round, and entering the score again moves on again', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);
  const u = must(s, { type: 'undo' }).state;
  assert.deepEqual([u.phase, u.game.round, u.game.pos], ['play', 1, 1]);
  const again = must(u, { type: 'score', pts: 20 });
  assert.deepEqual(again.events.map(e => e.type), ['turn', 'roundEnd', 'started']);
});

test('ending early before anyone plays the new round counts only the finished round', () => {
  let s = start(3, 0, 'score');
  s = score(s, 12, 1); s = score(s, 30); s = score(s, 4);                   // round 2 starts with B
  s = must(s, { type: 'drop' }).state; s = must(s, { type: 'drop' }).state; s = must(s, { type: 'drop' }).state;
  const r = must(s, { type: 'endearly' });
  const g = r.state.game;
  assert.deepEqual([r.state.phase, g.round, g.rounds.length, g.loser, g.early], ['over', 1, 1, 1, true]);
  assert.deepEqual(g.shots, [{ player: 1, round: 1 }]);
  assert.ok(checkReport({ id: '0123456789abcdef', mode: 'score', startedAt: 1, finishedAt: 2, sheet: sheetOf(g) }, E, 3).ok);
});

test('ending early: the highest score loses and the game is marked early', () => {
  let s = start(3, 0, 'score');
  s = score(s, 12, 1); s = score(s, 3);
  const r = must(s, { type: 'endearly' });
  assert.equal(r.state.phase, 'over');
  assert.equal(r.state.game.loser, 0);
  assert.ok(r.state.game.early);
});

test('undo to a snapshot taken between rounds by an older version moves on to the next round', () => {
  let s = start(2, 0, 'score');
  s = score(s, 10, 1); s = score(s, 20);
  const old = legacyRoundEnd(s), snapGame = E.clone(old.game);
  delete snapGame.history;
  const state = E.clone(s);
  state.game.history = [JSON.stringify({ phase: 'roundEnd', game: snapGame, msg: 'x' })];
  const r = must(state, { type: 'undo' });
  assert.deepEqual(r.events.map(e => e.type), ['undone', 'started']);
  assert.deepEqual([r.state.phase, r.state.game.round, r.state.game.starter], ['play', 2, 1]);
  assert.deepEqual(r.state.game.history, []);
  const direct = must(old, { type: 'nextround' }).state;
  delete direct.game.history; const got = E.clone(r.state); delete got.game.history;
  assert.deepEqual(got, direct);
});

// 42/18 rules engine tests: run with `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';

const E = globalThis.SevensEngine;

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
const start = (n, starter = 0, mode = 'dice') =>
  must(E.blank(), { type: 'start', names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter, mode, kind: '4218' }).state;
// one real-dice turn
const scored = (s, pts, rolls = 1) => must(s, { type: 'score', pts, rolls });
const score = (s, pts, rolls = 1) => scored(s, pts, rolls).state;

test('a throw counts the three dice besides a 4 and a 2', () => {
  assert.equal(E.throwPts([4, 2, 6, 6, 6]), 18);
  assert.equal(E.throwPts([6, 4, 5, 2, 6]), 17);
  assert.equal(E.throwPts([1, 1, 2, 1, 4]), 3);
  assert.equal(E.throwPts([4, 4, 2, 2, 3]), 9); // the other 4 and 2 count as points
  assert.equal(E.throwPts([4, 6, 6, 6, 6]), 0);
  assert.equal(E.throwPts([2, 6, 6, 6, 6]), 0);
});

test('the lowest throw loses the round; a tie goes against more rolls, then the later player', () => {
  const rd = (starter, results) => ({ starter, results });
  assert.equal(E.roundLoser(rd(0, { 0: { pts: 12, rolls: 1 }, 1: { pts: 0, rolls: 1 }, 2: { pts: 5, rolls: 3 } }), 3), 1);
  assert.equal(E.roundLoser(rd(0, { 0: { pts: 7, rolls: 3 }, 1: { pts: 7, rolls: 1 }, 2: { pts: 9, rolls: 1 } }), 3), 0);
  assert.equal(E.roundLoser(rd(0, { 0: { pts: 7, rolls: 2 }, 1: { pts: 7, rolls: 2 }, 2: { pts: 9, rolls: 1 } }), 3), 1);
  // the order follows the round's starter: P3 started, so P1 played after P3
  assert.equal(E.roundLoser(rd(2, { 0: { pts: 0, rolls: 3 }, 1: { pts: 4, rolls: 1 }, 2: { pts: 0, rolls: 3 } }), 3), 0);
});

test('a 42/18 game starts with five dice and no pairs; Sevens Out games stay as they were', () => {
  const s = start(3, 1);
  assert.equal(s.game.kind, '4218');
  assert.equal(s.game.turn.dice.length, 5);
  assert.equal(s.game.turn.maxRolls, 5);
  assert.deepEqual(s.game.order, [1, 2, 0]);
  const old = must(E.blank(), { type: 'start', names: ['A', 'B'], starter: 0, mode: 'dice' }).state;
  assert.equal(old.game.kind, undefined);
  assert.equal(old.game.turn.dice.length, 6);
});

test('after a roll at least one die is kept before the next; a die kept in this roll can go back', () => {
  let s = start(3);
  assert.equal(E.apply(s, { type: 'keep', id: 0 }).error, 'phase');
  s = must(s, { type: 'roll' }, { rng: faces([4, 1, 3, 5, 6]) }).state;
  assert.equal(E.apply(s, { type: 'roll' }).error, 'keep_one');
  assert.equal(E.apply(s, { type: 'pair', a: 2, b: 0 }).error, 'unknown_action');
  assert.equal(E.apply(s, { type: 'takeall' }).error, 'unknown_action');
  const k = must(s, { type: 'keep', id: 0 });
  assert.deepEqual(k.events, [{ type: 'kept', id: 0, value: 4 }]);
  s = k.state;
  assert.equal(E.apply(s, { type: 'keep', id: 0 }).error, 'bad_die');
  s = must(s, { type: 'unkeep', id: 0 }).state;
  assert.equal(s.game.turn.dice[0].held, null);
  s = must(s, { type: 'keep', id: 0 }).state;
  s = must(s, { type: 'keep', id: 4 }).state;
  s = must(s, { type: 'roll' }, { rng: faces([2, 6, 6]) }).state;
  assert.deepEqual(s.game.turn.dice.map(d => d.value), [4, 2, 6, 6, 6]);
  // dice kept in an earlier roll stay kept
  assert.equal(E.apply(s, { type: 'unkeep', id: 0 }).error, 'locked');
  // 42/18 can only end the turn
  assert.ok(E.ftPerfect(s.game.turn));
  s = must(s, { type: 'keep', id: 1 }).state;
  assert.equal(E.apply(s, { type: 'roll' }).error, 'perfect');
  const stop = must(s, { type: 'stop' });
  assert.deepEqual(stop.events.map(e => e.type), ['perfect', 'turn']);
  assert.deepEqual(stop.state.game.rounds[0].results[0], { pts: 18, rolls: 2 });
});

test('a turn rolls on while dice are left, one kept each time: five rolls at most', () => {
  let s = start(2);
  for (let r = 0; r < 5; r++) {
    s = must(s, { type: 'roll' }, { rng: faces([1]) }).state;
    if (r < 4) s = must(s, { type: 'keep', id: r }).state;
  }
  assert.equal(E.active(s.game.turn).length, 1);
  assert.equal(E.apply(s, { type: 'roll' }).error, 'no_rolls');
  const r = must(s, { type: 'end' });
  assert.deepEqual(r.state.game.rounds[0].results[0], { pts: 0, rolls: 5 });
  assert.equal(r.state.game.pos, 1);
  // keeping all five ends the rolling earlier
  let t = start(2);
  t = must(t, { type: 'roll' }, { rng: faces([4, 2, 6, 6, 5]) }).state;
  for (let id = 0; id < 5; id++) t = must(t, { type: 'keep', id }).state;
  assert.equal(E.apply(t, { type: 'roll' }).error, 'no_rolls');
  assert.deepEqual(must(t, { type: 'stop' }).state.game.rounds[0].results[0], { pts: 17, rolls: 1 });
});

test('the round loser takes a coaster and starts the next round; the first to 3 coasters loses', () => {
  let s = start(3, 0, 'score');
  // round 1: P2 has no 42
  s = score(s, 10); s = score(s, 0); const r1 = scored(s, 5);
  assert.deepEqual(r1.events.map(e => e.type), ['turn', 'roundEnd', 'started']);
  assert.deepEqual(r1.events[1], { type: 'roundEnd', round: 1, next: 1, loser: 1 });
  s = r1.state;
  assert.deepEqual(s.game.players.map(p => p.score), [0, 1, 0]);
  assert.equal(s.game.starter, 1);
  assert.deepEqual(s.game.order, [1, 2, 0]);
  const recap = E.roundRecap(s.game);
  assert.equal(recap.kind, '4218');
  assert.deepEqual([recap.next, recap.pts, recap.before, recap.after], [1, [0, 1, 0], [0, 0, 0], [0, 1, 0]]);
  assert.deepEqual(recap.best, { kind: 'no42', player: 1, value: null });
  assert.deepEqual(recap.reason, { kind: 'low', score: 0 });
  // round 2 (P2, P3, P1): P2 again, so P2 is one coaster from losing
  s = score(s, 3); s = score(s, 4); s = score(s, 9);
  assert.deepEqual(E.roundRecap(s.game).best, { kind: 'lastCoaster', player: 1, value: 2 });
  // round 3: a tie on 6, P1 needed more rolls
  s = score(s, 12); s = score(s, 6, 1); const end = scored(s, 6, 3);
  assert.deepEqual(end.state.game.players.map(p => p.score), [1, 2, 0]);
  assert.equal(end.state.game.starter, 0);
  assert.deepEqual(E.roundRecap(end.state.game).reason, { kind: 'rolls', score: 6 });
  s = end.state;
  // round 4 (P1, P2, P3): P2 takes the third coaster
  s = score(s, 8); s = score(s, 7); const over = scored(s, 8);
  assert.equal(over.state.phase, 'over');
  assert.equal(over.state.game.loser, 1);
  assert.deepEqual(over.events.map(e => e.type), ['turn', 'gameOver']);
});

test('real dice: points are 0 (no 42) or 3 to 18, and everyone gives the rolls used (1 to 5)', () => {
  const s = start(2, 0, 'score');
  for (const pts of [1, 2, 19, -1, 4.5]) assert.equal(E.apply(s, { type: 'score', pts, rolls: 1 }).error, 'pts');
  assert.equal(E.apply(s, { type: 'score', pts: 9 }).error, 'rolls');
  assert.equal(E.apply(s, { type: 'score', pts: 9, rolls: 6 }).error, 'rolls');
  assert.ok(!E.apply(s, { type: 'score', pts: 9, rolls: 5 }).error, 'up to five rolls');
  const next = score(s, 9, 2);
  assert.equal(E.apply(next, { type: 'score', pts: 9 }).error, 'rolls'); // not only the starter
  const u = must(next, { type: 'undo' });
  assert.deepEqual(u.state.game.rounds[0].results, {});
});

test('corrections count the coasters again and restart the round with the right loser', () => {
  let s = start(3, 0, 'score');
  s = score(s, 10); s = score(s, 0); s = score(s, 5); // P2 lost round 1
  assert.equal(s.game.starter, 1);
  // between rounds: P3's 5 becomes no 42 too, so P3 (later) lost and starts round 2 instead
  const e = must(s, { type: 'edit', player: 2, values: { 1: 0 } });
  assert.deepEqual(e.state.game.players.map(p => p.score), [0, 0, 1]);
  assert.equal(e.state.game.starter, 2);
  assert.equal(e.state.game.rounds.length, 2);
  assert.equal(E.apply(s, { type: 'edit', player: 2, values: { 1: 2 } }).error, 'pts');
  // a game that is over goes on when the correction takes the third coaster away
  let g = start(2, 0, 'score');
  for (let r = 0; r < 3; r++) { // P2 loses three times (and so starts rounds 2 and 3)
    if (g.game.starter === 0) { g = score(g, 10); g = score(g, 4); } else { g = score(g, 4); g = score(g, 10); }
  }
  assert.equal(g.phase, 'over');
  const back = must(g, { type: 'edit', player: 1, values: { 3: 12 } }).state;
  assert.equal(back.phase, 'play');
  assert.deepEqual(back.game.players.map(p => p.score), [1, 2]);
  assert.equal(back.game.round, 4);
  assert.equal(back.game.starter, 0);
});

test('whoever throws 42/18 is out for the rest of the game; the last player left loses', () => {
  let s = start(4, 0, 'score');
  const p = scored(s, 18, 3);
  assert.deepEqual(p.events.map(e => e.type), ['perfect', 'turn']);
  s = p.state;
  assert.equal(s.game.players[0].out, 1);
  assert.deepEqual(E.ftLeft(s.game), [1, 2, 3]);
  s = score(s, 7); s = score(s, 5); s = score(s, 9); // P3 lost round 1 and starts round 2, without P1
  assert.deepEqual(s.game.players.map(pl => pl.score), [0, 0, 1, 0]);
  assert.deepEqual(s.game.order, [2, 3, 1]);
  assert.deepEqual(E.ftPlays(s.game, 1), [0, 1, 2, 3]);
  assert.deepEqual(E.ftPlays(s.game, 2), [1, 2, 3]);
  // a 42/18 can't be corrected into or out of (Undo can)
  assert.equal(E.apply(s, { type: 'edit', player: 0, values: { 1: 17 } }).error, 'perfect_fixed');
  assert.equal(E.apply(s, { type: 'edit', player: 1, values: { 1: 18 } }).error, 'perfect_fixed');
  // ending early never picks a player who is out, even with the most coasters
  s = score(s, 4); s = score(s, 18, 2); s = score(s, 10); // P3 lost again; P4 is out
  assert.deepEqual(s.game.order, [2, 1]);
  const early = must(s, { type: 'endearly' }).state;
  assert.equal(early.game.loser, 2);
  // the third 42/18 leaves P3 alone: P3 loses at once, mid-round
  const last = scored(s, 18, 1);
  assert.deepEqual(last.events.map(e => e.type), ['perfect', 'turn', 'gameOver']);
  assert.equal(last.state.phase, 'over');
  assert.equal(last.state.game.loser, 1);
  assert.equal(last.state.game.left, true);
  assert.equal(last.state.game.players[1].score, 0); // no third coaster needed
  const back = must(last.state, { type: 'undo' }).state;
  assert.equal(back.phase, 'play');
  assert.equal(back.game.players[2].out, undefined);
});

test('ending early: the most coasters lose', () => {
  let s = start(3, 0, 'score');
  s = score(s, 10); s = score(s, 0); s = score(s, 5);
  const r = must(s, { type: 'endearly' });
  assert.equal(r.state.phase, 'over');
  assert.equal(r.state.game.loser, 1);
  assert.equal(r.state.game.rounds.length, 1); // the empty round is dropped
});

test('random 42/18 games follow every rule', () => {
  let lefts = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const rng = seeded(seed), n = 2 + (seed % 11), real = seed % 2 === 0;
    let s = start(n, seed % n, real ? 'score' : 'dice'), guard = 0;
    while (s.phase !== 'over' && guard++ < 20000) {
      if (real) { // real dice: a 42/18 now and then, so players go out and some games end with one player left
        const pts = rng() === 6 && rng() > 3 ? 18 : rng() === 1 ? 0 : 2 + rng() + rng();
        s = score(s, pts, rng() % 5 + 1);
        continue;
      }
      const t = s.game.turn;
      if (t.rolls && (!E.canRoll(t) || E.ftPerfect(t) || rng() === 6)) { s = must(s, { type: 'stop' }).state; continue; }
      if (t.rolls) {
        // keep one to three dice from this roll, the 4s and 2s first
        const table = E.active(t).sort((a, b) => [4, 2].includes(b.value) - [4, 2].includes(a.value));
        const keep = Math.min(table.length, 1 + (rng() % 3));
        for (const d of table.slice(0, keep)) s = must(s, { type: 'keep', id: d.id }).state;
        if (!E.canRoll(s.game.turn) || E.ftPerfect(s.game.turn)) { s = must(s, { type: 'stop' }).state; continue; }
      }
      s = must(s, { type: 'roll' }, { rng }).state;
    }
    assert.equal(s.phase, 'over', `seed ${seed} finished`);
    const g = s.game, coasters = Array(n).fill(0), last = g.rounds.length - 1;
    g.rounds.forEach((rd, ri) => {
      const plays = g.players.map((_, i) => i).filter(i => g.players[i].out == null || g.players[i].out >= rd.no);
      for (const i of Object.keys(rd.results)) assert.ok(plays.includes(+i), 'nobody out plays on');
      g.players.forEach((pl, i) => { if (pl.out === rd.no) assert.equal(rd.results[i].pts, 18, 'out with a 42/18'); });
      for (const [i, r] of Object.entries(rd.results)) if (r.pts === 18) assert.equal(g.players[i].out, rd.no, 'a 42/18 puts the player out');
      if (ri === last && g.left) { // the game ended mid-round: one player was left
        assert.deepEqual(g.players.map((_, i) => i).filter(i => g.players[i].out == null), [g.loser]);
        assert.equal(rd.loser, undefined);
        return;
      }
      assert.equal(Object.keys(rd.results).length, plays.length, `round ${rd.no} complete`);
      for (const r of Object.values(rd.results)) {
        assert.ok(r.rolls >= 1 && r.rolls <= 5, 'rolls within 5');
        assert.ok(r.pts === 0 || (r.pts >= 3 && r.pts <= 18), 'points of a throw');
      }
      const low = Math.min(...Object.values(rd.results).map(r => r.pts));
      assert.equal(rd.results[rd.loser].pts, low, 'the lowest throw lost');
      coasters[rd.loser]++;
      if (ri) assert.equal(rd.starter, g.rounds[ri - 1].loser, 'the loser starts the next round');
      if (ri < g.rounds.length - 1) assert.ok(Math.max(...coasters) < 3, 'the game should have ended earlier');
    });
    assert.deepEqual(coasters, g.players.map(p => p.score), 'coasters match the sheet');
    if (g.left) { lefts++; continue; }
    assert.equal(g.players[g.loser].score, 3);
    assert.equal(g.loser, g.rounds.at(-1).loser);
  }
  assert.ok(lefts > 0, 'some games end with one player left');
});

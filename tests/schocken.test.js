// Schocken rules engine tests: run with `node --test tests/`
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
  must(E.blank(), { type: 'start', names: Array.from({ length: n }, (_, i) => `P${i + 1}`), starter, mode, kind: 'schocken' }).state;
// one real-dice turn
const scored = (s, dice, rolls = 1, more = {}) => must(s, { type: 'score', dice, rolls, ...more });
const score = (s, dice, rolls = 1, more) => scored(s, dice, rolls, more).state;
// a dice turn: roll with these faces and stop
const turn = (s, values) => must(must(s, { type: 'roll' }, { rng: faces(values) }).state, { type: 'stop' });

test('throws rank Schock out, Schock, General, Straight, then numbers; General and Straight only from the hand', () => {
  const t = (d, hand = true) => E.skThrow(d, hand);
  assert.deepEqual([t([1, 1, 1]).cat, t([1, 1, 1]).worth], ['out', 13]);
  assert.deepEqual([t([1, 6, 1]).cat, t([1, 6, 1]).value, t([1, 6, 1]).worth], ['schock', 6, 6]);
  assert.deepEqual([t([2, 1, 1]).worth, t([5, 5, 5]).cat, t([5, 5, 5]).worth], [2, 'general', 3]);
  assert.deepEqual([t([4, 6, 5]).cat, t([4, 6, 5]).worth, t([3, 2, 1]).cat], ['straight', 2, 'straight']);
  assert.deepEqual([t([6, 5, 3]).cat, t([6, 5, 3]).value, t([6, 5, 3]).worth], ['number', 653, 1]);
  // built (dice set aside, or a 6 turned), a General or a Straight is just a number
  assert.deepEqual([t([5, 5, 5], false).cat, t([5, 5, 5], false).value], ['number', 555]);
  assert.equal(t([4, 5, 6], false).value, 654);
  assert.equal(t([1, 1, 3], false).cat, 'schock'); // a Schock always counts
  const order = [[1, 1, 1], [6, 1, 1], [2, 1, 1], [6, 6, 6], [2, 2, 2], [4, 5, 6], [1, 2, 3], [6, 6, 5], [6, 5, 4, false], [2, 2, 1]];
  for (let k = 1; k < order.length; k++) {
    const a = order[k - 1], b = order[k];
    assert.ok(t(a.slice(0, 3), a[3] !== false).rank > t(b.slice(0, 3), b[3] !== false).rank, `${a} beats ${b}`);
  }
});

test('a tie goes to fewer rolls, then to the earlier player', () => {
  const r = (dice, rolls) => ({ dice, hand: false, rolls });
  assert.ok(E.skBetter(r([6, 5, 3], 1), 1, r([6, 5, 3], 2), 0));
  assert.ok(E.skBetter(r([6, 5, 3], 2), 0, r([6, 5, 3], 2), 1));
  assert.ok(!E.skBetter(r([6, 5, 3], 2), 1, r([6, 5, 3], 2), 0));
  const rd = { results: { 0: r([4, 2, 1], 3), 1: r([4, 2, 1], 3), 2: r([6, 6, 1], 1) } };
  assert.deepEqual(E.skExtremes(rd, [0, 1, 2]), { high: 2, low: 1 });
  assert.deepEqual(E.skExtremes(rd, [1, 2, 0]), { high: 2, low: 0 });
});

test('a Schocken game starts with three dice, a pot of 13 and the first half; the other games stay as they were', () => {
  const s = start(3, 1);
  assert.equal(s.game.kind, 'schocken');
  assert.equal(s.game.turn.dice.length, 3);
  assert.equal(s.game.turn.maxRolls, 3);
  assert.deepEqual([s.game.half, s.game.pot, s.game.halves], [1, 13, []]);
  assert.deepEqual(s.game.order, [1, 2, 0]);
  const old = must(E.blank(), { type: 'start', names: ['A', 'B'], starter: 0, mode: 'dice' }).state;
  assert.equal(old.game.kind, undefined);
  assert.equal(old.game.turn.dice.length, 6);
});

test('dice are set aside and rolled again freely; a die set aside in this roll can go back; the starter sets the limit', () => {
  let s = start(2);
  assert.equal(E.apply(s, { type: 'keep', id: 0 }).error, 'phase');
  s = must(s, { type: 'roll' }, { rng: faces([1, 4, 3]) }).state;
  assert.equal(E.apply(s, { type: 'pair', a: 0, b: 1 }).error, 'unknown_action');
  assert.equal(E.apply(s, { type: 'edit', player: 0, values: {} }).error, 'unknown_action');
  s = must(s, { type: 'roll' }, { rng: faces([1, 1, 5]) }).state; // nothing set aside: all three again
  assert.deepEqual(s.game.turn.dice.map(d => d.value), [1, 1, 5]);
  s = must(s, { type: 'keep', id: 0 }).state;
  s = must(s, { type: 'keep', id: 1 }).state;
  s = must(s, { type: 'unkeep', id: 1 }).state;
  s = must(s, { type: 'keep', id: 1 }).state;
  const stop = must(s, { type: 'stop' });
  assert.deepEqual(stop.state.game.rounds[0].results[0], { dice: [5, 1, 1], hand: true, rolls: 2, pts: 5 });
  assert.equal(stop.state.game.mark, 2);
  assert.equal(stop.state.game.turn.maxRolls, 2);
  s = must(stop.state, { type: 'roll' }, { rng: faces([2, 3, 4]) }).state;
  s = must(s, { type: 'keep', id: 0 }).state;
  s = must(s, { type: 'roll' }, { rng: faces([5, 6]) }).state;
  assert.equal(E.apply(s, { type: 'roll' }).error, 'no_rolls');
  assert.equal(E.apply(s, { type: 'unkeep', id: 0 }).error, 'locked'); // set aside in an earlier roll
});

test('two 6s turn into a 1 and the other 6 goes back into the cup; three 6s into two 1s; never on the last roll', () => {
  let s = start(2);
  s = must(s, { type: 'roll' }, { rng: faces([6, 3, 6]) }).state;
  const f = must(s, { type: 'flip' });
  assert.deepEqual(f.events, [{ type: 'flipped', ids: [0], back: 2 }]);
  s = f.state;
  assert.deepEqual(s.game.turn.dice.map(d => [d.value, d.held]), [[1, 1], [3, null], [6, null]]);
  assert.equal(E.apply(s, { type: 'keep', id: 2 }).error, 'flip_back');
  assert.equal(E.apply(s, { type: 'stop' }).error, 'flip_roll');
  assert.equal(E.apply(s, { type: 'flip' }).error, 'no_sixes');
  // putting the 1 back undoes the turn: two 6s again
  const u = must(s, { type: 'unkeep', id: 0 });
  assert.deepEqual(u.state.game.turn.dice.map(d => [d.value, d.held]), [[6, null], [3, null], [6, null]]);
  s = must(s, { type: 'keep', id: 1 }).state;
  s = must(s, { type: 'roll' }, { rng: faces([1]) }).state;
  assert.deepEqual(s.game.turn.dice.map(d => d.value), [1, 3, 1]);
  const stop = must(s, { type: 'stop' });
  assert.deepEqual(stop.state.game.rounds[0].results[0], { dice: [3, 1, 1], hand: false, rolls: 2, pts: 3 });
  // a 6 set aside in this roll still turns
  let k = must(start(2), { type: 'roll' }, { rng: faces([6, 6, 3]) }).state;
  k = must(k, { type: 'keep', id: 0 }).state;
  assert.ok(E.canFlip(k.game.turn));
  k = must(k, { type: 'flip' }).state;
  assert.deepEqual(k.game.turn.dice.map(d => [d.value, d.held]), [[1, 1], [6, null], [3, null]]);
  // three 6s: two 1s, one die rolled again
  s = must(start(2), { type: 'roll' }, { rng: faces([6, 6, 6]) }).state;
  s = must(s, { type: 'flip' }).state;
  assert.deepEqual(s.game.turn.dice.map(d => d.value), [1, 1, 6]);
  // the last roll can't turn a 6
  s = must(start(2), { type: 'roll' }, { rng: faces([1]) }).state;
  s = must(s, { type: 'roll' }, { rng: faces([1]) }).state;
  s = must(s, { type: 'roll' }, { rng: faces([6, 6, 2]) }).state;
  assert.equal(E.apply(s, { type: 'flip' }).error, 'no_sixes');
  // 6s from an earlier roll don't turn
  s = must(start(2), { type: 'roll' }, { rng: faces([6, 2, 3]) }).state;
  s = must(s, { type: 'keep', id: 0 }).state;
  s = must(s, { type: 'roll' }, { rng: faces([6, 4]) }).state;
  assert.equal(E.apply(s, { type: 'flip' }).error, 'no_sixes');
});

test('a General from one roll is a General; built from dice set aside it is a number', () => {
  let s = start(2);
  s = must(s, { type: 'roll' }, { rng: faces([5, 5, 2]) }).state;
  s = must(s, { type: 'keep', id: 0 }).state;
  s = must(s, { type: 'keep', id: 1 }).state;
  s = must(s, { type: 'roll' }, { rng: faces([5]) }).state;
  s = must(s, { type: 'stop' }).state;
  assert.deepEqual(s.game.rounds[0].results[0], { dice: [5, 5, 5], hand: false, rolls: 2, pts: 1 });
  s = must(s, { type: 'roll' }, { rng: faces([1, 2, 3]) }).state;
  s = must(s, { type: 'roll' }, { rng: faces([4, 4, 4]) }).state;
  const r = must(s, { type: 'stop' });
  // P2's General (from the hand, in its second roll) beats P1's 555: P1 takes 3 from the pot
  assert.deepEqual(r.state.game.rounds[0].results[1], { dice: [4, 4, 4], hand: true, rolls: 2, pts: 3 });
  assert.deepEqual(r.state.game.players.map(p => p.score), [3, 0]);
  assert.equal(r.state.game.pot, 10);
});

test('the lowest throw takes what the highest is worth from the pot; the loser starts the next round', () => {
  let s = start(3, 0, 'score');
  s = score(s, [6, 5, 3], 2);
  s = score(s, [1, 1, 4], 1);
  const r = scored(s, [3, 2, 2], 2);
  assert.deepEqual(r.events.map(e => e.type), ['turn', 'roundEnd', 'started']);
  assert.deepEqual(r.events[1], { type: 'roundEnd', round: 1, next: 2, loser: 2, high: 1, take: 4 });
  const g = r.state.game;
  assert.deepEqual([g.players.map(p => p.score), g.pot, g.round, g.starter, g.order], [[0, 0, 4], 9, 2, 2, [2, 0, 1]]);
  assert.deepEqual([g.rounds[0].loser, g.rounds[0].high, g.rounds[0].take, g.rounds[0].from, g.rounds[0].after], [2, 1, 4, 'pot', [0, 0, 4]]);
  const recap = E.roundRecap(g);
  assert.deepEqual([recap.kind, recap.before, recap.after, recap.pts, recap.next, recap.best], ['schocken', [0, 0, 0], [0, 0, 4], [0, 0, 4], 2, { kind: 'schock', player: 1, value: 4 }]);
  assert.deepEqual(recap.reason.kind, 'pot');
  // the pot gives what it has left
  s = r.state;
  s = score(s, [6, 1, 1], 1); s = score(s, [2, 2, 1], 1); s = score(s, [6, 5, 4], 1);  // P1 takes 6
  s = score(s, [6, 1, 1], 1); s = score(s, [2, 2, 1], 1); s = score(s, [6, 5, 4], 1);  // P2 takes the 3 left
  assert.deepEqual([s.game.players.map(p => p.score), s.game.pot, s.game.rounds[2].take], [[6, 3, 4], 0, 3]);
});

test('with the pot empty, the highest throw pays the loser; players without coasters are out of the half', () => {
  let s = start(3, 0, 'score');
  s = score(s, [6, 1, 1], 3); s = score(s, [6, 1, 1], 2); s = score(s, [2, 2, 1], 2);  // P2's Schock 6 in fewer rolls: P3 takes 6
  assert.equal(s.game.rounds[0].high, 1);
  s = score(s, [2, 2, 1], 1); s = score(s, [5, 1, 1], 1); s = score(s, [6, 6, 6], 1);  // P3 takes 5
  assert.deepEqual([s.game.players.map(p => p.score), s.game.pot], [[0, 0, 11], 2]);
  s = score(s, [6, 6, 6], 1); s = score(s, [2, 2, 1], 1); s = score(s, [4, 3, 2], 1);  // a General is worth 3: P1 takes the last 2
  assert.deepEqual([s.game.players.map(p => p.score), s.game.pot, s.game.order], [[2, 0, 11], 0, [0, 2]]); // P2 is out
  s = score(s, [2, 2, 1], 1); s = score(s, [6, 1, 1], 1);                              // P3's Schock 6 pays P1 6
  assert.deepEqual(s.game.players.map(p => p.score), [8, 0, 5]);
  assert.equal(s.game.rounds[s.game.rounds.length - 2].from, 'player');
  s = score(s, [6, 1, 1], 1); s = score(s, [3, 2, 2], 1);                              // and back
  assert.deepEqual(s.game.players.map(p => p.score), [2, 0, 11]);
  assert.deepEqual(E.roundRecap(s.game).pts, [-6, 0, 6]);
});

test('Schock out hands the loser every coaster: the half is lost; the second half starts with the loser', () => {
  let s = start(3, 0, 'score');
  s = score(s, [6, 5, 4], 1); s = score(s, [4, 2, 1], 1);
  const r = scored(s, [1, 1, 1], 1);
  assert.deepEqual(r.events.map(e => e.type), ['schockOut', 'turn', 'roundEnd', 'halfOver', 'started']);
  const g = r.state.game;
  assert.deepEqual([g.half, g.pot, g.halves, g.starter, g.players.map(p => p.score)], [2, 13, [1], 1, [0, 0, 0]]);
  assert.deepEqual([g.rounds[0].after, g.rounds[0].halfLost, g.rounds[0].from, g.rounds[1].half], [[0, 13, 0], 1, 'all', 2]);
  const recap = E.roundRecap(g);
  assert.deepEqual([recap.best.kind, recap.half, recap.after], ['schockOut', { lost: 1, next: 2 }, [0, 13, 0]]);
});

test('the same loser twice loses the game; two losers play the final, whose loser loses the game', () => {
  // P2 loses both halves
  let s = start(3, 0, 'score');
  s = score(s, [6, 5, 4]); s = score(s, [3, 2, 2]);
  const half = scored(s, [1, 1, 1]);
  assert.equal(half.state.phase, 'play');
  s = half.state;
  assert.deepEqual([s.game.half, s.game.halves, s.game.order], [2, [1], [1, 2, 0]]);
  s = score(s, [3, 2, 2]); s = score(s, [1, 1, 1]);
  const end = scored(s, [6, 5, 4]);
  assert.deepEqual(end.events.map(e => e.type), ['turn', 'halfOver', 'gameOver']);
  assert.deepEqual([end.state.phase, end.state.game.loser, end.state.game.halves], ['over', 1, [1, 1]]);
  // P2 then P3 lose a half: the final is theirs alone, and P3 (who lost the second half) starts it
  s = start(3, 0, 'score');
  s = score(s, [6, 5, 4]); s = score(s, [3, 2, 2]); s = score(s, [1, 1, 1]);
  s = score(s, [6, 5, 4]); s = score(s, [3, 2, 2]); s = score(s, [1, 1, 1]);
  assert.deepEqual([s.game.half, s.game.halves, s.game.order, s.game.starter], [3, [1, 2], [2, 1], 2]);
  assert.deepEqual(E.roundRecap(s.game).half, { lost: 2, next: 3 });
  s = score(s, [1, 1, 1]);
  const fin = scored(s, [6, 6, 5]);
  assert.deepEqual([fin.state.phase, fin.state.game.loser, fin.state.game.halves], ['over', 1, [1, 2, 1]]);
});

test('blind: the turn ends at once with no dice in the state; the cups come up when the round ends, and it doubles', () => {
  let s = start(3);
  s = must(s, { type: 'roll' }, { rng: faces([1, 3, 5]) }).state;
  s = must(s, { type: 'keep', id: 0 }).state;
  const b = must(s, { type: 'blind' });
  assert.deepEqual(b.events, [{ type: 'turn', player: 0, pts: null, rolls: 2, blind: true }]);
  s = b.state;
  assert.deepEqual(s.game.rounds[0].results[0], { dice: null, kept: [1], hand: false, rolls: 2, blind: true });
  assert.equal(s.game.mark, 2); // the starter's blind roll sets the limit
  assert.equal(JSON.stringify(s).includes('"value":3'), false); // nothing of the blind roll is anywhere yet
  s = must(s, { type: 'roll' }, { rng: faces([6, 5, 3]) }).state;
  s = must(s, { type: 'stop' }).state;
  s = must(s, { type: 'roll' }, { rng: faces([4, 2, 2]) }).state;
  s = must(s, { type: 'roll' }, { rng: faces([4, 2, 1]) }).state;
  const r = must(s, { type: 'stop' }, { rng: faces([1, 4]) }); // the blind dice: 1 and 4, with the kept 1: Schock 4
  assert.deepEqual(r.events.map(e => e.type), ['turn', 'revealed', 'roundEnd', 'started']);
  assert.deepEqual(r.events[1], { type: 'revealed', player: 0, values: [4, 1, 1] });
  const rd = r.state.game.rounds[0];
  assert.deepEqual([rd.results[0].dice, rd.results[0].pts, rd.high, rd.loser, rd.take], [[4, 1, 1], 4, 0, 2, 8]); // 4, doubled
  assert.deepEqual(E.roundRecap(r.state.game).best, { kind: 'blind', player: 0, value: 8 });
  // a blind first roll: everyone gets one roll
  s = must(start(2), { type: 'blind' }).state;
  assert.deepEqual([s.game.mark, s.game.turn.maxRolls, s.game.rounds[0].results[0].hand], [1, 1, true]);
  s = must(s, { type: 'roll' }, { rng: faces([2]) }).state;
  assert.equal(E.apply(s, { type: 'blind' }).error, 'no_rolls');
});

test('real dice: three dice and the rolls used, within the limit; blind and from the hand are flags; undo works', () => {
  let s = start(2, 0, 'score');
  assert.equal(E.apply(s, { type: 'score', dice: [7, 1, 1], rolls: 1 }).error, 'dice');
  assert.equal(E.apply(s, { type: 'score', dice: [6, 1], rolls: 1 }).error, 'dice');
  assert.equal(E.apply(s, { type: 'score', dice: [6, 1, 1], rolls: 4 }).error, 'rolls');
  assert.equal(E.apply(s, { type: 'roll' }).error, 'phase');
  s = score(s, [5, 5, 5], 2, { hand: true });
  assert.deepEqual(s.game.rounds[0].results[0], { dice: [5, 5, 5], hand: true, rolls: 2, pts: 3 });
  assert.equal(E.apply(s, { type: 'score', dice: [6, 1, 1], rolls: 3 }).error, 'rolls');
  const u = must(s, { type: 'undo' });
  assert.equal(u.state.game.pos, 0);
  // blind: the cup stays down, so the turn is booked with the rolls only
  const b = must(s, { type: 'score', rolls: 2, blind: true });
  assert.deepEqual(b.events, [{ type: 'turn', player: 1, pts: null, rolls: 2, blind: true }, { type: 'lift', player: 1 }]);
  s = b.state;
  // every turn is booked: the blind cup comes up, and Ben (the current player again) enters what is under it
  assert.deepEqual([s.game.lifting, E.current(s.game), s.game.rounds[0].results[1]], [true, 1, { dice: null, hand: null, rolls: 2, blind: true }]);
  assert.equal(E.apply(s, { type: 'score', dice: [7, 4, 4] }).error, 'dice');
  const up = must(s, { type: 'score', dice: [5, 4, 4] });
  assert.deepEqual(up.events.map(e => e.type), ['revealed', 'roundEnd', 'started']);
  const rd = up.state.game.rounds[0];
  assert.deepEqual([rd.results[1], rd.loser, rd.take], [{ dice: [5, 4, 4], hand: false, rolls: 2, blind: true, pts: 1 }, 1, 6]); // the lowest throw was blind: General 3, doubled
  assert.equal(up.state.game.lifting, undefined);
  assert.equal(must(up.state, { type: 'undo' }).state.game.lifting, true); // undo takes the lifted throw back
  s = score(up.state, [3, 2, 2], 1);
  s = must(s, { type: 'drop' }).state;
  assert.equal(s.game.drops, 1);
});

test('real dice: several blind cups come up in the round\'s order, then the round is scored', () => {
  let s = start(3, 0, 'score');
  s = must(s, { type: 'score', rolls: 2, blind: true }).state;
  s = score(s, [6, 5, 4], 1);
  const last = must(s, { type: 'score', rolls: 2, blind: true });
  assert.deepEqual(last.events.at(-1), { type: 'lift', player: 0 });
  s = must(last.state, { type: 'score', dice: [3, 1, 1] }).state;
  assert.deepEqual([E.current(s.game), s.game.lifting, s.game.round], [2, true, 1]);
  const r = must(s, { type: 'score', dice: [3, 3, 3], hand: true });
  assert.deepEqual(r.events.map(e => e.type), ['revealed', 'roundEnd', 'started']);
  const rd = r.state.game.rounds[0];
  assert.deepEqual([rd.high, rd.loser, rd.take], [0, 1, 6]); // P1's blind Schock 3 is the highest, doubled; P2's Straight is the lowest
});

test('ending early: the most coasters lose; right after a half, its loser', () => {
  let s = start(2);
  s = score(start(2, 0, 'score'), [6, 5, 4], 1); s = score(s, [3, 2, 2], 1);
  const e = must(s, { type: 'endearly' });
  assert.deepEqual([e.state.phase, e.state.game.loser, e.state.game.early], ['over', 1, true]);
  s = score(start(2, 0, 'score'), [1, 1, 1], 1); s = score(s, [3, 2, 2], 1);
  const e2 = must(s, { type: 'endearly' });
  assert.deepEqual([e2.state.game.loser, e2.state.game.round, e2.state.game.rounds.length], [1, 1, 1]);
  // shots paid in the empty new round move to the round just finished
  s = score(start(2, 0, 'score'), [6, 5, 4], 1); s = score(s, [3, 2, 2], 1);
  for (let k = 0; k < 3; k++) s = must(s, { type: 'drop' }).state;
  const e3 = must(s, { type: 'endearly' }).state.game;
  assert.deepEqual([e3.round, e3.starter, e3.shots], [1, 0, [{ player: 1, round: 1 }]]);
  // a real-dice blind entry is known at once: no cup stays down
  s = start(2, 0, 'score');
  assert.deepEqual(scored(s, [6, 5, 4], 1, { blind: true }).events, [{ type: 'turn', player: 0, pts: 2, rolls: 1 }]);
});

test('random games keep the rules: 13 coasters a half, rolls within the limit, losers start, the game ends', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = seeded(seed), n = 2 + (seed % 5);
    let s = start(n, seed % n);
    let guard = 0;
    while (s.phase === 'play') {
      assert.ok(++guard < 20000, `seed ${seed} never ends`);
      const g = s.game, t = g.turn;
      assert.equal(g.pot + g.players.reduce((a, p) => a + p.score, 0), 13, 'coasters');
      assert.ok(t.maxRolls === (g.pos === 0 ? 3 : g.mark));
      const pick = rng();
      let r;
      if (t.rolls === 0 || (pick > 1 && E.canRoll(t))) {
        if (pick === 6 && E.canRoll(t)) r = must(s, { type: 'blind' }, { rng });
        else if (E.canFlip(t) && pick > 3) r = must(s, { type: 'flip' }, { rng });
        else {
          // set aside any 1s and roll the rest
          t.dice.forEach(d => { if (d.held === null && d.value === 1 && t.rolls) s = must(s, { type: 'keep', id: d.id }).state; });
          r = E.canRoll(s.game.turn) ? must(s, { type: 'roll' }, { rng }) : must(s, { type: 'stop' }, { rng });
        }
      } else if (t.flip && t.flip.roll === t.rolls) r = must(s, { type: 'roll' }, { rng });
      else r = must(s, { type: 'stop' }, { rng });
      s = r.state;
      const end = r.events.find(e => e.type === 'roundEnd');
      if (end) {
        const rd = s.game.rounds[s.game.rounds.length - 2];
        assert.equal(s.game.starter, rd.loser, 'the loser starts');
        for (const [p, x] of Object.entries(rd.results)) assert.ok(x.dice && x.rolls <= (+p === rd.starter ? 3 : rd.mark), 'rolls within the limit');
        const { high, low } = E.skExtremes(rd, E.orderFrom(rd.starter, n).filter(i => rd.results[i]));
        assert.deepEqual([high, low], [rd.high, rd.loser]);
        assert.ok(E.roundRecap(s.game));
        if (!r.events.some(e => e.type === 'halfOver')) assert.equal(rd.half, s.game.half);
        assert.deepEqual(rd.after, rd.halfLost != null ? rd.after : s.game.players.map(p => p.score));
      }
    }
    const g = s.game, h = g.halves;
    assert.ok(h.length === 3 || (h.length === 2 && h[0] === h[1]), `seed ${seed}: halves ${h}`);
    assert.equal(g.loser, h[h.length - 1]);
    if (h.length === 3) assert.ok(h[2] === h[0] || h[2] === h[1]);
  }
});

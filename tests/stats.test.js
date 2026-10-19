// Game statistics: summaries of finished games and the check for one-phone reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { summarize, sheetOf, nameKey, GAME_ID_RE, checkReport } from '../server/core/stats.js';
import { diceGame, scoreGame, must } from './games.js';

const E = globalThis.SevensEngine;
const ID = '0123456789abcdef';

test('names match ignoring case and extra spaces', () => {
  assert.equal(nameKey('  Anna   Lee '), 'anna lee');
  assert.equal(nameKey('BEN'), nameKey('ben'));
  assert.ok(GAME_ID_RE.test(ID) && !GAME_ID_RE.test('XYZ'));
});

test('a finished game becomes rows that match its score sheet', () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const s of [diceGame(seed), scoreGame(seed)]) {
      const g = s.game, n = g.players.length;
      const { game, players, turns } = summarize(s, { id: ID, source: 'phone', startedAt: 1000, finishedAt: 5000, status: 'over' });
      assert.equal(game.status, 'over');
      assert.equal(game.mode, g.mode);
      assert.equal(game.player_count, n);
      assert.equal(game.rounds, g.rounds.length);
      assert.equal(game.loser, g.players[g.loser].name);
      const sorted = g.players.map(p => p.score).sort((a, b) => b - a);
      assert.equal(game.top_score, sorted[0]);
      assert.equal(game.margin, sorted[0] - sorted[1]);
      assert.deepEqual(JSON.parse(game.sheet), sheetOf(g));
      assert.equal(players.length, n);
      for (const p of players) {
        assert.equal(p.score, g.players[p.idx].score);
        assert.equal(p.lost, p.idx === g.loser ? 1 : 0);
        const mine = turns.filter(t => t.idx === p.idx);
        assert.equal(p.turns, mine.length);
        assert.equal(mine.reduce((a, t) => a + t.pts, 0), p.score, 'turns add up to the total');
        assert.equal(p.sevens_outs, mine.filter(t => t.pts === 0).length);
        assert.equal(p.shots, (g.shots || []).filter(x => x.player === p.idx).length);
      }
      for (const t of turns) {
        const rd = g.rounds[t.round - 1];
        assert.equal(t.starter, t.idx === rd.starter ? 1 : 0);
        assert.equal(t.mark, rd.mark);
        if (g.mode === 'score' && !t.starter) assert.equal(t.rolls, null, 'only the starter enters rolls');
      }
    }
  }
});

test('a game ended early in the middle of a round', () => {
  let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben', 'Cleo'], starter: 0, mode: 'score' });
  s = must(s, { type: 'score', pts: 12, rolls: 2 });
  s = must(s, { type: 'score', pts: 30 });
  s = must(s, { type: 'score', pts: 4 });
  s = must(s, { type: 'nextround' });
  s = must(s, { type: 'score', pts: 0, rolls: 1 }); // Ben starts round 2 and clears the table
  s = must(s, { type: 'endearly' });
  const { game, players, turns } = summarize(s, { id: ID, source: 'online', roomCode: 'K7QPM', status: 'over', finishedAt: 9 });
  assert.equal(game.early, 1);
  assert.equal(game.rounds, 2);
  assert.equal(game.loser, 'Ben');
  assert.equal(game.room_code, 'K7QPM');
  assert.equal(turns.length, 4);
  assert.equal(players.find(p => p.name === 'Ben').sevens_outs, 1);
});

test('a game that is still running or was abandoned has only its game row', () => {
  const s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben'], starter: 0, mode: 'dice' });
  for (const status of ['playing', 'abandoned']) {
    const r = summarize(s, { id: ID, source: 'online', roomCode: 'K7QPM', startedAt: 7, status });
    assert.deepEqual(r.players, []);
    assert.deepEqual(r.turns, []);
    assert.equal(r.game.status, status);
    assert.equal(r.game.player_count, 2);
    assert.equal(r.game.started_at, 7);
    assert.equal(r.game.finished_at, null);
    assert.equal(r.game.sheet, null);
  }
});

const reportOf = (s, over = {}) => ({
  id: ID, mode: s.game.mode, startedAt: 1_000_000, finishedAt: 2_000_000,
  sheet: JSON.parse(JSON.stringify(sheetOf(s.game))), ...over
});
const NOW = 3_000_000;
const refused = (rep, why) => {
  const r = checkReport(rep, E, NOW);
  assert.ok(r.error, `should be refused: ${why}`);
};

test('every real game is accepted, and the server works out the same result', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const s of [diceGame(seed), scoreGame(seed)]) {
      const r = checkReport(reportOf(s), E, NOW);
      assert.ok(r.ok, `seed ${seed} ${s.game.mode}: ${r.error}`);
      assert.equal(r.state.game.loser, s.game.loser);
      assert.deepEqual(r.state.game.players.map(p => p.score), s.game.players.map(p => p.score));
      assert.deepEqual(summarize(r.state, { id: ID, source: 'phone', status: 'over' }).turns,
                       summarize(s, { id: ID, source: 'phone', status: 'over' }).turns);
    }
  }
});

test('a dice game ended early in the middle of a round is accepted', () => {
  const rng = () => 3; // all threes: no 7-pairs, 18 points per turn
  let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben', 'Cleo'], starter: 0, mode: 'dice' });
  for (let i = 0; i < 3; i++) { s = must(s, { type: 'roll' }, { rng }); s = must(s, { type: 'stop' }); }
  s = must(s, { type: 'nextround' });
  s = must(s, { type: 'roll' }, { rng }); s = must(s, { type: 'stop' });
  s = must(s, { type: 'endearly' });
  const r = checkReport(reportOf(s), E, NOW);
  assert.ok(r.ok, r.error);
  assert.equal(r.state.game.loser, s.game.loser);
});

test('a corrected scoreboard game is accepted even though a past starter no longer fits', () => {
  let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben'], starter: 0, mode: 'score' });
  s = must(s, { type: 'score', pts: 30, rolls: 1 }); s = must(s, { type: 'score', pts: 20 });
  s = must(s, { type: 'nextround' });
  s = must(s, { type: 'score', pts: 36, rolls: 1 }); s = must(s, { type: 'score', pts: 20 });
  s = must(s, { type: 'nextround' });
  s = must(s, { type: 'score', pts: 36, rolls: 1 }); s = must(s, { type: 'score', pts: 20 });
  assert.equal(s.phase, 'over');
  s = must(s, { type: 'edit', player: 1, values: { 1: 36 } }); // Ben now led after round 1, yet Anna started round 2
  assert.equal(s.phase, 'over');
  const r = checkReport(reportOf(s), E, NOW);
  assert.ok(r.ok, r.error);
  assert.equal(r.state.game.loser, 0);
});

test('broken or made-up reports are refused', () => {
  const d = diceGame(7), sc = scoreGame(7);
  const edit = (s, fn) => { const rep = reportOf(s); fn(rep, rep.sheet); return rep; };
  refused(null, 'not an object');
  refused(edit(d, r => { r.id = 'nope'; }), 'bad id');
  refused(edit(d, r => { r.mode = 'poker'; }), 'bad mode');
  refused(edit(d, r => { r.finishedAt = NOW + 11 * 60_000; }), 'finished in the future');
  refused(edit(d, r => { r.startedAt = r.finishedAt + 1; }), 'started after it finished');
  refused(edit(d, (r, sh) => { sh.players = ['Solo']; }), 'one player');
  refused(edit(d, (r, sh) => { sh.players[0] = '   '; }), 'empty name');
  refused(edit(d, (r, sh) => { sh.players[0] = { toString: 1 }; }), 'name is an object');
  refused(edit(d, (r, sh) => { sh.players[0] = 12345; }), 'name is a number');
  refused(edit(d, (r, sh) => { sh.rounds[1].starter = (sh.rounds[1].starter + 1) % sh.players.length; }), 'wrong starter');
  refused(edit(d, (r, sh) => { const rd = sh.rounds[0], p = (rd.starter + 1) % sh.players.length; rd.results[p].rolls = rd.mark + 1; }), 'rolls over the limit');
  refused(edit(d, (r, sh) => { sh.rounds[0].mark = 9; }), 'limit does not match the starter');
  refused(edit(d, (r, sh) => { sh.rounds[0].results[sh.rounds[0].starter].pts = 37; }), 'too many points');
  refused(edit(d, (r, sh) => { delete sh.rounds[0].results[(sh.rounds[0].starter + 1) % sh.players.length]; }), 'incomplete round');
  refused(edit(d, (r, sh) => { sh.rounds.push({ ...sh.rounds.at(-1), no: sh.rounds.length + 1 }); }), 'played past 101');
  refused(edit(d, (r, sh) => { sh.rounds.pop(); }), 'nobody reached 101');
  refused(edit(d, (r, sh) => { sh.rounds[0].no = 5; }), 'round numbers');
  refused(edit(d, (r, sh) => { sh.shots = [{ player: 9, round: 1 }]; }), 'shot for a missing player');
  refused(edit(sc, (r, sh) => { const rd = sh.rounds[0], p = (rd.starter + 1) % sh.players.length; rd.results[p].rolls = 2; }), 'scoreboard non-starter with rolls');
});

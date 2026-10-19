// Game statistics: summaries of finished games and the check for one-phone reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { summarize, sheetOf, nameKey, GAME_ID_RE } from '../server/core/stats.js';
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

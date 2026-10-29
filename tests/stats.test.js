// Game statistics: summaries of finished games and the check for one-phone reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { summarize, sheetOf, nameKey, GAME_ID_RE, checkReport, MAX_REPORT_BYTES } from '../server/core/stats.js';
import { diceGame, scoreGame, ftGame, skGame, must } from './games.js';

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
  id: ID, ...(s.game.kind ? { kind: s.game.kind } : {}), mode: s.game.mode, startedAt: 1_000_000, finishedAt: 2_000_000,
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

test('a game of 12 players is accepted, 13 is refused', () => {
  for (const s of [diceGame(5, 12), scoreGame(5, 12), diceGame(8, 12)]) {
    const r = checkReport(reportOf(s), E, NOW);
    assert.ok(r.ok, `${s.game.mode}: ${r.error}`);
    assert.equal(r.state.game.players.length, 12);
    assert.equal(r.state.game.loser, s.game.loser);
    const rep = reportOf(s);
    rep.sheet.players.push('P13');
    assert.equal(checkReport(rep, E, NOW).error, 'players');
  }
});

test('a long, low-scoring game of 12 fits in one report', () => {
  // 3 points a turn, everyone: 34 rounds of 12 turns
  let s = must(E.blank(), { type: 'start', names: Array.from({ length: 12 }, (_, i) => `Player number ${i + 1}`), starter: 0, mode: 'score' });
  while (s.phase !== 'over') s = must(s, { type: 'score', pts: 3, rolls: s.game.pos === 0 ? 3 : undefined });
  assert.ok(s.game.rounds.length >= 34);
  const rep = { ...reportOf(s), owner: 11 };
  assert.ok(JSON.stringify(rep).length < MAX_REPORT_BYTES, `${JSON.stringify(rep).length} bytes`);
  assert.ok(checkReport(rep, E, NOW).ok);
});

test('a dice game ended early in the middle of a round is accepted', () => {
  const rng = () => 3; // all threes: no 7-pairs, 18 points per turn
  let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben', 'Cleo'], starter: 0, mode: 'dice' });
  s = must(s, { type: 'roll' }, { rng }); s = must(s, { type: 'stop' }); // the starter stops after one roll ...
  for (let i = 0; i < 2; i++) s = must(s, { type: 'roll' }, { rng }); // ... so the others' one roll ends their turn
  s = must(s, { type: 'roll' }, { rng }); s = must(s, { type: 'stop' });
  s = must(s, { type: 'endearly' });
  const r = checkReport(reportOf(s), E, NOW);
  assert.ok(r.ok, r.error);
  assert.equal(r.state.game.loser, s.game.loser);
});

test('a corrected scoreboard game is accepted even though a past starter no longer fits', () => {
  let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben'], starter: 0, mode: 'score' });
  s = must(s, { type: 'score', pts: 30, rolls: 1 }); s = must(s, { type: 'score', pts: 20 });
  s = must(s, { type: 'score', pts: 36, rolls: 1 }); s = must(s, { type: 'score', pts: 20 });
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

test('signed-in players carry their player ID; guests have none', () => {
  const s = diceGame(3);
  const { players } = summarize(s, { id: ID, source: 'online', status: 'over', users: [null, 'aaaa000000000001'] });
  assert.deepEqual(players.map(p => p.user_id), s.game.players.map((_, i) => (i === 1 ? 'aaaa000000000001' : null)));
  assert.ok(summarize(s, { id: ID, source: 'phone', status: 'over' }).players.every(p => p.user_id === null));
});

// ---------- 42/18 and Schocken ----------
// (real-dice games keep undo snapshots, so they take a moment to play)
const played = new Map();
const both = seed => played.get(seed) || played.set(seed, [ftGame(seed, undefined, 'dice'), ftGame(seed, undefined, 'score'), skGame(seed, undefined, 'dice'), skGame(seed, undefined, 'score')]).get(seed);

test('42/18 and Schocken games are recorded with their game, coasters and top throws', () => {
  for (let seed = 1; seed <= 15; seed++) {
    for (const s of both(seed)) {
      const g = s.game, ft = g.kind === '4218';
      const { game, players, turns } = summarize(s, { id: ID, source: 'phone', status: 'over', finishedAt: 5 });
      assert.equal(game.kind, g.kind);
      assert.equal(game.loser, g.players[g.loser].name);
      assert.deepEqual(players.map(p => p.score), g.players.map(p => p.score), 'coasters');
      const sheet = JSON.parse(game.sheet);
      g.rounds.forEach((rd, k) => {
        assert.equal(sheet.rounds[k].loser, rd.loser);
        assert.equal(sheet.rounds[k].half, rd.half);
      });
      for (const p of players) {
        const mine = turns.filter(t => t.idx === p.idx);
        assert.equal(p.turns, mine.length);
        assert.equal(p.sevens_outs, mine.filter(t => t.pts === (ft ? 18 : 13)).length, 'a 42/18 or a Schock out');
      }
      for (const t of turns) assert.equal(t.pts, g.rounds[t.round - 1].results[t.idx].pts);
    }
  }
  assert.equal(summarize(diceGame(2), { id: ID, source: 'phone', status: 'over' }).game.kind, 'sevens');
});

test('Schocken ended early with a blind cup still down: the cup is not a turn', () => {
  let s = must(E.blank(), { type: 'start', kind: E.SK, names: ['Anna', 'Ben', 'Cleo'], starter: 0, mode: 'dice' });
  s = must(s, { type: 'roll' }, { rng: () => 3 }); s = must(s, { type: 'stop' });
  s = must(s, { type: 'blind' });
  s = must(s, { type: 'endearly' });
  const { players, turns } = summarize(s, { id: ID, source: 'phone', status: 'over' });
  assert.deepEqual(turns.map(t => t.idx), [0]);
  assert.deepEqual(players.map(p => p.turns), [1, 0, 0]);
  const r = checkReport(reportOf(s), E, NOW);
  assert.ok(r.ok, r.error);
  assert.equal(r.state.game.loser, s.game.loser);
});

test('every real 42/18 and Schocken game is accepted, and the server works out the same result', () => {
  let left = 0, blind = 0, finals = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const s of both(seed)) {
      const r = checkReport(reportOf(s), E, NOW);
      assert.ok(r.ok, `seed ${seed} ${s.game.kind} ${s.game.mode}: ${r.error}`);
      const a = r.state.game, b = s.game;
      assert.equal(a.kind, b.kind);
      assert.equal(a.loser, b.loser, `seed ${seed} ${b.kind} ${b.mode}: loser`);
      assert.deepEqual(a.players.map(p => p.score), b.players.map(p => p.score));
      assert.deepEqual(a.rounds.map(rd => rd.loser), b.rounds.map(rd => rd.loser));
      // the same rows; the stored sheet is rebuilt (Schocken's blind results lose the dice kept before the blind roll)
      const sum = st => { const x = summarize(st, { id: ID, source: 'phone', status: 'over', finishedAt: 1 }); return { ...x, game: { ...x.game, sheet: null } }; };
      assert.deepEqual(sum(r.state), sum(s), 'the same rows');
      if (b.left) left++;
      if (b.half === 3) finals++;
      if (b.rounds.some(rd => Object.values(rd.results).some(x => x.blind))) blind++;
    }
  }
  assert.ok(left && blind && finals, `the games cover the corners: ${left} left, ${blind} blind, ${finals} finals`);
});

test('42/18 and Schocken games ended early are accepted, between rounds and in the middle of one', () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const s of both(seed)) {
      // replay the game's first turns, then end it early
      let t = must(E.blank(), { type: 'start', kind: s.game.kind, names: s.game.players.map(p => p.name), starter: s.game.rounds[0].starter, mode: 'score' });
      const steps = 1 + (seed * 7) % 20;
      const turns = s.game.rounds.flatMap(rd => E.orderFrom(rd.starter, s.game.players.length).filter(p => rd.results[p]).map(p => rd.results[p]));
      for (const x of turns.slice(0, steps)) {
        if (t.phase !== 'play') break;
        const action = s.game.kind === '4218' ? { type: 'score', pts: x.pts === 18 ? 17 : x.pts, rolls: x.rolls }
          : t.game.lifting ? { type: 'score', dice: [2, 3, 5] } : { type: 'score', dice: x.dice || [6, 4, 1], rolls: Math.min(x.rolls, t.game.pos === 0 ? 3 : t.game.mark), hand: x.hand };
        t = must(t, action);
      }
      if (t.phase !== 'play') continue;
      t = must(t, { type: 'endearly' });
      const r = checkReport(reportOf(t), E, NOW);
      assert.ok(r.ok, `seed ${seed} ${t.game.kind}: ${r.error}`);
      assert.equal(r.state.game.loser, t.game.loser, `seed ${seed} ${t.game.kind}: loser`);
    }
  }
});

test('a corrected 42/18 scoreboard game is accepted even though a round\'s starter no longer lost the round before', () => {
  let s = must(E.blank(), { type: 'start', kind: E.FT, names: ['Anna', 'Ben'], starter: 0, mode: 'score' });
  for (let i = 0; i < 3; i++) { s = must(s, { type: 'score', pts: 5, rolls: 1 }); s = must(s, { type: 'score', pts: 9, rolls: 1 }); }
  assert.equal(s.phase, 'over');
  s = must(s, { type: 'edit', player: 0, values: { 1: 12 } }); // Ben lost round 1 now, yet Anna started round 2
  assert.equal(s.phase, 'play', 'Anna is down to 2 coasters: round 4');
  s = must(s, { type: 'score', pts: 5, rolls: 1 }); s = must(s, { type: 'score', pts: 9, rolls: 1 });
  assert.equal(s.phase, 'over');
  const r = checkReport(reportOf(s), E, NOW);
  assert.ok(r.ok, r.error);
  assert.equal(r.state.game.loser, s.game.loser);
  const dice = reportOf(s, { mode: 'dice' });
  assert.equal(checkReport(dice, E, NOW).error, 'round 2: wrong starter', 'dice games follow every rule');
});

test('a long Schocken game of 12 fits in one report', () => {
  let biggest = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const s = skGame(seed, 12, 'dice');
    const rep = { ...reportOf(s), owner: 11 };
    biggest = Math.max(biggest, JSON.stringify(rep).length);
    assert.ok(checkReport(rep, E, NOW).ok);
  }
  assert.ok(biggest < MAX_REPORT_BYTES / 2, `${biggest} bytes`);
});

test('broken or made-up 42/18 and Schocken reports are refused', () => {
  const ft = ftGame(3, 4, 'dice'), sk = skGame(3, 4, 'dice');
  const edit = (s, fn) => { const rep = reportOf(s); fn(rep, rep.sheet); return rep; };
  const second = sh => (sh.rounds[0].starter + 1) % sh.players.length;
  refused(edit(ft, r => { r.kind = 'yahtzee'; }), 'unknown game');
  refused(edit(ft, r => { delete r.kind; }), 'read as Sevens Out');
  refused(edit(ft, (r, sh) => { sh.rounds[0].results[sh.rounds[0].starter].pts = 2; }), 'no throw has 2 points');
  refused(edit(ft, (r, sh) => { sh.rounds[0].results[sh.rounds[0].starter].rolls = 6; }), 'six rolls');
  refused(edit(ft, (r, sh) => { sh.rounds[1].starter = second(sh); if (sh.rounds[1].starter === sh.rounds[0].loser) sh.rounds[1].starter = (sh.rounds[1].starter + 1) % 4; }), 'the round\'s loser starts');
  refused(edit(ft, (r, sh) => { sh.rounds.push({ ...sh.rounds.at(-1), no: sh.rounds.length + 1 }); }), 'played on after 3 coasters');
  refused(edit(ft, (r, sh) => { sh.rounds.pop(); }), 'nobody has 3 coasters');
  refused(edit(ft, (r, sh) => { for (const p of [0, 1, 2]) if (sh.rounds[0].results[p]) sh.rounds[0].results[p].pts = 18; }), 'everyone out but one, and the round goes on');
  refused(edit(sk, (r, sh) => { sh.rounds[0].results[sh.rounds[0].starter].dice = [7, 1, 1]; }), 'a 7');
  refused(edit(sk, (r, sh) => { sh.rounds[0].results[sh.rounds[0].starter].dice = [6, 1]; }), 'two dice');
  refused(edit(sk, (r, sh) => { const rd = sh.rounds[0]; rd.results[second(sh)].rolls = rd.results[rd.starter].rolls + 1; }), 'over the limit');
  refused(edit(sk, (r, sh) => { const rd = sh.rounds[0]; rd.results[rd.starter] = { dice: null, rolls: 1, blind: true }; }), 'a cup never came up mid-game');
  refused(edit(sk, (r, sh) => { sh.rounds[1].starter = (sh.rounds[0].loser + 1) % 4; }), 'the round\'s loser starts');
  refused(edit(sk, (r, sh) => { sh.rounds.pop(); }), 'unfinished');
  refused(edit(sk, (r, sh) => { sh.rounds.push({ ...sh.rounds.at(-1), no: sh.rounds.length + 1 }); }), 'played on after the end');
  refused(edit(sk, r => { r.sheet.early = true; }), 'ended early after the end');
  // a throw that loses claimed as a Schock out: the coasters no longer add up to the rounds that follow
  const rep = reportOf(sk), rd = rep.sheet.rounds[0];
  rd.results[rd.loser].dice = [1, 1, 1];
  assert.notEqual(checkReport(rep, E, NOW).state?.game.loser ?? -1, sk.game.loser, 'a made-up Schock out changes the game');
});

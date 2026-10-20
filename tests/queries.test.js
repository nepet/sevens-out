// The admin page's statistics queries, against the real schema in node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { fakeD1 } from './fake-d1.js';
import { fromD1 } from '../server/d1/db.js';
import { writeRecord } from '../server/d1/write.js';
import { summarize } from '../server/core/stats.js';
import { parseFilters, stats, recentGames, gameDetail, PAGE_SIZE } from '../server/admin/queries.js';
import { diceGame, scoreGame, quickGame } from './games.js';

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 19, 12);
const q = (s, now = NOW) => parseFilters(new URLSearchParams(s), now);
let n = 0;
const nextId = () => (++n).toString(16).padStart(16, '0');
async function put(db, state, { source = 'online', finishedAt, startedAt = finishedAt - 1_800_000, status = 'over', id = nextId() }) {
  const rec = summarize(state, { id, source, roomCode: source === 'online' ? 'K7QPM' : null, startedAt, finishedAt: status === 'over' ? finishedAt : null, status });
  await writeRecord(db, rec);
  return rec;
}

test('filters: defaults and junk fall back to safe values', () => {
  const f = q('');
  assert.deepEqual([f.period, f.source, f.mode, f.tz, f.before], ['30d', null, null, 0, null]);
  assert.equal(f.since, NOW - 30 * DAY);
  const g = q('period=all&source=phone&mode=score&tz=-120&before=123_00000000000000ab');
  assert.deepEqual([g.period, g.since, g.source, g.mode, g.tz, g.before], ['all', 0, 'phone', 'score', -120, { at: 123, id: '00000000000000ab' }]);
  assert.equal(q('before=123').before, null, 'a bare time is not a cursor');
  const h = q("period=1y&source=x'or'1&mode=dice;drop&tz=9999&before=abc");
  assert.deepEqual([h.period, h.source, h.mode, h.tz, h.before], ['30d', null, null, 0, null]);
});

test('activity, facts and abandoned games follow the filters', async () => {
  const db = fromD1(fakeD1());
  const g1 = await put(db, diceGame(11), { source: 'online', finishedAt: NOW - 1 * DAY });
  const g2 = await put(db, scoreGame(12), { source: 'phone', finishedAt: NOW - 2 * DAY });
  await put(db, diceGame(13), { source: 'phone', finishedAt: NOW - 40 * DAY });
  const lobby = diceGame(14);
  await put(db, lobby, { status: 'playing', startedAt: NOW - 20 * DAY, finishedAt: 0 }); // stale: abandoned
  await put(db, lobby, { status: 'abandoned', startedAt: NOW - 2 * DAY, finishedAt: 0 });
  await put(db, lobby, { status: 'playing', startedAt: NOW - 1 * DAY, finishedAt: 0 });  // may still be played

  const s = await stats(db, q('period=30d'));
  const both = [g1, g2];
  const turns = both.flatMap(r => r.turns);
  assert.equal(s.activity.games, 2);
  assert.equal(s.activity.abandoned, 2);
  assert.equal(s.activity.players, new Set(both.flatMap(r => r.players.map(p => p.name_key))).size);
  assert.equal(s.activity.avgPlayers, (g1.game.player_count + g2.game.player_count) / 2);
  assert.equal(s.activity.avgRounds, (g1.game.rounds + g2.game.rounds) / 2);
  assert.equal(s.activity.avgMinutes, 30);
  assert.equal(s.facts.turns, turns.length);
  assert.equal(s.facts.sevensOuts, turns.filter(t => t.pts === 0).length);
  assert.ok(Math.abs(s.facts.avgPoints - turns.reduce((a, t) => a + t.pts, 0) / turns.length) < 1e-9);
  assert.equal(s.facts.shots, both.flatMap(r => r.players).reduce((a, p) => a + p.shots, 0));
  const starts = turns.filter(t => t.starter);
  for (const k of [1, 2, 3]) assert.equal(s.facts.limits[k], starts.filter(t => t.rolls === k).length);
  assert.equal(s.facts.spread.reduce((a, b) => a + b.n, 0), turns.length);
  assert.equal(s.facts.records.biggestTurn.pts, Math.max(...turns.map(t => t.pts)));
  assert.equal(s.facts.records.longestGame.rounds, Math.max(g1.game.rounds, g2.game.rounds));
  assert.equal(s.facts.records.closestFinish.margin, Math.min(g1.game.margin, g2.game.margin));
  assert.deepEqual(s.activity.series, [
    { bucket: new Date(NOW - 2 * DAY).toISOString().slice(0, 10), online: 0, phone: 1 },
    { bucket: new Date(NOW - 1 * DAY).toISOString().slice(0, 10), online: 1, phone: 0 }
  ]);

  assert.equal((await stats(db, q('period=all'))).activity.games, 3);
  const phone = await stats(db, q('period=30d&source=phone'));
  assert.deepEqual([phone.activity.games, phone.activity.abandoned], [1, 0]);
  assert.equal((await stats(db, q('period=30d&mode=dice'))).activity.games, 1);
  const empty = await stats(db, q('period=7d&mode=score&source=online'));
  assert.equal(empty.activity.games, 0);
  assert.equal(empty.activity.avgPlayers, null);
  assert.deepEqual(empty.facts.records, { biggestTurn: null, longestGame: null, closestFinish: null });
  assert.deepEqual(empty.leaderboard, []);
});

test('days and weeks are counted in the viewer\'s time zone', async () => {
  const db = fromD1(fakeD1());
  const late = Date.UTC(2026, 9, 14, 23, 30); // Wednesday 23:30 UTC = Thursday 01:30 in UTC+2
  await put(db, quickGame(['Anna', 'Ben']), { finishedAt: late });
  const now = Date.UTC(2026, 9, 19, 12);
  assert.equal((await stats(db, q('period=30d&tz=0', now))).activity.series[0].bucket, '2026-10-14');
  assert.equal((await stats(db, q('period=30d&tz=-120', now))).activity.series[0].bucket, '2026-10-15');
  const week = await stats(db, q('period=12m&tz=-120', now));
  assert.equal(week.bucket, 'week');
  assert.equal(week.activity.series[0].bucket, '2026-10-12', 'weeks start on Monday');
});

test('the leaderboard joins spellings of the same name', async () => {
  const db = fromD1(fakeD1());
  await put(db, quickGame(['Anna', 'Ben']), { finishedAt: NOW - DAY });
  await put(db, quickGame(['Anna', 'Cleo']), { finishedAt: NOW - DAY });
  await put(db, quickGame(['ANNA   ', 'Ben'], 0), { finishedAt: NOW - DAY });
  const s = await stats(db, q('period=30d'));
  assert.deepEqual(s.leaderboard[0], { name: 'Anna', tag: null, games: 3, losses: 3, lossRate: 1, sevensOuts: 0, shots: 0 });
  const ben = s.leaderboard.find(p => p.name === 'Ben');
  assert.deepEqual([ben.games, ben.losses, ben.sevensOuts], [2, 0, 3]);
});

test('signed-in players count by player ID: two Annas stay apart, one renamed player stays one', async () => {
  const db = fromD1(fakeD1());
  const A1 = 'a1a1000000000000', A2 = 'a2a2000000000000';
  const game = (names, users) => writeRecord(db, summarize(quickGame(names), { id: nextId(), source: 'online', finishedAt: NOW - DAY, status: 'over', users }));
  await game(['Anna', 'Ben'], [A1]);
  await game(['Anna', 'Ben'], [A2]);
  await game(['Annie', 'Ben'], [A1]);
  await game(['Anna', 'Ben'], []); // a guest Anna
  const s = await stats(db, q('period=30d'));
  assert.equal(s.activity.players, 4, 'Anna #a1a1, Anna #a2a2, guest Anna, guest Ben');
  const annas = s.leaderboard.filter(p => /^Ann/.test(p.name)).map(p => [p.name, p.tag, p.games]);
  assert.deepEqual(annas, [['Anna', 'a1a1', 2], ['Anna', null, 1], ['Anna', 'a2a2', 1]]);
  const recent = await recentGames(db, q(''));
  assert.ok(recent.games.some(g => g.players[0].tag === 'a2a2'));
  assert.equal((await gameDetail(db, recent.games[0].id)).players[1].tag, null);
});

test('recent games come newest first, 20 per page, and one game opens with its sheet', async () => {
  const db = fromD1(fakeD1());
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push((await put(db, quickGame(['Anna', 'Ben']), { source: i % 2 ? 'phone' : 'online', finishedAt: NOW - i * 3_600_000 })).game.id);
  const p1 = await recentGames(db, q(''));
  assert.equal(p1.games.length, PAGE_SIZE);
  assert.deepEqual(p1.games.map(g => g.id), ids.slice(0, 20));
  assert.deepEqual(p1.games[0].players, [{ idx: 0, name: 'Anna', tag: null, score: 108, lost: true }, { idx: 1, name: 'Ben', tag: null, score: 15, lost: false }]);
  const p2 = await recentGames(db, q(`before=${p1.next}`));
  assert.deepEqual(p2.games.map(g => g.id), ids.slice(20));
  assert.equal(p2.next, null);
  assert.equal((await recentGames(db, q('source=phone'))).games.length, 12);

  const one = await gameDetail(db, ids[0]);
  assert.equal(one.sheet.players[1], 'Ben');
  assert.equal(one.players[0].lost, true);
  assert.equal(await gameDetail(db, 'ffffffffffffffff'), null);
});

test('paging does not skip games that finished at the same time', async () => {
  const db = fromD1(fakeD1());
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push((await put(db, quickGame(['Anna', 'Ben']), { finishedAt: NOW - DAY })).game.id);
  const p1 = await recentGames(db, q(''));
  const p2 = await recentGames(db, q(`before=${p1.next}`));
  assert.equal(p1.games.length, PAGE_SIZE);
  assert.equal(p2.next, null);
  assert.deepEqual([...p1.games, ...p2.games].map(g => g.id).sort(), [...ids].sort());
});

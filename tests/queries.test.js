// The admin page's statistics queries, against the real schema in node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { fakeD1 } from './fake-d1.js';
import { fromD1 } from '../server/d1/db.js';
import { writeRecord, writeRoom, markRoomGone } from '../server/d1/write.js';
import { summarize } from '../server/core/stats.js';
import { parseFilters, stats, recentGames, gameDetail, PAGE_SIZE, parseRoomFilters, roomList, roomDetail, usage, ROOMS_PAGE } from '../server/admin/queries.js';
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
  for (const id of [A1, A2]) await db.batch([['INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)', [id, 'Anna']]]);
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

// ----- rooms and usage -----
const roomRow = (o = {}) => ({
  id: nextId(), code: 'K7QPM', created_at: NOW - DAY, active_at: NOW - DAY, closed_at: null, close_reason: null, phase: 'lobby', mode: 'dice',
  pairing: 'manual', round: null, seats: 2, connected: 2, watching: 0, signed_in: 0, host: 'Anna', names: '["Anna","Ben"]', game_id: null,
  first_start_at: null, games_started: 0, games_finished: 0, connects: 2, rejoins: 0, spectators: 0, chat: 0, peak: 2, ...o
});

test('rooms: open rooms by last activity, closed rooms paged by when they closed, one room with its timeline and games', async () => {
  const db = fromD1(fakeD1());
  const older = roomRow({ active_at: NOW - 2 * DAY }), newer = roomRow({ code: 'ABCDE', active_at: NOW - 1000 });
  await writeRoom(db, older, [{ seq: 1, at: NOW - 2 * DAY, kind: 'created', detail: { name: 'Anna' } }]);
  await writeRoom(db, newer);
  for (let i = 0; i < ROOMS_PAGE + 2; i++) await writeRoom(db, roomRow({ closed_at: NOW - i * 1000, close_reason: 'empty' }));
  const open = await roomList(db, parseRoomFilters(new URLSearchParams('')));
  assert.deepEqual(open.rooms.map(r => r.code), ['ABCDE', 'K7QPM']);
  assert.deepEqual(open.rooms[1].names, ['Anna', 'Ben']);
  const p1 = await roomList(db, parseRoomFilters(new URLSearchParams('status=closed')));
  assert.equal(p1.rooms.length, ROOMS_PAGE);
  const p2 = await roomList(db, parseRoomFilters(new URLSearchParams(`status=closed&before=${p1.next}`)));
  assert.equal(p2.rooms.length, 2);
  assert.equal(p2.next, null);
  assert.ok(p1.rooms.every(r => r.closeReason === 'empty'));

  // the same event again (a retried write) is kept once; a game played in the room is listed
  await writeRoom(db, { ...older, phase: 'over', games_started: 1 }, [{ seq: 1, at: 0, kind: 'created' }, { seq: 2, at: NOW - DAY, kind: 'started', detail: { players: 2 } }]);
  await put(db, diceGame(3), { finishedAt: NOW - DAY / 2 });
  const one = await roomDetail(db, older.id);
  assert.deepEqual(one.events.map(e => [e.seq, e.kind]), [[1, 'created'], [2, 'started']]);
  assert.deepEqual(one.events[0].detail, { name: 'Anna' });
  assert.equal(one.phase, 'over');
  assert.equal(one.games.length, 1);
  assert.equal(await roomDetail(db, 'nope'), null);
  assert.equal(await roomDetail(db, 'ffffffffffffffff'), null);

  await markRoomGone(db, newer.id, NOW);
  assert.deepEqual((await roomList(db, parseRoomFilters(new URLSearchParams('')))).rooms.map(r => r.code), ['K7QPM']);
  assert.equal((await roomDetail(db, newer.id)).closeReason, 'gone');
});

test('usage: the rooms funnel, when people play, game sizes, new and returning players, accounts, turns', async () => {
  const d1 = fakeD1(), db = fromD1(d1);
  await writeRoom(db, roomRow({ seats: 1 }));
  await writeRoom(db, roomRow({ created_at: NOW - DAY, first_start_at: NOW - DAY + 120_000, games_started: 2, games_finished: 1, spectators: 1, chat: 4, rejoins: 2, closed_at: NOW, close_reason: 'admin' }));
  await writeRoom(db, roomRow({ created_at: NOW - 60 * DAY })); // before the period
  // Anna and Ben played 40 days ago, then twice in the period on two days; Cleo is new
  await put(db, quickGame(['Anna', 'Ben']), { finishedAt: NOW - 40 * DAY });
  await put(db, quickGame(['Anna', 'Ben']), { finishedAt: Date.UTC(2026, 9, 18, 20), startedAt: Date.UTC(2026, 9, 18, 19, 30) }); // a Sunday, 19:30 UTC
  await put(db, quickGame(['Anna', 'Cleo', 'Ben']), { finishedAt: NOW - 3 * DAY, source: 'phone' });
  d1.raw.prepare("INSERT INTO users (id, name, created_at, updated_at) VALUES ('aaaaaaaaaaaaaaaa', 'Anna', ?, ?), ('bbbbbbbbbbbbbbbb', 'Ben', 0, 0)").run(NOW - DAY, NOW - DAY);
  d1.raw.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at, last_used_at) VALUES ('h1', 'aaaaaaaaaaaaaaaa', 0, ?, ?)").run(NOW + DAY, NOW - DAY);

  const u = await usage(db, q(''));
  assert.deepEqual([u.rooms.created, u.rooms.twoPlus, u.rooms.started, u.rooms.finished, u.rooms.watched, u.rooms.chatted, u.rooms.messages], [2, 1, 1, 1, 1, 1, 4]);
  assert.equal(u.rooms.lobbyMinutes, 2);
  assert.equal(u.rooms.closed.admin, 1);
  assert.equal(u.rooms.rejoinsPerSeat, 1);
  assert.equal(u.when.length, 7);
  assert.equal(u.when[0][19], 1, 'Sunday 19:00 in UTC');
  assert.equal(u.when.flat().reduce((a, b) => a + b, 0), 2);
  assert.equal((await usage(db, q('tz=-120'))).when[0][21], 1, 'and 21:00 two hours east');
  assert.deepEqual(u.sizes, [{ players: 2, n: 1 }, { players: 3, n: 1 }]);
  assert.deepEqual(u.people, { total: 3, fresh: 1, twoDays: 2, fiveGames: 0 });
  assert.deepEqual(u.accounts, { total: 2, fresh: 1, active: 1, passkeys: 0, synced: 0 });
  assert.ok(u.turns.starter.turns > 0 && u.turns.others.turns > 0);
  assert.equal(u.turns.starter.turns + u.turns.others.turns, d1.raw.prepare('SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id = t.game_id WHERE g.finished_at >= ?').get(NOW - 30 * DAY).n);
  const phoneOnly = await usage(db, q('source=phone'));
  assert.deepEqual(phoneOnly.sizes, [{ players: 3, n: 1 }]);
});

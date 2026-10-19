// The stats database: schema, the D1 adapter and the writer, against node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './fake-d1.js';
import { fromD1 } from '../server/d1/db.js';
import { writeRecord, deleteGame } from '../server/d1/write.js';

const game = (over = {}) => ({
  id: 'aaaaaaaaaaaaaaaa', source: 'online', mode: 'dice', room_code: 'K7QPM', status: 'over', early: 0,
  started_at: 1000, finished_at: 61000, rounds: 1, player_count: 2, loser: 'Ben', top_score: 9, margin: 4,
  sheet: '{}', ...over
});
const players = id => [
  { game_id: id, idx: 0, name: 'Anna', name_key: 'anna', score: 5, lost: 0, sevens_outs: 0, shots: 0, turns: 1 },
  { game_id: id, idx: 1, name: 'Ben', name_key: 'ben', score: 9, lost: 1, sevens_outs: 0, shots: 1, turns: 1 }
];
const turns = id => [
  { game_id: id, round: 1, idx: 0, pts: 5, rolls: 2, starter: 1, mark: 2 },
  { game_id: id, round: 1, idx: 1, pts: 9, rolls: 1, starter: 0, mark: 2 }
];
const count = (d1, table) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('a record is written, and writing it again replaces it', async () => {
  const d1 = fakeD1(), db = fromD1(d1);
  await writeRecord(db, { game: game(), players: players('aaaaaaaaaaaaaaaa'), turns: turns('aaaaaaaaaaaaaaaa') });
  assert.equal(count(d1, 'players'), 2);
  assert.equal(count(d1, 'turns'), 2);
  await writeRecord(db, { game: game({ status: 'playing', loser: null }), players: [], turns: [] });
  const rows = await db.all('SELECT status, loser FROM games');
  assert.deepEqual(rows.map(r => ({ ...r })), [{ status: 'playing', loser: null }]);
  assert.equal(count(d1, 'players'), 0, 'old players are removed');
  assert.equal(count(d1, 'turns'), 0, 'old turns are removed');
});

test('deleting a game removes its players and turns', async () => {
  const d1 = fakeD1(), db = fromD1(d1);
  await writeRecord(db, { game: game(), players: players('aaaaaaaaaaaaaaaa'), turns: turns('aaaaaaaaaaaaaaaa') });
  await writeRecord(db, { game: game({ id: 'bbbbbbbbbbbbbbbb' }), players: players('bbbbbbbbbbbbbbbb'), turns: [] });
  await deleteGame(db, 'aaaaaaaaaaaaaaaa');
  assert.equal(count(d1, 'games'), 1);
  assert.equal(count(d1, 'players'), 2);
  assert.equal(count(d1, 'turns'), 0);
});

test('a failing write changes nothing', async () => {
  const d1 = fakeD1(), db = fromD1(d1);
  const bad = turns('aaaaaaaaaaaaaaaa').concat([{ ...turns('aaaaaaaaaaaaaaaa')[0] }]); // duplicate key
  await assert.rejects(writeRecord(db, { game: game(), players: players('aaaaaaaaaaaaaaaa'), turns: bad }));
  assert.equal(count(d1, 'games'), 0);
  d1.down = true;
  await assert.rejects(db.all('SELECT 1'));
});

test('a big game is written in a few statements of at most 100 parameters each', async () => {
  const d1 = fakeD1(), db = fromD1(d1), id = 'cccccccccccccccc', batches = [];
  const spy = { all: db.all, batch: stmts => { batches.push(stmts); return db.batch(stmts); } };
  const six = Array.from({ length: 6 }, (_, i) => ({ game_id: id, idx: i, name: `P${i}`, name_key: `p${i}`, score: 50 + i, lost: i === 5 ? 1 : 0, sevens_outs: 1, shots: 0, turns: 20 }));
  const many = [];
  for (let round = 1; round <= 20; round++) for (let idx = 0; idx < 6; idx++) many.push({ game_id: id, round, idx, pts: (round + idx) % 9, rolls: 1 + (idx % 3), starter: idx === 0 ? 1 : 0, mark: 3 });
  await writeRecord(spy, { game: game({ id, rounds: 20, player_count: 6 }), players: six, turns: many });
  assert.equal(count(d1, 'players'), 6);
  assert.equal(count(d1, 'turns'), 120);
  const sum = d1.raw.prepare('SELECT SUM(pts) AS s FROM turns WHERE round = 20 AND idx = 5').get().s;
  assert.equal(sum, (20 + 5) % 9, 'values land in the right rows');
  const [stmts] = batches;
  assert.equal(batches.length, 1, 'one atomic batch');
  for (const [sql, params] of stmts) assert.ok(params.length <= 100, `${params.length} parameters in: ${sql.slice(0, 40)}`);
  assert.ok(stmts.length <= 13, `${stmts.length} statements`); // 2 deletes, the game, 1 for players, 9 for turns

  await writeRecord(spy, { game: game({ id, rounds: 20, player_count: 6 }), players: six, turns: many });
  assert.equal(count(d1, 'turns'), 120, 'writing it again still replaces it');
});

// The Node server's SQLite database: the same { all, batch } interface as D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/node/sqlite.js';

const GAME = `INSERT INTO games (id, source, mode, status, player_count) VALUES (?, 'online', 'dice', 'over', 2)`;
const PLAYER = `INSERT INTO players (game_id, idx, name, name_key, score, lost, sevens_outs, shots, turns) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0)`;

test('a file keeps what a batch wrote, after closing and reopening it', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sevens-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sevens-out.db');
  let db = openDatabase(file);
  await db.batch([[GAME, ['aaaaaaaaaaaaaaaa']], [PLAYER, ['aaaaaaaaaaaaaaaa', 0, 'Anna', 'anna']]]);
  db.close();
  db = openDatabase(file); // the schema is applied again without harm
  assert.deepEqual(await db.all('SELECT game_id, name FROM players WHERE game_id = ?', ['aaaaaaaaaaaaaaaa']),
    [{ game_id: 'aaaaaaaaaaaaaaaa', name: 'Anna' }]);
  assert.equal(Object.getPrototypeOf((await db.all('SELECT id FROM games'))[0]), Object.prototype);
  assert.deepEqual(await db.all('PRAGMA journal_mode'), [{ journal_mode: 'wal' }]);
  db.close();
});

test('a batch that fails writes nothing', async () => {
  const db = openDatabase(':memory:');
  await assert.rejects(db.batch([[GAME, ['bbbbbbbbbbbbbbbb']], [GAME, ['bbbbbbbbbbbbbbbb']]]), /UNIQUE/);
  // foreign keys are on: a player of an unknown game is refused
  await assert.rejects(db.batch([[PLAYER, ['cccccccccccccccc', 0, 'Ben', 'ben']]]), /FOREIGN KEY/);
  assert.deepEqual(await db.all('SELECT COUNT(*) AS n FROM games'), [{ n: 0 }]);
  await db.batch([[GAME, ['bbbbbbbbbbbbbbbb']]]); // and the database is still usable
  assert.deepEqual(await db.all('SELECT id FROM games'), [{ id: 'bbbbbbbbbbbbbbbb' }]);
  db.close();
});

test('the schema is in place', async () => {
  const db = openDatabase(':memory:');
  const tables = (await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map(r => r.name);
  for (const t of ['games', 'players', 'turns']) assert.ok(tables.includes(t), t);
  db.close();
});

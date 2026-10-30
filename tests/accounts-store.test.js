// The account store (server/d1/accounts.js) and the accounts migration, against node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fakeD1 } from './fake-d1.js';
import { fromD1 } from '../server/d1/db.js';
import { writeRecord } from '../server/d1/write.js';
import * as A from '../server/d1/accounts.js';

const DAY = 24 * 3600 * 1000, T0 = 1_700_000_000_000;
const UID = '0123456789abcdef', OTHER = 'fedcba9876543210';
const key = (id, over = {}) => ({ id, publicKey: `pk-${id}`, alg: -7, signCount: 0, transports: ['internal', 'hybrid'], synced: true, ...over });
const plain = rows => rows.map(r => ({ ...r }));
const count = (d1, table) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function setup() {
  const d1 = fakeD1(), db = fromD1(d1);
  await A.createUser(db, { id: UID, name: 'Anna', now: T0, passkey: key('cred-a'), session: { hash: 'h-a', expiresAt: T0 + A.SESSION_TTL_MS } });
  return { d1, db };
}

test('createUser stores the user, the first passkey and a session', async () => {
  const { db } = await setup();
  assert.deepEqual(await A.getUser(db, UID), { id: UID, name: 'Anna', createdAt: T0, updatedAt: T0 });
  assert.deepEqual(await A.getPasskey(db, 'cred-a'), {
    id: 'cred-a', userId: UID, publicKey: 'pk-cred-a', alg: -7, signCount: 0,
    transports: ['internal', 'hybrid'], synced: true, createdAt: T0, lastUsedAt: null
  });
  assert.deepEqual(await A.sessionUser(db, 'h-a', T0), { id: UID, name: 'Anna' });
  assert.equal(await A.getUser(db, OTHER), null);
  assert.equal(await A.getPasskey(db, 'nope'), null);
});

test('createUser is all or nothing', async () => {
  const { d1, db } = await setup();
  // the passkey id is taken, so the user and session must not be stored either
  await assert.rejects(A.createUser(db, { id: OTHER, name: 'Ben', now: T0, passkey: key('cred-a'), session: { hash: 'h-b', expiresAt: T0 + DAY } }));
  assert.equal(await A.getUser(db, OTHER), null);
  assert.equal(count(d1, 'sessions'), 1);
});

test('renameUser changes the name and updated_at', async () => {
  const { db } = await setup();
  await A.renameUser(db, UID, 'Annie', T0 + 5);
  assert.deepEqual(await A.getUser(db, UID), { id: UID, name: 'Annie', createdAt: T0, updatedAt: T0 + 5 });
  assert.deepEqual(await A.sessionUser(db, 'h-a', T0 + 6), { id: UID, name: 'Annie' });
});

test('passkeys: add, list oldest first, touch', async () => {
  const { db } = await setup();
  await A.addPasskey(db, UID, key('cred-b', { alg: -257, transports: undefined, synced: false, signCount: 3 }), T0 + 10);
  const list = await A.listPasskeys(db, UID);
  assert.deepEqual(list.map(k => k.id), ['cred-a', 'cred-b']);
  assert.deepEqual(list[1], {
    id: 'cred-b', userId: UID, publicKey: 'pk-cred-b', alg: -257, signCount: 3,
    transports: [], synced: false, createdAt: T0 + 10, lastUsedAt: null
  });
  assert.deepEqual(await A.listPasskeys(db, OTHER), []);

  await A.touchPasskey(db, 'cred-b', { signCount: 7, synced: true, now: T0 + 20 });
  let k = await A.getPasskey(db, 'cred-b');
  assert.deepEqual([k.signCount, k.synced, k.lastUsedAt], [7, true, T0 + 20]);
  await A.touchPasskey(db, 'cred-b', { signCount: 8, now: T0 + 30 });
  k = await A.getPasskey(db, 'cred-b');
  assert.deepEqual([k.signCount, k.synced, k.lastUsedAt], [8, true, T0 + 30], 'synced left out keeps the flag');
});

test('a passkey needs an existing user, and its id is unique', async () => {
  const { db } = await setup();
  await assert.rejects(A.addPasskey(db, OTHER, key('cred-x'), T0), /FOREIGN KEY/);
  await assert.rejects(A.addPasskey(db, UID, key('cred-a'), T0), /UNIQUE/);
  await assert.rejects(A.createSession(db, { hash: 'h-x', userId: OTHER, now: T0 }), /FOREIGN KEY/);
});

test('deletePasskey removes only the user\'s own passkey and never the last one', async () => {
  const { db } = await setup();
  assert.equal(await A.deletePasskey(db, UID, 'cred-a'), false, 'the last passkey stays');
  await A.addPasskey(db, UID, key('cred-b'), T0 + 1);
  await A.createUser(db, { id: OTHER, name: 'Ben', now: T0, passkey: key('cred-c'), session: { hash: 'h-c', expiresAt: T0 + DAY } });
  await A.addPasskey(db, OTHER, key('cred-d'), T0 + 1);
  assert.equal(await A.deletePasskey(db, OTHER, 'cred-a'), false, 'not Ben\'s passkey');
  assert.equal(await A.deletePasskey(db, UID, 'missing'), false);
  assert.equal(await A.deletePasskey(db, UID, 'cred-a'), true);
  assert.deepEqual((await A.listPasskeys(db, UID)).map(k => k.id), ['cred-b']);
  assert.equal(await A.deletePasskey(db, UID, 'cred-b'), false, 'now cred-b is the last one');
  assert.equal((await A.listPasskeys(db, OTHER)).length, 2);
});

test('challenges are single use and expire', async () => {
  const { db } = await setup();
  await A.putChallenge(db, { id: 'c1', challenge: 'xyz', purpose: 'create', name: 'Ben', expiresAt: T0 + A.CHALLENGE_TTL_MS });
  await A.putChallenge(db, { id: 'c2', challenge: 'abc', purpose: 'add', userId: UID, expiresAt: T0 + A.CHALLENGE_TTL_MS });
  await A.putChallenge(db, { id: 'c3', challenge: 'old', purpose: 'signin', expiresAt: T0 + A.CHALLENGE_TTL_MS });
  assert.deepEqual(await A.takeChallenge(db, 'c1', T0 + 1000), { challenge: 'xyz', purpose: 'create', userId: null, name: 'Ben' });
  assert.equal(await A.takeChallenge(db, 'c1', T0 + 1000), null, 'second take');
  assert.deepEqual(await A.takeChallenge(db, 'c2', T0 + A.CHALLENGE_TTL_MS - 1), { challenge: 'abc', purpose: 'add', userId: UID, name: null });
  assert.equal(await A.takeChallenge(db, 'c3', T0 + A.CHALLENGE_TTL_MS), null, 'expired');
  assert.deepEqual(await db.all('SELECT id FROM auth_challenges'), [], 'an expired challenge is gone too');
  assert.equal(await A.takeChallenge(db, 'nope', T0), null);
  await assert.rejects(A.putChallenge(db, { id: 'c4', challenge: 'q', purpose: 'hack', expiresAt: T0 }), /CHECK/);
});

test('sessions expire, and slide at most once a day', async () => {
  const { d1, db } = await setup();
  const row = () => ({ ...d1.raw.prepare('SELECT expires_at, last_used_at FROM sessions WHERE hash = ?').get('h-a') });
  await A.sessionUser(db, 'h-a', T0 + DAY - 1);
  assert.deepEqual(row(), { expires_at: T0 + A.SESSION_TTL_MS, last_used_at: T0 }, 'not written within a day');
  await A.sessionUser(db, 'h-a', T0 + DAY);
  assert.deepEqual(row(), { expires_at: T0 + DAY + A.SESSION_TTL_MS, last_used_at: T0 + DAY });

  const end = T0 + DAY + A.SESSION_TTL_MS;
  assert.deepEqual(await A.sessionUser(db, 'h-a', end - 1), { id: UID, name: 'Anna' });
  assert.equal(await A.sessionUser(db, 'h-a', end - 1 + A.SESSION_TTL_MS), null, 'expired');
  assert.equal(await A.sessionUser(db, 'missing', T0), null);

  await A.createSession(db, { hash: 'h-short', userId: UID, now: T0, expiresAt: T0 + 100 });
  assert.deepEqual(await A.sessionUser(db, 'h-short', T0 + 99, { ttl: 1000, refreshEvery: 50 }), { id: UID, name: 'Anna' });
  assert.deepEqual({ ...d1.raw.prepare('SELECT expires_at FROM sessions WHERE hash = ?').get('h-short') }, { expires_at: T0 + 1099 });
  assert.equal(await A.sessionUser(db, 'h-short', T0 + 1099), null);

  await A.createSession(db, { hash: 'h-default', userId: UID, now: T0 });
  assert.equal(d1.raw.prepare('SELECT expires_at FROM sessions WHERE hash = ?').get('h-default').expires_at, T0 + A.SESSION_TTL_MS);
});

test('deleteSession and deleteSessions', async () => {
  const { db } = await setup();
  await A.createSession(db, { hash: 'h-b', userId: UID, now: T0 });
  await A.createUser(db, { id: OTHER, name: 'Ben', now: T0, passkey: key('cred-c'), session: { hash: 'h-c', expiresAt: T0 + DAY } });
  await A.deleteSession(db, 'h-a');
  assert.equal(await A.sessionUser(db, 'h-a', T0), null);
  assert.ok(await A.sessionUser(db, 'h-b', T0));
  await A.deleteSessions(db, UID);
  assert.equal(await A.sessionUser(db, 'h-b', T0), null);
  assert.ok(await A.sessionUser(db, 'h-c', T0), 'other users keep theirs');
});

test('purgeExpired removes expired challenges and sessions only', async () => {
  const { d1, db } = await setup();
  await A.createSession(db, { hash: 'h-old', userId: UID, now: T0, expiresAt: T0 + 10 });
  await A.putChallenge(db, { id: 'c-old', challenge: 'x', purpose: 'signin', expiresAt: T0 + 10 });
  await A.putChallenge(db, { id: 'c-new', challenge: 'y', purpose: 'signin', expiresAt: T0 + 11 });
  await A.purgeExpired(db, T0 + 10);
  assert.deepEqual(plain(await db.all('SELECT hash FROM sessions')), [{ hash: 'h-a' }]);
  assert.deepEqual(plain(await db.all('SELECT id FROM auth_challenges')), [{ id: 'c-new' }]);
  assert.equal(count(d1, 'users'), 1);
});

test('deleteUser removes the account and unlinks the stats rows', async () => {
  const { d1, db } = await setup();
  await A.addPasskey(db, UID, key('cred-b'), T0);
  await A.putChallenge(db, { id: 'c-add', challenge: 'x', purpose: 'add', userId: UID, expiresAt: T0 + DAY });
  await A.createUser(db, { id: OTHER, name: 'Ben', now: T0, passkey: key('cred-c'), session: { hash: 'h-c', expiresAt: T0 + DAY } });
  await writeRecord(db, {
    game: { id: 'aaaaaaaaaaaaaaaa', source: 'online', mode: 'dice', status: 'over', early: 0, player_count: 2 },
    players: [
      { game_id: 'aaaaaaaaaaaaaaaa', idx: 0, name: 'Anna', name_key: 'anna', score: 5, lost: 0, sevens_outs: 0, shots: 0, turns: 1 },
      { game_id: 'aaaaaaaaaaaaaaaa', idx: 1, name: 'Ben', name_key: 'ben', score: 9, lost: 1, sevens_outs: 0, shots: 0, turns: 1 }
    ],
    turns: []
  });
  d1.raw.prepare('UPDATE players SET user_id = CASE idx WHEN 0 THEN ? ELSE ? END').run(UID, OTHER);

  await A.deleteUser(db, UID);
  assert.equal(await A.getUser(db, UID), null);
  assert.deepEqual(await A.listPasskeys(db, UID), []);
  assert.equal(await A.sessionUser(db, 'h-a', T0), null);
  assert.equal(await A.takeChallenge(db, 'c-add', T0), null);
  assert.deepEqual(plain(await db.all('SELECT name, user_id FROM players ORDER BY idx')),
    [{ name: 'Anna', user_id: null }, { name: 'Ben', user_id: OTHER }], 'the row keeps the name');
  assert.ok(await A.getUser(db, OTHER));
  assert.equal((await A.listPasskeys(db, OTHER)).length, 1);
});

test('deleting a user row cascades to passkeys and sessions', async () => {
  const { d1 } = await setup();
  d1.raw.prepare('DELETE FROM users WHERE id = ?').run(UID);
  assert.equal(count(d1, 'passkeys'), 0);
  assert.equal(count(d1, 'sessions'), 0);
});

test('players.user_id has no foreign key', async () => {
  const { d1, db } = await setup();
  await writeRecord(db, { game: { id: 'bbbbbbbbbbbbbbbb', source: 'phone', mode: 'score', status: 'over', early: 0, player_count: 1 }, players: [], turns: [] });
  d1.raw.prepare("INSERT INTO players (game_id, idx, name, name_key, score, lost, sevens_outs, shots, turns, user_id) VALUES ('bbbbbbbbbbbbbbbb', 0, 'Cy', 'cy', 0, 1, 0, 0, 1, 'nobody')").run();
  assert.equal(count(d1, 'players'), 1);
});

// the migration brings a database made from the old schema to the same tables, columns and indexes as schema.sql
test('migrations 0001 to 0003 turn the old schema into the new one', () => {
  const sql = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const shape = db => db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map(o => ({ ...o, cols: o.type === 'table' ? db.prepare(`PRAGMA table_xinfo(${o.name})`).all().map(c => ({ ...c })) : undefined,
      fks: o.type === 'table' ? db.prepare(`PRAGMA foreign_key_list(${o.name})`).all().map(f => ({ ...f })) : undefined,
      idx: o.type === 'index' ? db.prepare(`PRAGMA index_info(${o.name})`).all().map(c => c.name) : undefined }));
  const open = (...files) => { const db = new DatabaseSync(':memory:'); for (const f of files) db.exec(sql(f)); return db; };

  const migrated = open('./fixtures/schema-v1.sql', '../server/d1/migrations/0001-accounts.sql', '../server/d1/migrations/0002-rooms.sql', '../server/d1/migrations/0003-kinds.sql', '../server/d1/migrations/0004-flags.sql');
  const fresh = open('../server/d1/schema.sql');
  assert.deepEqual(shape(migrated), shape(fresh));
  assert.ok(shape(fresh).some(o => o.name === 'users'));
  const text = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('users', 'passkeys', 'sessions', 'auth_challenges')").all().map(o => ({ ...o }));
  assert.deepEqual(text(migrated), text(fresh), 'the new tables match, CHECK included');
  assert.throws(() => migrated.exec(sql('../server/d1/migrations/0001-accounts.sql')), /duplicate column/, 'runs once');
  migrated.exec(sql('../server/d1/migrations/0002-rooms.sql')); // safe to run again
  // rooms itself gained kind through ALTER TABLE in 0003, so only its shape matches (above)
  const rooms = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE name = 'room_events'").all().map(o => ({ ...o }));
  assert.deepEqual(rooms(migrated), rooms(fresh));
  assert.throws(() => migrated.exec(sql('../server/d1/migrations/0003-kinds.sql')), /duplicate column/, 'runs once');
  migrated.exec(sql('../server/d1/migrations/0004-flags.sql')); // safe to run again
  const games = db => db.prepare("SELECT kind FROM games").all().map(o => ({ ...o }));
  const old = open('./fixtures/schema-v1.sql');
  old.exec("INSERT INTO games (id, source, mode, status, player_count) VALUES ('aaaaaaaaaaaaaaaa', 'phone', 'dice', 'over', 2)");
  for (const f of ['0001-accounts', '0002-rooms', '0003-kinds', '0004-flags']) old.exec(sql(`../server/d1/migrations/${f}.sql`));
  assert.deepEqual(games(old), [{ kind: 'sevens' }], 'games recorded before are Sevens Out');
});

test('party flags: none, configured, flipped', async () => {
  const d1 = fakeD1(), db = fromD1(d1);
  assert.equal(await A.partyConfig(db), null);
  const put = (name, value) => d1.raw.prepare('INSERT INTO flags (name, value, updated_at) VALUES (?, ?, 0)').run(name, value);
  put('party_owner', 'a'.repeat(16));
  assert.equal(await A.partyConfig(db), null, 'needs both the owner and the player');
  put('party_for', 'b'.repeat(16));
  assert.deepEqual(await A.partyConfig(db), { owner: 'a'.repeat(16), for: 'b'.repeat(16), age: null, on: false });
  put('party_age', '48');
  await A.setPartyOn(db, true, 1);
  assert.deepEqual(await A.partyConfig(db), { owner: 'a'.repeat(16), for: 'b'.repeat(16), age: 48, on: true });
  await A.setPartyOn(db, false, 2);
  assert.equal((await A.partyConfig(db)).on, false);
});

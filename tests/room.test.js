// Room server tests: the protocol core with in-memory connections. Run with `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { Room } from '../server/core/room.js';

const E = globalThis.SevensEngine;

// an in-memory room: conns are plain objects that collect what the server sends them
function makeRoom(stats = null) {
  let stored = null;
  const conns = new Set();
  const net = {
    send: (c, m) => c.inbox.push(m),
    conns: () => [...conns].filter(c => c.open),
    seatOf: c => c.seat || null,
    bind: (c, s) => { c.seat = s; },
    close: c => { c.open = false; conns.delete(c); }
  };
  const storage = { get: async () => stored && JSON.parse(stored), put: async d => { stored = JSON.stringify(d); }, remove: async () => { stored = null; } };
  const room = new Room({ engine: E, storage, net, stats });
  const connect = () => { const c = { inbox: [], open: true, seat: null }; conns.add(c); return c; };
  const drop = async c => { c.open = false; conns.delete(c); await room.closed(c); };
  return { room, connect, drop, stored: () => stored && JSON.parse(stored), fresh: () => new Room({ engine: E, storage, net, stats }) };
}
const send = (room, c, m) => room.message(c, JSON.stringify(m), 'K7QPM');
const last = (c, t) => [...c.inbox].reverse().find(m => m.t === t);

async function lobbyOf2(opts = {}) {
  const r = makeRoom(opts.stats);
  const a = r.connect(), b = r.connect();
  await send(r.room, a, { t: 'hello', name: 'Anna', create: true });
  await send(r.room, b, { t: 'hello', name: 'Ben' });
  if (opts.mode) await send(r.room, a, { t: 'lobby', op: 'settings', mode: opts.mode });
  return { ...r, a, b };
}

test('create, join, and everyone sees the same lobby', async () => {
  const { a, b } = await lobbyOf2();
  assert.ok(last(a, 'welcome').token, 'host gets a token');
  const room = last(b, 'room').room;
  assert.equal(room.code, 'K7QPM');
  assert.deepEqual(room.seats.map(s => s.name), ['Anna', 'Ben']);
  assert.equal(room.host, last(a, 'welcome').seat);
  assert.ok(room.seats.every(s => s.connected));
  assert.ok(!JSON.stringify(last(b, 'room')).includes(last(a, 'welcome').token), 'tokens are never broadcast');
});

test('joining a room that does not exist, or creating one that does, is refused', async () => {
  const r = makeRoom(), c = r.connect();
  await send(r.room, c, { t: 'hello', name: 'X' });
  assert.equal(last(c, 'error').code, 'no_room');
  const { room, connect } = await lobbyOf2();
  const d = connect();
  await send(room, d, { t: 'hello', name: 'Dan', create: true });
  assert.equal(last(d, 'error').code, 'room_taken');
});

test('duplicate names get a number, and a room holds six', async () => {
  const { room, connect } = await lobbyOf2();
  const names = [];
  for (let i = 0; i < 5; i++) { const c = connect(); await send(room, c, { t: 'hello', name: 'Ben' }); names.push(c); }
  const seats = last(names[3], 'room').room.seats.map(s => s.name);
  assert.deepEqual(seats, ['Anna', 'Ben', 'Ben 2', 'Ben 3', 'Ben 4', 'Ben 5']);
  assert.equal(last(names[4], 'error').code, 'room_full');
});

test('only the host starts, and the server rolls the dice for the player whose turn it is', async () => {
  const { room, a, b } = await lobbyOf2();
  await send(room, b, { t: 'lobby', op: 'start' });
  assert.equal(last(b, 'error').code, 'host_only');
  await send(room, a, { t: 'lobby', op: 'start' });
  const msg = last(b, 'room');
  assert.equal(msg.room.phase, 'game');
  assert.equal(msg.state.phase, 'play');
  assert.deepEqual(msg.state.game.seats, [last(a, 'welcome').seat, last(b, 'welcome').seat]);
  await send(room, b, { t: 'act', action: { type: 'roll' } });
  assert.equal(last(b, 'error').code, 'not_your_turn');
  const rev = last(b, 'room').rev;
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  const after = last(b, 'room');
  assert.equal(after.rev, rev + 1);
  assert.equal(after.state.game.turn.rolls, 1);
  assert.equal(after.events[0].type, 'rolled');
  assert.ok(after.state.game.turn.dice.every(d => d.value >= 1 && d.value <= 6));
});

test('a full online game reaches the end with both phones in sync', async () => {
  const { room, a, b } = await lobbyOf2({ mode: 'score' });
  await send(room, a, { t: 'lobby', op: 'start' });
  const seatA = last(a, 'welcome').seat;
  let guard = 0;
  while (guard++ < 500) {
    const st = last(a, 'room').state;
    if (st.phase === 'over') break;
    if (st.phase === 'roundEnd') { await send(room, b, { t: 'act', action: { type: 'nextround' } }); continue; }
    const g = st.game, who = g.seats[g.order[g.pos]] === seatA ? a : b;
    await send(room, who, { t: 'act', action: { type: 'score', pts: 20, rolls: g.pos === 0 ? 2 : undefined } });
  }
  assert.equal(last(a, 'room').state.phase, 'over');
  assert.deepEqual(last(a, 'room').state, last(b, 'room').state);
});

test('rejoining with the token gets the same seat back, and a stranger mid-game only watches', async () => {
  const { room, a, b, connect, drop } = await lobbyOf2();
  await send(room, a, { t: 'lobby', op: 'start' });
  const tokenB = last(b, 'welcome').token, seatB = last(b, 'welcome').seat;
  await drop(b);
  assert.equal(last(a, 'room').room.seats[1].connected, false, 'others see Ben offline');
  const b2 = connect();
  await send(room, b2, { t: 'hello', name: 'whatever', token: tokenB });
  assert.equal(last(b2, 'welcome').seat, seatB);
  assert.equal(last(a, 'room').room.seats[1].connected, true);
  const s = connect();
  await send(room, s, { t: 'hello', name: 'Sam' });
  assert.equal(last(s, 'welcome').seat, null);
  assert.equal(last(s, 'room').state.phase, 'play');
  await send(room, s, { t: 'act', action: { type: 'roll' } });
  assert.equal(last(s, 'error').code, 'not_seated');
});

test('the host can play for a player who is offline, but not for one who is online', async () => {
  const { room, a, b, drop } = await lobbyOf2();
  await send(room, a, { t: 'lobby', op: 'settings', starter: 1 });
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  assert.equal(last(a, 'error').code, 'not_your_turn');
  await drop(b);
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  assert.equal(last(a, 'room').state.game.turn.rolls, 1);
});

test('when the host is offline, the next connected player runs the room', async () => {
  const { room, a, b, drop } = await lobbyOf2();
  await drop(a);
  const hostNow = last(b, 'room').room.host;
  assert.equal(hostNow, last(b, 'welcome').seat);
  await send(room, b, { t: 'lobby', op: 'start' });
  assert.equal(last(b, 'room').room.phase, 'game');
});

test('the room survives a restart: state comes back from storage', async () => {
  const r = await lobbyOf2();
  await send(r.room, r.a, { t: 'lobby', op: 'start' });
  await send(r.room, r.a, { t: 'act', action: { type: 'roll' } });
  const again = r.fresh(), c = r.connect();
  await again.message(c, JSON.stringify({ t: 'hello', token: last(r.a, 'welcome').token }), 'K7QPM');
  assert.equal(last(c, 'room').state.game.turn.rolls, 1);
});

test('kick, leave, reopen and bad input', async () => {
  const { room, a, b, connect } = await lobbyOf2();
  const c = connect();
  await send(room, c, { t: 'hello', name: 'Cleo' });
  await send(room, a, { t: 'lobby', op: 'kick', seat: last(c, 'welcome').seat });
  assert.equal(last(c, 'error').code, 'kicked');
  assert.equal(last(a, 'room').room.seats.length, 2);
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'act', action: { type: 'endearly' } });
  assert.equal(last(a, 'room').state.phase, 'over');
  await send(room, a, { t: 'lobby', op: 'reopen' });
  assert.equal(last(b, 'room').room.phase, 'lobby');
  await send(room, b, { t: 'lobby', op: 'leave' });
  assert.equal(last(a, 'room').room.seats.length, 1);
  await room.message(a, 'not json', 'K7QPM');
  assert.equal(last(a, 'error').code, 'bad_message');
  await room.message(a, 'x'.repeat(5000), 'K7QPM');
  assert.equal(last(a, 'error').message, 'Message too large.');
});

const recorder = () => { const records = []; return { records, record: async rec => { records.push(rec); } }; };
async function playToEnd(room, a, b) {
  const seatA = last(a, 'welcome').seat;
  for (let guard = 0; guard < 500; guard++) {
    const st = last(a, 'room').state;
    if (st.phase === 'over') return;
    if (st.phase === 'roundEnd') { await send(room, b, { t: 'act', action: { type: 'nextround' } }); continue; }
    const g = st.game, who = g.seats[g.order[g.pos]] === seatA ? a : b;
    await send(room, who, { t: 'act', action: { type: 'score', pts: 20, rolls: g.pos === 0 ? 2 : undefined } });
  }
  throw new Error('the game did not end');
}

test('statistics: a game is recorded when it starts, ends, is undone, and when a new game starts', async () => {
  const stats = recorder();
  const { room, a, b } = await lobbyOf2({ mode: 'score', stats });
  await send(room, a, { t: 'lobby', op: 'start' });
  const first = stats.records.at(-1).game;
  assert.equal(first.status, 'playing');
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.equal(first.source, 'online');
  assert.equal(first.room_code, 'K7QPM');
  assert.equal(stats.records.at(-1).players.length, 0);

  await playToEnd(room, a, b);
  const over = stats.records.at(-1);
  assert.equal(over.game.status, 'over');
  assert.equal(over.game.id, first.id);
  assert.equal(over.players.length, 2);
  assert.ok(over.game.finished_at >= over.game.started_at);
  const recordsBefore = stats.records.length;

  await send(room, b, { t: 'act', action: { type: 'undo' } });
  assert.equal(stats.records.at(-1).game.status, 'playing', 'undo takes the game out of game over');
  await playToEnd(room, a, b);
  assert.equal(stats.records.at(-1).game.status, 'over');
  assert.equal(stats.records.length, recordsBefore + 2);

  await send(room, a, { t: 'lobby', op: 'reopen' });
  assert.equal(stats.records.length, recordsBefore + 2, 'a finished game is not abandoned');
  await send(room, a, { t: 'lobby', op: 'start' });
  const second = stats.records.at(-1).game;
  assert.notEqual(second.id, first.id, 'a new game gets a new id');
  await send(room, a, { t: 'lobby', op: 'reopen' });
  assert.deepEqual([stats.records.at(-1).game.id, stats.records.at(-1).game.status], [second.id, 'abandoned']);
});

test('statistics: an expired room with an unfinished game counts it as abandoned', async () => {
  const stats = recorder();
  const { room, a } = await lobbyOf2({ stats });
  await room.expire();
  assert.equal(stats.records.length, 0, 'nothing to record in the lobby');
  await send(room, a, { t: 'lobby', op: 'start' });
  await room.expire();
  assert.equal(stats.records.at(-1).game.status, 'abandoned');
});

test('statistics: a failing adapter does not stop the game', async () => {
  const stats = { record: async () => { throw new Error('D1 is down'); } };
  const { room, a, b } = await lobbyOf2({ stats });
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  assert.equal(last(b, 'room').state.game.turn.rolls, 1);
});

test('statistics: "New game" reaches everyone before the abandoned game is recorded', async () => {
  const seen = [];
  const stats = { record: async rec => { seen.push([rec.game.status, last(b, 'room').room.phase]); throw new Error('D1 is down'); } };
  const { room, a, b } = await lobbyOf2({ stats });
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'lobby', op: 'reopen' });
  assert.deepEqual(seen.at(-1), ['abandoned', 'lobby'], 'the lobby is shown first');
  assert.equal(last(a, 'room').room.phase, 'lobby');
  assert.equal(last(a, 'error'), undefined, 'a failing record does not abort the reopen');
});

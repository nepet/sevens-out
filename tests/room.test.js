// Room server tests: the protocol core with in-memory connections. Run with `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../engine.js';
import { legacyRoundEnd } from './games.js';
import { Room, TRACK_EVERY_MS } from '../server/core/room.js';

const E = globalThis.SevensEngine;

// an in-memory room: conns are plain objects that collect what the server sends them
function makeRoom(stats = null, accounts = null, now = undefined, sessions = null) {
  let stored = null;
  const conns = new Set();
  const net = {
    send: (c, m) => c.inbox.push(m),
    conns: () => [...conns].filter(c => c.open),
    seatOf: c => c.seat || null,
    bind: (c, s, info) => { c.seat = s; if (info !== undefined) c.info = info; },
    infoOf: c => c.info || null,
    close: c => { c.open = false; conns.delete(c); }
  };
  const storage = { get: async () => stored && JSON.parse(stored), put: async d => { stored = JSON.stringify(d); }, remove: async () => { stored = null; } };
  const room = new Room({ engine: E, storage, net, stats, accounts, sessions, ...(now ? { now } : {}) });
  const connect = () => { const c = { inbox: [], open: true, seat: null }; conns.add(c); return c; };
  const drop = async c => { c.open = false; conns.delete(c); await room.closed(c); };
  return { room, connect, drop, setStored: d => { stored = JSON.stringify(d); }, stored: () => stored && JSON.parse(stored), fresh: (more = {}) => new Room({ engine: E, storage, net, stats, ...more }) };
}
const send = (room, c, m) => room.message(c, JSON.stringify(m), 'K7QPM');
const last = (c, t) => [...c.inbox].reverse().find(m => m.t === t);

async function lobbyOf2(opts = {}) {
  const r = makeRoom(opts.stats, null, opts.now, opts.sessions);
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

test('duplicate names get a number, and a room holds twelve', async () => {
  const { room, connect, a } = await lobbyOf2();
  const names = [];
  for (let i = 0; i < 11; i++) { const c = connect(); await send(room, c, { t: 'hello', name: 'Ben' }); names.push(c); }
  const seats = last(names[9], 'room').room.seats.map(s => s.name);
  assert.deepEqual(seats, ['Anna', 'Ben', ...Array.from({ length: 10 }, (_, i) => `Ben ${i + 2}`)]);
  assert.equal(last(names[10], 'error').code, 'room_full');
  assert.ok(!names[10].open, 'the 13th is sent away');
  // the last seat can be chosen to start, and twelve can play
  await send(room, a, { t: 'lobby', op: 'settings', starter: 11 });
  await send(room, a, { t: 'lobby', op: 'start' });
  const msg = last(names[9], 'room');
  assert.equal(msg.room.phase, 'game');
  assert.equal(msg.state.game.players.length, 12);
  assert.equal(msg.state.game.starter, 11);
  assert.equal(msg.state.game.seats[11], last(names[9], 'welcome').seat);
});

test('a random starter can be any of twelve seats', async () => {
  const seen = new Set();
  for (let k = 0; k < 120 && seen.size < 12; k++) {
    const { room, connect, a } = await lobbyOf2();
    for (let i = 0; i < 10; i++) await send(room, connect(), { t: 'hello', name: `P${i}` });
    await send(room, a, { t: 'lobby', op: 'settings', starter: 'random' });
    await send(room, a, { t: 'lobby', op: 'start' });
    seen.add(last(a, 'room').state.game.starter);
  }
  assert.equal(seen.size, 12);
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

test('a missed 7-pair is shown on every phone', async () => {
  const { room, a, b } = await lobbyOf2();
  await send(room, a, { t: 'lobby', op: 'start' });
  // the server rolls 1 6 2 5 3 3 (byte b gives face b % 6 + 1)
  const orig = crypto.getRandomValues, seq = [0, 5, 1, 4, 2, 2];
  crypto.getRandomValues = arr => { arr[0] = seq.shift(); return arr; };
  try { await send(room, a, { t: 'act', action: { type: 'roll' } }); } finally { crypto.getRandomValues = orig; }
  await send(room, a, { t: 'act', action: { type: 'pair', a: 0, b: 1 } });
  await send(room, a, { t: 'act', action: { type: 'stop' } });
  for (const c of [a, b]) assert.deepEqual(last(c, 'room').events[0], { type: 'missed', player: 0, how: 'stop', pairs: [[2, 5]] });
});

test('a roll that leaves nothing to do books the turn on every phone, and the turn passes on', async () => {
  const { room, a, b } = await lobbyOf2();
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  await send(room, a, { t: 'act', action: { type: 'stop' } }); // Anna sets the limit at one roll
  // Ben has one roll; all 2s leave no 7-pair, so the roll ends his turn and the round
  const orig = crypto.getRandomValues;
  crypto.getRandomValues = arr => { arr[0] = 1; return arr; };
  try { await send(room, b, { t: 'act', action: { type: 'roll' } }); } finally { crypto.getRandomValues = orig; }
  for (const c of [a, b]) {
    const m = last(c, 'room');
    assert.deepEqual(m.events.map(e => e.type).slice(0, 2), ['rolled', 'turn']);
    assert.deepEqual(m.state.game.rounds[0].results[1], { pts: 12, rolls: 1 });
    assert.equal(m.state.game.round, 2);
  }
  await send(room, b, { t: 'act', action: { type: 'stop' } }); // nothing to stop: Ben's turn is over
  assert.ok(last(b, 'error'));
});

test('a full online game reaches the end with both phones in sync', async () => {
  const { room, a, b } = await lobbyOf2({ mode: 'score' });
  await send(room, a, { t: 'lobby', op: 'start' });
  const seatA = last(a, 'welcome').seat;
  let guard = 0;
  while (guard++ < 500) {
    const st = last(a, 'room').state;
    if (st.phase === 'over') break;
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

test('the 7s are found by hand unless the host lets the app find them', async () => {
  const { room, a, b } = await lobbyOf2();
  assert.equal(last(a, 'room').room.settings.pairing, 'manual');
  await send(room, b, { t: 'lobby', op: 'settings', pairing: 'auto' });
  assert.equal(last(b, 'error').code, 'host_only');
  await send(room, a, { t: 'lobby', op: 'settings', pairing: 'sometimes' });
  assert.equal(last(a, 'room').room.settings.pairing, 'manual', 'unknown values are ignored');
  await send(room, a, { t: 'lobby', op: 'settings', pairing: 'auto' });
  assert.equal(last(b, 'room').room.settings.pairing, 'auto');
  await send(room, a, { t: 'lobby', op: 'start' });
  assert.equal(last(b, 'room').state.game.pairing, 'auto');
});

test('a room saved before the pairing setting existed starts a game where the 7s are found by hand', async () => {
  const { room, a, b } = await lobbyOf2();
  delete room.data.settings.pairing;
  await send(room, a, { t: 'lobby', op: 'start' });
  assert.equal(last(b, 'room').state.game.pairing, 'manual');
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  assert.deepEqual(last(b, 'room').state.game.turn.pairs, []);
  await send(room, a, { t: 'act', action: { type: 'takeall' } });
  assert.equal(last(a, 'error').code, 'by_hand');
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

test('a room saved between rounds moves on to the next round when it loads', async () => {
  const r = await lobbyOf2({ mode: 'score' });
  await send(r.room, r.a, { t: 'lobby', op: 'start' });
  const tokenA = last(r.a, 'welcome').token;
  for (let i = 0; i < 2; i++) {
    const g = last(r.a, 'room').state.game, who = g.seats[g.order[g.pos]] === last(r.a, 'welcome').seat ? r.a : r.b;
    await send(r.room, who, { t: 'act', action: { type: 'score', pts: i ? 30 : 10, rolls: i ? undefined : 1 } });
  }
  const d = r.stored(), after = d.state;
  assert.equal(after.game.round, 2);
  d.state = legacyRoundEnd(after);
  assert.equal(d.state.phase, 'roundEnd');
  r.setStored(d);
  const again = r.fresh(), c = r.connect();
  await again.message(c, JSON.stringify({ t: 'hello', token: tokenA }), 'K7QPM');
  const st = last(c, 'room').state;
  assert.deepEqual([st.phase, st.game.round, st.game.starter], ['play', 2, after.game.starter]);
});

// signed-in players: sessions resolve to { id, name } through the accounts adapter
const PLAYERS = { 'sess-anna': { id: 'aaaa000000000001', name: 'Anna' }, 'sess-anna2': { id: 'aaaa000000000002', name: 'Anna' }, 'sess-ben': { id: 'bbbb000000000001', name: 'Ben' } };
const accounts = { resolve: async s => PLAYERS[s] || null };

test('players: a signed-in player sits under their player name, and everyone sees the player ID', async () => {
  const r = makeRoom(null, accounts), a = r.connect(), b = r.connect(), c = r.connect(), g = r.connect();
  await send(r.room, a, { t: 'hello', name: 'whatever', session: 'sess-anna', create: true });
  await send(r.room, b, { t: 'hello', name: 'Anna', session: 'sess-anna2' });
  await send(r.room, c, { t: 'hello', name: 'Cleo', session: 'expired' });
  await send(r.room, g, { t: 'hello', name: 'Gus' });
  assert.equal(last(a, 'welcome').user, 'aaaa000000000001');
  assert.equal(last(c, 'welcome').user, null, 'an ended session plays as a guest, and the phone learns it');
  assert.equal(last(g, 'welcome').user, null);
  const seats = last(g, 'room').room.seats;
  assert.deepEqual(seats.map(s => [s.name, s.user]), [['Anna', 'aaaa000000000001'], ['Anna 2', 'aaaa000000000002'], ['Cleo', null], ['Gus', null]]);
});

test('players: a player gets their seat back from another phone, also mid-game, and never takes two', async () => {
  const r = makeRoom(null, accounts), a = r.connect(), b = r.connect();
  await send(r.room, a, { t: 'hello', session: 'sess-anna', create: true });
  await send(r.room, b, { t: 'hello', name: 'Ben' });
  const seat = last(a, 'welcome').seat;
  const again = r.connect();
  await send(r.room, again, { t: 'hello', name: 'Anna', session: 'sess-anna' });
  assert.equal(last(again, 'welcome').seat, seat, 'the same seat, not a new one');
  assert.equal(last(again, 'room').room.seats.length, 2);
  await send(r.room, a, { t: 'lobby', op: 'start' });
  // a new phone without the room token, mid-game
  await r.drop(a); await r.drop(again);
  const phone = r.connect();
  await send(r.room, phone, { t: 'hello', session: 'sess-anna' });
  assert.equal(last(phone, 'welcome').seat, seat);
  assert.ok(last(phone, 'welcome').token, 'the new phone gets the token for later');
  const st = last(phone, 'room').state, cur = st.game.seats[st.game.order[st.game.pos]];
  const mover = cur === seat ? phone : b;
  await send(r.room, mover, { t: 'act', action: { type: 'roll' } });
  assert.equal(last(mover, 'room').state.game.turn.rolls, 1, 'the player plays from the new phone');
  // a stranger mid-game still only watches
  const stranger = r.connect();
  await send(r.room, stranger, { t: 'hello', session: 'sess-ben' });
  assert.equal(last(stranger, 'welcome').seat, null);
});

test('players: a guest who signs in keeps their seat as that player', async () => {
  const r = makeRoom(null, accounts), a = r.connect(), b = r.connect();
  await send(r.room, a, { t: 'hello', name: 'Anna', create: true });
  await send(r.room, b, { t: 'hello', name: 'Benny' });
  const { token, seat } = last(b, 'welcome');
  const b2 = r.connect();
  await send(r.room, b2, { t: 'hello', token, session: 'sess-ben' });
  assert.equal(last(b2, 'welcome').seat, seat);
  assert.deepEqual(last(b2, 'room').room.seats.map(s => [s.name, s.user]), [['Anna', null], ['Ben', 'bbbb000000000001']], 'in the lobby the seat takes the player name');
  // mid-game the name on the score sheet stays
  await send(r.room, a, { t: 'lobby', op: 'start' });
  const a2 = r.connect();
  await send(r.room, a2, { t: 'hello', token: last(a, 'welcome').token, session: 'sess-anna' });
  const room = last(a2, 'room');
  assert.deepEqual(room.room.seats.map(s => [s.name, s.user]), [['Anna', 'aaaa000000000001'], ['Ben', 'bbbb000000000001']]);
  assert.deepEqual(room.state.game.players.map(p => p.name), ['Anna', 'Ben']);
});

test('players: without accounts, or when they fail, everyone plays as a guest', async () => {
  const r = makeRoom(), a = r.connect();
  await send(r.room, a, { t: 'hello', name: 'Anna', session: 'sess-anna', create: true });
  assert.ok(!('user' in last(a, 'welcome')), 'a server without accounts never signs a phone out');
  assert.equal(last(a, 'room').room.seats[0].user, null);
  const broken = makeRoom(null, { resolve: async () => { throw new Error('D1 is down'); } }), c = broken.connect();
  const err = console.error; console.error = () => {};
  try { await send(broken.room, c, { t: 'hello', name: 'Cleo', session: 'sess-anna', create: true }); } finally { console.error = err; }
  assert.deepEqual(last(c, 'room').room.seats.map(s => [s.name, s.user]), [['Cleo', null]]);
  assert.ok(!('user' in last(c, 'welcome')), 'the phone is not told its session ended when the accounts could not be asked');
  // a room saved before seats had players
  const old = makeRoom(null, accounts);
  old.setStored({ v: 1, code: 'K7QPM', created: 1, updated: Date.now(), rev: 3, phase: 'lobby', host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats: [{ id: 's1', name: 'Old', token: 't'.repeat(32) }], state: null });
  const o = old.connect();
  await send(old.room, o, { t: 'hello', token: 't'.repeat(32) });
  assert.deepEqual(last(o, 'room').room.seats.map(s => [s.name, s.user]), [['Old', null]]);
});

test('players: a finished game is recorded with the player ID of each signed-in seat', async () => {
  const stats = recorder();
  const r = makeRoom(stats, accounts), a = r.connect(), b = r.connect();
  await send(r.room, a, { t: 'hello', session: 'sess-ben', create: true });
  await send(r.room, b, { t: 'hello', name: 'Gus' });
  await send(r.room, a, { t: 'lobby', op: 'settings', mode: 'score' });
  await send(r.room, a, { t: 'lobby', op: 'start' });
  await playToEnd(r.room, a, b);
  const rec = stats.records.at(-1);
  assert.equal(rec.game.status, 'over');
  assert.deepEqual(rec.players.map(p => [p.name, p.user_id]), [['Ben', 'bbbb000000000001'], ['Gus', null]]);
});

test('players: a connection says hello once, so it looks a session up at most once', async () => {
  let asked = 0;
  const r = makeRoom(null, { resolve: async s => { asked++; return PLAYERS[s] || null; } }), a = r.connect();
  await send(r.room, a, { t: 'hello', session: 'sess-anna', create: true });
  for (let i = 0; i < 5; i++) await send(r.room, a, { t: 'hello', session: 'fake' + i });
  assert.equal(asked, 1);
  assert.equal(last(a, 'error').code, 'bad_message');
  assert.equal(last(a, 'room').room.seats.length, 1);
});

test('chat: a seated player\'s message reaches every connection, in the lobby and in a game', async () => {
  const { room, a, b } = await lobbyOf2();
  const seat = last(a, 'welcome').seat;
  await send(room, a, { t: 'chat', text: '  nice   roll\u0007 ' });
  for (const x of [a, b]) {
    const m = last(x, 'chat').msg;
    assert.equal(m.text, 'nice roll');
    assert.equal(m.name, 'Anna');
    assert.equal(m.seat, seat);
    assert.equal(m.from, seat);
    assert.equal(m.user, null);
    assert.equal(m.id, 1);
    assert.equal(typeof m.at, 'number');
  }
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'chat', text: 'go' });
  assert.equal(last(b, 'chat').msg.id, 2);
});

test('chat: refused text', async () => {
  const { room, a } = await lobbyOf2();
  for (const text of ['', '   ', '\u0001', 42, 'x'.repeat(141)]) {
    const n = a.inbox.filter(m => m.t === 'chat').length;
    await send(room, a, { t: 'chat', text });
    assert.equal(last(a, 'error').code, 'bad_message');
    assert.equal(a.inbox.filter(m => m.t === 'chat').length, n);
  }
  await send(room, a, { t: 'chat', text: 'x'.repeat(140) });
  assert.equal(last(a, 'chat').msg.text.length, 140);
});

test('chat: bidi controls are stripped, and zero-width-only text is empty', async () => {
  const { room, a } = await lobbyOf2();
  await send(room, a, { t: 'chat', text: '\u202eevil\u202c \u2066x\u2069 \u202a\u202b\u202d\u2067\u2068ok' });
  assert.equal(last(a, 'chat').msg.text, 'evil x ok');
  // a family emoji keeps its zero-width joiners
  await send(room, a, { t: 'chat', text: '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}' });
  assert.equal(last(a, 'chat').msg.text, '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}');
  for (const text of ['\u200b', '\u200b\u200c\u200d', '\u2060 \ufeff', '\u202e\u202c', '\u2066\u200b\u2069']) {
    const n = a.inbox.filter(m => m.t === 'chat').length;
    await send(room, a, { t: 'chat', text });
    assert.equal(last(a, 'error').code, 'bad_message', JSON.stringify(text));
    assert.equal(a.inbox.filter(m => m.t === 'chat').length, n);
  }
});

test('chat: bidi controls are stripped from a spectator\'s name and a seat name', async () => {
  const r = makeRoom(), { room } = r;
  const a = r.connect(), b = r.connect(), c = r.connect();
  await send(room, a, { t: 'hello', name: 'An\u202ena', create: true });
  await send(room, b, { t: 'hello', name: 'Ben' });
  assert.equal(last(a, 'room').room.seats[0].name, 'Anna');
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, c, { t: 'hello', name: '\u2067Dan\u2069\u202d' });
  await send(room, c, { t: 'chat', text: 'hi' });
  assert.equal(last(a, 'chat').msg.name, 'Dan');
  const e = r.connect();
  await send(room, e, { t: 'hello', name: '\u202e\u2066' });
  await send(room, e, { t: 'chat', text: 'hi' });
  assert.equal(last(a, 'chat').msg.name, 'Guest');
});

test('chat: a connection that has not said hello is refused', async () => {
  const { room, connect } = await lobbyOf2();
  const c = connect();
  await send(room, c, { t: 'chat', text: 'hi' });
  assert.equal(last(c, 'error').code, 'not_seated');
  assert.equal(last(c, 'chat'), undefined);
});

test('chat: the rate limit', async () => {
  let t = 1000;
  const r = makeRoom(null, null, () => t);
  const a = r.connect();
  await send(r.room, a, { t: 'hello', name: 'Anna', create: true });
  for (let i = 0; i < 8; i++) await send(r.room, a, { t: 'chat', text: 'm' + i });
  assert.equal(a.inbox.filter(m => m.t === 'chat' && m.msg).length, 8);
  await send(r.room, a, { t: 'chat', text: 'ninth' });
  assert.equal(last(a, 'error').code, 'rate');
  assert.equal(a.inbox.filter(m => m.t === 'chat' && m.msg).length, 8);
  t += 10001;
  await send(r.room, a, { t: 'chat', text: 'again' });
  assert.equal(last(a, 'chat').msg.text, 'again');
});

test('chat: the log follows welcome and is capped at 50', async () => {
  let t = 1000;
  const r = makeRoom(null, null, () => t);
  const a = r.connect();
  await send(r.room, a, { t: 'hello', name: 'Anna', create: true });
  for (let i = 0; i < 55; i++) { if (i % 8 === 0) t += 10001; await send(r.room, a, { t: 'chat', text: 'm' + i }); }
  const c = r.connect();
  await send(r.room, c, { t: 'hello', name: 'Cy' });
  const kinds = c.inbox.map(m => m.t);
  assert.deepEqual(kinds.slice(0, 3), ['welcome', 'chat', 'room']);
  const log = last(c, 'chat').log;
  assert.equal(log.length, 50);
  assert.equal(log[0].id, 6);
  assert.equal(log[49].id, 55);
});

test('chat: no rev change, no room broadcast', async () => {
  const { room, a, b } = await lobbyOf2();
  const rooms = b.inbox.filter(m => m.t === 'room').length, rev = last(b, 'room').rev;
  await send(room, a, { t: 'chat', text: 'hi' });
  assert.equal(b.inbox.filter(m => m.t === 'room').length, rooms);
  assert.equal(room.data.rev, rev);
});

test('chat: stored, and a room saved without chat loads', async () => {
  const { room, a, connect, stored, setStored, fresh } = await lobbyOf2();
  await send(room, a, { t: 'chat', text: 'hi' });
  assert.equal(stored().chat.length, 1);
  const old = stored(); delete old.chat; delete old.chatSeq;
  setStored(old);
  const r2 = fresh(), c = connect();
  await send(r2, c, { t: 'hello', name: 'Cy' });
  assert.deepEqual(last(c, 'chat').log, []);
  await send(r2, c, { t: 'chat', text: 'first' });
  assert.equal(last(c, 'chat').msg.id, 1);
});

test('chat: a spectator chats under their name', async () => {
  let t = 1000;
  const r = makeRoom(null, null, () => t), { room } = r;
  const a = r.connect(), b = r.connect(), c = r.connect();
  await send(room, a, { t: 'hello', name: 'Anna', create: true });
  await send(room, b, { t: 'hello', name: 'Ben' });
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, c, { t: 'hello', name: 'Dan' });
  const viewer = last(c, 'welcome').viewer;
  assert.match(viewer, /^w[0-9a-f]{8}$/);
  assert.deepEqual(c.inbox.map(m => m.t).filter(t => t !== 'room'), ['welcome', 'chat']);
  assert.deepEqual(last(c, 'chat').log, []);
  await send(room, c, { t: 'chat', text: 'go Anna' });
  const msg = last(a, 'chat').msg;
  assert.equal(msg.from, viewer);
  assert.equal(msg.seat, null);
  assert.equal(msg.name, 'Dan');
  assert.equal(msg.user, null);

  const e = r.connect();
  await send(room, e, { t: 'hello', name: '   ' });
  await send(room, e, { t: 'chat', text: 'hi' });
  assert.equal(last(a, 'chat').msg.name, 'Guest');

  const c2 = r.connect();
  await send(room, c2, { t: 'hello', name: 'Dan' });
  assert.notEqual(last(c2, 'welcome').viewer, viewer);

  for (let i = 0; i < 7; i++) await send(room, c, { t: 'chat', text: 'm' + i });
  await send(room, c, { t: 'chat', text: 'ninth' });
  assert.equal(last(c, 'error').code, 'rate');
  assert.ok(!last(a, 'chat').msg || last(a, 'chat').msg.text !== 'ninth');
});

// ----- the admin page's rooms -----
const tracker = () => {
  const rows = [], events = [];
  return { rows, events, kinds: () => events.map(e => e.kind), row: () => rows.at(-1), track: async (row, evs) => { rows.push(row); events.push(...evs); } };
};

test('sessions: the room keeps its row and timeline up to date through a game', async () => {
  const sessions = tracker(), stats = recorder();
  const { room, a, b, connect, drop } = await lobbyOf2({ mode: 'score', sessions, stats });
  const id = sessions.row().id;
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepEqual(sessions.kinds(), ['created', 'joined']);
  assert.deepEqual(sessions.events.map(e => e.detail.name), ['Anna', 'Ben']);
  assert.deepEqual(sessions.events.map(e => e.seq), [1, 2]);
  assert.deepEqual([sessions.row().phase, sessions.row().seats, sessions.row().connected, sessions.row().host, JSON.parse(sessions.row().names)],
    ['lobby', 2, 2, 'Anna', ['Anna', 'Ben']]);
  assert.equal(sessions.row().mode, 'score');
  assert.equal(sessions.row().kind, 'sevens');

  await send(room, a, { t: 'lobby', op: 'start' });
  const started = sessions.events.at(-1);
  assert.equal(started.kind, 'started');
  assert.deepEqual(started.detail, { game: stats.records.at(-1).game.id, players: 2, kind: 'sevens', mode: 'score', pairing: 'manual' });
  assert.deepEqual([sessions.row().phase, sessions.row().round, sessions.row().games_started, sessions.row().game_id],
    ['playing', 1, 1, started.detail.game]);
  assert.ok(sessions.row().first_start_at >= sessions.row().created_at);

  // a stranger watches, a player drops out and comes back
  const w = connect();
  await send(room, w, { t: 'hello', name: 'Cleo' });
  assert.deepEqual([sessions.events.at(-1).kind, sessions.events.at(-1).detail], ['watching', { name: 'Cleo' }]);
  assert.equal(sessions.row().watching, 1);
  await drop(b);
  assert.equal(sessions.row().connected, 1);
  const b2 = connect();
  await send(room, b2, { t: 'hello', token: last(b, 'welcome').token });
  assert.deepEqual([sessions.row().connected, sessions.row().rejoins, sessions.row().connects, sessions.row().spectators, sessions.row().peak], [2, 1, 4, 1, 3]);

  await send(room, a, { t: 'chat', text: 'hi' });
  await playToEnd(room, a, b2);
  const over = sessions.events.at(-1);
  assert.equal(over.kind, 'over');
  assert.equal(over.detail.loser, stats.records.at(-1).game.loser);
  assert.deepEqual([sessions.row().phase, sessions.row().games_finished, sessions.row().chat], ['over', 1, 1]);
  await send(room, a, { t: 'act', action: { type: 'undo' } });
  assert.deepEqual([sessions.events.at(-1).kind, sessions.row().phase, sessions.row().games_finished], ['undone', 'playing', 0]);
  await send(room, a, { t: 'lobby', op: 'reopen' });
  assert.deepEqual(sessions.events.at(-1).detail, { game: started.detail.game, abandoned: true });
  assert.ok(sessions.rows.every(r => r.id === id), 'one row per room');
  assert.ok(!JSON.stringify(sessions.rows).includes(last(a, 'welcome').token), 'no tokens');
});

test('sessions: moves and chat alone write at most once a minute; seats, connections and rounds at once', async () => {
  let t = 1_000_000;
  const sessions = tracker();
  const { room, a, b } = await lobbyOf2({ sessions, now: () => t });
  await send(room, a, { t: 'lobby', op: 'start' });
  const n = sessions.rows.length;
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  await send(room, a, { t: 'chat', text: 'go' });
  assert.equal(sessions.rows.length, n, 'within the minute: nothing');
  t += TRACK_EVERY_MS;
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  assert.equal(sessions.rows.length, n + 1);
  assert.equal(sessions.row().chat, 1);
  await send(room, a, { t: 'act', action: { type: 'stop' } });
  if (last(a, 'room').state.game.turn.rolls) await send(room, a, { t: 'act', action: { type: 'stop' } }); // Stop asks twice only on the page
  await send(room, b, { t: 'act', action: { type: 'roll' } });
  await send(room, b, { t: 'act', action: { type: 'stop' } });
  assert.equal(last(a, 'room').state.game.round, 2);
  assert.equal(sessions.row().round, 2, 'a new round writes at once');
});

test('sessions: a failed write keeps its events for the next one, and play goes on', async () => {
  const sessions = tracker();
  let down = true;
  const flaky = { track: async (row, evs) => { if (down) throw new Error('D1 is down'); return sessions.track(row, evs); } };
  const { room, a, b } = await lobbyOf2({ sessions: flaky });
  await send(room, a, { t: 'lobby', op: 'start' });
  assert.equal(last(b, 'room').room.phase, 'game');
  down = false;
  await send(room, a, { t: 'lobby', op: 'reopen' });
  assert.deepEqual(sessions.kinds(), ['created', 'joined', 'started', 'reopened']);
  assert.deepEqual(sessions.events.map(e => e.seq), [1, 2, 3, 4]);
});

test('sessions: a room closes its row when the last player leaves, when it expires, and when the owner closes it', async () => {
  const s1 = tracker(), r1 = makeRoom(null, null, undefined, s1), x = r1.connect();
  await send(r1.room, x, { t: 'hello', name: 'Solo', create: true });
  await send(r1.room, x, { t: 'lobby', op: 'leave' });
  assert.deepEqual([s1.events.at(-2).kind, s1.events.at(-1).kind, s1.events.at(-1).detail], ['left', 'closed', { reason: 'empty' }]);
  assert.deepEqual([s1.row().close_reason, s1.row().connected], ['empty', 0]);
  assert.ok(s1.row().closed_at);

  const s2 = tracker(), stats = recorder();
  const two = await lobbyOf2({ sessions: s2, stats });
  await send(two.room, two.a, { t: 'lobby', op: 'start' });
  await two.room.expire();
  assert.equal(s2.row().close_reason, 'expired');
  assert.equal(stats.records.at(-1).game.status, 'abandoned');

  const s3 = tracker(), stats3 = recorder();
  const three = await lobbyOf2({ sessions: s3, stats: stats3 });
  await send(three.room, three.a, { t: 'lobby', op: 'start' });
  assert.equal(await three.room.shutdown('ffffffffffffffff'), false, 'another room under this code is left alone');
  assert.ok(three.stored());
  assert.equal(await three.room.shutdown(s3.row().id), true);
  for (const c of [three.a, three.b]) {
    assert.equal(last(c, 'error').code, 'closed');
    assert.equal(c.open, false);
  }
  assert.equal(three.stored(), null, 'the room is deleted');
  assert.deepEqual([s3.row().close_reason, s3.events.at(-1).kind], ['admin', 'closed']);
  assert.equal(stats3.records.at(-1).game.status, 'abandoned');
  assert.equal(await three.room.shutdown(), false, 'closing twice');
});

test('sessions: the admin view shows seats, watchers and the game, never tokens, the history or chat text', async () => {
  const sessions = tracker();
  const { room, a, b, connect } = await lobbyOf2({ mode: 'score', sessions });
  await send(room, a, { t: 'chat', text: 'secret plans' });
  await send(room, a, { t: 'lobby', op: 'start' });
  await send(room, a, { t: 'act', action: { type: 'score', pts: 12, rolls: 2 } });
  const w = connect();
  await send(room, w, { t: 'hello', name: 'Cleo' });
  const v = room.adminView();
  assert.equal(v.id, sessions.row().id);
  assert.deepEqual(v.room.seats.map(s => [s.name, s.connected]), [['Anna', true], ['Ben', true]]);
  assert.deepEqual(v.watching, [{ name: 'Cleo', user: null }]);
  assert.equal(v.state.game.players[0].score, 12);
  assert.deepEqual(v.state.game.history, []);
  assert.equal(v.chat, 1);
  assert.equal(v.connections, 3);
  const text = JSON.stringify(v);
  assert.ok(!text.includes(last(a, 'welcome').token) && !text.includes(last(b, 'welcome').token), 'no tokens');
  assert.ok(!text.includes('secret plans'), 'no chat text');
});

test('sessions: a room saved before the admin page\'s rooms gets its id on its first write', async () => {
  const sessions = tracker(), r = makeRoom(null, null, undefined, sessions);
  r.setStored({ v: 1, code: 'K7QPM', created: 1, updated: 1, rev: 3, phase: 'lobby', host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 },
    seats: [{ id: 's1', name: 'Anna', token: 't'.repeat(32), user: null }], state: null });
  const c = r.connect();
  await send(r.room, c, { t: 'hello', token: 't'.repeat(32) });
  assert.match(sessions.row().id, /^[0-9a-f]{16}$/);
  await send(r.room, c, { t: 'lobby', op: 'rename', name: 'Anne' });
  assert.equal(r.stored().rid, sessions.row().id, 'kept with the next save');
});

test('42/18: the host picks the game, keep and unkeep are the player\'s moves, and the stats record it as 42/18', async () => {
  const stats = recorder();
  const { room, a, b } = await lobbyOf2({ stats });
  assert.equal(last(a, 'room').room.settings.kind, 'sevens');
  await send(room, b, { t: 'lobby', op: 'settings', kind: '4218' });
  assert.equal(last(b, 'error').code, 'host_only');
  await send(room, a, { t: 'lobby', op: 'settings', kind: 'yahtzee' });
  assert.equal(last(b, 'room').room.settings.kind, 'sevens');
  await send(room, a, { t: 'lobby', op: 'settings', kind: '4218' });
  assert.equal(last(b, 'room').room.settings.kind, '4218');
  await send(room, a, { t: 'lobby', op: 'start' });
  const g = last(b, 'room').state.game;
  assert.equal(g.kind, '4218');
  assert.equal(g.turn.dice.length, 5);
  assert.deepEqual(stats.records.map(r => [r.game.kind, r.game.status]), [['4218', 'playing']]);
  await send(room, a, { t: 'act', action: { type: 'roll' } });
  await send(room, b, { t: 'act', action: { type: 'keep', id: 0 } });
  assert.equal(last(b, 'error').code, 'not_your_turn');
  await send(room, a, { t: 'act', action: { type: 'keep', id: 0 } });
  let msg = last(b, 'room');
  assert.deepEqual(msg.events, [{ type: 'kept', id: 0, value: msg.state.game.turn.dice[0].value }]);
  await send(room, a, { t: 'act', action: { type: 'unkeep', id: 0 } });
  assert.equal(last(b, 'room').state.game.turn.dice[0].held, null);
  await send(room, a, { t: 'act', action: { type: 'stop' } });
  msg = last(b, 'room');
  assert.equal(msg.state.game.pos, 1);
  assert.equal(msg.state.game.rounds[0].results[0].rolls, 1);
});

test('Schocken: the host picks it, flip and blind are the player\'s moves, a blind roll stays secret, and the stats record it as Schocken', async () => {
  const stats = recorder();
  const { room, a, b } = await lobbyOf2({ stats });
  await send(room, a, { t: 'lobby', op: 'settings', kind: 'schocken' });
  assert.equal(last(b, 'room').room.settings.kind, 'schocken');
  await send(room, a, { t: 'lobby', op: 'start' });
  let g = last(b, 'room').state.game;
  assert.deepEqual([g.kind, g.turn.dice.length, g.pot], ['schocken', 3, 13]);
  assert.deepEqual(stats.records.map(r => [r.game.kind, r.game.status]), [['schocken', 'playing']]);
  await send(room, b, { t: 'act', action: { type: 'blind' } });
  assert.equal(last(b, 'error').code, 'not_your_turn');
  await send(room, a, { t: 'act', action: { type: 'flip' } });
  assert.equal(last(a, 'error').code, 'phase');
  await send(room, a, { t: 'act', action: { type: 'blind' } });
  const msg = last(b, 'room');
  assert.deepEqual(msg.events, [{ type: 'turn', player: 0, pts: null, rolls: 1, blind: true }]);
  assert.equal(msg.state.game.rounds[0].results[0].dice, null);
  assert.equal(msg.state.game.pos, 1);
  await send(room, b, { t: 'act', action: { type: 'roll' } });
  await send(room, b, { t: 'act', action: { type: 'stop' } });
  const end = last(a, 'room');
  assert.ok(end.events.some(e => e.type === 'revealed' && e.player === 0));
  g = end.state.game;
  assert.equal(g.rounds[0].results[0].dice.length, 3);
  assert.equal(g.starter, g.rounds[0].loser);
});

// the party: the accounts adapter says whose phone it is for (a player ID, or null), and the room tells every phone the seat
function partyRoom() {
  const p = { id: null, calls: 0, fail: false, t: 1_000_000 };
  const acc = { resolve: async s => PLAYERS[s] || null, party: async () => { p.calls++; if (p.fail) throw new Error('down'); return p.id; } };
  return { p, ...makeRoom(null, acc, () => p.t) };
}
const partyMsgs = c => c.inbox.filter(m => m.t === 'party');

test('party: nothing without a party', async () => {
  const { room, connect } = partyRoom(), a = connect(), b = connect();
  await send(room, a, { t: 'hello', name: 'x', session: 'sess-anna', create: true });
  await send(room, b, { t: 'hello', name: 'Ben' });
  await send(room, b, { t: 'party' });
  assert.deepEqual([...partyMsgs(a), ...partyMsgs(b)], []);
});

test("party: the chosen player's seat, also for a phone that joins later", async () => {
  const { room, connect, p } = partyRoom(), a = connect(), b = connect(), c = connect();
  p.id = 'aaaa000000000001';
  await send(room, a, { t: 'hello', name: 'Gus', create: true });
  assert.deepEqual(partyMsgs(a), [], 'not seated yet');
  p.t += 3000;
  await send(room, b, { t: 'hello', name: 'x', session: 'sess-anna' });
  const seat = last(b, 'welcome').seat;
  assert.deepEqual(last(a, 'party'), { t: 'party', seat, viewer: null });
  assert.deepEqual(last(b, 'party'), { t: 'party', seat, viewer: null });
  const rev = last(a, 'room').rev;
  await send(room, c, { t: 'hello', name: 'Cleo' });
  const order = c.inbox.map(m => m.t);
  assert.ok(order.indexOf('party') > order.indexOf('room'), 'after the room message');
  assert.deepEqual(last(c, 'party'), { t: 'party', seat, viewer: null });
  assert.equal(partyMsgs(a).length, 1, 'no repeat for the others');
  assert.equal(last(a, 'room').rev, rev + 1, 'only the join bumped rev');
});

test('party: a chosen player who only watches', async () => {
  const r = partyRoom(), x = r.connect(), y = r.connect(), w = r.connect();
  r.p.id = 'aaaa000000000001';
  await send(r.room, x, { t: 'hello', name: 'Gus', create: true });
  await send(r.room, y, { t: 'hello', name: 'Ben' });
  await send(r.room, x, { t: 'lobby', op: 'start' });
  r.p.t += 3000;
  await send(r.room, w, { t: 'hello', name: 'x', session: 'sess-anna' });
  const viewer = last(w, 'welcome').viewer;
  assert.ok(viewer);
  assert.deepEqual(last(x, 'party'), { t: 'party', seat: null, viewer });
  assert.deepEqual(last(w, 'party'), { t: 'party', seat: null, viewer });
  r.p.t += 3000;
  await r.drop(w);
  assert.deepEqual(last(x, 'party'), { t: 'party', seat: null, viewer: null }, 'gone when they leave');
});

test('party: a poke after the switch is flipped, on and off, never touching the game', async () => {
  const { room, connect, p } = partyRoom(), a = connect(), b = connect();
  await send(room, a, { t: 'hello', name: 'x', session: 'sess-anna', create: true });
  await send(room, b, { t: 'hello', name: 'Ben' });
  const seat = last(a, 'welcome').seat, rev = last(b, 'room').rev;
  p.id = 'aaaa000000000001'; p.t += 2001;
  await send(room, b, { t: 'party' });
  assert.deepEqual(last(b, 'party'), { t: 'party', seat, viewer: null });
  p.id = null; p.t += 2001;
  await send(room, a, { t: 'party' });
  assert.deepEqual(last(a, 'party'), { t: 'party', seat: null, viewer: null });
  assert.equal(last(b, 'room').rev, rev);
});

test('party: a poke is throttled, ignored before hello, and never an error', async () => {
  const { room, connect, p } = partyRoom(), a = connect(), s = connect();
  await send(room, s, { t: 'party' });
  assert.deepEqual(s.inbox, [], 'before hello: nothing');
  await send(room, a, { t: 'hello', name: 'x', session: 'sess-anna', create: true });
  const calls = p.calls;
  p.t += 2001;
  await send(room, a, { t: 'party' });
  await send(room, a, { t: 'party' });
  assert.equal(p.calls, calls + 1, 'one read per 2 s');
  assert.equal(last(a, 'error'), undefined);
});

test('party: a failing party() keeps the last value', async () => {
  const { room, connect, p } = partyRoom(), a = connect();
  p.id = 'aaaa000000000001';
  await send(room, a, { t: 'hello', name: 'x', session: 'sess-anna', create: true });
  assert.equal(partyMsgs(a).length, 1);
  p.fail = true; p.t += 3000;
  await send(room, a, { t: 'party' });
  assert.equal(partyMsgs(a).length, 1, 'no broadcast');
  assert.equal(last(a, 'error'), undefined);
});

test('party: a release or withdraw after the room object was evicted still reaches every phone', async () => {
  const { room, connect, fresh, p } = partyRoom(), a = connect(), b = connect();
  p.id = 'aaaa000000000001';
  await send(room, a, { t: 'hello', name: 'x', session: 'sess-anna', create: true });
  await send(room, b, { t: 'hello', name: 'Ben' });
  assert.equal(last(b, 'party').seat, last(a, 'welcome').seat);
  // hibernation: a new Room object over the same storage and sockets, which says hello to nobody
  const woken = fresh({ accounts: { party: async () => p.id }, now: () => p.t });
  p.id = null; p.t += 5000;
  await send(woken, a, { t: 'party' });
  assert.deepEqual(last(b, 'party'), { t: 'party', seat: null, viewer: null });
});

test('party: a release after eviction, from a phone the new room object never greeted', async () => {
  const { room, connect, fresh, p } = partyRoom(), a = connect(), b = connect();
  await send(room, a, { t: 'hello', name: 'x', session: 'sess-anna', create: true });
  await send(room, b, { t: 'hello', name: 'Ben' });
  const woken = fresh({ accounts: { party: async () => p.id }, now: () => p.t });
  p.id = 'aaaa000000000001'; p.t += 5000;
  await send(woken, b, { t: 'party' });
  assert.deepEqual(last(a, 'party'), { t: 'party', seat: last(a, 'welcome').seat, viewer: null });
});

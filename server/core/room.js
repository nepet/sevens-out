/*
 * One game room, independent of where it runs.
 *
 * The room owns the authoritative game: phones send actions, the room checks who may make them,
 * applies them with the shared rules engine (it rolls the dice), saves, and broadcasts the result.
 *
 * Adapters plug in two small interfaces:
 *   storage: { get(): Promise<data|null>, put(data): Promise<void>, remove(): Promise<void> }
 *   net:     { send(conn, msg), conns(): conn[], seatOf(conn): string|null, bind(conn, seatId, info?), infoOf(conn): { viewer, name, user } | null, close(conn, code, reason) }
 *            (a spectator has no seat: bind keeps their info {viewer, name, user} with the connection, so it outlives a restart of the room object)
 *   stats:   { record(rec) } (optional): gets a stats record (server/core/stats.js summarize) whenever a game starts, ends or is abandoned
 *   accounts: { resolve(session) -> Promise<{ id, name } | null> } (optional): the signed-in player behind hello.session
 *            (server/core/accounts.js resolveSession); a seat taken by a player remembers their ID in seat.user
 * server/cloudflare/worker.js (Durable Object) and server/node/server.js (plain Node) are the two adapters.
 * The wire protocol is documented in CLAUDE.md.
 * Table talk: a seated phone or a spectator sends {t:'chat', text}; everyone gets {t:'chat', msg:{id, at, from, seat, name, user, text}}
 * (seat is null for a spectator), and every phone that says hello gets {t:'chat', log:[msg..]} (the last CHAT_KEEP) right after
 * welcome. A spectator's welcome carries viewer, their own id. Chat never changes rev.
 */

import { summarize } from './stats.js';

export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
export const MAX_SEATS = 12;
export const MAX_MESSAGE = 4096;
export const ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000; // rooms are deleted after two weeks without activity

export const CHAT_MAX = 140; // characters per message
export const CHAT_KEEP = 50; // messages kept and replayed
export const CHAT_BURST = 8; // messages allowed per CHAT_WINDOW_MS and sender
export const CHAT_WINDOW_MS = 10000;

// actions only the player whose turn it is may make (or the host, when that player is offline)
const TURN_ACTIONS = new Set(['roll', 'pair', 'unpair', 'takeall', 'stop', 'end', 'score']);
// actions any seated player may make
const TABLE_ACTIONS = new Set(['drop', 'undo', 'edit', 'nextround']);
// actions only the host may make
const HOST_ACTIONS = new Set(['endearly']);

const hex = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };
// bidi overrides, embeddings and isolates (U+202A–U+202E, U+2066–U+2069) could reorder "Name · text" on other phones
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
// zero-width characters: a message of nothing else is empty (the joiner stays in a message, emoji need it)
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim().slice(0, 16);

// welcome.user is the signed-in player the server sees (null: a guest, or the session has ended);
// it is left out when the accounts couldn't be asked
const whoami = (user, known) => (known ? { user: user ? user.id : null } : {});

export class Room {
  constructor({ engine, storage, net, stats = null, accounts = null, now = () => Date.now() }) {
    this.E = engine; this.storage = storage; this.net = net; this.stats = stats; this.accounts = accounts; this.now = now;
    this.data = undefined; // undefined = not loaded yet, null = no room
    this.greeted = new WeakSet(); // connections that have said hello (each looks a session up at most once)
    this.loading = null;
    this.chatTimes = new Map(); // sender -> recent message times (not saved)
  }

  async load() {
    if (this.data !== undefined) return this.data;
    if (!this.loading) this.loading = this.storage.get().then(d => { this.data = d || null; this.moveOn(); return this.data; });
    return this.loading;
  }
  // a room saved between rounds by an older version moves on to the next round (stored on the next save)
  moveOn() {
    const st = this.data && this.data.state;
    if (!st || st.phase !== 'roundEnd') return;
    const r = this.E.apply(st, { type: 'nextround' });
    if (!r.error) this.data.state = r.state;
  }
  async save() {
    this.data.updated = this.now();
    await this.storage.put(this.data);
  }

  // ----- views -----
  connectedSeats() {
    const on = new Set();
    for (const c of this.net.conns()) { const s = this.net.seatOf(c); if (s) on.add(s); }
    return on;
  }
  // the host runs the lobby; if the host is offline, the first connected player stands in
  effectiveHost(on = this.connectedSeats()) {
    const d = this.data;
    if (!d || !d.seats.length) return null;
    if (on.has(d.host)) return d.host;
    const stand = d.seats.find(s => on.has(s.id));
    return stand ? stand.id : d.host;
  }
  publicRoom() {
    const d = this.data, on = this.connectedSeats();
    return {
      code: d.code, phase: d.phase, host: this.effectiveHost(on), settings: d.settings,
      seats: d.seats.map(s => ({ id: s.id, name: s.name, connected: on.has(s.id), user: s.user || null }))
    };
  }
  roomMessage(events = []) {
    return { t: 'room', rev: this.data.rev, room: this.publicRoom(), state: this.data.state, events };
  }
  broadcast(events = []) {
    const msg = this.roomMessage(events);
    for (const c of this.net.conns()) this.net.send(c, msg);
  }
  error(conn, code, message) { this.net.send(conn, { t: 'error', code, message }); }

  // ----- entry points called by the adapters -----
  async message(conn, raw, code) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return this.error(conn, 'bad_message', 'Message too large.');
    let m;
    try { m = JSON.parse(raw); } catch { return this.error(conn, 'bad_message', 'Not JSON.'); }
    if (!m || typeof m.t !== 'string') return this.error(conn, 'bad_message', 'Missing type.');
    await this.load();
    switch (m.t) {
      case 'hello': return this.hello(conn, m, code);
      case 'act': return this.act(conn, m.action);
      case 'lobby': return this.lobby(conn, m);
      case 'chat': return this.chat(conn, m.text);
      case 'ping': return this.net.send(conn, { t: 'pong' });
      default: return this.error(conn, 'bad_message', 'Unknown message type.');
    }
  }
  async closed(conn) {
    await this.load();
    if (this.data && this.net.seatOf(conn)) this.broadcast();
  }

  // the signed-in player behind a session, null (a guest or an ended session), or undefined when the
  // accounts can't be reached right now; that player plays as a guest, and their phone keeps its session
  async player(session) {
    if (typeof session !== 'string' || !session) return null;
    if (!this.accounts) return undefined; // this server has no accounts: it can't tell whether the session is valid
    try { return await this.accounts.resolve(session); } catch (err) { console.error('accounts', err); return undefined; }
  }

  // ----- hello: create, join, rejoin or watch -----
  async hello(conn, m, code) {
    if (this.greeted.has(conn)) return this.error(conn, 'bad_message', 'Already joined.');
    this.greeted.add(conn);
    const found = await this.player(m.session); // before reading the room: other messages may run meanwhile
    const user = found || null, known = found !== undefined;
    let d = this.data;
    if (d && user) {
      // a player gets their seat back from any phone, even mid-game
      const seat = d.seats.find(s => s.user === user.id);
      if (seat) return this.seat(conn, seat, user, known);
    }
    if (d && m.token) {
      const seat = d.seats.find(s => s.token === m.token);
      if (seat) {
        // a guest who has signed in since takes their seat as that player
        if (user && !seat.user) {
          seat.user = user.id;
          if (d.phase === 'lobby') seat.name = this.uniqueName(user.name, seat);
          d.rev++;
          await this.save();
        }
        return this.seat(conn, seat, user, known);
      }
    }
    if (!d) {
      if (!m.create) { this.error(conn, 'no_room', 'There is no room with this code.'); return this.net.close(conn, 4404, 'no_room'); }
      if (!CODE_RE.test(code || '')) return this.error(conn, 'bad_message', 'Bad room code.');
      d = this.data = {
        v: 1, code, created: this.now(), updated: this.now(), rev: 1,
        phase: 'lobby', host: null, settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats: [], state: null
      };
      const seat = this.addSeat(m.name, user);
      d.host = seat.id;
      await this.save();
      return this.seat(conn, seat, user, known);
    }
    if (m.create) return this.error(conn, 'room_taken', 'That code is in use.');
    if (d.phase === 'lobby') {
      if (d.seats.length >= MAX_SEATS) { this.error(conn, 'room_full', 'This room is full.'); return this.net.close(conn, 4409, 'room_full'); }
      const seat = this.addSeat(m.name, user);
      d.rev++;
      await this.save();
      return this.seat(conn, seat, user, known);
    }
    // a game is running: watch it
    const viewer = 'w' + hex(4);
    this.net.bind(conn, null, { viewer, name: cleanName(user ? user.name : m.name) || 'Guest', user: user ? user.id : null });
    this.net.send(conn, { t: 'welcome', seat: null, viewer, ...whoami(user, known) });
    this.net.send(conn, { t: 'chat', log: this.data.chat || [] });
    this.net.send(conn, this.roomMessage());
  }
  // a signed-in player sits under their player name
  addSeat(name, user = null) {
    const d = this.data;
    const seat = { id: hex(4), name: this.uniqueName(user ? user.name : name), token: hex(16), user: user ? user.id : null };
    d.seats.push(seat);
    return seat;
  }
  uniqueName(name, self = null) {
    const d = this.data;
    let base = cleanName(name) || `Player ${d.seats.length + 1}`, nm = base, k = 2;
    while (d.seats.some(s => s !== self && s.name.toLowerCase() === nm.toLowerCase())) nm = `${base.slice(0, 13)} ${k++}`;
    return nm;
  }
  seat(conn, seat, user = null, known = true) {
    this.net.bind(conn, seat.id);
    this.net.send(conn, { t: 'welcome', seat: seat.id, token: seat.token, ...whoami(user, known) });
    this.net.send(conn, { t: 'chat', log: this.data.chat || [] });
    this.broadcast();
  }

  // ----- table talk -----
  async chat(conn, text) {
    const d = this.data, sid = this.net.seatOf(conn), seat = d && sid && d.seats.find(s => s.id === sid);
    const who = seat ? { id: seat.id, seat: seat.id, name: seat.name, user: seat.user || null }
      : d && !sid && this.net.infoOf(conn) ? { id: this.net.infoOf(conn).viewer, seat: null, ...this.net.infoOf(conn) } : null;
    if (!who) return this.error(conn, 'not_seated', 'Join the room first.');
    const id = who.id;
    if (typeof text !== 'string') return this.error(conn, 'bad_message', `Messages are 1 to ${CHAT_MAX} characters.`);
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
    const n = [...text].length;
    if (n < 1 || n > CHAT_MAX || !text.replace(ZERO_WIDTH, '').trim()) return this.error(conn, 'bad_message', `Messages are 1 to ${CHAT_MAX} characters.`);
    const at = this.now(), recent = (this.chatTimes.get(id) || []).filter(t => at - t < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_BURST) { this.chatTimes.set(id, recent); return this.error(conn, 'rate', 'Slow down a little.'); }
    recent.push(at); this.chatTimes.set(id, recent);
    d.chatSeq = (d.chatSeq || 0) + 1;
    const msg = { id: d.chatSeq, at, from: id, seat: who.seat, name: who.name, user: who.user || null, text };
    d.chat = [...(d.chat || []), msg].slice(-CHAT_KEEP);
    await this.save();
    for (const c of this.net.conns()) this.net.send(c, { t: 'chat', msg });
  }

  // ----- game actions -----
  async act(conn, action) {
    const d = this.data, me = this.net.seatOf(conn);
    if (!d || d.phase !== 'game' || !d.state || !d.state.game) return this.error(conn, 'phase', 'No game is running.');
    if (!me || !d.state.game.seats.includes(me)) return this.error(conn, 'not_seated', 'You are watching this game.');
    if (!action || typeof action.type !== 'string') return this.error(conn, 'bad_message', 'Bad action.');
    const g = d.state.game, on = this.connectedSeats(), host = this.effectiveHost(on);
    if (TURN_ACTIONS.has(action.type)) {
      const cur = g.seats[g.order[g.pos]];
      if (d.state.phase !== 'play' || (me !== cur && !(me === host && !on.has(cur)))) return this.error(conn, 'not_your_turn', "It isn't your turn.");
    } else if (HOST_ACTIONS.has(action.type)) {
      if (me !== host) return this.error(conn, 'host_only', 'Only the host can do that.');
    } else if (!TABLE_ACTIONS.has(action.type)) {
      return this.error(conn, 'bad_message', 'Unknown action.');
    }
    const was = d.state.phase;
    const r = this.E.apply(d.state, action);
    if (r.error) return this.error(conn, r.error, 'That move is not allowed.');
    d.state = r.state;
    d.rev++;
    await this.save();
    this.broadcast(r.events);
    if (d.state.phase === 'over') await this.recordStats('over');
    else if (was === 'over') await this.recordStats('playing');
  }

  // ----- lobby -----
  async lobby(conn, m) {
    const d = this.data, me = this.net.seatOf(conn);
    if (!d || !me) return this.error(conn, 'not_seated', 'Join the room first.');
    const isHost = me === this.effectiveHost();
    let abandoned = null; // recorded after the lobby change reaches everyone
    switch (m.op) {
      case 'settings': {
        if (!isHost) return this.error(conn, 'host_only', 'Only the host can change the settings.');
        if (d.phase !== 'lobby') return this.error(conn, 'phase', 'The game has started.');
        if (m.mode === 'dice' || m.mode === 'score') d.settings.mode = m.mode;
        if (m.pairing === 'manual' || m.pairing === 'auto') d.settings.pairing = m.pairing;
        if (m.starter === 'random' || (Number.isInteger(m.starter) && m.starter >= 0 && m.starter < MAX_SEATS)) d.settings.starter = m.starter;
        break;
      }
      case 'start': {
        if (!isHost) return this.error(conn, 'host_only', 'Only the host can start the game.');
        if (d.phase !== 'lobby') return this.error(conn, 'phase', 'The game has started.');
        if (d.seats.length < 2) return this.error(conn, 'players', 'You need at least 2 players.');
        const n = d.seats.length;
        let starter = d.settings.starter;
        if (starter === 'random') { const b = new Uint8Array(1); do crypto.getRandomValues(b); while (b[0] >= 256 - (256 % n)); starter = b[0] % n; } // no modulo bias
        if (!(starter >= 0 && starter < n)) starter = 0;
        const r = this.E.apply(this.E.blank(), { type: 'start', names: d.seats.map(s => s.name), seats: d.seats.map(s => s.id), starter, mode: d.settings.mode, pairing: d.settings.pairing });
        if (r.error) return this.error(conn, r.error, 'Could not start.');
        d.state = r.state; d.phase = 'game'; d.rev++;
        d.stats = { id: hex(8), startedAt: this.now() };
        await this.save();
        this.broadcast(r.events);
        return this.recordStats('playing');
      }
      case 'reopen': {
        if (!isHost) return this.error(conn, 'host_only', 'Only the host can start a new game.');
        if (d.phase === 'game' && d.state && d.state.phase !== 'over') abandoned = this.statsRecord('abandoned');
        d.phase = 'lobby'; d.state = null; d.stats = null;
        break;
      }
      case 'rename': {
        const seat = d.seats.find(s => s.id === me), nm = cleanName(m.name);
        if (!seat || !nm || d.phase !== 'lobby') return this.error(conn, 'phase', 'Names can only change before the game starts.');
        seat.name = nm;
        break;
      }
      case 'kick': {
        if (!isHost) return this.error(conn, 'host_only', 'Only the host can remove players.');
        if (d.phase !== 'lobby' || m.seat === me) return this.error(conn, 'phase', 'Players can only be removed before the game starts.');
        const i = d.seats.findIndex(s => s.id === m.seat);
        if (i < 0) return;
        d.seats.splice(i, 1);
        for (const c of this.net.conns()) if (this.net.seatOf(c) === m.seat) { this.error(c, 'kicked', 'The host removed you.'); this.net.bind(c, null); this.net.close(c, 4403, 'kicked'); }
        this.fixStarter();
        break;
      }
      case 'leave': {
        // in the lobby the seat is freed; during a game the player keeps their seat and can rejoin
        this.net.bind(conn, null);
        if (d.phase === 'lobby') {
          d.seats = d.seats.filter(s => s.id !== me);
          if (d.host === me && d.seats.length) d.host = d.seats[0].id;
          this.fixStarter();
          if (!d.seats.length) { await this.storage.remove(); this.data = null; return; }
        }
        this.net.close(conn, 1000, 'left');
        break;
      }
      default: return this.error(conn, 'bad_message', 'Unknown lobby operation.');
    }
    d.rev++;
    await this.save();
    this.broadcast();
    if (abandoned) await this.sendStats(abandoned);
  }
  fixStarter() {
    const d = this.data;
    if (Number.isInteger(d.settings.starter) && d.settings.starter >= d.seats.length) d.settings.starter = 0;
  }

  // ----- housekeeping -----
  expired() { return !!this.data && this.now() - this.data.updated > ROOM_TTL_MS; }
  // an unfinished game in a room that is being deleted
  async expire() {
    const d = this.data;
    if (d && d.phase === 'game' && d.state && d.state.phase !== 'over') await this.recordStats('abandoned');
  }

  // ----- statistics -----
  async recordStats(status) {
    await this.sendStats(this.statsRecord(status));
  }
  // the record of the current game, or null; recording never breaks play
  statsRecord(status) {
    const d = this.data;
    if (!this.stats || !d || !d.stats || !d.state || !d.state.game) return null;
    try {
      const seats = d.state.game.seats || [];
      return summarize(d.state, {
        id: d.stats.id, source: 'online', roomCode: d.code, startedAt: d.stats.startedAt,
        finishedAt: status === 'over' ? this.now() : null, status,
        users: seats.map(id => (d.seats.find(s => s.id === id) || {}).user || null)
      });
    } catch (err) { console.error('stats', err); return null; }
  }
  async sendStats(rec) {
    if (!rec) return;
    try { await this.stats.record(rec); } catch (err) { console.error('stats', err); }
  }
}

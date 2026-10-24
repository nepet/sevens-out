/*
 * Writes game records (from server/core/stats.js summarize) to the stats database.
 * A record replaces any earlier version of the same game, so a game recorded as playing,
 * then over, then corrected ends up as one row with the latest score sheet.
 */
const GAME_COLS = ['id', 'source', 'kind', 'mode', 'room_code', 'status', 'early', 'started_at', 'finished_at', 'rounds', 'player_count', 'loser', 'top_score', 'margin', 'sheet'];
const PLAYER_COLS = ['game_id', 'idx', 'name', 'name_key', 'score', 'lost', 'sevens_outs', 'shots', 'turns', 'user_id'];
const TURN_COLS = ['game_id', 'round', 'idx', 'pts', 'rolls', 'starter', 'mark'];

const MAX_PARAMS = 100; // D1's limit of bound parameters per statement

const insert = (table, cols, rows = 1) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${Array(rows).fill(`(${cols.map(() => '?').join(', ')})`).join(', ')}`;
const UPSERT_GAME = `${insert('games', GAME_COLS)} ON CONFLICT (id) DO UPDATE SET ${GAME_COLS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`;
const values = (row, cols) => cols.map(c => (row[c] === undefined ? null : row[c]));
// multi-row inserts keep a record to a handful of statements, each within the parameter limit
function insertRows(table, cols, rows) {
  const per = Math.floor(MAX_PARAMS / cols.length), stmts = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    stmts.push([insert(table, cols, chunk.length), chunk.flatMap(r => values(r, cols))]);
  }
  return stmts;
}
const clearChildren = id => [['DELETE FROM turns WHERE game_id = ?', [id]], ['DELETE FROM players WHERE game_id = ?', [id]]];

export async function writeRecord(db, { game, players, turns }) {
  await db.batch([
    ...clearChildren(game.id),
    // a record from before 42/18 and Schocken were recorded (still waiting for a retry) is Sevens Out
    [UPSERT_GAME, values({ kind: 'sevens', ...game }, GAME_COLS)],
    ...insertRows('players', PLAYER_COLS, players),
    ...insertRows('turns', TURN_COLS, turns),
    // a room may still remember a player who has deleted their account since
    ...(players.some(p => p.user_id) ? [['UPDATE players SET user_id = NULL WHERE game_id = ? AND user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)', [game.id]]] : [])
  ]);
}

export async function deleteGame(db, id) {
  await db.batch([...clearChildren(id), ['DELETE FROM games WHERE id = ?', [id]]]);
}

// ----- rooms (the admin page's live and past rooms) -----
const ROOM_COLS = ['id', 'code', 'created_at', 'active_at', 'closed_at', 'close_reason', 'phase', 'kind', 'mode', 'pairing', 'round', 'seats', 'connected',
  'watching', 'signed_in', 'host', 'names', 'game_id', 'first_start_at', 'games_started', 'games_finished', 'connects', 'rejoins', 'spectators', 'chat', 'peak'];
const EVENT_COLS = ['room_id', 'seq', 'at', 'kind', 'detail'];
const UPSERT_ROOM = `${insert('rooms', ROOM_COLS)} ON CONFLICT (id) DO UPDATE SET ${ROOM_COLS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`;

// a room's row (server/core/room.js sessionRow) and its timeline events since the last write; an event sent twice is kept once
export async function writeRoom(db, row, events = []) {
  const evs = events.map(e => ({ room_id: row.id, seq: e.seq, at: e.at, kind: e.kind, detail: e.detail ? JSON.stringify(e.detail) : null }));
  await db.batch([
    [UPSERT_ROOM, values(row, ROOM_COLS)],
    ...insertRows('room_events', EVENT_COLS, evs).map(([sql, p]) => [sql.replace(/^INSERT/, 'INSERT OR IGNORE'), p])
  ]);
}

// a room that no longer exists in the game Worker (closed before the room could say so)
export async function markRoomGone(db, id, now = Date.now()) {
  await db.batch([["UPDATE rooms SET closed_at = ?, close_reason = 'gone', connected = 0, watching = 0 WHERE id = ? AND closed_at IS NULL", [now, id]]]);
}

/*
 * Writes game records (from server/core/stats.js summarize) to the stats database.
 * A record replaces any earlier version of the same game, so a game recorded as playing,
 * then over, then corrected ends up as one row with the latest score sheet.
 */
const GAME_COLS = ['id', 'source', 'mode', 'room_code', 'status', 'early', 'started_at', 'finished_at', 'rounds', 'player_count', 'loser', 'top_score', 'margin', 'sheet'];
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
    [UPSERT_GAME, values(game, GAME_COLS)],
    ...insertRows('players', PLAYER_COLS, players),
    ...insertRows('turns', TURN_COLS, turns),
    // a room may still remember a player who has deleted their account since
    ...(players.some(p => p.user_id) ? [['UPDATE players SET user_id = NULL WHERE game_id = ? AND user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)', [game.id]]] : [])
  ]);
}

export async function deleteGame(db, id) {
  await db.batch([...clearChildren(id), ['DELETE FROM games WHERE id = ?', [id]]]);
}

/*
 * Writes game records (from server/core/stats.js summarize) to the stats database.
 * A record replaces any earlier version of the same game, so a game recorded as playing,
 * then over, then corrected ends up as one row with the latest score sheet.
 */
const GAME_COLS = ['id', 'source', 'mode', 'room_code', 'status', 'early', 'started_at', 'finished_at', 'rounds', 'player_count', 'loser', 'top_score', 'margin', 'sheet'];
const PLAYER_COLS = ['game_id', 'idx', 'name', 'name_key', 'score', 'lost', 'sevens_outs', 'shots', 'turns'];
const TURN_COLS = ['game_id', 'round', 'idx', 'pts', 'rolls', 'starter', 'mark'];

const insert = (table, cols) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
const UPSERT_GAME = `${insert('games', GAME_COLS)} ON CONFLICT (id) DO UPDATE SET ${GAME_COLS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`;
const values = (row, cols) => cols.map(c => (row[c] === undefined ? null : row[c]));
const clearChildren = id => [['DELETE FROM turns WHERE game_id = ?', [id]], ['DELETE FROM players WHERE game_id = ?', [id]]];

export async function writeRecord(db, { game, players, turns }) {
  await db.batch([
    ...clearChildren(game.id),
    [UPSERT_GAME, values(game, GAME_COLS)],
    ...players.map(p => [insert('players', PLAYER_COLS), values(p, PLAYER_COLS)]),
    ...turns.map(t => [insert('turns', TURN_COLS), values(t, TURN_COLS)])
  ]);
}

export async function deleteGame(db, id) {
  await db.batch([...clearChildren(id), ['DELETE FROM games WHERE id = ?', [id]]]);
}

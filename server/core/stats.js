/*
 * Game statistics, independent of where they run (no runtime code, like room.js).
 *
 *   summarize(state, meta) -> { game, players, turns }
 *     rows for the stats database (server/d1/schema.sql) from an engine state;
 *     meta = { id, source: 'online'|'phone', roomCode?, startedAt?, finishedAt?, status: 'playing'|'over'|'abandoned' }
 */

export const GAME_ID_RE = /^[0-9a-f]{16}$/;
export const MAX_REPORT_BYTES = 16 * 1024;

export const nameKey = name => String(name).replace(/\s+/g, ' ').trim().toLowerCase();

export function sheetOf(g) {
  return {
    players: g.players.map(p => p.name),
    rounds: g.rounds.map(rd => ({ no: rd.no, starter: rd.starter, mark: rd.mark ?? null, results: rd.results })),
    shots: (g.shots || []).map(s => ({ player: s.player, round: s.round })),
    early: !!g.early
  };
}

export function summarize(state, { id, source, roomCode = null, startedAt = null, finishedAt = null, status }) {
  const g = state.game, n = g.players.length;
  const game = {
    id, source, mode: g.mode === 'score' ? 'score' : 'dice', room_code: roomCode, status, early: 0,
    started_at: startedAt, finished_at: null, rounds: null, player_count: n,
    loser: null, top_score: null, margin: null, sheet: null
  };
  if (status !== 'over') return { game, players: [], turns: [] };

  const turns = [], per = g.players.map(() => ({ turns: 0, sevens: 0, shots: 0 }));
  for (const rd of g.rounds) {
    for (const [k, r] of Object.entries(rd.results)) {
      const idx = +k;
      turns.push({ game_id: id, round: rd.no, idx, pts: r.pts, rolls: r.rolls ?? null, starter: idx === rd.starter ? 1 : 0, mark: rd.mark ?? null });
      per[idx].turns++;
      if (r.pts === 0) per[idx].sevens++;
    }
  }
  for (const s of g.shots || []) if (per[s.player]) per[s.player].shots++;
  const sorted = g.players.map(p => p.score).sort((a, b) => b - a);
  Object.assign(game, {
    early: g.early ? 1 : 0,
    finished_at: finishedAt,
    rounds: g.rounds.filter(rd => Object.keys(rd.results).length).length,
    loser: g.players[g.loser] ? g.players[g.loser].name : null,
    top_score: sorted[0],
    margin: sorted[0] - sorted[1],
    sheet: JSON.stringify(sheetOf(g))
  });
  const players = g.players.map((p, i) => ({
    game_id: id, idx: i, name: p.name, name_key: nameKey(p.name), score: p.score,
    lost: i === g.loser ? 1 : 0, sevens_outs: per[i].sevens, shots: per[i].shots, turns: per[i].turns
  }));
  return { game, players, turns };
}

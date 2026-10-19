/*
 * The small database interface used by the stats writer and the admin queries:
 *   all(sql, params) -> rows
 *   batch([[sql, params], ...]) -> runs every statement in one transaction
 * fromD1 wraps a Cloudflare D1 binding; tests wrap node:sqlite the same way (tests/fake-d1.js).
 */
export function fromD1(d1) {
  return {
    all: async (sql, params = []) => (await d1.prepare(sql).bind(...params).all()).results,
    batch: async stmts => { await d1.batch(stmts.map(([sql, params = []]) => d1.prepare(sql).bind(...params))); }
  };
}

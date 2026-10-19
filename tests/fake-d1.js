// A stand-in for a Cloudflare D1 binding, backed by node:sqlite and the real schema.
// Set `down = true` to make every call fail, as if D1 were unavailable.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../server/d1/schema.sql', import.meta.url), 'utf8');

export function fakeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  const d1 = { raw, down: false, prepare: sql => statement(sql, []) };
  const check = () => { if (d1.down) throw new Error('D1 is down'); };
  function statement(sql, params) {
    return {
      sql, params,
      bind: (...p) => statement(sql, p),
      all: async () => { check(); return { results: raw.prepare(sql).all(...params) }; },
      run: async () => { check(); raw.prepare(sql).run(...params); return { success: true }; }
    };
  }
  d1.batch = async stmts => {
    check();
    raw.exec('BEGIN');
    try { for (const s of stmts) raw.prepare(s.sql).run(...s.params); raw.exec('COMMIT'); }
    catch (err) { raw.exec('ROLLBACK'); throw err; }
    return stmts.map(() => ({ success: true }));
  };
  return d1;
}

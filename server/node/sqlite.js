/*
 * The Node server's database: a SQLite file with the same small interface as server/d1/db.js,
 *   all(sql, params) -> rows        batch([[sql, params], ...]) -> one transaction
 * so the shared SQL code runs on D1 and here alike. The schema (server/d1/schema.sql) is
 * applied on every open; it is all CREATE … IF NOT EXISTS.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../d1/schema.sql', import.meta.url), 'utf8');

export function openDatabase(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);
  return {
    // node:sqlite rows have no prototype; plain objects compare like D1's
    all: async (sql, params = []) => raw.prepare(sql).all(...params).map(row => ({ ...row })),
    batch: async stmts => {
      raw.exec('BEGIN');
      try { for (const [sql, params = []] of stmts) raw.prepare(sql).run(...params); raw.exec('COMMIT'); }
      catch (err) { raw.exec('ROLLBACK'); throw err; }
    },
    close: () => raw.close()
  };
}

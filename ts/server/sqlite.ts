// core's Db on node:sqlite (synchronous underneath; the promises keep core independent of that).
import { DatabaseSync } from 'node:sqlite';
import type { Db, Params, Row } from '../core/db.ts';

export function openSqlite(path: string): Db {
  const con = new DatabaseSync(path);
  con.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');
  const stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const prep = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = con.prepare(sql);
      if (stmts.size > 500) stmts.clear();
      stmts.set(sql, s);
    }
    return s;
  };
  const args = (p?: Params): any[] => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
  // One connection: while a transaction is open, every other caller waits for it (statements of a concurrent request must
  // not land inside it). The transaction itself works through `inner`, which does not wait.
  let lock: Promise<void> = Promise.resolve();
  let pending = 0; // transactions open or waiting
  const idle = async () => { while (pending) await lock; };
  const raw = {
    all: (sql: string, p?: Params) => prep(sql).all(...args(p)),
    get: (sql: string, p?: Params) => prep(sql).get(...args(p)),
    run: (sql: string, p?: Params) => {
      const r = prep(sql).run(...args(p));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
  };
  const inner: Db = {
    async all<T = Row>(sql: string, p?: Params) { return raw.all(sql, p) as T[]; },
    async get<T = Row>(sql: string, p?: Params) { return raw.get(sql, p) as T | undefined; },
    async run(sql: string, p?: Params) { return raw.run(sql, p); },
    async exec(sql: string) { con.exec(sql); },
    async tx(fn) { return fn(inner); }, // nested: joins the open transaction
  };
  const db: Db = {
    async all<T = Row>(sql: string, p?: Params) { await idle(); return raw.all(sql, p) as T[]; },
    async get<T = Row>(sql: string, p?: Params) { await idle(); return raw.get(sql, p) as T | undefined; },
    async run(sql: string, p?: Params) { await idle(); return raw.run(sql, p); },
    async exec(sql: string) { await idle(); con.exec(sql); },
    async tx(fn) {
      pending++;
      const before = lock;
      let release!: () => void;
      lock = new Promise((r) => (release = r));
      await before;
      try {
        con.exec('BEGIN IMMEDIATE'); // inside the try: a failing BEGIN (database locked) must release the lock too
      } catch (e) {
        pending--;
        release();
        throw e;
      }
      try {
        const out = await fn(inner);
        con.exec('COMMIT');
        return out;
      } catch (e) {
        if (con.isTransaction) con.exec('ROLLBACK');
        throw e;
      } finally {
        pending--;
        release();
      }
    },
    close() { con.close(); },
  };
  return db;
}

// core's Db over the bridge (`sql` and `exec` ops). The same transaction rules as server/sqlite.ts: one connection on the native
// side, so while a transaction is open every other caller waits for it (statements of a concurrent request must not land inside it);
// the transaction itself works through `inner`, which does not wait. This is only safe because the native side runs the ops of
// this page strictly one after another, in the order they arrive.
import { openSchema, type Db, type Params, type Row, type Value } from '../core/db.ts';
import { fromB64, toB64, type Bridge } from './bridge.ts';

export type DbName = 'main' | 'bls' | 'catalog';

function encode(v: Value): unknown {
  if (v === null || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError('NaN or infinity cannot be bound'); // JSON would turn it into null
    return v;
  }
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('integer too large for the bridge');
    return Number(v);
  }
  if (v instanceof Uint8Array) return { b64: toB64(v) };
  throw new TypeError(`cannot bind a value of type ${typeof v}`); // like node:sqlite (undefined, booleans, objects)
}

/** Positional args stay a list; named ones an object whose keys carry no prefix (`{w: 'x'}` binds `:w`, like node:sqlite). */
const encodeArgs = (p?: Params): unknown[] | Record<string, unknown> => {
  if (p === undefined) return [];
  if (Array.isArray(p)) return p.map(encode);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, encode(v)]));
};

const decodeRow = (row: Record<string, unknown>): Row => {
  for (const [k, v] of Object.entries(row)) if (v !== null && typeof v === 'object' && typeof (v as any).b64 === 'string') row[k] = fromB64((v as any).b64);
  return row;
};

/** One `sql` op: rows (as objects), changes and the rowid of the last insert. */
export async function sql(bridge: Bridge, db: DbName, text: string, p?: Params): Promise<{ rows: Row[]; changes: number; lastId: number }> {
  const a = await bridge({ op: 'sql', db, sql: text, args: encodeArgs(p) });
  return { rows: (a?.rows ?? []).map(decodeRow), changes: Number(a?.changes ?? 0), lastId: Number(a?.lastId ?? 0) };
}

export function nativeDb(bridge: Bridge): Db {
  const raw = {
    all: async (q: string, p?: Params) => (await sql(bridge, 'main', q, p)).rows,
    get: async (q: string, p?: Params) => (await sql(bridge, 'main', q, p)).rows[0],
    run: async (q: string, p?: Params) => { const r = await sql(bridge, 'main', q, p); return { changes: r.changes, lastId: r.lastId }; },
    exec: async (q: string) => { await bridge({ op: 'exec', db: 'main', sql: q }); },
  };
  let lock: Promise<void> = Promise.resolve();
  let pending = 0; // transactions open or waiting
  const idle = async () => { while (pending) await lock; };
  const inner: Db = {
    async all<T = Row>(q: string, p?: Params) { return (await raw.all(q, p)) as T[]; },
    async get<T = Row>(q: string, p?: Params) { return (await raw.get(q, p)) as T | undefined; },
    run: raw.run,
    exec: raw.exec,
    async tx(fn) { return fn(inner); }, // nested: joins the open transaction
  };
  return {
    async all<T = Row>(q: string, p?: Params) { await idle(); return (await raw.all(q, p)) as T[]; },
    async get<T = Row>(q: string, p?: Params) { await idle(); return (await raw.get(q, p)) as T | undefined; },
    async run(q: string, p?: Params) { await idle(); return raw.run(q, p); },
    async exec(q: string) { await idle(); return raw.exec(q); },
    async tx(fn) {
      pending++;
      const before = lock;
      let release!: () => void;
      lock = new Promise((r) => (release = r));
      await before;
      try {
        await raw.exec('BEGIN IMMEDIATE'); // inside the try: a failing BEGIN must release the lock too
      } catch (e) {
        pending--;
        release();
        throw e;
      }
      try {
        const out = await fn(inner);
        await raw.exec('COMMIT');
        return out;
      } catch (e) {
        // no isTransaction over the bridge: a ROLLBACK after SQLite already ended the transaction fails, which is fine
        await raw.exec('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        pending--;
        release();
      }
    },
  };
}

/** The main database, with the current schema applied when it is empty. Unlike the server, the app migrates its own database with
 * `migrations` (core/migrations, keyed by the version a step starts from: `{20: v21.sql}`); any other version is refused (SchemaMismatch). */
export async function openNativeDb(bridge: Bridge, schemaSql: string, migrations: Record<number, string> = {}): Promise<Db> {
  const db = nativeDb(bridge);
  // a page that went away in the middle of a transaction (a reload) may have left it open on the native side: nothing of this page
  // can be in one yet, so it is rolled back (an error just means there was none)
  await bridge({ op: 'exec', db: 'main', sql: 'ROLLBACK' }).catch(() => undefined);
  await openSchema(db, schemaSql, migrations);
  return db;
}

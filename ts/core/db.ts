// The database as core sees it: asynchronous on purpose, so that the same handlers run on node:sqlite (server), a
// Capacitor SQLite plugin (app) or SQLite in WebAssembly (demo). No node imports here; the adapters live outside core.

export type Value = string | number | bigint | null | Uint8Array;
export type Params = Value[] | Record<string, Value>;
export type Row = Record<string, any>;

export interface Db {
  all<T = Row>(sql: string, params?: Params): Promise<T[]>;
  get<T = Row>(sql: string, params?: Params): Promise<T | undefined>;
  /** Changes and the rowid of the last insert. */
  run(sql: string, params?: Params): Promise<{ changes: number; lastId: number }>;
  exec(sql: string): Promise<void>;
  /** Runs `fn` in one transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on error). Nested calls join the outer one. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close?(): void;
}

export const SCHEMA_VERSION = 20;

export class SchemaMismatch extends Error {}

/** A new database gets schema v20; a v20 database is used as it is. Every other version is refused: migrations stay with
 * the Python server, so that a switch back and forth never meets a schema the other side does not know. */
export async function openSchema(db: Db, schemaSql: string): Promise<void> {
  await db.exec('PRAGMA foreign_keys = OFF');
  const { user_version: version } = (await db.get<{ user_version: number }>('PRAGMA user_version'))!;
  if (version === SCHEMA_VERSION) return;
  const tables = await db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'");
  if (version !== 0 || tables!.n > 0) {
    throw new SchemaMismatch(`database has schema version ${version}, this server only reads ${SCHEMA_VERSION}`);
  }
  await db.exec(`BEGIN; ${schemaSql} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
}

/** json.dumps(allow_nan=False) of the Python side: NaN or infinity in a stored value is an error, not null. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('NaN or infinity cannot be stored');
    return v;
  });
}

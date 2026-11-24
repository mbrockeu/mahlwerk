// FOR TESTS: the native side of the app (the bridge contract of ts/app, see ts/PORTING.md "App-Host") on node:sqlite, so that the app
// host can run under `node --test`. One connection per database, every op handled in arrival order, like the Swift side must.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../server/catalogImport.ts';
import { BLS, nameCompact, nameKey } from '../core/catalog.ts';

type Msg = Record<string, any>;
const decode = (v: any) => (v !== null && typeof v === 'object' && typeof v.b64 === 'string' ? new Uint8Array(Buffer.from(v.b64, 'base64')) : v);
const encode = (v: any) => (v instanceof Uint8Array ? { b64: Buffer.from(v).toString('base64') } : v);

export interface FakeNative {
  bridge: (msg: Msg) => Promise<any>;
  /** Every message seen, in order (the tests look at what went over the bridge). */
  log: Msg[];
  close(): void;
}

/** `http` answers the http op (default: refused as `connect`); the tests never reach the network. */
export function nodeBridge(paths: { main: string; bls?: string; catalog?: string }, http?: (msg: Msg) => Promise<any>): FakeNative {
  const open: Record<string, DatabaseSync> = {};
  const con = (name: string): DatabaseSync => {
    if (open[name]) return open[name]!;
    const path = name === 'main' ? paths.main : (paths as any)[name];
    if (name !== 'main' && (!path || !existsSync(path))) throw new Error('missing');
    return (open[name] = new DatabaseSync(path, { readOnly: name !== 'main' }));
  };
  const log: Msg[] = [];
  const secretKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))); // this "device's" keychain key
  return {
    log,
    async bridge(msg) {
      log.push(msg);
      await Promise.resolve(); // asynchronous like a message to the native side
      const db = msg.db ?? 'main';
      if (msg.op === 'exec') { con(db).exec(msg.sql); return {}; }
      if (msg.op === 'sql') {
        const c = con(db);
        const args = Array.isArray(msg.args) ? msg.args.map(decode) : Object.fromEntries(Object.entries(msg.args ?? {}).map(([k, v]) => [k, decode(v)]));
        const stmt = c.prepare(msg.sql);
        const rows = (Array.isArray(args) ? stmt.all(...args) : stmt.all(args as any)) as Record<string, unknown>[];
        const meta = c.prepare('SELECT changes() AS changes, last_insert_rowid() AS lastId').get() as any;
        return { rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encode(v)]))), changes: meta.changes, lastId: meta.lastId };
      }
      if (msg.op === 'secretKey') return { keyB64: secretKey };
      if (msg.op === 'http') {
        if (!http) throw new Error('connect: no network in the tests');
        return http(msg);
      }
      throw new Error(`unknown op ${msg.op}`);
    },
    close() { for (const c of Object.values(open)) c.close(); },
  };
}

/** A few basic foods (BLS) in a catalogue file built with the importer's own DDL. */
export const BLS_FIXTURE = [
  { code: 'C133000', name: 'Haferflocken', name_en: 'Oat flakes', kcal: 370, fat: 7, carbs: 59, protein: 13.5 },
  { code: 'F110100', name: 'Apfel roh', name_en: 'Apple raw', kcal: 54, fat: 0.1, carbs: 11.4, protein: 0.3 },
  { code: 'M111200', name: 'Vollmilch 3,5 %', name_en: 'Whole milk 3.5 %', kcal: 64, fat: 3.5, carbs: 4.7, protein: 3.3 },
];

export function buildBlsFixture(path: string): void {
  const c = new DatabaseSync(path);
  c.exec(SCHEMA);
  const ins = c.prepare('INSERT INTO product (source, code, name, unit, kcal, fat, carbs, protein, name_key, name_en, name_key_en, name_compact, name_compact_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const f of BLS_FIXTURE) {
    ins.run(BLS, f.code, f.name, 'g', f.kcal, f.fat, f.carbs, f.protein, nameKey(f.name), f.name_en, nameKey(f.name_en), nameCompact(f.name), nameCompact(f.name_en));
  }
  c.exec("INSERT INTO product_fts (rowid, name, brand, name_en) SELECT id, name, brand, name_en FROM product");
  c.prepare('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)').run('products', String(BLS_FIXTURE.length), 'updated_at', '1764000000');
  c.close();
}

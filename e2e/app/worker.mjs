// FOR TESTS: the native side of the iOS app (the bridge contract of ts/app, see ts/PORTING.md "App-Host") as a SharedWorker with
// SQLite in WebAssembly. Shared by all pages of the browser context, so the data survive a reload and a new page, like on the phone.
// `main` lives in memory, `bls` is the fixture the test server built with the importer's DDL, `catalog` is missing. The http op never
// reaches the network. Ops are handled one after another; while one page has a transaction open, the ops of the other pages wait
// (on the phone there is only one page, here the test's helper page also talks to it).
import sqlite3InitModule from '/__fake/sqlite/index.mjs';

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  const main = new sqlite3.oo1.DB(':memory:', 'c');
  const bytes = new Uint8Array(await (await fetch('/__fake/bls.db')).arrayBuffer());
  const bls = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(bls.pointer, 'main', p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
  if (rc) throw new Error(`deserialize failed: ${rc}`);
  return { sqlite3, dbs: { main, bls } };
})();

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const arg = (v) => (v !== null && typeof v === 'object' && typeof v.b64 === 'string' ? unb64(v.b64) : v);

const SECRET_KEY = b64(crypto.getRandomValues(new Uint8Array(32))); // this "device's" keychain key (per worker)

async function handle(msg) {
  const { sqlite3, dbs } = await ready;
  const name = msg.db ?? 'main';
  if (msg.op === 'http') throw new Error('connect: no network in the e2e app mode');
  if (msg.op === 'secretKey') return { keyB64: SECRET_KEY };
  if (msg.op !== 'sql' && msg.op !== 'exec') throw new Error(`unknown op ${msg.op}`);
  const db = dbs[name];
  if (!db) throw new Error('missing');
  if (msg.op === 'exec') { db.exec(msg.sql); return {}; }
  const bind = Array.isArray(msg.args) ? msg.args.map(arg) : Object.fromEntries(Object.entries(msg.args ?? {}).map(([k, v]) => [`:${k}`, arg(v)]));
  const rows = db.exec({ sql: msg.sql, bind: Array.isArray(bind) && !bind.length ? undefined : bind, rowMode: 'object', returnValue: 'resultRows' });
  for (const row of rows) for (const [k, v] of Object.entries(row)) {
    if (v instanceof Uint8Array) row[k] = { b64: b64(v) };
    else if (typeof v === 'bigint') row[k] = Number(v);
  }
  return { rows, changes: db.changes(), lastId: Number(sqlite3.capi.sqlite3_last_insert_rowid(db)) };
}

// one op at a time; a port with an open transaction on `main` goes first, the others wait until it ends
let owner = null;
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const i = queue.findIndex((q) => owner === null || q.port === owner);
      if (i < 0) break;
      const { port, id, msg } = queue.splice(i, 1)[0];
      let reply;
      try {
        reply = { id, result: await handle(msg) };
      } catch (e) {
        reply = { id, error: e instanceof Error ? e.message : String(e) };
      }
      // whoever leaves the connection inside a transaction owns it until it ends (also `BEGIN; …; COMMIT;` in one exec)
      const { sqlite3, dbs } = await ready;
      owner = sqlite3.capi.sqlite3_get_autocommit(dbs.main.pointer) ? null : port;
      if (id) port.postMessage(reply);
    }
  } finally {
    busy = false;
  }
}

onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (e) => {
    if (e.data.bye) { // the page is gone (what the Swift side does when the web view loads a new page)
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].port === port) queue.splice(i, 1);
      if (owner === port) queue.unshift({ port, id: 0, msg: { op: 'exec', sql: 'ROLLBACK' } });
      void pump();
      return;
    }
    queue.push({ port, ...e.data });
    void pump();
  };
  port.start();
};

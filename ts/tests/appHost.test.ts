// The app host (ts/app) on a fake native side (appBridge.ts): schema, transactions, catalogue, outgoing HTTP, every route without a
// crash, the export.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SchemaMismatch } from '../core/db.ts';
import { outgoing } from '../core/outgoing.ts';
import { pickAddress, TargetNotAllowed } from '../core/netguard.ts';
import { APP_ROUTES, localFetch, openLocal } from '../app/localHost.ts';
import { nativeDb } from '../app/nativeDb.ts';
import { buildBlsFixture, nodeBridge } from './appBridge.ts';

const schemaSql = readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'mw-app-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (http?: (m: any) => Promise<any>, withBls = true) => {
  const d = join(dir, String(++n));
  const bls = join(dir, `${n}-bls.db`);
  if (withBls) buildBlsFixture(bls);
  return nodeBridge({ main: `${d}.db`, bls: withBls ? bls : undefined, catalog: join(dir, 'none.db') }, http);
};
const json = (a: { body: Uint8Array | null }) => JSON.parse(new TextDecoder().decode(a.body!));
const JSON_HEADERS = { 'content-type': 'application/json', 'x-mahlwerk-request': '1' };

test('an empty database gets schema v20; another version is refused', async () => {
  const native = fresh();
  const { ctx } = await openLocal({ bridge: native.bridge, schemaSql });
  assert.equal((await ctx.db.get<any>('PRAGMA user_version'))!.user_version, 20);
  await ctx.db.exec('PRAGMA user_version = 19');
  await assert.rejects(openLocal({ bridge: native.bridge, schemaSql }), SchemaMismatch);
  native.close();
});

test('a transaction holds back the statements of other callers and rolls back on error', async () => {
  const native = fresh();
  const { ctx } = await openLocal({ bridge: native.bridge, schemaSql });
  const db = ctx.db;
  await db.exec('CREATE TABLE t (x INTEGER)');
  const order: string[] = [];
  const tx = db.tx(async (inner) => {
    await inner.run('INSERT INTO t VALUES (1)');
    await new Promise((r) => setTimeout(r, 20));
    order.push('tx');
    await inner.run('INSERT INTO t VALUES (2)');
  });
  const other = db.run('INSERT INTO t VALUES (3)').then(() => order.push('other'));
  await Promise.all([tx, other]);
  assert.deepEqual(order, ['tx', 'other']);
  await assert.rejects(db.tx(async (inner) => { await inner.run('INSERT INTO t VALUES (4)'); throw new Error('boom'); }), /boom/);
  assert.deepEqual((await db.all<any>('SELECT x FROM t ORDER BY x')).map((r) => r.x), [1, 2, 3]);
  // BLOBs and named arguments over the bridge
  await db.exec('CREATE TABLE b (v BLOB, k TEXT)');
  await db.run('INSERT INTO b VALUES (:v, :k)', { v: new Uint8Array([0, 1, 255]), k: 'a' });
  const row = await db.get<any>('SELECT v FROM b WHERE k = :k AND k = :k', { k: 'a' });
  assert.deepEqual([...row.v], [0, 1, 255]);
  const r = await db.run('INSERT INTO t VALUES (?)', [9]);
  assert.equal(r.changes, 1);
  assert.ok(r.lastId > 0);
  native.close();
});

test('nested transactions join the outer one; a failing BEGIN releases the lock', async () => {
  const calls: string[] = [];
  let failBegin = true;
  const db = nativeDb(async (m) => {
    calls.push(m.sql);
    if (m.sql === 'BEGIN IMMEDIATE' && failBegin) { failBegin = false; throw new Error('database is locked'); }
    return { rows: [], changes: 0, lastId: 0 };
  });
  await assert.rejects(db.tx(async () => 1), /locked/);
  assert.equal(await db.tx(async (inner) => inner.tx(async () => 7)), 7);
  await db.get('SELECT 1');
  assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'BEGIN IMMEDIATE', 'COMMIT', 'SELECT 1']);
});

test('the catalogue: BLS from the bridge, a missing Open Food Facts file is an empty catalogue', async () => {
  const native = fresh();
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const a = await dispatch('GET', '/api/v1/catalog', '?q=hafer', {});
  assert.equal(a.status, 200, new TextDecoder().decode(a.body!));
  const hits = json(a);
  assert.ok(JSON.stringify(hits).includes('Haferflocken'));
  const info = await dispatch('GET', '/api/v1/me', '', {});
  assert.equal(info.status, 200);
  native.close();
});

test('outgoing HTTP: only the Open Food Facts lookup leaves the device, no DNS, no pinned address', async () => {
  const seen: any[] = [];
  const native = fresh(async (m) => { seen.push(m); return { status: 200, headers: { 'Content-Type': 'application/json' }, bodyB64: Buffer.from('{"ok":1}').toString('base64') }; });
  const { ctx } = await openLocal({ bridge: native.bridge, schemaSql });
  const out = outgoing(ctx);
  const r = await out.fetch('off', { url: 'https://world.openfoodfacts.org/api/v2/product/1', timeout: 8 });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(seen[0].timeoutMs, 8000);
  assert.equal(seen[0].method, 'GET');
  await assert.rejects(out.fetch('webhook', { url: 'https://example.org/' }), (e: any) => e.kind === 'connect');
  await assert.rejects(out.fetch('off', { url: 'https://example.org/', address: '93.184.216.34' }), (e: any) => e.kind === 'connect');
  await assert.rejects(out.fetch('off', { url: 'https://example.org/', maxBytes: 3 }), (e: any) => e.kind === 'too_large');
  await assert.rejects(pickAddress(ctx, 'example.org', 443), TargetNotAllowed);
  assert.equal(seen.length, 2); // the refused ones never reached the native side
  native.close();
  const failing = fresh(async () => { throw new Error('timeout: the request took too long'); });
  const app = await openLocal({ bridge: failing.bridge, schemaSql });
  await assert.rejects(outgoing(app.ctx).fetch('off', { url: 'https://world.openfoodfacts.org/' }), (e: any) => e.kind === 'timeout');
  failing.close();
});

test('the barcode lookup goes to Open Food Facts over the bridge; without network it is a 502', async () => {
  const seen: any[] = [];
  const product = { status: 1, product: { product_name: 'Testmüsli', brands: 'Hof', nutriments: { 'energy-kcal_100g': 380, proteins_100g: 10, carbohydrates_100g: 60, fat_100g: 8 } } };
  const native = fresh(async (m) => { seen.push(m); return { status: 200, headers: { 'content-type': 'application/json' }, bodyB64: Buffer.from(JSON.stringify(product)).toString('base64') }; });
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const a = await dispatch('GET', '/api/v1/foods/barcode/4006381333931', '', {});
  assert.equal(a.status, 200, new TextDecoder().decode(a.body!));
  assert.equal(json(a).name, 'Testmüsli');
  assert.equal(new URL(seen[0].url).host, 'world.openfoodfacts.org');
  assert.equal(seen[0].bodyB64, null);
  native.close();
  const offline = fresh();
  const app = await openLocal({ bridge: offline.bridge, schemaSql });
  assert.equal((await app.dispatch('GET', '/api/v1/foods/barcode/4006381333931', '', {})).status, 502);
  offline.close();
});

test('what is off in the app answers like a server without it', async () => {
  const native = fresh();
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const me = json(await dispatch('GET', '/api/v1/me', '', {}));
  assert.deepEqual(me.features, { access_tokens: false, webhooks: false, cookidoo: false, web_recipes: false });
  assert.equal((await dispatch('GET', '/api/v1/me/yazio', '', {})).status, 404);
  assert.equal((await dispatch('POST', '/api/v1/admin/catalog/refresh', '', JSON_HEADERS)).status, 501);
  assert.equal((await dispatch('GET', '/api/v1/vision/status', '', {})).status, 200);
  assert.equal((await dispatch('DELETE', '/api/v1/me', '', {})).status !== 500, true);
  assert.equal((await dispatch('PUT', '/api/v1/nothing', '', {})).status, 404);
  assert.equal((await dispatch('DELETE', '/api/v1/auth/status', '', {})).status, 405);
  native.close();
});

test('every route of the app answers without a server error', async () => {
  const native = fresh();
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const values: Record<string, string> = { digest: '0'.repeat(32), size: 's', name: 'x', day: '2026-01-01' };
  const crashed: string[] = [];
  for (const r of APP_ROUTES) {
    const path = r.path.replace(/\{(\w+)(:path)?\}/g, (_m, name) => values[name] ?? '1');
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method);
    const a = await dispatch(r.method, path, '', write ? JSON_HEADERS : {}, write ? new TextEncoder().encode('{}') : null);
    // 501: a service the app does not have (pictures, catalogue refresh), the answer of a server without it
    if (a.status >= 500 && a.status !== 501) crashed.push(`${r.method} ${r.path} -> ${a.status} ${new TextDecoder().decode(a.body ?? new Uint8Array()).slice(0, 120)}`);
  }
  assert.deepEqual(crashed, []);
  native.close();
});

test('the export is a ZIP; localFetch gives the frontend a Response', async () => {
  const native = fresh();
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const f = localFetch(dispatch);
  const created = await f('api/v1/foods', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Brot', unit: 'g', per_100: { kcal: 250, protein: 9, carbs: 48, fat: 1 } }) });
  assert.equal(created.status, 201, await created.clone().text());
  const res = await f('api/v1/me/export?lang=de');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename=.*\.zip/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 2)], [0x50, 0x4b]);
  const bad = await f('api/v1/foods', { method: 'POST', headers: JSON_HEADERS, body: '{' });
  assert.equal(bad.status, 422);
  const empty = await f('api/v1/foods/999999', { method: 'DELETE', headers: { 'x-mahlwerk-request': '1' } });
  assert.equal(empty.status, 404);
  await assert.rejects(f('https://example.org/api/v1/me'), TypeError);
  native.close();
});

test('the app sources import nothing of node', () => {
  for (const file of ['bridge.ts', 'nativeDb.ts', 'catalog.ts', 'outgoing.ts', 'localHost.ts']) {
    const text = readFileSync(new URL(`../app/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /from '(node:|\.\.\/server\/)/, file);
  }
  void DatabaseSync;
});

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
import { APP_ROUTES, hostRequest, localFetch, openLocal } from '../app/localHost.ts';
import { nativeDb } from '../app/nativeDb.ts';
import { buildBlsFixture, nodeBridge } from './appBridge.ts';
import { fillSynthetic } from './synthetic.ts';
import { unzip } from '../core/yazioStage.ts';

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

const v21Sql = readFileSync(new URL('../core/migrations/v21.sql', import.meta.url), 'utf8');
const migrations = { 20: v21Sql };
/** The schema as sqlite_master holds it (tables, indexes, triggers in creation order) – what scripts/schema_sql.py writes. */
const dump = (path: string): string => {
  const c = new DatabaseSync(path);
  const rows = c.prepare('SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all() as { type: string; sql: string }[];
  c.close();
  const order: Record<string, number> = { table: 0, index: 1, trigger: 2 };
  return rows.sort((a, b) => order[a.type]! - order[b.type]!).map((r) => `${r.sql};\n`).join('');
};

test('an empty database gets schema v21; v20 is migrated by the app, any other version is refused', async () => {
  const native = fresh();
  const { ctx } = await openLocal({ bridge: native.bridge, schemaSql, migrations });
  assert.equal((await ctx.db.get<any>('PRAGMA user_version'))!.user_version, 21);
  await ctx.db.exec('PRAGMA user_version = 19');
  await assert.rejects(openLocal({ bridge: native.bridge, schemaSql, migrations }), SchemaMismatch);
  await ctx.db.exec('PRAGMA user_version = 20');
  await assert.rejects(openLocal({ bridge: native.bridge, schemaSql }), SchemaMismatch); // without the step (the server) v20 is refused
  native.close();
});

test('a v20 database on the phone is migrated to exactly the schema of a new v21 one; rows and counts stay, every row gets its own uid', async () => {
  const path = join(dir, 'v20.db');
  const c = new DatabaseSync(path);
  c.exec(`BEGIN; ${readFileSync(new URL('./fixtures/schema-v20.sql', import.meta.url), 'utf8')} PRAGMA user_version = 20; COMMIT;`);
  c.exec(`INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'me', 'Me', 1);
    INSERT INTO food (id, code, source, found, data, fetched_at, created_by) VALUES (1, '4000000000001', 'own', 1, '{"name":"x"}', 1, 1), (2, NULL, 'recipe', 1, '{}', 1, 1);
    INSERT INTO recipe (id, food_id, portions, created_by, updated_at) VALUES (1, 2, 1, 1, 1);
    INSERT INTO recipe_group (id, name, position, created_by, created_at) VALUES (1, 'G', 1, 1, 1);
    INSERT INTO template (id, user_id, name, created_at) VALUES (1, 1, 'T', 1);
    INSERT INTO fast (id, user_id, started_at, ended_at, target_hours) VALUES (1, 1, 1, 2, 16), (2, 1, 5, NULL, 16);
    INSERT INTO workout (id, user_id, day, minutes, created_at, external_id) VALUES (1, 1, '2026-01-01', 30, 1, 'hk-1');
    INSERT INTO weight (user_id, day, kg) VALUES (1, '2026-01-01', 70);`);
  const ins = c.prepare("INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, per_100, created_at) VALUES (1, ?, 'lunch', 1, ?, 'g', 'x', '{}', 1)");
  for (let i = 0; i < 300; i++) ins.run(`2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, i);
  const tables = ['diary_entry', 'workout', 'fast', 'template', 'recipe', 'recipe_group', 'food', 'weight'];
  const snapshot = () => Object.fromEntries(tables.map((t) => [t, c.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r: any) => { const { uid, ...rest } = r; return rest; })]));
  const before = snapshot();
  c.close();
  const native = nodeBridge({ main: path });
  const { ctx } = await openLocal({ bridge: native.bridge, schemaSql, migrations });
  assert.equal((await ctx.db.get<any>('PRAGMA user_version'))!.user_version, 21);
  native.close();
  const freshPath = join(dir, 'v21.db');
  const f = new DatabaseSync(freshPath);
  f.exec(`BEGIN; ${schemaSql} PRAGMA user_version = 21; COMMIT;`);
  f.close();
  assert.equal(dump(path), dump(freshPath));
  const after = new DatabaseSync(path);
  assert.deepEqual(Object.fromEntries(tables.map((t) => [t, after.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r: any) => { const { uid, ...rest } = r; return rest; })])), before);
  for (const t of tables.filter((x) => x !== 'weight')) {
    const uids = after.prepare(`SELECT uid FROM ${t}`).all().map((r: any) => r.uid);
    assert.ok(uids.every((u) => typeof u === 'string' && /^[0-9a-f]{32}$/.test(u)), t);
    assert.equal(new Set(uids).size, uids.length, t);
  }
  after.close();
  // a second start changes nothing; a failing step leaves the database at v20
  const again = nodeBridge({ main: path });
  await openLocal({ bridge: again.bridge, schemaSql, migrations });
  again.close();
  const broken = join(dir, 'v20b.db');
  const b = new DatabaseSync(broken);
  b.exec(`BEGIN; ${readFileSync(new URL('./fixtures/schema-v20.sql', import.meta.url), 'utf8')} PRAGMA user_version = 20; COMMIT;`);
  b.close();
  const nb = nodeBridge({ main: broken });
  await assert.rejects(openLocal({ bridge: nb.bridge, schemaSql, migrations: { 20: v21Sql + ' SELECT no_such_function();' } }));
  nb.close();
  const b2 = new DatabaseSync(broken);
  assert.equal((b2.prepare('PRAGMA user_version').get() as any).user_version, 20);
  assert.ok(!(b2.prepare('PRAGMA table_info(food)').all() as any[]).some((col) => col.name === 'uid'));
  b2.close();
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
  assert.deepEqual(me.features, { access_tokens: false, webhooks: false, cookidoo: true, web_recipes: false });
  assert.equal(json(await dispatch('GET', '/api/v1/me/import', '', {})).available, true);
  assert.equal((await dispatch('POST', '/api/v1/me/yazio/login', '', JSON_HEADERS, new TextEncoder().encode('{"email":"a@b.de","password":"x"}'))).status, 404);
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

test('Cookidoo in the app: the own account is stored with the keychain key, the client talks over the http op', async () => {
  const seen: any[] = [];
  const native = fresh(async (m) => { seen.push(m); throw new Error('connect: no network in the tests'); });
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const body = new TextEncoder().encode(JSON.stringify({ email: 'koch@example.org', password: 'geheim-123', country: 'de', language: 'de-DE' }));
  const put = await dispatch('PUT', '/api/v1/me/cookidoo-account', '', JSON_HEADERS, body);
  assert.equal(put.status, 200, new TextDecoder().decode(put.body!));
  assert.equal(JSON.stringify(json(put)).includes('geheim'), false);
  const own = json(await dispatch('GET', '/api/v1/me/cookidoo-account', '', {}));
  assert.equal(JSON.stringify(own).includes('k***@example.org'), true);
  const stored = (await native.bridge({ op: 'sql', db: 'main', sql: 'SELECT blob FROM secret', args: [] })).rows;
  assert.equal(stored.length, 1);
  assert.equal(Buffer.from(stored[0].blob.b64, 'base64').includes(Buffer.from('geheim')), false); // encrypted at rest
  await dispatch('POST', '/api/v1/me/cookidoo-account/check', '', JSON_HEADERS, new Uint8Array(0));
  assert.equal(seen.length > 0 && seen.every((m) => new URL(m.url).protocol === 'https:'), true); // went out over the bridge
  native.close();
});

test('without a keychain key the app refuses to store an account instead of making a key of its own', async () => {
  const native = fresh();
  const bridge = async (m: any) => { if (m.op === 'secretKey') throw new Error('keychain unavailable'); return native.bridge(m); };
  const { dispatch } = await openLocal({ bridge, schemaSql });
  const body = new TextEncoder().encode(JSON.stringify({ email: 'koch@example.org', password: 'geheim-123', country: 'de', language: 'de-DE' }));
  assert.equal((await dispatch('PUT', '/api/v1/me/cookidoo-account', '', JSON_HEADERS, body)).status, 503);
  native.close();
});

test('the Yazio file import works in the app: a gzip-packed file is unpacked, previewed and imported', async () => {
  const native = fresh();
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const status = json(await dispatch('GET', '/api/v1/me/yazio', '', {}));
  assert.equal(status.login.available, false);
  const packed = new Uint8Array(await new Response(new Blob([JSON.stringify({ '2026-01-10': 80.4, '2026-01-11': 80.1 })]).stream()
    .pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const put = await dispatch('PUT', '/api/v1/me/yazio/files/weight.json', '', { 'content-type': 'application/octet-stream', 'x-mahlwerk-request': '1' }, packed);
  assert.equal(put.status, 200, new TextDecoder().decode(put.body!));
  const preview = await dispatch('POST', '/api/v1/me/yazio/preview', '', JSON_HEADERS, new TextEncoder().encode('{}'));
  assert.equal(preview.status, 200, new TextDecoder().decode(preview.body!));
  const shown = json(preview);
  const done = await dispatch('POST', '/api/v1/me/yazio/confirm', '', JSON_HEADERS, new TextEncoder().encode(JSON.stringify({ token: shown.token })));
  assert.equal(done.status, 200, new TextDecoder().decode(done.body!));
  const weights = (await native.bridge({ op: 'sql', db: 'main', sql: 'SELECT count(*) AS n FROM weight', args: [] })).rows[0].n;
  assert.equal(weights, 2);
  native.close();
});

test('the native side reaches core through mahlwerkHost.request: Health sync, summary/today, water, history', async () => {
  const native = fresh();
  const { dispatch } = await openLocal({ bridge: native.bridge, schemaSql });
  const request = hostRequest(dispatch);
  const day = new Date().toISOString().slice(0, 10);
  const sync = await request({ method: 'POST', path: '/api/v1/health/sync', body: { days: [{ day, steps: 5400, active_kcal: 310 }] } });
  assert.equal(sync.status, 200, sync.body ?? '');
  const water = await request({ method: 'POST', path: `/api/v1/water/${day}`, body: JSON.stringify({ add_ml: 250 }) });
  assert.equal(water.status, 200, water.body ?? '');
  const today = await request({ method: 'GET', path: '/api/v1/summary/today' });
  assert.equal(today.status, 200);
  assert.equal(typeof JSON.parse(today.body!), 'object');
  const history = await request({ method: 'GET', path: '/api/v1/history', query: { days: 30 } });
  assert.equal(history.status, 200, history.body ?? '');
  assert.equal((await request({ method: 'GET', path: '/elsewhere' })).status, 400);
  native.close();
});

test('"refresh" in the app loads the published catalogue: manifest over http (redirect followed), then the download op', async () => {
  const manifest = { version: 1, url: 'https://github.com/mbrockeu/mahlwerk/releases/download/catalog/catalog-de-2026-11-24.db.gz',
    sha256: 'ab'.repeat(32), bytes: 40153729, db_bytes: 109215744, products: 243838 };
  const asked: string[] = [];
  const native = fresh(async (m) => {
    asked.push(m.url);
    if (new URL(m.url).host === 'github.com') return { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/x/catalog.json' }, bodyB64: null };
    return { status: 200, headers: { 'content-type': 'application/octet-stream' }, bodyB64: Buffer.from(JSON.stringify(manifest)).toString('base64') };
  });
  let download: any = null;
  let state: any = { state: 'idle', bytes: 0, total: 0 };
  const bridge = async (m: any) => {
    if (m.op === 'download') { download = m; state = { state: 'running', bytes: 5 * 1024 * 1024, total: manifest.bytes }; return {}; }
    if (m.op === 'downloadStatus') return state;
    return native.bridge(m);
  };
  const { dispatch } = await openLocal({ bridge, schemaSql });
  assert.equal(json(await dispatch('GET', '/api/v1/admin/catalog/refresh', '', {})).state, 'idle');
  const started = await dispatch('POST', '/api/v1/admin/catalog/refresh', '', JSON_HEADERS);
  assert.equal(started.status, 202, new TextDecoder().decode(started.body!));
  assert.deepEqual(asked, ['https://github.com/mbrockeu/mahlwerk/releases/download/catalog/catalog.json', 'https://release-assets.githubusercontent.com/x/catalog.json']);
  assert.deepEqual({ ...download, op: undefined }, { op: undefined, target: 'catalog', url: manifest.url, sha256: manifest.sha256, bytes: manifest.bytes, db_bytes: manifest.db_bytes });
  const running = json(started);
  assert.equal(running.state, 'running');
  assert.equal(running.progress, '5.0 / 38 MB');
  assert.equal((await dispatch('POST', '/api/v1/admin/catalog/refresh', '', JSON_HEADERS)).status, 409);
  state = { state: 'failed', error: 'checksum' };
  assert.deepEqual([json(await dispatch('GET', '/api/v1/admin/catalog/refresh', '', {})).state, json(await dispatch('GET', '/api/v1/admin/catalog/refresh', '', {})).error], ['error', 'checksum']);
  state = { state: 'done', bytes: manifest.bytes, total: manifest.bytes };
  const done = json(await dispatch('GET', '/api/v1/admin/catalog/refresh', '', {}));
  assert.equal(done.state, 'done');
  native.close();
});

test('a manifest that names a file elsewhere is refused before anything is downloaded', async () => {
  const bad = { version: 1, url: 'https://evil.example/catalog.db.gz', sha256: 'ab'.repeat(32), bytes: 10, db_bytes: 20 };
  const native = fresh(async () => ({ status: 200, headers: {}, bodyB64: Buffer.from(JSON.stringify(bad)).toString('base64') }));
  let downloads = 0;
  const bridge = async (m: any) => { if (m.op === 'download') { downloads++; return {}; } if (m.op === 'downloadStatus') return { state: 'idle' }; return native.bridge(m); };
  const { dispatch } = await openLocal({ bridge, schemaSql });
  await dispatch('POST', '/api/v1/admin/catalog/refresh', '', JSON_HEADERS);
  const s = json(await dispatch('GET', '/api/v1/admin/catalog/refresh', '', {}));
  assert.deepEqual([s.state, s.error, downloads], ['error', 'unexpected file address', 0]);
  native.close();
});

const exportJson = async (zip: Uint8Array) => JSON.parse(new TextDecoder().decode((await unzip(zip, ['mahlwerk-export.json']))['mahlwerk-export.json']));
const RAW = { 'content-type': 'application/octet-stream', 'x-mahlwerk-request': '1' };

test('data import in the app: a server export comes onto the phone and back, a second import changes nothing', async () => {
  const phone = fresh();
  const { dispatch } = await openLocal({ bridge: phone.bridge, schemaSql, migrations });
  const post = (path: string, body: unknown) => dispatch('POST', path, '', JSON_HEADERS, new TextEncoder().encode(JSON.stringify(body)));
  const food = json(await post('/api/v1/foods', { name: 'Brot', per_100: { kcal: 250, protein: 9, carbs: 48, fat: 1 } }));
  await post('/api/v1/diary/2026-03-10/entries', { food_id: food.id, meal: 'lunch', amount: 80 });
  const zip = (await dispatch('GET', '/api/v1/me/export', '', {})).body!;
  // a second phone (a new device)
  const other = fresh();
  const app2 = await openLocal({ bridge: other.bridge, schemaSql, migrations });
  const p = await app2.dispatch('POST', '/api/v1/me/import/preview', '', RAW, zip);
  assert.equal(p.status, 200, new TextDecoder().decode(p.body!));
  const c = await app2.dispatch('POST', '/api/v1/me/import/confirm', '', JSON_HEADERS, new TextEncoder().encode(JSON.stringify({ token: json(p).token, mode: 'merge' })));
  assert.equal(c.status, 200, new TextDecoder().decode(c.body!));
  const back = (await app2.dispatch('GET', '/api/v1/me/export', '', {})).body!;
  const strip = (d: any) => { const { exported_at: _e, app_version: _v, ...rest } = d; return rest; };
  assert.deepEqual(strip(await exportJson(back)), strip(await exportJson(zip)));
  const again = json(await app2.dispatch('POST', '/api/v1/me/import/preview', '', RAW, zip));
  for (const k of Object.values(again.modes.merge.counts) as any[]) assert.equal(k.new + k.changed, 0);
  phone.close();
  other.close();
});

test('data import in the app: 15,000 diary entries (about 3 years) over the bridge, measured', async () => {
  const source = fresh();
  const a = await openLocal({ bridge: source.bridge, schemaSql, migrations });
  await a.dispatch('GET', '/api/v1/me', '', {}); // makes the one user of the app
  const userId = (await a.ctx.db.get<any>('SELECT id FROM user'))!.id;
  await fillSynthetic(a.ctx.db, userId, 15000);
  const zip = (await a.dispatch('GET', '/api/v1/me/export', '', {})).body!;
  source.close();
  const target = fresh();
  const b = await openLocal({ bridge: target.bridge, schemaSql, migrations });
  const t0 = performance.now();
  const p = await b.dispatch('POST', '/api/v1/me/import/preview', '', RAW, zip);
  const t1 = performance.now();
  assert.equal(p.status, 200, new TextDecoder().decode(p.body!));
  assert.equal(json(p).modes.merge.counts.diary.new, 15000);
  const ops = target.log.length;
  const c = await b.dispatch('POST', '/api/v1/me/import/confirm', '', JSON_HEADERS, new TextEncoder().encode(JSON.stringify({ token: json(p).token, mode: 'merge' })));
  const t2 = performance.now();
  assert.equal(c.status, 200, new TextDecoder().decode(c.body!));
  const confirmOps = target.log.length - ops;
  assert.equal((await b.ctx.db.get<any>('SELECT count(*) AS n, count(DISTINCT uid) AS u FROM diary_entry'))!.n, 15000);
  // the same file once more: everything is matched, nothing written
  const p2 = await b.dispatch('POST', '/api/v1/me/import/preview', '', RAW, zip);
  const t3 = performance.now();
  assert.equal(json(p2).modes.merge.counts.diary.unchanged, 15000);
  console.log(`import of 15,000 entries (zip ${zip.length} bytes): preview ${Math.round(t1 - t0)} ms, confirm ${Math.round(t2 - t1)} ms with ${confirmOps} bridge ops, `
    + `second preview ${Math.round(t3 - t2)} ms`);
  // one statement per product (300 here), the long tables in batches: far fewer ops than rows
  assert.ok(confirmOps < 1000, `${confirmOps} bridge ops`);
  target.close();
});

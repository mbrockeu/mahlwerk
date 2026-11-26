// The refresh of the last days from Yazio (core/yazio.ts buildPlan with `refresh`, core/store/imports.ts, core/yazioLive.ts fetchRefresh):
// the scope of "came from Yazio", what counts as gone, normalised comparison, dry run = import, and a failed day ending the run. The HTTP-level
// behaviour is covered by the Python tests in tests/test_yazio_refresh.py (run against this server through ts/api-tests.sh).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { YazioError, runImportFrom } from '../core/yazio.ts';
import { Credentials, Fetcher, LiveError } from '../core/yazioLive.ts';
import { RefreshChanged } from '../core/store/imports.ts';
import type { Outgoing } from '../core/outgoing.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });

const OATS = { name: 'Oats', producer: 'Acme', base_unit: 'g', servings: [], nutrients: { 'energy.energy': 3.73, 'nutrient.carb': 0.5954, 'nutrient.fat': 0.07, 'nutrient.protein': 0.135 } };
const day = (products: unknown[] = [], trainings: unknown[] = [], water?: number) => ({
  consumed: { products, recipe_portions: [], simple_products: [] }, exercises: { training: trainings, custom_training: [] },
  daily_summary: water === undefined ? {} : { water_intake: water },
});
const oats = (id: string, amount: number, daytime = 'breakfast') => ({ id, daytime, date: '2026-03-10T08:00:00+01:00', product_id: 'p-oats', amount });
const run = (id: string, minutes: number) => ({ id, name: 'running', duration: minutes, energy: 300, date: '2026-03-10T07:00:00+01:00' });
const files = (days: Record<string, unknown>, weights: Record<string, number> = {}) => ({ 'days.json': days, 'products.json': { products: { 'p-oats': OATS }, recipes: {} }, 'weight.json': weights });
const PERIOD = { first_day: '2026-03-09', last_day: '2026-03-11' };
const empty = (): Record<string, unknown> => ({ '2026-03-09': day(), '2026-03-10': day(), '2026-03-11': day() });

async function setup() {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  await w.ann.get('/api/v1/me');
  const id = (await w.ctx.db.get<any>("SELECT id FROM user WHERE username = 'ann'"))!.id as number;
  return { w, db: w.ctx.db, id };
}
const count = async (db: any, sql: string, ...args: unknown[]) => (await db.get(sql, args))!.n as number;

test('an unchanged refresh reports 0 updated and 0 removed and leaves no batch', async () => {
  const { db, id } = await setup();
  const days = { ...empty(), '2026-03-10': day([oats('e1', 80), oats('e2', 30.5, 'dinner')], [run('t1', 30)], 1500) };
  await runImportFrom(db, id, files(days, { '2026-03-10': 80 }));
  const batches = await count(db, 'SELECT count(*) AS n FROM import_batch');
  const s = await runImportFrom(db, id, files(days, { '2026-03-10': 80 }), false, false, 'test', PERIOD);
  assert.deepEqual([s.entries_updated, s.entries_removed, s.workouts_updated, s.workouts_removed, s.weights_updated, s.water_updated, s.activity_updated], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.already_imported, 2);
  assert.equal(s.batch_id, null);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM import_batch'), batches);
  assert.deepEqual([s.entries_seen, s.workouts_seen], [2, 1]);
});

test('a changed amount is an update that keeps the first batch; what Yazio dropped is removed; dry run and import count the same', async () => {
  const { db, id } = await setup();
  const first = await runImportFrom(db, id, files({ ...empty(), '2026-03-10': day([oats('e1', 80), oats('e2', 30)], [run('t1', 30)]) }));
  const next = files({ ...empty(), '2026-03-10': day([oats('e1', 120), oats('e3', 10)], []) });
  const dry = await runImportFrom(db, id, next, false, true, 'test', PERIOD);
  const real = await runImportFrom(db, id, next, false, false, 'test', PERIOD);
  for (const k of ['entries_updated', 'entries_removed', 'workouts_removed', 'already_imported', 'total_entries'] as const) assert.equal(dry[k], real[k], k);
  assert.deepEqual([real.entries_updated, real.entries_removed, real.workouts_removed, real.total_entries], [1, 1, 1, 1]);
  const rows = await db.all('SELECT external_id, amount, import_id FROM diary_entry ORDER BY external_id');
  assert.deepEqual(rows.map((r) => [r.external_id, r.amount]), [['e1', 120], ['e3', 10]]);
  assert.equal(rows[0]!.import_id, first.batch_id); // updated in place, still the first batch's
  assert.equal(rows[1]!.import_id, real.batch_id);
});

test('an item that is listed but cannot be imported is not deleted', async () => {
  const { db, id } = await setup();
  await runImportFrom(db, id, files({ ...empty(), '2026-03-10': day([oats('e1', 80)], [run('t1', 30)]) }));
  const s = await runImportFrom(db, id, files({ ...empty(), '2026-03-10': day([oats('e1', 0)], [run('t1', 0)]) }), false, false, 'test', PERIOD);
  assert.deepEqual([s.entries_removed, s.workouts_removed, s.entries_updated, s.workouts_updated], [0, 0, 0, 0]);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM diary_entry'), 1);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM workout'), 1);
});

test('own, Health, changed and outside rows are never touched', async () => {
  const { db, id } = await setup();
  await runImportFrom(db, id, files({ '2026-03-01': day([oats('old', 50)]), ...empty(), '2026-03-10': day([oats('e1', 80), oats('e2', 30)], [run('t1', 30)]) }));
  await db.run("UPDATE diary_entry SET import_id = NULL WHERE external_id = 'e2'"); // what a change by the person does
  await db.run("INSERT INTO diary_entry (user_id, day, meal, amount, unit, name, per_100, extra, created_at) VALUES (?, '2026-03-10', 'snack', 1, 'g', 'Mine', '{}', '{}', 1)", [id]);
  await db.run("INSERT INTO workout (user_id, day, kind, name, minutes, source, external_id, created_at) VALUES (?, '2026-03-10', 'walking', 'Walk', 20, 'health', 'hk-1', 1)", [id]);
  await db.run("INSERT INTO workout (user_id, day, kind, name, minutes, source, external_id, created_at) VALUES (?, '2026-03-10', 'walking', 'Fake', 20, 'health', 'yazio:t1x', 1)", [id]);
  const s = await runImportFrom(db, id, files(empty()), false, false, 'test', PERIOD);
  assert.deepEqual([s.entries_removed, s.workouts_removed], [1, 1]); // only e1 and the Yazio training t1
  assert.deepEqual((await db.all('SELECT name FROM diary_entry ORDER BY name')).map((r) => r.name), ['Mine', 'Oats', 'Oats']); // old (outside) + e2 (changed) + own
  assert.deepEqual((await db.all('SELECT external_id FROM workout ORDER BY external_id')).map((r) => r.external_id), ['hk-1', 'yazio:t1x']);
});

test('weight and water of Yazio origin are updated, the person\'s own are not, and nothing is deleted', async () => {
  const { db, id } = await setup();
  await db.run("INSERT INTO weight (user_id, day, kg, demo, health) VALUES (?, '2026-03-11', 70, 0, 0)", [id]);
  await runImportFrom(db, id, files({ ...empty(), '2026-03-10': day([oats('e1', 80)], [], 1500), '2026-03-11': day([], [], 900) }, { '2026-03-10': 81, '2026-03-11': 79 }));
  const days = { ...empty(), '2026-03-10': day([oats('e1', 80)], [], 1800), '2026-03-11': day([], [], 1000) };
  const s = await runImportFrom(db, id, files(days, { '2026-03-10': 82, '2026-03-11': 78 }), false, false, 'test', PERIOD);
  assert.deepEqual([s.weights_updated, s.water_updated, s.weights, s.water], [1, 2, 0, 0]);
  assert.deepEqual((await db.all('SELECT day, kg FROM weight ORDER BY day')).map((r) => [r.day, r.kg]), [['2026-03-10', 82], ['2026-03-11', 70]]);
  const gone = await runImportFrom(db, id, files(empty()), false, false, 'test', PERIOD);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM weight'), 2);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM water'), 2);
  assert.equal(gone.entries_removed, 1);
});

test('a refresh whose staged days do not cover the period is refused, an ordinary import ignores seen ids', async () => {
  const { db, id } = await setup();
  await assert.rejects(runImportFrom(db, id, files({ '2026-03-10': day() }), false, false, 'test', PERIOD), YazioError);
  const s = await runImportFrom(db, id, files({ '2026-03-10': day([oats('e1', 80)]) }));
  assert.equal(s.refresh, null);
  assert.equal(s.entries_removed, 0);
});

// ---- the fetcher ----

function service(days: Record<string, any>, fail: Record<string, number> = {}): Outgoing {
  return {
    resolve: async () => [],
    fetch: async (_purpose, req) => {
      const url = new URL(req.url);
      const path = url.pathname.replace('/v15', '');
      const reply = (status: number, body: unknown) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
      if (path === '/oauth/token') return reply(200, { access_token: 'tok' });
      for (const [prefix, status] of Object.entries(fail)) if (path.startsWith(prefix)) return reply(status, {});
      const d = url.searchParams.get('date') ?? '';
      if (path === '/user/consumed-items') return days[d] ? reply(200, days[d].consumed) : reply(404, {});
      if (path === '/user/exercises') return days[d] ? reply(200, days[d].exercises) : reply(404, {});
      if (path === '/user/widgets/daily-summary') return days[d] ? reply(200, days[d].daily_summary) : reply(404, {});
      if (path.startsWith('/products/')) return reply(200, OATS);
      if (path === '/user/bodyvalues/weight/last') return reply(200, d >= '2026-03-10' ? { value: 80 } : {});
      return reply(404, {});
    },
  } as Outgoing;
}
const fetcher = (out: Outgoing) => new Fetcher(out, ['id', 'secret'], { sleep: async () => {}, today: () => ({ year: 2026, month: 3, iso: '2026-03-11' }) });
const progress = () => ({ phase: 'login', done: 0, total: 0, requests: 0, bytes: 0, cancelled: false });

test('the refresh fetch asks for every day directly and keeps the weights of the period only', async () => {
  const got = await fetcher(service({ ...empty(), '2026-03-10': day([oats('e1', 80)]) })).run(new Credentials('a@b.de', 'x'), 12, progress(), 3);
  assert.deepEqual(Object.keys(got['days.json']), ['2026-03-09', '2026-03-10', '2026-03-11']);
  assert.deepEqual(got['refresh.json'], PERIOD);
  assert.deepEqual({ ...got['weight.json'] }, { '2026-03-10': 80 }); // the day before the period is asked, but it is not kept
});

test('an unanswered or failed day ends the whole run, an empty period is fine', async () => {
  const bad = { ...empty() } as Record<string, any>;
  delete bad['2026-03-10'];
  await assert.rejects(fetcher(service(bad)).run(new Credentials('a@b.de', 'x'), 12, progress(), 3), (e: any) => e instanceof LiveError && e.kind === 'unexpected');
  await assert.rejects(fetcher(service(empty(), { '/user/exercises': 403 })).run(new Credentials('a@b.de', 'x'), 12, progress(), 3), (e: any) => e instanceof LiveError && e.kind === 'expired');
  const notList = { ...empty(), '2026-03-10': { ...day(), consumed: { products: 'oops', recipe_portions: [], simple_products: [] } } };
  await assert.rejects(fetcher(service(notList)).run(new Credentials('a@b.de', 'x'), 12, progress(), 3), (e: any) => e instanceof LiveError && e.kind === 'unexpected');
  const got = await fetcher(service(empty())).run(new Credentials('a@b.de', 'x'), 12, progress(), 3);
  assert.equal(Object.keys(got['days.json']).length, 3); // nothing logged at all is a valid answer
});

test('a refresh day without its lists is refused by the plan builder', async () => {
  const { db, id } = await setup();
  for (const bad of [{ ...day(), exercises: {} }, { ...day(), exercises: { training: [] } }, { ...day(), consumed: { products: [] } }, { consumed: day().consumed }]) {
    await assert.rejects(runImportFrom(db, id, files({ ...empty(), '2026-03-10': bad }), false, true, 'test', PERIOD), (e: any) => e instanceof YazioError && /incomplete/.test(e.message));
  }
});

test('the removals the person was shown must still be the removals: otherwise nothing is written', async () => {
  const { db, id } = await setup();
  await runImportFrom(db, id, files({ ...empty(), '2026-03-10': day([oats('e1', 80)], [run('t1', 30)]) }));
  const next = files(empty());
  await assert.rejects(runImportFrom(db, id, next, false, false, 'test', PERIOD, [0, 1]), RefreshChanged);
  await assert.rejects(runImportFrom(db, id, next, false, false, 'test', PERIOD, [1, 0]), RefreshChanged);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM diary_entry'), 1);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM workout'), 1);
  const s = await runImportFrom(db, id, next, false, false, 'test', PERIOD, [1, 1]);
  assert.deepEqual([s.entries_removed, s.workouts_removed], [1, 1]);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM diary_entry'), 0);
});

test('a refresh fetch needs both exercise lists', async () => {
  for (const exercises of [{}, { training: [] }, { custom_training: [] }, { training: [], custom_training: 'x' }]) {
    const days = { ...empty(), '2026-03-10': { ...day(), exercises } };
    await assert.rejects(fetcher(service(days)).run(new Credentials('a@b.de', 'x'), 12, progress(), 3), (e: any) => e instanceof LiveError && e.kind === 'unexpected');
  }
});

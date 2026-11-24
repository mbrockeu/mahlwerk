// Taking over many recipes at once: pacing, idempotence, stopping, one run per account, groups (test_cookidoo_bulk.py).
// Nothing sleeps: the client is a stand-in and the clock an injected one that the stand-in `sleep` advances.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { openSchema } from '../core/db.ts';
import { Access, BULK_CALL_LIMIT, BULK_GAP, CALL_LIMIT, CookidooError, Hub, Settings, type Collection, type CookidooClient, type PlanDay, type PlannedRecipe, type RecipeDetails } from '../core/cookidoo.ts';
import { BulkError, BulkRuns, FRESH_SECONDS, MAX_RECIPES, MAX_STREAK, SECONDS_PER_RECIPE, makeImagePlan, makePlan, summarize, type ImagesPort } from '../core/cookidooBulk.ts';
import { addToGroup, createGroup, deleteGroup, listGroups, removeFromGroup, renameGroup } from '../core/store/recipes.ts';
import { sourceDismissed } from '../core/store/cookidoo.ts';
import { getFoodByExternalId, setFoodImage } from '../core/store/foods.ts';
import { openSqlite } from '../server/sqlite.ts';
import { entry } from './cookidooHarness.ts';

const SETTINGS = Settings.build('someone@example.invalid', 'pw-not-real', 'de', 'de-DE')!;
const access = (key = 'shared') => new Access(key, SETTINGS, key === 'shared' ? 'shared' : 'own');
const details = (rid: string): RecipeDetails => ({ id: rid, name: `Recipe ${rid}`, portions: 4, nutrition: entry({ kcal: [400, 'kcal'], fat: [10, 'g'], carb2: [50, 'g'], protein: [20, 'g'] }) });
const KEEP_FINISHED = 3600;

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function makeWorld(n = 6) {
  const dir = mkdtempSync(join(tmpdir(), 'cookidoo-bulk-'));
  dirs.push(dir);
  const db = openSqlite(join(dir, 'bulk.db'));
  await openSchema(db, readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8'));
  const clock = { now: Date.now() / 1000 }; // the store stamps foods with the system clock, so the runner's clock starts there
  const w = {
    db, clock, calls: [] as [string, number][], sleeps: [] as number[], fail: {} as Record<string, string>, reject: new Set<string>(),
    enabled: true, onCall: null as null | ((rid: string) => void), ids: [] as string[], refs: [] as PlannedRecipe[],
    collections: [] as Collection[], week: [] as PlanDay[], hub: null as unknown as Hub, runs: null as unknown as BulkRuns,
    images: null as null | { wants: (id: number) => Promise<boolean>; stored: [number, string][]; fetchProvider: ImagesPort['fetchProvider'] },
    imagesOn: false,
    async go(scope = 'all', collection: string | null = null, key = 'shared', regroup = false) {
      const plan = await makePlan(w.hub, access(key), scope, collection);
      const run = await w.runs.start(access(key), plan, null, regroup);
      await run.task;
      return run;
    },
    names: async () => Object.fromEntries((await listGroups(db)).map((g) => [g.name, g])),
    food: (rid: string) => getFoodByExternalId(db, `cookidoo:${rid}`),
  };
  w.ids = Array.from({ length: n }, (_, i) => `r${100000 + i}`);
  w.refs = w.ids.map((id) => ({ id, name: `Recipe ${id}` }));
  w.collections = [{ id: 'c1', name: 'Favourites', managed: false, recipes: w.refs.slice(0, 4) }, { id: 'c2', name: 'Quick dinners', managed: true, recipes: w.refs.slice(2, 6) }];
  w.week = [{ day: 'd1', title: 'Monday', recipes: [w.refs[5]!, w.refs[0]!] }];
  const client: CookidooClient = {
    week: async () => w.week, collections: async () => w.collections,
    async recipe(rid) {
      w.calls.push([rid, w.clock.now]);
      w.onCall?.(rid);
      if (w.fail[rid]) throw new CookidooError(w.fail[rid]!);
      if (w.reject.has(rid)) return { id: rid, name: `Recipe ${rid}`, portions: 2, nutrition: [] };
      return { ...details(rid), image: `https://img.example/${rid}.jpg` };
    },
    async ping() {}, async close() {},
  };
  w.hub = new Hub({ factory: () => client, clock: () => w.clock.now });
  const sleep = async (s: number) => { w.sleeps.push(s); w.clock.now += s; await new Promise((r) => setImmediate(r)); };
  w.images = { stored: [], wants: async () => true, fetchProvider: async (_f, id, url) => { w.images!.stored.push([id, String(url)]); await setFoodImage(db, id, 'a'.repeat(32), 'cookidoo', String(url)); return true; } };
  w.runs = new BulkRuns({ hub: w.hub, db, enabled: () => w.enabled, sleep, clock: () => w.clock.now, images: w.images as ImagesPort, fetcher: {} as never, imagesOn: () => w.imagesOn });
  return w;
}
const kindOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof BulkError || e instanceof CookidooError ? e.kind : `other ${e}`; } };

// ---- the plan ----

test('the plan has every recipe once and remembers its collections', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  assert.deepEqual(plan.items.map((i) => i.id), w.ids);
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i.collections]));
  assert.deepEqual([by[w.ids[2]!], by[w.ids[5]!]], [['c1', 'c2'], ['c2']]);
  assert.deepEqual([...plan.groups], [['c1', 'Favourites'], ['c2', 'Quick dinners']]);
});

test('the plan of one collection and of the week; unknown, empty and too many', async () => {
  const w = await makeWorld();
  const one = await makePlan(w.hub, access(), 'collection', 'c2');
  assert.deepEqual(one.items.map((i) => i.id), w.ids.slice(2, 6));
  const wk = await makePlan(w.hub, access(), 'week', null);
  assert.deepEqual(new Set(wk.items.map((i) => i.id)), new Set([w.ids[5], w.ids[0]]));
  assert.equal(wk.groups.size, 0);
  assert.equal(await kindOf(makePlan(w.hub, access(), 'collection', 'nope')), 'not_found');
  w.collections = []; w.week = [];
  w.clock.now += 61;
  assert.equal(await kindOf(makePlan(w.hub, access(), 'all', null)), 'empty');
  const many = Array.from({ length: MAX_RECIPES + 1 }, (_, i) => ({ id: `r${200000 + i}`, name: `R${i}` }));
  w.clock.now += 61;
  w.collections = [{ id: 'big', name: 'Big', managed: false, recipes: many }];
  const err = await makePlan(w.hub, access(), 'all', null).catch((e) => e);
  assert.ok(err instanceof BulkError && err.kind === 'too_many' && err.detail === MAX_RECIPES + 1);
  w.clock.now += 61;
  w.collections = [{ id: 'big', name: 'Big', managed: false, recipes: many.slice(0, MAX_RECIPES) }];
  assert.equal((await makePlan(w.hub, access(), 'all', null)).items.length, MAX_RECIPES); // exactly the limit is fine
});

// ---- pacing and idempotence ----

test('calls are at least the gap apart, none before the first, and nothing really sleeps', async () => {
  const w = await makeWorld();
  const started = Date.now();
  const r = await w.go();
  assert.deepEqual([r.state, r.counts.adopted, r.fetched], ['done', 6, 6]);
  const times = w.calls.map((c) => c[1]);
  assert.equal(times.length, 6);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= BULK_GAP - 1e-9);
  assert.equal(w.sleeps.length, 5);
  assert.ok(w.sleeps.every((s) => Math.abs(s - BULK_GAP) < 1e-9));
  assert.ok(Date.now() - started < 2000);
  const food = await w.food(w.ids[0]!);
  assert.deepEqual([food!.source, food!.data!.per_100.kcal, (food!.data as any).region], ['cookidoo', 400, ['de', 'de-DE']]);
});

test('a second run skips what is up to date and an old one is updated', async () => {
  const w = await makeWorld();
  await w.go();
  const calls = w.calls.length;
  const again = await w.go();
  assert.deepEqual([w.calls.length, again.counts.fresh, again.fetched, again.state], [calls, 6, 0, 'done']);
  w.clock.now += FRESH_SECONDS + 1;
  const stale = await w.go();
  assert.deepEqual([stale.counts.updated, stale.counts.adopted, w.calls.length], [6, 0, calls + 6]);
});

test('the preview counts what would be fetched', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  assert.equal((await summarize(w.db, plan, w.clock.now)).to_fetch, 6);
  await w.go('collection', 'c1');
  assert.deepEqual(await summarize(w.db, plan, w.clock.now), { total: 6, fresh: 4, to_fetch: 2, eta_seconds: Math.trunc(2 * SECONDS_PER_RECIPE) });
});

// ---- failures ----

test('a recipe without values is skipped and listed, and the run goes on', async () => {
  const w = await makeWorld();
  w.reject = new Set([w.ids[1]!]);
  const r = await w.go();
  assert.deepEqual([r.state, r.counts.no_nutrition, r.counts.adopted, r.done], ['done', 1, 5, 6]);
  assert.deepEqual([r.failures[0]!.id, r.failures[0]!.kind], [w.ids[1], 'no_nutrition']);
  assert.equal(await w.food(w.ids[1]!), undefined);
});

test('a single failing recipe is listed and the run goes on; three in a row stop it', async () => {
  const w = await makeWorld();
  w.fail = { [w.ids[2]!]: 'unexpected' };
  const r = await w.go();
  assert.deepEqual([r.state, r.counts.failed, r.counts.adopted, r.failures[0]!.kind], ['done', 1, 5, 'unexpected']);
  const v = await makeWorld();
  v.fail = Object.fromEntries(v.ids.slice(0, 4).map((i) => [i, 'unavailable']));
  const s = await v.go();
  assert.deepEqual([s.state, s.error, s.counts.failed, v.calls.length], ['error', 'unavailable', MAX_STREAK, MAX_STREAK]);
});

test('a refused sign-in stops at once without a retry, and the hub brakes the account', async () => {
  const w = await makeWorld();
  w.fail = Object.fromEntries(w.ids.map((i) => [i, 'auth']));
  const r = await w.go();
  assert.deepEqual([r.state, r.error, w.calls.length, r.done], ['error', 'auth', 1, 0]);
  assert.ok(r.view().error!.includes('sign-in failed'));
  const again = await w.go();
  assert.deepEqual([again.state, again.error, w.calls.length], ['error', 'auth', 1]);
});

for (const kind of ['busy', 'wait', 'locked', 'gone']) {
  test(`the brake "${kind}" stops the run at once`, async () => {
    const w = await makeWorld();
    w.hub.recipeFetched = async () => { throw new CookidooError(kind); };
    const r = await w.go();
    assert.deepEqual([r.state, r.error, r.done], ['error', kind, 0]);
  });
}

test('bulk calls have a budget of their own', async () => {
  const w = await makeWorld();
  const a = access();
  const plan = await makePlan(w.hub, a, 'all', null); // the lists come from the interactive budget, so before it is used up
  for (let i = 0; i < CALL_LIMIT[0] - 2; i++) await w.hub.recipe(a, `r${300000 + i}`);
  assert.equal(await kindOf(w.hub.recipe(a, 'r399999')), 'busy');
  const r = await w.runs.start(a, plan, null); // the run is not locked out by that
  await r.task;
  assert.equal(r.counts.adopted, 6);
  w.clock.now += 301; // and a run does not use up the interactive budget
  for (let i = 0; i < CALL_LIMIT[0]; i++) await w.hub.recipe(a, `r${400000 + i}`);
});

test('the bulk budget is a guard against a hurried run', async () => {
  const w = await makeWorld();
  const a = access();
  for (let i = 0; i < BULK_CALL_LIMIT[0]; i++) await w.hub.recipeFetched(a, `r${500000 + i}`, { bulk: true });
  assert.equal(await kindOf(w.hub.recipeFetched(a, 'r599999', { bulk: true })), 'busy');
});

// ---- cancel, one run per account, switches ----

test('cancel stops before the next call and keeps what was saved; starting again continues', async () => {
  const w = await makeWorld();
  const seen: string[] = [];
  w.onCall = (rid) => { seen.push(rid); if (seen.length === 2) w.runs.cancel('shared'); };
  const r = await w.go();
  assert.deepEqual([r.state, r.reason, w.calls.length], ['cancelled', 'user', 2]);
  assert.ok((await w.food(w.ids[0]!)) && (await w.food(w.ids[1]!)) && (await w.food(w.ids[2]!)) === undefined);
  assert.equal(r.view().reason, 'cancelled');
  w.onCall = null;
  const resumed = await w.go();
  assert.deepEqual([resumed.counts.fresh, resumed.counts.adopted], [2, 4]);
});

test('cancel while waiting for the turn stops without another call', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  const original = (w.runs as any).sleep;
  (w.runs as any).sleep = async (s: number) => { w.runs.cancel('shared'); await original(s); };
  const r = await w.runs.start(access(), plan, null);
  await r.task;
  assert.deepEqual([r.state, w.calls.length], ['cancelled', 1]); // the first call needed no wait
});

test('one run per account and two on the server', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  const first = await w.runs.start(access(), plan, null);
  assert.equal(await kindOf(w.runs.start(access(), plan, null)), 'running');
  const second = await w.runs.start(access('user:1'), plan, null);
  assert.equal(await kindOf(w.runs.start(access('user:2'), plan, null)), 'busy');
  await first.task; await second.task;
  await (await w.runs.start(access('user:2'), plan, null)).task; // a place is free again
  await (await w.runs.start(access(), plan, null)).task;
});

test('two starts at the same moment make one run', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  const [a, b] = await Promise.allSettled([w.runs.start(access(), plan, null), w.runs.start(access(), plan, null)]);
  assert.deepEqual([a.status, b.status], ['fulfilled', 'rejected']);
  await (a as PromiseFulfilledResult<any>).value.task;
});

test('the state of a run is taken before its first step, and stays for a while after the end', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  const r = await w.runs.start(access(), plan, null);
  assert.deepEqual([r.view().state, r.view().done, r.view().fetched, r.view().current], ['running', 0, 0, null]);
  await r.task;
  assert.equal(w.runs.get('shared'), r);
  assert.ok(r.view().state === 'done' && r.view().finished_at !== null);
  w.clock.now += KEEP_FINISHED + 1;
  assert.equal(w.runs.get('shared'), undefined);
});

for (const [how, reason] of [['forget', 'account'], ['off', 'off'], ['change', 'account']] as const) {
  test(`${how} ends the run (${reason})`, async () => {
    const w = await makeWorld();
    w.onCall = (rid) => {
      if (rid !== w.ids[1]) return;
      if (how === 'off') w.enabled = false;
      else if (how === 'forget') void w.hub.forget('shared');
      else (w.hub as any).accounts.get('shared').gen += 1;
    };
    const r = await w.go();
    assert.deepEqual([r.state, r.reason], ['cancelled', reason]);
    assert.ok(w.calls.length <= 3);
    assert.equal(await w.food(w.ids[5]!), undefined);
  });
}

test('forget cancels a run at once; shutdown ends every run', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  const r = await w.runs.start(access(), plan, null);
  await w.hub.forget('shared');
  await r.task;
  assert.deepEqual([r.state, r.reason], ['cancelled', 'account']);
  const v = await makeWorld();
  const run = await v.runs.start(access(), await makePlan(v.hub, access(), 'all', null), null);
  await v.runs.shutdown();
  assert.equal(run.state, 'cancelled');
});

test('the hook of the host: switching off ends runs; no pictures ends only a catch-up; no own accounts ends own runs', async () => {
  const w = await makeWorld();
  const plan = await makePlan(w.hub, access(), 'all', null);
  const own = await w.runs.start(access('user:1'), plan, null);
  const shared = await w.runs.start(access(), plan, null);
  w.runs.cancelOwnRuns();
  assert.ok(own.cancelFlag && !shared.cancelFlag && own.reason === 'account');
  w.runs.cancelPictureRuns();
  assert.ok(!shared.cancelFlag); // a run that takes recipes over goes on without pictures
  w.runs.cancelAll('off');
  assert.ok(shared.cancelFlag && shared.reason === 'off');
  await own.task; await shared.task;
});

// ---- groups ----

test('a collection run makes a group named like the collection', async () => {
  const w = await makeWorld();
  const r = await w.go('collection', 'c1');
  const groups = await w.names();
  assert.deepEqual(Object.keys(groups), ['Favourites']);
  assert.deepEqual([r.groups, groups.Favourites!.source, groups.Favourites!.food_ids.length], [['Favourites'], 'cookidoo:c1', 4]);
});

test('"all" makes a group per collection and a recipe can be in two; the week makes none', async () => {
  const w = await makeWorld();
  await w.go();
  const groups = await w.names();
  assert.deepEqual(new Set(Object.keys(groups)), new Set(['Favourites', 'Quick dinners']));
  assert.equal(groups['Quick dinners']!.food_ids.length, 4);
  const both = (await w.food(w.ids[2]!))!.id;
  assert.ok(groups.Favourites!.food_ids.includes(both) && groups['Quick dinners']!.food_ids.includes(both));
  const v = await makeWorld();
  await v.go('week');
  assert.deepEqual(await listGroups(v.db), []);
});

test('a renamed group is respected and a removed member does not come back', async () => {
  const w = await makeWorld();
  await w.go('collection', 'c1');
  const group = (await w.names()).Favourites!;
  await renameGroup(w.db, group.id, 'My favourites');
  const gone = (await w.food(w.ids[0]!))!.id;
  await removeFromGroup(w.db, group.id, [gone]);
  const r = await w.go('collection', 'c1');
  const groups = await w.names();
  assert.deepEqual([Object.keys(groups), r.groups], [['My favourites'], ['My favourites']]);
  assert.ok(!groups['My favourites']!.food_ids.includes(gone));
  assert.equal(groups['My favourites']!.food_ids.length, 3);
});

test('a deleted group does not come back unasked but does on request', async () => {
  const w = await makeWorld();
  await w.go('collection', 'c1');
  await deleteGroup(w.db, (await w.names()).Favourites!.id);
  assert.ok(await sourceDismissed(w.db, 'cookidoo:c1'));
  const r = await w.go('collection', 'c1');
  assert.deepEqual([await listGroups(w.db), r.groups, r.counts.fresh], [[], [], 4]);
  await w.go('collection', 'c1', 'shared', true);
  const groups = await w.names();
  assert.deepEqual([Object.keys(groups), groups.Favourites!.food_ids.length], [['Favourites'], 4]); // a new group is filled completely
  assert.ok(!(await sourceDismissed(w.db, 'cookidoo:c1')));
});

test('a group with the same name is not taken over and not merged', async () => {
  const w = await makeWorld();
  const mine = await createGroup(w.db, 'Favourites', 1);
  await w.go('collection', 'c1');
  const groups = await w.names();
  assert.deepEqual(new Set(Object.keys(groups)), new Set(['Favourites', 'Favourites (Cookidoo)']));
  assert.deepEqual([groups.Favourites!.id, groups.Favourites!.food_ids, groups['Favourites (Cookidoo)']!.food_ids.length], [mine.id, [], 4]);
});

test('a recipe already taken over joins a new group', async () => {
  const w = await makeWorld();
  await w.go('week');
  await w.go('collection', 'c1');
  const group = (await w.names()).Favourites!;
  assert.ok(group.food_ids.includes((await w.food(w.ids[0]!))!.id));
  assert.equal(group.food_ids.length, 4);
  void addToGroup;
});

// ---- pictures ----

test('with pictures on, a recipe taken over gets its picture; with pictures off nothing is fetched', async () => {
  const w = await makeWorld();
  await w.go('week');
  assert.equal(w.images!.stored.length, 0);
  const v = await makeWorld();
  v.imagesOn = true;
  const r = await v.go('week');
  assert.deepEqual([r.counts.pictures, v.images!.stored.length], [2, 2]);
  assert.equal(v.images!.stored[0]![1], `https://img.example/${v.ids[5]}.jpg`);
});

test('the catch-up asks Cookidoo only where the address is not known, and is limited to one per ten minutes', async () => {
  const w = await makeWorld();
  await w.go('week'); // two recipes, no pictures (the pictures are off)
  w.imagesOn = true;
  const plan = await makeImagePlan(w.db, w.clock.now);
  assert.equal(plan.items.length, 2);
  const run = await w.runs.start(access(), plan, null);
  await run.task;
  assert.deepEqual([run.mode, run.state, run.fetched, run.counts.pictures], ['pictures', 'done', 2, 2]);
  assert.equal(await kindOf(w.runs.start(access(), plan, null)), 'wait');
  await assert.rejects(makeImagePlan(w.db, w.clock.now), (e: any) => e.kind === 'empty'); // nobody lacks a picture now
});

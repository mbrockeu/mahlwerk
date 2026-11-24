// The import of an own data export (core/dataImport.ts, routes/dataImport.ts) on the Node server with proxy sign-in: round trip to
// another server, the same file twice, file wins, ownership of shared rows, replace, refused files, demo account.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildZip } from '../core/zip.ts';
import { verdict } from '../core/demoAccount.ts';
import { unzip } from '../core/yazioStage.ts';
import { makeWorld, type Reply, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });
const world = async () => {
  const w = await makeWorld({ on: false, env: { MAHLWERK_HOUSEHOLD_GROUPS: 'eltern' } });
  worlds.push(w);
  return w;
};
const DAY = '2026-03-10';
const IMPORT = '/api/v1/me/import';

async function call(w: World, who: string, method: string, path: string, body?: Uint8Array | string, type = 'application/octet-stream', groups = 'eltern'): Promise<Reply & { bytes: Uint8Array }> {
  const res = await fetch(`http://127.0.0.1:${w.port}${path}`, { method, body: body as BodyInit | undefined,
    headers: { 'remote-user': who, 'remote-groups': groups, 'x-mahlwerk-request': '1', ...(body === undefined ? {} : { 'content-type': type }) } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers, bytes };
}
const send = (w: World, who: string, method: string, path: string, body?: unknown, groups = 'eltern') =>
  call(w, who, method, path, body === undefined ? undefined : JSON.stringify(body), 'application/json', groups);

/** One of everything for `who`. */
async function fill(w: World, who: string, groups = 'eltern') {
  const s = (m: string, p: string, b?: unknown) => send(w, who, m, p, b, groups);
  const oats = (await s('POST', '/api/v1/foods', { name: 'Oats', brand: 'Acme', per_100: { kcal: 200, protein: 10, carbs: 30, fat: 4 } })).json;
  const bar = (await s('PUT', '/api/v1/foods/barcode/4006381333931', { name: 'Bar', per_100: { kcal: 400, protein: 5, carbs: 60, fat: 15 } })).json;
  for (const day of ['2026-03-09', DAY]) {
    assert.equal((await s('POST', `/api/v1/diary/${day}/entries`, { food_id: oats.id, meal: 'lunch', amount: 50 })).status, 201);
    assert.equal((await s('POST', `/api/v1/diary/${day}/entries`, { food_id: bar.id, meal: 'snack', amount: 30 })).status, 201);
    await s('PUT', `/api/v1/weights/${day}`, { kg: 71.5, body_fat_pct: 22 });
    await s('PUT', `/api/v1/water/${day}`, { ml: 1750 });
    await s('PUT', `/api/v1/activity/${day}`, { steps: 8123 });
  }
  await s('POST', '/api/v1/workouts', { day: DAY, kind: 'running', name: 'Run', minutes: 30, kcal: 280, started_at: 1773126000 });
  await s('PUT', '/api/v1/me/goal', { kcal: 2100, protein: 110, carbs: 240, fat: 70 });
  await s('PATCH', '/api/v1/me/settings', { playful: false, fasting: { enabled: true, target_hours: 18 } });
  await s('POST', '/api/v1/templates', { name: 'Usual lunch', from: { day: DAY, meal: 'lunch' } });
  const recipe = (await s('POST', '/api/v1/recipes', { name: `Porridge ${who}`, portions: 2, items: [{ food_id: oats.id, amount: 80 }] })).json;
  const group = (await s('POST', '/api/v1/recipe-groups', { name: `Breakfast ${who}` })).json;
  await s('POST', `/api/v1/recipe-groups/${group.id}/members`, { food_ids: [recipe.food.id] });
  await s('POST', '/api/v1/fasting/start', { started_at: 1773000000, target_hours: 16 });
  await s('POST', '/api/v1/fasting/stop', { ended_at: 1773050000 });
  return { oats, bar, recipe, group };
}

const exportZip = async (w: World, who: string, query = '', groups = 'eltern') => {
  const r = await call(w, who, 'GET', `/api/v1/me/export${query}`, undefined, undefined, groups);
  assert.equal(r.status, 200, r.text);
  return r.bytes;
};
const jsonOf = async (zip: Uint8Array) => JSON.parse(new TextDecoder().decode((await unzip(zip, ['mahlwerk-export.json']))['mahlwerk-export.json']));
const comparable = (data: any) => { const { exported_at: _e, account: _a, app_version: _v, ...rest } = data; return rest; };
const preview = (w: World, who: string, body: Uint8Array | string, groups = 'eltern') => call(w, who, 'POST', `${IMPORT}/preview`, body, undefined, groups);
const confirm = (w: World, who: string, token: string, mode = 'merge', groups = 'eltern') => send(w, who, 'POST', `${IMPORT}/confirm`, { token, mode }, groups);
const sum = (counts: any, what: 'new' | 'changed' | 'unchanged' | 'skipped') => Object.values(counts).reduce((n: number, c: any) => n + c[what], 0);

test('export A, import into an empty account on another server, export there: the same data', async () => {
  const one = await world(), two = await world();
  await fill(one, 'ann');
  const zip = await exportZip(one, 'ann');
  const p = await preview(two, 'anna', zip);
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.mode_allowed, ['merge', 'replace']);
  const merge = p.json.modes.merge.counts;
  assert.equal(merge.diary.new, 4);
  assert.equal(merge.foods.new, 2);
  assert.equal(merge.recipes.new, 1);
  assert.equal(merge.recipe_groups.new, 1);
  assert.equal(sum(merge, 'changed'), 0);
  assert.equal(p.json.same_account, false);
  const c = await confirm(two, 'anna', p.json.token);
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json.counts, merge);
  assert.deepEqual(comparable(await jsonOf(await exportZip(two, 'anna'))), comparable(await jsonOf(zip)));
  // the links work: the entry points at the imported product, the group holds the imported recipe
  const day = (await send(two, 'anna', 'GET', `/api/v1/diary/${DAY}`)).json;
  const foodId = day.meals.lunch.entries[0].food_id;
  assert.equal((await send(two, 'anna', 'GET', `/api/v1/foods/${foodId}`)).json.name, 'Oats');
  const groups = (await send(two, 'anna', 'GET', '/api/v1/recipe-groups')).json;
  const recipes = (await send(two, 'anna', 'GET', '/api/v1/recipes')).json;
  assert.deepEqual(groups[0].food_ids, [recipes[0].food.id]);
  // the waiting file is gone after the import
  assert.equal((await confirm(two, 'anna', p.json.token)).status, 410);
});

test('the same file twice: the second preview finds nothing new and nothing changed', async () => {
  const one = await world(), two = await world();
  await fill(one, 'ann');
  const zip = await exportZip(one, 'ann');
  const first = await preview(two, 'ann', zip);
  assert.equal((await confirm(two, 'ann', first.json.token)).status, 200);
  const again = await preview(two, 'ann', zip);
  assert.equal(sum(again.json.modes.merge.counts, 'new'), 0);
  assert.equal(sum(again.json.modes.merge.counts, 'changed'), 0);
  assert.ok(sum(again.json.modes.merge.counts, 'unchanged') > 10);
  // and into the account it came from
  const back = await preview(one, 'ann', zip);
  assert.equal(sum(back.json.modes.merge.counts, 'new') + sum(back.json.modes.merge.counts, 'changed'), 0);
});

test('a row changed in the file is counted as changed and the file wins; rows only here stay', async () => {
  const w = await world();
  await fill(w, 'ann');
  const data = await jsonOf(await exportZip(w, 'ann'));
  await send(w, 'ann', 'PUT', '/api/v1/weights/2026-03-01', { kg: 80 }); // only here
  data.diary[0].amount = 99;
  data.weight[0].kg = 70;
  data.templates[0].name = 'Renamed';
  data.goal_history[0].kcal = 1800;
  data.goal.kcal = 1800;
  const p = await preview(w, 'ann', JSON.stringify(data));
  assert.equal(p.status, 200, p.text);
  const m = p.json.modes.merge.counts;
  assert.deepEqual([m.diary.changed, m.weight.changed, m.templates.changed, m.goal.changed, m.goal_history.changed], [1, 1, 1, 1, 1]);
  assert.equal(m.diary.new + m.weight.new, 0);
  assert.equal((await confirm(w, 'ann', p.json.token)).status, 200);
  const day = (await send(w, 'ann', 'GET', '/api/v1/diary/2026-03-09')).json;
  assert.equal(day.meals.lunch.entries[0].amount, 99);
  assert.equal((await send(w, 'ann', 'GET', '/api/v1/me')).json.goal.kcal, 1800);
  const weights = (await jsonOf(await exportZip(w, 'ann'))).weight;
  assert.deepEqual(weights.map((x: any) => [x.day, x.kg]), [['2026-03-01', 80], ['2026-03-09', 70], [DAY, 71.5]]); // merge deletes nothing
  assert.equal((await send(w, 'ann', 'GET', '/api/v1/templates')).json[0].name, 'Renamed');
});

test('shared rows: a guest\'s file never changes what the household owns, and nobody touches the rows of another person', async () => {
  const w = await world();
  const ann = await fill(w, 'ann');
  const guestFile = await jsonOf(await exportZip(w, 'gast', '', ''));
  // the guest's file names the household's bar (same barcode) and the household's recipe, both with other values
  const annFile = await jsonOf(await exportZip(w, 'ann'));
  const bar = annFile.foods.find((f: any) => f.code === '4006381333931');
  const recipe = annFile.recipes[0];
  const file = { ...guestFile, foods: [{ ...bar, data: { ...bar.data, name: 'Hacked bar' } }], recipes: [{ ...recipe, portions: 9 }],
    recipe_groups: [{ ...annFile.recipe_groups[0], name: 'Hacked group' }] };
  const p = await preview(w, 'gast', JSON.stringify(file), '');
  assert.equal(p.status, 200, p.text);
  const m = p.json.modes.merge.counts;
  assert.deepEqual([m.foods.skipped, m.recipes.skipped, m.recipe_groups.skipped], [1, 1, 1]);
  assert.deepEqual(m.foods.reasons, { not_editable: 1 });
  assert.equal((await confirm(w, 'gast', p.json.token, 'merge', '')).status, 200);
  assert.equal((await send(w, 'ann', 'GET', `/api/v1/foods/${ann.bar.id}`)).json.name, 'Bar');
  assert.equal((await send(w, 'ann', 'GET', `/api/v1/recipes/${ann.recipe.id}`)).json.portions, 2);
  assert.equal((await send(w, 'ann', 'GET', '/api/v1/recipe-groups')).json[0].name, 'Breakfast ann');
  // a household member's file may change the household's product (the normal edit rules)
  const own = await preview(w, 'ben', JSON.stringify({ ...guestFile, foods: [{ ...bar, data: { ...bar.data, name: 'Better bar' } }] }));
  assert.deepEqual(own.json.modes.merge.counts.foods, { new: 0, changed: 1, unchanged: 0, skipped: 0, reasons: {} });
  // ann's own per-user rows: ben's import of ann's file makes copies for ben, ann's stay untouched
  const before = (await send(w, 'ann', 'GET', `/api/v1/diary/${DAY}`)).text;
  const b = await preview(w, 'ben', await exportZip(w, 'ann'));
  assert.equal(b.json.modes.merge.counts.diary.new, 4);
  assert.equal((await confirm(w, 'ben', b.json.token)).status, 200);
  assert.equal((await send(w, 'ann', 'GET', `/api/v1/diary/${DAY}`)).text, before);
  assert.equal((await send(w, 'ben', 'GET', `/api/v1/diary/${DAY}`)).json.meals.lunch.entries.length, 1);
});

test('replace deletes only the caller\'s own rows; a file of a period is refused for replace', async () => {
  const w = await world();
  await fill(w, 'ann');
  await fill(w, 'ben');
  const foodsBefore = (await send(w, 'ann', 'GET', '/api/v1/foods')).json.length;
  const benBefore = (await send(w, 'ben', 'GET', `/api/v1/diary/${DAY}`)).text;
  const file = await jsonOf(await exportZip(w, 'ann'));
  await send(w, 'ann', 'PUT', '/api/v1/weights/2026-03-01', { kg: 80 }); // goes with replace
  const p = await preview(w, 'ann', JSON.stringify({ ...file, diary: file.diary.slice(0, 1) }));
  assert.equal(p.json.modes.replace.deleted.diary, 4);
  assert.equal(p.json.modes.replace.deleted.weight, 3);
  assert.equal(p.json.modes.replace.counts.diary.new, 1);
  const c = await confirm(w, 'ann', p.json.token, 'replace');
  assert.equal(c.status, 200, c.text);
  const after = await jsonOf(await exportZip(w, 'ann'));
  assert.equal(after.diary.length, 1);
  assert.deepEqual(after.weight.map((x: any) => x.day), ['2026-03-09', DAY]);
  assert.equal((await send(w, 'ben', 'GET', `/api/v1/diary/${DAY}`)).text, benBefore);
  assert.equal((await send(w, 'ann', 'GET', '/api/v1/foods')).json.length, foodsBefore); // shared rows stay
  assert.equal((await send(w, 'ann', 'GET', '/api/v1/recipes')).json.length, 2);
  // a file of a period: merge yes, replace no
  const ranged = await preview(w, 'ann', await exportZip(w, 'ann', `?from=${DAY}&to=${DAY}`));
  assert.deepEqual(ranged.json.mode_allowed, ['merge']);
  assert.equal(ranged.json.modes.replace.reason, 'ranged');
  const refused = await confirm(w, 'ann', ranged.json.token, 'replace');
  assert.equal(refused.status, 409);
  assert.match(refused.json.detail, /period/);
});

test('format 1 (no ids): replace, or merge only into an account without data', async () => {
  const w = await world();
  await fill(w, 'ann');
  const v2 = await jsonOf(await exportZip(w, 'ann'));
  const strip = (rows: any[]) => rows.map(({ uid: _u, food_uid: _f, food_code: _c, external_id: _x, ...rest }) => ({ ...rest, ...(rest.items ? { items: strip(rest.items) } : {}) }));
  const v1 = { ...v2, format_version: 1, diary: strip(v2.diary), workouts: strip(v2.workouts), fasting: strip(v2.fasting), templates: strip(v2.templates), recipes: strip(v2.recipes) };
  delete v1.foods; delete v1.recipe_groups;
  const here = await preview(w, 'ann', JSON.stringify(v1));
  assert.equal(here.status, 200, here.text);
  assert.deepEqual(here.json.mode_allowed, ['replace']);
  assert.equal(here.json.modes.merge.reason, 'old_format');
  assert.equal((await confirm(w, 'ann', here.json.token, 'merge')).status, 409);
  const empty = await preview(w, 'cleo', JSON.stringify(v1));
  assert.deepEqual(empty.json.mode_allowed, ['merge', 'replace']);
  assert.equal((await confirm(w, 'cleo', empty.json.token)).status, 200);
  assert.equal((await jsonOf(await exportZip(w, 'cleo'))).diary.length, 4);
});

test('refused: not an export, unknown format, a key twice, too large, a ZIP bomb, the wrong token, the demo account', async () => {
  const w = await world();
  await fill(w, 'ann');
  const data = await jsonOf(await exportZip(w, 'ann'));
  const status = async (body: Uint8Array | string) => (await preview(w, 'ann', body)).status;
  assert.equal(await status('not json'), 422);
  assert.equal(await status('{"hello": 1}'), 422);
  assert.equal(await status('[1, 2]'), 422);
  assert.equal(await status(''), 422);
  const future = await preview(w, 'ann', JSON.stringify({ ...data, format_version: 99 }));
  assert.equal(future.status, 422);
  assert.match(future.json.detail, /format 99/);
  assert.equal(await status(JSON.stringify({ ...data, diary: [data.diary[0], data.diary[0]] })), 422);
  assert.equal(await status(JSON.stringify({ ...data, diary: [{ ...data.diary[0], amount: 'lots' }] })), 422);
  assert.equal(await status(JSON.stringify({ ...data, diary: [{ ...data.diary[0], uid: 'x' }] })), 422);
  assert.equal(await status(JSON.stringify({ ...data, weight: [{ day: '2026-02-30', kg: 70 }] })), 422);
  assert.equal(await status(await buildZip([['other.json', new TextEncoder().encode('{}')]], new Date())), 422);
  // larger than the body limit as sent
  assert.equal(await status(new Uint8Array(33 * 1024 * 1024).fill(0x20)), 413);
  // packed far too densely (40 MB of blanks in a few kB)
  const bomb = await buildZip([['mahlwerk-export.json', new Uint8Array(40 * 1024 * 1024).fill(0x20)]], new Date());
  assert.ok(bomb.length < 200_000);
  const b = await preview(w, 'ann', bomb);
  assert.equal(b.status, 413);
  assert.match(b.json.detail, /densely/);
  // nothing waits after refusals; a good file waits until a confirmation names its token
  assert.equal((await confirm(w, 'ann', 'nope')).status, 410);
  const p = await preview(w, 'ann', JSON.stringify(data));
  assert.equal((await confirm(w, 'ann', 'wrong-token')).status, 409);
  assert.equal((await send(w, 'ann', 'POST', `${IMPORT}/confirm`, { token: p.json.token, mode: 'all' })).status, 422);
  assert.equal((await confirm(w, 'ben', p.json.token)).status, 410); // another person's file is not theirs to import
  assert.equal((await send(w, 'ann', 'DELETE', `${IMPORT}/staged`)).status, 204);
  assert.equal((await confirm(w, 'ann', p.json.token)).status, 410);
  // the demo account: closed; the flag tells the interface
  for (const [m, path] of [['POST', '/api/v1/me/import/preview'], ['POST', '/api/v1/me/import/confirm'], ['DELETE', '/api/v1/me/import/staged']]) {
    assert.equal(verdict(m!, path!), 'blocked');
  }
  assert.equal((await send(w, 'ann', 'GET', '/api/v1/me')).json.features.data_import, true);
});

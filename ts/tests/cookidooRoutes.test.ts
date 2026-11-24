// The routes of the connector on a real app with the stand-in client (test_cookidoo.py, test_cookidoo_accounts.py, API tests).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { MESSAGES } from '../core/cookidoo.ts';
import { installCookidoo } from '../core/cookidooService.ts';
import { FakeClient, LENTILS, entry, makeWorld, type World } from './cookidooHarness.ts';

const ADMIN_MAIL = 'household@example.invalid', ANN_MAIL = 'ann.private@example.invalid', BEN_MAIL = 'ben.private@example.invalid';
const ADMIN_PW = 'household-pw-0001', ANN_PW = 'ann-private-pw-0002', BEN_PW = 'ben-private-pw-0003';
const SECRETS = [ADMIN_MAIL, ANN_MAIL, BEN_MAIL, ADMIN_PW, ANN_PW, BEN_PW, 'guess-number'];
const body = (email: string, password: string, extra: object = {}) => ({ email, password, ...extra });
const DAY = '2026-01-10';

const worlds: World[] = [];
const world = async (opts?: Parameters<typeof makeWorld>[0]) => { const w = await makeWorld(opts); worlds.push(w); return w; };
after(async () => { for (const w of worlds) await w.close(); });
const card = async (w: World) => (await w.admin.get('/api/v1/admin/connectors')).json.find((c: any) => c.key === 'cookidoo');
const userId = async (w: World, name: string): Promise<number> => (await w.ctx.db.get('SELECT id FROM user WHERE username = ?', [name]))!.id;

test('off by default: every route says 404 "switched off"', async () => {
  const w = await world({ on: false });
  const c = await card(w);
  assert.ok(c.enabled === false && c.configurable === true && c.locked.length === 0);
  assert.equal((await w.admin.get('/api/v1/me')).json.features.cookidoo, false);
  for (const url of ['/week', '/collections', '/recipe?ref=r100001']) {
    const r = await w.admin.get('/api/v1/cookidoo' + url);
    assert.ok(r.status === 404 && r.json.detail.includes('switched off'), url);
  }
  assert.equal((await w.admin.post('/api/v1/cookidoo/adopt', { recipe: 'r100001' })).status, 404);
  assert.equal((await w.admin.get('/api/v1/cookidoo/images/preview')).status, 404);
  assert.equal((await w.admin.post('/api/v1/me/cookidoo-account/check')).status, 404);
  assert.equal((await w.admin.post('/api/v1/admin/cookidoo/account/check')).status, 404);
  assert.equal((await w.admin.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW))).status, 404);
  assert.equal(w.built.length, 0);
});

test('the environment can fix the switch', async () => {
  const w = await world({ on: false, env: { MAHLWERK_COOKIDOO: '0' } });
  assert.deepEqual((await card(w)).locked, ['enabled']);
  assert.equal((await w.admin.patch('/api/v1/admin/connectors/cookidoo', { enabled: true })).status, 409);
});

test('switched on without credentials: not configured, 409', async () => {
  const w = await world();
  const c = await card(w);
  assert.equal(c.status, 'not_configured');
  const r = await w.admin.get('/api/v1/cookidoo/week');
  assert.ok(r.status === 409 && r.json.detail.includes('not configured'));
  assert.equal((await w.admin.get('/api/v1/cookidoo/status')).json.state, 'not_configured');
});

test('the admin stores the shared account and nothing comes back; it is encrypted in the database', async () => {
  const w = await world();
  const r = await w.admin.put('/api/v1/admin/cookidoo/account', body(ADMIN_MAIL, ADMIN_PW, { country: 'at', language: 'de-AT' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.source, r.json.email, r.json.editable, r.json.country, r.json.language, r.json.key], ['stored', 'h***@example.invalid', true, 'at', 'de-AT', 'file']);
  for (const url of ['/api/v1/admin/cookidoo/account', '/api/v1/admin/connectors', '/api/v1/cookidoo/status', '/api/v1/me/cookidoo-account']) {
    const text = (await w.admin.get(url)).text;
    assert.ok(!text.includes(ADMIN_PW) && !text.includes(ADMIN_MAIL), url);
  }
  const c = await card(w);
  assert.equal(c.info.account.email, 'h***@example.invalid');
  assert.equal(c.status, 'ready');
  const raw = readFileSync(w.ctx.db ? (await w.ctx.db.get("SELECT file FROM pragma_database_list WHERE name = 'main'"))!.file : '').toString('latin1');
  assert.ok(!raw.includes(ADMIN_PW) && !raw.includes(ADMIN_MAIL));
});

test('only admins reach the shared account endpoints; validation errors never echo the input', async () => {
  const w = await world();
  assert.equal((await w.ann.get('/api/v1/admin/cookidoo/account')).status, 403);
  assert.equal((await w.ann.put('/api/v1/admin/cookidoo/account', body(ANN_MAIL, ANN_PW))).status, 403);
  const bad = await w.admin.put('/api/v1/admin/cookidoo/account', { email: ADMIN_MAIL, password: ADMIN_PW, country: 'Germany' });
  assert.equal(bad.status, 422);
  assert.ok(!bad.text.includes(ADMIN_PW) && !bad.text.includes(ADMIN_MAIL));
  const bad2 = await w.admin.put('/api/v1/admin/cookidoo/account', { email: ADMIN_MAIL, password: { secret: ADMIN_PW } });
  assert.equal(bad2.status, 422);
  assert.ok(!bad2.text.includes(ADMIN_PW));
  assert.equal((await w.admin.put('/api/v1/admin/cookidoo/account', body('', ''))).status, 422);
});

test('everybody without an own account uses the shared one; own accounts never mix', async () => {
  const w = await world();
  await w.admin.put('/api/v1/admin/cookidoo/account', body(ADMIN_MAIL, ADMIN_PW));
  const title = async (who: typeof w.ann) => (await who.get('/api/v1/cookidoo/week')).json[0].title;
  assert.equal(await title(w.ann), ADMIN_MAIL);
  assert.equal(await title(w.ben), ADMIN_MAIL);
  assert.equal(w.built.length, 1); // one sign-in, one client for the household
  await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW));
  await w.ben.put('/api/v1/me/cookidoo-account', body(BEN_MAIL, BEN_PW));
  assert.equal(await title(w.ann), ANN_MAIL);
  assert.equal(await title(w.ben), BEN_MAIL);
  assert.equal(await title(w.admin), ADMIN_MAIL);
  assert.equal((await w.ann.get('/api/v1/me/cookidoo-account')).json.email, 'a***@example.invalid');
  // taken over from an own account: the food belongs to the household
  const food = (await w.ann.post('/api/v1/cookidoo/adopt', { recipe: 'r100001' }));
  assert.equal(food.status, 200);
  assert.equal((await w.ben.get(`/api/v1/foods/${food.json.id}`)).json.can_edit, true);
  // removing an own account closes its client and falls back to the shared one
  const ann = w.built.find((c) => c.settings.email === ANN_MAIL)!;
  assert.equal((await w.ann.delete('/api/v1/me/cookidoo-account')).json.source, 'none');
  assert.equal(ann.closed, true);
  assert.equal(await title(w.ann), ADMIN_MAIL);
});

test('the environment wins and cannot be changed', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  const r = (await w.admin.get('/api/v1/admin/cookidoo/account')).json;
  assert.deepEqual([r.source, r.editable, r.email], ['env', false, 'e***@example.invalid']);
  assert.equal((await w.admin.put('/api/v1/admin/cookidoo/account', body(ADMIN_MAIL, ADMIN_PW))).status, 409);
  assert.equal((await w.admin.delete('/api/v1/admin/cookidoo/account')).status, 409);
  assert.equal((await w.admin.get('/api/v1/cookidoo/week')).status, 200);
  assert.ok(!(await w.admin.get('/api/v1/admin/connectors')).text.includes('env-pw-not-real'));
});

test('the admin can forbid own accounts', async () => {
  const w = await world();
  await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW));
  assert.equal((await w.admin.patch('/api/v1/admin/connectors/cookidoo', { config: { personal: false } })).status, 200);
  const mine = (await w.ann.get('/api/v1/me/cookidoo-account')).json;
  assert.deepEqual([mine.allowed, mine.editable], [false, false]);
  assert.equal((await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW))).status, 403);
  assert.equal((await w.ann.post('/api/v1/me/cookidoo-account/check')).status, 403);
  assert.equal((await w.ann.get('/api/v1/cookidoo/status')).json.personal_allowed, false);
});

test('a guest never gets the household account', async () => {
  const w = await world({ env: { MAHLWERK_HOUSEHOLD_GROUPS: 'family', MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  const guest = w.who('gast');
  const r = await guest.get('/api/v1/cookidoo/week');
  assert.ok(r.status === 409 && r.json.detail.includes('guests'), r.text);
  assert.equal((await guest.post('/api/v1/cookidoo/import', { scope: 'week' })).status, 403); // the household only
  assert.equal((await w.who('mama', 'family').get('/api/v1/cookidoo/week')).status, 200);
});

test('an access token can neither use the connector nor read, set or check credentials', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  const token = (await w.admin.post('/api/v1/me/tokens', { name: 't', scope: 'write' })).json.token as string;
  const via = async (method: string, path: string, b?: unknown) => (await fetch(`http://127.0.0.1:${w.port}${path}`, { method, body: b ? JSON.stringify(b) : undefined,
    headers: { authorization: `Bearer ${token}`, ...(b ? { 'content-type': 'application/json' } : {}) } })).status;
  for (const [method, path, b] of [['GET', '/api/v1/cookidoo/week'], ['GET', '/api/v1/cookidoo/status'], ['POST', '/api/v1/cookidoo/adopt', { recipe: 'r100001' }],
    ['GET', '/api/v1/admin/cookidoo/account'], ['PUT', '/api/v1/admin/cookidoo/account', { email: 'a@b.invalid', password: 'x' }],
    ['GET', '/api/v1/me/cookidoo-account'], ['PUT', '/api/v1/me/cookidoo-account', { email: 'a@b.invalid', password: 'x' }], ['DELETE', '/api/v1/me/cookidoo-account'],
    ['POST', '/api/v1/me/cookidoo-account/check'], ['POST', '/api/v1/admin/cookidoo/account/check'], ['POST', '/api/v1/cookidoo/import', { scope: 'week' }]] as [string, string, object?][]) {
    assert.equal(await via(method, path, b), 403, `${method} ${path}`);
  }
  assert.equal(w.built.length, 0);
});

test('check signs in once and is braked; a failed check blocks, new credentials get one try after the gap', async () => {
  const w = await world();
  await w.admin.put('/api/v1/admin/cookidoo/account', body(ADMIN_MAIL, ADMIN_PW));
  assert.deepEqual((await w.admin.post('/api/v1/admin/cookidoo/account/check')).json, { ok: true });
  assert.equal((await w.admin.post('/api/v1/admin/cookidoo/account/check')).status, 429);
  assert.equal((await w.admin.post('/api/v1/me/cookidoo-account/check')).status, 409); // no own account stored
  assert.equal(w.built.length, 1);
});

test('changing the account does not buy new sign-in attempts (5 refusals an hour per person)', async () => {
  const w = await world();
  const refuse = () => { (w.ctx.services as any).cookidooFactory = (s: any) => { const c = new FakeClient(s); c.fail = 'auth'; w.built.push(c); return c; }; };
  refuse();
  for (let n = 0; n < 5; n++) {
    assert.equal((await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, `guess-number-${String(n).padStart(4, '0')}`))).status, 200);
    w.clock.now += 31;
    assert.equal((await w.ann.post('/api/v1/me/cookidoo-account/check')).status, 502);
  }
  assert.equal(w.built.length, 5);
  for (let i = 0; i < 3; i++) { // a sixth, seventh ... try: changed again, removed and added again, a plain request
    await w.ann.delete('/api/v1/me/cookidoo-account');
    await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, 'yet-another-guess'));
    w.clock.now += 300 + 31;
    const r = await w.ann.post('/api/v1/me/cookidoo-account/check');
    assert.ok(r.status === 429 && r.json.detail.includes('refused sign-ins'), r.text);
    assert.equal((await w.ann.get('/api/v1/cookidoo/week')).status, 429);
  }
  assert.equal(w.built.length, 5); // nothing was sent to Cookidoo
  w.clock.now += 3600;
  await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW));
  (w.ctx.services as any).cookidooFactory = (s: any) => { const c = new FakeClient(s); w.built.push(c); return c; };
  assert.deepEqual((await w.ann.post('/api/v1/me/cookidoo-account/check')).json, { ok: true });
  // the count is per person: ben is not locked out
  refuse();
  for (let n = 0; n < 5; n++) { await w.admin.put('/api/v1/admin/cookidoo/account', body(ADMIN_MAIL, `guess-number-${n}`)); w.clock.now += 31; await w.admin.post('/api/v1/admin/cookidoo/account/check'); }
  (w.ctx.services as any).cookidooFactory = (s: any) => { const c = new FakeClient(s); w.built.push(c); return c; };
  await w.ben.put('/api/v1/me/cookidoo-account', body(BEN_MAIL, BEN_PW));
  assert.equal((await w.ben.get('/api/v1/cookidoo/week')).json[0].title, BEN_MAIL);
  assert.equal((await w.admin.post('/api/v1/admin/cookidoo/account/check')).status === 200, false);
});

test('preview by id and by link saves nothing; adopt books one portion as 100 g; again updates the same food', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  for (const ref of ['r100001', 'https://cookidoo.de/recipes/recipe/de-DE/r100001']) {
    const r = await w.admin.get('/api/v1/cookidoo/recipe?ref=' + encodeURIComponent(ref));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.name, r.json.portions, r.json.per_portion.kcal, r.json.extra, r.json.complete, r.json.food_id], ['Red lentil salad', 4, 497, { sodium: 1168 }, true, null]);
  }
  assert.deepEqual((await w.admin.get('/api/v1/foods?source=cookidoo')).json, []);
  const r = await w.admin.post('/api/v1/cookidoo/adopt', { recipe: 'https://cookidoo.de/recipes/recipe/de-DE/r100001' });
  assert.equal(r.status, 200, r.text);
  const food = r.json;
  assert.deepEqual([food.source, food.name, food.brand, food.serving_quantity, food.unit, food.per_100.kcal, food.extra, food.code],
    ['cookidoo', 'Red lentil salad', 'Cookidoo', 100, 'g', 497, { sodium: 1168 }, null]);
  assert.equal(food.url, 'https://cookidoo.de/recipes/recipe/de-DE/r100001');
  assert.deepEqual([food.external_id, food.portions], ['cookidoo:r100001', 4]);
  const entryR = (await w.admin.post(`/api/v1/diary/${DAY}/entries`, { food_id: food.id, meal: 'lunch', amount: 50 })).json;
  assert.deepEqual([entryR.kcal], [248.5]);
  assert.equal((await w.admin.get('/api/v1/cookidoo/recipe?ref=r100001')).json.food_id, food.id);
  // again, with other values: the same food is updated
  w.built[0]!.recipes.r100001 = { id: 'r100001', name: 'Red lentil salad v2', portions: 2, nutrition: entry({ kcal: [400, 'kcal'], fat: [10, 'g'] }) };
  w.clock.now += 601; // the recipe cache
  const second = (await w.admin.post('/api/v1/cookidoo/adopt', { recipe: 'r100001' })).json;
  assert.deepEqual([second.id, second.name, second.per_100.kcal, second.per_100.protein], [food.id, 'Red lentil salad v2', 400, null]);
  assert.equal((await w.admin.get('/api/v1/foods?source=cookidoo')).json.length, 1);
});

test('a bad reference is 422 and nothing is asked of Cookidoo', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  for (const ref of ['hello', 'https://evil.example/recipes/recipe/de-DE/r100001', 'http://169.254.169.254/']) {
    assert.equal((await w.admin.get('/api/v1/cookidoo/recipe?ref=' + encodeURIComponent(ref))).status, 422);
    assert.equal((await w.admin.post('/api/v1/cookidoo/adopt', { recipe: ref })).status, 422);
  }
  assert.equal((await w.admin.get('/api/v1/cookidoo/recipe')).status, 422); // the reference is required
  assert.equal(w.built.length, 0);
});

test('a recipe without energy is refused with a reason', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  await w.admin.get('/api/v1/cookidoo/week'); // makes the client
  w.built[0]!.recipes.r100002 = { id: 'r100002', name: 'Mystery', portions: 2, nutrition: entry({ protein: [5, 'g'] }) };
  const r = await w.admin.post('/api/v1/cookidoo/adopt', { recipe: 'r100002' });
  assert.ok(r.status === 422 && r.json.detail.includes('energy'));
  assert.deepEqual((await w.admin.get('/api/v1/foods?source=cookidoo')).json, []);
});

test('removing a taken-over recipe removes it from its groups (API test of recipe_groups)', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  const taken = (await w.admin.post('/api/v1/cookidoo/adopt', { recipe: 'r100001' })).json;
  const g = (await w.admin.post('/api/v1/recipe-groups', { name: 'A' })).json;
  await w.admin.post(`/api/v1/recipe-groups/${g.id}/members`, { food_ids: [taken.id] });
  assert.equal((await w.admin.delete(`/api/v1/foods/${taken.id}`)).status, 204);
  const groups = (await w.admin.get('/api/v1/recipe-groups')).json;
  assert.deepEqual([groups[0].food_ids, groups[0].count], [[], 0]);
});

test('a failure is a neutral 502 and shows in the card; the next success clears it; secrets are not logged', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  await w.admin.get('/api/v1/cookidoo/collections');
  w.built[0]!.fail = 'unavailable';
  const r = await w.admin.get('/api/v1/cookidoo/week');
  assert.ok(r.status === 502 && r.json.detail === MESSAGES.unavailable);
  const c = await card(w);
  assert.deepEqual([c.status, c.info.error], ['error', MESSAGES.unavailable]);
  assert.deepEqual((await w.admin.get('/api/v1/cookidoo/status')).json, { state: 'error', error: MESSAGES.unavailable, account: 'shared', personal_allowed: true });
  w.built[0]!.fail = null;
  assert.equal((await w.admin.get('/api/v1/cookidoo/week')).status, 200);
  assert.equal((await card(w)).status, 'ready');
  // an unexpected exception that mentions the secret
  w.built[0]!.fail = 'boom';
  w.clock.now += 61;
  const boom = await w.admin.get('/api/v1/cookidoo/week');
  assert.ok(boom.status === 502 && !boom.text.includes('env-pw-not-real'));
  assert.ok(!w.logs.join('\n').includes('env-pw-not-real'));
  assert.ok(!w.logs.join('\n').includes('env@example'));
});

test('limits answer 429 (busy)', async () => {
  const w = await world({ env: { MAHLWERK_COOKIDOO_EMAIL: 'env@example.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'env-pw-not-real' } });
  await w.admin.get('/api/v1/cookidoo/collections');
  w.built[0]!.recipes = new Proxy({}, { get: () => LENTILS });
  const codes: number[] = [];
  for (let i = 0; i < 35; i++) codes.push((await w.admin.get(`/api/v1/cookidoo/recipe?ref=r${200000 + i}`)).status);
  assert.deepEqual(codes.slice(0, 29), Array(29).fill(200)); // one call of the 30 went to the collections
  assert.ok(codes.slice(29).every((c) => c === 429));
});

test('the hook for a person who signed out, was blocked or lost access drops their sign-in; other listeners still run', async () => {
  const w = await world();
  await w.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW));
  await w.ben.put('/api/v1/me/cookidoo-account', body(BEN_MAIL, BEN_PW));
  await w.ann.get('/api/v1/cookidoo/week');
  await w.ben.get('/api/v1/cookidoo/week');
  const [ann, ben] = [w.built.find((c) => c.settings.email === ANN_MAIL)!, w.built.find((c) => c.settings.email === BEN_MAIL)!];
  assert.ok(!ann.closed && !ben.closed);
  // revoking the access of ann (the admin route calls the hook)
  assert.equal((await w.admin.post('/api/v1/admin/users/ann/revoke-access')).status, 200);
  assert.ok(ann.closed && !ben.closed);
  // composition: a listener installed earlier stays
  const seen: number[] = [];
  const second = await world();
  (second.ctx.services as any).userEnded = async (id: number) => { seen.push(id); };
  installCookidoo(second.ctx);
  await second.ann.put('/api/v1/me/cookidoo-account', body(ANN_MAIL, ANN_PW));
  await second.ann.get('/api/v1/cookidoo/week');
  await (second.ctx.services.userEnded as (id: number) => Promise<void>)(await userId(second, 'ann'));
  assert.deepEqual(seen, [await userId(second, 'ann')]);
  assert.ok(second.built[0]!.closed);
});

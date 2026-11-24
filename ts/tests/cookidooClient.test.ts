// The real client against a local stand-in for Cookidoo: the sign-in flow, the three calls and what goes wrong. The real service is never contacted.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Access, CookidooError, Hub, MESSAGES, Settings, nutritionFrom } from '../core/cookidoo.ts';
import { LibraryClient, normalizeHref } from '../core/cookidooClient.ts';
import { CIAM, FakeCookidoo, GOOD_MAIL, GOOD_PW, SITE, defaultRecipe } from './cookidooFake.ts';

const fake = new FakeCookidoo();
before(async () => { await fake.start(); });
after(() => fake.stop());

const settings = (pw = GOOD_PW, extra: { country?: string; language?: string } = {}) => Settings.build(GOOD_MAIL, pw, extra.country ?? 'de', extra.language ?? 'de-DE')!;
const clientFor = (pw = GOOD_PW, now: () => number = () => Date.now() / 1000, extra = {}) => { fake.seen = []; return new LibraryClient(settings(pw, extra), fake.outgoing(), now); };
const kind = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof CookidooError ? e.kind : `other:${e}`; } };
const reset = () => { Object.assign(fake, { expiresIn: 43200, rejectApi: 0, wellKnownFail: 0, badState: false, evilRedirect: false, wellKnownHref: {}, apiStatus: 200, apiContentType: 'application/json', recipe: defaultRecipe(), refresh: 'refresh-1', refreshed: 0 }); };

test('the sign-in and the recipe: PKCE, cookies across the redirects, bearer token, the shape of every request', async () => {
  reset();
  const client = clientFor();
  const r = await client.recipe('r100001');
  assert.deepEqual([r.id, r.name, r.portions], ['r100001', 'Red lentil salad', 4]);
  assert.equal(r.image, 'https://img.example/p/t_web_rdp_recipe_584x480_1_5x/x.jpg');
  assert.equal(r.nutrition.length, 2);
  const [per100, extra] = nutritionFrom(r.nutrition);
  assert.deepEqual([per100.kcal, per100.fat, per100.salt, extra.sodium], [497, 8, 2.92, 1168]);
  const seen = fake.calls();
  // 1 discovery, 2 authorize, 3 login page (cookie!), 4 credentials, 5 follow-up (cookie!), 6 token, then 3 well-known (any order), then the recipe
  assert.deepEqual(seen.slice(0, 6).map((s) => [s.host, s.method, s.path.split('?')[0]]), [
    [CIAM, 'GET', '/.well-known/openid-configuration'], [CIAM, 'GET', '/authorize'], [CIAM, 'GET', '/login-page'],
    [CIAM, 'POST', '/login-srv/login'], [CIAM, 'GET', '/after-login'], [CIAM, 'POST', '/token']]);
  const authorize = new URL('https://x' + seen[1]!.path).searchParams;
  assert.deepEqual([authorize.get('response_type'), authorize.get('client_id'), authorize.get('redirect_uri'), authorize.get('market'), authorize.get('scope'), authorize.get('code_challenge_method'), authorize.get('ui_locales')],
    ['code', 'mobile-android', 'com.vorwerk.cookidoo://code-grant', 'de', 'openid profile email offline offline_access', 'S256', 'de-DE']);
  assert.match(seen[2]!.headers['user-agent']!, /Mozilla/);
  assert.ok(seen[2]!.headers.cookie!.includes('sid=sess-'));
  assert.equal(seen[3]!.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.ok(seen[5]!.body.includes('code_verifier=') && !seen[5]!.body.includes('client_secret'));
  const well = seen.slice(6, 9);
  assert.deepEqual(well.map((s) => s.path).sort(), ['/organize/.well-known/home', '/planning/.well-known/home', '/recipes/recipe/.well-known/home']); // only the three services in use
  const api = seen[9]!;
  assert.deepEqual([api.host, api.path, api.headers.authorization, api.headers.accept], [SITE, '/recipes/recipe/de-DE/r100001', `Bearer ${fake.token}`, 'application/json']);
  assert.ok(!api.headers.cookie, 'the cookies of the identity provider never go to the site');
  // the credentials went to one request only: the login service
  const withSecret = seen.filter((s) => s.body.includes('good-password') || JSON.stringify(s.headers).includes('good-password') || s.path.includes('good-password'));
  assert.deepEqual(withSecret.map((s) => `${s.host}${s.path.split('?')[0]}`), [`${CIAM}/login-srv/login`]);
  // a second call needs no new sign-in and no new discovery
  fake.seen = [];
  await client.recipe('r100001');
  assert.equal(fake.calls().length, 1);
});

test('the week, with the day in the path; custom recipes are not read', async () => {
  reset();
  const client = clientFor();
  const days = await client.week('2026-01-10');
  assert.deepEqual(days, [{ day: '2026-01-10', title: 'Monday', recipes: [{ id: 'r100001', name: 'Red lentil salad' }] }, { day: '2026-01-13', title: 'Tuesday', recipes: [] }]);
  assert.ok(fake.calls(SITE).some((s) => s.path === '/planning/de-DE/api/my-week/2026-01-10'));
});

test('the collections: own lists first, then the managed ones, first page, their own Accept header', async () => {
  reset();
  const client = clientFor();
  const found = await client.collections();
  assert.deepEqual(found, [
    { id: 'c1', name: 'Favourites', managed: false, recipes: [{ id: 'r100001', name: 'Red lentil salad' }, { id: 'r100002', name: 'Soup' }] },
    { id: 'm1', name: 'Quick dinners', managed: true, recipes: [] }]);
  const lists = fake.calls(SITE).filter((s) => s.path.startsWith('/organize/de-DE'));
  assert.deepEqual(lists.map((s) => [s.path, s.headers.accept]), [
    ['/organize/de-DE/api/custom-list?page=0', 'application/vnd.vorwerk.organize.custom-list.mobile+json'],
    ['/organize/de-DE/api/managed-list?page=0', 'application/vnd.vorwerk.organize.managed-list.mobile+json']]);
});

test('wrong credentials: auth, nothing in the error; no code, no retry', async () => {
  reset();
  const client = clientFor('a-wrong-password-not-real');
  const e = await client.recipe('r100001').catch((x) => x);
  assert.ok(e instanceof CookidooError && e.kind === 'auth');
  assert.ok(!JSON.stringify(e).includes('wrong-password') && !String(e.stack).includes('wrong-password') && !e.message.includes('wrong-password'));
  assert.equal(fake.calls(CIAM).filter((s) => s.path === '/login-srv/login').length, 1); // not retried
  assert.equal(fake.calls(SITE).length, 0);
});

test('a state that does not match is a refusal', async () => {
  reset(); fake.badState = true;
  assert.equal(await kind(clientFor().ping()), 'auth');
});

test('a redirect off the identity provider is never followed (credentials and cookies stay at home)', async () => {
  reset(); fake.evilRedirect = true;
  const client = clientFor();
  assert.equal(await kind(client.ping()), 'auth');
  assert.deepEqual((fake.outgoing() as any).refused, []);
  assert.ok(!fake.calls().some((s) => s.host === 'evil.example'));
});

test('an expired token is renewed with the refresh token; a refused token means one new sign-in, then auth', async () => {
  reset();
  let now = 1_000_000;
  fake.expiresIn = 3600;
  const client = clientFor(GOOD_PW, () => now);
  await client.week('2026-01-10');
  now += 3600 - 200; // within the five minutes before the end
  fake.seen = [];
  await client.week('2026-01-10');
  assert.equal(fake.refreshed, 1);
  assert.ok(fake.calls(CIAM).some((s) => s.body.includes('grant_type=refresh_token')));
  assert.ok(!fake.calls(CIAM).some((s) => s.path === '/login-srv/login'));
  // the server refuses the token: one new sign-in, and the call is made again
  fake.seen = [];
  fake.rejectApi = 1;
  await client.week('2026-01-10');
  assert.equal(fake.calls(CIAM).filter((s) => s.path === '/login-srv/login').length, 1);
  // refused twice: auth, and the session is forgotten
  fake.rejectApi = 2;
  fake.seen = [];
  assert.equal(await kind(client.week('2026-01-10')), 'auth');
  fake.seen = [];
  await client.week('2026-01-10'); // a later call signs in afresh
  assert.equal(fake.calls(CIAM).filter((s) => s.path === '/login-srv/login').length, 1);
});

test('a refused refresh token leads to a new sign-in', async () => {
  reset();
  let now = 1_000_000;
  fake.expiresIn = 3600;
  const client = clientFor(GOOD_PW, () => now);
  await client.week('2026-01-10');
  fake.refresh = 'refresh-2'; // the server forgot the old one
  now += 3500;
  fake.seen = [];
  await client.week('2026-01-10');
  assert.equal(fake.calls(CIAM).filter((s) => s.path === '/login-srv/login').length, 1);
});

test('the discovery is retried once; a lasting failure is "unavailable", a changed shape "unexpected"', async () => {
  reset(); fake.wellKnownFail = 3; // the first round fails, the retry works
  assert.equal(await kind(clientFor().week('2026-01-10')), 'ok');
  reset(); fake.wellKnownFail = 100;
  assert.equal(await kind(clientFor().week('2026-01-10')), 'unavailable');
  reset(); fake.wellKnownHref = { 'recipe:details': `https://${SITE}/recipes/recipe/{lang}` }; // one placeholder less
  assert.equal(await kind(clientFor().recipe('r100001')), 'unexpected');
  reset(); fake.wellKnownHref = { 'recipe:details': `https://${SITE}/recipes/recipe/{id}/{lang}` }; // two placeholders swapped
  assert.equal(await kind(clientFor().recipe('r100001')), 'unexpected');
  reset();
});

test('normalizing the discovered addresses', () => {
  assert.equal(normalizeHref('https://cookidoo.de/recipes/recipe/{lang}/{id}', 'recipes/recipe/{language}/{id}'), 'recipes/recipe/{language}/{id}');
  assert.equal(normalizeHref('/planning/{lang}/api/my-week/{dayKey}{?x,y}', 'planning/{language}/api/my-week/{day}'), 'planning/{language}/api/my-week/{day}');
  assert.equal(normalizeHref('/a/{foo}/b/{bar}', 'a/{language}/b/{id}'), 'a/{language}/b/{id}'); // unknown names: by position
  assert.equal(normalizeHref('/a/{id}/{lang}', 'a/{language}/{id}'), null);
  assert.equal(normalizeHref('/a/{lang}', 'a/{language}/{id}'), null);
});

test('bad answers become categories', async () => {
  reset(); fake.apiStatus = 500;
  assert.equal(await kind(clientFor().recipe('r100001')), 'unavailable');
  reset(); fake.apiContentType = 'text/html';
  assert.equal(await kind(clientFor().recipe('r100001')), 'unavailable');
  reset(); fake.apiContentType = 'application/vnd.vorwerk.x+json'; // a json type of any vendor is fine
  assert.equal(await kind(clientFor().recipe('r100001')), 'ok');
  reset(); delete fake.recipe.servingSize;
  assert.equal(await kind(clientFor().recipe('r100001')), 'unexpected');
  reset(); fake.recipe.nutritionGroups[0].recipeNutritions[0].nutritions[0].number = null; // no value is not 0 kcal
  assert.equal(await kind(clientFor().recipe('r100001')), 'unexpected');
  reset(); fake.recipe.nutritionGroups[0].recipeNutritions[0].nutritions[0].number = '497.5'; // a numeric text is a number
  assert.equal((await clientFor().recipe('r100001')).nutrition[0]!.values.get('kcal')![0], 497.5);
  reset(); fake.recipe.servingSize.quantity.value = null; // portions unknown
  assert.equal((await clientFor().recipe('r100001')).portions, null);
  reset(); fake.recipe.descriptiveAssets = [];
  assert.equal((await clientFor().recipe('r100001')).image, null);
  reset(); delete fake.recipe.nutritionGroups; // no values at all: the connector refuses the recipe, the client reads it
  assert.deepEqual((await clientFor().recipe('r100001')).nutrition, []);
  reset();
});

test('a country and language that do not exist ask nothing', async () => {
  reset();
  const client = clientFor(GOOD_PW, undefined, { country: 'zz', language: 'zz-ZZ' });
  assert.equal(await kind(client.ping()), 'unexpected');
  assert.equal(fake.calls().length, 0);
});

test('an unreachable service is "unavailable"', async () => {
  reset();
  const dead = new LibraryClient(settings(), { fetch: async () => { throw new Error('socket hang up'); }, resolve: async () => [] });
  assert.equal(await kind(dead.ping()), 'unavailable');
});

test('behind the hub: a refused sign-in is not repeated for five minutes and the credentials are in no log', async () => {
  reset();
  const logs: string[] = [];
  const warn = console.warn; console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    let now = 5_000_000;
    fake.seen = [];
    const hub = new Hub({ factory: (s) => new LibraryClient(s, fake.outgoing(), () => now), clock: () => now });
    const bad = new Access('shared', settings('a-wrong-password-not-real'), 'shared');
    assert.equal(await kind(hub.week(bad)), 'auth');
    const logins = () => fake.calls(CIAM).filter((s) => s.path === '/login-srv/login').length;
    assert.equal(logins(), 1);
    now += 120;
    assert.equal(await kind(hub.collections(bad)), 'auth');
    assert.equal(logins(), 1); // Cookidoo was not asked again
    now += 400;
    const good = new Access('shared', settings(), 'shared'); // changed account: after the gap one try
    assert.equal(await kind(hub.collections(good)), 'ok');
    assert.equal(logins(), 2);
    assert.ok(!logs.join(' ').includes('password'));
    assert.ok(!JSON.stringify(hub).includes('password'));
  } finally { console.warn = warn; }
});

test('MESSAGES hold no text from the service', () => {
  for (const text of Object.values(MESSAGES)) assert.ok(!text.includes('Bearer') && !text.includes('http'));
});

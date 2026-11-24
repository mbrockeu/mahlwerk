// The hub: accounts that never mix, the sign-in brake, caches and call limits (test_cookidoo.py, test_cookidoo_accounts.py).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_COOLDOWN, Access, CookidooError, Hub, IDLE_SECONDS, LOGIN_GAP, MESSAGES, Settings, type CookidooClient } from '../core/cookidoo.ts';
import { FakeClient, LENTILS } from './cookidooHarness.ts';

const access = (key: string, n: number) => new Access(key, Settings.build(`u${n}@example.invalid`, `password-${String(n).padStart(4, '0')}`, 'de', 'de-DE')!, key === 'shared' ? 'shared' : 'own');

function setup(clock = { now: 1e6 }, wrap: (c: FakeClient) => CookidooClient = (c) => c) {
  const built: FakeClient[] = [];
  const hub = new Hub({ factory: (s) => { const c = new FakeClient(s); built.push(c); return wrap(c); }, clock: () => clock.now });
  return { hub, built, clock };
}
const kind = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok'; } catch (e) { return e instanceof CookidooError ? e.kind : `other ${e}`; } };
const internals = (hub: Hub) => hub as unknown as { accounts: Map<string, { lists: Map<string, unknown>; lastError: string | null; lastFail: number; client: unknown }> };

test('the same account in two requests is one sign-in (settings are compared by value)', async () => {
  const { hub, built } = setup();
  await hub.week(access('user:1', 1));
  await hub.collections(access('user:1', 1)); // a new Settings object with the same values
  assert.equal(built.length, 1);
  assert.deepEqual(built[0]!.calls, ['week', 'collections']);
});

test('a failed sign-in is not retried for five minutes, and the client is closed', async () => {
  const { hub, built, clock } = setup();
  const a = access('shared', 1);
  await hub.week(a);
  built[0]!.fail = 'auth';
  clock.now += 61; // the list cache is over
  assert.equal(await kind(hub.week(a)), 'auth');
  assert.equal(built[0]!.closed, true);
  clock.now += 120;
  assert.equal(await kind(hub.collections(a)), 'auth'); // blocked: Cookidoo is not asked
  assert.equal(built.length, 1);
  assert.deepEqual(built[0]!.calls, ['week', 'week']);
  clock.now += 400;
  assert.equal(await kind(hub.collections(a)), 'ok');
  assert.equal(built.length, 2);
});

test('the call limit: 30 in 300 seconds per account, again after the window', async () => {
  const { hub, clock } = setup({ now: 1e6 }, (c) => { c.recipe = async () => LENTILS; return c; });
  const a = access('shared', 1);
  const codes: string[] = [];
  for (let i = 0; i < 35; i++) { codes.push(await kind(hub.recipe(a, `r${200000 + i}`))); }
  assert.deepEqual(codes.slice(0, 30), Array(30).fill('ok'));
  assert.deepEqual(new Set(codes.slice(30)), new Set(['busy']));
  clock.now += 301;
  assert.equal(await kind(hub.recipe(a, 'r299999')), 'ok');
});

test('lists are loaded once a minute; recipes are cached', async () => {
  const { hub, built, clock } = setup();
  const a = access('shared', 1);
  for (let i = 0; i < 3; i++) await hub.week(a);
  assert.equal(built[0]!.calls.filter((c) => c === 'week').length, 1);
  clock.now += 61;
  await hub.week(a);
  assert.equal(built[0]!.calls.filter((c) => c === 'week').length, 2);
  for (let i = 0; i < 3; i++) await hub.recipe(a, 'r100001');
  assert.equal(built[0]!.calls.filter((c) => c === 'recipe').length, 1);
});

test('the week is asked for the day of the hub clock', async () => {
  let asked = '';
  const clock = { now: Date.UTC(2026, 0, 10, 12) / 1000 };
  const hub = new Hub({ factory: (s) => { const c = new FakeClient(s); c.week = async (day?: unknown) => { asked = String(day); return []; }; return c; }, clock: () => clock.now });
  await hub.week(access('shared', 1));
  assert.equal(asked, '2026-01-10');
});

test('at most MAX_CLIENTS signed-in clients are held; the others are closed', async () => {
  const { hub, built } = setup();
  hub.maxClients = 2;
  for (let n = 0; n < 5; n++) { await hub.week(access(`user:${n}`, n)); assert.ok(hub.clientCount() <= 2); }
  assert.deepEqual(built.map((c) => c.closed), [true, true, true, false, false]);
});

test('idle clients are closed', async () => {
  const { hub, built, clock } = setup();
  await hub.week(access('user:1', 1));
  clock.now += IDLE_SECONDS + 1;
  await hub.week(access('user:2', 2));
  assert.deepEqual([built[0]!.closed, built[1]!.closed], [true, false]);
});

test('forget empties the account and a refusal is not forgotten', async () => {
  const { hub, built, clock } = setup();
  const a = access('user:1', 1);
  await hub.week(a);
  await hub.forget('user:1');
  assert.ok(built[0]!.closed && hub.clientCount() === 0);
  built[0]!.fail = 'auth';
  await hub.forget('user:1');
  await hub.week(a); // a fresh client (the next one is fine)
  assert.ok(built.length === 2 && !built[1]!.closed);
  built[1]!.fail = 'auth';
  internals(hub).accounts.get('user:1')!.lists.clear();
  assert.equal(await kind(hub.week(a)), 'auth');
  await hub.forget('user:1');
  assert.equal(internals(hub).accounts.get('user:1')!.lastFail, clock.now); // the refusal is remembered
  assert.equal(await kind(hub.week(a)), 'wait');
  clock.now += LOGIN_GAP + 1;
  assert.equal(await kind(hub.week(a)), 'ok');
});

test('the global call limit covers all accounts', async () => {
  const { hub } = setup({ now: 1e6 }, (c) => { c.recipe = async () => LENTILS; return c; });
  hub.globalCallLimit = [3, 300];
  for (let n = 0; n < 3; n++) await hub.recipe(access(`user:${n}`, n), `r10000${n}`);
  assert.equal(await kind(hub.recipe(access('user:9', 9), 'r100009')), 'busy');
});

test('at most 20 sign-ins an hour for all accounts together', async () => {
  const { hub, built, clock } = setup();
  for (let n = 0; n < 20; n++) await hub.week(access(`user:${n}`, n));
  assert.equal(await kind(hub.week(access('user:99', 99))), 'busy');
  await hub.week(access('user:3', 3)); // an existing sign-in needs no new attempt
  clock.now += 3601;
  await hub.week(access('user:99', 99));
  assert.equal(built.length, 21);
});

test('five refusals an hour per holder lock the holder, changing the account does not help', async () => {
  const { hub, built, clock } = setup({ now: 1e6 }, (c) => { c.fail = 'auth'; return c; });
  for (let n = 0; n < 5; n++) {
    const a = new Access('user:1', Settings.build('a@example.invalid', `guess-${String(n).padStart(8, '0')}`, 'de', 'de-DE')!, 'own');
    assert.equal(await kind(hub.week(a)), 'auth');
    clock.now += AUTH_COOLDOWN + LOGIN_GAP + 1;
  }
  const again = new Access('user:1', Settings.build('a@example.invalid', 'a-sixth-guess', 'de', 'de-DE')!, 'own');
  assert.equal(await kind(hub.week(again)), 'locked');
  assert.equal(built.length, 5);
  // another person is not locked out by it
  assert.equal(await kind(hub.week(access('user:2', 2))), 'auth'); // (the stand-in refuses everybody) ...
  assert.equal(built.length, 6); // ... but Cookidoo was asked: no brake of user 1 applies to user 2
  clock.now += 3600; // an hour after the refusals
  assert.equal(await kind(hub.week(again)), 'auth');
  assert.equal(built.length, 7);
});

test('evicting idle accounts does not forget refusals', async () => {
  const { hub, clock } = setup({ now: 1e6 }, (c) => { c.fail = 'auth'; return c; });
  hub.maxAccounts = 2;
  for (let n = 0; n < 5; n++) {
    const a = new Access('user:1', Settings.build('a@example.invalid', `guess-${String(n).padStart(8, '0')}`, 'de', 'de-DE')!, 'own');
    assert.equal(await kind(hub.week(a)), 'auth');
    clock.now += AUTH_COOLDOWN + LOGIN_GAP + 1;
  }
  for (const k of [2, 3, 4]) { clock.now += 1; await kind(hub.week(access(`user:${k}`, k))); } // other people push the account out of the hub
  assert.ok(!internals(hub).accounts.has('user:1'));
  assert.equal(await kind(hub.week(access('user:1', 1))), 'locked');
});

test('an answer that arrives after a change is not cached', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { hub } = setup({ now: 1e6 }, (c) => { const week = c.week.bind(c); c.week = async () => { await gate; return week(); }; return c; });
  const old = access('user:1', 1);
  const slow = hub.week(old);
  await new Promise((r) => setTimeout(r, 30));
  await hub.forget('user:1'); // the account is removed while the request is on its way
  release();
  assert.equal((await slow)[0]!.title, 'u1@example.invalid'); // the caller still gets its answer ...
  const acc = internals(hub).accounts.get('user:1')!;
  assert.ok(acc.lists.size === 0 && acc.lastError === null); // ... but nothing is kept
});

test('a request that waited for the lock while the account was removed gets a neutral answer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { hub } = setup({ now: 1e6 }, (c) => { const week = c.week.bind(c); c.week = async () => { await gate; return week(); }; return c; });
  const a = access('user:1', 1);
  const first = hub.week(a);
  await new Promise((r) => setTimeout(r, 30));
  const second = kind(hub.recipe(a, 'r100001')); // waits for the lock
  await new Promise((r) => setTimeout(r, 30));
  await hub.forget('user:1'); // settings are gone now
  release();
  await first;
  assert.equal(await second, 'gone');
  assert.equal(new CookidooError('gone').message, MESSAGES.gone);
});

test('check: one sign-in, braked 30 seconds; a failed check blocks five minutes', async () => {
  const state = { fail: null as string | null };
  const { hub, built, clock } = setup({ now: 1e6 }, (c) => { c.fail = state.fail; return c; });
  const a = access('shared', 1);
  await hub.check(a);
  assert.equal(await kind(hub.check(a)), 'wait');
  clock.now += LOGIN_GAP + 1;
  await hub.check(a);
  assert.deepEqual(built.map((c) => c.calls), [['ping'], ['ping']]);
  state.fail = 'auth';
  clock.now += LOGIN_GAP + 1;
  assert.equal(await kind(hub.check(a)), 'auth');
  clock.now += LOGIN_GAP + 1;
  assert.equal(await kind(hub.check(a)), 'auth'); // blocked (five minutes), and not even asked
  assert.equal(built.length, 3);
  state.fail = null;
  clock.now += AUTH_COOLDOWN;
  assert.equal(await kind(hub.check(a)), 'ok');
});

test('whatever the client throws, the caller learns only the category and nothing secret is logged', async () => {
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    const { hub } = setup({ now: 1e6 }, (c) => { c.fail = 'boom'; return c; });
    const e = await hub.week(access('user:1', 1)).catch((x) => x);
    assert.ok(e instanceof CookidooError && e.kind === 'unexpected');
    assert.ok(!String(e.message).includes('password-0001') && !(e.cause !== undefined));
    assert.ok(logs.length === 1 && !logs.join(' ').includes('password-0001') && !logs.join(' ').includes('boom'), logs.join(' '));
    assert.equal(hub.errorOf('user:1'), 'unexpected');
  } finally { console.warn = warn; }
});

test('the status of a card: not configured, ready, off, error', async () => {
  const { hub } = setup();
  assert.equal(hub.status(true, null), 'not_configured');
  assert.equal(hub.status(true, access('shared', 1)), 'ready');
  assert.equal(hub.status(false, access('shared', 1)), 'off');
  await kind(hub.week(access('shared', 1))); // fine
  const bad = setup({ now: 1e6 }, (c) => { c.fail = 'unavailable'; return c; });
  await kind(bad.hub.week(access('shared', 1)));
  assert.equal(bad.hub.status(true, access('shared', 1)), 'error');
  assert.equal(bad.hub.lastError, 'unavailable');
});

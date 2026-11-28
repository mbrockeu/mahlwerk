// Hardening of the outgoing name resolution (audit leads of run-2): a name that is routed to the server's own address is no target,
// the resolver has a deadline and a limit on lookups in flight, and the tag strip of cleanText is linear.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ctx } from '../core/http.ts';
import { pickAddress, TargetNotAllowed } from '../core/netguard.ts';
import { OutError, type Outgoing } from '../core/outgoing.ts';
import { cleanText } from '../core/webrecipes.ts';
import { makeResolve } from '../server/outgoing.ts';

const ctxWith = (table: Record<string, string[]>, calls: string[] = []): Ctx => {
  const out: Outgoing = {
    async fetch() { throw new Error('no network'); },
    async resolve(host) { calls.push(host); if (!table[host]) throw new OutError('connect', 'ENOTFOUND'); return table[host]!; },
  };
  return { services: { out }, env: {} } as unknown as Ctx;
};

test('a public name routed to the address of an own name is refused, other names pass', async () => {
  const calls: string[] = [];
  const ctx = ctxWith({ 'evil.example.com': ['93.184.216.34'], 'good.example.com': ['93.184.216.35'], 'home.example.org': ['93.184.216.34'] }, calls);
  await assert.rejects(pickAddress(ctx, 'evil.example.com', 443, false, ['home.example.org']), TargetNotAllowed);
  assert.equal(await pickAddress(ctx, 'good.example.com', 443, false, ['home.example.org']), '93.184.216.35');
  assert.equal(await pickAddress(ctx, 'evil.example.com', 443), '93.184.216.34'); // no own names given: as before
  assert.equal(calls.filter((c) => c === 'home.example.org').length, 1, 'own names are cached');
});

test('own address check also holds for listed internal hosts, and compares IPv6 spellings', async () => {
  const ctx = ctxWith({ 'internal.lan': ['10.0.0.5'], 'home.example.org': ['10.0.0.5', '2001:DB8::1'], 'v6.example.com': ['::ffff:10.0.0.5'] });
  await assert.rejects(pickAddress(ctx, 'internal.lan', 80, true, ['home.example.org']), TargetNotAllowed);
  await assert.rejects(pickAddress(ctx, 'v6.example.com', 80, true, ['home.example.org']), TargetNotAllowed);
  assert.equal(await pickAddress(ctx, 'internal.lan', 80, true, ['unknown.example.org']), '10.0.0.5'); // own name that does not resolve
});

test('an own name that times out or fails refuses the target (fail closed) and is not cached; answers are cached and shared', async () => {
  let n = 0;
  let mode: 'timeout' | 'ok' = 'timeout';
  const out: Outgoing = {
    async fetch() { throw new Error('no network'); },
    async resolve(host) { return host === 'home.example.org' ? ['93.184.216.34'] : ['93.184.216.35']; },
    async resolveOwn(host) { n++; await new Promise((r) => setTimeout(r, 20)); if (mode === 'timeout') throw new OutError('timeout'); return host === 'home.example.org' ? ['93.184.216.99'] : ['93.184.216.98']; },
  };
  const ctx = { services: { out }, env: {} } as unknown as Ctx;
  await assert.rejects(pickAddress(ctx, 'good.example.com', 443, false, ['home.example.org']), TargetNotAllowed);
  mode = 'ok';
  assert.equal(await pickAddress(ctx, 'good.example.com', 443, false, ['home.example.org']), '93.184.216.35'); // the failure was not cached
  await Promise.all([pickAddress(ctx, 'good.example.com', 443, false, ['other.example.org']), pickAddress(ctx, 'good.example.com', 443, false, ['other.example.org'])]);
  assert.equal(n, 3, 'concurrent lookups of one own name share a promise; the answer is cached');
});

test('the resolver gives up after the deadline, cancels, and frees the place at the deadline (at most two at once)', async () => {
  let inFlight = 0;
  let peak = 0;
  let cancelled = 0;
  const cancels: (() => void)[] = [];
  const hang = () => new Promise<string[]>((_ok, no) => { inFlight++; peak = Math.max(peak, inFlight); cancels.push(() => { inFlight--; no(Object.assign(new Error('x'), { code: 'ECANCELLED' })); }); });
  const resolve = makeResolve(() => ({ resolve4: hang, resolve6: async () => [], lookup: async () => [], cancel: () => { cancelled++; cancels.shift()?.(); } }), 100, 2);
  const t0 = Date.now();
  const results = await Promise.allSettled(['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'].map(resolve));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(Date.now() - t0 < 350, 'two rounds of at most one deadline each');
  assert.equal(cancelled, 4);
  assert.ok(peak <= 2, `peak ${peak}`);
});

test('the resolver answers from DNS, passes IP literals; getaddrinfo only after "no such name", never after a timeout', async () => {
  const looked: string[] = [];
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  const resolve = makeResolve({
    resolve4: async (h) => { if (h === 'a.example.com') return ['93.184.216.34']; throw code(h === 'slow.example.com' ? 'ETIMEOUT' : 'ENODATA'); },
    resolve6: async (h) => { if (h === 'a.example.com') return ['2606:2800::1']; throw code(h === 'slow.example.com' ? 'ETIMEOUT' : 'ENODATA'); },
    lookup: async (h) => { looked.push(h); if (h === 'localhost' || h === 'hosts.example.com') return ['127.0.0.1']; throw code('ENOTFOUND'); },
  });
  assert.deepEqual(await resolve('a.example.com'), ['93.184.216.34', '2606:2800::1']);
  assert.deepEqual(await resolve('1.2.3.4'), ['1.2.3.4']);
  assert.deepEqual(await resolve('localhost'), ['127.0.0.1']);
  assert.deepEqual(await resolve('hosts.example.com'), ['127.0.0.1']); // any name, after a definitive no-such-name
  await assert.rejects(resolve('nothing.example.com'), (e: unknown) => e instanceof OutError && e.kind === 'connect');
  await assert.rejects(resolve('slow.example.com'), (e: unknown) => e instanceof OutError && e.kind === 'timeout');
  assert.deepEqual(looked, ['localhost', 'hosts.example.com', 'nothing.example.com']);
});

test('cleanText strips tags as before and handles runs of "<" quickly', () => {
  assert.equal(cleanText('<b>2 cups</b> <i>flour</i>'), '2 cups flour');
  assert.equal(cleanText('a < b and c > d'), 'a < b and c > d'.replace(/<[^<>]{0,300}>/g, ' ').split(/\s+/).join(' '));
  assert.equal(cleanText('x<<b>y'), 'x< y');
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) cleanText('<'.repeat(1600));
  assert.ok(Date.now() - t0 < 500, 'linear');
});

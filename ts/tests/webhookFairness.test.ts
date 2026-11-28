// The webhook delivery places are shared fairly (finding of the security audit of 28.11.): one person's backlog against a slow
// receiver neither holds up the others' deliveries nor grows without bound, and the wait before a retry frees the place.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Outgoing } from '../core/outgoing.ts';
import { dispatcher, MAX_WAITING_PER_PERSON } from '../core/webhooks.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) { dispatcher(w.ctx).stop(); await w.close(); } });

async function world(stalling = true) {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  const calls: string[] = [];
  let release: () => void = () => {};
  let stall = new Promise<void>((r) => { release = r; });
  const out: Outgoing = {
    async fetch(_purpose, req) {
      calls.push(req.url);
      if (req.url.includes('slow.example.com')) { await (stalling ? stall : new Promise((r) => setTimeout(r, 30))); return { status: 503, headers: {}, body: new Uint8Array() }; }
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    async resolve() { return ['93.184.216.34']; },
  };
  w.ctx.services.out = out;
  const d = dispatcher(w.ctx);
  d.backoff = [0.01, 0.01];
  return { w, d, calls, unstall: () => { release(); stall = Promise.resolve(); } };
}
const hook = (url: string) => ({ name: 'n', url, events: ['entry.created'] });
const userId = async (w: World, name: string) => (await w.ctx.db.get<{ id: number }>('SELECT id FROM user WHERE username = ?', [name]))!.id;

test("another person's delivery does not wait behind one person's backlog", async () => {
  const { w, d, calls, unstall } = await world(false); // ann's receiver answers 503 after a moment, so places turn over
  assert.equal((await w.ann.post('/api/v1/me/webhooks', hook('https://slow.example.com/in'))).status, 201);
  assert.equal((await w.ben.post('/api/v1/me/webhooks', hook('https://fast.example.com/in'))).status, 201);
  const [ann, ben] = [await userId(w, 'ann'), await userId(w, 'ben')];
  for (let i = 0; i < 40; i++) d.publish(ann, 'ann', 'entry.created', { i });
  d.publish(ben, 'ben', 'entry.created', { i: 0 });
  for (let i = 0; i < 50 && !calls.some((u) => u.includes('fast')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((u) => u.includes('fast')), "ben's delivery was held up by ann's backlog");
  assert.ok(d.waitingFor(ann) > 0); // ann's own deliveries still wait their turn
  unstall();
  assert.ok(await d.waitIdle(20));
});

test("one person's waiting deliveries are capped; beyond that new ones are dropped", async () => {
  const { w, d, unstall } = await world();
  assert.equal((await w.ann.post('/api/v1/me/webhooks', hook('https://slow.example.com/in'))).status, 201);
  const ann = await userId(w, 'ann');
  for (let i = 0; i < MAX_WAITING_PER_PERSON + 100; i++) d.publish(ann, 'ann', 'entry.created', { i });
  for (let i = 0; i < 200 && d.waitingFor(ann) < MAX_WAITING_PER_PERSON; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200)); // the rest of the jobs have been fanned out
  assert.equal(d.waitingFor(ann), MAX_WAITING_PER_PERSON);
  const rows = (await w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_delivery'))!.n;
  assert.ok(rows <= MAX_WAITING_PER_PERSON + 4, `${rows} delivery rows`); // dropped ones leave no row
  unstall();
  assert.ok(await d.waitIdle(60));
});

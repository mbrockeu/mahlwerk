// Deliveries that wait for a place (or for a retry) use the hook as it is when they are sent, not as it was at fan-out time
// (finding of the security audit of 28.11.): a removed, disabled or re-pointed hook, switched-off webhooks and an owner who
// became a guest all take effect for what is already queued.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Outgoing, OutRequest } from '../core/outgoing.ts';
import { dispatcher } from '../core/webhooks.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) { dispatcher(w.ctx).stop(); await w.close(); } });

/** POOL places are held by deliveries to stall.example.com until `open()`; every other target answers at once. */
async function world(env: Record<string, string> = {}) {
  const w = await makeWorld({ on: false, env });
  worlds.push(w);
  const seen: OutRequest[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const out: Outgoing = {
    async fetch(_purpose, req) {
      seen.push(req);
      if (req.url.includes('stall.example.com')) await gate;
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    async resolve() { return ['93.184.216.34']; },
  };
  w.ctx.services.out = out;
  const d = dispatcher(w.ctx);
  const ids = async (name: string) => (await w.ctx.db.get<{ id: number }>('SELECT id FROM user WHERE username = ?', [name]))!.id;
  /** 4 deliveries hold all places, 2 more wait. */
  const fill = async (who: string) => {
    const id = await ids(who);
    for (let i = 0; i < 6; i++) d.publish(id, who, 'entry.created', { i });
    for (let i = 0; i < 100 && (seen.length < 4 || d.waitingFor(id) < 2); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 4);
    assert.equal(d.waitingFor(id), 2);
  };
  return { w, d, seen, open, fill };
}
const hook = (url: string) => ({ name: 'n', url, events: ['entry.created'] });
const errors = async (w: World) => (await w.ctx.db.all<{ error: string | null }>('SELECT error FROM webhook_delivery ORDER BY id')).map((r) => r.error);

test('a hook that was re-pointed while deliveries waited gets them at the new URL', async () => {
  const { w, d, seen, open, fill } = await world();
  const made = await w.ann.post('/api/v1/me/webhooks', hook('https://stall.example.com/in'));
  assert.equal(made.status, 201, made.text);
  await fill('ann');
  assert.equal((await w.ann.patch(`/api/v1/me/webhooks/${made.json.id}`, { url: 'https://new.example.com/in' })).status, 200);
  open();
  assert.ok(await d.waitIdle(10));
  assert.deepEqual(seen.map((r) => new URL(r.url).hostname), ['stall.example.com', 'stall.example.com', 'stall.example.com', 'stall.example.com', 'new.example.com', 'new.example.com']);
});

test('a deleted hook gets nothing that was still waiting', async () => {
  const { w, d, seen, open, fill } = await world();
  const made = await w.ann.post('/api/v1/me/webhooks', hook('https://stall.example.com/in'));
  await fill('ann');
  assert.equal((await w.ann.delete(`/api/v1/me/webhooks/${made.json.id}`)).status, 204);
  open();
  assert.ok(await d.waitIdle(10));
  assert.equal(seen.length, 4);
});

test('a disabled hook, or one that stopped listening to the event, gets nothing that was still waiting', async () => {
  for (const change of [{ enabled: false }, { events: ['weight.recorded'] }]) {
    const { w, d, seen, open, fill } = await world();
    const made = await w.ann.post('/api/v1/me/webhooks', hook('https://stall.example.com/in'));
    await fill('ann');
    assert.equal((await w.ann.patch(`/api/v1/me/webhooks/${made.json.id}`, change)).status, 200);
    open();
    assert.ok(await d.waitIdle(10));
    assert.equal(seen.length, 4, JSON.stringify(change));
    assert.deepEqual((await errors(w)).filter(Boolean), ['hook changed', 'hook changed'], JSON.stringify(change));
  }
});

test('webhooks switched off by the admin stop what was still waiting', async () => {
  const { w, d, seen, open, fill } = await world();
  assert.equal((await w.ann.post('/api/v1/me/webhooks', hook('https://stall.example.com/in'))).status, 201);
  await fill('ann');
  await w.ctx.db.run("INSERT OR REPLACE INTO setting (key, value) VALUES ('webhooks.enabled', 'false')");
  (w.ctx.services as any).features?.clear?.();
  open();
  assert.ok(await d.waitIdle(10));
  assert.equal(seen.length, 4);
  assert.deepEqual((await errors(w)).filter(Boolean), ['webhooks switched off', 'webhooks switched off']);
});

test('an owner who became a guest in the meantime gets nothing more', async () => {
  const { w, d, seen, open, fill } = await world({ MAHLWERK_HOUSEHOLD_GROUPS: 'familie' });
  const member = w.who('cara', 'familie');
  assert.equal((await member.post('/api/v1/me/webhooks', hook('https://stall.example.com/in'))).status, 201);
  await fill('cara');
  await w.who('cara').get('/api/v1/me'); // the group is gone: a guest
  open();
  assert.ok(await d.waitIdle(10));
  assert.equal(seen.length, 4);
});

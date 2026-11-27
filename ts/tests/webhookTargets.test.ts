// Who may have webhooks and where they may go (finding S4 of the review of 22.11.): never to the server's own names (not even
// when an admin lists them), and not for guests; a guest's old hooks stay quiet.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Outgoing, OutRequest } from '../core/outgoing.ts';
import { dispatcher } from '../core/webhooks.ts';
import { blockedHosts } from '../core/webrecipes.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) { dispatcher(w.ctx).stop(); await w.close(); } });

/** Every name resolves to one public address; every POST is recorded and answered with 200. */
function receiver() {
  const seen: OutRequest[] = [];
  const out: Outgoing = {
    async fetch(_purpose, req) { seen.push(req); return { status: 200, headers: {}, body: new Uint8Array() }; },
    async resolve() { return ['93.184.216.34']; },
  };
  return { out, seen };
}

async function world(env: Record<string, string> = {}) {
  const w = await makeWorld({ on: false, env: { MAHLWERK_PUBLIC_URL: 'https://mahlwerk.example.org', MAHLWERK_ALLOWED_HOSTS: '127.0.0.1,mahlwerk.example.org,food.example.net', ...env } });
  worlds.push(w);
  const r = receiver();
  w.ctx.services.out = r.out;
  return { w, r };
}
const hook = (url: string) => ({ name: 'n', url, events: ['entry.created'] });

test("the server's own names are no webhook target, also as subdomains and when the admin lists them", async () => {
  const { w } = await world();
  for (const url of ['https://mahlwerk.example.org/api', 'https://MAHLWERK.example.org./x', 'http://a.mahlwerk.example.org/', 'https://food.example.net/']) {
    assert.equal((await w.ann.post('/api/v1/me/webhooks', hook(url))).status, 422, url);
  }
  assert.equal((await w.ann.post('/api/v1/me/webhooks', hook('https://hooks.example.com/in'))).status, 201);
  await w.admin.get('/api/v1/me');
  const listed = await w.admin.patch('/api/v1/admin/connectors/webhooks', { config: { hosts: ['mahlwerk.example.org', 'hooks.example.com'] } });
  assert.equal(listed.status, 200, listed.text);
  assert.equal((await w.ann.post('/api/v1/me/webhooks', hook('https://mahlwerk.example.org/api'))).status, 422);
});

test('a hook whose target became one of the own names is refused at delivery', async () => {
  const { w, r } = await world({ MAHLWERK_ALLOWED_HOSTS: '127.0.0.1,mahlwerk.example.org' });
  const made = await w.ann.post('/api/v1/me/webhooks', hook('https://later.example.com/in'));
  assert.equal(made.status, 201, made.text);
  w.env.MAHLWERK_ALLOWED_HOSTS = '127.0.0.1,mahlwerk.example.org,later.example.com'; // the server now answers to that name as well
  assert.equal((await w.ann.post(`/api/v1/me/webhooks/${made.json.id}/test`)).status, 202);
  assert.ok(await dispatcher(w.ctx).waitIdle(5));
  assert.equal(r.seen.length, 0);
  assert.equal((await w.ann.get(`/api/v1/me/webhooks/${made.json.id}/deliveries`)).json[0].error, 'target not allowed');
});

test('guests have no webhooks, and the hooks they made as household members stay quiet', async () => {
  const { w, r } = await world({ MAHLWERK_HOUSEHOLD_GROUPS: 'familie' });
  const member = w.who('cara', 'familie');
  const made = await member.post('/api/v1/me/webhooks', hook('https://hooks.example.com/in'));
  assert.equal(made.status, 201, made.text);
  assert.equal((await member.get('/api/v1/me')).json.features.webhooks, true);
  const guest = w.who('cara'); // the same person without the group: now a guest
  assert.equal((await guest.get('/api/v1/me')).json.features.webhooks, false);
  assert.equal((await guest.get('/api/v1/me/webhooks')).json.length, 1); // a guest still sees the old hook, and could remove it
  assert.equal((await guest.post('/api/v1/me/webhooks', hook('https://hooks.example.com/x'))).status, 403);
  assert.equal((await guest.patch(`/api/v1/me/webhooks/${made.json.id}`, { name: 'x' })).status, 403);
  assert.equal((await guest.post(`/api/v1/me/webhooks/${made.json.id}/test`)).status, 403);
  dispatcher(w.ctx).publish(made.json.user_id ?? (await w.ctx.db.get<{ id: number }>("SELECT id FROM user WHERE username = 'cara'"))!.id, 'cara', 'entry.created', {});
  assert.ok(await dispatcher(w.ctx).waitIdle(5));
  assert.equal(r.seen.length, 0);
  // back in the household, the hook delivers again
  await member.get('/api/v1/me');
  assert.equal((await member.post(`/api/v1/me/webhooks/${made.json.id}/test`)).status, 202);
  assert.ok(await dispatcher(w.ctx).waitIdle(5));
  assert.equal(r.seen.length, 1);
});

test('IPv6 literals in the own names are compared without brackets and port', () => {
  assert.deepEqual(blockedHosts({ MAHLWERK_ALLOWED_HOSTS: '[::1]:8110,[fd00::5],Food.Example:443' }), ['::1', 'fd00::5', 'food.example']);
});

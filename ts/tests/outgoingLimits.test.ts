// Answers of other servers are read with a size limit: Open Food Facts (one product, 2 MB) and the receiver of a webhook (64 KB; only
// its status is used). A longer answer stops at the limit (`too_large`) and counts as a failure.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Ctx } from '../core/http.ts';
import { fetchProduct, UpstreamError } from '../core/off.ts';
import { OutError, type Outgoing, type OutRequest } from '../core/outgoing.ts';
import { dispatcher } from '../core/webhooks.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) { dispatcher(w.ctx).stop(); await w.close(); } });

/** Records the requests; answers 200 with `body`, or fails like the Node client on a too long answer. */
function fake(tooLarge: boolean, body = '{}') {
  const seen: OutRequest[] = [];
  const out: Outgoing = {
    async fetch(_purpose, req) {
      seen.push(req);
      if (tooLarge) throw new OutError('too_large');
      return { status: 200, headers: {}, body: new TextEncoder().encode(body) };
    },
    async resolve() { return ['93.184.216.34']; },
  };
  return { out, seen };
}

test('the Open Food Facts answer is read with a limit of 2 MB; a longer one is an upstream error', async () => {
  const ok = fake(false, JSON.stringify({ status: 1, product: { product_name: 'Bar', nutriments: {} } }));
  const ctx = { env: {}, services: { out: ok.out } } as unknown as Ctx;
  assert.equal((await fetchProduct(ctx, 'https://off.example', '4006381333931'))?.name, 'Bar');
  assert.equal(ok.seen[0]!.maxBytes, 2 * 1024 * 1024);
  const big = fake(true);
  await assert.rejects(fetchProduct({ env: {}, services: { out: big.out } } as unknown as Ctx, 'https://off.example', '4006381333931'), UpstreamError);
});

test('the answer of a webhook receiver is read with a limit of 64 KB', async () => {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  const ok = fake(false);
  w.ctx.services.out = ok.out;
  const hook = await w.ann.post('/api/v1/me/webhooks', { name: 'n', url: 'https://hooks.example.org/in', events: ['entry.created'] });
  assert.equal(hook.status, 201, hook.text);
  assert.equal((await w.ann.post(`/api/v1/me/webhooks/${hook.json.id}/test`)).status, 202);
  assert.ok(await dispatcher(w.ctx).waitIdle(5));
  assert.equal(ok.seen.length, 1);
  assert.equal(ok.seen[0]!.maxBytes, 64 * 1024);
});

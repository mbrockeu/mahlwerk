// Availability limits: catalogue search words, the per-person brake and search budget of the ingredient match, the brake and heavy slot of the export.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Catalog, searchWords, type CatalogFiles } from '../core/catalog.ts';
import { budgeted, candidates, type CatalogSearch } from '../core/ingredients.ts';
import { yazioOf } from '../core/routes/yazio.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });
const world = async () => {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  return w;
};

test('search words: no repeats, no one-letter words, at most 8, text cut at 200 characters', () => {
  assert.deepEqual(searchWords('Hafer Flocken'), ['hafer', 'flocken']);
  assert.deepEqual(searchWords('milch milch MILCH 3 x'), ['milch']);
  assert.deepEqual(searchWords('a b c d'), ['a', 'b']); // nothing but one-letter words: the first two stay
  assert.deepEqual(searchWords('a a a a'), ['a']);
  assert.equal(searchWords(Array.from({ length: 50 }, (_, i) => `wort${i}`).join(' ')).length, 8);
  assert.deepEqual(searchWords(`${'x'.repeat(199)} abc`), ['x'.repeat(199)]); // the 200th character is a space, the rest is cut off
});

test('Catalog.search builds a bounded MATCH from a huge query', async () => {
  const matches: string[] = [];
  const files: CatalogFiles = { async all(_source, _sql, params) { if (params) matches.push(JSON.stringify(params)); return []; } };
  await new Catalog(files).search(`${'a '.repeat(5000)} ${'b '.repeat(5000)}`, 10, 'bls');
  const used = matches.map((m) => (m.match(/\*/g) ?? []).length);
  assert.ok(used.length > 0 && Math.max(...used) <= 4, `prefix terms per query: ${used}`);
});

test('GET /catalog cuts a long q instead of refusing it', async () => {
  const w = await world();
  const seen: string[] = [];
  w.ctx.services.catalog = { async search(q: string) { seen.push(q); return []; } };
  const r = await w.ann.get(`/api/v1/catalog?q=${encodeURIComponent('milch '.repeat(300))}`);
  assert.equal(r.status, 200);
  assert.ok(seen[0]!.length <= 200);
});

test('budgeted catalogue answers nothing after the budget; candidates still return own foods', async () => {
  let calls = 0;
  const counting: CatalogSearch = { async search() { calls++; return []; } };
  const cat = budgeted(counting, 5)!;
  for (let i = 0; i < 20; i++) await cat.search('milch', 10, 'bls');
  assert.equal(calls, 5);
  const own = [{ id: 1, code: null, source: 'user', data: { name: 'Haferflocken', per_100: { kcal: 370 } } }];
  const found = await candidates('Haferflocken', own, budgeted(counting, 0), undefined, 'Haferflocken');
  assert.equal(found[0]?.food_id, 1);
});

test('POST /recipes/ingredients/match: 30 lists per person in 10 minutes, then 429 with Retry-After', async () => {
  const w = await world();
  const body = { text: '100 g Hafer' };
  for (let i = 0; i < 30; i++) assert.equal((await w.ann.post('/api/v1/recipes/ingredients/match', body)).status, 200);
  const r = await w.ann.post('/api/v1/recipes/ingredients/match', body);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await w.ben.post('/api/v1/recipes/ingredients/match', body)).status, 200); // somebody else is not held back
  w.clock.now += 700;
  assert.equal((await w.ann.post('/api/v1/recipes/ingredients/match', body)).status, 200);
});

test('GET /me/export: 6 per person in 10 minutes', async () => {
  const w = await world();
  for (let i = 0; i < 6; i++) assert.equal((await w.ann.get('/api/v1/me/export')).status, 200);
  const r = await w.ann.get('/api/v1/me/export');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await w.ben.get('/api/v1/me/export')).status, 200);
});

test('GET /me/export takes the server-wide heavy slot (429 + Retry-After while an import holds it)', async () => {
  const w = await world();
  const { stage } = yazioOf(w.ctx);
  assert.ok(stage.tryHeavy());
  const busy = await w.ann.get('/api/v1/me/export');
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '3');
  for (let i = 0; i < 10; i++) assert.equal((await w.ann.get('/api/v1/me/export')).status, 429); // busy answers do not burn the export budget
  stage.releaseHeavy();
  assert.equal((await w.ann.get('/api/v1/me/export')).status, 200);
  assert.ok(stage.tryHeavy(), 'the slot is free again after an export');
  stage.releaseHeavy();
});

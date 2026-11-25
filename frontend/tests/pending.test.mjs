import test from 'node:test';
import assert from 'node:assert/strict';

const { provisionalFood, resolveFood, isPending } = await import('../src/lib/pending.ts');

const item = { source: 'bls', code: 'M123', name: 'Milchmischgetränk mit Kakao', name_en: null, brand: null, quantity: null, serving_size: null, serving_quantity: null, unit: 'ml', per_100: { kcal: 70 }, extra: {}, complete: true };
const stored = (extra = {}) => ({ ...provisionalFood(item), id: 77, pending: undefined, can_edit: false, ...extra });

test('looking at a catalogue product and going back adopts nothing', () => {
  let adopts = 0;
  const food = provisionalFood(item); // what a tap in the search creates
  assert.ok(isPending(food));
  assert.equal(food.id, 0);
  assert.equal(food.name, item.name);
  assert.equal(food.per_100.kcal, 70);
  assert.deepEqual(food.pending, { source: 'bls', code: 'M123' });
  assert.equal(adopts, 0); // no adopt function is even involved until something is saved
});

test('saving adopts exactly once, the entry gets the real id (also with a second request in flight)', async () => {
  const calls = [];
  const adopt = async (ref) => { calls.push(ref); await new Promise((r) => setTimeout(r, 5)); return stored(); };
  const food = provisionalFood(item);
  const [a, b] = await Promise.all([resolveFood(food, adopt), resolveFood(food, adopt)]);
  await resolveFood(food, adopt); // later: nothing pending any more
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { source: 'bls', code: 'M123' });
  assert.equal(a, food); assert.equal(b, food);
  assert.equal(food.id, 77);
  assert.equal(isPending(food), false);
  assert.equal(food.can_edit, false);
});

test('a failed adoption can be tried again', async () => {
  let n = 0;
  const adopt = async () => { if (++n === 1) throw new Error('offline'); return stored(); };
  const food = provisionalFood(item);
  await assert.rejects(resolveFood(food, adopt));
  await resolveFood(food, adopt);
  assert.equal(n, 2);
  assert.equal(food.id, 77);
});

test('a stored food is never adopted again', async () => {
  let n = 0;
  const food = stored();
  await resolveFood(food, async () => { n++; return food; });
  assert.equal(n, 0);
});

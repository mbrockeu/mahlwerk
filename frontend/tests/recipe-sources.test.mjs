// The mock's copies of the server rules (suggest.py, webrecipes.py) must keep behaving like the server: same cases as the Python tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rank } from '../src/lib/mockSuggest.ts';
import { interpretWeb, normaliseWeb } from '../src/lib/mockWeb.ts';

const c = (id, kcal, protein, carbs, fat) => ({ id, kcal, protein, carbs, fat, portionAmount: 100 });
const POOL = [c(1, 350, 12, 40, 14), c(2, 600, 55, 50, 18), c(3, 800, 25, 110, 25), c(4, 180, 6, 25, 5)];
const ids = (r) => r.items.map((i) => i.id);

test('protein gap moves the protein rich recipe up', () => {
  const pool = [c(1, 500, 10, 60, 15), c(2, 500, 45, 40, 15)];
  const r = rank({ kcal: 800, protein: 90, carbs: 120, fat: 40 }, pool, new Map(), 'protein', 5, false);
  assert.deepEqual(ids(r), [2, 1]);
  assert.ok(r.items[0].reasons.includes('fills_protein'));
});
test('goal reached: nothing unless asked, then light ideas up to 300 kcal', () => {
  const rest = { kcal: -40, protein: 0, carbs: -10, fat: 0 };
  assert.deepEqual(rank(rest, POOL, new Map(), 'balanced', 5, false), { state: 'goal_reached', items: [] });
  const r = rank(rest, POOL, new Map(), 'balanced', 5, true);
  assert.equal(r.state, 'goal_reached');
  assert.equal(r.items[0].kcal, Math.min(...r.items.map((i) => i.kcal)));
  assert.ok(r.items.every((i) => i.kcal <= 300));
});
test('no goal, no recipes, nothing fits', () => {
  assert.equal(rank({ kcal: null, protein: null, carbs: null, fat: null }, POOL, new Map([[1, 0]]), 'balanced', 5, false).state, 'no_goal');
  assert.equal(rank({ kcal: 500, protein: null, carbs: null, fat: null }, [], new Map(), 'balanced', 5, false).state, 'no_recipes');
  assert.equal(rank({ kcal: 60, protein: 5, carbs: 5, fat: 2 }, [c(3, 800, 25, 110, 25)], new Map(), 'balanced', 5, false).state, 'nothing_fits');
});
test('recently eaten moves back, ties go to the lower id', () => {
  const pool = [c(5, 500, 30, 50, 15), c(3, 500, 30, 50, 15), c(4, 500, 30, 50, 15)];
  assert.deepEqual(ids(rank({ kcal: 900, protein: 70, carbs: 100, fat: 40 }, pool, new Map(), 'balanced', 5, false)), [3, 4, 5]);
  assert.deepEqual(ids(rank({ kcal: 900, protein: 70, carbs: 100, fat: 40 }, pool.slice(0, 2), new Map([[3, 0]]), 'balanced', 5, false)), [5, 3]);
});

test('addresses: tracking removed, fragment dropped, odd ones refused', () => {
  const n = normaliseWeb('HTTPS://Recipes.Example.org:443/r?b=2&utm_source=x&a=1#c');
  assert.equal(n.address, 'https://recipes.example.org/r?a=1&b=2');
  for (const bad of ['ftp://recipes.example.org/x', 'https://user:pw@recipes.example.org/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://recipes.example.org:8443/x', 'nonsense'])
    assert.equal(typeof normaliseWeb(bad), 'string', bad);
});
test('whole recipe is divided by the portions, missing energy blocks', () => {
  const page = { name: 'X', portions: 4, values: { kcal: 2000, protein: 148, carbs: 292, fat: 32 }, ingredients: [] };
  const per = interpretWeb(page, { whole: false, portions: null }, 'https://a.example.org/x', 'a.example.org', null);
  assert.ok(per.warnings.includes('maybe_whole'));
  const whole = interpretWeb(page, { whole: true, portions: null }, 'https://a.example.org/x', 'a.example.org', null);
  assert.equal(whole.per_portion.kcal, 500);
  assert.equal(whole.blocked, null);
  assert.equal(interpretWeb({ ...page, values: null }, { whole: false, portions: null }, 'https://a.example.org/x', 'a.example.org', null).blocked, 'no_energy');
});

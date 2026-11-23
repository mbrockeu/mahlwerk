import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown } from '../src/lib/macroBreakdown.ts';

const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'];
const e = (id, meal, name, protein, food_id = id, brand = null) =>
  ({ id, food_id, meal, name, brand, amount: 100, unit: 'g', kcal: 100, protein, carbs: null, fat: 2 });

test('splits a macro by meal with shares, empty meals included', () => {
  const b = breakdown(MEALS, {
    breakfast: [e(1, 'breakfast', 'Quark', 12), e(2, 'breakfast', 'Brot', 8)],
    lunch: [e(3, 'lunch', 'Lachs', 30)],
    snack: [],
    dinner: [e(4, 'dinner', 'Salat', null)],
  }, 'protein');
  assert.equal(b.total, 50);
  assert.deepEqual(b.meals.map((m) => [m.meal, m.grams, m.share, m.entries]),
    [['breakfast', 20, 0.4, 2], ['lunch', 30, 0.6, 1], ['snack', 0, 0, 0], ['dinner', 0, 0, 1]]);
});

test('foods: the same food summed, largest first, capped, no zero entries', () => {
  const b = breakdown(MEALS, {
    breakfast: [e(1, 'breakfast', 'Quark', 12, 7), e(2, 'breakfast', 'Ei', 6)],
    lunch: [e(3, 'lunch', 'Quark', 12, 7), e(4, 'lunch', 'Gurke', 0)],
    snack: [e(5, 'snack', 'Riegel', 10, null, 'X'), e(6, 'snack', 'Riegel', 5, null, 'X')],
    dinner: [],
  }, 'protein', 2);
  assert.deepEqual(b.foods.map((f) => [f.name, f.grams]), [['Quark', 24], ['Riegel', 15]]);
  assert.equal(b.foods[0].share, 24 / 45);
});

test('nothing eaten: totals and shares are 0', () => {
  const b = breakdown(MEALS, { breakfast: [], lunch: [], snack: [], dinner: [] }, 'fat');
  assert.equal(b.total, 0);
  assert.ok(b.meals.every((m) => m.share === 0));
  assert.deepEqual(b.foods, []);
});

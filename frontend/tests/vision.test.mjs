// The logic around photo recognition (lib/vision.ts) and its additions to the ingredient rows (lib/ingredients.ts) and to image shrinking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMealRows, changePick, cleanName, estimateFood, estimateOf, estimatePer100, matchLine, readiness, summarize, takeEstimate } from '../src/lib/ingredients.ts';
import { failure, markNoticeSeen, noticeSeen, perPortion, photoNutrition, recipeLines, waitText } from '../src/lib/vision.ts';
import { shrinkSteps } from '../src/lib/image.ts';

const per = (kcal, protein = null) => ({ kcal, fat: null, saturated_fat: null, carbs: null, sugars: null, fiber: null, protein, salt: null });
const cand = (name, kcal = 100, protein = 10, unit = 'g') => ({ source: 'own', food_id: 1, code: null, name, brand: null, unit, per_100: per(kcal, protein) });
const item = (over = {}) => ({ name: 'Boiled rice', grams: 150, kcal: 195, protein_g: 4, fat_g: 0.4, carbs_g: 43, confidence: 0.8, ...over });
const matched = (n, text, over = {}) => ({ line: n, text, quantity: 150, unit: 'g', name: 'rice', note: null, optional: false, grams: 150, ml: null, estimated: false, basis: 'mass', candidates: [], suggestion: null, ...over });

test('a name becomes one clean line: no brackets, no line breaks, no leading count', () => {
  assert.equal(cleanName('Rice (200 g)\nboiled'), 'Rice boiled');
  assert.equal(cleanName('2 eggs'), 'eggs');
  assert.equal(cleanName('  Spätzle   mit  Soße '), 'Spätzle mit Soße');
  assert.equal(cleanName('x'.repeat(300)).length, 120);
});

test('the matcher line has the model grams in front, or only the name without a usable amount', () => {
  assert.equal(matchLine({ name: 'Boiled rice', grams: 150 }), '150 g Boiled rice');
  assert.equal(matchLine({ name: 'Boiled rice', grams: 152.34 }), '152.3 g Boiled rice');
  assert.equal(matchLine({ name: 'Sauce', grams: null }), 'Sauce');
  assert.equal(matchLine({ name: 'Sauce', grams: 0 }), 'Sauce');
  assert.equal(matchLine({ name: 'Sauce', grams: 99999 }), 'Sauce');
  assert.equal(matchLine({ name: '(…)', grams: 10 }), '10 g ?');
});

test('an estimate needs the energy and a usable amount', () => {
  assert.deepEqual(estimateOf(item()), { grams: 150, kcal: 195, protein: 4, fat: 0.4, carbs: 43 });
  assert.equal(estimateOf(item({ kcal: null })), null);
  assert.equal(estimateOf(item({ grams: null })), null);
  assert.equal(estimateOf(item({ grams: 0 })), null);
  assert.equal(estimateOf(item({ kcal: -3 })), null);
  assert.deepEqual(estimateOf(item({ protein_g: null })), { grams: 150, kcal: 195, protein: null, fat: 0.4, carbs: 43 });
});

test('values per 100 g are calculated from the amount of the estimate', () => {
  const p = estimatePer100({ grams: 250, kcal: 190, protein: 5, fat: 0.3, carbs: 40 });
  assert.equal(p.kcal, 76);
  assert.equal(p.protein, 2);
  assert.equal(p.fat, 0.12);
  assert.equal(p.carbs, 16);
  assert.equal(p.salt, null);
  assert.equal(estimatePer100({ grams: 50, kcal: 100, protein: null, fat: null, carbs: null }).protein, null);
  assert.equal(estimatePer100({ grams: 140, kcal: 230, protein: 43, fat: 5.5, carbs: 0 }).kcal, 164.29);
});

test('the own food made from an estimate: the name as recognised, grams, per 100 g', () => {
  assert.deepEqual(estimateFood('  Chicken   breast ', { grams: 100, kcal: 165, protein: 31, fat: 3.6, carbs: 0 }),
    { name: 'Chicken breast', unit: 'g', per_100: { kcal: 165, protein: 31, fat: 3.6, carbs: 0, saturated_fat: null, sugars: null, fiber: null, salt: null } });
});

test('rows: one per recognised part, with the matcher answer where there is one', () => {
  const items = [item(), item({ name: 'Sauce', grams: null, kcal: null }), item({ name: 'Beans', grams: 100, kcal: 30 })];
  const lines = [matched(1, '150 g Boiled rice', { suggestion: cand('Rice, boiled', 130, 2.5), candidates: [cand('Rice, boiled')] }), matched(3, '100 g Beans', { grams: 100 })];
  const rows = buildMealRows(items, lines);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].line.text, 'Boiled rice');           // the model's name is shown
  assert.equal(rows[0].pick.name, 'Rice, boiled');
  assert.equal(rows[0].amount, '150');
  assert.equal(rows[0].estimated, false);                    // everything is an estimate; the sheet says so once
  assert.equal(rows[0].useEstimate, false);
  assert.equal(rows[0].estimate.kcal, 195);
  assert.equal(rows[1].pick, null);                          // the matcher dropped the line: an empty row, not a vanished one
  assert.equal(rows[1].amount, '');
  assert.equal(rows[1].estimate, null);
  assert.equal(readiness(rows[1]), 'no_food');
  assert.equal(rows[2].pick, null);
  assert.equal(readiness(rows[2]), 'no_food');
  assert.equal(rows[2].amount, '100');
});

test('without a match the person can take the estimate: the row is ready and counts with the model values', () => {
  const [row] = buildMealRows([item()], [matched(1, '150 g Boiled rice')]);
  assert.equal(readiness(row), 'no_food');
  const taken = takeEstimate(row);
  assert.equal(taken.pick, null);
  assert.equal(taken.useEstimate, true);
  assert.equal(readiness(taken), 'ready');
  const s = summarize([taken]);
  assert.equal(s.ready, 1);
  assert.equal(Math.round(s.kcal), 195);
  assert.equal(Math.round(s.protein * 10) / 10, 4);
  assert.equal(taken.estimate.grams, 150);
});

test('the estimate follows a typed amount (per 100 g from the model, amount from the person)', () => {
  const [row] = buildMealRows([item()], [matched(1, '150 g Boiled rice')]);
  const taken = { ...takeEstimate(row), amount: '300' };
  assert.equal(Math.round(summarize([taken]).kcal), 390);
});

test('choosing a food after an estimate switches the estimate off; a row without estimate cannot take one', () => {
  const [row] = buildMealRows([item()], [matched(1, '150 g Boiled rice')]);
  const back = changePick(takeEstimate(row), cand('Rice', 130));
  assert.equal(back.useEstimate, false);
  assert.equal(back.pick.name, 'Rice');
  const [bare] = buildMealRows([item({ kcal: null })], [matched(1, '150 g Boiled rice')]);
  assert.equal(takeEstimate(bare), bare);
  assert.equal(readiness(takeEstimate(bare)), 'no_food');
});

test('the sum counts energy and protein of the ready rows only', () => {
  const rows = buildMealRows([item(), item({ name: 'Beans', grams: 100, kcal: 30, protein_g: 2 }), item({ name: 'Skipped' })], [
    matched(1, '150 g Boiled rice', { suggestion: cand('Rice', 130, 2.5) }), matched(2, '100 g Beans', { grams: 100, suggestion: cand('Beans', 30, 2) }), matched(3, 'x', { suggestion: cand('Skipped', 500, 50) }),
  ]);
  rows[2] = { ...rows[2], skipped: true };
  const s = summarize(rows);
  assert.equal(s.ready, 2);
  assert.equal(s.skipped, 1);
  assert.equal(Math.round(s.kcal), 225);          // 130 * 1.5 + 30
  assert.equal(Math.round(s.protein * 100) / 100, 5.75); // 2.5 * 1.5 + 2
});

test('recipe lines: trimmed, no empty ones, at most 80 of 300 characters', () => {
  assert.deepEqual(recipeLines({ ingredients: ['  200 g  flour ', '', '   ', '2 eggs'] }), ['200 g flour', '2 eggs']);
  assert.equal(recipeLines({ ingredients: Array.from({ length: 100 }, (_, i) => `${i + 1} g x`) }).length, 80);
  assert.equal(recipeLines({ ingredients: ['a'.repeat(400)] })[0].length, 300);
});

test('values printed on a recipe photo count only with an energy value', () => {
  assert.equal(photoNutrition({ nutrition_per_portion: null }), null);
  assert.equal(photoNutrition({ nutrition_per_portion: { kcal: null, protein_g: 5, fat_g: null, carbs_g: null } }), null);
  assert.equal(photoNutrition({ nutrition_per_portion: { kcal: 160, protein_g: null, fat_g: null, carbs_g: null } }).kcal, 160);
});

test('per portion: the sum divided by the portions, nothing without them', () => {
  assert.equal(perPortion(640, 4), 160);
  assert.equal(perPortion(640, 0), null);
  assert.equal(perPortion(640, null), null);
  assert.equal(perPortion(null, 4), null);
  assert.equal(perPortion(100, 0.5), 200);
});

test('failures: which text, and how long to wait', () => {
  assert.deepEqual(failure(429, 8), { code: 'busy', wait: 8 });
  assert.deepEqual(failure(429, null), { code: 'busy', wait: 10 });
  assert.equal(failure(429, 99999).wait, 3600);
  assert.equal(failure(413, null).code, 'toolarge');
  assert.equal(failure(422, null).code, 'unreadable');
  assert.equal(failure(504, null).code, 'timeout');
  assert.equal(failure(502, null).code, 'failed');
  assert.equal(failure(0, null, false).code, 'offline');
  assert.equal(failure(0, null, true).code, 'failed');
  assert.equal(failure(403, null).code, 'blocked');
  assert.equal(failure(404, null).code, 'off');
  assert.equal(failure(409, null).code, 'off');
  assert.equal(failure(500, null).code, 'other');
});

test('the wait of a 429 in seconds or minutes', () => {
  assert.deepEqual(waitText(8), { n: 8, unit: 's' });
  assert.deepEqual(waitText(89), { n: 89, unit: 's' });
  assert.deepEqual(waitText(120), { n: 2, unit: 'min' });
  assert.deepEqual(waitText(0), { n: 1, unit: 's' });
});

test('the privacy notice is remembered per device; blocked storage never breaks it', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(noticeSeen(), false);
  markNoticeSeen();
  assert.equal(noticeSeen(), true);
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(noticeSeen(), false);
  assert.doesNotThrow(markNoticeSeen);
  delete globalThis.localStorage;
});

test('shrinking: recipe pictures keep their ladder, a photo for the model starts at the given edge', () => {
  assert.deepEqual(shrinkSteps().map((s) => s[0]), [2000, 1800, 1600, 1400, 1200]);
  assert.deepEqual(shrinkSteps(1600).map((s) => s[0]), [1600, 1400, 1200]);
  assert.equal(shrinkSteps(1600)[0][1], 0.8);
  assert.deepEqual(shrinkSteps(1000).map((s) => s[0]), [1000]);
});

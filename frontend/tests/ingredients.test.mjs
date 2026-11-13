// The logic of "Paste ingredient list" (lib/ingredients.ts) and the mock's small reader of ingredient lines (lib/mockIngredients.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { amountText, changePick, makeRow, readAmount, readiness, suggestAmount, summarize } from '../src/lib/ingredients.ts';
import { candidatesFor, mockMatch, parseLine } from '../src/lib/mockIngredients.ts';

const per = (kcal) => ({ kcal, fat: null, saturated_fat: null, carbs: null, sugars: null, fiber: null, protein: null, salt: null });
const cand = (name, unit = 'g', kcal = 100, id = 1) => ({ source: 'own', food_id: id, code: null, name, brand: null, unit, per_100: per(kcal) });
const line = (over = {}) => ({ line: 1, text: '200 g flour', quantity: 200, unit: 'g', name: 'flour', note: null, optional: false, grams: 200, ml: null, estimated: false, basis: 'mass', candidates: [], suggestion: null, ...over });

test('amount for a food in g: the grams of the line, estimate flag kept', () => {
  assert.deepEqual(suggestAmount({ grams: 110, ml: null, estimated: true }, 'g'), { amount: 110, estimated: true });
  assert.deepEqual(suggestAmount({ grams: 200, ml: null, estimated: false }, 'g'), { amount: 200, estimated: false });
  assert.deepEqual(suggestAmount({ grams: null, ml: null, estimated: false }, 'g'), { amount: null, estimated: false });
});

test('amount for a food in ml: ml where known, else grams as a guess', () => {
  assert.deepEqual(suggestAmount({ grams: 257.5, ml: 250, estimated: false }, 'ml'), { amount: 250, estimated: false });
  assert.deepEqual(suggestAmount({ grams: 200, ml: null, estimated: false }, 'ml'), { amount: 200, estimated: true });
  assert.deepEqual(suggestAmount({ grams: null, ml: null, estimated: false }, 'ml'), { amount: null, estimated: false });
});

test('amount text has at most one decimal', () => {
  assert.equal(amountText(13.8), '13.8');
  assert.equal(amountText(0.4), '0.4');
  assert.equal(amountText(396.9), '396.9');
  assert.equal(amountText(12.04), '12');
  assert.equal(amountText(null), '');
});

test('typed amounts: comma or dot, above zero, a sane size', () => {
  assert.equal(readAmount('12,5'), 12.5);
  assert.equal(readAmount(' 200 '), 200);
  for (const bad of ['', ' ', '0', '-3', 'abc', '1e9', '20001', 'NaN', 'Infinity']) assert.equal(readAmount(bad), null, bad);
});

test('a row starts with the suggestion and its amount', () => {
  const row = makeRow(line({ suggestion: cand('Flour'), grams: 110, estimated: true }));
  assert.equal(row.pick.name, 'Flour');
  assert.equal(row.amount, '110');
  assert.equal(row.estimated, true);
  assert.equal(readiness(row), 'ready');
});

test('lines without food or amount do not block the others', () => {
  const rows = [
    makeRow(line({ suggestion: cand('Flour'), grams: 200 })),
    makeRow(line({ line: 2, suggestion: null, grams: 50 })),
    makeRow(line({ line: 3, suggestion: cand('Salt'), grams: null })),
    { ...makeRow(line({ line: 4, suggestion: cand('Egg'), grams: 55 })), skipped: true },
  ];
  assert.deepEqual(rows.map(readiness), ['ready', 'no_food', 'no_amount', 'skipped']);
  const s = summarize(rows);
  assert.deepEqual({ ready: s.ready, noFood: s.noFood, noAmount: s.noAmount, skipped: s.skipped }, { ready: 1, noFood: 1, noAmount: 1, skipped: 1 });
  assert.equal(s.kcal, 200); // 200 g at 100 kcal per 100 g
});

test('the total is unknown when no ready ingredient states energy', () => {
  const row = makeRow(line({ suggestion: { ...cand('Water'), per_100: per(null) }, grams: 100 }));
  assert.equal(summarize([row]).kcal, null);
});

test('choosing another food keeps a typed amount but follows an estimate to the new unit', () => {
  const estimated = makeRow(line({ suggestion: cand('Milk'), grams: 200, ml: 194, estimated: true }));
  assert.equal(changePick(estimated, cand('Oat drink', 'ml')).amount, '194');
  const typed = { ...estimated, amount: '150', estimated: false };
  assert.equal(changePick(typed, cand('Oat drink', 'ml')).amount, '150');
  const empty = makeRow(line({ suggestion: null, grams: 80, estimated: false }));
  assert.equal(changePick({ ...empty, amount: '' }, cand('Salt')).amount, '80');
});

// the mock's reader
const mock = (text) => parseLine(text);

test('mock reader: mass, volume, pieces, brackets, notes', () => {
  assert.equal(mock('200 g Mehl').grams, 200);
  assert.equal(mock('1,5 kg Kartoffeln').grams, 1500);
  const oil = mock('2 EL Olivenöl');
  assert.equal(oil.ml, 30);
  assert.equal(oil.grams, 27.6);
  assert.equal(oil.estimated, false);
  assert.equal(mock('1 EL Zimt').estimated, true);
  assert.deepEqual([mock('2 Eier').grams, mock('2 Eier').estimated, mock('2 Eier').basis], [110, true, 'piece']);
  const can = mock('1 Dose Tomaten (400 g)');
  assert.deepEqual([can.grams, can.basis, can.estimated], [400, 'explicit', false]);
  assert.equal(mock('2 Zwiebeln, fein gehackt').note, 'fein gehackt');
  assert.equal(mock('2-3 EL Öl').quantity, 2.5);
  assert.equal(mock('1 1/2 cups flour').quantity, 1.5);
  assert.equal(mock('½ l Milch').quantity, 0.5);
  assert.equal(mock('Salz').grams, null);
  assert.equal(mock('Für den Teig:'), null);
});

// the same numbers as the server (tests/test_ingredients.py): the screenshots and the demo must not disagree with it
test('mock reader gives the server\'s grams for the common examples', () => {
  const g = (text) => mock(text).grams;
  assert.equal(g('1 TL Salz'), 6);
  assert.equal(g('1 Prise Salz'), 0.5);
  assert.equal(g('½ Bund Petersilie'), 25);
  assert.equal(g('1 Dose Tomaten'), 400);
  assert.equal(g('2 Knoblauchzehen'), null); // the server knows the compound, the mock does not: no number rather than a wrong one
  assert.equal(g('2 Zehen Knoblauch'), 8);
  assert.equal(g('1 EL Honig'), 21.3);
  assert.equal(g('250 ml Milch'), 257.5);
  assert.equal(g('2 Eier'), 110);
  assert.equal(g('200 g Mehl'), 200);
});

test('mock reader survives rubbish', () => {
  for (const text of ['', '   ', '((((', '1/0 g x', '99999999999999999999 g Mehl', '<b>2 g</b>', '٣ g Mehl', '🙂']) {
    assert.doesNotThrow(() => mock(text), text);
  }
});

test('mock matching: own foods first, then basic foods, at most five', () => {
  const food = (id, name, source = 'own') => ({ id, name, brand: null, code: null, source, unit: 'g', per_100: per(300) });
  const item = (name, source = 'bls', code = name) => ({ source, code, name, name_en: null, brand: null, unit: 'g', per_100: per(30) });
  const pool = { own: [food(1, 'Mehl Type 550'), food(2, 'Rezept Mehlspeise', 'recipe')], catalog: [item('Weizenmehl'), item('Mehl gemischt'), item('Mehlkloß', 'openfoodfacts')] };
  const found = candidatesFor('Mehl', pool);
  assert.equal(found[0].food_id, 1);
  assert.ok(found.every((c) => c.name !== 'Rezept Mehlspeise'));
  assert.ok(found.length <= 5);
  const out = mockMatch('200 g Mehl\n\nFür den Teig:\nZahnstocher', pool);
  assert.equal(out.lines.length, 2);
  assert.equal(out.ignored, 1);
  assert.equal(out.lines[1].suggestion, null);
});

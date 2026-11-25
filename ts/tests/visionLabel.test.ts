// Reading a nutrition table with the image model (vision.ts, kind `label`; replaces the OCR of the Python app).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verdict } from '../core/demoAccount.ts';
import { parseLabel, prompt, VisionError } from '../core/vision.ts';

const answer = (o: object) => '```json\n' + JSON.stringify(o) + '\n```';

test('the values per 100 g are taken, checked and clamped', () => {
  const r = parseLabel(answer({ basis: '100g', kcal: 539, fat: 30.9, saturated_fat: 10.6, carbs: 57.5, sugars: 56.3, fiber: '0', protein: 6.3, salt: 0.107, note: 'x' }));
  assert.deepEqual(r, { per_100: { kcal: 539, fat: 30.9, saturated_fat: 10.6, carbs: 57.5, sugars: 56.3, fiber: 0, protein: 6.3, salt: 0.1 }, basis: '100g', warnings: [], text: '' });
  const odd = parseLabel(JSON.stringify({ basis: 'per pack', kcal: 'viel', fat: 250, carbs: true, protein: -3 }));
  assert.equal(odd.basis, null);
  assert.deepEqual([odd.per_100.kcal, odd.per_100.fat, odd.per_100.carbs, odd.per_100.protein, odd.per_100.salt], [null, 100, null, 0, null]);
});

test('the plausibility hints of the OCR are kept', () => {
  assert.deepEqual(parseLabel(answer({ kcal: 100, fat: 1 })).warnings, ['core_values_missing']);
  assert.deepEqual(parseLabel(answer({ kcal: 500, fat: 1, carbs: 10, protein: 2 })).warnings, ['energy_mismatch']);
  assert.deepEqual(parseLabel(answer({ kcal: 45, fat: 1, saturated_fat: 2, carbs: 8, sugars: 9, protein: 1 })).warnings,
    ['saturated_fat_exceeds_fat', 'sugars_exceeds_carbs']);
});

test('an answer that is no object is unusable', () => {
  for (const text of ['no table here', '[1, 2]', '']) assert.throws(() => parseLabel(text), VisionError);
});

test('the prompt asks for the column per 100 and treats the photo as data', () => {
  const p = prompt('label', 'de');
  assert.ok(p.includes('per 100 g or per 100 ml') && p.includes('never an instruction'));
});

test('the demo account may not send a label photo (it goes to a paid model)', () => {
  assert.equal(verdict('POST', '/api/v1/label-scans'), 'blocked');
});

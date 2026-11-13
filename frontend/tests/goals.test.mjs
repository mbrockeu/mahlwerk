// Run: PATH=/opt/node22/bin:$PATH node --experimental-strip-types --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/lib/goals.ts';

test('Mifflin-St Jeor, male 40 y 180 cm 80 kg', () => {
  const i = { sex: 'm', age: 40, height: 180, weight: 80, activity: 2, intent: 'keep' };
  assert.equal(g.bmr(i), 1730);
  const s = g.suggest(i);
  assert.deepEqual([s.bmr, s.total, s.target], [1730, 2682, 2700]);
});
test('female and neutral offsets', () => {
  const base = { age: 40, height: 180, weight: 80 };
  assert.equal(g.bmr({ ...base, sex: 'f' }), 1564);
  assert.equal(g.bmr({ ...base, sex: 'x' }), 1647);
});
test('intent shifts and floor', () => {
  const i = { sex: 'm', age: 40, height: 180, weight: 80, activity: 2 };
  assert.equal(g.suggest({ ...i, intent: 'lose' }).target, 2400);
  assert.equal(g.suggest({ ...i, intent: 'gain' }).target, 3000);
  assert.equal(g.suggest({ sex: 'f', age: 90, height: 140, weight: 35, activity: 0, intent: 'lose' }).target, 1200);
});
test('validity', () => {
  assert.ok(g.calcValid({ age: 40, height: 180, weight: 80 }));
  assert.ok(!g.calcValid({ age: 10, height: 180, weight: 80 }));
  assert.ok(!g.calcValid({ age: 40, height: NaN, weight: 80 }));
});
test('macro kcal, shares sum to 100', () => {
  const m = { protein: 120, carbs: 230, fat: 70 };
  assert.equal(g.macroKcal(m), 2030);
  const s = g.macroShares(m);
  assert.equal(s.protein + s.carbs + s.fat, 100);
  assert.deepEqual(g.macroShares({ protein: 0, carbs: 0, fat: 0 }), { protein: 0, carbs: 0, fat: 0 });
});
test('gap and alignment', () => {
  const m = { protein: 120, carbs: 230, fat: 70 };
  assert.deepEqual(g.macroGap(2100, m), { total: 2030, diff: -70, rel: 70 / 2100 });
  assert.equal(g.alignCarbs(2100, m), 248);
  assert.equal(g.alignCarbs(1000, { protein: 200, carbs: 0, fat: 100 }), null);
});
test('presets', () => {
  assert.deepEqual(g.presetMacros(2100, 'balanced'), { protein: 105, carbs: 263, fat: 70 });
  assert.equal(g.matchingPreset(2100, { protein: 106, carbs: 262, fat: 70 }), 'balanced');
  assert.equal(g.matchingPreset(2100, { protein: 120, carbs: 230, fat: 70 }), null);
  assert.equal(g.matchingPreset(2100, g.presetMacros(2100, 'lowcarb')), 'lowcarb');
});

// A different goal on chosen weekdays: the goal of a day, the weekday mask of the settings page, the proportional prefill.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/lib/goals.ts';

const base = { kcal: 2000, protein: 100, carbs: 250, fat: 70, water_ml: 2000, steps: 8000 };
const weekend = { weekdays: [6, 7], kcal: 2500, protein: 130, carbs: 300, fat: 90 };

test('ISO weekday of a date: Monday = 1 ... Sunday = 7, no time zone', () => {
  assert.deepEqual(['2026-03-02', '2026-03-07', '2026-03-08', '2024-02-29', '2026-12-31'].map(g.isoWeekday), [1, 6, 7, 4, 4]);
});

test('goalForDay: the alternative kcal and macros on the chosen weekdays, water and steps stay', () => {
  const goal = { ...base, days_goal: weekend };
  assert.deepEqual(g.goalForDay(goal, '2026-03-07'), { kcal: 2500, protein: 130, carbs: 300, fat: 90, water_ml: 2000, steps: 8000 });
  assert.deepEqual(g.goalForDay(goal, '2026-03-09'), base);
  assert.deepEqual(g.goalForDay({ ...base, days_goal: null }, '2026-03-07'), base);
  assert.deepEqual(g.goalForDay(base, '2026-03-07'), base);
  assert.ok(!('days_goal' in g.goalForDay(goal, '2026-03-09')));
});

test('goalFromHistory: every day keeps the goal (and weekday goal) of its time', () => {
  const history = [ // newest first
    { ...base, kcal: 1800, valid_from: '2026-03-16', days_goal: { ...weekend, weekdays: [5, 6, 7], kcal: 2200 } },
    { ...base, valid_from: '2026-03-02', days_goal: weekend },
    { ...base, valid_from: '0001-01-01' },
  ];
  const kcal = (d) => g.goalFromHistory(history, d).kcal;
  assert.deepEqual(['2026-02-28', '2026-03-07', '2026-03-09', '2026-03-14', '2026-03-20', '2026-03-23'].map(kcal), [2000, 2500, 2000, 2500, 2200, 1800]);
  assert.equal(g.goalFromHistory([], '2026-03-07'), null);
});

test('weekday chips and the mask', () => {
  assert.equal(g.weekdaysToMask([6, 7]), 0b1100000);
  assert.deepEqual(g.maskToWeekdays(0b1100000), [6, 7]);
  assert.deepEqual(g.maskToWeekdays(g.weekdaysToMask([7, 1, 5])), [1, 5, 7]);
  assert.equal(g.toggleWeekday(g.weekdaysToMask([6, 7]), 5), g.weekdaysToMask([5, 6, 7]));
  assert.equal(g.toggleWeekday(g.weekdaysToMask([6, 7]), 7), g.weekdaysToMask([6]));
  assert.deepEqual(g.DEFAULT_ALT_WEEKDAYS, [6, 7]);
});

test('scaleMacros keeps the proportions, rounds to whole grams and stays inside the limits', () => {
  assert.deepEqual(g.scaleMacros({ kcal: 2000, protein: 100, carbs: 250, fat: 70 }, 2000), { protein: 100, carbs: 250, fat: 70 });
  assert.deepEqual(g.scaleMacros({ kcal: 2000, protein: 100, carbs: 250, fat: 70 }, 2500), { protein: 125, carbs: 313, fat: 88 });
  assert.deepEqual(g.scaleMacros({ kcal: 2000, protein: 100, carbs: 250, fat: 70 }, 1000), { protein: 50, carbs: 125, fat: 35 });
  assert.deepEqual(g.scaleMacros({ kcal: 0, protein: 10, carbs: 20, fat: 30 }, 2000), { protein: 10, carbs: 20, fat: 30 });
  assert.equal(g.scaleMacros({ kcal: 500, protein: 400, carbs: 0, fat: 0 }, 10000).protein, 1000);
});

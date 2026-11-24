import test from 'node:test';
import assert from 'node:assert/strict';
import * as tr from '../src/lib/training.ts';

const w = (day, minutes) => ({ day, minutes });

test('a training day needs 10 minutes in total; several workouts are one day', () => {
  assert.deepEqual([...tr.trainingDays([w('a', 9.9), w('b', 10), w('c', 6), w('c', 4)])].sort(), ['b', 'c']);
});

test('weeks run Monday to Sunday', () => {
  assert.equal(tr.weekStart('2025-03-09'), '2025-03-03'); // Sunday
  assert.equal(tr.weekStart('2025-03-10'), '2025-03-10'); // Monday
  assert.equal(tr.weekNumber('2025-03-10'), tr.weekNumber('2025-03-09') + 1);
  assert.equal(tr.weekNumber('2025-01-01'), tr.weekNumber('2024-12-30')); // across the year boundary
});

test('week block: days, done, goal off', () => {
  const trained = tr.trainingDays([w('2025-03-03', 30), w('2025-03-05', 12), w('2025-03-12', 30)]);
  assert.equal(tr.weekBlock(trained, 0, '2025-03-05'), null);
  assert.deepEqual(tr.weekBlock(trained, 3, '2025-03-07'), { goal: 3, days: [true, false, true, false, false, false, false], done: 2, streak: 0 });
});

test('streak: ends with this week when reached, else with the week before; a gap breaks it', () => {
  const plus2 = (day) => new Date(Date.parse(day) + 2 * 86400000).toISOString().slice(0, 10);
  const two = (mon) => [w(mon, 30), w(plus2(mon), 30)]; // Monday and Wednesday
  const trained = tr.trainingDays([...two('2025-03-03'), ...two('2025-03-10'), w('2025-03-17', 30)]);
  assert.equal(tr.weekBlock(trained, 2, '2025-03-19').streak, 2); // the third week is still open
  const more = tr.trainingDays([...two('2025-03-03'), ...two('2025-03-10'), ...two('2025-03-17')]);
  assert.equal(tr.weekBlock(more, 2, '2025-03-19').streak, 3);
  const gap = tr.trainingDays([...two('2025-03-03'), ...two('2025-03-17')]);
  assert.equal(tr.weekBlock(gap, 2, '2025-03-19').streak, 1);
  assert.equal(tr.weekBlock(gap, 2, '2025-03-12').streak, 1); // an empty week shown: the weeks before still count
});

test('training summary: weeks of the whole calendar weeks, inside figures, threshold of 5 days per side', () => {
  const none = tr.trainingSummary('2025-03-05', '2025-03-11', [], 0, [], () => ({ kcal: 0, protein: 0 }), () => null, null);
  assert.equal(none, null);
  const ws = ['2025-03-03', '2025-03-04', '2025-03-06', '2025-03-12'].map((d) => w(d, 30));
  const s = tr.trainingSummary('2025-03-05', '2025-03-11', ws, 3, [], () => ({ kcal: 0, protein: 0 }), () => null, null);
  assert.deepEqual(s.weeks, [{ week_start: '2025-03-03', training_days: 3 }, { week_start: '2025-03-10', training_days: 1 }]);
  assert.equal(s.training_days, 1);
  assert.equal(s.workout_minutes, 30);
  assert.equal(s.goal, 3);

  const days = Array.from({ length: 10 }, (_, i) => `2025-03-${String(i + 1).padStart(2, '0')}`);
  const totals = (d) => ({ kcal: ws2.has(d) ? 2200 : 1800, protein: 100 });
  const five = days.slice(0, 5).map((d) => w(d, 20));
  const ws2 = new Set(five.map((x) => x.day));
  const ok = tr.trainingSummary(days[0], days[9], five, 0, days, totals, () => 2000, null);
  assert.deepEqual(ok.trained, { days: 5, kcal: 2200, protein: 100, kcal_vs_goal: 200 });
  assert.equal(ok.rest.kcal, 1800);
  assert.equal(ok.goal, null);
  const few = tr.trainingSummary(days[0], days[9], five.slice(0, 4), 0, days, totals, () => 2000, null);
  assert.deepEqual(few.trained, { days: 4, kcal: null, protein: null, kcal_vs_goal: null });
  const todayOut = tr.trainingSummary(days[0], days[9], five, 0, days, totals, () => 2000, days[9]);
  assert.equal(todayOut.rest.days, 4); // today is not over
  assert.equal(todayOut.rest.kcal, null);
});

test('the bar scale always fits the goal and never drops below 3', () => {
  assert.equal(tr.barScale([{ training_days: 1 }], null), 3);
  assert.equal(tr.barScale([{ training_days: 2 }], 5), 5);
  assert.equal(tr.barScale([{ training_days: 6 }], 3), 6);
});

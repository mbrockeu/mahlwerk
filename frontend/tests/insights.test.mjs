import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/lib/insightsRange.ts';

const TODAY = '2026-11-12';
const q = (s) => r.parseQuery(new URLSearchParams(s), TODAY);

test('presets end today and count back', () => {
  assert.deepEqual(r.period(q('range=7'), TODAY), { from: '2026-11-06', to: TODAY });
  assert.deepEqual(r.period(q(''), TODAY), { from: '2026-10-14', to: TODAY });
  assert.equal(r.period(q('range=all'), TODAY), null);
  assert.deepEqual(r.period(q('range=bogus'), TODAY), { from: '2026-10-14', to: TODAY });
});

test('custom ranges are validated: dates, order, ten years', () => {
  assert.deepEqual(r.period(q('range=custom&from=2026-02-01&to=2026-02-28'), TODAY), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(r.period(q('range=custom&from=2026-02-30&to=2026-03-01'), TODAY), null);
  assert.equal(r.period(q('range=custom&from=2026-03-02&to=2026-03-01'), TODAY), null);
  assert.equal(r.period(q('range=custom&from=2014-01-01&to=2025-01-01'), TODAY), null);
  assert.notEqual(r.period(q('range=custom&from=2016-01-01&to=2025-12-31'), TODAY), null);
});

test('the query survives a round trip through the URL', () => {
  const original = { range: 'custom', from: '2026-01-01', to: '2026-03-31', g: 'week', compare: true };
  assert.deepEqual(q(new URLSearchParams(r.toParams(original)).toString()), original);
  assert.deepEqual(r.toParams(q('range=90')), { range: '90' });
});

test('moving by the period length, forward only up to today', () => {
  assert.deepEqual(r.shifted({ from: '2026-10-14', to: TODAY }, -1, TODAY), { from: '2026-09-14', to: '2026-10-13' });
  assert.deepEqual(r.shifted({ from: '2026-09-14', to: '2026-10-13' }, 1, TODAY), { from: '2026-10-14', to: TODAY });
  assert.deepEqual(r.shifted({ from: '2026-10-20', to: '2026-11-05' }, 1, TODAY), { from: '2026-10-27', to: TODAY });
});

test('zooming: months open as weeks, weeks as days, days leave the view', () => {
  const sec = { start: '2026-02-01', end: '2026-02-28' };
  assert.deepEqual(r.zoomTarget('month', sec), { from: sec.start, to: sec.end, g: 'week' });
  assert.equal(r.zoomTarget('week', sec).g, 'day');
  assert.equal(r.zoomTarget('day', sec), null);
});

test('auto granularity mirrors the server', () => {
  assert.deepEqual([1, 45, 46, 370, 371].map(r.autoGran), ['day', 'day', 'week', 'week', 'month']);
});

test('macro shares are shares of the energy', () => {
  const s = r.macroShares({ protein: 100, carbs: 250, fat: 70 });
  assert.ok(Math.abs(s.protein + s.carbs + s.fat - 1) < 1e-9);
  assert.ok(Math.abs(s.fat - 630 / 2030) < 1e-9);
  assert.deepEqual(r.macroShares({ protein: 0, carbs: 0, fat: 0 }), { protein: 0, carbs: 0, fat: 0 });
});

test('label positions include first and last and never repeat', () => {
  assert.deepEqual(r.labelIndexes(10, 4), [0, 3, 6, 9]);
  assert.deepEqual(r.labelIndexes(2, 8), [0, 1]);
  assert.deepEqual(r.labelIndexes(1, 8), [0]);
  assert.deepEqual(r.labelIndexes(0, 8), []);
});

test('calendar cells: weeks are columns, Monday is row 0', () => {
  assert.deepEqual(r.calendarCell('2026-11-12', '2026-11-12'), { col: 0, row: 3 }); // a Thursday
  assert.deepEqual(r.calendarCell('2026-11-12', '2026-11-15'), { col: 0, row: 6 });
  assert.deepEqual(r.calendarCell('2026-11-12', '2026-11-16'), { col: 1, row: 0 });
  assert.deepEqual(r.calendarCell('2026-11-09', '2026-11-22'), { col: 1, row: 6 });
});

test('delta arrows', () => {
  assert.deepEqual([5, -1, 0].map(r.deltaArrow), ['↑', '↓', '=']);
});

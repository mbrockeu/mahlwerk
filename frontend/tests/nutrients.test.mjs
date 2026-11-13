import test from 'node:test';
import assert from 'node:assert/strict';
import * as n from '../src/lib/nutrientCompare.ts';

const goal = { kcal: 2100, protein: 120, carbs: 230, fat: 70 };
const NRV = { magnesium: 375, calcium: 800, vitamin_c: 80, sodium: null };
const ref = (k) => n.refOf(k, goal, NRV[k] ?? null);

test('selection from the URL: valid, unique, known, at most four, in order', () => {
  assert.deepEqual(n.parsePick('magnesium,iron,zinc'), ['magnesium', 'iron', 'zinc']);
  assert.deepEqual(n.parsePick('iron,iron, iron ,zinc'), ['iron', 'zinc']);
  assert.deepEqual(n.parsePick('a1,b,c,d,e,f'), ['a1', 'b', 'c', 'd']);
  assert.deepEqual(n.parsePick('Bad Key,../x,;drop,iron'), ['iron']);
  assert.deepEqual(n.parsePick(''), []);
  assert.deepEqual(n.parsePick(null), []);
  assert.deepEqual(n.parsePick('iron,nonsense,zinc', new Set(['iron', 'zinc'])), ['iron', 'zinc']);
  assert.equal(n.pickParam(['iron', 'zinc']), 'iron,zinc');
});

test('references: personal goal for the four goal values, NRV for the rest, nothing invented', () => {
  assert.deepEqual(n.refOf('protein', goal, null), { value: 120, kind: 'goal' });
  assert.deepEqual(n.refOf('kcal', goal, null), { value: 2100, kind: 'goal' });
  assert.equal(n.refOf('protein', null, null), null); // no goal set
  assert.equal(n.refOf('protein', goal, 50)?.kind, 'goal');
  assert.deepEqual(n.refOf('magnesium', goal, 375), { value: 375, kind: 'nrv' });
  for (const k of ['fiber', 'sugars', 'salt', 'saturated_fat', 'sodium']) assert.equal(n.refOf(k, goal, null), null);
  assert.equal(n.refOf('x', goal, 0), null);
});

test('normalizing: empty falls back, several keep only nutrients with a reference, never empty', () => {
  assert.deepEqual(n.normalizePick([], ref), ['fiber']);
  assert.deepEqual(n.normalizePick(['fiber'], ref), ['fiber']);
  assert.deepEqual(n.normalizePick(['magnesium', 'fiber', 'calcium'], ref), ['magnesium', 'calcium']);
  assert.deepEqual(n.normalizePick(['fiber', 'sodium'], ref), ['fiber']);
  assert.deepEqual(n.normalizePick(['fiber', 'magnesium'], ref), ['magnesium']);
});

test('toggling: limit of four, last one stays, no-reference nutrients only alone', () => {
  assert.deepEqual(n.togglePick(['magnesium'], 'calcium', ref), ['magnesium', 'calcium']);
  assert.deepEqual(n.togglePick(['magnesium', 'calcium'], 'magnesium', ref), ['calcium']);
  assert.deepEqual(n.togglePick(['magnesium'], 'magnesium', ref), ['magnesium']);
  const four = ['magnesium', 'calcium', 'vitamin_c', 'protein'];
  assert.deepEqual(n.togglePick(four, 'kcal', ref), four);
  assert.equal(n.blockedReason(four, 'kcal', ref), 'max');
  assert.equal(n.blockedReason(four, 'fiber', ref), 'noref');
  assert.equal(n.blockedReason(['magnesium', 'calcium'], 'fiber', ref), 'noref');
  assert.deepEqual(n.togglePick(['magnesium', 'calcium'], 'fiber', ref), ['magnesium', 'calcium']);
  assert.equal(n.blockedReason(['magnesium'], 'calcium', ref), null);
  assert.equal(n.blockedReason(['magnesium'], 'magnesium', ref), 'last');
  assert.equal(n.blockedReason(['magnesium', 'calcium'], 'magnesium', ref), null);
  // a lone nutrient without reference: another without one replaces it, one with a reference replaces it too
  assert.deepEqual(n.togglePick(['fiber'], 'salt', ref), ['salt']);
  assert.deepEqual(n.togglePick(['fiber'], 'magnesium', ref), ['magnesium']);
  assert.equal(n.blockedReason(['fiber'], 'salt', ref), null);
});

test('groups of the picker', () => {
  assert.equal(n.pickGroup('fiber', 'core'), 'macro');
  assert.equal(n.pickGroup('protein', 'core'), 'macro');
  assert.equal(n.pickGroup('magnesium', 'mineral'), 'mineral');
  assert.equal(n.pickGroup('vitamin_c', 'vitamin'), 'vitamin');
  for (const g of ['fat', 'carb', 'other']) assert.equal(n.pickGroup('x', g), 'other');
});

const sec = (day, average, coverage) => ({ start: day, end: day, average, coverage });

test('points: percent of the reference, gaps stay gaps, low coverage is flagged', () => {
  const pts = n.pointsOf([sec('2026-11-01', 300, 0.9), sec('2026-11-02', null, 0), sec('2026-11-03', 0, 0), sec('2026-11-04', 75, 0.1), sec('2026-11-05', 0, 0.5)], { value: 375, kind: 'nrv' });
  assert.deepEqual(pts.map((p) => p.known), [true, false, false, true, true]);
  assert.equal(pts[0].pct, 80);
  assert.equal(pts[1].value, null);
  assert.equal(pts[1].pct, null);
  assert.equal(pts[2].value, null); // mean without any calorie carrying the value: unknown, not 0
  assert.equal(pts[3].low, true);
  assert.equal(pts[0].low, false);
  assert.equal(pts[4].pct, 0); // known and really zero
  assert.equal(n.pointsOf([sec('d', 5, 1)], null)[0].pct, null);
});

test('axis: nice maxima, the 100 % line always fits', () => {
  assert.equal(n.niceMax(0.7), 1);
  assert.equal(n.niceMax(1.2), 2);
  assert.equal(n.niceMax(2.3), 2.5);
  assert.equal(n.niceMax(130), 200);
  assert.equal(n.niceMax(100), 100);
  assert.equal(n.percentMax(0), 200); // 110 -> 200
  assert.equal(n.percentMax(60), 200);
  assert.equal(n.percentMax(180), 200);
  assert.equal(n.percentMax(190), 250);
  assert.equal(n.percentMax(2200), 2500);
  for (const m of [0, 50, 99, 100, 150, 450, 999]) assert.ok(n.percentMax(m) >= Math.max(m, 100) * 1.1 - 1e-9);
});

test('end labels keep their distance and stay inside', () => {
  assert.deepEqual(n.spreadLabels([100, 100, 100], 14, 0, 300), [100, 114, 128]);
  assert.deepEqual(n.spreadLabels([50], 14, 0, 300), [50]);
  const r = n.spreadLabels([290, 295, 300, 20], 14, 10, 300);
  assert.equal(r[3], 20); // the input order is kept
  const sorted = [r[0], r[1], r[2]].sort((a, b) => a - b);
  assert.ok(sorted[1] - sorted[0] >= 14 - 1e-9 && sorted[2] - sorted[1] >= 14 - 1e-9 && sorted[2] <= 300);
  assert.deepEqual(n.spreadLabels([], 14, 0, 10), []);
  assert.equal(n.markerStride(30), 1);
  assert.equal(n.markerStride(5), 3);
  assert.equal(n.markerStride(0), 14);
});

test('summary: exact range figures when there are some, else the mean of the sections; coverage flags low', () => {
  const series = [sec('a', 100, 0.5), sec('b', 200, 0.1), sec('c', null, 0)];
  const r = { value: 400, kind: 'nrv' };
  const withMicro = n.summaryOf('magnesium', series, r, [{ key: 'magnesium', average: 180, coverage: 0.15 }], null);
  assert.deepEqual([withMicro.mean, withMicro.coverage, withMicro.pct, withMicro.low, withMicro.fromRange], [180, 0.15, 45, true, true]);
  const fallback = n.summaryOf('magnesium', series, r, [], null);
  assert.equal(fallback.mean, 150);
  assert.ok(Math.abs(fallback.coverage - 0.3) < 1e-9);
  assert.equal(fallback.fromRange, false);
  const core = n.summaryOf('protein', [sec('a', 90, 1)], { value: 120, kind: 'goal' }, [], { protein: 96 });
  assert.deepEqual([core.mean, core.coverage, core.pct, core.low], [96, 1, 80, false]);
  const none = n.summaryOf('magnesium', [sec('a', null, 0)], r, [], null);
  assert.deepEqual([none.mean, none.coverage, none.pct, none.low], [null, null, null, false]);
  assert.equal(n.summaryOf('fiber', [sec('a', 20, 1)], null, [], { fiber: 20 }).pct, null);
});

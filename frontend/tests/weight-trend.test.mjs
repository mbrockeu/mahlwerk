import test from 'node:test';
import assert from 'node:assert/strict';
import { pacePerWeek, provisional, readingOf, trendOf, usualSpread } from '../src/lib/weightTrend.ts';

const day = (i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10); // 2026-10-01 + i
const series = (kgs) => kgs.map((kg, i) => ({ day: day(i), kg }));

test('the trend is the mean of the values within three days on either side, gaps included', () => {
  const t = trendOf([{ day: day(0), kg: 80 }, { day: day(2), kg: 82 }, { day: day(6), kg: 84 }]);
  assert.deepEqual(t.map((p) => p.kg), [81, 81, 84]); // day 6 is four days from day 2: it stands alone
});

test('only the last three days of the trend are still open', () => {
  assert.equal(provisional('2026-11-26', '2026-11-26'), true);
  assert.equal(provisional('2026-11-24', '2026-11-26'), true);
  assert.equal(provisional('2026-11-23', '2026-11-26'), false);
});

test('the usual spread is what 9 of 10 settled values stay within, at least 0.3 kg, and needs ten values', () => {
  const pts = series([80, 80.5, 80, 80.5, 80, 80.5, 80, 80.5, 80, 80.5, 80, 80.5, 80, 80.5]);
  const today = pts.at(-1).day;
  const spread = usualSpread(pts, trendOf(pts), today);
  assert.ok(spread >= 0.3 && spread <= 0.3, `got ${spread}`); // deviations ±0.25 at most: the floor
  assert.equal(usualSpread(pts.slice(0, 9), trendOf(pts.slice(0, 9)), today), null);
  const wild = series([80, 82, 80, 82, 80, 82, 80, 82, 80, 82, 80, 82, 80, 82]);
  assert.ok(usualSpread(wild, trendOf(wild), wild.at(-1).day) >= 0.8);
});

test('the pace is kilos per week over the last three weeks and needs five values over ten days', () => {
  const down = series(Array.from({ length: 21 }, (_, i) => 85 - 0.05 * i));
  assert.equal(pacePerWeek(down, down.at(-1).day), -0.35);
  assert.equal(pacePerWeek(down.slice(0, 4), down[3].day), null);
  assert.equal(pacePerWeek(down.slice(0, 8), down[7].day), null); // eight values, but only seven days apart
});

test('a jump above the trend inside the usual spread is ordinary, a big one is flagged', () => {
  const kgs = Array.from({ length: 28 }, (_, i) => 85 - 0.05 * i + (i % 2 ? 0.3 : -0.3));
  const ordinary = series([...kgs.slice(0, 27), kgs[26] + 0.6]);
  const r = readingOf(ordinary, ordinary.at(-1).day);
  assert.ok(r.deviation > 0 && !r.unusual, JSON.stringify(r));
  assert.ok(r.pace < 0);
  const big = series([...kgs.slice(0, 27), kgs[26] + 3]);
  assert.equal(readingOf(big, big.at(-1).day).unusual, true);
  assert.equal(readingOf([], '2026-11-26'), null);
});

// The weight trend and how to read a single value against it: the smoothed line (the same centred 7-day mean as the server's
// evaluation), the person's usual day-to-day spread around it, the pace per week, and which end of the line is still open.
// No imports: tested by tests/weight-trend.test.mjs.

export interface DayKg { day: string; kg: number }

/** Days on either side that the trend averages over (as TREND_HALF_WINDOW in ts/core/insights.ts). */
export const HALF_WINDOW = 3;
/** The usual spread is the distance that 9 of 10 recent values stay within. */
const SPREAD_SHARE = 0.9;
const SPREAD_DAYS = 60;
const SPREAD_MIN_VALUES = 6;
const SPREAD_FLOOR = 0.3; // kg: scales and water never hold a value closer than that
const PACE_DAYS = 21;
const PACE_MIN_VALUES = 5;
const PACE_MIN_SPAN = 10;
const STEADY = 0.05; // kg per week: below this the trend counts as steady

const ord = (day: string) => Math.round(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 86400000);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The mean of the values within HALF_WINDOW days around each day; `points` sorted ascending by day. */
export function trendOf(points: DayKg[]): DayKg[] {
  const o = points.map((p) => ord(p.day));
  const out: DayKg[] = [];
  let lo = 0, hi = 0, sum = 0;
  points.forEach((p, i) => {
    while (hi < points.length && o[hi] <= o[i] + HALF_WINDOW) sum += points[hi++].kg;
    while (o[lo] < o[i] - HALF_WINDOW) sum -= points[lo++].kg;
    out.push({ day: p.day, kg: r2(sum / (hi - lo)) });
  });
  return out;
}

/** Whether the trend on `day` can still move: values of the next HALF_WINDOW days may yet come in. */
export const provisional = (day: string, today: string) => ord(today) - ord(day) < HALF_WINDOW;

/**
 * The usual distance of a value from the trend, from the values of the last SPREAD_DAYS days up to the latest one
 * (null with fewer than SPREAD_MIN_VALUES of them). Only settled days count: an open end sits close to its own value.
 */
export function usualSpread(points: DayKg[], trend: DayKg[], today: string): number | null {
  if (!points.length) return null;
  const from = ord(points[points.length - 1].day) - SPREAD_DAYS;
  const dev: number[] = [];
  points.forEach((p, i) => { if (ord(p.day) > from && !provisional(p.day, today)) dev.push(Math.abs(p.kg - trend[i].kg)); });
  if (dev.length < SPREAD_MIN_VALUES) return null;
  dev.sort((a, b) => a - b);
  return Math.max(SPREAD_FLOOR, r1(dev[Math.min(dev.length - 1, Math.ceil(dev.length * SPREAD_SHARE) - 1)]));
}

/** Kilos per week over the last PACE_DAYS days (least squares through the measured values); null without enough of them. */
export function pacePerWeek(points: DayKg[], today: string): number | null {
  const from = ord(today) - PACE_DAYS;
  const xs: number[] = [], ys: number[] = [];
  for (const p of points) if (ord(p.day) > from) { xs.push(ord(p.day)); ys.push(p.kg); }
  if (xs.length < PACE_MIN_VALUES || xs[xs.length - 1] - xs[0] < PACE_MIN_SPAN) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return r2((num / den) * 7);
}

export interface Reading {
  pace: number | null; // kg per week
  steady: boolean; // |pace| below STEADY
  day: string; // the latest value's day
  deviation: number; // latest value minus the trend on its day, kg
  spread: number | null; // the usual distance, kg
  unusual: boolean; // the deviation is beyond the usual distance
}

/** The latest value read against the trend; null without any value. `points` sorted ascending. */
export function readingOf(points: DayKg[], today: string): Reading | null {
  if (!points.length) return null;
  const trend = trendOf(points);
  const last = points[points.length - 1];
  const deviation = r1(last.kg - trend[trend.length - 1].kg);
  const spread = usualSpread(points, trend, today);
  const pace = pacePerWeek(points, today);
  return { pace, steady: pace !== null && Math.abs(pace) < STEADY, day: last.day, deviation, spread, unusual: spread !== null && Math.abs(deviation) > spread };
}

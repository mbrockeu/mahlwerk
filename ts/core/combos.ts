// Favourite combos and "which foods fit a meal" (combos.py). Pure functions over diary rows `{day, food_id, amount}`,
// already limited to ONE meal type and to foods that still exist, in the order they were logged.
// Mining rule: per day the foods of the meal form one set; candidates are the day sets with 2 to MAX_SIZE foods plus the pairwise
// intersections of those sets (size >= 2); the support of a candidate is the number of DISTINCT days whose set contains it (MIN_SUPPORT
// needed); a candidate is dropped when a larger one that contains it has at least KEEP_RATIO of its support; ranked by support, latest day,
// size (all descending); sets equal to one in `skip` (the food sets of existing templates) are left out before the cut to `limit`.
// Candidates that tie in all three keys keep the order in which they were found (Python's order there is that of a hash set).
import { addDays, daysBetween } from './dates.ts';

export const WINDOW_DAYS = 42; // about six weeks
export const MIN_SUPPORT = 3;
export const MAX_SIZE = 8;
export const KEEP_RATIO = 0.75;
export const LIMIT = 3;
export const HALF_LIFE_DAYS = 14.0; // a day this much older counts half as much for "fits this meal"

export const windowStart = (today: string): string => addDays(today, -(WINDOW_DAYS - 1));

export interface MealRow { day: string; food_id: number; amount: number }

/** How well each food fits the rows' meal: `{food_id: {score, amount}}`. The score adds up one weight per day the food was
 * eaten in this meal, halving every HALF_LIFE_DAYS (so recent habits count more); `amount` is the one of the latest entry. */
export function fitScores(rows: MealRow[], today: string): Map<number, { score: number; amount: number }> {
  const out = new Map<number, { score: number; amount: number; days: Set<string> }>();
  for (const row of rows) { // logging order, so the last write is the latest entry
    const age = Math.max(0, daysBetween(row.day, today));
    let item = out.get(row.food_id);
    if (!item) out.set(row.food_id, (item = { score: 0.0, amount: row.amount, days: new Set() }));
    if (!item.days.has(row.day)) {
      item.days.add(row.day);
      item.score += 0.5 ** (age / HALF_LIFE_DAYS);
    }
    item.amount = row.amount;
  }
  return new Map([...out].map(([f, v]) => [f, { score: v.score, amount: v.amount }]));
}

const keyOf = (foods: Iterable<number>): string => [...new Set(foods)].sort((a, b) => a - b).join(',');

export interface Combo { foods: [number, number][]; days: number; last_day: string }

/** The best combos of the rows' meal, best first. `amount` is the one of the latest day on which the whole combo was eaten. `skip` holds
 * the keys (`comboKey`) of the food sets to leave out. */
export function mine(rows: MealRow[], skip: Set<string> | null = null, limit = LIMIT): Combo[] {
  const days = new Map<string, Map<number, number>>(); // day -> {food_id: amount}, in logging order; the amounts of a food logged twice are summed
  for (const row of rows) {
    let foods = days.get(row.day);
    if (!foods) days.set(row.day, (foods = new Map()));
    foods.set(row.food_id, (foods.get(row.food_id) ?? 0) + row.amount);
  }
  const sets = new Map([...days].map(([day, foods]) => [day, new Set(foods.keys())]));
  const big = [...sets.values()].filter((s) => s.size >= 2);
  const candidates = new Map<string, Set<number>>();
  for (const s of big) if (s.size <= MAX_SIZE) candidates.set(keyOf(s), s);
  const unique = [...new Map(big.map((s) => [keyOf(s), s])).values()];
  for (const [i, a] of unique.entries()) {
    for (const b of unique.slice(i + 1)) {
      const both = new Set([...a].filter((f) => b.has(f)));
      if (both.size >= 2 && both.size <= MAX_SIZE) candidates.set(keyOf(both), both);
    }
  }
  const found = new Map<string, { set: Set<number>; support: number; last: string }>();
  for (const [key, cand] of candidates) {
    const eaten = [...sets].filter(([, s]) => [...cand].every((f) => s.has(f))).map(([day]) => day);
    if (eaten.length >= MIN_SUPPORT) found.set(key, { set: cand, support: eaten.length, last: eaten.reduce((a, b) => (a > b ? a : b)) });
  }
  const kept = [...found.values()].filter((c) => ![...found.values()].some((o) => o.set.size > c.set.size && [...c.set].every((f) => o.set.has(f)) && o.support >= KEEP_RATIO * c.support));
  kept.sort((a, b) => b.support - a.support || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || b.set.size - a.set.size);
  const out: Combo[] = [];
  for (const c of kept) {
    if (skip?.has(keyOf(c.set))) continue;
    const amounts = days.get(c.last)!;
    out.push({ foods: [...amounts].filter(([f]) => c.set.has(f)), days: c.support, last_day: c.last });
    if (out.length >= limit) break;
  }
  return out;
}

/** The key of a set of food ids, as `mine` wants it in `skip`. */
export const comboKey = keyOf;

// Favourite combos and "which foods fit a meal" (combos.py). Pure functions over diary rows `{day, food_id, amount}`,
// already limited to ONE meal type and to foods that still exist, in the order they were logged.
// Only the window and the fit scores so far; the mining of combos (`mine`) comes with the combos route.
import { addDays, daysBetween } from './dates.ts';

export const WINDOW_DAYS = 42; // about six weeks
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

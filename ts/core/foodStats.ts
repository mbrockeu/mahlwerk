// Foods eaten in a period (food_stats.py): the list with totals per food and the detail of one food. Foods are grouped by
// `food_id`; entries whose food was deleted by name + brand. The group key is `id:<food_id>` or `n:<hash of name and brand>`.
import { weekday } from './dates.ts';
import { monthKeys } from './analysis.ts';
import { MEALS } from './models/common.ts';
import { scale, type Per100 } from './nutrition.ts';
import { pySum, roundHalfEven } from './num.ts';

export const SORTS = ['kcal', 'times', 'amount', 'last', 'name'] as const;
export type Sort = (typeof SORTS)[number];

export interface FoodEntry { day: string; meal: string; food_id: number | null; name: string; brand: string | null; unit: string; amount: number; per_100: Per100 }

/** str.casefold() for the letters that differ from lower-casing in practice. */
export const casefold = (s: string): string => s.toLowerCase().replaceAll('ß', 'ss').replaceAll('ſ', 's').replaceAll('ς', 'σ');

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function groupKey(row: FoodEntry): Promise<string> {
  if (row.food_id !== null) return `id:${row.food_id}`;
  const digest = hex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${row.name}\x00${row.brand || ''}`)));
  return `n:${digest.slice(0, 16)}`;
}

const kcalOf = (row: FoodEntry): number => scale(row.per_100, row.amount).kcal || 0.0;
const r1 = (x: number) => roundHalfEven(x, 1);

interface Group {
  key: string; food_id: number | null; name: string; brand: string | null; unit: string; times: number; day_set: Set<string>;
  amount_total: number; kcal_total: number; first_day: string; last_day: string;
}

/** Grouped foods, filtered by a case-insensitive search in name and brand, sorted, one page. `share` is the part of the whole
 * period's kcal (also of foods the search leaves out). Ties are broken by name so that paging is stable. */
export async function foodsList(rows: FoodEntry[], q: string, sort: Sort, limit: number, offset: number) {
  const groups = new Map<string, Group>();
  let totalKcal = 0.0;
  for (const row of rows) {
    const kcal = kcalOf(row);
    totalKcal += kcal;
    const key = await groupKey(row);
    let g = groups.get(key);
    if (!g) {
      groups.set(key, (g = { key, food_id: row.food_id, name: row.name, brand: row.brand, unit: row.unit, times: 0, day_set: new Set(), amount_total: 0.0, kcal_total: 0.0, first_day: row.day, last_day: row.day }));
    }
    g.times += 1;
    g.day_set.add(row.day);
    g.amount_total += row.amount;
    g.kcal_total += kcal;
    if (row.day >= g.last_day) Object.assign(g, { last_day: row.day, name: row.name, brand: row.brand, unit: row.unit }); // the latest spelling wins
    g.first_day = row.day < g.first_day ? row.day : g.first_day;
  }
  const needle = casefold(q.trim()); // Python strip(): Unicode whitespace, as trim()
  const items = [...groups.values()].filter((g) => !needle || casefold(g.name).includes(needle) || casefold(g.brand || '').includes(needle));
  const byName = items.sort((a, b) => cmp(casefold(a.name), casefold(b.name)) || cmp(a.brand || '', b.brand || ''));
  let ordered: Group[];
  if (sort === 'name') ordered = byName;
  else if (sort === 'last') ordered = [...byName].sort((a, b) => cmp(b.last_day, a.last_day));
  else {
    const field = { kcal: 'kcal_total', times: 'times', amount: 'amount_total' }[sort] as 'kcal_total' | 'times' | 'amount_total';
    ordered = [...byName].sort((a, b) => b[field] - a[field]); // stable: ties stay in name order
  }
  return {
    total: ordered.length,
    offset,
    limit,
    kcal_total: r1(totalKcal),
    items: ordered.slice(offset, offset + limit).map((g) => ({
      key: g.key, food_id: g.food_id, name: g.name, brand: g.brand, times: g.times, days: g.day_set.size, amount_total: r1(g.amount_total),
      unit: g.unit, kcal_total: r1(g.kcal_total), share: totalKcal ? roundHalfEven(g.kcal_total / totalKcal, 4) : 0.0,
      avg_amount: r1(g.amount_total / g.times), first_day: g.first_day, last_day: g.last_day,
    })),
  };
}

/** Monthly series, distribution over meals and weekdays and the three most common amounts of one food; null without entries. */
export async function foodDetail(rows: FoodEntry[], key: string, first: string, last: string) {
  const mine: FoodEntry[] = [];
  for (const r of rows) if ((await groupKey(r)) === key) mine.push(r);
  if (!mine.length) return null;
  const latest = mine.at(-1)!;
  const monthly = new Map(monthKeys(first, last).map((m) => [m, { month: m, times: 0, amount: 0.0, kcal: 0.0 }]));
  const meals: Record<string, number> = Object.fromEntries(MEALS.map((m) => [m, 0]));
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const amounts = new Map<number, number>();
  const days = new Set<string>();
  for (const r of mine) {
    const slot = monthly.get(r.day.slice(0, 7))!;
    slot.times += 1;
    slot.amount += r.amount;
    slot.kcal += kcalOf(r);
    meals[r.meal] += 1;
    weekdays[weekday(r.day)] += 1;
    const a = r1(r.amount);
    amounts.set(a, (amounts.get(a) ?? 0) + 1);
    days.add(r.day);
  }
  const n = mine.length;
  const usual = [...amounts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3);
  return {
    key, food_id: latest.food_id, name: latest.name, brand: latest.brand, unit: latest.unit, times: n, days: days.size,
    amount_total: r1(pySum(mine.map((r) => r.amount))), kcal_total: r1(pySum(mine.map(kcalOf))),
    first_day: mine[0].day, last_day: mine.at(-1)!.day,
    monthly: [...monthly.values()].map((m) => ({ ...m, amount: r1(m.amount), kcal: r1(m.kcal) })),
    by_meal: MEALS.map((m) => ({ meal: m, times: meals[m], share: roundHalfEven(meals[m] / n, 3) })),
    by_weekday: weekdays.map((times, i) => ({ weekday: i, times, share: roundHalfEven(times / n, 3) })),
    usual_amounts: usual.map(([amount, times]) => ({ amount, times })),
  };
}

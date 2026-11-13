// Pure helpers of the evaluation: the period in the URL, moving it, zooming into a section, chart scales.
// No DOM, no framework: tested by tests/insights.test.mjs.

export type Gran = 'day' | 'week' | 'month';
export type RangeKey = '7' | '30' | '90' | '365' | 'all' | 'custom';
export const PRESETS = ['7', '30', '90', '365'] as const;
export const MAX_DAYS = 3660; // ten years, as the server allows
export const DETAIL_DAYS = 370; // per-day lists (calendar, days) come only up to this many days

export interface Q {
  range: RangeKey;
  /** custom range only */
  from: string;
  to: string;
  /** chosen granularity; 'auto' lets the server decide */
  g: Gran | 'auto';
  compare: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => toIso(ms(day) + n * 86400000);
export const diffDays = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 86400000);
export const validDay = (day: string) => DAY.test(day) && !Number.isNaN(ms(day)) && toIso(ms(day)) === day;

export function parseQuery(params: URLSearchParams, today: string): Q {
  const raw = params.get('range') ?? '30';
  const range: RangeKey = raw === 'all' || raw === 'custom' || (PRESETS as readonly string[]).includes(raw) ? (raw as RangeKey) : '30';
  const g = params.get('g');
  return {
    range,
    from: params.get('from') ?? addDays(today, -29),
    to: params.get('to') ?? today,
    g: g === 'day' || g === 'week' || g === 'month' ? g : 'auto',
    compare: params.get('cmp') === '1',
  };
}

export function toParams(q: Q): Record<string, string> {
  const out: Record<string, string> = { range: q.range };
  if (q.range === 'custom') { out.from = q.from; out.to = q.to; }
  if (q.g !== 'auto') out.g = q.g;
  if (q.compare) out.cmp = '1';
  return out;
}

/** The days a query asks for; null for `all` (known only from the answer) and for an invalid custom range. */
export function period(q: Q, today: string): { from: string; to: string } | null {
  if (q.range === 'all') return null;
  if (q.range === 'custom') {
    const ok = validDay(q.from) && validDay(q.to) && q.from <= q.to && diffDays(q.from, q.to) + 1 <= MAX_DAYS;
    return ok ? { from: q.from, to: q.to } : null;
  }
  return { from: addDays(today, -(Number(q.range) - 1)), to: today };
}

/** Move a period by its own length (dir -1 back, +1 forward). Forward stops at today: the last step is shortened by moving back. */
export function shifted(p: { from: string; to: string }, dir: -1 | 1, today: string): { from: string; to: string } {
  const n = diffDays(p.from, p.to) + 1;
  let to = addDays(p.to, dir * n);
  if (to > today) to = today;
  return { from: addDays(to, -(n - 1)), to };
}

/** Section to zoom into: months open as weeks, weeks as days; days open the day view (null). */
export function zoomTarget(g: Gran, section: { start: string; end: string }): { from: string; to: string; g: Gran } | null {
  if (g === 'day') return null;
  return { from: section.start, to: section.end, g: g === 'month' ? 'week' : 'day' };
}

/** Granularity the server picks for `auto` (mirrors analysis.resolve_granularity). */
export const autoGran = (days: number): Gran => (days <= 45 ? 'day' : days <= 370 ? 'week' : 'month');

/** Share of each macro in the kcal (4/4/9 kcal per gram), summing to 1; zeros without energy. */
export function macroShares(m: { protein: number; carbs: number; fat: number }) {
  const p = m.protein * 4, c = m.carbs * 4, f = m.fat * 9;
  const sum = p + c + f;
  return sum > 0 ? { protein: p / sum, carbs: c / sum, fat: f / sum } : { protein: 0, carbs: 0, fat: 0 };
}

/** Evenly spread label positions (always first and last) for `n` items with at most `want` labels. */
export function labelIndexes(n: number, want: number): number[] {
  if (n <= 0) return [];
  const k = Math.min(n, Math.max(1, want));
  if (k === 1) return [0];
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1))))];
}

/** Position of week column and weekday row for a calendar cell; the first column starts on the Monday of the first day. */
export function calendarCell(first: string, day: string): { col: number; row: number } {
  const row = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const offset = diffDays(first, day) + row;
  return { col: Math.floor(offset / 7), row: offset % 7 };
}

/** Delta text parts: arrow glyph and magnitude; no judgement. */
export function deltaArrow(abs: number): '↑' | '↓' | '=' {
  return abs > 0 ? '↑' : abs < 0 ? '↓' : '=';
}

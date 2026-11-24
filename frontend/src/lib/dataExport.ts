// The address of the personal data export (GET /api/v1/me/export). A plain link does the download: the cookie or the proxy
// sign-in goes along with it. No DOM, no framework, no imports: tested by tests/data-export.test.mjs.

export type ExportPeriod = 'all' | 'year' | 'custom';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Why a custom period cannot be used (an end may stay open), or null. */
export function periodProblem(period: ExportPeriod, from: string, to: string): 'format' | 'order' | null {
  if (period !== 'custom') return null;
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return 'format';
  return from && to && from > to ? 'order' : null;
}

/** The relative address (below any path prefix, like the API client); null while the period is not usable.
 * `lang` decides the CSV format: German `;` and decimal comma, English `,` and decimal point. */
export function exportUrl(period: ExportPeriod, from: string, to: string, today: string, lang: 'de' | 'en'): string | null {
  if (periodProblem(period, from, to)) return null;
  const params = new URLSearchParams();
  if (period === 'year') {
    params.set('from', shiftDay(today, -364));
    params.set('to', today);
  } else if (period === 'custom') {
    if (from) params.set('from', from);
    if (to) params.set('to', to);
  }
  params.set('lang', lang);
  return `api/v1/me/export?${params}`;
}

// --- the import of an export (POST api/v1/me/import/...) ---

type Count = { new: number; changed: number; unchanged: number; skipped: number; reasons: Record<string, number> };

/** The kinds worth a row in the preview (anything in the file), in the order of the API, and the sums over all of them. */
export function importRows<K extends string>(counts: Record<K, Count>): { kind: K; count: Count }[] {
  return (Object.entries(counts) as [K, Count][])
    .filter(([, c]) => c.new + c.changed + c.unchanged + c.skipped > 0)
    .map(([kind, count]) => ({ kind, count }));
}

export function importTotals(counts: Record<string, Count>): { new: number; changed: number; unchanged: number; skipped: number } {
  const out = { new: 0, changed: 0, unchanged: 0, skipped: 0 };
  for (const c of Object.values(counts)) {
    out.new += c.new;
    out.changed += c.changed;
    out.unchanged += c.unchanged;
    out.skipped += c.skipped;
  }
  return out;
}

/** The rows replace would delete first, all kinds together (the Yazio import batches are bookkeeping, not data). */
export const deletedTotal = (deleted: Record<string, number> | null): number =>
  Object.entries(deleted ?? {}).reduce((n, [k, v]) => n + (k === 'imports' ? 0 : v), 0);

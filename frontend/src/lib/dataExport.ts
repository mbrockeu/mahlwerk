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

// Body composition of the weight page: percent, fat mass and lean mass per day and their change. No imports but types:
// tested by tests/body.test.mjs.
import type { WeightPoint } from './types';

export interface BodyPoint { day: string; pct: number; fat: number; lean: number }
export type BodyKey = 'pct' | 'fat' | 'lean';

const round1 = (v: number) => Math.round(v * 10) / 10;

/** The days that have body composition, oldest first: fat = kg * % / 100, lean = kg - fat; only a lean mass gives the percent. */
export function bodyPoints(points: WeightPoint[]): BodyPoint[] {
  const out: BodyPoint[] = [];
  for (const p of points) {
    const pct = p.body_fat_pct ?? (p.lean_kg != null && p.kg > 0 ? Math.min(Math.max((1 - p.lean_kg / p.kg) * 100, 0), 100) : null);
    if (pct == null) continue;
    const fat = (p.kg * pct) / 100;
    out.push({ day: p.day, pct, fat, lean: p.kg - fat });
  }
  return out;
}

/** Change of one value since the latest day that is on or before `cutoff` (one decimal); null without such a day. */
export function bodyChange(series: BodyPoint[], key: BodyKey, cutoff: string): number | null {
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const base = [...series].reverse().find((p) => p.day <= cutoff);
  return base && base !== latest ? round1(latest[key] - base[key]) : null;
}

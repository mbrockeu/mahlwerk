// The workout kinds (a copy of src/mahlwerk/activity.py: key, MET value, icon) and the kcal estimate. Pure, no DOM:
// tested by tests/workouts.test.mjs.
import type { WorkoutKind } from './types';

type WorkoutIcon = 'walk' | 'run' | 'bike' | 'mountain' | 'swim' | 'dumbbell' | 'lotus' | 'bolt' | 'stairs' | 'ball' | 'music';

export interface KindInfo { key: WorkoutKind; met: number; icon: WorkoutIcon }

export const KINDS: KindInfo[] = [
  { key: 'walking', met: 3.5, icon: 'walk' },
  { key: 'running', met: 9.8, icon: 'run' },
  { key: 'cycling', met: 7.5, icon: 'bike' },
  { key: 'hiking', met: 6.0, icon: 'mountain' },
  { key: 'swimming', met: 6.0, icon: 'swim' },
  { key: 'strength', met: 5.0, icon: 'dumbbell' },
  { key: 'yoga', met: 2.5, icon: 'lotus' },
  { key: 'pilates', met: 3.0, icon: 'lotus' },
  { key: 'crosstrainer', met: 5.0, icon: 'bolt' },
  { key: 'stairs', met: 8.8, icon: 'stairs' },
  { key: 'circuit', met: 8.0, icon: 'bolt' },
  { key: 'squash', met: 7.3, icon: 'ball' },
  { key: 'bowling', met: 3.0, icon: 'ball' },
  { key: 'dancing', met: 5.0, icon: 'music' },
  { key: 'football', met: 7.0, icon: 'ball' },
  { key: 'tennis', met: 7.3, icon: 'ball' },
  { key: 'skiing', met: 7.0, icon: 'mountain' },
  { key: 'rowing', met: 7.0, icon: 'swim' },
  { key: 'other', met: 4.0, icon: 'bolt' },
];

export const DEFAULT_WEIGHT_KG = 75;

export const kindInfo = (key: string): KindInfo => KINDS.find((k) => k.key === key) ?? KINDS[KINDS.length - 1];

/** MET x body weight (kg) x hours, rounded to whole kcal; the server does the same when no kcal is given. */
export function estimateKcal(kind: string, minutes: number, weightKg: number | null): number {
  return Math.round(kindInfo(kind).met * (weightKg ?? DEFAULT_WEIGHT_KG) * (minutes / 60));
}

/** "17:30" for a Unix time, in the local time zone. */
export function clock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Unix seconds for "HH:MM" on a day (YYYY-MM-DD) in the local time zone; null for anything that is not a time. */
export function startAt(day: string, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const [y, mo, d] = day.split('-').map(Number);
  return Math.floor(new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime() / 1000);
}

/** The share of the steps goal, 0..1 (0 without a goal). */
export const stepShare = (steps: number | null, goal: number) => (goal > 0 && steps ? Math.min(steps / goal, 1) : 0);

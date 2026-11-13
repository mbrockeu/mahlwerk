// The logic around "photo recognition" on the capture screens: how a failed request is explained, the one-time privacy notice. Pure functions (tests/vision.test.mjs).
import type { VisionRecipe } from './types';

/** Lines of a recipe photo for the review step: clean, not empty, at most 80, each at most 300 characters. */
export function recipeLines(recipe: Pick<VisionRecipe, 'ingredients'>): string[] {
  return recipe.ingredients.map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 80);
}

/** Nutrition per portion from a recipe photo, only when it has the energy value (else there is nothing to compare). */
export function photoNutrition(recipe: Pick<VisionRecipe, 'nutrition_per_portion'>) {
  const n = recipe.nutrition_per_portion;
  return n && n.kcal != null && Number.isFinite(n.kcal) ? n : null;
}

/** The energy of the whole list per portion, for the comparison with the photo; null without portions or energy. */
export function perPortion(total: number | null, portions: number | null | undefined): number | null {
  return total == null || portions == null || !Number.isFinite(portions) || portions <= 0 ? null : total / portions;
}

export type VisionErrorCode = 'busy' | 'toolarge' | 'unreadable' | 'timeout' | 'failed' | 'offline' | 'blocked' | 'off' | 'other';
export interface VisionFailure { code: VisionErrorCode; /** seconds until a new try makes sense (429), else 0 */ wait: number }

/** Which text a failed request gets; `status` 0 is "no answer at all" (offline). Neutral: the model's own text is never shown. */
export function failure(status: number, retryAfter: number | null | undefined, online = true): VisionFailure {
  const wait = status === 429 ? Math.min(Math.max(Math.round(retryAfter ?? 10), 1), 3600) : 0;
  if (status === 429) return { code: 'busy', wait };
  if (status === 413) return { code: 'toolarge', wait };
  if (status === 422) return { code: 'unreadable', wait };
  if (status === 504) return { code: 'timeout', wait };
  if (status === 502) return { code: 'failed', wait };
  if (status === 0) return { code: online ? 'failed' : 'offline', wait };
  if (status === 403) return { code: 'blocked', wait };
  if (status === 404 || status === 409 || status === 501) return { code: 'off', wait };
  return { code: 'other', wait };
}

/** "8 s", "2 min": the wait of a 429 for a sentence. */
export function waitText(seconds: number): { n: number; unit: 's' | 'min' } {
  return seconds < 90 ? { n: Math.max(1, Math.round(seconds)), unit: 's' } : { n: Math.round(seconds / 60), unit: 'min' };
}

const NOTICE_KEY = 'mahlwerk.visionNotice';
/** The privacy notice is shown once per device; storage may be blocked, then it is shown every time (never an error). */
export function noticeSeen(): boolean {
  try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch { return false; }
}
export function markNoticeSeen(): void {
  try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* shown again next time */ }
}

/** The model found nothing it could use (an empty list): not an error of the request, so the screen says so and offers another photo. */
export class NothingFound extends Error {
  constructor() { super('nothing found'); }
}

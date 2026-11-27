// Nutrition values typed "per serving" instead of "per 100 g / ml": the app stores and computes everything per 100, so the
// product editor converts once, on saving. No imports: tested by tests/basis.test.mjs.

/** The leading amount of a serving size ("350 g", "250 ml", "1,5 g"), as the server reads it (parseServing in ts/core/nutrition.ts). */
const SERVING = /^\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i;

/** The amount of one serving in the product's unit; null when the text gives none or gives it in the other unit. */
export function servingAmount(servingSize: string, unit: 'g' | 'ml'): number | null {
  const m = SERVING.exec(servingSize);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return value > 0 && m[2].toLowerCase() === unit ? value : null;
}

/** A value per serving of `amount` g/ml as a value per 100, to two decimals; null stays null. */
export const per100Of = (perServing: number | null, amount: number): number | null =>
  perServing === null ? null : Math.round((perServing * 100 / amount) * 100) / 100;

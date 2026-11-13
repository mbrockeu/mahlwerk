// The logic behind "Paste ingredient list": what amount a line gets for the chosen food, and which lines are ready to be taken over.
// Pure functions (tests/ingredients.test.mjs); the reading of the lines itself is done by the server (ingredients.py).
import type { FoodIn, IngredientCandidate, IngredientLine, Per100, VisionMealItem } from './types';

/** What an image model estimated for one recognised part of a meal: the values are for `grams`, not per 100 g. */
export interface Estimate { grams: number; kcal: number; protein: number | null; fat: number | null; carbs: number | null }

/** What the person has decided about one line. `amount` is the text of the field (it may be typed with a comma). */
export interface Row {
  line: IngredientLine;
  pick: IngredientCandidate | null;
  amount: string;
  /** The amount is still the server's estimate: it is marked until the person types something. */
  estimated: boolean;
  skipped: boolean;
  /** Photo of a meal: the model's own values for this part; the person may take them when no food of the database fits. */
  estimate?: Estimate | null;
  /** The row is booked as a food made from `estimate` (then `pick` is null). */
  useEstimate?: boolean;
}

export type Readiness = 'ready' | 'no_food' | 'no_amount' | 'skipped';

/** The amount to suggest for a line when the chosen food is measured in `unit`: ml where the line gave (or could work out) ml, else grams. */
export function suggestAmount(line: Pick<IngredientLine, 'grams' | 'ml' | 'estimated'>, unit: 'g' | 'ml'): { amount: number | null; estimated: boolean } {
  if (unit === 'ml') {
    if (line.ml != null) return { amount: line.ml, estimated: line.estimated };
    // grams for a food in ml: 1 g = 1 ml is a guess
    return { amount: line.grams, estimated: line.grams != null };
  }
  return { amount: line.grams, estimated: line.estimated };
}

const trimNumber = (v: number) => (Math.round(v * 10) / 10).toString();

/** The text for the amount field: no decimals worth showing past one place, a dot (the field is parsed with the language's rules by the caller). */
export function amountText(amount: number | null): string {
  return amount == null ? '' : trimNumber(amount);
}

/** A row for a line with the server's best suggestion already chosen. */
export function makeRow(line: IngredientLine): Row {
  const pick = line.suggestion;
  const { amount, estimated } = suggestAmount(line, pick?.unit ?? 'g');
  return { line, pick, amount: amountText(amount), estimated, skipped: false };
}

/** The person chose another food: the amount follows the new unit unless they typed their own. */
export function changePick(row: Row, pick: IngredientCandidate): Row {
  if (row.estimated || row.amount === '') {
    const { amount, estimated } = suggestAmount(row.line, pick.unit);
    return { ...row, pick, useEstimate: false, amount: amountText(amount), estimated };
  }
  return { ...row, pick, useEstimate: false };
}

/** Per 100 g from values that hold for `grams` (two decimals, so that the amount of the estimate gives its values back). */
export function estimatePer100(e: Estimate): Per100 {
  const k = 100 / e.grams;
  const scale = (v: number | null) => (v == null ? null : Math.round(v * k * 100) / 100);
  return { kcal: scale(e.kcal), protein: scale(e.protein), fat: scale(e.fat), carbs: scale(e.carbs), saturated_fat: null, sugars: null, fiber: null, salt: null };
}

/** The own food made from an estimate (named as recognised, in grams). */
export function estimateFood(name: string, e: Estimate): FoodIn {
  return { name: name.trim().replace(/\s+/g, ' ').slice(0, 120), unit: 'g', per_100: estimatePer100(e) };
}

/** The person takes the model's values for this row instead of a food of the database. */
export function takeEstimate(row: Row): Row {
  if (!row.estimate) return row;
  const amount = row.amount === '' ? amountText(row.estimate.grams) : row.amount;
  return { ...row, pick: null, useEstimate: true, amount, estimated: row.amount === '' ? true : row.estimated };
}

/** The values per 100 of what the row would book: the chosen food, or the model's estimate. */
export function rowPer100(row: Row): Per100 | null {
  if (row.useEstimate && row.estimate) return estimatePer100(row.estimate);
  return row.pick?.per_100 ?? null;
}

/** The unit the row's amount is in: the food's, or grams for an estimate. */
export const rowUnit = (row: Row): 'g' | 'ml' => (row.useEstimate && row.estimate ? 'g' : row.pick?.unit ?? 'g');

/** A typed amount: a number above zero (comma or dot), else null. */
export function readAmount(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(v) && v > 0 && v <= 20000 ? v : null;
}

export function readiness(row: Row): Readiness {
  if (row.skipped) return 'skipped';
  if (!row.pick && !(row.useEstimate && row.estimate)) return 'no_food';
  return readAmount(row.amount) == null ? 'no_amount' : 'ready';
}

export interface Summary { ready: number; noFood: number; noAmount: number; skipped: number; kcal: number | null; protein: number | null }

export function summarize(rows: Row[]): Summary {
  const s: Summary = { ready: 0, noFood: 0, noAmount: 0, skipped: 0, kcal: null, protein: null };
  for (const row of rows) {
    const r = readiness(row);
    if (r === 'ready') {
      s.ready += 1;
      const per = rowPer100(row) as Per100;
      const amount = readAmount(row.amount) as number;
      if (per.kcal != null) s.kcal = (s.kcal ?? 0) + (per.kcal * amount) / 100;
      if (per.protein != null) s.protein = (s.protein ?? 0) + (per.protein * amount) / 100;
    } else if (r === 'no_food') s.noFood += 1;
    else if (r === 'no_amount') s.noAmount += 1;
    else s.skipped += 1;
  }
  return s;
}


// ---- a photo of a meal: the lines for the matcher and the rows of the check step ----

const MAX_NAME = 120;

/** A name as one clean line for the matcher: no line breaks, no brackets (a number in brackets would count as the weight), no leading count. */
export function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\d.,/\s]+(?=\D)/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

const usableGrams = (g: number | null | undefined): g is number => g != null && Number.isFinite(g) && g > 0 && g <= 5000;

/** The line for the ingredient matcher: "150 g Boiled rice" (just the name when the model gave no usable amount). */
export function matchLine(item: Pick<VisionMealItem, 'name' | 'grams'>): string {
  const name = cleanName(item.name) || '?';
  return usableGrams(item.grams) ? `${amountText(item.grams)} g ${name}` : name;
}

/** What the model estimated, when it is enough to make a food from it: the energy AND a usable amount. */
export function estimateOf(item: VisionMealItem): Estimate | null {
  if (item.kcal == null || !Number.isFinite(item.kcal) || item.kcal < 0 || !usableGrams(item.grams)) return null;
  return { grams: item.grams, kcal: item.kcal, protein: item.protein_g, fat: item.fat_g, carbs: item.carbs_g };
}

/**
 * One review row per recognised part, in the model's order. `lines` are the matcher's answers for the lines of `matchLine`
 * (`line` is the 1-based number of the line sent); a line the matcher dropped gets an empty row, so nothing silently vanishes.
 * The row shows the model's name; the amount is the model's grams (an estimate for the whole sheet, not marked per row).
 */
export function buildMealRows(items: VisionMealItem[], lines: IngredientLine[]): Row[] {
  const byNumber = new Map(lines.map((l) => [l.line, l]));
  return items.map((item, i) => {
    const found = byNumber.get(i + 1);
    const grams = usableGrams(item.grams) ? item.grams : null;
    const line: IngredientLine = {
      line: i + 1, quantity: grams, unit: grams == null ? null : 'g', name: cleanName(item.name), note: null, optional: false,
      grams, ml: null, estimated: false, basis: grams == null ? 'none' : 'explicit', candidates: [], suggestion: null,
      ...found, text: item.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || '?',
    };
    return { ...makeRow(line), estimated: false, estimate: estimateOf(item), useEstimate: false };
  });
}


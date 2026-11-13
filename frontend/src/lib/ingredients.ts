// The logic behind "Paste ingredient list": what amount a line gets for the chosen food, and which lines are ready to be taken over.
// Pure functions (tests/ingredients.test.mjs); the reading of the lines itself is done by the server (ingredients.py).
import type { IngredientCandidate, IngredientLine } from './types';

/** What the person has decided about one line. `amount` is the text of the field (it may be typed with a comma). */
export interface Row {
  line: IngredientLine;
  pick: IngredientCandidate | null;
  amount: string;
  /** The amount is still the server's estimate: it is marked until the person types something. */
  estimated: boolean;
  skipped: boolean;
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
    return { ...row, pick, amount: amountText(amount), estimated };
  }
  return { ...row, pick };
}

/** A typed amount: a number above zero (comma or dot), else null. */
export function readAmount(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(v) && v > 0 && v <= 20000 ? v : null;
}

export function readiness(row: Row): Readiness {
  if (row.skipped) return 'skipped';
  if (!row.pick) return 'no_food';
  return readAmount(row.amount) == null ? 'no_amount' : 'ready';
}

export interface Summary { ready: number; noFood: number; noAmount: number; skipped: number; kcal: number | null }

export function summarize(rows: Row[]): Summary {
  const s: Summary = { ready: 0, noFood: 0, noAmount: 0, skipped: 0, kcal: null };
  for (const row of rows) {
    const r = readiness(row);
    if (r === 'ready') {
      s.ready += 1;
      const kcal = (row.pick as IngredientCandidate).per_100.kcal;
      if (kcal != null) s.kcal = (s.kcal ?? 0) + (kcal * (readAmount(row.amount) as number)) / 100;
    } else if (r === 'no_food') s.noFood += 1;
    else if (r === 'no_amount') s.noAmount += 1;
    else s.skipped += 1;
  }
  return s;
}


/** Pieces: a person says once what one piece of a food is ("slice" = 25 g); the amount dialog then counts in pieces and books grams.
 *  Pure helpers, the diary itself stays in g or ml. */
export const MAX_AMOUNT = 5000;
export const MAX_LABEL = 30;
const round = (v: number) => Math.round(v * 1000) / 1000;

/** The grams (ml) of a number of pieces. */
export const piecesToGrams = (count: number, pieceGrams: number) => round(count * pieceGrams);
/** The number of pieces in an amount of grams (ml), rounded to 3 digits. */
export const gramsToPieces = (grams: number, pieceGrams: number) => round(grams / pieceGrams);
/** The amount is a whole or half number of pieces (so "2 × slice" says it exactly); a small tolerance for rounded amounts. */
export const isHalfMultiple = (grams: number, pieceGrams: number) => {
  const n = (grams / pieceGrams) * 2;
  return grams > 0 && pieceGrams > 0 && Math.abs(n - Math.round(n)) < 0.01 && Math.round(n) >= 1;
};
/** "2 × Scheibe": no plural forms to inflect, same pattern for every language. */
export const piecesText = (count: number, label: string, format: (n: number) => string = String) => `${format(count)} × ${label}`;

export interface PieceDraft { label: string; grams: number }
/** The label trimmed and the grams read from a typed number; null when either is not acceptable (what the server would refuse with 422). */
export function checkPiece(label: string, grams: number | null): PieceDraft | null {
  const name = label.trim();
  if (!name || [...name].length > MAX_LABEL) return null;
  if (grams == null || Number.isNaN(grams) || grams <= 0 || grams > MAX_AMOUNT) return null;
  return { label: name, grams };
}

/** A share of a whole ("cake of 1250 g cut into 8, ate 2" = 312.5 g); null when the numbers do not make a share up to 5000. */
export function splitGrams(total: number | null, parts: number | null, eaten: number | null): number | null {
  if (total == null || parts == null || eaten == null || [total, parts, eaten].some(Number.isNaN)) return null;
  if (total <= 0 || parts <= 0 || eaten <= 0 || eaten > parts) return null;
  const grams = round((total / parts) * eaten);
  return grams > 0 && grams <= MAX_AMOUNT ? grams : null;
}

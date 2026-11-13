// A small counterpart of ingredients.py for the mock and the demo: it reads the common cases (amount, unit, name, mass, volume, a few
// piece weights, a weight in brackets) so that "Paste ingredient list" can be tried without a server. The server knows far more
// (fractions of every kind, ranges, many more units and weights); the rules it shares with this file are the ones the tests pin down.
import type { CatalogItem, Food, IngredientCandidate, IngredientLine, IngredientMatches } from './types';

const MASS: Record<string, number> = { g: 1, gr: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 };
const VOLUME: Record<string, number> = { ml: 1, cl: 10, dl: 100, l: 1000, el: 15, tl: 5, tbsp: 15, tsp: 5, cup: 240, cups: 240 };
const PIECE: Record<string, number> = { ei: 55, eier: 55, egg: 55, eggs: 55, zwiebel: 80, zwiebeln: 80, onion: 80, onions: 80, banane: 120, banana: 120, apfel: 180, apple: 180 };
const ITEM: Record<string, string> = { prise: 'pinch', pinch: 'pinch', bund: 'bunch', bunch: 'bunch', dose: 'can', dosen: 'can', can: 'can', cans: 'can', zehe: 'clove', zehen: 'clove', clove: 'clove', cloves: 'clove' };
// grams of one unit by food; '' is the default of the unit (the server's table is bigger)
const ITEM_GRAMS: Record<string, Record<string, number>> = {
  pinch: { '': 0.4, salz: 0.5, salt: 0.5 }, bunch: { '': 50, petersilie: 50, parsley: 50, schnittlauch: 25, chives: 25 }, can: { '': 400 }, clove: { knoblauch: 4, garlic: 4 },
};
const DENSITY: Record<string, number> = { honig: 1.42, honey: 1.42, salz: 1.2, salt: 1.2, wasser: 1, water: 1, milch: 1.03, milk: 1.03, olivenol: 0.92, 'olive oil': 0.92, mehl: 0.55, flour: 0.55, zucker: 0.85, sugar: 0.85 };
const FRACTIONS: Record<string, string> = { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3' };

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function numberOf(text: string): number | null {
  const t = text.trim();
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  m = /^(\d+)(?:[.,](\d+))?$/.exec(t);
  return m ? Number(`${m[1]}.${m[2] ?? '0'}`) : null;
}

export function parseLine(raw: string): Omit<IngredientLine, 'line' | 'candidates' | 'suggestion'> | null {
  let text = raw;
  for (const [k, v] of Object.entries(FRACTIONS)) text = text.replaceAll(k, ` ${v} `);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || (text.endsWith(':') && !/\d/.test(text))) return null;
  const notes: string[] = [];
  let explicit: number | null = null;
  text = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    const m = /(?:je\s+)?(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i.exec(inner);
    if (m && explicit == null) explicit = numberOf(m[1]);
    else if (inner.trim()) notes.push(inner.trim());
    return ' ';
  });
  const [head, ...rest] = text.split(/,\s+/);
  if (rest.length) notes.push(rest.join(', '));
  const m = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?\s*([^\s\d]+)?\s*(.*)$/.exec(head.trim());
  let quantity: number | null = null;
  let unit: string | null = null;
  let name = head.trim();
  if (m) {
    quantity = numberOf(m[1]);
    if (quantity != null && m[2]) quantity = (quantity + (numberOf(m[2]) ?? quantity)) / 2;
    const word = (m[3] ?? '').replace(/\.$/, '');
    const key = fold(word);
    if (key in MASS || key in VOLUME || key in ITEM) { unit = m[3]; name = m[4]; }
    else name = `${m[3] ?? ''} ${m[4]}`.trim();
  }
  name = name.replace(/^(of|von)\s+/i, '').trim();
  const item = unit ? ITEM[fold(unit).replace(/\.$/, '')] : undefined;
  if (item && quantity == null) quantity = 1;
  const optional = /optional/i.test(raw);
  let grams: number | null = null;
  let ml: number | null = null;
  let estimated = false;
  let basis: IngredientLine['basis'] = 'none';
  const u = unit ? fold(unit).replace(/\.$/, '') : null;
  const dens = DENSITY[fold(name)];
  if (explicit != null) { grams = explicit * (quantity ?? 1); basis = 'explicit'; }
  else if (quantity != null && u && u in MASS) { grams = quantity * MASS[u]; basis = 'mass'; }
  else if (quantity != null && u && u in VOLUME) {
    ml = quantity * VOLUME[u]; grams = ml * (dens ?? 1); estimated = dens == null; basis = 'volume';
  } else if (quantity != null && item) {
    const table = ITEM_GRAMS[item]; const each = table[fold(name)] ?? (item === 'clove' ? undefined : table['']);
    if (each != null) { grams = quantity * each; estimated = true; basis = 'unit'; }
  } else if (quantity != null && !u && PIECE[fold(name)]) { grams = quantity * PIECE[fold(name)]; estimated = true; basis = 'piece'; }
  if (grams != null) grams = Math.round(grams * 10) / 10;
  return { text: raw.trim(), quantity, unit, name, note: notes.join('; ') || null, optional, grams, ml, estimated, basis };
}

type Pool = { own: Food[]; catalog: CatalogItem[] };

const asCandidate = (f: Food | CatalogItem, own: boolean): IngredientCandidate => ({
  source: own ? (f.source === 'own' || f.source === 'bls' || f.source === 'openfoodfacts' || f.source === 'yazio' ? f.source : 'own') : (f.source as 'bls' | 'openfoodfacts'),
  food_id: own ? (f as Food).id : null, code: f.code ?? null, name: f.name ?? '?', brand: f.brand ?? null, unit: f.unit, per_100: f.per_100,
});

export function candidatesFor(name: string, pool: Pool): IngredientCandidate[] {
  const words = fold(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const stem = (w: string) => w.replace(/(es|en|er|n|e|s)$/, '');
  const tries = [words, ...words.map((w) => [w]), ...words.map((w) => [stem(w)])].filter((w) => w.length && w.every((x) => x.length >= 2));
  for (const t of tries) {
    // a word start, the end of a compound ("Weizenmehl" for "Mehl"), or a two-letter stem as a whole word or word end ("Ei" in "Hühnerei")
    const fits = (part: string, w: string) => (w.length <= 2 ? part === w || (part.length > w.length && part.endsWith(w)) : part.startsWith(w) || (w.length >= 4 && part.includes(w)));
    const hit = (n: string | null) => { const f = fold(n ?? ''); return t.every((w) => f.split(/[^\p{L}\p{N}]+/u).some((part) => fits(part, w))); };
    const own = pool.own.filter((f) => f.source !== 'recipe' && f.source !== 'cookidoo' && f.source !== 'web' && hit(f.name)).sort((a, b) => (a.name ?? '').length - (b.name ?? '').length).slice(0, 3);
    const basics = pool.catalog.filter((c) => c.source === 'bls' && (hit(c.name) || hit(c.name_en ?? null))).slice(0, 3);
    const packaged = pool.catalog.filter((c) => c.source !== 'bls' && hit(c.name));
    const all = [...own.map((f) => asCandidate(f, true)), ...basics.map((c) => asCandidate(c, false)), ...packaged.map((c) => asCandidate(c, false))].slice(0, 5);
    if (all.length) return all;
  }
  return [];
}

export function mockMatch(text: string, pool: Pool): IngredientMatches {
  const lines: IngredientLine[] = [];
  let ignored = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const parsed = parseLine(raw);
    if (!parsed) { ignored += 1; return; }
    const candidates = candidatesFor(parsed.name, pool);
    lines.push({ line: i + 1, ...parsed, candidates, suggestion: candidates[0] ?? null });
  });
  return { lines, ignored };
}

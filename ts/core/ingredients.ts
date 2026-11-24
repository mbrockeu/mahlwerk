// Ingredient lines (pasted from a cookbook or a web page) to amounts in grams, and the foods that may be meant (ingredients.py).
// Deterministic and offline: no model, no network. `parseLine` reads one line ("2 EL Olivenöl (extra virgin), kalt gepresst",
// "1 1/2 cups flour", "1 Dose Tomaten (400 g)") into quantity, unit, name and note and works out grams where it can; `candidates`
// then looks for the foods a line may mean: own foods first, then the basic foods and the packaged products of the catalogue.
//
// Python's `\b`, `\w` and `[^\W\d_]` are Unicode-aware, JavaScript's `\b` is not: the patterns below spell the boundaries out.
import * as T from './ingredientTables.ts';
import { roundHalfEven } from './num.ts';
import { casefold, pyHead, pySplit, pySplitLines, pyStrip, stripChars } from './text.ts';

export const MAX_LINES = 200;
export const MAX_LINE = 300;
export const MAX_TEXT = 20_000;
export const MAX_CANDIDATES = 5;
const MAX_QUANTITY = 100_000;
const MAX_GRAMS = 1_000_000;

/** Lower case without diacritics; 'ß' as 'ss' ('Äpfel' -> 'apfel'). */
export const fold = (text: string): string => casefold(text).normalize('NFKD').replace(/\p{Mn}/gu, '');

/** catalog.words(): the words of a text as the catalogue sees them (lower case, no diacritics, 'ß' stays), so they can be compared with its names. */
export const words = (text: string): string[] => {
  const decomposed = text.split('ß').map((part) => casefold(part)).join('ß').normalize('NFKD').replace(/\p{Mn}/gu, '');
  return decomposed.match(/[\p{L}\p{N}]+/gu) ?? [];
};

const W = '[\\p{L}\\p{N}_]'; // \w
const LET = '[\\p{L}\\p{Nl}\\p{No}]'; // [^\W\d_]
const BEFORE = `(?<!${W})`; // \b in front of a word character
const AFTER = `(?!${W})`; // \b after a word character
const rx = (source: string, flags = 'u') => new RegExp(source, flags);
const anchored = (re: RegExp) => new RegExp(`^(?:${re.source})`, re.flags);
const set = (a: readonly string[]) => new Set(a);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const get = <V>(o: Record<string, V>, k: string): V | undefined => (has(o, k) ? o[k] : undefined);

const ALIASES = T.ALIASES;
const ITEMS = set(T.ITEMS);
const CONTAINERS = set(T.CONTAINERS);
const PREP = set(T.PREP);
const ADJECTIVES = set(T.ADJECTIVES);
const STOP = set(T.STOP);
const MODIFIERS = set(T.MODIFIERS);
const PREPARED = set(T.PREPARED);
const DISH_WORDS = set(T.DISH_WORDS);

const NUM = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:[.,]\\d+)*|[.,]\\d+)';
const RANGE_RE = rx(`^(${NUM})\\s*(?:-|–|—|bis|to|or|oder)\\s*(${NUM})(?![\\d/])`, 'iu');
const QTY_RE = rx(`^(${NUM})(?![\\d/])`);
const OPTIONAL_RE = rx(`${BEFORE}(optional|nach belieben|nach geschmack|to taste|bei bedarf|as needed|wenn gewünscht|if desired)${AFTER}`, 'iu');
const LEAD_RE = rx('^(?:[-–—•*·▪●○□☐☑✓✔]+\\s*|\\[[ xX]?\\]\\s*)+');
const APPROX_RE = rx('^(?:ca\\.?|etwa|circa|about|approx\\.?|approximately|rund|~|≈)\\s*', 'iu');
const EXPLICIT_RE = rx(`(?:${BEFORE}(?:ca\\.?|etwa|circa|about|approx\\.?|je|à|á|a|each|per)\\s+|~|≈|@)?\\s*(${NUM})\\s*(g|gr|gramm|gramme|grams?|kg|ml|l|oz|lbs?|fl\\.?\\s*oz|cl|dl)${AFTER}\\.?`, 'iu');
const PER_RE = rx(`${BEFORE}(?:je|à|á|each)\\s+(${NUM})\\s*(g|gr|gramm|grams?|kg|ml|l|oz|lbs?)${AFTER}`, 'iu');
const BRACKET_RE = rx('[(\\[]([^()\\[\\]]*)[)\\]]', 'gu');
const COMMA_RE = rx(',\\s+|,(?!\\d)|;');
const GLUED_RE = rx('^(kg|mg|ml|cl|dl|g|l)(?=[A-ZÄÖÜ])');
const FLOZ_RE = rx(`^fl\\.?\\s*oz${AFTER}\\.?`, 'iu');
const TOKEN_RE = rx(`^(${LET}+)(\\.?)`);
const PER_START_RE = rx(`^\\s*(?:je|each|per|à|á)${AFTER}`, 'iu');
const CITRUS_RE = rx(
  `^(saft|schale|abrieb|juice|zest)\\s+(?:von|vom|einer|eines|einem|of|from)\\s+(?:(${NUM})\\s+|(halben?|half(?:\\s+an?)?|an?|1)\\s+)?(?:bio[- ]|unbehandelte[nr]?\\s+|organic\\s+|large\\s+|small\\s+|gro(?:ß|ss)en?\\s+|kleinen?\\s+)*(${LET}+)`, 'iu');
const EXPLICIT_START = anchored(EXPLICIT_RE);

/** Python's str.partition-like split at the first match: [before, after] or [whole]. */
function splitOnce(re: RegExp, text: string): string[] {
  const m = re.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text];
}

/** float(text) for what the number patterns produce; NaN where Python raises ValueError. */
const toFloat = (s: string): number => (/^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN);
const nul = (n: number): number | null => (Number.isNaN(n) ? null : n);

/** '1,5' / '1.5' -> 1.5; '1/2' -> 0.5; '1 1/2' -> 1.5; '1.500' -> 1500 (a thousands separator: three digits after it, integer part 1-999). */
export function parseNumber(input: string): number | null {
  const text = pyStrip(input);
  if (text.includes('/')) {
    const cut = text.lastIndexOf(' ');
    const whole = cut < 0 ? '' : text.slice(0, cut);
    const frac = cut < 0 ? text : text.slice(cut + 1);
    const slash = frac.indexOf('/');
    const top = slash < 0 ? frac : frac.slice(0, slash);
    const bottom = slash < 0 ? '' : frac.slice(slash + 1);
    const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);
    if (int(bottom) === 0) return null;
    const result = (whole ? int(whole) : 0) + int(top) / int(bottom);
    return Number.isNaN(result) ? null : result;
  }
  const parts = text.split(/[.,]/);
  const seps = text.match(/[.,]/g) ?? [];
  if (parts.length === 1) return nul(toFloat(parts[0]));
  if (new Set(seps).size === 2) return nul(toFloat(parts.slice(0, -1).join('') + '.' + parts[parts.length - 1])); // the last one is the decimal separator
  if (seps.length > 1) return nul(toFloat(parts.join(''))); // '1.234.567': thousands separators only
  const [whole, frac] = parts;
  if (frac.length === 3 && whole !== '' && whole !== '0' && whole.length <= 3) return nul(toFloat(whole + frac));
  return nul(toFloat((whole || '0') + '.' + frac));
}

function value(text: string): number | null {
  const m = RANGE_RE.exec(text);
  if (m) {
    const low = parseNumber(m[1]);
    const high = parseNumber(m[2]);
    if (low !== null && high !== null && 0 < low && low <= high) return (low + high) / 2;
  }
  return parseNumber(text);
}

function clean(input: string): string {
  let raw = input;
  for (const [char, frac] of Object.entries(T.VULGAR)) raw = raw.replaceAll(char, ` ${frac} `);
  const text = [...raw.normalize('NFKC')].filter((c) => !/[\p{Cc}\p{Cf}]/u.test(c) || c === '\t').join('');
  return pyStrip(text.replace(/\s+/g, ' '));
}

export type Basis = 'mass' | 'volume' | 'explicit' | 'piece' | 'unit' | 'none';

export interface Line {
  text: string;
  quantity: number | null;
  unit: string | null; // as written, lower case ('EL', 'cups', 'Dose')
  name: string;
  note: string | null;
  optional: boolean;
  grams: number | null;
  ml: number | null;
  estimated: boolean;
  basis: Basis; // where `grams` comes from
  canned: boolean; // the line counts cans (Dose, can): a canned food is meant
}

/** The value of the longest key of `table` found in the (folded) name: as a word, its plural, or the end of a compound. */
function lookup<V>(table: Record<string, V>, name: string, dflt: V | null = null, compounds = true): V | null {
  const tokens = fold(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const joined = tokens.join(' ');
  for (const key of Object.keys(table).filter((k) => k).sort((a, b) => b.length - a.length)) {
    if (key.includes(' ')) {
      if (joined.includes(key)) return table[key];
      continue;
    }
    for (const token of tokens) {
      if (token === key || (key.length >= 3 && token.startsWith(key) && token.length - key.length <= 3)) return table[key];
      if (compounds && key.length >= 4 && token.endsWith(key)) return table[key];
      if (key.length < 3 && [key + 's', key + 'e', key + 'er', key + 'en', key + 'n'].includes(token)) return table[key];
    }
  }
  return has(table, '') ? table[''] : dflt;
}

type Explicit = [number, string];

function splitExplicit(text: string): [string, Explicit | null, boolean] {
  const m = PER_RE.exec(text);
  if (m) {
    const v = parseNumber(m[1]);
    const unit = get(ALIASES, fold(m[2].replace(/[.\s]/g, '')));
    if (v !== null && unit && (has(T.MASS, unit) || has(T.VOLUME, unit))) return [text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length), [v, unit], true];
  }
  return [text, null, false];
}

/** 'Saft von 1 Zitrone', 'Schale einer Orange', 'juice of half a lemon': [count, grams, name, word as written], or null. */
function citrus(text: string): [number, number, string, string] | null {
  const m = CITRUS_RE.exec(text);
  if (!m) return null;
  const fruit = fold(m[4]);
  const row = get(T.CITRUS, fruit) || get(T.CITRUS, fruit.replace(/n+$/, '')) || get(T.CITRUS, fruit.replace(/s+$/, ''));
  if (!row) return null;
  const word = fold(m[1]);
  let count: number | null;
  if (m[2]) count = parseNumber(m[2]);
  else if (m[3] && /^(halb|half)/.test(fold(m[3]))) count = 0.5;
  else count = 1.0;
  if (!count || !(0 < count && count <= 1000)) return null;
  const juice = word === 'saft' || word === 'juice';
  return [count, count * (juice ? row[0] : row[1]), juice ? row[2] : row[3], m[1]];
}

/** One ingredient line, or null for a line that holds nothing (blank, only punctuation, a heading such as 'Für den Teig:'). */
export function parseLine(raw: string): Line | null {
  let text = pyStrip(clean(raw).replace(LEAD_RE, ''));
  if (!text || !/[\p{L}\p{N}_]/u.test(text) || (text.endsWith(':') && !/\d/.test(text))) return null;
  const line: Line = { text: pyStrip(raw), quantity: null, unit: null, name: '', note: null, optional: false, grams: null, ml: null, estimated: false, basis: 'none', canned: false };
  const notes: string[] = [];
  if (OPTIONAL_RE.test(text)) line.optional = true;

  // explicit weight in brackets or after "je" / "à"
  let explicit: Explicit | null = null;
  let perPiece = false;

  text = text.replace(BRACKET_RE, (_all, group: string) => {
    let inner = pyStrip(group);
    const e = explicit === null ? EXPLICIT_RE.exec(inner) : null;
    if (e) {
      const v = parseNumber(e[1]);
      const unit = get(ALIASES, fold(e[2].replace(/[.\s]/g, '')));
      if (v !== null && unit && (has(T.MASS, unit) || has(T.VOLUME, unit)) && v > 0) {
        explicit = [v, unit];
        perPiece = PER_START_RE.test(group); // "je 60 g": each; plain "(400 g)" is the total, except for cans and packs
        inner = stripChars(inner.slice(0, e.index) + ' ' + inner.slice(e.index + e[0].length), ' ,;-');
      }
    }
    if (inner) notes.push(inner);
    return ' ';
  });
  if (explicit === null) [text, explicit, perPiece] = splitExplicit(text);
  text = pyStrip(text.replace(/\s+/g, ' '));

  const [head0, ...more] = splitOnce(COMMA_RE, text);
  if (more.length && pyStrip(more[0])) notes.push(pyStrip(more[0]));
  let head = pyStrip(head0);

  const c = citrus(head);
  if (c !== null) { // "Saft von 1 Zitrone"
    const [count, weight, name, word] = c;
    line.quantity = count;
    line.unit = word;
    line.name = name;
    line.grams = roundHalfEven(weight, 1);
    line.estimated = true;
    line.basis = 'unit';
    line.note = pyHead(notes.filter((n) => n).join('; '), 300) || null;
    return line;
  }

  // quantity
  head = head.replace(APPROX_RE, '');
  let quantity: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = RANGE_RE.exec(head))) {
    quantity = value(head);
    head = pyStrip(head.slice(m[0].length));
  } else if ((m = QTY_RE.exec(head))) {
    quantity = parseNumber(m[1]);
    head = pyStrip(head.slice(m[0].length));
    if (/^[x×]\s/.test(head)) { // "2 x Eier", "2 x 200 g Mehl"
      head = pyStrip(head.slice(1));
      const e = EXPLICIT_START.exec(head);
      if (e && explicit === null) {
        const v = parseNumber(e[1]);
        const eunit = get(ALIASES, fold(e[2].replace(/[.\s]/g, '')));
        if (v && eunit && (has(T.MASS, eunit) || has(T.VOLUME, eunit))) {
          explicit = [v, eunit];
          perPiece = true;
          head = pyStrip(head.slice(e[0].length));
        }
      }
    }
  } else if ((m = rx(`^(${LET}+)${AFTER}`).exec(head))) {
    const word = fold(m[1]);
    const after = pyStrip(head.slice(m[0].length));
    if (has(T.WORD_NUMBERS, word) && (word !== 'a' && word !== 'an' || unitOf(after)[0])) {
      quantity = T.WORD_NUMBERS[word];
      head = after;
      const half = rx(`^(halbe|halber|halbes|halb|half)${AFTER}`, 'iu').exec(head); // "eine halbe Zitrone", "a half cup"
      if (half) {
        quantity *= 0.5;
        head = pyStrip(head.slice(half[0].length));
      }
    }
  }
  if (quantity === null && explicit === null) {
    const e = rx(`\\s(${NUM})\\s*(${LET}+\\.?)$`).exec(head); // the amount at the end: "Mehl 200 g", "Salz 1 Prise"
    if (e) {
      const v = parseNumber(e[1]);
      const canonEnd = get(ALIASES, fold(e[2].replace(/\.+$/, '')));
      if (v && canonEnd && (has(T.MASS, canonEnd) || has(T.VOLUME, canonEnd) || ITEMS.has(canonEnd))) {
        quantity = v;
        head = pyStrip(`${e[2]} ${pyStrip(head.slice(0, e.index))}`);
      }
    }
  }
  if (quantity !== null && !(0 < quantity && quantity <= MAX_QUANTITY)) quantity = null;
  line.quantity = quantity;

  // modifiers ("gestr.", "heaped", "große") between quantity and unit
  let size = 1.0;
  for (;;) {
    const mm = rx(`^(${LET}+\\.?)\\s*`).exec(head);
    if (!mm) break;
    const word = fold(mm[1]);
    const bare = word.replace(/\.+$/, '');
    if (MODIFIERS.has(word)) head = head.slice(mm[0].length);
    else if (has(T.SIZE, bare) && !unitOf(head)[0]) {
      size = T.SIZE[bare];
      head = head.slice(mm[0].length);
    } else break;
  }

  const [unitWord, canon, rest] = unitOf(head);
  head = rest.replace(rx(`^(?:of|von|vom|aus)\\s+`, 'iu'), ''); // "of" / "von" between unit and name
  if (unitWord && quantity === null && canon !== null && ITEMS.has(canon)) {
    quantity = 1.0; // "Prise Salz", "pinch of salt"
    line.quantity = null;
  }
  line.unit = unitWord;

  // name: first alternative, without cutting words
  const [first, ...alternative] = splitOnce(rx('\\s+(?:oder|or|und|and|&)\\s+', 'iu'), head);
  let name = first;
  if (alternative.length) notes.push(alternative[0]);
  let kept: string[] = [];
  let dropped: string[] = [];
  for (const word of pySplit(name)) (PREP.has(fold(stripChars(word, '.,;:'))) ? dropped : kept).push(word);
  name = stripChars(kept.join(' '), ' -–—.:;/');
  if (!name) {
    name = stripChars(head, ' -–—.:;/');
    dropped = [];
  } else notes.push(...dropped);
  line.name = pyHead(name, 200);
  line.note = pyHead(notes.filter((n) => n).join('; '), 300) || null;

  line.canned = canon === 'can' || rx(`${BEFORE}(?:dose|dosen|konserve|can|cans|canned|tin|tinned)${AFTER}`, 'iu').test(raw);
  weigh(line, quantity, canon, explicit, perPiece, size);
  return line;
}

/** The unit at the start of `text`: [as written, canonical, the rest]. [null, null, text] when there is none. */
function unitOf(text: string): [string | null, string | null, string] {
  const f = FLOZ_RE.exec(text);
  if (f) return [pyStrip(text.slice(0, f[0].length)), 'floz', pyStrip(text.slice(f[0].length))];
  const m = TOKEN_RE.exec(text);
  if (!m) return [null, null, text];
  const canon = get(ALIASES, fold(m[1])) ?? null;
  if (canon === null) {
    const glued = GLUED_RE.exec(text);
    if (glued) return [glued[1], ALIASES[glued[1]], pyStrip(text.slice(glued[0].length))]; // "200gMehl", "1ELHonig"
  }
  if (canon === null || (text.length > m[0].length && !' .,(/;'.includes(text[m[0].length]) && !text.slice(m[0].length).startsWith('-'))) return [null, null, text];
  return [m[1] + m[2], canon, pyStrip(text.slice(m[0].length))];
}

function weigh(line: Line, quantity: number | null, canon: string | null, explicit: Explicit | null, perPiece: boolean, size: number): void {
  const name = line.name;
  const counted = canon === null || ITEMS.has(canon);
  const amount = quantity !== null ? quantity : canon !== null && ITEMS.has(canon) ? 1.0 : null;
  const density = () => lookup(T.DENSITY, name, null);
  const fromMl = (ml: number, varies = false) => {
    const d = density();
    line.ml = roundHalfEven(ml, 2);
    line.grams = ml * (d !== null ? d : 1.0);
    line.estimated = d === null || varies;
    line.basis = 'volume';
  };

  if (explicit !== null && (amount !== null || counted)) {
    const [v, unit] = explicit;
    const times = counted && (perPiece || (canon !== null && CONTAINERS.has(canon))) ? (amount !== null ? amount : 1.0) : 1.0;
    if (has(T.MASS, unit)) {
      line.grams = v * T.MASS[unit] * times;
      line.basis = 'explicit';
      line.estimated = false;
    } else {
      fromMl(v * T.VOLUME[unit][0] * times);
      line.basis = 'explicit';
    }
  } else if (canon !== null && has(T.MASS, canon) && amount !== null) {
    line.grams = amount * T.MASS[canon];
    line.basis = 'mass';
    const d = density();
    if (d !== null) line.ml = roundHalfEven(line.grams / d, 2);
  } else if (canon !== null && has(T.VOLUME, canon) && amount !== null) {
    const [factor, varies] = T.VOLUME[canon];
    fromMl(amount * factor, varies);
  } else if (counted && amount !== null) {
    let each: number | null = null;
    if (canon !== null && ITEMS.has(canon) && canon !== 'piece') {
      const table = T.UNIT_WEIGHTS[canon];
      if (table) {
        each = lookup(table, name, null);
        if (each === null) each = has(table, '') ? table[''] : null;
      }
    }
    if (each === null && (canon === null || canon === 'piece')) {
      each = lookup(T.PIECES, name, null);
      if (each !== null) each *= size;
    }
    if (each !== null) {
      line.grams = amount * each;
      line.estimated = true;
      line.basis = canon === null || canon === 'piece' ? 'piece' : 'unit';
    }
  }
  if (line.grams !== null) {
    if (!(0 < line.grams && line.grams <= MAX_GRAMS)) {
      line.grams = line.ml = null;
      line.estimated = false;
      line.basis = 'none';
    } else line.grams = roundHalfEven(line.grams, 1);
  }
  if (line.grams === null) {
    line.ml = null;
    line.estimated = false;
    line.basis = 'none';
  }
}

/** All lines with something in them as [line number from 1, parsed line], and how many non-empty lines were left out. */
export function parseText(text: string): { lines: [number, Line][]; ignored: number } {
  const lines: [number, Line][] = [];
  let ignored = 0;
  pySplitLines(text).forEach((raw, i) => {
    if (!pyStrip(raw)) return;
    const line = parseLine(raw);
    if (line === null) ignored++;
    else lines.push([i + 1, line]);
  });
  return { lines, ignored };
}

// --- the finding of foods --------------------------------------------------------------------------------------------

/** What the catalogue (a service of the host, `ctx.services.catalog`) gives back for a search: the hit shape of catalog.py. */
export interface CatalogHit {
  source: string; code: string; name: string; name_en?: string | null; brand?: string | null; unit: string; per_100: Record<string, number | null>;
  [k: string]: unknown;
}
export interface CatalogSearch {
  /** `skip` gets a list of hits and answers the `skipKey`s of those that exist as a food already (they are left out). */
  search(query: string, limit: number, source: string | null, skip?: (hits: CatalogHit[]) => Promise<Set<string>>): Promise<CatalogHit[]>;
}
export const skipKey = (source: string, code: string): string => `${source}\u0000${code}`;

/** A stored food as the finding needs it: a store row with its data. */
export interface OwnFood { id: number; code: string | null; source: string; data: { name?: string | null; brand?: string | null; unit?: string | null; per_100: Record<string, number | null> } }

export interface Candidate {
  source: string; name: string; brand: string | null; unit: string; per_100: Record<string, number | null>;
  food_id: number | null; code: string | null;
  good: boolean; // a confident match; the first candidate is only suggested when it is
  eaten_count: number; // entries of this food in the last RECENT_DAYS days (only asked for with `eaten`)
  eaten_last: string | null;
}
export type Eaten = Map<number, { count: number; last: string }>;

const RAW = new Set(['roh', 'raw']);
const USER_SOURCES = ['own', 'yazio'];
const USER_BONUS = 4.0;
const RECENT_BONUS = 5.0; // a stored food eaten in the last days (photo of a meal): most likely the same one again
export const RECENT_DAYS = 14;
const GOOD_LIMIT = 1.0; // an average word match worse than this (the word only starts a longer word) is no confident suggestion
const BASIC_POOL = 60; // how many basic foods of a search are ranked again here
const NAME_SPLIT = /[\s\-/&+]+/;

const tokensOf = words;

const isDigits = (s: string) => /^\p{Nd}+$/u.test(s);
const isUpper = (ch: string) => /^\p{Lu}/u.test(ch);

/** The usual search words of an ingredient name ("Eier" -> "Hühnerei roh"), or null. */
export function usualQuery(name: string): string | null {
  const found = lookup(T.USUAL_KEYS, name, null, false);
  if (found !== null) return found;
  for (const token of words(name)) { // "Paprikaschote", "Brokkoliröschen": the food and a word for its cut or part
    for (const tail of T.TAILS) {
      if (token.endsWith(tail) && token.length > tail.length + 2) {
        const key = fold(token.slice(0, -tail.length));
        if (has(T.USUAL_KEYS, key)) return T.USUAL_KEYS[key];
      }
    }
  }
  return null;
}

function isDish(token: string): boolean {
  if (token === 'suppe' || token === 'soup') return false;
  return DISH_WORDS.has(token) || [...DISH_WORDS].some((d) => d !== 'suppe' && d.length >= 5 && token.endsWith(d) && token.length - d.length >= 3);
}

/** How well `word` fits the words of a name: 0 the word itself, 0.5 with a plural ending, 1 the end of a compound (Speisesalz for Salz),
 * 2 the start of a longer word (Salzburger, Butterzwieback), 3 somewhere inside; null when it does not occur. */
function wordClass(word: string, tokens: string[]): number | null {
  let best: number | null = null;
  for (const token of tokens) {
    if (token === word) return 0.0;
    let c: number;
    if (token.startsWith(word)) c = token.length - word.length <= 3 ? 0.5 : 2.0;
    else if (word.length >= 4 && token.endsWith(word)) c = 1.0;
    else if (word.length >= 4 && token.includes(word)) c = 3.0;
    else continue;
    best = best === null || c < best ? c : best;
  }
  return best;
}

/** For names people typed (own foods, Yazio, products): every noun before the first comma or bracket is one the line asks for. */
function namesOnly(name: string, ws: string[], context: Set<string>): boolean {
  const nouns = splitOnce(/[,(;]/, name)[0].split(NAME_SPLIT).filter((w) => w.slice(0, 1) !== '' && isUpper(w));
  for (const noun of nouns) {
    const tokens = tokensOf(noun);
    if (!tokens.length || tokens.every((t) => ADJECTIVES.has(t) || STOP.has(t) || PREP.has(t) || PREPARED.has(t) || RAW.has(t) || isDigits(t) || context.has(t))) continue;
    if (!ws.some((w) => { const c = wordClass(w, tokens); return c !== null && c <= 0.5; })) return false; // 'Kokosmilch' is not milk
  }
  return true;
}

/** The words of a line plus every word that says the same about the preparation; and whether the line names a preparation at all. */
function expand(context: Set<string>): [Set<string>, boolean] {
  const expanded = new Set(context);
  let named = false;
  for (const group of T.SAME_WORDS) {
    if ([...context].some((c) => group.includes(c) || group.some((w) => w.length >= 5 && c.startsWith(w)))) {
      for (const w of group) expanded.add(w);
      named = true;
    }
  }
  return [expanded, named];
}

type Scored = { score: number; confident: boolean; credit: boolean; close: boolean };

/** (score, confident, says the preparation of the line, close) of a food for the search words; smaller is better. null when a word does not occur
 * in any of the names. `close`: every search word is a whole word or the end of a compound of the name. `sure` false: the search words leave out
 * part of the line, so no food can be a confident match. */
function score(ws: string[], names: string[], context: Set<string>, code: string | null, source: string, said: Set<string>, sure = true): Scored | null {
  let best: { score: number; confident: boolean; credit: boolean; close: boolean } | null = null;
  for (const name of names) {
    const tokens = tokensOf(name);
    if (!tokens.length) continue;
    const classes = ws.map((w) => wordClass(w, tokens));
    if (classes.some((c) => c === null)) continue;
    const cls = (classes as number[]).reduce((a, b) => a + b, 0);
    const prepared = tokens.filter((t) => PREPARED.has(t));
    let penalty = prepared.filter((t) => !context.has(t)).reduce((s, t) => s + (t.endsWith('pulver') ? 2 : 1), 0);
    penalty += 2 * tokens.filter((t) => t.endsWith('pulver') && !PREPARED.has(t) && !context.has(t)).length; // "Instantpulver": the dry mix
    const credit = prepared.filter((t) => context.has(t)).length;
    const exact = prepared.filter((t) => said.has(t)).length; // the very word of the line counts more than one that says the same
    const dish = tokens.some((t) => isDish(t) && !context.has(t)); // a stew, a cake, a Baumkuchen: not the plain food
    const raw = tokens.some((t) => RAW.has(t)) ? -2.0 : 0.0;
    const base = source === 'bls' && code && code.endsWith('00') ? -1.0 : 0.0;
    const extra = Math.max(0, tokens.length - ws.length) * 0.2;
    const first = ws.some((w) => tokens[0] === w || (tokens[0].startsWith(w) && tokens[0].length - w.length <= 3)) ? -1.0 : 0.0; // the food comes first in its name
    const s = 2 * cls + 3 * penalty - 4 * credit - 3 * exact + raw + base + extra + first;
    if (best === null || s < best.score) {
      const close = sure && cls <= GOOD_LIMIT * ws.length && !dish;
      const confident = close && (source === 'bls' || namesOnly(name, ws, context));
      best = { score: s, confident, credit: credit > 0, close };
    }
  }
  if (best === null) return null;
  return { ...best, score: best.score - (USER_SOURCES.includes(source) && best.confident ? USER_BONUS : 0.0) };
}

/** 'grüne' -> 'grun', 'rote' -> 'rot': the colour a word names (a colour can make a food of its own: grüne Bohnen, rote Linsen). */
function colour(token: string): string | null {
  for (const stem of T.COLOURS) if (token === stem || (token.startsWith(stem) && ['e', 'er', 'en', 'es', 'em'].includes(token.slice(stem.length)))) return stem;
  return null;
}

/** The words of a name that say what the food is: without numbers, filler words, cutting and preparation words, adjectives. */
function core(full: string[]): string[] {
  const a = full.filter((w) => !isDigits(w) && !STOP.has(w) && !PREP.has(w) && !ADJECTIVES.has(w));
  const c = a.length ? a : full.filter((w) => !isDigits(w) && !STOP.has(w));
  const b = c.filter((w) => !PREPARED.has(w));
  return b.length ? b : c;
}

/** Whether the search words still stand for every word of the name ('schoko' alone does not stand for 'Schoko-Cerealien'). */
const covers = (tokens: string[], c: string[]): boolean => c.every((w) => tokens.some((t) => t === w || w.startsWith(t) || t.startsWith(w)));

const singular = (word: string): string => {
  for (const ending of ['en', 'er', 'n', 'e', 's']) if (word.endsWith(ending) && word.length - ending.length >= 2) return word.slice(0, -ending.length);
  return word;
};

/** What to look for, most specific first: all words, then fewer (from the end, then from the front), then single words, each also without a
 * plural ending. Numbers and filler words ('Typ 405', 'extra') are left out of every variant but the first. */
export function variants(name: string): string[][] {
  const full = tokensOf(name);
  const c = core(full);
  const result: string[][] = [];
  const seen = new Set<string>();
  const add = (tokens: string[]) => {
    const key = JSON.stringify(tokens);
    if (tokens.length && !seen.has(key)) { seen.add(key); result.push(tokens); }
  };
  add(full);
  const coloured = full.filter((w) => !isDigits(w) && !STOP.has(w) && !PREP.has(w) && !PREPARED.has(w)).map((w) => colour(w) ?? w);
  if (full.some((w) => colour(w))) add(coloured); // "grüne Bohnen" -> "grun bohnen" before the colour is dropped
  add(c);
  for (let n = c.length - 1; n > 0; n--) add(c.slice(0, n));
  for (let n = 1; n < c.length; n++) add(c.slice(n));
  for (const word of [...c].reverse()) add([word]); // the noun comes last in German and in English
  for (const tokens of [...result]) add(tokens.map(singular));
  return result.slice(0, 12);
}

const fromFood = (food: OwnFood, good: boolean): Candidate => ({
  source: food.source, food_id: food.id, code: food.code ?? null, name: food.data.name || food.code || '?', brand: food.data.brand ?? null,
  unit: food.data.unit || 'g', per_100: food.data.per_100, good, eaten_count: 0, eaten_last: null,
});

const fromItem = (item: CatalogHit, good = true): Candidate => ({
  source: item.source, food_id: null, code: item.code, name: item.name, brand: item.brand ?? null, unit: item.unit, per_100: item.per_100,
  good, eaten_count: 0, eaten_last: null,
});

type Skip = (hits: CatalogHit[]) => Promise<Set<string>>;

async function packaged(catalog: CatalogSearch | undefined, tokens: string[], limit: number, skip: Skip | undefined, context: Set<string>, sure: boolean): Promise<Candidate[]> {
  const query = tokens.join(' ');
  if (!catalog || [...query].length < 2) return [];
  const result: Candidate[] = [];
  for (const item of await catalog.search(query, limit, 'openfoodfacts', skip)) {
    const hit = score(tokens, [item.name], context, item.code, 'openfoodfacts', new Set(), sure);
    result.push(fromItem(item, hit !== null && hit.confident));
  }
  return result;
}

/** Up to MAX_CANDIDATES foods that may be meant by `name`, best first. The search words are tried from the usual meaning of the ingredient to
 * ever looser forms of the name; the first form that finds an own or basic food wins. Stored foods and the basic foods of the catalogue are
 * ranked together by `score`; packaged products come only after those, and alone only when nothing else was found. `context` is the whole line
 * (what it says about the preparation); `canned` says the line is about a can. `catalog` may be missing. `eaten` (food id -> {count, last}, the
 * person's diary of the last days): a stored food eaten lately whose name holds every word of the line comes first and counts as a confident match. */
export async function candidates(name: string, ownFoods: OwnFood[], catalog: CatalogSearch | undefined, skip?: Skip, context = '', canned = false, eaten?: Eaten | null): Promise<Candidate[]> {
  let contextWords = new Set(tokensOf(context));
  if (canned) { contextWords.add('konserve'); contextWords.add('canned'); }
  const said = new Set([...contextWords, ...[...PREPARED].filter((t) => [...t].length >= 5 && [...contextWords].some((c) => c.startsWith(t)))]); // "gebratenes" says "gebraten"
  const [expanded, saysPrepared] = expand(contextWords);
  contextWords = expanded;
  const nameTokens = tokensOf(name);
  const colours = new Set<string>();
  for (const w of nameTokens) { const c = colour(w); if (c) colours.add(c); }
  for (const w of nameTokens) if (DISH_WORDS.has(w)) colours.add(w); // words that make a food of its own
  const steps: string[][] = [];
  let tableSteps = 0;
  const usual = nameTokens.some((w) => DISH_WORDS.has(w)) ? null : usualQuery(name);
  if (usual !== null) {
    let usualWords = tokensOf(usual);
    if (canned || saysPrepared) usualWords = usualWords.filter((w) => !RAW.has(w)).length ? usualWords.filter((w) => !RAW.has(w)) : usualWords; // the line names the preparation: "Tomate roh" becomes "Tomate"
    steps.push(usualWords);
    tableSteps = 1;
  }
  const seenSteps = new Set(steps.map((s) => JSON.stringify(s)));
  for (const t of variants(name)) if (!seenSteps.has(JSON.stringify(t))) { seenSteps.add(JSON.stringify(t)); steps.push(t); }
  const coreWords = core(nameTokens);
  const sure = steps.map((tokens, i) => i < tableSteps || covers(tokens, coreWords));
  const good = (hit: Scored) => hit.confident && (hit.credit || !saysPrepared);

  const stored = (tokens: string[], position: number): [number, number, Candidate][] => {
    const found: [number, number, Candidate][] = [];
    ownFoods.forEach((food, index) => {
      const hit = score(tokens, [food.data.name || ''], contextWords, food.code, food.source, said, sure[position]);
      if (hit === null) return;
      const candidate = fromFood(food, good(hit));
      let s = hit.score;
      const seen = eaten?.get(food.id);
      if (seen) {
        candidate.eaten_count = seen.count;
        candidate.eaten_last = seen.last;
        if (hit.close && (hit.credit || !saysPrepared)) { // fits the line, maybe with more words: most likely this one again
          candidate.good = true;
          s -= RECENT_BONUS + 0.3 * Math.min(seen.count, 5);
        }
      }
      found.push([s, index, candidate]);
    });
    return found;
  };
  const byScore = (a: [number, number, Candidate], b: [number, number, Candidate]) => a[0] - b[0] || a[1] - b[1];

  // stored foods are looked for with every form of the name, the first form that finds one wins; the basic foods of the catalogue the same way
  let ownHits: [number, number, Candidate][] = [];
  for (let p = 0; p < steps.length; p++) {
    const hits = stored(steps[p], p);
    if (hits.length) { ownHits = hits; break; }
  }
  for (let position = 0; position < steps.length; position++) {
    const tokens = steps[position];
    const scored = [...ownHits];
    const loose = position >= tableSteps && colours.size > 0 && !tokens.some((t) => colours.has(t)); // "grüne Bohnen" found as "Bohnen": no sure match
    if (catalog && [...tokens.join(' ')].length >= 2) {
      const items = await catalog.search(tokens.join(' '), BASIC_POOL, 'bls', skip);
      items.forEach((item, i) => {
        const hit = score(tokens, [item.name, item.name_en || ''], contextWords, item.code, 'bls', said, sure[position]);
        if (hit !== null) scored.push([hit.score, ownFoods.length + i, fromItem(item, good(hit))]);
      });
    }
    if (scored.length > ownHits.length || (ownHits.length && position === steps.length - 1)) {
      const found = scored.sort(byScore).slice(0, MAX_CANDIDATES).map((r) => r[2]);
      if (loose) for (const c of found) c.good = false;
      if (found.length < MAX_CANDIDATES && !found[0].good) { // packaged products only where the basic foods give no confident answer
        found.push(...await packaged(catalog, tokens, MAX_CANDIDATES - found.length, skip, contextWords, sure[position]));
      }
      return found;
    }
  }
  if (ownHits.length) return ownHits.sort(byScore).slice(0, MAX_CANDIDATES).map((r) => r[2]);
  for (let p = 0; p < steps.length; p++) {
    const found = await packaged(catalog, steps[p], MAX_CANDIDATES, skip, contextWords, sure[p]);
    if (found.length) return found;
  }
  return [];
}

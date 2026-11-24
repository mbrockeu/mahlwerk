// The local catalogue (catalog.py, read side): read-only SQLite files with foods, searchable by name. Every source has its own
// file. The files are opened by the host (`CatalogFiles`); everything else – folding, the queries, the ranking – is here.
import type { Row } from './db.ts';
import type { Ctx } from './http.ts';
import { clean } from './nutrients.ts';
import { isComplete, PER_100_KEYS } from './nutrition.ts';
import type { CatalogInfo, CatalogItem, CatalogSourceInfo } from './models/catalog.ts';

export const OFF = 'openfoodfacts';
export const BLS = 'bls';
const BLS_FIRST = 8; // a search without `source` lists up to this many BLS hits before the packaged products
const RAW_BONUS = 12; // a raw basic form ranks as if its name were this many characters shorter
const COMPOUND_BELOW = 3; // fewer name-start hits than this for one word: also look for compound spellings
const BLS_CANDIDATES = 1500; // BLS hits are ranked here; the file is small, this is more than any query matches

/** Read access to the catalogue files. `all` answers a query on the file of `source`; null: no readable file, or a query it could
 * not answer (both mean "nothing found"). Every call may open its own short-lived read-only connection. */
export interface CatalogFiles {
  all(source: string, sql: string, params?: Record<string, string | number> | (string | number)[]): Promise<Row[] | null>;
}

/** Python's str.casefold() for what the folding needs: lower case, `ß` stays (see `fold`). */
const casefold = (s: string): string => s.toLowerCase().replace(/ẞ/g, 'ss').replace(/ς/g, 'σ').replace(/ſ/g, 's');

/** Lower case without diacritics ('Äpfel' -> 'apfel'), like the FTS tokenizer sees words. 'ß' stays: the full text index keeps it too. */
export function fold(text: string): string {
  const decomposed = text.split('ß').map(casefold).join('ß').normalize('NFKD');
  return decomposed.replace(/\p{M}/gu, '');
}

export const words = (text: string): string[] => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
export const nameKey = (name: string): string => words(name).join(' ');
/** The name without spaces and hyphens ('Hafer Flocken' -> 'haferflocken'), so that a compound word finds it. */
export const nameCompact = (name: string | null | undefined): string | null => (name ? words(name).join('') : null);

/** A catalogue entry in the shape stored in `food.data`. */
export function foodData(item: CatalogItem) {
  return {
    name: item.name, brand: item.brand, quantity: item.quantity, serving_size: item.serving_size,
    serving_quantity: item.serving_quantity, unit: item.unit, per_100: item.per_100, complete: item.complete, extra: item.extra ?? {},
  };
}

/** How a food adopted from the catalogue is recognised later when it has no barcode (BLS foods). */
export const externalId = (source: string, code: string): string | null => (source === BLS ? `${source}:${code}` : null);

const item = (row: Row): CatalogItem => {
  const per100 = Object.fromEntries(PER_100_KEYS.map((k) => [k, row[k] ?? null])) as CatalogItem['per_100'];
  // a catalogue file built before the additional nutrients or the English name existed has no such column
  return {
    source: row.source, code: row.code, name: row.name, name_en: row.name_en ?? null, brand: row.brand ?? null,
    quantity: row.quantity ?? null, serving_size: row.serving_size ?? null, serving_quantity: row.serving_quantity ?? null,
    unit: row.unit, per_100: per100, extra: clean(row.extra ? JSON.parse(row.extra) : {}), complete: isComplete(per100),
  };
};

const match = (tokens: string[]): string => tokens.map((t) => `"${t}"*`).join(' '); // tokens are letters and digits only

const compareTuple = (a: (string | number)[], b: (string | number)[]): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
};

export class Catalog {
  files: CatalogFiles;
  /** Paths for the host (the refresh job writes the Open Food Facts file). */
  path: string;
  constructor(files: CatalogFiles, path = '') {
    this.files = files;
    this.path = path;
  }

  private async fileInfo(source: string): Promise<CatalogSourceInfo> {
    const rows = await this.files.all(source, 'SELECT key, value FROM meta');
    if (!rows) return { products: 0, updated_at: null };
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const products = Number.parseInt(meta.products ?? '0', 10);
    const updated = meta.updated_at !== undefined ? Number.parseInt(meta.updated_at, 10) : null;
    if (Number.isNaN(products) || (updated !== null && Number.isNaN(updated))) return { products: 0, updated_at: null };
    return { products, updated_at: updated };
  }

  /** Size and age of the catalogue: {products, updated_at} of Open Food Facts and `bls` with the same two. */
  async info(): Promise<CatalogInfo> {
    return { ...(await this.fileInfo(OFF)), bls: await this.fileInfo(BLS) };
  }

  async get(source: string, code: string): Promise<CatalogItem | null> {
    const rows = await this.files.all(source, 'SELECT * FROM product WHERE source = ? AND code = ?', [source, code]);
    return rows?.[0] ? item(rows[0]) : null;
  }

  /** Foods whose name (or brand) contains every word of `query` (as a word start), best first.
   * Without `source`: up to 8 basic foods (BLS), then packaged products (Open Food Facts) up to `limit` in all. With `source`: only
   * that one. `skip` gets a list of hits and returns the "source/code" keys to leave out (those already stored as a food). */
  async search(query: string, limit = 25, source: string | null = null,
    skip: ((hits: CatalogItem[]) => Promise<Set<string>>) | null = null): Promise<CatalogItem[]> {
    const tokens = words(query);
    if (!tokens.length || limit < 1) return [];
    const take = async (src: string, n: number): Promise<CatalogItem[]> => {
      if (n < 1) return [];
      let hits = await this.searchFile(src, tokens, skip ? n * 2 + 20 : n);
      if (skip) {
        const dropped = await skip(hits);
        hits = hits.filter((h) => !dropped.has(`${h.source}/${h.code}`));
      }
      return hits.slice(0, n);
    };
    if (source !== null) return take(source, limit);
    const basics = await take(BLS, Math.min(BLS_FIRST, limit));
    return [...basics, ...(await take(OFF, limit - basics.length))];
  }

  private async searchFile(source: string, tokens: string[], limit: number): Promise<CatalogItem[]> {
    let hits: CatalogItem[];
    if (source === BLS) hits = await this.searchBls(tokens, limit);
    else if (source === OFF) hits = await this.searchOff(tokens, limit);
    else return [];
    return tokens.length === 1 ? this.withCompounds(source, tokens, hits, limit) : hits;
  }

  private static starts(it: CatalogItem, word: string): boolean {
    return [it.name, it.name_en].some((name) => name && nameKey(name).startsWith(word));
  }

  private async hasCompactColumns(source: string): Promise<boolean> {
    const cols = await this.files.all(source, 'PRAGMA table_info(product)');
    const names = new Set((cols ?? []).map((r) => r.name));
    return names.has('name_compact') && names.has('name_compact_en');
  }

  /** A food whose whole name is the word, only written apart ("Hafer Flocken" for "haferflocken"), goes to the top. */
  private async wholeNameFirst(source: string, word: string, hits: CatalogItem[], limit: number): Promise<CatalogItem[]> {
    if (!(await this.hasCompactColumns(source))) return hits;
    const rows = await this.files.all(source,
      'SELECT * FROM product WHERE source = :source AND (name_compact = :w OR name_compact_en = :w) ORDER BY id LIMIT 3', { source, w: word });
    const exact = (rows ?? []).map(item);
    if (!exact.length) return hits;
    const codes = new Set(exact.map((e) => e.code));
    return [...exact, ...hits.filter((h) => !codes.has(h.code))].slice(0, limit);
  }

  /** A single word that finds fewer than 3 names starting with it also finds names that only spell it with a space. */
  private async withCompounds(source: string, tokens: string[], hits: CatalogItem[], limit: number): Promise<CatalogItem[]> {
    const word = tokens[0]!;
    hits = await this.wholeNameFirst(source, word, hits, limit);
    const starting = hits.filter((h) => Catalog.starts(h, word) || [nameCompact(h.name), nameCompact(h.name_en)].includes(word));
    if (starting.length >= COMPOUND_BELOW) return hits;
    if (!(await this.hasCompactColumns(source))) return hits;
    const upper = word.slice(0, -1) + String.fromCodePoint(word.codePointAt(word.length - 1)! + 1);
    const rows = await this.files.all(source,
      'SELECT * FROM product WHERE source = :source AND (name_compact >= :w AND name_compact < :u '
      + 'OR name_compact_en >= :w AND name_compact_en < :u) ORDER BY length(name_key), id LIMIT :limit', { source, w: word, u: upper, limit });
    const seen = new Set(hits.map((h) => h.code));
    const extra = (rows ?? []).filter((r) => !seen.has(r.code)).map(item);
    if (!extra.length) return hits;
    const rest = hits.filter((h) => !starting.includes(h));
    return [...starting, ...extra, ...rest].slice(0, limit);
  }

  private async searchOff(tokens: string[], limit: number): Promise<CatalogItem[]> {
    const rows = await this.files.all(OFF,
      'SELECT p.* FROM product_fts JOIN product p ON p.id = product_fts.rowid WHERE product_fts MATCH :match '
      + "ORDER BY CASE WHEN p.name_key = :first OR p.name_key LIKE :first || ' %' THEN 0 "
      + "              WHEN p.name_key LIKE :first || '%' THEN 1 ELSE 2 END, "
      + '         length(p.name_key) - min(p.popularity, 400) / 10.0, p.name_key, p.id LIMIT :limit',
      { match: match(tokens), first: tokens[0]!, limit });
    return (rows ?? []).map(item);
  }

  /** Basic foods matching every word in the German or the English name, best first (see catalog.py `_search_bls`). */
  private async searchBls(tokens: string[], limit: number): Promise<CatalogItem[]> {
    const rows = await this.files.all(BLS,
      'SELECT p.* FROM product_fts JOIN product p ON p.id = product_fts.rowid WHERE product_fts MATCH ? ORDER BY length(p.name_key), p.id LIMIT ?',
      [match(tokens), BLS_CANDIDATES]);
    const first = tokens[0]!;
    const rank = (row: Row): (string | number)[] => {
      let best: [number, number] | null = null;
      for (const [key, rawWord] of [[row.name_key, 'roh'], [row.name_key_en ?? '', 'raw']] as const) {
        if (!key) continue;
        const klass = key === first || key.startsWith(first + ' ') ? 0 : key.startsWith(first) ? 1 : 2;
        const length = key.length - (key.split(/\s+/).includes(rawWord) ? RAW_BONUS : 0);
        if (best === null || klass < best[0] || (klass === best[0] && length < best[1])) best = [klass, length];
      }
      return [...(best ?? [3, 0]), row.name_key, row.id];
    };
    return [...(rows ?? [])].sort((a, b) => compareTuple(rank(a), rank(b))).slice(0, limit).map(item);
  }
}

/** The catalogue of the host; without one everything is empty. */
export const catalogOf = (ctx: Ctx): Catalog => (ctx.services.catalog as Catalog | undefined) ?? new Catalog({ all: async () => null });

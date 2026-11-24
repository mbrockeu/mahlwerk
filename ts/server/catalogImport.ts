// Build a new catalogue from the Open Food Facts CSV export (catalog.py `import_off`): gzip, tab separated. Streams the source; nothing is
// held in memory or unpacked on disk. A cut-off gzip file is read up to its end and reported in `truncated`. Nothing is replaced when
// the import fails or keeps no product at all. The new file is swapped in with an atomic rename, so a running server keeps reading the
// old one meanwhile. Runs in a worker thread (server/jobs.ts): it is long and the sqlite calls are synchronous.
import { createReadStream, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip } from 'node:zlib';
import { nameCompact, nameKey, OFF } from '../core/catalog.ts';
import { extraFromOff, parseNumber } from '../core/nutrients.ts';
import { roundHalfEven } from '../core/num.ts';
import { CORE, guessUnit, PER_100_KEYS } from '../core/nutrition.ts';
import { VERSION } from '../core/version.ts';

export const OFF_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
const PROGRESS_EVERY = 200_000;
const BATCH = 5_000;

const SCHEMA = `
CREATE TABLE product (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, brand TEXT, quantity TEXT, serving_size TEXT,
    serving_quantity REAL, unit TEXT NOT NULL, kcal REAL NOT NULL, fat REAL, saturated_fat REAL, carbs REAL, sugars REAL, fiber REAL,
    protein REAL, salt REAL, extra TEXT, popularity INTEGER NOT NULL DEFAULT 0, name_key TEXT NOT NULL, name_en TEXT, name_key_en TEXT,
    name_compact TEXT, name_compact_en TEXT, UNIQUE (source, code)
);
CREATE INDEX product_name_compact ON product (name_compact);
CREATE INDEX product_name_compact_en ON product (name_compact_en);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE product_fts USING fts5(
    name, brand, name_en, content='product', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);`;
const COLUMNS = ['source', 'code', 'name', 'brand', 'quantity', 'serving_size', 'serving_quantity', 'unit', ...PER_100_KEYS, 'extra', 'popularity', 'name_key',
  'name_en', 'name_key_en', 'name_compact', 'name_compact_en'];
const INSERT = `INSERT OR REPLACE INTO product (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;

// CSV columns the import reads
const WANTED = ['code', 'product_name', 'brands', 'quantity', 'serving_size', 'serving_quantity', 'countries_tags', 'energy-kcal_100g', 'energy_100g',
  'fat_100g', 'saturated-fat_100g', 'carbohydrates_100g', 'sugars_100g', 'fiber_100g', 'proteins_100g', 'salt_100g', 'unique_scans_n'];
const MACROS: Record<string, string> = {
  fat: 'fat_100g', saturated_fat: 'saturated-fat_100g', carbs: 'carbohydrates_100g', sugars: 'sugars_100g', fiber: 'fiber_100g', protein: 'proteins_100g', salt: 'salt_100g',
};

/** The import cannot continue (unreadable source, missing columns, nothing usable). */
export class CatalogImportError extends Error {}

export interface Stats { read: number; kept: number; other_country: number; incomplete: number; nonsense: number; broken: number; truncated: boolean; seconds: number }

const number = (value: string | undefined): number | null => {
  const n = parseNumber((value ?? '').trim());
  return n === null ? null : roundHalfEven(n, 2);
};
const countryTags = (countries: string[]): Set<string> =>
  new Set(countries.filter((c) => c.trim()).map((c) => (c.includes(':') ? c.trim().toLowerCase() : `en:${c.trim().toLowerCase()}`)));
const squash = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ');

function convert(row: string[], at: Record<string, number>, tags: Set<string>, stats: Stats): unknown[] | null {
  if (!row[at.countries_tags!]!.toLowerCase().split(',').some((t) => tags.has(t))) { stats.other_country++; return null; }
  const name = Array.from(squash(row[at.product_name!]!)).slice(0, 200).join('');
  const code = row[at.code!]!.trim();
  let kcal = number(row[at['energy-kcal_100g']!]);
  if (kcal === null) { const kj = number(row[at.energy_100g!]); if (kj !== null) kcal = roundHalfEven(kj / 4.184, 1); }
  if (!name || !code || kcal === null) { stats.incomplete++; return null; }
  const macros: Record<string, number | null> = Object.fromEntries(Object.entries(MACROS).map(([k, c]) => [k, number(row[at[c]!])]));
  const values = Object.values(macros).filter((v): v is number => v !== null);
  const coreSum = CORE.filter((k) => k !== 'kcal').reduce((s, k) => s + (macros[k] ?? 0), 0);
  if (kcal < 0 || kcal > 950 || values.some((v) => v < 0 || v > 100) || coreSum > 105) { stats.nonsense++; return null; }
  const extra = extraFromOff((column) => (column in at && at[column]! < row.length ? parseNumber(row[at[column]!]) : null), macros.fat, macros.carbs);
  const quantity = row[at.quantity!]!.trim() || null;
  const servingSize = row[at.serving_size!]!.trim() || null;
  const serving = number(row[at.serving_quantity!]);
  const scans = number(row[at.unique_scans_n!]);
  const brand = row[at.brands!]!.split(',')[0]!.trim() || null;
  return [OFF, code, name, brand, quantity, servingSize, serving && serving > 0 && serving <= 5000 ? serving : null, guessUnit(null, quantity, servingSize), kcal,
    ...PER_100_KEYS.filter((k) => k !== 'kcal').map((k) => macros[k]), Object.keys(extra).length ? JSON.stringify(extra) : null,
    scans && scans > 0 ? Math.trunc(scans) : 0, nameKey(name), null, null, nameCompact(name), null];
}

async function* chunks(source: string): AsyncGenerator<Uint8Array> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { redirect: 'follow', headers: { 'User-Agent': `Mahlwerk/${VERSION} (catalogue import)` }, signal: AbortSignal.timeout(6 * 3600_000) });
    if (res.status !== 200 || !res.body) throw new CatalogImportError(`${source}: HTTP ${res.status}`);
    yield* Readable.fromWeb(res.body as any) as AsyncIterable<Uint8Array>;
  } else {
    yield* createReadStream(source, { highWaterMark: 1 << 20 });
  }
}

/** The decompressed text lines of a gzip stream (without the line end); `state.truncated` tells whether the stream ended early. */
async function* lines(source: string, state: { truncated: boolean }): AsyncGenerator<string> {
  const gunzip = createGunzip();
  const decoder = new TextDecoder('utf-8'); // invalid bytes become U+FFFD
  let pending = '';
  const feed = (async () => {
    try {
      for await (const c of chunks(source)) if (!gunzip.write(c)) await new Promise((r) => gunzip.once('drain', r));
      gunzip.end();
    } catch (e) { gunzip.destroy(e as Error); }
  })();
  try {
    for await (const block of gunzip) {
      pending += decoder.decode(block as Uint8Array, { stream: true });
      if (pending.includes('\n')) {
        const parts = pending.split('\n');
        pending = parts.pop()!;
        yield* parts;
      }
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'Z_BUF_ERROR') state.truncated = true; // the file ends before the gzip trailer: what was complete is read
    else if (err instanceof CatalogImportError) throw err;
    else if (String(err.code ?? '').startsWith('Z_')) throw new CatalogImportError(`not a readable gzip stream: ${err.message}`);
    else throw err;
  }
  await feed.catch(() => {});
  if (pending && !state.truncated) yield pending; // an unterminated last line of a complete file; one of a cut file is probably incomplete
}

export async function importOff(dest: string, countriesIn: string[], source = OFF_URL, progress: (text: string) => void = () => {}): Promise<Stats> {
  const tags = countryTags(countriesIn);
  if (!tags.size) throw new CatalogImportError('no country given');
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = dest + '.new';
  if (existsSync(tmp) || lstatSync(tmp, { throwIfNoEntry: false })) unlinkSync(tmp);
  const started = Date.now();
  const stats: Stats = { read: 0, kept: 0, other_country: 0, incomplete: 0, nonsense: 0, broken: 0, truncated: false, seconds: 0 };
  const con = new DatabaseSync(tmp);
  try {
    con.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF');
    con.exec(SCHEMA);
    const insert = con.prepare(INSERT);
    const state = { truncated: false };
    let at: Record<string, number> | null = null;
    let width = 0;
    let batch: unknown[][] = [];
    const flush = () => { con.exec('BEGIN'); for (const v of batch) insert.run(...(v as any[])); con.exec('COMMIT'); batch = []; };
    for await (const raw of lines(source, state)) {
      const row = raw.replace(/\r$/, '').split('\t');
      if (at === null) {
        at = Object.fromEntries(row.map((n, i) => [n, i]));
        const missing = WANTED.filter((c) => !(c in at!));
        if (missing.length) throw new CatalogImportError(`columns missing in the source: ${missing.join(', ')}`);
        width = Math.max(...WANTED.map((c) => at![c]!)) + 1;
        continue;
      }
      stats.read++;
      if (stats.read % PROGRESS_EVERY === 0) { progress(`${stats.read.toLocaleString('en')} rows read, ${stats.kept.toLocaleString('en')} kept, ${Math.round((Date.now() - started) / 1000)} s`); await new Promise((r) => setImmediate(r)); }
      if (row.length < width) { stats.broken++; continue; }
      const values = convert(row, at, tags, stats);
      if (values === null) continue;
      batch.push(values);
      stats.kept++;
      if (batch.length >= BATCH) flush();
    }
    if (at === null) throw new CatalogImportError('the source is empty');
    if (batch.length) flush();
    stats.truncated = state.truncated;
    if (stats.kept === 0) throw new CatalogImportError('no product matched the filter; the existing catalogue was left alone');
    con.exec("INSERT INTO product_fts (product_fts) VALUES ('rebuild')");
    const count = (con.prepare('SELECT count(*) AS n FROM product').get() as { n: number }).n;
    stats.kept = count; // duplicates of one code collapse into one row
    const meta = { products: String(count), updated_at: String(Math.floor(Date.now() / 1000)), countries: [...tags].sort().join(',') };
    const put = con.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) put.run(k, v);
    con.close();
    renameSync(tmp, dest);
  } catch (e) {
    try { con.close(); } catch { /* closed already */ }
    if (lstatSync(tmp, { throwIfNoEntry: false })) unlinkSync(tmp);
    throw e;
  }
  stats.seconds = (Date.now() - started) / 1000;
  return stats;
}

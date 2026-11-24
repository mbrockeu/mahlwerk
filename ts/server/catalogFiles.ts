// The catalogue files opened by Node: read-only, a short-lived connection per call (an import swaps the file by rename, so
// a connection must not outlive a query), like Catalog._open of catalog.py.
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BLS, Catalog, type CatalogFiles } from '../core/catalog.ts';

/** `MAHLWERK_CATALOG_DB`, else `catalog.db` next to the main database. */
export const catalogPath = (env: Record<string, string | undefined>, mainDb: string): string =>
  env.MAHLWERK_CATALOG_DB || join(dirname(mainDb), 'catalog.db');

/** `MAHLWERK_CATALOG_BLS_DB`, else the file of the Open Food Facts catalogue with `-bls` before the suffix. */
export const blsPath = (env: Record<string, string | undefined>, offPath: string): string => {
  if (env.MAHLWERK_CATALOG_BLS_DB) return env.MAHLWERK_CATALOG_BLS_DB;
  const ext = extname(offPath);
  return join(dirname(offPath), `${basename(offPath, ext)}-bls${ext}`);
};

export function nodeCatalog(env: Record<string, string | undefined>, mainDb: string): Catalog {
  const off = catalogPath(env, mainDb);
  const bls = blsPath(env, off);
  const files: CatalogFiles = {
    async all(source, sql, params) {
      const path = source === BLS ? bls : off;
      if (!existsSync(path)) return null;
      let con: DatabaseSync | undefined;
      try {
        con = new DatabaseSync(path, { readOnly: true });
        con.exec('PRAGMA busy_timeout = 5000');
        return con.prepare(sql).all(...((params === undefined ? [] : Array.isArray(params) ? params : [params]) as any[])) as any[];
      } catch {
        return null;
      } finally {
        con?.close();
      }
    },
  };
  return new Catalog(files, off);
}

// The catalogue files over the bridge (read-only `bls` and `catalog` databases of the app), like server/catalogFiles.ts: a file
// that is missing (`missing`) or a query it cannot answer gives null, i.e. "nothing found".
import { BLS, Catalog, type CatalogFiles } from '../core/catalog.ts';
import type { Bridge } from './bridge.ts';
import { sql } from './nativeDb.ts';

export function bridgeCatalog(bridge: Bridge): Catalog {
  const files: CatalogFiles = {
    async all(source, text, params) {
      try {
        return (await sql(bridge, source === BLS ? 'bls' : 'catalog', text, params)).rows;
      } catch {
        return null;
      }
    },
  };
  return new Catalog(files);
}

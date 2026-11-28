// The local catalogue: search by name and adopt an item as a food (routes/catalog.py).
import { z } from 'zod';
import { BLS, catalogOf, MAX_QUERY_CHARS, externalId, foodData } from '../catalog.ts';
import { buildFood } from '../foodView.ts';
import { HttpError, parse, queryObject, respond, route, type Route } from '../http.ts';
import { catalogRef, type CatalogItem } from '../models/catalog.ts';
import { pyInt } from '../models/common.ts';
import { getFoodByCode, getFoodByExternalId, knownCatalog, putExternalFood, putFood } from '../store/foods.ts';

const MIN_QUERY = 2;
const SOURCES = z.enum(['openfoodfacts', 'bls']);

export const routes: Route[] = [
  // Foods by name (basic foods also by English name) or product brand. Without `source`, up to 8 basic foods come first, then
  // packaged products. Items already stored as a food are left out.
  route('GET', '/api/v1/catalog', async (req): Promise<CatalogItem[]> => {
    const q = parse(z.object({ q: z.string().default(''), source: SOURCES.optional(), limit: pyInt().pipe(z.number().min(1).max(50)).default(25) }),
      queryObject(req.query), 'query');
    const text = [...q.q.trim()].slice(0, MAX_QUERY_CHARS).join(''); // a longer text is cut, not refused
    if ([...text].length < MIN_QUERY) return [];
    return catalogOf(req.ctx).search(text, q.limit, q.source ?? null, (hits) => knownCatalog(req.ctx.db, hits));
  }),

  // Store a catalogue item as a regular food (201), or return the food that already exists (200).
  route('POST', '/api/v1/catalog/adopt', async (req) => {
    const ref = parse(catalogRef, req.body);
    const { db } = req.ctx;
    const user = req.user!;
    if (ref.source === BLS) {
      const existing = await getFoodByExternalId(db, externalId(BLS, ref.code)!);
      if (existing?.found) return respond({ status: 200, body: buildFood(req.ctx, existing as any, user) });
    }
    const item = await catalogOf(req.ctx).get(ref.source, ref.code);
    if (!item) throw new HttpError(404, 'unknown catalogue item');
    const data = foodData(item);
    if (item.source === BLS) {
      const [id, fetchedAt] = await putExternalFood(db, externalId(BLS, item.code)!, BLS, data);
      return respond({ status: 201, body: buildFood(req.ctx, { id, code: null, source: BLS, data, fetched_at: fetchedAt }, user) });
    }
    const existing = await getFoodByCode(db, item.code);
    if (existing?.found) return respond({ status: 200, body: buildFood(req.ctx, existing as any, user) });
    const [id, fetchedAt] = await putFood(db, item.code, item.source, data);
    return respond({ status: 201, body: buildFood(req.ctx, { id, code: item.code, source: item.source, data, fetched_at: fetchedAt }, user) });
  }),
];

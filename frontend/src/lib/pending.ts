import type { CatalogItem, Food } from './types.ts';

/** A catalogue product as a not yet stored food: it shows and calculates like a Food (id 0), `pending` names what has to be adopted
 *  when something is really saved. Looking at a product creates nothing. */
export function provisionalFood(item: CatalogItem): Food {
  return {
    id: 0,
    code: item.code,
    source: item.source,
    recipe_id: null,
    external_id: `${item.source}:${item.code}`,
    name: item.name,
    name_en: item.name_en ?? null,
    brand: item.brand,
    quantity: item.quantity,
    serving_size: item.serving_size,
    serving_quantity: item.serving_quantity,
    unit: item.unit,
    per_100: item.per_100,
    extra: item.extra,
    complete: item.complete,
    empty: false,
    cached: true,
    stale: false,
    fetched_at: 0,
    pending: { source: item.source, code: item.code },
  } as Food;
}

export const isPending = (food: Pick<Food, 'pending'> | null | undefined) => !!food?.pending;

/** One adoption per provisional food, however often it is asked for (double tap, save and piece at once). The food is updated in
 *  place with the stored one, so that everything holding it sees the real id. */
const running = new WeakMap<Food, Promise<Food>>();
export function resolveFood(food: Food, adopt: (ref: { source: 'openfoodfacts' | 'bls'; code: string }) => Promise<Food>): Promise<Food> {
  if (!food.pending) return Promise.resolve(food);
  let job = running.get(food);
  if (!job) {
    const ref = food.pending;
    job = adopt(ref).then((stored) => {
      Object.assign(food, stored);
      delete food.pending;
      return food;
    }, (err) => { running.delete(food); throw err; });
    running.set(food, job);
  }
  return job;
}

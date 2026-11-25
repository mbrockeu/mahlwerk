// The API shape of a food (routes/foods.py: build_food, own_data, food_image) – used wherever a food is shown.
import type { Ctx, User } from './http.ts';
import type { Food, FoodImage, FoodIn } from './models/food.ts';
import { clean } from './nutrients.ts';
import { guessUnit, isComplete, parseServing, type Per100Key } from './nutrition.ts';
import { PER_100_KEYS } from './nutrition.ts';
import { canEdit } from './ownership.ts';
import type { FoodData, FoodRow } from './store/foods.ts';

/** Links that belong to the recipe sources (Cookidoo, web recipes). Those packages put their implementation into
 * `ctx.services.foodLinks`; without it a recipe food has no `url` and a web picture no credit. */
export interface FoodLinks {
  cookidooUrl(externalId: string | null, region: unknown): string | null;
  webLink(url: unknown): string | null;
  hostLabel(address: string): string;
}

const HASH = /^[0-9a-f]{32}$/;

function foodImage(ctx: Ctx, row: FoodRow): FoodImage | null {
  const { image_hash: hash, image_origin: origin } = row;
  if (!hash || (origin !== 'own' && origin !== 'cookidoo' && origin !== 'web') || !HASH.test(hash)) return null;
  const links = ctx.services.foodLinks as FoodLinks | undefined;
  let credit: string | null = null;
  if (origin === 'cookidoo') credit = 'Cookidoo';
  else if (origin === 'web') credit = (links && links.hostLabel(links.webLink(row.data?.url) ?? '')) || null;
  return { hash, origin, credit };
}

/** The API shape of a food row. `user` (the caller) decides `can_edit`; without it nothing is withheld.
 * `extra` overrides fields like `cached` or `stale`. */
export function buildFood(ctx: Ctx, row: Partial<FoodRow> & Pick<FoodRow, 'id' | 'code' | 'source' | 'fetched_at'> & { data: FoodData; created_by?: number | null },
  user: User | null = null, extra: { cached?: boolean; stale?: boolean } = {}): Food {
  const data = row.data;
  const own = row.source === 'own';
  const unit = data.unit || guessUnit(null, data.quantity, data.serving_size);
  let serving = data.serving_quantity ?? null;
  if (serving === null && own) {
    const parsed = parseServing(data.serving_size);
    if (parsed && parsed[1] === unit) serving = parsed[0];
  }
  const links = ctx.services.foodLinks as FoodLinks | undefined;
  const url = row.source === 'cookidoo' ? links?.cookidooUrl(row.external_id ?? null, data.region) ?? null
    : row.source === 'web' ? links?.webLink(data.url) ?? null : null;
  const per100 = data.per_100;
  const owner = row.owner !== undefined ? row.owner : row.created_by;
  return {
    id: row.id,
    code: row.code,
    source: row.source as Food['source'],
    recipe_id: row.recipe_id ?? null,
    external_id: row.external_id ?? null,
    portions: data.portions ?? null,
    url,
    name: data.name ?? null,
    brand: data.brand ?? null,
    quantity: data.quantity ?? null,
    serving_size: data.serving_size ?? null,
    serving_quantity: serving,
    unit,
    per_100: Object.fromEntries(PER_100_KEYS.map((k: Per100Key) => [k, per100[k] ?? null])) as Food['per_100'],
    extra: clean(data.extra),
    complete: isComplete(per100),
    empty: data.name == null && Object.values(per100).every((v) => v == null),
    cached: extra.cached ?? true,
    stale: extra.stale ?? false,
    fetched_at: row.fetched_at,
    image: foodImage(ctx, row as FoodRow),
    can_edit: user === null ? true : canEdit(user, owner),
    image_removed: row.image_origin === 'none',
    piece: row.piece_label && row.piece_grams ? { label: row.piece_label, grams: row.piece_grams } : null,
    drink: row.drink ?? null,
  };
}

/** The data an own product is stored with. */
export function ownData(food: FoodIn): FoodData {
  const parsed = parseServing(food.serving_size);
  const unit = food.unit ?? (parsed ? parsed[1] : 'g');
  const serving = food.serving_quantity ?? (parsed && parsed[1] === unit ? parsed[0] : null);
  return {
    name: food.name.trim(),
    brand: food.brand,
    quantity: food.quantity,
    serving_size: food.serving_size,
    serving_quantity: serving,
    unit,
    per_100: food.per_100,
    extra: food.extra,
    complete: isComplete(food.per_100),
  };
}

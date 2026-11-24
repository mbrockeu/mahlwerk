// Open Food Facts client (off.py): fetch one product by barcode and normalise it.
import type { Ctx } from './http.ts';
import { extraFromOff, parseNumber } from './nutrients.ts';
import { roundHalfEven } from './num.ts';
import { CORE, guessUnit, PER_100_KEYS, type Per100Key } from './nutrition.ts';
import { OutError, outgoing } from './outgoing.ts';
import type { FoodData } from './store/foods.ts';
import { VERSION } from './version.ts';

const FIELDS = 'code,product_name,product_name_de,generic_name,brands,quantity,serving_size,serving_quantity,nutrition_data_per,nutriments';

// our name -> OFF nutriment key (all per 100 g / 100 ml)
const NUTRIENTS: Record<Exclude<Per100Key, 'kcal'> | 'kcal', string> = {
  kcal: 'energy-kcal_100g', fat: 'fat_100g', saturated_fat: 'saturated-fat_100g', carbs: 'carbohydrates_100g',
  sugars: 'sugars_100g', fiber: 'fiber_100g', protein: 'proteins_100g', salt: 'salt_100g',
};

/** Open Food Facts could not be reached or answered with an error. */
export class UpstreamError extends Error {}

const number = (value: unknown): number | null => {
  const n = parseNumber(value);
  return n === null ? null : roundHalfEven(n, 2);
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function normalise(product: Record<string, any>): FoodData {
  const nutriments = (product.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {}) as Record<string, unknown>;
  const per100 = Object.fromEntries(PER_100_KEYS.map((name) => [name, number(nutriments[NUTRIENTS[name]])])) as Record<Per100Key, number | null>;
  if (per100.kcal === null) {
    const kj = number(nutriments['energy-kj_100g']);
    if (kj !== null) per100.kcal = roundHalfEven(kj / 4.184, 1);
  }
  const extra = extraFromOff((column) => parseNumber(nutriments[column]), per100.fat, per100.carbs);
  const name = text(product.product_name_de) || text(product.product_name) || text(product.generic_name);
  return {
    name: name.trim() || null,
    brand: text(product.brands).split(',')[0]!.trim() || null,
    quantity: product.quantity || null,
    serving_size: product.serving_size || null,
    serving_quantity: number(product.serving_quantity),
    unit: guessUnit(str(product.nutrition_data_per), str(product.quantity), str(product.serving_size)),
    per_100: per100,
    extra,
    complete: CORE.every((k) => per100[k] !== null),
  };
}

/** The normalised product, or null when OFF does not know the barcode. */
export async function fetchProduct(ctx: Ctx, base: string, code: string): Promise<FoodData | null> {
  const contact = ctx.env.MAHLWERK_CONTACT ?? 'no-contact-configured';
  const url = `${base}/api/v2/product/${code}?${new URLSearchParams({ fields: FIELDS })}`;
  let res;
  try {
    res = await outgoing(ctx).fetch('off', { url, headers: { 'user-agent': `Mahlwerk/${VERSION} (${contact})`, accept: '*/*' }, timeout: 8 });
  } catch (e) {
    if (e instanceof OutError) throw new UpstreamError(e.message);
    throw e;
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new UpstreamError(`HTTP ${res.status}`);
  let body: any;
  try { body = JSON.parse(new TextDecoder().decode(res.body)); } catch { throw new UpstreamError('invalid JSON'); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new UpstreamError('invalid JSON');
  if (body.status !== 1 || !body.product) return null;
  return normalise(body.product);
}

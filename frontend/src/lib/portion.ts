import { fmt, t } from './i18n';
import type { Entry, Food } from './types';

/** A taken-over Cookidoo or web recipe is stored as a food of 100 g whose "per 100 g" values are those of one portion. The user never
 *  sees that: amounts of such foods are shown and typed as portions. */
export const PORTION_GRAMS = 100;
/** The brand the server gives every taken-over Cookidoo recipe. A diary entry keeps only a copy of name and brand (and survives
 *  the removal of its food), so the brand is how an entry is recognised. */
const COOKIDOO_BRAND = 'Cookidoo';
/** A recipe taken over from a web page has the brand `Web · <host>` (the same reason: an entry keeps only name and brand). */
const WEB_BRAND_PREFIX = 'Web \u00b7 ';

export const isPortionFood = (food: Pick<Food, 'source'> | null | undefined) => food?.source === 'cookidoo' || food?.source === 'web';
export const isPortionEntry = (entry: Pick<Entry, 'brand' | 'unit'> | null | undefined) =>
  (entry?.brand === COOKIDOO_BRAND || (entry?.brand?.startsWith(WEB_BRAND_PREFIX) ?? false)) && entry?.unit === 'g';
/** The host of a taken-over web recipe (from its brand), else null. */
export const webHost = (food: Pick<Food, 'source' | 'brand'>) => (food.source === 'web' && food.brand?.startsWith(WEB_BRAND_PREFIX) ? food.brand.slice(WEB_BRAND_PREFIX.length) : null);
/** The small label of a recipe taken over from elsewhere: "Cookidoo" or the web host; null for an own recipe. */
export const sourceLabel = (food: Pick<Food, 'source' | 'brand'>) => (food.source === 'cookidoo' ? 'Cookidoo' : webHost(food));
/** "1 portion", "1.5 portions" */
export const portionsText = (n: number) => (n === 1 ? t('portions1') : t('portionsN', { n: fmt(n, 2) }));
/** The amount of a diary entry as text: portions for a Cookidoo entry, else grams or millilitres. */
export const entryAmount = (e: Pick<Entry, 'brand' | 'unit' | 'amount'>) => (isPortionEntry(e) ? portionsText(e.amount / PORTION_GRAMS) : `${fmt(e.amount, 1)} ${e.unit}`);
/** A summed or typical amount of a food (statistics): portions for a Cookidoo food, else the rounded number with its unit. */
export const amountLabel = (item: Pick<Entry, 'brand' | 'unit'>, amount: number, digits = 0) =>
  isPortionEntry(item) ? portionsText(Math.round((amount / PORTION_GRAMS) * 100) / 100) : `${fmt(digits ? amount : Math.round(amount), digits)} ${item.unit}`;
/** Portions as people say them: ½, 1, 1½, 2 (others as a number): "1½ portions". */
export const portionsLabel = (n: number) => {
  const whole = Math.floor(n);
  const half = Math.abs(n - whole - 0.5) < 1e-9;
  if (!half) return portionsText(n);
  if (whole === 0) return t('halfPortion');
  return t('portionsN', { n: `${whole}½` });
};

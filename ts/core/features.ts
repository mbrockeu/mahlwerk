// Switches an admin can change at runtime (features.py): table `setting`, each with an optional environment override that wins.
import type { Ctx } from './http.ts';

const TRUE = ['1', 'true', 'yes', 'on'];
const FALSE = ['0', 'false', 'no', 'off'];
export const DEFAULT_COUNTRIES = ['en:germany'];

/** setting key -> [environment variable, kind] */
export const FEATURE_ENV: Record<string, [string, 'bool' | 'list']> = {
  'access_tokens.enabled': ['MAHLWERK_TOKENS', 'bool'],
  'webhooks.enabled': ['MAHLWERK_WEBHOOKS', 'bool'],
  'webhooks.hosts': ['MAHLWERK_WEBHOOK_HOSTS', 'list'],
  'openfoodfacts_lookup.enabled': ['MAHLWERK_OFF_LOOKUP', 'bool'],
  'openfoodfacts_catalog.countries': ['MAHLWERK_OFF_COUNTRIES', 'list'],
  'cookidoo.enabled': ['MAHLWERK_COOKIDOO', 'bool'],
  'web_recipes.enabled': ['MAHLWERK_WEB_RECIPES', 'bool'],
  'cookidoo.personal': ['MAHLWERK_COOKIDOO_PERSONAL', 'bool'],
  'cookidoo.images': ['MAHLWERK_COOKIDOO_IMAGES', 'bool'],
  'web_recipes.images': ['MAHLWERK_WEB_RECIPES_IMAGES', 'bool'],
  'yazio_login.enabled': ['MAHLWERK_YAZIO_LOGIN', 'bool'],
  'demo_account.enabled': ['MAHLWERK_DEMO_ACCOUNT', 'bool'],
  'vision.enabled': ['MAHLWERK_VISION', 'bool'],
};
export const FEATURE_DEFAULTS: Record<string, unknown> = {
  'access_tokens.enabled': true, 'webhooks.enabled': true, 'webhooks.hosts': [], 'openfoodfacts_lookup.enabled': true,
  'openfoodfacts_catalog.countries': DEFAULT_COUNTRIES, 'cookidoo.enabled': false, 'web_recipes.enabled': false,
  'cookidoo.images': false, 'web_recipes.images': false, 'cookidoo.personal': true, 'yazio_login.enabled': false,
  'demo_account.enabled': false, 'vision.enabled': false,
};

/** The value the environment fixes for `key`, or undefined when it leaves the setting to the admin. */
export function fixedByEnv(ctx: Ctx, key: string): boolean | string[] | undefined {
  const [name, kind] = FEATURE_ENV[key]!;
  const raw = (ctx.env[name] ?? '').trim();
  if (!raw) return undefined;
  if (kind === 'bool') {
    const lowered = raw.toLowerCase();
    return TRUE.includes(lowered) ? true : FALSE.includes(lowered) ? false : undefined;
  }
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

/** Store.get_global */
export async function getGlobal(ctx: Ctx, key: string, dflt: unknown = null): Promise<any> {
  const row = await ctx.db.get<{ value: string }>('SELECT value FROM setting WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : dflt;
}

export async function feature(ctx: Ctx, key: string): Promise<any> {
  const fixed = fixedByEnv(ctx, key);
  return fixed !== undefined ? fixed : getGlobal(ctx, key, FEATURE_DEFAULTS[key]);
}

export const featureOn = async (ctx: Ctx, key: string): Promise<boolean> => Boolean(await feature(ctx, key));

export async function webhookHosts(ctx: Ctx): Promise<string[]> {
  return ((await feature(ctx, 'webhooks.hosts')) as string[]).map((h) => h.toLowerCase());
}
export async function countries(ctx: Ctx): Promise<string[]> {
  return ((await feature(ctx, 'openfoodfacts_catalog.countries')) as string[])?.length ? await feature(ctx, 'openfoodfacts_catalog.countries') : DEFAULT_COUNTRIES;
}
/** An empty list allows every host. */
export async function hostAllowed(ctx: Ctx, host: string | null | undefined): Promise<boolean> {
  const hosts = await webhookHosts(ctx);
  return hosts.length === 0 || hosts.includes((host ?? '').toLowerCase());
}
/** The admin named this host: it may then be an internal one (a conscious decision). */
export async function hostListed(ctx: Ctx, host: string | null | undefined): Promise<boolean> {
  return Boolean(host) && (await webhookHosts(ctx)).includes(host!.toLowerCase());
}

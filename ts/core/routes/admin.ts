// The admin area: overview, user list (counts only), connectors and the catalogue refresh (routes/admin.py). Only for admins signed in
// the normal way; an access token never gets in.
//
// Connectors of other packages (Cookidoo, Yazio, photo recognition, the label reader, the catalogue refresh) show up as cards. What
// their cards say comes from `ctx.services.cards` (name -> function giving `{status, info, config?}`), the refresh job from
// `ctx.services.refresh` and what must stop when a switch goes off from `ctx.services.connectorOff`; without them the cards are what
// a server without that connector shows.
import { z } from 'zod';
import { configOf, requireAdmin } from '../auth.ts';
import * as demoAccount from '../demoAccount.ts';
import { today } from '../dates.ts';
import { FEATURE_ENV, countries, featureOn, fixedByEnv, webhookHosts } from '../features.ts';
import { HttpError, parse, route, type Ctx, type Req, type Route } from '../http.ts';
import { pyBool } from '../models/common.ts';
import { urlsplit } from '../urlsplit.ts';
import { VERSION } from '../version.ts';
import { adminCounts, adminUsers, demoAccountReady, demoAccountSummary, demoNameTaken } from '../store/demo.ts';
import { setGlobal } from '../store/globals.ts';
import { countActiveTokens } from '../store/tokens.ts';

const COUNTRY = /^[a-z]{2}:[a-z0-9-]{2,40}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_LIST = 50;

interface Card { status?: string; info?: Record<string, unknown>; config?: Record<string, unknown>; enabled?: boolean }
type Cards = Partial<Record<'cookidoo' | 'vision' | 'yazio_login' | 'label_reader', () => Promise<Card> | Card>>;
interface Refresh { status(): unknown; start(): boolean | Promise<boolean> }

const IDLE = { state: 'idle', started_at: null, finished_at: null, progress: null, countries: [], result: null, error: null };
const cards = (ctx: Ctx): Cards => (ctx.services.cards as Cards | undefined) ?? {};
const refreshOf = (ctx: Ctx): Refresh | undefined => ctx.services.refresh as Refresh | undefined;

const connectorPatch = z.object({ enabled: pyBool().nullable().default(null), config: z.record(z.string(), z.unknown()).nullable().default(null) });

/** Which of these settings the environment fixes, as the admin area names them: `enabled` or `config.<name>`. */
const locked = (ctx: Ctx, ...keys: string[]): string[] =>
  keys.filter((k) => fixedByEnv(ctx, k) !== undefined).map((k) => (k.endsWith('.enabled') ? 'enabled' : 'config.' + k.slice(k.lastIndexOf('.') + 1)));

/** The card of the built-in demo account: switch, what it holds and whether a real user of the reserved name stands in the way. */
async function demoAccountConnector(ctx: Ctx) {
  const userId = await demoAccountReady(ctx.db);
  const taken = userId === null && (await demoNameTaken(ctx.db));
  const enabled = await featureOn(ctx, 'demo_account.enabled');
  const info = { exists: userId !== null, name_taken: taken, env: 'MAHLWERK_DEMO_ACCOUNT', ...(userId !== null ? await demoAccountSummary(ctx.db, userId) : {}) };
  const status = taken ? 'conflict' : enabled ? (userId !== null ? 'ok' : 'empty') : 'off';
  return { key: 'demo_account', kind: 'import', enabled, status, configurable: true, locked: locked(ctx, 'demo_account.enabled'), config: {}, info };
}

export async function connectorList(ctx: Ctx) {
  const extra = cards(ctx);
  const catalog = (ctx.services.catalog as { info(): Promise<any> } | undefined);
  const info = catalog ? await catalog.info() : { products: 0, updated_at: null, bls: { products: 0, updated_at: null } };
  const refresh = (refreshOf(ctx)?.status() ?? IDLE) as { state: string };
  const counts = await adminCounts(ctx.db);
  const card = async (name: keyof Cards): Promise<Card> => (await extra[name]?.()) ?? {};
  const cookidoo = await card('cookidoo');
  const yazio = await card('yazio_login');
  const vision = await card('vision');
  const label = await card('label_reader');
  const [tokens, webhooks, lookup, webRecipes, cookidooOn, yazioOn, visionOn] = await Promise.all(
    ['access_tokens.enabled', 'webhooks.enabled', 'openfoodfacts_lookup.enabled', 'web_recipes.enabled', 'cookidoo.enabled', 'yazio_login.enabled', 'vision.enabled'].map((k) => featureOn(ctx, k)));
  const labelOn = label.enabled ?? false;
  return [
    { key: 'openfoodfacts_lookup', kind: 'source', enabled: lookup, status: lookup ? 'ok' : 'off', configurable: true,
      locked: locked(ctx, 'openfoodfacts_lookup.enabled'), config: {}, info: { base_url: (ctx.env.MAHLWERK_OFF_BASE ?? 'https://world.openfoodfacts.org').replace(/\/+$/, '') } },
    { key: 'openfoodfacts_catalog', kind: 'source', enabled: info.products > 0,
      status: refresh.state === 'running' ? 'running' : info.products ? 'ok' : 'empty', configurable: true,
      locked: locked(ctx, 'openfoodfacts_catalog.countries'), config: { countries: await countries(ctx) }, info: { products: info.products, updated_at: info.updated_at } },
    { key: 'bls', kind: 'source', enabled: info.bls.products > 0, status: info.bls.products ? 'ok' : 'empty', configurable: false, locked: [], config: {},
      info: { products: info.bls.products, updated_at: info.bls.updated_at, cli: true } },
    { key: 'cookidoo', kind: 'source', enabled: cookidooOn,
      status: cookidoo.status ?? ((ctx.env.MAHLWERK_COOKIDOO_EMAIL ?? '').trim() && (ctx.env.MAHLWERK_COOKIDOO_PASSWORD ?? '').trim() ? (cookidooOn ? 'ready' : 'off') : 'not_configured'), configurable: true,
      locked: locked(ctx, 'cookidoo.enabled', 'cookidoo.personal', 'cookidoo.images'),
      config: { personal: await featureOn(ctx, 'cookidoo.personal'), images: await featureOn(ctx, 'cookidoo.images') },
      info: { error: null, shared_account: true, account: { source: 'none', key: 'none', email: null, country: null, language: null, editable: true, allowed: true, error: null }, env: 'MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD', ...(cookidoo.info ?? {}) } },
    { key: 'web_recipes', kind: 'source', enabled: webRecipes, status: webRecipes ? 'ok' : 'off', configurable: true,
      locked: locked(ctx, 'web_recipes.enabled', 'web_recipes.images'), config: { images: await featureOn(ctx, 'web_recipes.images') }, info: {} },
    { key: 'yazio_import', kind: 'import', enabled: true, status: 'upload', configurable: false, locked: [], config: {},
      info: { batches: counts.import_batches, cli: true, upload: true } },
    { key: 'yazio_login', kind: 'import', enabled: yazioOn,
      status: yazio.status ?? ((ctx.env.MAHLWERK_YAZIO_CLIENT_ID ?? '').trim() && (ctx.env.MAHLWERK_YAZIO_CLIENT_SECRET ?? '').trim() ? (yazioOn ? 'ready' : 'off') : 'not_configured'), configurable: true,
      locked: locked(ctx, 'yazio_login.enabled'), config: {}, info: { unofficial: true, env: 'MAHLWERK_YAZIO_CLIENT_ID, MAHLWERK_YAZIO_CLIENT_SECRET' } },
    { key: 'vision', kind: 'source', enabled: visionOn, status: vision.status ?? (visionModel(ctx.env) === null ? 'not_configured' : visionOn ? 'ready' : 'off'),
      configurable: true, locked: locked(ctx, 'vision.enabled'), config: {},
      info: { model: visionModel(ctx.env), fallback_model: visionModel(ctx.env, 'MAHLWERK_VISION_FALLBACK'), per_hour: visionPerHour(ctx.env),
        env: 'MAHLWERK_VISION_URL, MAHLWERK_VISION_MODEL, MAHLWERK_VISION_KEY (and _FALLBACK_URL, _FALLBACK_MODEL, _FALLBACK_KEY)', ...(vision.info ?? {}) } },
    { key: 'label_reader', kind: 'import', enabled: labelOn, status: label.status ?? (labelOn ? 'ok' : 'unavailable'), configurable: false, locked: [], config: {}, info: {} },
    { key: 'demo_data', kind: 'import', enabled: demoDataOn(ctx), status: demoDataOn(ctx) ? 'ok' : 'off', configurable: false, locked: [], config: {}, info: { env: 'MAHLWERK_DEMO_DATA' } },
    await demoAccountConnector(ctx),
    { key: 'access_tokens', kind: 'interface', enabled: tokens, status: tokens ? 'ok' : 'off', configurable: true, locked: locked(ctx, 'access_tokens.enabled'), config: {},
      info: { active: await countActiveTokens(ctx.db) } },
    { key: 'webhooks', kind: 'interface', enabled: webhooks, status: webhooks ? 'ok' : 'off', configurable: true, locked: locked(ctx, 'webhooks.enabled', 'webhooks.hosts'),
      config: { hosts: await webhookHosts(ctx) }, info: { hooks: counts.webhooks } },
  ];
}

/** MAHLWERK_DEMO_DATA, read once when the app was made (like app.state.demo_enabled). */
export const demoDataOn = (ctx: Ctx): boolean => (ctx.services.demoDataOn as boolean | undefined) ?? false;

function names(raw: unknown, pattern: RegExp, what: string, fix: (v: string) => string): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_LIST || !raw.every((v) => typeof v === 'string')) throw new HttpError(422, `${what} must be a list of at most ${MAX_LIST} texts`);
  const values = [...new Set((raw as string[]).filter((v) => v.trim()).map((v) => fix(v.trim().toLowerCase())))];
  if (!values.every((v) => pattern.test(v))) throw new HttpError(422, `${what}: invalid entry`);
  return values;
}

/** vision.settings_from_env: the model named by the environment (the address and the key never appear on the card), or null. */
function visionModel(env: Record<string, string | undefined>, prefix = 'MAHLWERK_VISION'): string | null {
  const base = (env[`${prefix}_URL`] ?? '').trim().replace(/\/+$/, '');
  const model = (env[`${prefix}_MODEL`] ?? '').trim();
  if (!base || !model || [...model].length > 200) return null;
  try {
    const p = urlsplit(base);
    return ['http', 'https'].includes(p.scheme) && p.hostname && !p.username && !p.password && !p.fragment && !p.query && !base.includes('?') && !base.includes('#') ? model : null;
  } catch { return null; }
}

function visionPerHour(env: Record<string, string | undefined>): number {
  const raw = (env.MAHLWERK_VISION_PER_HOUR ?? '').trim();
  if (!raw) return 30;
  if (!/^[+-]?\d+$/.test(raw)) return 30;
  return Math.max(1, Math.min(10000, Number(raw)));
}

const country = (value: string) => (value.includes(':') ? value : `en:${value}`);

const SWITCH: Record<string, string> = {
  openfoodfacts_lookup: 'openfoodfacts_lookup.enabled', access_tokens: 'access_tokens.enabled', webhooks: 'webhooks.enabled', cookidoo: 'cookidoo.enabled',
  web_recipes: 'web_recipes.enabled', yazio_login: 'yazio_login.enabled', demo_account: 'demo_account.enabled', vision: 'vision.enabled',
};
const LISTING: Record<string, [string, string, RegExp, (v: string) => string]> = {
  openfoodfacts_catalog: ['openfoodfacts_catalog.countries', 'countries', COUNTRY, country],
  webhooks: ['webhooks.hosts', 'hosts', HOST, (v) => v],
};

const asAdmin = async (req: Req) => { await requireAdmin(req); };

export const routes: Route[] = [
  route('GET', '/api/v1/admin/overview', async (req) => {
    await asAdmin(req);
    const { ctx } = req;
    const counts = await adminCounts(ctx.db);
    const catalog = ctx.services.catalog as { info(): Promise<unknown> } | undefined;
    return {
      version: VERSION, auth_mode: configOf(ctx).mode, db_size_bytes: (ctx.services.dbSize as (() => number) | undefined)?.() ?? 0,
      schema_version: (await ctx.db.get('PRAGMA user_version'))!.user_version, users: counts.users, entries: counts.entries, foods: counts.foods,
      catalog: catalog ? await catalog.info() : { products: 0, updated_at: null, bls: { products: 0, updated_at: null } },
    };
  }),

  // Who uses this server, with counts. Never diary content, weights or goals. `sso` appears only in oidc mode.
  route('GET', '/api/v1/admin/users', async (req) => {
    await asAdmin(req);
    const { ctx } = req;
    const demoReady = (await demoAccountReady(ctx.db)) !== null;
    const oidc = configOf(ctx).mode === 'oidc';
    return (await adminUsers(ctx.db)).filter((r) => !r.demo || demoReady).map((r) => ({
      username: r.username, display_name: r.own_name || r.display_name || r.username, created_at: r.created_at, disabled: Boolean(r.disabled), admin: Boolean(r.admin),
      household: Boolean(r.household), has_password: Boolean(r.has_password), demo: Boolean(r.demo), entries: r.entries, first_day: r.first_day, last_day: r.last_day,
      tokens: r.tokens, webhooks: r.webhooks, ...(oidc ? { sso: Boolean(r.sso) } : {}),
    }));
  }),

  route('GET', '/api/v1/admin/connectors', async (req) => { await asAdmin(req); return connectorList(req.ctx); }),

  route('PATCH', '/api/v1/admin/connectors/{key}', async (req) => {
    await asAdmin(req);
    const { ctx } = req;
    const key = req.params.key!;
    const body = parse(connectorPatch, req.body);
    if (!(await connectorList(ctx)).some((c) => c.key === key)) throw new HttpError(404, 'unknown connector');
    if (!(key in SWITCH) && !(key in LISTING)) throw new HttpError(422, 'this connector cannot be configured here');
    const updates: Record<string, unknown> = {};
    if (body.enabled !== null) {
      if (!(key in SWITCH)) throw new HttpError(422, 'this connector has no switch');
      updates[SWITCH[key]!] = body.enabled;
    }
    if (body.config && Object.keys(body.config).length && (key === 'cookidoo' || key === 'web_recipes')) {
      const allowed = key === 'cookidoo' ? ['personal', 'images'] : ['images'];
      if (!Object.keys(body.config).every((k) => allowed.includes(k)) || !Object.values(body.config).every((v) => typeof v === 'boolean')) {
        throw new HttpError(422, `${key}: the settings are ${allowed.join(' and ')} (true or false)`);
      }
      for (const [name, value] of Object.entries(body.config)) updates[`${key}.${name}`] = value;
    } else if (body.config && Object.keys(body.config).length) {
      if (!(key in LISTING)) throw new HttpError(422, 'this connector has no settings');
      const [setting, name, pattern, fix] = LISTING[key]!;
      const unknown = Object.keys(body.config).filter((k) => k !== name).sort();
      if (unknown.length) throw new HttpError(422, `unknown setting: ${unknown[0]}`);
      const values = names(body.config[name], pattern, name, fix);
      if (key === 'openfoodfacts_catalog' && !values.length) throw new HttpError(422, 'at least one country');
      updates[setting] = values;
    }
    for (const setting of Object.keys(updates)) {
      if (fixedByEnv(ctx, setting) !== undefined) throw new HttpError(409, `fixed by the environment (${FEATURE_ENV[setting]![0]})`);
    }
    if (key === 'demo_account' && updates['demo_account.enabled'] === true) { // make it (and fill it) before it counts as on
      try { await demoAccount.provision(ctx.db, today()); } catch (e) {
        if (e instanceof demoAccount.DemoAccountError) throw new HttpError(409, e.message);
        throw e;
      }
    }
    for (const [setting, value] of Object.entries(updates)) await setGlobal(ctx.db, setting, value);
    // runs that depend on a switch end when it goes off (Cookidoo import runs, Yazio fetches); what they saved stays
    await (ctx.services.connectorOff as ((updates: Record<string, unknown>) => Promise<void> | void) | undefined)?.(updates);
    return (await connectorList(ctx)).find((c) => c.key === key);
  }),

  // Start the demo account over: everything it holds goes, fresh sample data up to today is made.
  route('POST', '/api/v1/admin/demo-account/reset', async (req) => {
    await asAdmin(req);
    const { ctx } = req;
    if (!(await featureOn(ctx, 'demo_account.enabled'))) throw new HttpError(409, 'the demo account is switched off');
    try { await demoAccount.reset(ctx.db, today()); } catch (e) {
      if (e instanceof demoAccount.DemoAccountError) throw new HttpError(409, e.message);
      throw e;
    }
    return demoAccountConnector(ctx);
  }),

  // Remove the demo account with everything it holds. The switch goes off (unless the environment fixes it); a running switch ends with the next request.
  route('DELETE', '/api/v1/admin/demo-account', async (req) => {
    await asAdmin(req);
    const { ctx } = req;
    if (!(await demoAccount.remove(ctx.db))) throw new HttpError(404, 'there is no demo account');
    if (fixedByEnv(ctx, 'demo_account.enabled') === undefined) await setGlobal(ctx.db, 'demo_account.enabled', false);
    return demoAccountConnector(ctx);
  }),

  route('GET', '/api/v1/admin/catalog/refresh', async (req) => { await asAdmin(req); return refreshOf(req.ctx)?.status() ?? IDLE; }),

  // Rebuild the Open Food Facts catalogue in the background (a download of several hundred MB). One at a time.
  route('POST', '/api/v1/admin/catalog/refresh', async (req) => {
    await asAdmin(req);
    const refresh = refreshOf(req.ctx);
    if (!refresh) throw new HttpError(501, 'the catalogue refresh is not available in this server');
    if (!(await refresh.start())) throw new HttpError(409, 'a refresh is already running');
    return refresh.status();
  }, { status: 202 }),
];

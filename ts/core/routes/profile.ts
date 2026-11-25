// The current user, their settings and the sample data (routes/profile.py: /me, /me/settings; /me/demo-data is in body.ts). The goal and the
// weights of that file belong to the insights package, the import batches to the Yazio one.
import { z } from 'zod';
import { today } from '../dates.ts';
import { featureOn } from '../features.ts';
import { HttpError, parse, pathInt, route, type Req, type Route, type User } from '../http.ts';
import { nullish, pyBool, pyFloat, pyInt } from '../models/common.ts';
import { demoAccountReady, demoCounts } from '../store/demo.ts';
import { listImports, removeImport } from '../store/imports.ts';
import { getGoal } from '../store/goals.ts';
import { getSettings, setSetting } from '../store/settings.ts';
import { setOwnName } from '../store/users.ts';

const HOME_CARDS = ['ring', 'macros', 'fasting', 'water', 'activity', 'weight', 'meals', 'micros', 'suggestions'] as const;
const MAX_WORKOUTS_WEEK = 7;

const homeCard = z.object({ id: z.enum(HOME_CARDS), hidden: pyBool().default(false), wide: pyBool().default(false) });
const home = z.array(homeCard).superRefine((cards, ctx) => {
  if (cards.length > HOME_CARDS.length) ctx.addIssue({ code: 'custom', message: `at most ${HOME_CARDS.length} cards` });
  if (new Set(cards.map((c) => c.id)).size !== cards.length) ctx.addIssue({ code: 'custom', message: 'a card id appears twice' });
});
// StrictInt: a number that is an integer (no text, no bool)
const glasses = z.array(z.number().int()).transform((v, ctx) => {
  if (v.length < 1 || v.length > 3) ctx.issues.push({ code: 'custom', message: '1 to 3 glass sizes', input: v });
  else if (v.some((x) => x < 50 || x > 1000)) ctx.issues.push({ code: 'custom', message: 'a glass holds 50-1000 ml', input: v });
  else if (new Set(v).size !== v.length) ctx.issues.push({ code: 'custom', message: 'a glass size appears twice', input: v });
  else return [...v].sort((a, b) => a - b);
  return z.NEVER;
});
const targetHours = () => pyFloat().pipe(z.number().min(8).max(72));
const workoutsWeek = () => pyInt().pipe(z.number().min(0).max(MAX_WORKOUTS_WEEK));

/** The Settings of the API: what is stored, with the defaults for everything that is not. */
const settings = z.object({
  playful: pyBool().default(true),
  fasting: z.object({ enabled: pyBool().default(false), target_hours: targetHours().default(16) }).default({ enabled: false, target_hours: 16 }),
  activity: z.object({ add_to_goal: pyBool().default(false), workouts_week: workoutsWeek().default(0) }).default({ add_to_goal: false, workouts_week: 0 }),
  tour_seen: pyBool().default(false),
  suggestions: pyBool().default(true),
  home: nullish(home),
  water_glasses: nullish(glasses),
  water_drinks: pyBool().default(true),
});
export type Settings = z.output<typeof settings>;
export const SETTING_KEYS = Object.keys(settings.shape);
/** The settings schema, for the data import (dataImport.ts checks every value like this route does). */
export const SETTINGS = settings;

const settingsPatch = z.object({
  playful: nullish(pyBool()),
  fasting: nullish(z.object({ enabled: nullish(pyBool()), target_hours: nullish(targetHours()) })),
  activity: nullish(z.object({ add_to_goal: nullish(pyBool()), workouts_week: nullish(workoutsWeek()) })),
  tour_seen: nullish(pyBool()),
  suggestions: nullish(pyBool()),
  home: nullish(home),
  water_glasses: nullish(glasses),
  water_drinks: nullish(pyBool()),
});

/** A chosen display name: no control characters, blanks collapsed, 1-60 characters; empty or null means "unset". */
function cleanName(value: string | null): string | null {
  if (value === null) return null;
  if (/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u.test(value) || /(?!‍)\p{Cf}/u.test(value)) throw new Error('the name must not contain control characters or line breaks');
  const text = value.split(/\s+/).filter(Boolean).join(' ');
  if ([...text].length > 60) throw new Error('the name may have at most 60 characters');
  return text || null;
}

const namePatch = z.object({
  display_name: z.string().nullable().default(null).transform((v, ctx) => {
    try { return cleanName(v); } catch (e) {
      ctx.issues.push({ code: 'custom', message: 'Value error, ' + (e as Error).message, input: v });
      return z.NEVER;
    }
  }),
});


export async function userSettings(req: Req, userId: number): Promise<Settings> {
  const stored = await getSettings(req.ctx.db, userId);
  return parse(settings, Object.fromEntries(Object.entries(stored).filter(([k]) => SETTING_KEYS.includes(k))));
}

/** The name the provider delivered, when it differs from the shown one (for "reset to ..."). */
const providerName = (user: User): string | null => {
  const name = user.provider_name || user.username;
  return name !== user.display_name ? name : null;
};

async function me(req: Req, user: User) {
  const { ctx } = req;
  const isDemo = Boolean(user.is_demo);
  const real = user.demo_real;
  const canSwitch = Boolean(user.is_admin && !isDemo && (await featureOn(ctx, 'demo_account.enabled')) && (await demoAccountReady(ctx.db)) !== null);
  const catalog = ctx.services.catalog as { info(): Promise<unknown> } | undefined;
  const [tokens, webhooks, cookidoo, webRecipes] = await Promise.all(
    ['access_tokens.enabled', 'webhooks.enabled', 'cookidoo.enabled', 'web_recipes.enabled'].map((k) => featureOn(ctx, k)));
  return {
    username: user.username,
    display_name: user.display_name,
    display_name_custom: Boolean(user.name_custom),
    provider_name: providerName(user),
    is_admin: user.is_admin,
    household: Boolean(user.household ?? true),
    goal: await getGoal(ctx.db, user.id),
    settings: await userSettings(req, user.id),
    // the demo account has no test-data switch of its own and no connectors (demoAccount.ts closes them)
    demo: { available: Boolean(ctx.services.demoDataOn) && !isDemo, ...(await demoCounts(ctx.db, user.id)) },
    demo_account: { can_switch: canSwitch, viewing: isDemo, real_username: real?.username ?? null, real_display_name: real?.display_name ?? null },
    catalog: catalog ? await catalog.info() : { products: 0, updated_at: null, bls: { products: 0, updated_at: null } },
    features: { access_tokens: tokens && !isDemo, webhooks: webhooks && !isDemo, cookidoo: cookidoo && !isDemo, web_recipes: webRecipes && !isDemo },
  };
}

export const routes: Route[] = [
  route('GET', '/api/v1/me', async (req) => me(req, req.user!)),

  // Choose the display name (kept over the provider's name at every sign-in) or, with an empty/null name, go back to the provider's.
  route('PATCH', '/api/v1/me', async (req) => {
    const user = req.user!;
    const body = parse(namePatch, req.body);
    await setOwnName(req.ctx.db, user.id, body.display_name);
    const own = body.display_name;
    return me(req, { ...user, display_name: own || user.provider_name || user.username, name_custom: own !== null });
  }),

  // This user's import batches (the Yazio import), newest first.
  route('GET', '/api/v1/me/imports', async (req) => listImports(req.ctx.db, req.user!.id)),

  // Remove what one batch created and the user has not changed since; the other data stays.
  route('DELETE', '/api/v1/me/imports/{import_id}', async (req) => {
    const id = pathInt(req, 'import_id');
    const removed = await removeImport(req.ctx.db, id, req.user!.id);
    if (removed === null) throw new HttpError(404, 'unknown import');
    await (req.ctx.services.images as { sweep(): Promise<void> } | undefined)?.sweep(); // foods are gone: tidy the files nothing refers to
    return removed;
  }),

  route('PATCH', '/api/v1/me/settings', async (req) => {
    const user = req.user!;
    const { db } = req.ctx;
    const body = parse(settingsPatch, req.body);
    const given = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    for (const key of SETTING_KEYS) {
      let value: unknown = (body as Record<string, unknown>)[key];
      if (value === null || value === undefined) continue; // exclude_none
      if (key === 'fasting' || key === 'activity') {
        const own = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null));
        value = { ...((await userSettings(req, user.id))[key]), ...own };
      }
      await setSetting(db, user.id, key, value);
    }
    if ('home' in given && body.home === null) await setSetting(db, user.id, 'home', null); // explicit null: back to the default layout
    if ('water_glasses' in given && body.water_glasses === null) await setSetting(db, user.id, 'water_glasses', null);
    return userSettings(req, user.id);
  }),
];

// Cookidoo: the meal plan and collections of a Cookidoo account, and recipes taken over as foods (routes/cookidoo.py).
//
// Whose account: a person who stored an own account (profile) uses that one; everybody else uses the shared household account (the
// environment's, else the one an admin stored). Credentials are kept encrypted (vault) and are never returned: the account endpoints
// only tell whether one is set and show the e-mail address masked.
//
// For signed-in users only (an access token is refused). Switched off or not set up: 404 or 409 with the reason. Anything that goes
// wrong at Cookidoo becomes 502 with a neutral message (see MESSAGES).
import { z } from 'zod';
import { requireAdmin, sessionUser } from '../auth.ts';
import { foodData, CookidooError, EXTERNAL_PREFIX, MESSAGES, RecipeRejected, SHARED, SOURCE, Settings, recipeId, type Access, type Hub, type RecipeDetails } from '../cookidoo.ts';
import { BulkError, GROUP_PREFIX, MAX_RECIPES, SECONDS_PER_RECIPE, makeImagePlan, makePlan, summarize, summarizeImages, type BulkRuns, type Plan } from '../cookidooBulk.ts';
import { accountOut, cookidooHub, cookidooRuns, imageBrake, ownAccess, sharedAccess, vaultOf, SECRET_NAME } from '../cookidooService.ts';
import { featureOn } from '../features.ts';
import { buildFood } from '../foodView.ts';
import { HttpError, parse, queryObject, route, type Ctx, type Req, type Route, type User } from '../http.ts';
import { nullish, pyBool, pyStr } from '../models/common.ts';
import { isHousehold, needEdit, needHousehold } from '../ownership.ts';
import type { RecipeImages } from '../recipeImages.ts';
import { sourceDismissed, sourceGroup } from '../store/cookidoo.ts';
import { getFood, getFoodByExternalId, putExternalFood, updateFood } from '../store/foods.ts';
import { addToGroup, listGroups } from '../store/recipes.ts';
import { HOUSEHOLD, VaultError } from '../vault.ts';
import { webFetcher } from '../brakes.ts';

const KEY_MESSAGE = 'the key for stored secrets is unusable or cannot be created (MAHLWERK_SECRET_KEY or the key file next to the database, see the README)';
const OFF = 'the Cookidoo connector is switched off (admin area)';

const COLLECTION_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const collectionId = () => z.string().regex(COLLECTION_ID);

/** The credentials. No limits are declared here on purpose: a validation error must never echo the password, so the checks run in the
 * handler and answer with a fixed text. */
const accountIn = z.object({
  email: z.string().default(''), password: z.string().default(''), country: z.string().default('de'), language: z.string().default('de-DE'),
});
const adoptIn = z.object({ recipe: pyStr(1, 400), collection: nullish(collectionId()), refresh_image: pyBool().default(false) });
const bulkIn = z.object({ scope: z.enum(['all', 'collection', 'week']), collection: nullish(collectionId()), regroup: pyBool().default(false) });
const refQuery = z.object({ ref: pyStr(1, 400) });
const previewQuery = z.object({ scope: z.enum(['all', 'collection', 'week']), collection: nullish(collectionId()) });

// ---- who and which account ----

/** The account this user's requests go to: their own (if allowed and readable), else the shared one. The shared account is the
 * household's: a guest never gets it, only an own account of theirs (null otherwise). */
async function accessFor(ctx: Ctx, user: User): Promise<Access | null> {
  if (await featureOn(ctx, 'cookidoo.personal')) {
    const [own] = await ownAccess(ctx, user.id);
    if (own !== null) return own;
  }
  if (!isHousehold(user)) return null;
  return (await sharedAccess(ctx))[0];
}

/** The connector and the account to use, once it is switched on and set up; otherwise the matching HTTP error. */
async function ready(req: Req): Promise<[Hub, Access]> {
  const { ctx } = req;
  if (!(await featureOn(ctx, 'cookidoo.enabled'))) throw new HttpError(404, OFF);
  const access = await accessFor(ctx, req.user!);
  if (access === null) {
    if (!isHousehold(req.user!)) throw new HttpError(409, "Cookidoo is not set up for you: guests do not use the household's account, add an own account in your profile");
    throw new HttpError(409, 'Cookidoo is not configured (an account in the admin area or in your profile, or MAHLWERK_COOKIDOO_EMAIL and MAHLWERK_COOKIDOO_PASSWORD)');
  }
  return [cookidooHub(ctx), access];
}

const fail = (e: CookidooError): HttpError => new HttpError(['busy', 'wait', 'locked', 'person'].includes(e.kind) ? 429 : 502, e.message);

/** Runs `fn`; a failure at Cookidoo becomes its neutral 502 (or 429). */
async function neutral<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof CookidooError) throw fail(e); throw e; }
}

/** The caller signed in the normal way (an access token is refused). */
const session = (fn: (req: Req) => Promise<unknown>) => async (req: Req) => { await sessionUser(req); return fn(req); };
const admin = (fn: (req: Req) => Promise<unknown>) => async (req: Req) => { await requireAdmin(req); return fn(req); };

function parseRef(text: string): string {
  const rid = recipeId(text);
  if (rid === null) throw new HttpError(422, 'not a Cookidoo recipe id or recipe link');
  return rid;
}

async function details(req: Req, text: string): Promise<[RecipeDetails, Access]> {
  const rid = parseRef(text);
  const [hub, access] = await ready(req);
  return [await neutral(() => hub.recipe(access, rid)), access];
}

// ---- recipes ----

async function preview(req: Req) {
  const { ref } = parse(refQuery, queryObject(req.query), 'query');
  const [d] = await details(req, ref);
  let data;
  try { data = foodData(d); } catch (e) { if (e instanceof RecipeRejected) throw new HttpError(422, e.message); throw e; }
  const known = await getFoodByExternalId(req.ctx.db, EXTERNAL_PREFIX + d.id);
  return { id: d.id, name: data.name, portions: data.portions, per_portion: data.per_100, extra: data.extra, complete: data.complete, food_id: known ? known.id : null };
}

/** A recipe taken over from a collection goes into that collection's group (the same rules as a run that takes over many). */
async function groupFor(ctx: Ctx, access: Access, user: User, collection: string, foodId: number, isNew: boolean): Promise<void> {
  let found;
  try { found = await cookidooHub(ctx).collections(access); } catch (e) { if (e instanceof CookidooError) return; throw e; } // the recipe is taken over all the same; only the group is left out
  const named = found.find((c) => c.id === collection);
  if (named === undefined) return;
  const [groupId, created] = await sourceGroup(ctx.db, GROUP_PREFIX + collection, named.name, user.id);
  if (groupId !== null && (created || isNew)) await addToGroup(ctx.db, groupId, [foodId]);
}

/** When the admin switched pictures on for Cookidoo, fetch the picture Cookidoo named (best effort: never makes taking the recipe over
 * fail; a picture somebody set or took away is left alone). A picture stored already for the same address is not fetched again unless
 * `force` (an explicit reload); every fetch counts against a brake per person and for the server. */
async function picture(req: Req, foodId: number, url: string | null | undefined, force: boolean): Promise<void> {
  const { ctx } = req;
  if (!url || !(await featureOn(ctx, 'cookidoo.images'))) return;
  const images = ctx.services.images as RecipeImages | undefined;
  const b = imageBrake(ctx);
  if (!images) return;
  await images.fetchProvider(webFetcher(ctx), foodId, url, SOURCE, { force, permit: () => b.allow(req.user!.id) === 0 });
}

async function adopt(req: Req) {
  const body = parse(adoptIn, req.body);
  const { ctx } = req;
  const { db } = ctx;
  const user = req.user!;
  const [d, access] = await details(req, body.recipe);
  let data;
  try { data = { ...foodData(d), region: [access.settings.country, access.settings.language] }; } catch (e) { if (e instanceof RecipeRejected) throw new HttpError(422, e.message); throw e; }
  const external = EXTERNAL_PREFIX + d.id;
  const known = await getFoodByExternalId(db, external);
  let foodId: number;
  if (known !== undefined) {
    needEdit(user, known.owner); // taking a recipe over again renews the household's recipe
    await updateFood(db, known.id, SOURCE, data as never);
    foodId = known.id;
    if (body.collection && isHousehold(user)) await groupFor(ctx, access, user, body.collection, foodId, false);
  } else {
    [foodId] = await putExternalFood(db, external, SOURCE, data as never);
    if (body.collection && isHousehold(user)) await groupFor(ctx, access, user, body.collection, foodId, true); // the groups made from collections are shared and the household's
  }
  await picture(req, foodId, d.image, body.refresh_image);
  return buildFood(ctx, (await getFood(db, foodId)) as never, user);
}

// ---- taking over many recipes at once (a background run, see cookidooBulk.ts) ----

function bulkError(e: BulkError): HttpError {
  if (e.kind === 'not_found') return new HttpError(404, 'unknown collection');
  if (e.kind === 'empty') return new HttpError(422, 'there is nothing to take over in this selection (or no recipe lacks a picture)');
  if (e.kind === 'too_many') return new HttpError(422, `${e.detail} recipes: at most ${MAX_RECIPES} per run, take over collection by collection`);
  if (e.kind === 'wait') return new HttpError(429, 'the picture catch-up was started a moment ago: try again in a few minutes', { 'Retry-After': '600' });
  if (e.kind === 'running') return new HttpError(409, 'a run for this Cookidoo account is already under way');
  return new HttpError(429, 'the server is already taking over recipes for other accounts, try again in a few minutes', { 'Retry-After': '120' });
}

async function planFor(req: Req, scope: string, collection: string | null): Promise<[Access, Plan]> {
  if (scope === 'collection' && !collection) throw new HttpError(422, 'scope collection needs a collection id');
  const [hub, access] = await ready(req);
  try {
    return [access, await makePlan(hub, access, scope, collection)];
  } catch (e) {
    if (e instanceof BulkError) throw bulkError(e);
    if (e instanceof CookidooError) throw fail(e);
    throw e;
  }
}

const runs = (req: Req): BulkRuns => cookidooRuns(req.ctx);

async function startRun(req: Req, access: Access, plan: Plan, regroup: boolean) {
  try {
    return (await runs(req).start(access, plan, req.user!.id, regroup)).view();
  } catch (e) {
    if (e instanceof BulkError) throw bulkError(e);
    throw e;
  }
}

// ---- the accounts: shared (admin) and own (profile) ----

function settingsOf(body: z.infer<typeof accountIn>): Settings {
  const s = Settings.build(body.email, body.password, body.country, body.language);
  if (s === null) throw new HttpError(422, 'e-mail address and password are required; the country is two letters (de) and the language like de-DE');
  return s;
}

async function store(ctx: Ctx, userId: number, settings: Settings): Promise<void> {
  try { await vaultOf(ctx).put(userId, SECRET_NAME, settings.toStored()); } catch (e) {
    if (e instanceof VaultError) throw new HttpError(503, KEY_MESSAGE);
    throw e;
  }
}

async function check(req: Req, access: Access | null) {
  const { ctx } = req;
  if (!(await featureOn(ctx, 'cookidoo.enabled'))) throw new HttpError(404, OFF);
  if (access === null) throw new HttpError(409, 'no Cookidoo account is stored');
  await neutral(() => cookidooHub(ctx).check(access));
  return { ok: true };
}

const FIXED = 'fixed by the environment (MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD)';
const adminAccount = (ctx: Ctx) => accountOut(ctx, HOUSEHOLD, SHARED, Settings.fromEnv(ctx.env) !== null, true, true);
const ownOut = async (ctx: Ctx, user: User) => accountOut(ctx, user.id, `user:${user.id}`, false, await featureOn(ctx, 'cookidoo.personal'), false);
const needPersonal = async (ctx: Ctx) => { if (!(await featureOn(ctx, 'cookidoo.personal'))) throw new HttpError(403, 'own Cookidoo accounts are switched off (admin area)'); };

export const routes: Route[] = [
  route('GET', '/api/v1/cookidoo/status', session(async (req) => {
    const { ctx } = req;
    const hub = cookidooHub(ctx);
    const user = req.user!;
    const access = await accessFor(ctx, user);
    const key = access ? access.key : isHousehold(user) ? SHARED : `user:${user.id}`;
    return {
      state: hub.status(await featureOn(ctx, 'cookidoo.enabled'), access, key), error: MESSAGES[hub.errorOf(key) ?? ''] ?? null,
      account: access ? access.scope : null, personal_allowed: await featureOn(ctx, 'cookidoo.personal'),
    };
  })),

  // The meal plan of the current week (catalogue recipes only). Loaded from Cookidoo at most once a minute.
  route('GET', '/api/v1/cookidoo/week', session(async (req) => {
    const [hub, access] = await ready(req);
    return (await neutral(() => hub.week(access))).map((d) => ({ day: d.day, title: d.title, recipes: d.recipes.map((r) => ({ id: r.id, name: r.name })) }));
  })),

  // The collections of the account (own lists and managed ones). Loaded from Cookidoo at most once a minute.
  route('GET', '/api/v1/cookidoo/collections', session(async (req) => {
    const [hub, access] = await ready(req);
    return (await neutral(() => hub.collections(access))).map((c) => ({ id: c.id, name: c.name, managed: c.managed, recipes: c.recipes.map((r) => ({ id: r.id, name: r.name })) }));
  })),

  // Name, portions and nutrition per portion of one recipe (id or link), without saving anything.
  route('GET', '/api/v1/cookidoo/recipe', session(preview)),

  // Take a recipe over as a food (source `cookidoo`, external id `cookidoo:<id>`). Doing it again updates the food. With `collection` the
  // recipe also goes into the group of that collection (household only). The values per portion are stored as 100 g of the food, so
  // 100 g = 1 portion when logging. The food belongs to the household.
  route('POST', '/api/v1/cookidoo/adopt', session(adopt)),

  // What taking over the selection would do, counted from the lists Cookidoo gave (cached for a minute) and from what is stored.
  route('GET', '/api/v1/cookidoo/import/preview', session(async (req) => {
    const q = parse(previewQuery, queryObject(req.query), 'query');
    const [, plan] = await planFor(req, q.scope, q.collection);
    const stats = await summarize(req.ctx.db, plan, req.ctx.now());
    const existing = await listGroups(req.ctx.db);
    const groups = [];
    for (const [cid, name] of plan.groups) {
      const source = GROUP_PREFIX + cid;
      const exists = existing.some((g) => g.source === source);
      groups.push({ collection: cid, name, exists, dismissed: !exists && (await sourceDismissed(req.ctx.db, source)) });
    }
    return { ...stats, seconds_per_recipe: SECONDS_PER_RECIPE, limit: MAX_RECIPES, groups };
  })),

  // Take over the selection in the background: one detail call to Cookidoo every 3 seconds at least, one run per Cookidoo account, at
  // most two on the server, at most 500 recipes. Household only: a run renews recipes and makes the shared groups.
  route('POST', '/api/v1/cookidoo/import', session(async (req) => {
    const body = parse(bulkIn, req.body);
    needHousehold(req.user!, 'taking over many recipes');
    const [access, plan] = await planFor(req, body.scope, body.collection);
    return startRun(req, access, plan, body.regroup);
  }), { status: 202 }),

  // The latest run of the Cookidoo account this person uses (running, or finished within the last hour), else null.
  route('GET', '/api/v1/cookidoo/import', session(async (req) => {
    const access = await accessFor(req.ctx, req.user!);
    const run = access ? runs(req).get(access.key) : undefined;
    return run ? run.view() : null;
  })),

  // Cancel the running run (it stops before its next call; what was saved stays).
  route('DELETE', '/api/v1/cookidoo/import', session(async (req) => {
    const access = await accessFor(req.ctx, req.user!);
    if (access) runs(req).cancel(access.key, 'user');
    return undefined;
  }), { status: 204 }),

  // How many recipes lack a picture and what a catch-up would cost. Counted from what is stored; no call to Cookidoo.
  route('GET', '/api/v1/cookidoo/images/preview', session(async (req) => {
    const { ctx } = req;
    if (!(await featureOn(ctx, 'cookidoo.enabled'))) throw new HttpError(404, OFF);
    const enabled = await featureOn(ctx, 'cookidoo.images');
    try {
      const stats = summarizeImages(await makeImagePlan(ctx.db, ctx.now()));
      return { enabled, total: stats.total, to_fetch: stats.to_fetch, eta_seconds: stats.eta_seconds, limit: MAX_RECIPES };
    } catch (e) {
      if (e instanceof BulkError) return { enabled, total: 0, to_fetch: 0, eta_seconds: 0, limit: MAX_RECIPES };
      throw e;
    }
  })),

  // Catch up the pictures of recipes taken over before pictures were switched on: in the background, paced like taking recipes over.
  route('POST', '/api/v1/cookidoo/images', session(async (req) => {
    const { ctx } = req;
    needHousehold(req.user!, 'the picture catch-up');
    if (!(await featureOn(ctx, 'cookidoo.images'))) throw new HttpError(409, 'storing recipe pictures is switched off for Cookidoo (admin area)');
    const [, access] = await ready(req);
    try {
      const plan = await makeImagePlan(ctx.db, ctx.now());
      return (await runs(req).start(access, plan, req.user!.id)).view();
    } catch (e) {
      if (e instanceof BulkError) throw bulkError(e);
      throw e;
    }
  }), { status: 202 }),

  // ---- the shared account (admin) ----

  route('GET', '/api/v1/admin/cookidoo/account', admin((req) => adminAccount(req.ctx))),

  route('PUT', '/api/v1/admin/cookidoo/account', admin(async (req) => {
    const body = parse(accountIn, req.body);
    const { ctx } = req;
    if (Settings.fromEnv(ctx.env) !== null) throw new HttpError(409, FIXED);
    await store(ctx, HOUSEHOLD, settingsOf(body));
    await cookidooHub(ctx).forget(SHARED);
    return adminAccount(ctx);
  })),

  route('DELETE', '/api/v1/admin/cookidoo/account', admin(async (req) => {
    const { ctx } = req;
    if (Settings.fromEnv(ctx.env) !== null) throw new HttpError(409, FIXED);
    await vaultOf(ctx).delete(HOUSEHOLD, SECRET_NAME);
    await cookidooHub(ctx).forget(SHARED);
    return adminAccount(ctx);
  })),

  // One sign-in attempt with the shared account (braked: not within 30 seconds of the last one, not for five minutes after a failure).
  route('POST', '/api/v1/admin/cookidoo/account/check', admin(async (req) => check(req, (await sharedAccess(req.ctx))[0]))),

  // ---- the own account (profile) ----

  // This person's own account (never the password). `allowed` is false when an admin forbade own accounts.
  route('GET', '/api/v1/me/cookidoo-account', session((req) => ownOut(req.ctx, req.user!))),

  route('PUT', '/api/v1/me/cookidoo-account', session(async (req) => {
    const body = parse(accountIn, req.body);
    const { ctx } = req;
    if (!(await featureOn(ctx, 'cookidoo.enabled'))) throw new HttpError(404, OFF);
    await needPersonal(ctx);
    await store(ctx, req.user!.id, settingsOf(body));
    await cookidooHub(ctx).forget(`user:${req.user!.id}`);
    return ownOut(ctx, req.user!);
  })),

  route('DELETE', '/api/v1/me/cookidoo-account', session(async (req) => {
    const { ctx } = req;
    await vaultOf(ctx).delete(req.user!.id, SECRET_NAME);
    await cookidooHub(ctx).forget(`user:${req.user!.id}`);
    return ownOut(ctx, req.user!);
  })),

  // One sign-in attempt with this person's own account (braked like every sign-in).
  route('POST', '/api/v1/me/cookidoo-account/check', session(async (req) => {
    await needPersonal(req.ctx);
    return check(req, (await ownAccess(req.ctx, req.user!.id))[0]);
  })),
];

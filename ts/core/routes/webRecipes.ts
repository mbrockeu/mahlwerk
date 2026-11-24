// Recipes from web pages: preview and take over (routes/web_recipes.py; webrecipes.ts says what is read, what is kept and how the
// fetch is guarded). For signed-in people only (an access token is refused). Switched off: 404. Every network problem on the way is
// the same 502 with the same text; a bad address is 422; the brake is 429.
import { z } from 'zod';
import { brake, webCache, webFetcher } from '../brakes.ts';
import { featureOn } from '../features.ts';
import { buildFood } from '../foodView.ts';
import { HttpError, parse, pathInt, route, type Req, type Route } from '../http.ts';
import { nullish, pyBool, pyFloat, pyInt, pyStr } from '../models/common.ts';
import { needEdit } from '../ownership.ts';
import type { RecipeImages } from '../recipeImages.ts';
import { getFood, getFoodByExternalId, putExternalFood, updateFood } from '../store/foods.ts';
import { urlsplit } from '../urlsplit.ts';
import * as web from '../webrecipes.ts';

const BLOCKED: Record<string, string> = {
  no_name: 'the recipe needs a name',
  no_energy: 'the page gives no energy value (kcal) for this recipe, so it is not taken over (it would count as 0 kcal)',
  too_high: 'the energy value per portion is not plausible (more than 5000 kcal): check the portions or whether the values are for the whole recipe',
  whole_needs_portions: 'the number of portions is needed to divide the values of the whole recipe',
};

const previewIn = z.object({
  url: pyStr(1, 2000),
  whole: pyBool().default(false),
  portions: nullish(pyFloat().pipe(z.number().gt(0).max(web.MAX_PORTIONS))),
  name: nullish(pyStr(0, 400)),
});
const adoptIn = previewIn.extend({ refresh: pyBool().default(false), group_id: nullish(pyInt()) });
type PreviewIn = z.infer<typeof previewIn>;

/** The dependencies of the router: a caller who signed in the normal way (an access token is refused), and the switch. */
async function need(req: Req): Promise<void> {
  if (req.user!.via_token) throw new HttpError(403, 'not available with an access token');
  if (!(await featureOn(req.ctx, 'web_recipes.enabled'))) throw new HttpError(404, 'the connector for recipes from web pages is switched off (admin area)');
}
const guarded = (fn: (req: Req) => Promise<any>) => async (req: Req) => { await need(req); return fn(req); };

/** [address as given, what the page said, address of the page that answered]. From the cache or from one fetch. */
async function load(req: Req, url: string, refresh: boolean): Promise<[string, web.Parsed, string]> {
  const { ctx } = req;
  let address: string;
  try {
    address = web.checkAddress(url)[0];
  } catch {
    throw new HttpError(422, 'this is not a web address that can be fetched (an http or https address of a public website, standard port)');
  }
  const fetcher = webFetcher(ctx);
  // a name that is the server's own (or listed by the admin) is refused like an internal target: same text, nothing contacted
  if (web.isBlocked(urlsplit(address).hostname ?? '', fetcher.blocked())) throw new HttpError(502, web.NEUTRAL);
  const key = address; // with the scheme: what http answers must never be shown for https
  const cache = webCache(ctx);
  if (refresh) cache.drop(key);
  else {
    const hit = cache.get(key);
    if (hit !== null) {
      if (hit[0] === null) throw new HttpError(422, 'no recipe data found on this page');
      return [address, hit[0], hit[1]];
    }
  }
  const b = brake(ctx, 'web');
  if (!b.slot()) throw new HttpError(429, 'the server is fetching other pages right now, try again in a moment', { 'Retry-After': '5' }); // first the slot: a fetch that could not even start is not counted against the person
  let page: web.Page;
  try {
    const wait = b.allow(req.user!.id);
    if (wait) throw new HttpError(429, 'too many pages fetched lately, try again in a few minutes', { 'Retry-After': String(wait) });
    page = await fetcher.fetch(address);
  } catch (e) {
    if (!(e instanceof web.FetchFailed)) throw e;
    console.info('web recipe fetch failed:', e.kind);
    if (e.kind === 'not_html') throw new HttpError(422, 'the address is not a web page (HTML)');
    if (e.kind === 'too_large') throw new HttpError(422, 'the page is too large');
    throw new HttpError(502, web.NEUTRAL);
  } finally {
    b.release();
  }
  let parsed: web.Parsed | null;
  try { parsed = web.parsePage(page.text); } catch { parsed = null; } // whatever a page does to the reader: no recipe, no 500
  cache.put(key, parsed, page.url);
  if (parsed === null) throw new HttpError(422, 'no recipe data found on this page');
  return [address, parsed, page.url];
}

async function preview(req: Req, address: string, final: string, parsed: web.Parsed, body: PreviewIn) {
  const item = web.interpret(parsed, { whole: body.whole, portions: body.portions, name: body.name });
  const known = await getFoodByExternalId(req.ctx.db, web.externalId(address));
  return {
    url: address, host: web.hostLabel(final), name: item.name, portions: item.portions, page_portions: parsed.portions,
    per_portion: item.per_portion, extra: item.extra, complete: item.complete, whole: body.whole, serving_size: parsed.serving_size,
    ingredients: parsed.ingredients, warnings: item.warnings, blocked: item.blocked, food_id: known ? known.id : null,
  };
}

async function save(req: Req, address: string, final: string, parsed: web.Parsed, body: PreviewIn, groupId: number | null, force = false) {
  const { ctx } = req;
  const { db } = ctx;
  const user = req.user!;
  const item = web.interpret(parsed, { whole: body.whole, portions: body.portions, name: body.name });
  if (item.blocked) throw new HttpError(422, BLOCKED[item.blocked]!);
  if (groupId !== null) {
    const group = await db.get('SELECT created_by FROM recipe_group WHERE id = ?', [groupId]);
    if (!group) throw new HttpError(404, 'unknown group');
    needEdit(user, group.created_by);
  }
  const data = { ...web.foodData(item, address, final), whole: body.whole };
  const external = web.externalId(address);
  const known = await getFoodByExternalId(db, external);
  if (known && address.startsWith('http://') && String(known.data?.url ?? '').startsWith('https://')) {
    // http and https of one page are ONE recipe, but an http address must not quietly replace one taken over through https
    throw new HttpError(422, 'this page was taken over with its https address: use that address');
  }
  let foodId: number;
  if (known) {
    needEdit(user, known.owner); // taking a page over again renews the household's recipe
    await updateFood(db, known.id, web.SOURCE, data);
    foodId = known.id;
  } else {
    [foodId] = await putExternalFood(db, external, web.SOURCE, data);
  }
  if (groupId !== null) await db.run('INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)', [groupId, foodId]);
  await picture(req, foodId, web.imageAddress(parsed.image, final), force);
  return buildFood(ctx, (await getFood(db, foodId)) as any, user);
}

/** When the admin switched pictures on for web recipes, fetch the picture the page named, with the same guarded fetch as the page. It
 * counts as a fetch of the brake (per person and for the server) and takes a slot. A picture that is stored already for the same address
 * is not fetched again unless `force` (an explicit reload). Best effort: never makes taking the recipe over fail; a picture somebody set
 * or took away is left alone. Nothing is remembered about the address while the switch is off. */
async function picture(req: Req, foodId: number, url: string | null, force: boolean): Promise<void> {
  const { ctx } = req;
  if (!url || !(await featureOn(ctx, 'web_recipes.images'))) return;
  const images = ctx.services.images as RecipeImages | undefined;
  const b = brake(ctx, 'web');
  if (!images || !b.slot()) return;
  try {
    await images.fetchProvider(webFetcher(ctx), foodId, url, web.SOURCE, { force, permit: () => b.allow(req.user!.id) === 0 });
  } finally {
    b.release();
  }
}

export const routes: Route[] = [
  // Fetch the page (once per few minutes and address) and show what would be taken over. Saves nothing. A POST, because it makes the
  // server open a connection.
  route('POST', '/api/v1/web-recipes/preview', guarded(async (req) => {
    const body = parse(previewIn, req.body);
    const [address, parsed, final] = await load(req, body.url, false);
    return preview(req, address, final, parsed, body);
  })),

  // Take the recipe over as a food (source `web`, external id `web:<host><path>`). The address is the identity: doing it again (also
  // with other tracking parameters) updates the same food. The values of one portion are stored as 100 g of the food, so 100 g = 1
  // portion when logging; the food belongs to the household.
  route('POST', '/api/v1/web-recipes', guarded(async (req) => {
    const body = parse(adoptIn, req.body);
    const [address, parsed, final] = await load(req, body.url, body.refresh);
    return save(req, address, final, parsed, body, body.group_id, body.refresh);
  })),

  // Fetch the page of a taken-over recipe again. The values are renewed; the name and the number of portions the person set stay (and
  // "values for the whole recipe", if that was said).
  route('POST', '/api/v1/web-recipes/{food_id}/reload', guarded(async (req) => {
    const row = await getFood(req.ctx.db, pathInt(req, 'food_id'));
    if (!row || !row.found || row.source !== web.SOURCE) throw new HttpError(404, 'unknown web recipe');
    const data = row.data!;
    const link = web.safeLink(data.url);
    if (link === null) throw new HttpError(422, 'this recipe has no usable address');
    const [address, parsed, final] = await load(req, link, true);
    const body = parse(previewIn, { url: address, whole: Boolean(data.whole), portions: data.portions ?? null, name: data.name ?? null });
    return save(req, address, final, parsed, body, null, true);
  })),
];

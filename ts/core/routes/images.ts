// Pictures of recipes: the stored files (for signed-in people and read tokens) and an own photo for a recipe (routes/images.py).
//
// The browser never loads a picture from anywhere else: every picture on a page is one of these routes. The hash in the address is the
// content hash, so the answer never changes for an address: it is cached for a year (`immutable`) in the browser of the person
// (`private`, never by a shared cache). That is the one deliberate exception to `Cache-Control: no-store`. A removed picture is gone at
// once: an address whose hash no food refers to any more answers 404, also while its file is still on disk waiting to be tidied.
import { buildFood } from '../foodView.ts';
import { HttpError, pathInt, respond, route, type Req, type Route } from '../http.ts';
import { ImageRejected, STATUS_OF } from '../imageproc.ts';
import { StoreError, validHash, validSize } from '../imagestore.ts';
import { needEdit } from '../ownership.ts';
import { UnknownFood, type RecipeImages } from '../recipeImages.ts';
import { getFood, imageRefs, type FoodRow } from '../store/foods.ts';
import { brake } from '../brakes.ts';
import { featureOn } from '../features.ts';

const CACHE = 'private, max-age=31536000, immutable';
const PICTURE_SOURCES = ['recipe', 'cookidoo', 'web']; // the foods that can have a picture

const images = (req: Req): RecipeImages => {
  const s = req.ctx.services.images as RecipeImages | undefined;
  if (!s) throw new HttpError(501, 'pictures cannot be processed on this server');
  return s;
};

/** The recipe a picture is changed on: it must exist, be a recipe and be the caller's to change. */
async function recipeFood(req: Req, foodId: number): Promise<FoodRow> {
  const row = await getFood(req.ctx.db, foodId);
  if (!row || !row.found) throw new HttpError(404, 'unknown food');
  if (!PICTURE_SOURCES.includes(row.source)) throw new HttpError(409, 'only recipes (own, from Cookidoo or from a web page) can have a picture');
  needEdit(req.user!, row.owner);
  return row;
}

const food = async (req: Req, id: number) => buildFood(req.ctx, (await getFood(req.ctx.db, id)) as any, req.user!);

export const routes: Route[] = [
  // One size (`l` 960 px, `m` 240 px square, `s` 96 px square) of a recipe picture, as WebP. 404 for an unknown size, a hash that is
  // not 32 hex digits, a picture no recipe uses, and a file that is missing (a recipe without picture, not an error).
  route('GET', '/api/v1/images/{digest}/{size}', async (req) => {
    const { digest, size } = req.params as { digest: string; size: string };
    if (!validHash(digest) || !validSize(size) || (await imageRefs(req.ctx.db, digest)) === 0) throw new HttpError(404, 'unknown picture');
    const etag = `"${digest}-${size}"`;
    const headers = { 'Cache-Control': CACHE, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if ((req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim()).includes(etag)) return respond({ status: 304, headers });
    const body = await images(req).files.read(digest, size);
    if (body === null) throw new HttpError(404, 'unknown picture');
    return respond({ status: 200, headers: { ...headers, 'content-type': 'image/webp' }, body });
  }),

  // Set an own photo for a recipe: the picture file as the request body (JPEG, PNG or WebP, at most 8 MB; the interface shrinks it
  // first). It replaces any picture the recipe had and is never replaced by a reload from the provider. Always possible, whatever the
  // picture switches of the connectors say.
  route('PUT', '/api/v1/foods/{food_id}/image', async (req) => {
    const foodId = pathInt(req, 'food_id');
    await recipeFood(req, foodId);
    const data = req.body instanceof Uint8Array ? req.body : undefined;
    if (!data || !data.length) throw new HttpError(422, 'empty body');
    const wait = brake(req.ctx, 'upload').allow(req.user!.id); // at most 20 photos per person in 10 minutes
    if (wait) throw new HttpError(429, 'too many photos lately, try again in a few minutes', { 'Retry-After': String(wait) });
    try {
      await images(req).attach(foodId, data, 'own', null);
    } catch (e) {
      if (e instanceof ImageRejected) throw new HttpError(STATUS_OF[e.kind] ?? 422, e.message, e.kind === 'busy' ? { 'Retry-After': '5' } : undefined);
      if (e instanceof StoreError) throw new HttpError(507, e.message);
      if (e instanceof UnknownFood) throw new HttpError(404, 'unknown food');
      throw e;
    }
    return food(req, foodId);
  }),

  // Take the picture of a recipe away. For a picture taken over from a provider this is remembered, so a reload does not bring it back.
  route('DELETE', '/api/v1/foods/{food_id}/image', async (req) => {
    const foodId = pathInt(req, 'food_id');
    await recipeFood(req, foodId);
    await images(req).remove(foodId, true);
    return food(req, foodId);
  }),

  // Lift the "taken away" marker of a provider's picture, so that the next reload of the recipe fetches it again. Only while the
  // picture switch of the recipe's connector is on; 409 otherwise or when nothing was taken away.
  route('POST', '/api/v1/foods/{food_id}/image/restore', async (req) => {
    const foodId = pathInt(req, 'food_id');
    const row = await recipeFood(req, foodId);
    const { ctx } = req;
    if (!((row.source === 'cookidoo' && (await featureOn(ctx, 'cookidoo.images'))) || (row.source === 'web' && (await featureOn(ctx, 'web_recipes.images'))))) {
      throw new HttpError(409, "storing recipe pictures is switched off for this recipe's source (admin area)");
    }
    if (!(await images(req).restore(foodId))) throw new HttpError(409, 'the picture of this recipe was not taken away');
    return food(req, foodId);
  }),
];

// Own foods: create, read, change, delete, search, the piece and drink settings, recent foods (routes/foods.py).
// Not ported yet (their own packages): GET /foods/barcode/{code} (Open Food Facts), label scans, images, combos.
import { z } from 'zod';
import { fitScores, windowStart } from '../combos.ts';
import { today } from '../dates.ts';
import { buildFood, ownData } from '../foodView.ts';
import { HttpError, parse, pathInt, queryObject, route, type Req, type Route, type User } from '../http.ts';
import { mealSchema, pyInt } from '../models/common.ts';
import { foodDrink, foodIn, foodPiece, type Food, type RecentFood } from '../models/food.ts';
import { validGtin, scale, r1 } from '../nutrition.ts';
import { needEdit } from '../ownership.ts';
import { mealRowsSince, recentFoods } from '../store/diary.ts';
import {
  clearFoodImage, deleteFood, getFood, getFoodByCode, getFoods, listFoods, putFood, setFoodDrink, setFoodPiece, updateFood,
  type FoodRow,
} from '../store/foods.ts';

const FIT_POOL = 500; // foods looked at when ordering the recent foods by fit to a meal
const COOKIDOO = 'cookidoo';
const WEB = 'web';

/** The pictures of recipes live outside core (files); the host may hand in what has to happen to a file. */
interface ImageService { release(digest: string | null): Promise<void> }
const images = (req: Req) => req.ctx.services.images as ImageService | undefined;

const SOURCES = z.enum(['own', 'openfoodfacts', 'recipe', 'yazio', 'bls', 'cookidoo', 'web']);

const needBarcode = (code: string) => {
  if (!validGtin(code)) throw new HttpError(422, 'not a valid EAN/UPC barcode');
};

const notARecipe = (row: FoodRow) => {
  if (row.source === 'recipe') throw new HttpError(409, 'this food is calculated from a recipe: change the recipe instead');
};

async function existing(req: Req, foodId: number, demoView = false): Promise<FoodRow> {
  const row = await getFood(req.ctx.db, foodId, demoView);
  if (!row || !row.found) throw new HttpError(404, 'unknown food');
  return row;
}

const demo = (user: User) => Boolean(user.is_demo);

/** The piece columns of a food that was just written (a reload keeps them), for the rows `buildFood` gets from a write. */
async function withPiece(req: Req, foodId: number) {
  const row = await getFood(req.ctx.db, foodId, true);
  return { piece_label: row?.piece_label ?? null, piece_grams: row?.piece_grams ?? null, drink: row?.drink ?? null, owner: row?.owner ?? null };
}

async function pieceFood(req: Req, foodId: number): Promise<FoodRow> {
  const row = await existing(req, foodId);
  needEdit(req.user!, row.owner);
  if (row.source === COOKIDOO || row.source === WEB) throw new HttpError(409, 'this food is booked in portions: a piece makes no sense here');
  return row;
}

export const routes: Route[] = [
  // An own entry for a barcode. A guest may do this only while the barcode has no entry yet (a remembered miss does not count)
  // or the entry is their own: an entry of the household (also one fetched from Open Food Facts) is never replaced by a guest.
  route('PUT', '/api/v1/foods/barcode/{code}', async (req): Promise<Food> => {
    const food = parse(foodIn, req.body);
    const code = req.params.code;
    needBarcode(code);
    const user = req.user!;
    const old = await getFoodByCode(req.ctx.db, code);
    if (old) {
      notARecipe(old);
      if (old.found) needEdit(user, old.owner);
    }
    const data = ownData(food);
    const [id, fetchedAt] = await putFood(req.ctx.db, code, 'own', data, user.id);
    return buildFood(req.ctx, { ...(await withPiece(req, id)), id, code, source: 'own', data, fetched_at: fetchedAt }, user);
  }),

  // Products stored on this server, newest first. The sample foods of the demo account show up only in the demo account.
  route('GET', '/api/v1/foods', async (req): Promise<Food[]> => {
    const q = parse(z.object({
      q: z.string().default(''), source: SOURCES.optional(), exclude_source: z.array(SOURCES).default([]),
      limit: pyInt().pipe(z.number().min(1).max(1000)).default(50),
    }), { ...queryObject(req.query), exclude_source: req.query.getAll('exclude_source') }, 'query');
    const rows = await listFoods(req.ctx.db, q.q, q.source ?? null, q.limit, q.exclude_source, demo(req.user!));
    return rows.map((row) => buildFood(req.ctx, row as Required<FoodRow> & { data: NonNullable<FoodRow['data']> }, req.user));
  }),

  route('GET', '/api/v1/foods/recent', async (req): Promise<RecentFood[]> => {
    const q = parse(z.object({ limit: pyInt().pipe(z.number().min(1).max(200)).default(20), meal: mealSchema.optional() }), queryObject(req.query), 'query');
    const { db } = req.ctx;
    const uid = req.user!.id;
    let items = await recentFoods(db, uid, q.meal === undefined ? q.limit : Math.max(q.limit, FIT_POOL));
    if (q.meal !== undefined) {
      const now = today();
      const scores = fitScores(await mealRowsSince(db, uid, q.meal, windowStart(now)), now);
      const byFood = new Set(items.map((i) => i.food_id));
      const fit = [...scores.keys()].filter((f) => byFood.has(f)).sort((a, b) => scores.get(b)!.score - scores.get(a)!.score);
      const fitting = fit.map((f) => ({ food_id: f, amount: scores.get(f)!.amount, meal: q.meal! }));
      items = [...fitting, ...items.filter((i) => !scores.has(i.food_id))].slice(0, q.limit);
    }
    const rows = await getFoods(db, items.map((i) => i.food_id), demo(req.user!)); // one query, not one per food
    return items.filter((i) => rows.has(i.food_id)).map((i) => ({
      food: buildFood(req.ctx, rows.get(i.food_id) as any, req.user), last_amount: i.amount, last_meal: i.meal as RecentFood['last_meal'],
    }));
  }),

  route('POST', '/api/v1/foods', async (req): Promise<Food> => {
    const food = parse(foodIn, req.body);
    const user = req.user!;
    const data = ownData(food);
    const [id, fetchedAt] = await putFood(req.ctx.db, null, 'own', data, user.id);
    return buildFood(req.ctx, { id, code: null, source: 'own', data, fetched_at: fetchedAt, created_by: user.id }, user);
  }, { status: 201 }),

  route('GET', '/api/v1/foods/{food_id}', async (req): Promise<Food> =>
    buildFood(req.ctx, (await existing(req, pathInt(req, 'food_id'), demo(req.user!))) as any, req.user)),

  route('PUT', '/api/v1/foods/{food_id}', async (req): Promise<Food> => {
    const foodId = pathInt(req, 'food_id');
    const food = parse(foodIn, req.body);
    let row = await existing(req, foodId);
    notARecipe(row);
    needEdit(req.user!, row.owner);
    const data = ownData(food);
    const fetchedAt = await updateFood(req.ctx.db, foodId, 'own', data);
    if (row.source === COOKIDOO || row.source === WEB || row.image_hash) {
      // an own product is no recipe and has no picture: the picture of the recipe it was goes with its source
      await images(req)?.release(await clearFoodImage(req.ctx.db, foodId) || null);
      row = { ...row, image_hash: null, image_origin: null };
    }
    return buildFood(req.ctx, { ...row, source: 'own', data, fetched_at: fetchedAt! }, req.user);
  }),

  // Say what one piece is ("slice" = 25 g). Not part of the food data: a reload from Open Food Facts leaves it alone.
  route('PUT', '/api/v1/foods/{food_id}/piece', async (req): Promise<Food> => {
    const foodId = pathInt(req, 'food_id');
    const piece = parse(foodPiece, req.body);
    const row = await pieceFood(req, foodId);
    await setFoodPiece(req.ctx.db, foodId, piece.label, piece.grams);
    return buildFood(req.ctx, { ...row, piece_label: piece.label, piece_grams: piece.grams } as any, req.user);
  }),

  route('DELETE', '/api/v1/foods/{food_id}/piece', async (req) => {
    const foodId = pathInt(req, 'food_id');
    await pieceFood(req, foodId);
    await setFoodPiece(req.ctx.db, foodId, null, null);
    return undefined;
  }, { status: 204 }),

  // Say whether the food counts towards the daily fluid total (`null`: automatically). Not part of the food data.
  route('PUT', '/api/v1/foods/{food_id}/drink', async (req): Promise<Food> => {
    const foodId = pathInt(req, 'food_id');
    const body = parse(foodDrink, req.body);
    const row = await existing(req, foodId);
    needEdit(req.user!, row.owner);
    if (row.source === COOKIDOO || row.source === WEB) throw new HttpError(409, 'this food is booked in portions: it is no drink');
    await setFoodDrink(req.ctx.db, foodId, body.drink);
    return buildFood(req.ctx, { ...row, drink: body.drink } as any, req.user);
  }),

  // Past diary entries keep their copy of the values. The picture of a taken-over recipe goes with it.
  route('DELETE', '/api/v1/foods/{food_id}', async (req) => {
    const foodId = pathInt(req, 'food_id');
    const row = await existing(req, foodId);
    notARecipe(row);
    needEdit(req.user!, row.owner);
    await deleteFood(req.ctx.db, foodId);
    await images(req)?.release(row.image_hash);
    return undefined;
  }, { status: 204 }),
];

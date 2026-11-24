// Recipes: a shared food of the household that is calculated from its ingredients (routes/recipes.py), and the reading of a pasted
// ingredient list (POST /recipes/ingredients/match).
import { addDays, today } from '../dates.ts';
import { buildFood } from '../foodView.ts';
import { HttpError, parse, pathInt, route, type Req, type Route, type User } from '../http.ts';
import * as ingredients from '../ingredients.ts';
import { ingredientsIn, recipeIn, type IngredientCandidate, type IngredientLine, type IngredientMatches, type Recipe } from '../models/recipe.ts';
import { PER_100_KEYS, r1, recipeFood, scale } from '../nutrition.ts';
import * as nutrients from '../nutrients.ts';
import { pySum } from '../num.ts';
import { canEdit, needEdit } from '../ownership.ts';
import { getFood, listFoods } from '../store/foods.ts';
import { deleteRecipe, eatenSince, getRecipe, knownCatalog, listRecipes, saveRecipe, type RecipeRow } from '../store/recipes.ts';
import type { ItemIn } from '../store/templates.ts';

/** The pictures of recipes live outside core (files); the host may hand in what has to happen to a file. */
interface ImageService { release(digest: string | null): Promise<void> }

export function recipeOut(req: Req, row: RecipeRow, user: User | null): Recipe {
  const items = row.items.map((item) => {
    const kcal = scale(item.per_100, item.amount).kcal;
    return { food_id: item.food_id, name: item.name, brand: item.brand, amount: item.amount, unit: item.unit, kcal: kcal === null ? null : r1(kcal) };
  });
  const known = items.map((i) => i.kcal).filter((k): k is number => k !== null);
  return {
    id: row.id,
    food: buildFood(req.ctx, row.food as any, user),
    portions: row.portions,
    total_weight: row.total_weight,
    items,
    kcal_per_portion: known.length ? r1(pySum(known) / row.portions) : null,
    can_edit: user === null ? true : canEdit(user, row.food.owner),
  };
}

async function ingredientRows(req: Req, body: { items: { food_id: number; amount: number }[] }): Promise<ItemIn[]> {
  const items: ItemIn[] = [];
  for (const [i, item] of body.items.entries()) {
    const position = i + 1;
    const food = await getFood(req.ctx.db, item.food_id);
    if (!food || !food.found) throw new HttpError(422, `ingredient ${position}: unknown food`);
    if (food.source === 'recipe') throw new HttpError(422, `ingredient ${position}: a recipe cannot be an ingredient of a recipe`);
    const data = food.data!;
    items.push({
      food_id: food.id, amount: item.amount, unit: data.unit || 'g', name: data.name || food.code || 'Unnamed', brand: data.brand ?? null,
      per_100: data.per_100, extra: nutrients.clean(data.extra),
    });
  }
  return items;
}

async function save(req: Req, recipeId: number | null, body: ReturnType<typeof recipeIn.parse>): Promise<RecipeRow> {
  const items = await ingredientRows(req, body);
  const data = { ...recipeFood(items as any, body.portions, body.total_weight), name: body.name };
  const saved = await saveRecipe(req.ctx.db, recipeId, req.user!.id, data as any, body.portions, body.total_weight, items);
  if (saved === null) throw new HttpError(404, 'unknown recipe');
  return (await getRecipe(req.ctx.db, saved))!;
}

async function existing(req: Req, recipeId: number): Promise<RecipeRow> {
  const row = await getRecipe(req.ctx.db, recipeId);
  if (!row) throw new HttpError(404, 'unknown recipe');
  return row;
}

const candidateOut = (c: ingredients.Candidate): IngredientCandidate => ({
  source: c.source, food_id: c.food_id, code: c.code, name: c.name, brand: c.brand, unit: c.unit as IngredientCandidate['unit'],
  per_100: Object.fromEntries(PER_100_KEYS.map((k) => [k, c.per_100[k] ?? null])), eaten_count: c.eaten_count, eaten_last: c.eaten_last,
});

export const routes: Route[] = [
  // Reads a pasted ingredient list (one per line, German or English): amount, unit, name, grams and the foods that may be meant.
  // With `recent` the foods eaten in the last days come first and say so. Writes nothing. Deterministic, no network.
  route('POST', '/api/v1/recipes/ingredients/match', async (req): Promise<IngredientMatches> => {
    const body = parse(ingredientsIn, req.body);
    const { db } = req.ctx;
    const user = req.user!;
    const { lines: parsed, ignored } = ingredients.parseText(body.text);
    const own = (await listFoods(db, '', null, 100_000, ['recipe', 'cookidoo', 'web'], Boolean(user.is_demo))) as ingredients.OwnFood[];
    const eaten = body.recent ? await eatenSince(db, user.id, addDays(today(), -(ingredients.RECENT_DAYS - 1))) : null;
    const catalog = req.ctx.services.catalog as ingredients.CatalogSearch | undefined;
    const skip = (hits: ingredients.CatalogHit[]) => knownCatalog(db, hits, ingredients.skipKey);
    const lines: IngredientLine[] = [];
    for (const [number, line] of parsed) {
      const found = await ingredients.candidates(line.name, own, catalog, skip, line.text, line.canned, eaten);
      const out = found.map(candidateOut);
      lines.push({
        line: number, text: line.text, quantity: line.quantity, unit: line.unit, name: line.name, note: line.note, optional: line.optional,
        grams: line.grams, ml: line.ml, estimated: line.estimated, basis: line.basis, candidates: out,
        suggestion: out.length && found[0].good ? out[0] : null,
      });
    }
    return { lines, ignored };
  }),

  route('GET', '/api/v1/recipes', async (req): Promise<Recipe[]> => (await listRecipes(req.ctx.db)).map((row) => recipeOut(req, row, req.user!))),

  route('POST', '/api/v1/recipes', async (req): Promise<Recipe> => recipeOut(req, await save(req, null, parse(recipeIn, req.body)), req.user!), { status: 201 }),

  route('GET', '/api/v1/recipes/{recipe_id}', async (req): Promise<Recipe> => recipeOut(req, await existing(req, pathInt(req, 'recipe_id')), req.user!)),

  // Recalculates the food; diary entries logged before keep their copy.
  route('PUT', '/api/v1/recipes/{recipe_id}', async (req): Promise<Recipe> => {
    const recipeId = pathInt(req, 'recipe_id');
    const body = parse(recipeIn, req.body);
    needEdit(req.user!, (await existing(req, recipeId)).food.owner);
    return recipeOut(req, await save(req, recipeId, body), req.user!);
  }),

  // Removes the recipe and its food (and its picture); diary entries and templates keep their copies.
  route('DELETE', '/api/v1/recipes/{recipe_id}', async (req) => {
    const recipeId = pathInt(req, 'recipe_id');
    const row = await getRecipe(req.ctx.db, recipeId);
    if (row) needEdit(req.user!, row.food.owner);
    if (!row || !(await deleteRecipe(req.ctx.db, recipeId))) throw new HttpError(404, 'unknown recipe');
    await (req.ctx.services.images as ImageService | undefined)?.release(row.food.image_hash);
    return undefined;
  }, { status: 204 }),
];

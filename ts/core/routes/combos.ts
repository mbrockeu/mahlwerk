// Favourite combos: foods a person often eats together in one meal (GET /foods/combos of routes/foods.py, logic in combos.ts).
// Its own file, registered before the foods routes: `/foods/{food_id}` would otherwise swallow the path.
import { z } from 'zod';
import { comboKey, mine, windowStart } from '../combos.ts';
import { today } from '../dates.ts';
import { buildFood } from '../foodView.ts';
import { parse, queryObject, route, type Route } from '../http.ts';
import { mealSchema } from '../models/common.ts';
import type { Combo } from '../models/recipe.ts';
import { r1, scale } from '../nutrition.ts';
import { pySum } from '../num.ts';
import { mealRowsSince } from '../store/diary.ts';
import { getFoods } from '../store/foods.ts';
import { listTemplates } from '../store/templates.ts';

export const routes: Route[] = [
  // Up to 3 sets of foods this person often eats together in this meal (at least 3 different days of the last 42), best first, each with
  // the amounts of the last time. Sets that equal one of the person's templates are left out.
  route('GET', '/api/v1/foods/combos', async (req): Promise<Combo[]> => {
    const { meal } = parse(z.object({ meal: mealSchema }), queryObject(req.query), 'query');
    const { db } = req.ctx;
    const user = req.user!;
    let rows = await mealRowsSince(db, user.id, meal, windowStart(today()));
    const foods = await getFoods(db, [...new Set(rows.map((r) => r.food_id))], Boolean(user.is_demo));
    rows = rows.filter((r) => foods.has(r.food_id));
    const skip = new Set<string>();
    for (const template of await listTemplates(db, user.id)) {
      const ids = template.items.map((i) => i.food_id);
      if (!ids.includes(null)) skip.add(comboKey(ids as number[]));
    }
    return mine(rows, skip).map((combo) => {
      const items = combo.foods.map(([foodId, amount]) => {
        const food = foods.get(foodId)!;
        const kcal = scale(food.data!.per_100, amount).kcal;
        return { food: buildFood(req.ctx, food as any, user), amount, kcal: kcal === null ? null : r1(kcal) };
      });
      return { items, kcal: r1(pySum(items.map((i) => i.kcal ?? 0))), days: combo.days, last_day: combo.last_day };
    });
  }),
];

// Suggestions "what still fits today": recipes that suit the rest of the day (routes/suggestions.py, rule in suggest.ts). Everything is
// computed from data that is on this server already; goals and history are per person, the recipes are the household's.
import { z } from 'zod';
import * as activity from '../activity.ts';
import { dayActivities } from '../activityViews.ts';
import { daysBetween, today } from '../dates.ts';
import { buildFood } from '../foodView.ts';
import { parse, queryObject, route, type Route } from '../http.ts';
import { FOCI, type Focus, type RestOut, type Suggestions } from '../models/recipe.ts';
import { pyBool, pyInt } from '../models/common.ts';
import { scale, total } from '../nutrition.ts';
import { roundHalfEven } from '../num.ts';
import * as suggest from '../suggest.ts';
import { entriesOn } from '../store/diary.ts';
import { getFood } from '../store/foods.ts';
import { goalOn } from '../store/goals.ts';
import { lastEaten, recipeFoods } from '../store/recipes.ts';
import { parseDay } from './diary.ts';

const r1 = (x: number) => roundHalfEven(x, 1);

const restOf = (goal: { protein?: number | null; carbs?: number | null; fat?: number | null } | null, goalKcal: number | null, eaten: Record<string, number>): suggest.Rest => {
  if (goal === null || goalKcal === null) return suggest.rest(null);
  return suggest.rest(r1(goalKcal - eaten.kcal), goal.protein ? r1(goal.protein - eaten.protein) : null, goal.carbs ? r1(goal.carbs - eaten.carbs) : null, goal.fat ? r1(goal.fat - eaten.fat) : null);
};

const query = z.object({
  date: z.string().optional(),
  limit: pyInt().pipe(z.number().min(1).max(20)).default(5),
  group: z.string().regex(/^(\d{1,9}|none)$/).optional(),
  focus: z.enum(FOCI).default('balanced'),
  anyway: pyBool().default(false),
});

export const routes: Route[] = [
  // Recipes that fit the rest of the day, best first, each with the best amount and one or two reasons.
  route('GET', '/api/v1/recipes/suggestions', async (req): Promise<Suggestions> => {
    const q = parse(query, queryObject(req.query), 'query');
    const iso = q.date ? parseDay(q.date) : today();
    const { db, user } = { db: req.ctx.db, user: req.user! };
    const uid = user.id;
    const goal = await goalOn(db, uid, iso); // the goal of that day (a past day keeps its own)
    const eaten = total((await entriesOn(db, uid, iso)).map((r) => scale(r.per_100, r.amount)));
    let goalKcal: number | null = null;
    if (goal) {
      const bonus = (await dayActivities(db, uid, iso, iso, goal))[iso].bonus_kcal;
      goalKcal = activity.dayGoalKcal(goal.kcal, { [iso]: bonus }, iso);
    }
    const left = restOf(goal, goalKcal, eaten);
    const candidates: suggest.Candidate[] = [];
    const byId = new Set<number>();
    for (const row of await recipeFoods(db, q.group ?? null)) {
      const per = row.data.per_100 ?? {};
      if (per.kcal === null || per.kcal === undefined) continue;
      const portion = row.data.serving_quantity || 100.0;
      const values = scale(per, portion);
      candidates.push({ food_id: row.id, kcal: values.kcal, protein: values.protein, carbs: values.carbs, fat: values.fat, portion_amount: portion });
      byId.add(row.id);
    }
    const ago = new Map<number, number | null>();
    for (const [fid, d] of await lastEaten(db, uid, iso)) if (byId.has(fid)) ago.set(fid, daysBetween(d, iso));
    const result = suggest.rank(left, candidates, ago, q.focus as Focus, q.limit, q.anyway);
    const items = [];
    for (const s of result.items) {
      items.push({
        food: buildFood(req.ctx, (await getFood(db, s.food_id))! as any, user), portions: s.portions, amount: s.amount, kcal: s.kcal,
        protein: s.protein, carbs: s.carbs, fat: s.fat, after: { ...s.after } as RestOut, reasons: s.reasons, score: s.score,
      });
    }
    return { day: iso, state: result.state as Suggestions['state'], focus: q.focus, goal_kcal: goalKcal, rest: { ...left }, candidates: candidates.length, items };
  }),
];

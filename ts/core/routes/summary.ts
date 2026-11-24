// A compact read-only summary for home automation (routes/summary.py); an access token with scope `read` is enough.
import * as activity from '../activity.ts';
import { dayActivities } from '../activityViews.ts';
import { today } from '../dates.ts';
import { route, type Route } from '../http.ts';
import { dayDrinksMl } from '../hydration.ts';
import { MEALS } from '../models/common.ts';
import { r1, scale, total } from '../nutrition.ts';
import { roundHalfEven } from '../num.ts';
import { lastEntryAt } from '../store/badges.ts';
import { entriesOn } from '../store/diary.ts';
import { currentFast } from '../store/fasting.ts';
import { DEFAULT_WATER_GOAL, goalOn } from '../store/goals.ts';
import { getSettings } from '../store/settings.ts';
import { getWater } from '../store/water.ts';
import { latestWeight } from '../store/weights.ts';

export const routes: Route[] = [
  route('GET', '/api/v1/summary/today', async (req) => {
    const { db } = req.ctx;
    const uid = req.user!.id;
    const day = today();
    const rows = await entriesOn(db, uid, day);
    const kcalOf = (list: typeof rows) => total(list.map((r) => scale(r.per_100, r.amount)));
    const sums = kcalOf(rows);
    const byMeal = Object.fromEntries(MEALS.map((m) => [m, rows.filter((r) => r.meal === m)]));
    const goal = await goalOn(db, uid, day);
    const todayActivity = (await dayActivities(db, uid, day, day, goal))[day];
    const kcalGoal = goal ? roundHalfEven(activity.dayGoalKcal(goal.kcal, { [day]: todayActivity.bonus_kcal }, day)!) : null;
    const weight = await latestWeight(db, uid);
    const current = await currentFast(db, uid);
    const fasting = (await getSettings(db, uid)).fasting ?? {};
    let fast = null;
    if (current) fast = { active: true, elapsed_seconds: Math.max(0, Math.floor(Date.now() / 1000) - current.started_at), target_hours: current.target_hours };
    else if (fasting.enabled) fast = { active: false, elapsed_seconds: 0, target_hours: fasting.target_hours ?? 16 };
    return {
      day,
      kcal_eaten: r1(sums.kcal),
      kcal_goal: kcalGoal,
      kcal_left: goal ? r1(kcalGoal! - sums.kcal) : null,
      kcal_goal_bonus: todayActivity.bonus_kcal,
      steps: todayActivity.steps,
      steps_goal: todayActivity.steps_goal,
      active_kcal: todayActivity.active_kcal,
      workouts: todayActivity.workouts.length,
      protein: r1(sums.protein),
      carbs: r1(sums.carbs),
      fat: r1(sums.fat),
      water_ml: await getWater(db, uid, day),
      water_goal_ml: goal?.water_ml ?? DEFAULT_WATER_GOAL,
      water_drinks_ml: await dayDrinksMl(db, uid, day),
      weight_kg: weight ? weight.kg : null,
      weight_day: weight ? weight.day : null,
      body_fat_pct: weight ? weight.body_fat_pct : null,
      lean_kg: weight ? weight.lean_kg : null,
      fasting: fast,
      logged_today: rows.length > 0,
      meals: Object.fromEntries(MEALS.map((m) => [m, r1(kcalOf(byMeal[m]).kcal)])),
      meal_entries: Object.fromEntries(MEALS.map((m) => [m, byMeal[m].length])),
      last_entry_at: await lastEntryAt(db, uid),
    };
  }),
];

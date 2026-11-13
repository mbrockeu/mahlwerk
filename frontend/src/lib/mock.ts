// In-memory implementation of docs/api-v1.md for developing without the backend.
// Only bundled when built with VITE_MOCK=1. Add ?mock=nogoal to the URL to start without a goal.
import { imageRegistry } from './foodImage';
import { plate } from './mockImages';
import { ApiError, DEMO_BLOCKED } from './api';
import { lang } from './i18n';
import { fromDay, isoWeek, mondayOfWeek, shiftDay, today, weekStart } from './date';
import { addDays, autoGran, diffDays } from './insightsRange';
import { recipePreview } from './nutrition';
import { buildCookidoo } from './mockCookidoo';
import { buildWebPages, interpretWeb, normaliseWeb, NO_RECIPE } from './mockWeb';
import { rank as rankSuggestions } from './mockSuggest';
import { mockMatch } from './mockIngredients';
import type { DemoAccountState, ActivitySource, DayActivity, Workout, WorkoutIn, WorkoutKind, AccessToken, BadgeCode, Badges, Connector, RefreshState, Webhook, WebhookDelivery, WebhookIn, CatalogItem, Day, Entry, Extra, Food, FoodIn, Goal, ImportBatch, InsightFood, InsightDay, InsightMicro, Insights, NutrientCurve, Section, FoodStat, Meal, NutrientInfo, Per100, Recipe, RecipeGroup, RecipeIn, Review, SuggestFocus, Template, TopMetric } from './types';

// the made-up foods follow the language of the interface: L(German, English)
const L = (de: string, en: string) => (lang === 'en' ? en : de);

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function gtin(base: string): string {
  const digits = [...base].map(Number).reverse();
  const sum = digits.reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
}

const per = (kcal: number, fat: number, sat: number, carbs: number, sugars: number, fiber: number, protein: number, salt: number): Per100 =>
  ({ kcal, fat, saturated_fat: sat, carbs, sugars, fiber, protein, salt });

// the directory of additional nutrients (a copy of src/mahlwerk/nutrients.py: key, group, unit, NRV)
const N = (key: string, group: NutrientInfo['group'], unit: NutrientInfo['unit'], nrv: number | null): NutrientInfo => ({ key, group, unit, nrv });
const NUTRIENTS: NutrientInfo[] = [
  N('monounsaturated_fat', 'fat', 'g', null), N('polyunsaturated_fat', 'fat', 'g', null), N('trans_fat', 'fat', 'g', null),
  N('cholesterol', 'fat', 'mg', null), N('omega_3', 'fat', 'g', null), N('added_sugars', 'carb', 'g', null), N('starch', 'carb', 'g', null),
  N('alcohol', 'other', 'g', null), N('water', 'other', 'g', null), N('sodium', 'other', 'mg', null), N('caffeine', 'other', 'mg', null),
  N('calcium', 'mineral', 'mg', 800), N('iron', 'mineral', 'mg', 14), N('potassium', 'mineral', 'mg', 2000), N('magnesium', 'mineral', 'mg', 375),
  N('zinc', 'mineral', 'mg', 10), N('phosphorus', 'mineral', 'mg', 700), N('iodine', 'mineral', 'µg', 150), N('copper', 'mineral', 'mg', 1),
  N('manganese', 'mineral', 'mg', 2), N('selenium', 'mineral', 'µg', 55), N('chloride', 'mineral', 'mg', 800), N('fluoride', 'mineral', 'mg', 3.5),
  N('chromium', 'mineral', 'µg', 40), N('molybdenum', 'mineral', 'µg', 50),
  N('vitamin_a', 'vitamin', 'µg', 800), N('vitamin_b1', 'vitamin', 'mg', 1.1), N('vitamin_b2', 'vitamin', 'mg', 1.4), N('vitamin_b3', 'vitamin', 'mg', 16),
  N('vitamin_b5', 'vitamin', 'mg', 6), N('vitamin_b6', 'vitamin', 'mg', 1.4), N('vitamin_b7', 'vitamin', 'µg', 50), N('vitamin_b9', 'vitamin', 'µg', 200),
  N('vitamin_b12', 'vitamin', 'µg', 2.5), N('vitamin_c', 'vitamin', 'mg', 80), N('vitamin_d', 'vitamin', 'µg', 5), N('vitamin_e', 'vitamin', 'mg', 12),
  N('vitamin_k', 'vitamin', 'µg', 75),
];

let nextFoodId = 1;
const foods: Food[] = [];
function addFood(name: string, brand: string | null, p: Per100, extra: Partial<Food> = {}): Food {
  const food: Food = {
    id: nextFoodId++, code: null, source: 'own', recipe_id: null, name, brand, quantity: null, serving_size: null, serving_quantity: null,
    unit: 'g', per_100: p, extra: {}, complete: true, empty: false, cached: true, stale: false, fetched_at: Date.now() / 1000, ...extra,
  };
  foods.unshift(food);
  return food;
}
// stand-in pictures (drawn plates, see mockImages.ts): the hash is only a key into the registry
let nextPlate = 1;
function givePicture(food: Food, origin: 'own' | 'cookidoo' | 'web', credit: string | null, seed = nextPlate++): Food {
  const hash = `mock${String(seed).padStart(12, '0')}`;
  imageRegistry[hash] = plate(seed);
  food.image = { hash, origin, credit };
  return food;
}
const oats = addFood(L('Haferflocken zart', 'Rolled oats'), 'Kornika', per(372, 7, 1.3, 59, 1.1, 10, 13.5, 0.02), { code: gtin('400100000010'), source: 'openfoodfacts', quantity: '500 g', serving_size: '40 g', serving_quantity: 40 });
const banana = addFood(L('Banane', 'Banana'), null, per(89, 0.3, 0.1, 20, 12, 2, 1.1, 0), { serving_size: '120 g', serving_quantity: 120 });
const milk = addFood(L('Vollmilch 3,5 %', 'Whole milk 3.5 %'), 'Almora', per(64, 3.6, 2.3, 4.8, 4.8, 0, 3.3, 0.1), { code: gtin('400100000027'), source: 'openfoodfacts', unit: 'ml', quantity: '1 l', serving_size: '200 ml', serving_quantity: 200 });
const pasta = addFood(L('Spaghetti', 'Spaghetti'), 'Pastello', per(352, 1.5, 0.3, 71, 3.5, 3, 12.5, 0.01), { code: gtin('400100000034'), source: 'openfoodfacts', quantity: '500 g', serving_size: '80 g', serving_quantity: 80 });
const sauce = addFood(L('Tomatensoße Basilikum', 'Tomato sauce with basil'), 'Rossetta', per(45, 1.5, 0.2, 6, 5, 1.2, 1.4, 0.8), { code: gtin('400100000041'), source: 'openfoodfacts', quantity: '400 g' });
const nuts = addFood(L('Nussmischung', 'Mixed nuts'), 'Nussara', per(610, 52, 7, 12, 7, 7, 22, 0.01), { quantity: '200 g', serving_size: '30 g', serving_quantity: 30 });
const skyr = addFood(L('Skyr natur', 'Plain skyr'), 'Nordika', per(63, 0.2, 0.1, 4, 3.7, 0, 11, 0.1), { code: gtin('400100000058'), source: 'openfoodfacts', quantity: '450 g', serving_size: '150 g', serving_quantity: 150 });
// two Cookidoo recipes that were taken over before (invented; the third one, r100001, can be taken over in the demo). A portion is booked as 100 g.
const cookidooFood = (id: string, name: string, portions: number, p: Per100) => addFood(name, 'Cookidoo', p, {
  source: 'cookidoo', serving_size: '1 portion', serving_quantity: 100, external_id: `cookidoo:${id}`, portions, url: `https://cookidoo.de/recipes/recipe/de-DE/${id}`,
});
const pumpkinSoup = cookidooFood('r100002', L('Kürbissuppe', 'Pumpkin soup'), 4, per(180, 9, 3, 18, 0, 4, 4, 1.6));
if (new URLSearchParams(location.search).get('mock') !== 'nopics') givePicture(pumpkinSoup, 'cookidoo', 'Cookidoo', 2);
cookidooFood('r100003', L('Apfelkuchen vom Blech', 'Apple sheet cake'), 16, per(265, 11, 6, 36, 0, 2, 4, 0.2));
// ?mock=many: a long list (130 more recipes taken over from Cookidoo) for the paging of the recipes page
if (new URLSearchParams(location.search).get('mock') === 'many') {
  const words = ['Linsen', 'Kürbis', 'Kartoffel', 'Hähnchen', 'Lachs', 'Spinat', 'Tomaten', 'Pilz', 'Reis', 'Quark', 'Bohnen', 'Karotten', 'Paprika', 'Couscous'];
  const kinds = ['Suppe', 'Pfanne', 'Auflauf', 'Salat', 'Eintopf', 'Curry', 'Bowl', 'Ragout', 'Gratin'];
  for (let i = 0; i < 130; i++) cookidooFood(`r2${String(i).padStart(5, '0')}`, `${words[i % words.length]}-${kinds[(i * 5) % kinds.length]} ${i + 1}`, 2 + (i % 4), per(120 + (i * 7) % 300, 6, 2, 20, 3, 3, 5, 0.8));
}
// one recipe that was taken over from a web page before (an invented host: nothing is ever fetched); a portion is booked as 100 g
const WEB_PAGES = buildWebPages(L);
const webFood = (key: string, page: { name: string; portions: number | null }, p: Per100) => addFood(page.name, `Web \u00b7 ${key.split('/')[0]}`, p, {
  source: 'web', serving_size: '1 portion', serving_quantity: 100, external_id: `web:${key}`, portions: page.portions, url: `https://${key}`,
});
{ const key = 'recipes.example.org/shakshuka-vom-blech'; const page = WEB_PAGES[key]; const f = webFood(key, page, per(page.values!.kcal!, page.values!.fat!, page.values!.saturated_fat!, page.values!.carbs!, page.values!.sugars!, page.values!.fiber!, page.values!.protein!, page.values!.salt!)); if (new URLSearchParams(location.search).get('mock') !== 'nopics') givePicture(f, 'web', key.split('/')[0], 3); }
oats.extra = { magnesium: 129, iron: 4.3, zinc: 4.3, potassium: 370, vitamin_b1: 0.5 };
banana.extra = { potassium: 360, magnesium: 27, vitamin_c: 9, vitamin_b6: 0.37 };
milk.extra = { calcium: 120, vitamin_b2: 0.18, vitamin_b12: 0.4, iodine: 10 };
nuts.extra = { magnesium: 170, vitamin_e: 10, zinc: 3, potassium: 700 };
sauce.extra = { vitamin_c: 14, potassium: 300, magnesium: 12, vitamin_a: 60, vitamin_k: 6 }; // several nutrients with different coverage for the comparison
skyr.extra = { calcium: 120, iodine: 12, vitamin_b12: 0.5, potassium: 150 };
const soda = addFood(L('Zitronen-Brause', 'Lemon soda'), null, per(42, 0, 0, 10.6, 10.6, 0, 0, 0), { unit: 'ml', serving_size: '330 ml', serving_quantity: 330 });
addFood(L('Haselnuss-Schokocreme', 'Hazelnut chocolate spread'), 'Haselina', per(539, 31, 10.6, 57.5, 56.3, 3.4, 6.3, 0.1), { code: gtin('400100000065'), source: 'openfoodfacts', quantity: '450 g', serving_size: '15 g', serving_quantity: 15 });

// a few packaged products that are not stored yet, standing in for the local catalogue
const catalogProduct = (code: string, name: string, brand: string | null, quantity: string | null, p: Per100, unit: 'g' | 'ml' = 'g', serving: number | null = null): CatalogItem =>
  ({ source: 'openfoodfacts', code: gtin(code), name, brand, quantity, serving_size: serving ? `${serving} ${unit}` : null, serving_quantity: serving, unit, per_100: p, extra: {}, complete: true });
const catalog: CatalogItem[] = [
  catalogProduct('400200000011', L('Apfel', 'Apple'), null, '1 kg', per(52, 0.2, 0, 11, 10, 2, 0.3, 0), 'g', 150),
  catalogProduct('400200000028', L('Apfelmus ohne Zuckerzusatz', 'Unsweetened apple sauce'), 'Wiesetta', '360 g', per(42, 0.1, 0, 9.5, 9, 1, 0.2, 0)),
  catalogProduct('400200000035', L('Apfelschorle Holunder Bio 6x1,5 l', 'Organic apple elderflower spritzer 6x1.5 l'), 'Quellora', L('6x1,5 l', '6x1.5 l'), per(21, 0, 0, 5, 5, 0, 0, 0), 'ml', 250),
  catalogProduct('400200000042', L('Haferflocken Kernig', 'Hearty rolled oats'), 'Feldora', '500 g', per(372, 7, 1.3, 59, 1.1, 10, 13.5, 0.02), 'g', 40),
  catalogProduct('400200000059', L('Haferdrink Barista', 'Barista oat drink'), 'Haferly', '1 l', per(59, 3, 0.3, 6.7, 3.9, 0.8, 1, 0.1), 'ml', 200),
];
// basic foods (BLS) standing in for the second catalogue file; the values are rounded examples
const basicFood = (code: string, name: string, name_en: string, p: Per100, extra: Extra = {}): CatalogItem =>
  ({ source: 'bls', code, name, name_en, brand: null, quantity: null, serving_size: null, serving_quantity: null, unit: 'g', per_100: p, extra, complete: true });
const basics: CatalogItem[] = [
  basicFood('F110100', 'Apfel roh', 'Apple raw', per(58, 0.5, 0.1, 12.4, 11.4, 2, 0.4, 0.01), { vitamin_c: 12, potassium: 120, vitamin_e: 0.5 }),
  basicFood('F110400', 'Apfel getrocknet', 'Apple dried', per(242, 1.1, 0.2, 52, 49, 10, 1.6, 0.02), { vitamin_c: 3, potassium: 570 }),
  basicFood('K110132', 'Kartoffel geschält, gekocht', 'Potato peeled, boiled', per(76, 0.1, 0, 16.7, 0.8, 1.7, 2, 0.01), { vitamin_c: 11, potassium: 400 }),
  basicFood('B101000', 'Vollkornbrot', 'Wholemeal bread', per(210, 1.2, 0.2, 38, 2.5, 7.5, 7.5, 1.2), { magnesium: 70, vitamin_b1: 0.2 }),
  basicFood('F503100', 'Banane roh', 'Banana raw', per(79, 0.2, 0.1, 17.4, 16, 1.8, 1.1, 0), { vitamin_c: 11, potassium: 370, magnesium: 30 }),
  basicFood('C101100', 'Weizenmehl Type 405', 'Wheat flour type 405', per(343, 1, 0.2, 70, 0.8, 3.2, 10.6, 0.01), { magnesium: 22 }),
  basicFood('Q110200', 'Olivenöl', 'Olive oil', per(824, 91.6, 14, 0, 0, 0, 0, 0)),
  basicFood('G101100', 'Zwiebel roh', 'Onion raw', per(28, 0.3, 0, 4.9, 4.2, 1.8, 1.2, 0.01), { vitamin_c: 7, potassium: 160 }),
  basicFood('H101100', 'Hühnerei Vollei roh', 'Hen egg whole raw', per(137, 9.3, 2.9, 0.4, 0.4, 0, 12.4, 0.35), { vitamin_d: 2.9 }),
  basicFood('G300100', 'Petersilie roh', 'Parsley raw', per(53, 0.9, 0.2, 5.4, 0.9, 4.9, 4.4, 0.1), { vitamin_c: 160, potassium: 810 }),
  basicFood('Q500100', 'Speisesalz', 'Table salt', per(0, 0, 0, 0, 0, 0, 0, 99.8)),
  basicFood('G200100', 'Karotte roh', 'Carrot raw', per(27, 0.2, 0, 4.8, 4.8, 3.6, 0.8, 0.1), { vitamin_c: 5, potassium: 250 }),
];
const adoptedBasics = new Map<string, number>();
let catalogUpdatedAt = Math.floor(Date.now() / 1000) - 3 * 86400;

let goal: Goal | null = new URLSearchParams(location.search).get('mock') === 'nogoal' ? null : { kcal: 2100, protein: 120, carbs: 230, fat: 70, water_ml: 2000, steps: 8000 };

let nextEntryId = 1;
const entries = new Map<string, Entry[]>();

function makeEntry(food: Food, meal: Meal, amount: number): Entry {
  const k = amount / 100;
  const n = (v: number | null) => (v == null ? null : Math.round(v * k * 10) / 10);
  return {
    id: nextEntryId++, food_id: food.id, meal, name: food.name, brand: food.brand, amount, unit: food.unit,
    kcal: n(food.per_100.kcal), protein: n(food.per_100.protein), carbs: n(food.per_100.carbs), fat: n(food.per_100.fat),
  };
}
const put = (day: string, food: Food, meal: Meal, amount: number) => {
  const list = entries.get(day) ?? [];
  list.push(makeEntry(food, meal, amount));
  entries.set(day, list);
};

const t0 = today();
put(t0, oats, 'breakfast', 60); put(t0, banana, 'breakfast', 100); put(t0, milk, 'breakfast', 150);
put(t0, pasta, 'lunch', 150); put(t0, sauce, 'lunch', 300);
put(t0, nuts, 'snack', 40); put(t0, soda, 'snack', 330);
const plan: [Food, Meal, number][] = [[oats, 'breakfast', 70], [skyr, 'breakfast', 150], [pasta, 'lunch', 120], [sauce, 'lunch', 200], [nuts, 'snack', 30], [banana, 'dinner', 120], [milk, 'dinner', 250]];
const boost = new URLSearchParams(location.search).get('mock') === 'history' ? 1.55 : 1; // see ?mock=history below
for (let back = 1; back <= 12; back += 1) {
  if (back === 7 || back === 9) continue;
  for (const [i, [f, m, a]] of plan.entries()) if ((i + back) % 4 !== 0 || i < 3) put(shiftDay(t0, -back), f, m, Math.round(a * boost * (0.8 + ((back * 7 + i * 3) % 9) / 15)));
}
// a Cookidoo recipe eaten on a few days (amounts are portions: 100 g = 1 portion)
put(shiftDay(t0, -2), pumpkinSoup, 'dinner', 100); put(shiftDay(t0, -5), pumpkinSoup, 'dinner', 150); put(shiftDay(t0, -10), pumpkinSoup, 'lunch', 50);
// one day well over the goal
put(shiftDay(t0, -3), nuts, 'snack', 180);
// ?mock=history: a year of older days with gaps and all kinds of days (below, within, above the goal) for the calendar screenshots
if (new URLSearchParams(location.search).get('mock') === 'history') {
  for (let back = 13; back <= 430; back += 1) {
    const h = (back * 37 + 11) % 23;
    if (h < 4 || (back > 100 && back < 109) || back % 29 === 0) continue;
    const k = [0.9, 1.3, 1.6, 1.7, 1.95, 1.45, 2.2, 1.55][h % 8];
    for (const [i, [f, m, a]] of plan.entries()) if ((i + back) % 4 !== 0 || i < 3) put(shiftDay(t0, -back), f, m, Math.round(a * k));
  }
}

const weights = new Map<string, number>();
{
  let kg = 82.4;
  for (let back = 89; back >= 0; back -= 1) {
    if (back % 3 === 1 || back % 7 === 4) continue;
    kg += Math.sin(back * 1.7) * 0.25 - 0.018;
    weights.set(shiftDay(t0, -back), Math.round(kg * 10) / 10);
  }
}
if (new URLSearchParams(location.search).get('mock') === 'noweight') weights.clear(); // empty state of the weight tile

// demo data: remembers what it created so DELETE removes exactly that
const demoEntryIds = new Set<number>();
const demoWeightDays = new Set<string>();
const demoWaterDays = new Set<string>();
// water per day in ml; fasting: finished fasts and the open one (Unix seconds)
const water = new Map<string, number>();
for (let back = 1; back <= 12; back += 1) if (back % 5 !== 0) { water.set(shiftDay(today(), -back), 1250 + ((back * 5) % 6) * 250); }
const fastSettings = { enabled: false, target_hours: 16 };

// activity: one row per day, workouts, and the setting that adds the active energy to the calorie goal
const MET: Record<WorkoutKind, number> = {
  walking: 3.5, running: 9.8, cycling: 7.5, hiking: 6, swimming: 6, strength: 5, yoga: 2.5, pilates: 3, crosstrainer: 5, stairs: 8.8,
  circuit: 8, squash: 7.3, bowling: 3, dancing: 5, football: 7, tennis: 7.3, skiing: 7, rowing: 7, other: 4,
};
interface ActivityRow { steps: number | null; active_kcal: number | null; distance_m: number | null; source: ActivitySource }
const activity = new Map<string, ActivityRow>();
const workoutRows: (Omit<Workout, 'kcal' | 'kcal_estimated'> & { kcal: number | null })[] = [];
let nextWorkoutId = 1;
const demoActivityDays = new Set<string>();
const demoWorkoutIds = new Set<number>();
const activitySettings = { add_to_goal: false };
for (let back = 0; back <= 9; back += 1) {
  const d = shiftDay(today(), -back);
  const steps = back === 0 ? 3140 : 5200 + ((back * 1531) % 6200);
  activity.set(d, { steps, active_kcal: Math.round(steps * 0.042 + (back % 3 === 1 ? 260 : 60)), distance_m: Math.round(steps * 0.74), source: back % 4 === 3 ? 'health' : 'manual' });
  if (back % 3 === 1) {
    workoutRows.push({ id: nextWorkoutId++, day: d, started_at: Math.floor(new Date(`${d}T18:00:00`).getTime() / 1000), kind: back === 4 ? 'cycling' : 'running', name: '', minutes: back === 4 ? 70 : 32, kcal: back === 4 ? null : 318, distance_m: back === 4 ? 21000 : 5400, steps: null, note: null, source: 'manual' });
  }
}
const weightFor = (d: string) => { const w = [...weights.keys()].filter((k) => k <= d).sort().pop(); return w ? (weights.get(w) as number) : 75; };
const workoutOut = (w: (typeof workoutRows)[number]): Workout => {
  const estimated = w.kcal == null;
  return { ...w, kcal: Math.round(estimated ? MET[w.kind] * weightFor(w.day) * (w.minutes / 60) : (w.kcal as number)), kcal_estimated: estimated };
};
const bonusOf = (d: string) => (activitySettings.add_to_goal ? Math.round(activity.get(d)?.active_kcal ?? 0) : 0);
const goalFor = (d: string, kcal: number) => kcal + bonusOf(d);
function dayActivity(d: string): DayActivity {
  const a = activity.get(d);
  return {
    steps: a?.steps ?? null, steps_goal: goal?.steps ?? 8000, active_kcal: a?.active_kcal ?? null, distance_m: a?.distance_m ?? null,
    source: a?.source ?? null, bonus_kcal: bonusOf(d), workouts: workoutRows.filter((w) => w.day === d).sort((x, y) => (x.started_at ?? 0) - (y.started_at ?? 0)).map(workoutOut),
  };
}
let nextFastId = 1;
const fasts: { id: number; started_at: number; ended_at: number | null; target_hours: number }[] = [];
function createDemo(days: number) {
  let nEntries = 0;
  let nWeights = 0;
  let nWater = 0;
  let nActivity = 0;
  let nWorkouts = 0;
  const gentle = [oats, banana, milk, pasta, sauce, nuts, skyr];
  for (let back = days - 1; back >= 0; back -= 1) {
    const d = shiftDay(t0, -back);
    if ((entries.get(d) ?? []).length === 0 && back % 12 !== 5) {
      const picks: [Food, Meal, number][] = [[gentle[back % 7], 'breakfast', 60 + (back % 4) * 20], [gentle[(back + 3) % 7], 'lunch', 150 + (back % 3) * 40]];
      if (back > 0) picks.push([gentle[(back + 5) % 7], 'dinner', 120], [nuts, 'snack', 30]);
      for (const [f, m, a] of picks) { put(d, f, m, a); demoEntryIds.add(nextEntryId - 1); nEntries += 1; }
    }
    if (!water.has(d)) { water.set(d, back === 0 ? 500 : 1250 + ((back * 3) % 7) * 250); demoWaterDays.add(d); nWater += 1; }
    if (!activity.has(d)) {
      const steps = back === 0 ? 2100 : 6000 + ((back * 977) % 7000);
      activity.set(d, { steps, active_kcal: Math.round(steps * 0.04 + 70), distance_m: Math.round(steps * 0.74), source: 'demo' });
      demoActivityDays.add(d);
      nActivity += 1;
      if (back > 0 && back % 3 === 0) {
        workoutRows.push({ id: nextWorkoutId++, day: d, started_at: null, kind: 'walking', name: '', minutes: 45, kcal: null, distance_m: null, steps: null, note: null, source: 'demo' });
        demoWorkoutIds.add(nextWorkoutId - 1);
        nWorkouts += 1;
      }
    }
    if (!weights.has(d) && back % 7 < 5) { weights.set(d, Math.round((78 + back * 0.03) * 10) / 10); demoWeightDays.add(d); nWeights += 1; }
  }
  const goalSet = goal === null;
  if (goalSet) goal = { kcal: 2100, protein: 120, carbs: 230, fat: 70, water_ml: 2000, steps: 8000 };
  return { entries: nEntries, weights: nWeights, water: nWater, activity: nActivity, workouts: nWorkouts, foods: 0, goal_set: goalSet };
}
function deleteDemo() {
  let nEntries = 0;
  for (const es of entries.values()) for (let i = es.length - 1; i >= 0; i -= 1) if (demoEntryIds.delete(es[i].id)) { es.splice(i, 1); nEntries += 1; }
  const nWeights = demoWeightDays.size;
  for (const d of demoWeightDays) weights.delete(d);
  demoWeightDays.clear();
  const nWater = demoWaterDays.size;
  for (const d of demoWaterDays) water.delete(d);
  demoWaterDays.clear();
  const nActivity = demoActivityDays.size;
  for (const d of demoActivityDays) activity.delete(d);
  demoActivityDays.clear();
  const nWorkouts = demoWorkoutIds.size;
  for (let i = workoutRows.length - 1; i >= 0; i -= 1) if (demoWorkoutIds.has(workoutRows[i].id)) workoutRows.splice(i, 1);
  demoWorkoutIds.clear();
  return { entries: nEntries, weights: nWeights, water: nWater, activity: nActivity, workouts: nWorkouts, foods: 0 };
}

// an import batch to look at (remove it to see the section disappear); it owns no rows in the mock
const importBatches: ImportBatch[] = [{
  id: 1, kind: 'yazio', created_at: Math.floor(Date.now() / 1000) - 5 * 86400,
  counts: { days: 412, entries: 3640, product_entries: 3100, recipe_entries: 340, quick_entries: 200, foods: 520, weights: 180, water: 390, goal_set: false },
}];

const num = (v: number | null | undefined) => v ?? 0;

// additional nutrients of a list of entries (food looked up by id, like the server's copy): amount and coverage by energy
function microTotals(list: Entry[]): Record<string, { amount: number; coverage: number }> {
  const kcalAll = list.reduce((s, e) => s + num(e.kcal), 0);
  const out: Record<string, { amount: number; coverage: number }> = {};
  for (const e of list) {
    const extra = foods.find((f) => f.id === e.food_id)?.extra ?? {};
    for (const [key, v] of Object.entries(extra)) {
      const o = (out[key] ??= { amount: 0, coverage: 0 });
      o.amount += (v * e.amount) / 100;
      o.coverage += kcalAll > 0 ? num(e.kcal) / kcalAll : 1 / list.length;
    }
  }
  for (const o of Object.values(out)) { o.amount = Math.round(o.amount * 1000) / 1000; o.coverage = Math.min(1, Math.round(o.coverage * 1000) / 1000); }
  return out;
}
function dayView(day: string): Day {
  const list = entries.get(day) ?? [];
  const meals = {} as Day['meals'];
  for (const m of ['breakfast', 'lunch', 'dinner', 'snack'] as Meal[]) {
    const es = list.filter((e) => e.meal === m);
    meals[m] = { kcal: es.reduce((s, e) => s + num(e.kcal), 0), entries: es };
  }
  const sum = (k: 'kcal' | 'protein' | 'carbs' | 'fat') => list.reduce((s, e) => s + num(e[k]), 0);
  let streak = 0;
  for (let d = day; (entries.get(d) ?? []).length; d = shiftDay(d, -1)) streak += 1;
  const yesterday: Day['yesterday'] = {};
  for (const m of ['breakfast', 'lunch', 'dinner', 'snack'] as Meal[]) {
    const es = (entries.get(shiftDay(day, -1)) ?? []).filter((e) => e.meal === m);
    if (es.length) yesterday[m] = { kcal: Math.round(es.reduce((s, e) => s + num(e.kcal), 0) * 10) / 10, names: es.map((e) => e.name ?? '?') };
  }
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = shiftDay(day, i - 6);
    const es = entries.get(d) ?? [];
    return { day: d, logged: es.length > 0, kcal: es.reduce((s, e) => s + num(e.kcal), 0) };
  });
  return {
    day, goal: clone(goal), kcal_goal: goal ? goalFor(day, goal.kcal) : null, activity: dayActivity(day),
    water: { ml: water.get(day) ?? 0, goal_ml: goal?.water_ml ?? 2000 },
    totals: { kcal: sum('kcal'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat'), saturated_fat: 0, sugars: 0, fiber: 0, salt: 0 },
    extra_totals: microTotals(list), meals, streak, week, yesterday,
  };
}

function toFood(body: FoodIn, base?: Food): Food {
  const serving = body.serving_size ? Number(/^\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i.exec(body.serving_size)?.[1]?.replace(',', '.')) : NaN;
  const empty: Per100 = per(0, 0, 0, 0, 0, 0, 0, 0);
  const p = { ...(base?.per_100 ?? (Object.fromEntries(Object.keys(empty).map((k) => [k, null])) as unknown as Per100)), ...body.per_100 };
  return {
    id: base?.id ?? nextFoodId++, code: base?.code ?? null, source: 'own', recipe_id: null, name: body.name, brand: body.brand ?? null,
    quantity: body.quantity ?? null, serving_size: body.serving_size ?? null, serving_quantity: Number.isFinite(serving) ? serving : null,
    unit: body.unit ?? 'g', per_100: p, extra: body.extra ?? {}, complete: [p.kcal, p.fat, p.carbs, p.protein].every((v) => v != null), empty: false,
    cached: true, stale: false, fetched_at: Date.now() / 1000,
  };
}

const lastOf = (foodId: number) => {
  const all = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [, es] of all) for (const e of [...es].reverse()) if (e.food_id === foodId) return e;
  return null;
};


// templates (per user) and recipes (shared), kept as snapshots like the server does
let nextTemplateId = 1;
const templates: { id: number; name: string; items: Entry[] }[] = [];
const templateOut = (tpl: (typeof templates)[number]): Template => ({
  id: tpl.id, name: tpl.name, kcal: Math.round(tpl.items.reduce((s, e) => s + num(e.kcal), 0) * 10) / 10,
  items: tpl.items.map((e) => ({ name: e.name ?? '?', brand: e.brand, amount: e.amount, unit: e.unit, kcal: e.kcal })),
});
const addCopies = (day: string, source: Entry[], meal?: Meal): Entry[] => {
  const list = entries.get(day) ?? [];
  const made = source.map((e) => ({ ...clone(e), id: nextEntryId++, meal: meal ?? e.meal }));
  list.push(...made);
  entries.set(day, list);
  return made;
};

let nextRecipeId = 1;
const recipes: { id: number; food: Food; portions: number; total_weight: number | null; items: { food_id: number; amount: number }[] }[] = [];
function recipeCalc(body: RecipeIn, food?: Food): Food {
  const used = body.items.map((i) => ({ food: foods.find((f) => f.id === i.food_id), amount: i.amount }));
  if (used.some((u) => !u.food)) throw new ApiError(422, 'unknown food');
  if (used.some((u) => u.food?.source === 'recipe')) throw new ApiError(422, 'a recipe cannot be an ingredient of a recipe');
  const calc = recipePreview(used.map((u) => ({ per_100: (u.food as Food).per_100, amount: u.amount })), body.portions, body.total_weight ?? null);
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  const per_100 = { ...per(0, 0, 0, 0, 0, 0, 0, 0), kcal: round(calc.per100.kcal), protein: round(calc.per100.protein), carbs: round(calc.per100.carbs), fat: round(calc.per100.fat), saturated_fat: null, sugars: null, fiber: null, salt: null } as Per100;
  const serving = Math.round((calc.serving ?? 0) * 100) / 100;
  return {
    id: food?.id ?? nextFoodId++, code: null, source: 'recipe', recipe_id: 0, name: body.name.trim(), brand: null, quantity: null,
    serving_size: `${serving} g`, serving_quantity: serving, unit: 'g', per_100, extra: {},
    complete: [per_100.kcal, per_100.fat, per_100.carbs, per_100.protein].every((v) => v != null), empty: false, cached: true, stale: false, fetched_at: Date.now() / 1000,
    image: food?.image ?? null,
  };
}
function recipeOut(r: (typeof recipes)[number]): Recipe {
  const items = r.items.map((i) => {
    const f = foods.find((x) => x.id === i.food_id);
    return { food_id: f ? i.food_id : null, name: f?.name ?? '?', brand: f?.brand ?? null, amount: i.amount, unit: f?.unit ?? 'g', kcal: f?.per_100.kcal == null ? null : Math.round(f.per_100.kcal * i.amount) / 100 };
  });
  const known = items.filter((i) => i.kcal != null);
  return {
    id: r.id, food: { ...r.food, recipe_id: r.id }, portions: r.portions, total_weight: r.total_weight, items,
    kcal_per_portion: known.length ? Math.round((known.reduce((s, i) => s + (i.kcal as number), 0) / r.portions) * 10) / 10 : null,
  };
}
// a few household recipes so that the recipe page has something to show (?mock=norecipes starts empty)
if (new URLSearchParams(location.search).get('mock') !== 'norecipes') {
  const seedRecipe = (body: RecipeIn) => {
    const food = recipeCalc(body);
    foods.unshift(food);
    recipes.push({ id: nextRecipeId++, food, portions: body.portions, total_weight: body.total_weight ?? null, items: clone(body.items) });
  };
  seedRecipe({ name: L('Nudeln mit Tomatensoße', 'Pasta with tomato sauce'), portions: 2, total_weight: null, items: [{ food_id: pasta.id, amount: 160 }, { food_id: sauce.id, amount: 300 }] });
  if (new URLSearchParams(location.search).get('mock') !== 'nopics') givePicture(foods[0], 'own', null, 1);
  seedRecipe({ name: L('Haferbrei mit Banane', 'Banana oatmeal'), portions: 1, total_weight: null, items: [{ food_id: oats.id, amount: 60 }, { food_id: milk.id, amount: 200 }, { food_id: banana.id, amount: 100 }] });
  seedRecipe({ name: L('Skyr-Schale mit Nüssen', 'Skyr bowl with nuts'), portions: 2, total_weight: null, items: [{ food_id: skyr.id, amount: 300 }, { food_id: nuts.id, amount: 40 }, { food_id: banana.id, amount: 120 }] });
}

// GET insights: a compact version of the server's evaluation, on the mock diary
function baseInsights(from: string, to: string): Insights {
  const NUT = ['kcal', 'protein', 'carbs', 'fat', 'sugars', 'fiber', 'salt', 'saturated_fat'] as const;
  const dayKeys: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) dayKeys.push(d);
  const foodOf = (e: Entry) => foods.find((f) => f.id === e.food_id) ?? null;
  const totals = new Map<string, Record<(typeof NUT)[number], number>>();
  const mealKcal: Record<Meal, number> = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
  const groups: Record<TopMetric, Map<string, InsightFood>> = { kcal: new Map(), sugars: new Map(), salt: new Map(), protein: new Map() };
  const grand: Record<TopMetric, number> = { kcal: 0, sugars: 0, salt: 0, protein: 0 };
  for (const d of dayKeys) {
    const list = entries.get(d) ?? [];
    if (!list.length) continue;
    const t0 = { kcal: 0, protein: 0, carbs: 0, fat: 0, sugars: 0, fiber: 0, salt: 0, saturated_fat: 0 };
    for (const e of list) {
      const p = foodOf(e)?.per_100;
      const k = e.amount / 100;
      const v = { kcal: num(e.kcal), protein: num(e.protein), carbs: num(e.carbs), fat: num(e.fat), sugars: num(p?.sugars) * k, fiber: num(p?.fiber) * k, salt: num(p?.salt) * k, saturated_fat: num(p?.saturated_fat) * k };
      for (const n of NUT) t0[n] += v[n];
      mealKcal[e.meal] += v.kcal;
      for (const m of ['kcal', 'sugars', 'salt', 'protein'] as TopMetric[]) {
        grand[m] += v[m];
        const key = String(e.food_id ?? e.name);
        const g = groups[m].get(key) ?? { name: e.name ?? '?', brand: e.brand, amount_total: 0, value: 0, share: 0, times: 0 };
        g.amount_total += e.amount; g.value += v[m]; g.times += 1;
        groups[m].set(key, g);
      }
    }
    totals.set(d, t0);
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const loggedDays = dayKeys.filter((d) => totals.has(d));
  const days = dayKeys.map((d) => {
    const t0 = totals.get(d);
    return { day: d, logged: !!t0, ...Object.fromEntries(NUT.map((n) => [n, r1(t0?.[n] ?? 0)])), weight: weights.get(d) ?? null, water_ml: water.get(d) ?? null,
      steps: activity.get(d)?.steps ?? null, active_kcal: activity.get(d)?.active_kcal ?? null,
      workout_minutes: workoutRows.filter((w) => w.day === d).reduce((a, w) => a + w.minutes, 0), goal_kcal: goal ? goalFor(d, goal.kcal) : null } as Insights['days'][number];
  });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const averages = Object.fromEntries(NUT.map((n) => [n, r1(mean(loggedDays.map((d) => totals.get(d)![n])))])) as Insights['averages'];
  averages.water_ml = Math.round(mean(days.filter((d) => d.water_ml != null).map((d) => d.water_ml as number)));
  averages.steps = Math.round(mean(days.filter((d) => d.steps != null).map((d) => d.steps as number)));
  averages.active_kcal = Math.round(mean(days.filter((d) => d.active_kcal != null).map((d) => d.active_kcal as number)));
  averages.workout_minutes = r1(days.reduce((a, d) => a + d.workout_minutes, 0) / Math.max(days.length, 1));
  const by_weekday = Array.from({ length: 7 }, (_, wd) => {
    const xs = loggedDays.filter((d) => (fromDay(d).getDay() + 6) % 7 === wd).map((d) => totals.get(d)![ 'kcal' ]);
    return { weekday: wd, logged_days: xs.length, kcal: r1(mean(xs)) };
  });
  const meals: Meal[] = ['breakfast', 'lunch', 'dinner', 'snack'];
  const mealSum = meals.reduce((s, m) => s + mealKcal[m], 0);
  const by_meal = meals.map((m) => ({ meal: m, kcal: r1(loggedDays.length ? mealKcal[m] / loggedDays.length : 0), share: mealSum ? Math.round((mealKcal[m] / mealSum) * 1000) / 1000 : 0 }));
  const top = (m: TopMetric) => [...groups[m].values()].filter((g) => g.value > 0).sort((a, b) => b.value - a.value).slice(0, 8)
    .map((g) => ({ ...g, amount_total: r1(g.amount_total), value: r1(g.value), share: Math.round((g.value / grand[m]) * 1000) / 1000 }));
  const ws = days.filter((d) => d.weight != null).map((d) => ({ day: d.day, kg: d.weight as number }));
  const weight = ws.length ? {
    first: ws[0].kg, last: ws[ws.length - 1].kg, change: Math.round((ws[ws.length - 1].kg - ws[0].kg) * 100) / 100,
    trend: ws.map((w) => ({ day: w.day, kg: Math.round(mean(ws.filter((o) => Math.abs((fromDay(o.day).getTime() - fromDay(w.day).getTime()) / 86400000) <= 3).map((o) => o.kg)) * 100) / 100 })),
  } : null;
  let adherence: Insights['adherence'] = null;
  if (goal) {
    adherence = { in_range_days: 0, over_days: 0, under_days: 0 };
    for (const d of loggedDays) {
      const k = totals.get(d)!.kcal;
      const gk = goalFor(d, goal.kcal);
      if (k > gk * 1.1) adherence.over_days += 1; else if (k < gk * 0.9) adherence.under_days += 1; else adherence.in_range_days += 1;
    }
  }
  const hints: Insights['hints'] = [];
  if (loggedDays.length < 7) hints.push({ code: 'few_days', params: { logged_days: loggedDays.length, min: 7 } });
  else {
    if (goal && averages.protein < goal.protein * 0.8) hints.push({ code: 'low_protein', params: { avg: Math.round(averages.protein), goal: goal.protein, pct: Math.round((averages.protein / goal.protein) * 100) } });
    if (averages.fiber < 25) hints.push({ code: 'low_fiber', params: { avg: Math.round(averages.fiber), top: [] } });
    if (averages.sugars > 50) hints.push({ code: 'high_sugar', params: { avg: Math.round(averages.sugars), top: top('sugars')[0]?.name ?? null } });
    if (averages.salt > 6) hints.push({ code: 'high_salt', params: { avg: r1(averages.salt) } });
    if (adherence && adherence.in_range_days / loggedDays.length >= 0.7) hints.push({ code: 'in_range', params: { days: adherence.in_range_days, of: loggedDays.length, pct: Math.round((adherence.in_range_days / loggedDays.length) * 100) } });
  }
  // vitamins and minerals: sums over the range, divided by all logged days; coverage by energy
  const rangeEntries = loggedDays.flatMap((d) => entries.get(d) ?? []);
  const agg = microTotals(rangeEntries);
  const micros: InsightMicro[] = NUTRIENTS.filter((n) => agg[n.key]).map((n) => {
    const average = agg[n.key].amount / loggedDays.length;
    return { key: n.key, group: n.group, unit: n.unit, nrv: n.nrv, average: Math.round(average * 1000) / 1000, coverage: agg[n.key].coverage, percent_nrv: n.nrv ? r1((average / n.nrv) * 100) : null };
  }).sort((a, b) => b.coverage - a.coverage);
  return {
    range: { from, to, days: dayKeys.length, logged_days: loggedDays.length }, goal: clone(goal),
    goal_kcal: goal ? r1(loggedDays.length ? mean(loggedDays.map((d) => goalFor(d, goal!.kcal))) : goal.kcal) : null, steps_goal: goal?.steps ?? 8000, days, averages, by_weekday, by_meal,
    top_foods: { kcal: top('kcal'), sugars: top('sugars'), salt: top('salt'), protein: top('protein') }, weight, adherence, micros, hints: hints.slice(0, 4),
  };
}

// the long-range parts of GET insights (sections, calendar, comparison, expenditure), computed from the base answer
function sectionsOf(from: string, to: string, g: 'day' | 'week' | 'month', base: Insights): Section[] {
  const out: Section[] = [];
  const dayRows = new Map(base.days.map((d) => [d.day, d]));
  const spans: { start: string; end: string; label: string }[] = [];
  if (g === 'day') for (let d = from; d <= to; d = addDays(d, 1)) spans.push({ start: d, end: d, label: d });
  else if (g === 'week') {
    for (let m = weekStart(from); m <= to; m = addDays(m, 7)) spans.push({ start: m < from ? from : m, end: addDays(m, 6) > to ? to : addDays(m, 6), label: isoWeek(m) });
  } else {
    let [y, mo] = from.split('-').map(Number);
    while (`${y}-${String(mo).padStart(2, '0')}-01` <= to) {
      const first = `${y}-${String(mo).padStart(2, '0')}-01`;
      const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      spans.push({ start: first < from ? from : first, end: addDays(next, -1) > to ? to : addDays(next, -1), label: first.slice(0, 7) });
      [y, mo] = mo === 12 ? [y + 1, 1] : [y, mo + 1];
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  for (const sp of spans) {
    const ds: InsightDay[] = [];
    for (let d = sp.start; d <= sp.end; d = addDays(d, 1)) { const r = dayRows.get(d); if (r) ds.push(r); }
    const got = ds.filter((d) => d.logged);
    const m = (k: keyof InsightDay) => Math.round(mean(got.map((d) => d[k] as number)) * 10) / 10;
    const ws = ds.filter((d) => d.weight != null).map((d) => d.weight as number);
    const wa = ds.filter((d) => d.water_ml != null).map((d) => d.water_ml as number);
    const goalK = base.goal?.kcal;
    const cls = (d: InsightDay) => (!goalK || d.goal_kcal == null ? '' : d.kcal > d.goal_kcal * 1.1 ? 'over' : d.kcal < d.goal_kcal * 0.9 ? 'under' : 'in');
    const st = ds.filter((d) => d.steps != null).map((d) => d.steps as number);
    const ac = ds.filter((d) => d.active_kcal != null).map((d) => d.active_kcal as number);
    out.push({
      steps: st.length ? Math.round(mean(st)) : null, active_kcal: ac.length ? Math.round(mean(ac)) : null,
      workout_minutes: ds.reduce((a, d) => a + d.workout_minutes, 0), goal_kcal: goalK ? Math.round(mean(got.map((d) => d.goal_kcal ?? goalK))) || goalK : null,
      start: sp.start, end: sp.end, label_key: sp.label, logged_days: got.length, days: diffDays(sp.start, sp.end) + 1,
      kcal: m('kcal'), protein: m('protein'), carbs: m('carbs'), fat: m('fat'), sugars: m('sugars'), fiber: m('fiber'), salt: m('salt'), saturated_fat: m('saturated_fat'),
      water_ml: wa.length ? Math.round(mean(wa)) : null, weight: ws.length ? Math.round(mean(ws) * 100) / 100 : null,
      in_range_days: got.filter((d) => cls(d) === 'in').length, over_days: got.filter((d) => cls(d) === 'over').length, under_days: got.filter((d) => cls(d) === 'under').length,
    });
  }
  return out;
}
function insights(from: string, to: string, g: string | null = null, compare = false): Insights {
  const base = baseInsights(from, to);
  const gran = g === 'day' || g === 'week' || g === 'month' ? g : autoGran(base.range.days);
  const all = [...entries.keys()].sort();
  const trend = base.weight;
  const rawW = base.days.filter((d) => d.weight != null).map((d) => ({ day: d.day, kg: d.weight as number }));
  const missing: string[] = [];
  if (base.range.days < 21) missing.push('short_period');
  if (base.range.logged_days / base.range.days < 0.7) missing.push('few_logged_days');
  if (rawW.length < 6) missing.push('few_weights');
  if (rawW.length < 2 || diffDays(rawW[0].day, rawW[rawW.length - 1].day) < 14) missing.push('weights_not_spread');
  let expenditure: Insights['expenditure'] = null;
  if (!missing.length) {
    const n = rawW.length, xs = rawW.map((w) => diffDays(from, w.day)), mx = xs.reduce((a, b) => a + b, 0) / n, my = rawW.reduce((a, w) => a + w.kg, 0) / n;
    const slope = rawW.reduce((a, w, i) => a + (xs[i] - mx) * (w.kg - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const kcal = base.averages.kcal - slope * 7700;
    const half = Math.max(0.1 * Math.abs(kcal), 1);
    expenditure = { kcal: Math.round(kcal), low: Math.round(kcal - half), high: Math.round(kcal + half), intake: Math.round(base.averages.kcal), weight_change_kg: Math.round(slope * base.range.days * 100) / 100, kg_per_week: Math.round(slope * 7 * 100) / 100, days: base.range.days, weigh_ins: n, goal_gap: base.goal ? Math.round(base.goal.kcal - kcal) : null };
  }
  const detailed = base.range.days <= 370;
  const goalK = base.goal?.kcal;
  const result: Insights = {
    ...base, first_day: all[0] ?? null, last_day: all[all.length - 1] ?? null, granularity: gran,
    series: sectionsOf(from, to, gran, base), expenditure, expenditure_missing: missing,
    weight: trend ? { ...trend, raw: rawW } : null,
    days: detailed ? base.days : [],
    calendar: detailed ? base.days.map((d) => ({ day: d.day, state: !d.logged ? 'none' : !goalK || d.goal_kcal == null ? 'no_goal' : d.kcal > d.goal_kcal * 1.1 ? 'over' : d.kcal < d.goal_kcal * 0.9 ? 'under' : 'in_range' })) : [],
  };
  if (compare) {
    const n = base.range.days;
    const pTo = addDays(from, -1), pFrom = addDays(pTo, -(n - 1));
    const pb = baseInsights(pFrom, pTo);
    result.previous = { range: pb.range, averages: pb.averages, adherence: pb.adherence, weight: pb.weight, logged_days: pb.range.logged_days, series: sectionsOf(pFrom, pTo, gran, pb) };
    const d = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : { abs: Math.round((a - b) * 100) / 100, pct: b ? Math.round(((a - b) / b) * 1000) / 10 : null });
    const share = (r: Insights) => (r.adherence && r.range.logged_days ? (r.adherence.in_range_days / r.range.logged_days) * 100 : null);
    result.deltas = pb.range.logged_days === 0 || base.range.logged_days === 0 ? null : {
      kcal: d(base.averages.kcal, pb.averages.kcal), protein: d(base.averages.protein, pb.averages.protein), carbs: d(base.averages.carbs, pb.averages.carbs),
      fat: d(base.averages.fat, pb.averages.fat), sugars: d(base.averages.sugars, pb.averages.sugars), fiber: d(base.averages.fiber, pb.averages.fiber),
      salt: d(base.averages.salt, pb.averages.salt), water_ml: d(base.averages.water_ml, pb.averages.water_ml),
      steps: d(base.averages.steps, pb.averages.steps), active_kcal: d(base.averages.active_kcal, pb.averages.active_kcal), workout_minutes: d(base.averages.workout_minutes, pb.averages.workout_minutes),
      weight_change: base.weight && pb.weight ? d(base.weight.change, pb.weight.change) : null,
      in_range_share: (() => { const a = share(base), b = share(pb); return a == null || b == null ? null : { abs: Math.round((a - b) * 10) / 10, pct: null }; })(),
    };
  }
  return result;
}
function mockNutrient(key: string, from: string, to: string, g: string): NutrientCurve {
  const core = ['kcal', 'protein', 'carbs', 'fat', 'sugars', 'fiber', 'salt', 'saturated_fat'];
  const base = baseInsights(from, to);
  const gran = g === 'day' || g === 'week' || g === 'month' ? g : autoGran(base.range.days);
  const info = NUTRIENTS.find((n) => n.key === key);
  const series = sectionsOf(from, to, gran, base).map((sec) => {
    const list: Entry[] = [];
    for (let d = sec.start; d <= sec.end; d = addDays(d, 1)) list.push(...(entries.get(d) ?? []));
    const days = sec.logged_days;
    if (core.includes(key)) return { start: sec.start, end: sec.end, average: sec.logged_days ? (sec[key as 'kcal'] as number) : null, coverage: sec.logged_days ? 1 : 0 };
    const agg = microTotals(list)[key];
    return { start: sec.start, end: sec.end, average: sec.logged_days ? (agg ? Math.round((agg.amount / Math.max(days, 1)) * 1000) / 1000 : 0) : null, coverage: agg?.coverage ?? 0 };
  });
  return {
    key, group: core.includes(key) ? 'core' : info?.group ?? 'other', unit: core.includes(key) ? (key === 'kcal' ? 'kcal' : 'g') : info?.unit ?? 'g', nrv: info?.nrv ?? null,
    goal: goal && ['kcal', 'protein', 'carbs', 'fat'].includes(key) ? (goal as unknown as Record<string, number>)[key] : null,
    range: base.range, granularity: gran, series, has_data: series.some((p) => p.average != null && p.coverage > 0),
  };
}
function foodStats(from: string, to: string) {
  const groups = new Map<string, FoodStat & { dates: string[] }>();
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const e of entries.get(d) ?? []) {
      const key = e.food_id != null ? `id:${e.food_id}` : `n:${e.name}|${e.brand ?? ''}`;
      const g = groups.get(key) ?? { key, food_id: e.food_id ?? null, name: e.name ?? '?', brand: e.brand ?? null, times: 0, days: 0, amount_total: 0, unit: e.unit, kcal_total: 0, share: 0, avg_amount: 0, first_day: d, last_day: d, dates: [] };
      g.times += 1; g.amount_total += e.amount; g.kcal_total += num(e.kcal); g.last_day = d; g.dates.push(d);
      total += num(e.kcal);
      groups.set(key, g);
    }
  }
  return { groups: [...groups.values()].map((g) => ({ ...g, days: new Set(g.dates).size, share: total ? Math.round((g.kcal_total / total) * 10000) / 10000 : 0, avg_amount: Math.round((g.amount_total / g.times) * 10) / 10 })), total };
}

// playful feedback: a small copy of src/mahlwerk/badges.py and review.py (enough to develop the screens)
let playful = true;
let tourSeen = ['demoacct', 'demoview'].includes(new URLSearchParams(location.search).get('mock') ?? ''); // the demo-account screens start without the tour
let suggestionsOn = true;
const earnedAt = new Map<BadgeCode, number>();
const seenBadges = new Set<string>();
const longestRun = (nums: number[]) => {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  let best = 0, run = 0;
  s.forEach((n, i) => { run = i && n === s[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); });
  return best;
};
const ord = (day: string) => Math.round(fromDay(day).getTime() / 86400000);
const bestWindow = (days: string[]) => {
  const nums = days.map(ord).sort((a, b) => a - b);
  let best = 0, start = 0;
  nums.forEach((n, end) => { while (n - nums[start] >= 7) start += 1; best = Math.max(best, end - start + 1); });
  return best;
};
function badgeProgress(): Record<BadgeCode, [number, number]> {
  const days = [...entries.keys()].filter((d) => (entries.get(d) ?? []).length);
  const totals = new Map(days.map((d) => [d, dayView(d).totals]));
  const foodIds = new Set([...entries.values()].flat().map((e) => e.food_id ?? e.name));
  const cap = (v: number, t: number): [number, number] => [Math.min(v, t), t];
  const streak = longestRun(days.map(ord));
  const g = goal;
  const hit = (f: (d: string) => boolean) => bestWindow(days.filter(f));
  const weeks = [...weights.keys()].map((d) => Math.floor(ord(weekStart(d)) / 7));
  return {
    first_entry: cap(days.length, 1), streak_3: cap(streak, 3), streak_7: cap(streak, 7), streak_30: cap(streak, 30), streak_100: cap(streak, 100),
    scans_10: cap(foodIds.size, 10), scans_50: cap(foodIds.size, 50), first_recipe: cap(recipes.length, 1),
    protein_week: cap(g ? hit((d) => (totals.get(d)?.protein ?? 0) >= g.protein * 0.9) : 0, 5),
    balanced_week: cap(g ? hit((d) => { const k = totals.get(d)?.kcal ?? 0; return k >= g.kcal * 0.9 && k <= g.kcal * 1.1; }) : 0, 5),
    fiber_5: cap(hit((d) => (totals.get(d)?.fiber ?? 0) >= 25), 5), weigh_in_4: cap(longestRun(weeks), 4),
    full_day_10: cap(days.filter((d) => ['breakfast', 'lunch', 'dinner'].every((m) => (entries.get(d) ?? []).some((e) => e.meal === m))).length, 10),
  };
}
function badgesView(): Badges {
  if (!playful) return { earned: [], open: [], new: [] };
  const progress = badgeProgress();
  for (const [code, [cur, target]] of Object.entries(progress) as [BadgeCode, [number, number]][]) {
    if (cur >= target && !earnedAt.has(code)) earnedAt.set(code, Math.floor(Date.now() / 1000));
  }
  const earned = [...earnedAt].map(([code, at]) => ({ code, earned_at: at, seen: seenBadges.has(code) }));
  return {
    earned,
    open: (Object.entries(progress) as [BadgeCode, [number, number]][]).filter(([c]) => !earnedAt.has(c)).map(([code, [current, target]]) => ({ code, progress: { current, target } })),
    new: earned.filter((b) => !b.seen).map((b) => b.code),
  };
}
function reviewView(week: string): Review {
  const monday = mondayOfWeek(week);
  const g = goal;
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = shiftDay(monday, i);
    const v = dayView(day);
    const logged = (entries.get(day) ?? []).length > 0;
    const k = v.totals.kcal ?? 0;
    const gk = g ? goalFor(day, g.kcal) : 0;
    const state = logged && g ? (k > gk * 1.1 ? 'over' : k < gk * 0.9 ? 'under' : 'in') as 'in' | 'over' | 'under' : null;
    return { day, logged, kcal: Math.round(k), state };
  });
  const n = days.filter((d) => d.logged).length;
  const avg = n ? days.filter((d) => d.logged).reduce((s, d) => s + d.kcal, 0) / n : 0;
  const inRange = days.filter((d) => d.state === 'in').length;
  const res: Review = { week, from: monday, to: shiftDay(monday, 6), logged_days: n, kcal_avg: Math.round(avg), goal: clone(g), days, best: null, improve: null, badges: [] };
  if (n < 2) { res.badges = ['quiet_week']; return res; }
  if (n === 7) res.best = { code: 'all_days', params: { days: 7 } };
  else if (inRange >= 5) res.best = { code: 'in_range_days', params: { days: inRange, of: n } };
  if (n < 4) res.improve = { code: 'few_days', params: { days: n } };
  else if (g) {
    const p = days.filter((d) => d.logged).reduce((s, d) => s + (dayView(d.day).totals.protein ?? 0), 0) / n;
    if (p < g.protein * 0.8) res.improve = { code: 'low_protein', params: { avg: Math.round(p), goal: Math.round(g.protein), pct: Math.round((p / g.protein) * 100) } };
  }
  return res;
}

// ---- integrations and admin area (mock) ----
const nowSec = () => Math.floor(Date.now() / 1000);
let mockTokens: AccessToken[] = [
  { id: 1, name: 'Home Assistant', prefix: 'mw_k3Xa9', scope: 'read', created_at: nowSec() - 12 * 86400, expires_at: null, last_used_at: nowSec() - 240, revoked_at: null },
  { id: 2, name: 'Waage', prefix: 'mw_Qp7Lm', scope: 'write', created_at: nowSec() - 40 * 86400, expires_at: nowSec() + 50 * 86400, last_used_at: nowSec() - 3 * 86400, revoked_at: null },
];
let mockHooks: Webhook[] = [
  { id: 1, name: 'Wochenmail', url: 'https://flow.example.org/hooks/mahlwerk', events: ['entry.created', 'weight.recorded'], enabled: true, created_at: nowSec() - 5 * 86400 },
];
let mockDeliveries: Record<number, WebhookDelivery[]> = {
  1: [
    { id: 3, event: 'weight.recorded', status_code: 200, error: null, attempts: 1, created_at: nowSec() - 3600, finished_at: nowSec() - 3599 },
    { id: 2, event: 'entry.created', status_code: 500, error: 'HTTP 500', attempts: 3, created_at: nowSec() - 7200, finished_at: nowSec() - 7190 },
    { id: 1, event: 'entry.created', status_code: 200, error: null, attempts: 1, created_at: nowSec() - 9000, finished_at: nowSec() - 8999 },
  ],
};
let mockHookSeq = 1;
let mockTokenSeq = 2;
const demoAcctMock = new URLSearchParams(location.search).get('mock');
const demoAcctOn = demoAcctMock === 'demoacct' || demoAcctMock === 'demoview';
let demoViewing = demoAcctMock === 'demoview';
const cnq = new URLSearchParams(location.search).get('cn'); // ?cn=notinstalled | locked | error | notconfigured : states of the connector cards
const mockConnectors: Connector[] = [
  { key: 'openfoodfacts_lookup', kind: 'source', enabled: true, status: 'ok', configurable: true, locked: cnq === 'locked' ? ['enabled'] : [], config: {}, info: { base_url: 'https://world.openfoodfacts.org' } },
  { key: 'openfoodfacts_catalog', kind: 'source', enabled: true, status: 'ok', configurable: true, locked: [], config: { countries: ['en:germany'] }, info: { products: 612480, updated_at: nowSec() - 3 * 86400 } },
  { key: 'bls', kind: 'source', enabled: true, status: 'ok', configurable: false, locked: [], config: {}, info: { products: 7140, updated_at: nowSec() - 30 * 86400, cli: true } },
  { key: 'cookidoo', kind: 'source', enabled: new URLSearchParams(location.search).get('cookidoo') !== 'off', status: cnq === 'notinstalled' ? 'not_installed' : cnq === 'error' ? 'error' : 'ready', configurable: true, locked: cnq === 'locked' ? ['enabled', 'config.images'] : [], config: { personal: true, images: false }, info: { error: cnq === 'error' ? 'Cookidoo is not reachable' : null, shared_account: true, env: 'MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD' } },
  { key: 'web_recipes', kind: 'source', enabled: new URLSearchParams(location.search).get('webrecipes') !== 'off', status: 'ok', configurable: true, locked: [], config: { images: false }, info: {} },
  { key: 'yazio_import', kind: 'import', enabled: true, status: 'upload', configurable: false, locked: [], config: {}, info: { batches: 1, cli: true, upload: true } },
  { key: 'yazio_login', kind: 'import', enabled: new URLSearchParams(location.search).get('yazio') !== 'off', status: (new URLSearchParams(location.search).get('yazio') === 'unset' || cnq === 'notconfigured') ? 'not_configured' : 'ready', configurable: true, locked: [], config: {}, info: { unofficial: true, env: 'MAHLWERK_YAZIO_CLIENT_ID, MAHLWERK_YAZIO_CLIENT_SECRET' } },
  // ?vision=off: photo recognition is switched off; ?vision=unset (or ?cn=notconfigured): no model configured
  { key: 'vision', kind: 'source', enabled: new URLSearchParams(location.search).get('vision') !== 'off',
    status: new URLSearchParams(location.search).get('vision') === 'unset' || cnq === 'notconfigured' ? 'not_configured' : new URLSearchParams(location.search).get('vision') === 'off' ? 'off' : 'ready',
    configurable: true, locked: [], config: {}, info: { model: new URLSearchParams(location.search).get('vision') === 'unset' || cnq === 'notconfigured' ? null : 'local-vision-model', per_hour: 30, env: 'MAHLWERK_VISION_URL, MAHLWERK_VISION_MODEL, MAHLWERK_VISION_KEY' } },
  { key: 'label_reader', kind: 'import', enabled: true, status: 'ok', configurable: false, locked: [], config: {}, info: {} },
  { key: 'demo_data', kind: 'import', enabled: true, status: 'ok', configurable: false, locked: [], config: {}, info: { env: 'MAHLWERK_DEMO_DATA' } },
  // ?mock=demoacct: the demo account is switched on (an admin can switch to it); ?mock=demoview: and the switch is already made
  { key: 'demo_account', kind: 'import', enabled: demoAcctOn, status: demoAcctOn ? 'ok' : 'off', configurable: true, locked: [], config: {},
    info: { exists: demoAcctOn, name_taken: false, env: 'MAHLWERK_DEMO_ACCOUNT', entries: 800, first_day: shiftDay(today(), -89), last_day: today() } },
  { key: 'access_tokens', kind: 'interface', enabled: true, status: 'ok', configurable: true, locked: [], config: {}, info: { active: 2 } },
  { key: 'webhooks', kind: 'interface', enabled: true, status: 'ok', configurable: true, locked: [], config: { hosts: [] }, info: { hooks: 1 } },
];
let mockRefresh: RefreshState = { state: 'idle', started_at: null, finished_at: null, progress: null, countries: [], result: null, error: null };

const COOKIDOO = buildCookidoo(L);
const COOKIDOO_WEEK = COOKIDOO.week;
const COOKIDOO_COLLECTIONS = COOKIDOO.collections;
const ckRecipe = (id: string): { name: string; portions: number; per: Per100 | null; fails: boolean } | undefined => {
  const known = (COOKIDOO.known as Record<string, { name: string; portions: number; per: Per100 }>)[id];
  return known ? { ...known, fails: false } : COOKIDOO.recipes.get(id);
};

// ---- groups of recipes (members are food ids) and the run that takes over many Cookidoo recipes: invented, a recipe every 0.45 s ----
let nextGroupId = 1;
const groupRows: { id: number; name: string; position: number; source: string | null; food_ids: Set<number> }[] = [];
const dismissedSources = new Set<string>();
const groupOut = (g: (typeof groupRows)[number]): RecipeGroup => ({ id: g.id, name: g.name, position: g.position, auto: g.source !== null, count: g.food_ids.size, food_ids: [...g.food_ids].sort((a, b) => a - b) });
const sortedGroups = () => [...groupRows].sort((a, b) => a.position - b.position);
const dropFromGroups = (foodId: number) => { for (const g of groupRows) g.food_ids.delete(foodId); };
const newGroup = (name: string, source: string | null) => {
  const g = { id: nextGroupId++, name, position: Math.max(0, ...groupRows.map((x) => x.position)) + 1, source, food_ids: new Set<number>() };
  groupRows.push(g);
  return g;
};
/** The group of a Cookidoo collection: found by its link, made when new, never made again once deleted (unless asked). */
function sourceGroup(collection: string, name: string): { group: (typeof groupRows)[number]; created: boolean } | null {
  const source = `cookidoo:${collection}`;
  const have = groupRows.find((g) => g.source === source);
  if (have) return { group: have, created: false };
  if (dismissedSources.has(source)) return null;
  const taken = new Set(groupRows.map((g) => g.name.toLowerCase()));
  let candidate = name;
  for (let k = 2; taken.has(candidate.toLowerCase()); k++) candidate = `${name} (${k === 2 ? 'Cookidoo' : k})`;
  return { group: newGroup(candidate, source), created: true };
}
interface MockRun { state: 'running' | 'done' | 'cancelled' | 'error'; scope: 'all' | 'collection' | 'week'; items: { id: string; name: string; cols: string[] }[]; names: Record<string, string>; i: number; fetched: number;
  toFetch: number; counts: Record<'adopted' | 'updated' | 'fresh' | 'no_nutrition' | 'failed', number>; failures: { id: string; name: string; kind: string; reason: string }[]; groups: string[]; groupNew: Record<string, boolean>;
  cancel: boolean; started: number; finished: number | null; timer: ReturnType<typeof setTimeout> | null; error: string | null; pictures?: boolean; picked?: number }
let bulkRun: MockRun | null = null;
const bulkExternal = (id: string) => `cookidoo:${id}`;
const bulkFresh = (id: string) => foods.some((f) => f.source === 'cookidoo' && f.external_id === bulkExternal(id));
function bulkPlan(scope: 'all' | 'collection' | 'week', collection: string | null) {
  const items = new Map<string, { id: string; name: string; cols: string[] }>();
  const names: Record<string, string> = {};
  const put = (r: { id: string; name: string }, col: string | null) => { const it = items.get(r.id) ?? { id: r.id, name: r.name, cols: [] }; if (col && !it.cols.includes(col)) it.cols.push(col); items.set(r.id, it); };
  if (scope !== 'week') {
    const list = COOKIDOO_COLLECTIONS.filter((c) => scope === 'all' || c.id === collection);
    if (scope === 'collection' && list.length === 0) throw new ApiError(404, 'unknown collection');
    for (const c of list) { if (c.recipes.length) names[c.id] = c.name; for (const r of c.recipes) put(r, c.id); }
  }
  if (scope !== 'collection') for (const d of COOKIDOO_WEEK) for (const r of d.recipes) put(r, null);
  if (items.size === 0) throw new ApiError(422, 'there is nothing to take over in this selection');
  if (items.size > 500) throw new ApiError(422, `${items.size} recipes: at most 500 per run, take over collection by collection`);
  return { items: [...items.values()], names };
}
function bulkView() {
  const run = bulkRun;
  if (!run) return null;
  const running = run.state === 'running';
  const cur = running ? run.items[run.i] : undefined;
  return {
    state: run.state, cancelling: running && run.cancel, scope: run.scope, mode: run.pictures ? 'pictures' : 'recipes', pictures: run.picked ?? 0, no_picture: 0,
    total: run.items.length, done: run.i, fetched: run.fetched, ...run.counts,
    current: cur?.name ?? null, failures: clone(run.failures), groups: [...run.groups], error: run.error ? 'Cookidoo is not reachable' : null, error_kind: run.error,
    reason: run.state === 'cancelled' ? 'cancelled' : null, reason_kind: run.state === 'cancelled' ? 'user' : null,
    eta_seconds: running ? Math.max(0, run.toFetch - run.fetched) * 4 : 0, started_at: Math.floor(run.started / 1000), finished_at: run.finished ? Math.floor(run.finished / 1000) : null,
  };
}
function bulkStep() {
  const run = bulkRun;
  if (!run || run.state !== 'running') return;
  if (run.cancel) { run.state = 'cancelled'; run.finished = Date.now(); return; }
  const item = run.items[run.i];
  if (!item) { run.state = 'done'; run.finished = Date.now(); return; }
  let wait = 0;
  if (run.pictures) {
    const f = foods.find((x) => x.external_id === item.id);
    if (f && !f.image) { givePicture(f, 'cookidoo', 'Cookidoo'); run.picked = (run.picked ?? 0) + 1; }
    run.i++;
    run.timer = setTimeout(bulkStep, 450);
    return;
  }
  const known = foods.find((f) => f.source === 'cookidoo' && f.external_id === bulkExternal(item.id));
  let foodId = known?.id ?? null;
  let isNew = false;
  if (known) run.counts.fresh++;
  else {
    wait = 450;
    run.fetched++;
    const rec = ckRecipe(item.id);
    if (!rec || rec.fails) { run.counts.failed++; run.failures.push({ id: item.id, name: item.name, kind: 'unexpected', reason: 'unexpected' }); }
    else if (!rec.per) { run.counts.no_nutrition++; run.failures.push({ id: item.id, name: item.name, kind: 'no_nutrition', reason: 'no_nutrition' }); }
    else { const f = cookidooFood(item.id, rec.name, rec.portions, rec.per); foodId = f.id; isNew = true; run.counts.adopted++; }
  }
  if (foodId != null) for (const col of item.cols) { const g = groupRows.find((x) => x.source === `cookidoo:${col}`); if (g && (isNew || run.groupNew[col])) g.food_ids.add(foodId); }
  run.i++;
  run.timer = setTimeout(bulkStep, wait);
}
function bulkStart(scope: 'all' | 'collection' | 'week', collection: string | null, regroup: boolean) {
  if (bulkRun?.state === 'running') throw new ApiError(409, 'a run for this Cookidoo account is already under way');
  const { items, names } = bulkPlan(scope, collection);
  const run: MockRun = { state: 'running', scope, items, names, i: 0, fetched: 0, toFetch: items.filter((i) => !bulkFresh(i.id)).length,
    counts: { adopted: 0, updated: 0, fresh: 0, no_nutrition: 0, failed: 0 }, failures: [], groups: [], groupNew: {}, cancel: false, started: Date.now(), finished: null, timer: null, error: null };
  for (const [col, name] of Object.entries(names)) {
    if (regroup) dismissedSources.delete(`cookidoo:${col}`);
    const made = sourceGroup(col, name);
    if (made) { run.groups.push(made.group.name); run.groupNew[col] = made.created; }
  }
  bulkRun = run;
  run.timer = setTimeout(bulkStep, 600);
  return bulkView();
}

const NOT_MINE = Symbol('not handled here');

// Local sign-in mode, for trying the sign-in pages without a server: ?mock=local (sign in) or ?mock=setup (first start).
// Any password of 10 or more characters signs in, except "wrong-password". With ?mock=setup&code=1 the setup asks for the code "demo-code".
const mockMode = new URLSearchParams(location.search).get('mock');
const oidcMock = mockMode === 'oidc'; // ?mock=oidc: the sign-in page of the oidc mode (the button leads nowhere here); ?mock=oidc&signedin=1 starts signed in
const localMock = mockMode === 'local' || mockMode === 'setup';
let mockOwnName: string | null = null;
const mockProviderName = () => (localMock ? (mockAccounts.find((a) => a.username === mockAuth.user)?.display_name ?? mockAuth.user) : oidcMock ? 'Alexandra Example' : 'Alex');
const mockAuth = { setup: mockMode === 'setup', signedIn: !(localMock || oidcMock) || (oidcMock && new URLSearchParams(location.search).get('signedin') === '1'), user: 'alex' };
const mockAccounts: { username: string; display_name: string; admin: boolean; disabled: boolean }[] = [
  { username: 'alex', display_name: 'Alex', admin: true, disabled: false },
  { username: 'sam', display_name: 'Sam Example', admin: false, disabled: false },
  { username: 'kim', display_name: 'kim', admin: false, disabled: true },
];
function mockAuthRequest(method: string, p: string, body: unknown): unknown {
  const status = () => ({
    mode: oidcMock ? 'oidc' : localMock ? 'local' : 'single', ...(oidcMock ? { oidc_label: new URLSearchParams(location.search).get('label') ?? 'Example ID' } : {}), setup_required: mockAuth.setup, setup_code_required: mockMode === 'setup' && mockAuth.setup && new URLSearchParams(location.search).get('code') === '1', authenticated: mockAuth.signedIn,
    username: mockAuth.signedIn ? mockAuth.user : null, display_name: mockAuth.signedIn ? mockAuth.user : null, is_admin: mockAuth.signedIn ? true : null,
  });
  if (p === 'auth/status') return status();
  const b = (body ?? {}) as { username?: string; display_name?: string; password?: string; current_password?: string; new_password?: string };
  if (p === 'auth/setup') {
    if (!mockAuth.setup) throw new ApiError(409, 'already set up');
    if (new URLSearchParams(location.search).get('code') === '1' && (body as { setup_code?: string }).setup_code !== 'demo-code') throw new ApiError(403, 'the setup code is wrong');
    mockAuth.setup = false;
    mockAuth.signedIn = true;
    mockAuth.user = b.username ?? 'alex';
    mockAccounts[0] = { username: mockAuth.user, display_name: b.display_name || mockAuth.user, admin: true, disabled: false };
    return { username: mockAuth.user, display_name: b.display_name || mockAuth.user, is_admin: true };
  }
  if (p === 'auth/login') {
    const acct = mockAccounts.find((a) => a.username === (b.username ?? '').toLowerCase());
    if (!acct || b.password === 'wrong-password') throw new ApiError(401, 'invalid user name or password');
    if (acct.disabled) throw new ApiError(403, 'this account is blocked');
    mockAuth.signedIn = true;
    mockAuth.user = acct.username;
    return { username: acct.username, display_name: acct.display_name, is_admin: acct.admin };
  }
  if (p === 'auth/logout') { mockAuth.signedIn = false; return null; }
  if (p === 'auth/password' && method === 'POST') {
    if (b.current_password === 'wrong-password') throw new ApiError(403, 'the current password is wrong');
    return null;
  }
  return NOT_MINE;
}
function mockIntegrations(method: string, p: string, body: unknown): unknown {
  let r: RegExpExecArray | null;
  if (p === 'me/tokens') {
    if (method === 'GET') return clone(mockTokens);
    const b = body as { name: string; scope: AccessToken['scope']; expires_in_days?: number };
    const token = `mw_${Array.from({ length: 43 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'[Math.floor(Math.random() * 57)]).join('')}`;
    const made: AccessToken = { id: ++mockTokenSeq, name: b.name, prefix: token.slice(0, 8), scope: b.scope, created_at: nowSec(), expires_at: b.expires_in_days ? nowSec() + b.expires_in_days * 86400 : null, last_used_at: null, revoked_at: null };
    mockTokens = [made, ...mockTokens];
    return { ...made, token };
  }
  if ((r = /^me\/tokens\/(\d+)$/.exec(p)) && method === 'DELETE') {
    const k = mockTokens.find((x) => x.id === Number(r![1]));
    if (!k) throw new ApiError(404, 'unknown token');
    k.revoked_at = nowSec();
    return null;
  }
  if (p === 'me/webhooks') {
    if (method === 'GET') return clone(mockHooks);
    const b = body as WebhookIn;
    if (!/^https?:\/\//.test(b.url)) throw new ApiError(422, 'url must start with http:// or https://');
    const made: Webhook = { id: ++mockHookSeq, name: b.name, url: b.url, events: b.events, enabled: b.enabled ?? true, created_at: nowSec() };
    mockHooks = [...mockHooks, made];
    mockDeliveries[made.id] = [];
    return { ...made, secret: `whsec_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}` };
  }
  if ((r = /^me\/webhooks\/(\d+)(?:\/(test|deliveries))?$/.exec(p))) {
    const id = Number(r[1]);
    const hook = mockHooks.find((h) => h.id === id);
    if (!hook) throw new ApiError(404, 'unknown webhook');
    if (r[2] === 'deliveries') return clone(mockDeliveries[id] ?? []);
    if (r[2] === 'test') {
      const d: WebhookDelivery = { id: Date.now(), event: 'ping', status_code: null, error: null, attempts: 0, created_at: nowSec(), finished_at: null };
      mockDeliveries[id] = [d, ...(mockDeliveries[id] ?? [])];
      setTimeout(() => { Object.assign(d, { status_code: 200, attempts: 1, finished_at: nowSec() }); }, 900);
      return { queued: true };
    }
    if (method === 'DELETE') { mockHooks = mockHooks.filter((h) => h.id !== id); return null; }
    if (method === 'PATCH') { Object.assign(hook, body as Partial<WebhookIn>); return clone(hook); }
  }
  if (p === 'admin/overview') {
    return { version: '0.0.1', auth_mode: oidcMock ? 'oidc' : localMock ? 'local' : 'proxy', db_size_bytes: 3_412_992, schema_version: 8, users: mockAccounts.length, entries: 4218, foods: 386, catalog: { products: 612480, updated_at: nowSec() - 3 * 86400, bls: { products: 7140, updated_at: nowSec() - 30 * 86400 } } };
  }
  if (p === 'admin/users' && method === 'GET') {
    const demoRow = mockConnectors.find((c) => c.key === 'demo_account')!.info.exists
      ? [{ username: 'demo', display_name: 'Demo', created_at: nowSec() - 86400, entries: 800, first_day: shiftDay(today(), -89), last_day: today(), tokens: 0, webhooks: 0, disabled: false, admin: false, has_password: false, demo: true }] : [];
    return [...mockAccounts.map((a, i) => ({
      username: a.username, display_name: a.display_name, created_at: nowSec() - [90, 60, 9, 2][i % 4] * 86400, entries: [2310, 1544, 364, 0][i % 4],
      first_day: i === 3 ? null : ['2026-08-14', '2026-09-02', '2026-11-03'][i % 3], last_day: i === 3 ? null : shiftDay(today(), -i), tokens: [2, 0, 1, 0][i % 4], webhooks: i === 0 ? 1 : 0,
      disabled: a.disabled, admin: a.admin, has_password: !oidcMock, ...(oidcMock ? { sso: i !== 2 } : {}),
    })), ...demoRow];
  }
  if (p === 'admin/users' && method === 'POST') {
    const b = body as { username: string; display_name: string; password: string; is_admin: boolean };
    if (mockAccounts.some((a) => a.username === b.username)) throw new ApiError(409, 'this user name is taken');
    mockAccounts.push({ username: b.username, display_name: b.display_name || b.username, admin: b.is_admin, disabled: false });
    return { username: b.username, display_name: b.display_name || b.username, is_admin: b.is_admin, disabled: false };
  }
  if ((r = /^admin\/users\/([^/]+)(\/password)?$/.exec(p))) {
    const acct = mockAccounts.find((a) => a.username === decodeURIComponent(r![1]));
    if (!acct) throw new ApiError(404, 'unknown user');
    if (r[2]) return null;
    const b = body as { disabled?: boolean; is_admin?: boolean };
    const others = mockAccounts.filter((a) => a !== acct && a.admin && !a.disabled).length;
    if (others === 0 && acct.admin && !acct.disabled && (b.disabled || b.is_admin === false)) throw new ApiError(409, 'this is the last active admin');
    if (b.disabled != null) acct.disabled = b.disabled;
    if (b.is_admin != null) acct.admin = b.is_admin;
    return { username: acct.username, display_name: acct.display_name, is_admin: acct.admin, disabled: acct.disabled };
  }
  if (p === 'admin/connectors' && method === 'GET') return clone(mockConnectors.map((c) => (c.key === 'cookidoo' ? { ...c, info: { ...c.info, account: ckView('shared', true) } } : c)));
  if ((r = /^admin\/connectors\/(\w+)$/.exec(p)) && method === 'PATCH') {
    const c = mockConnectors.find((x) => x.key === r![1]);
    if (!c) throw new ApiError(404, 'unknown connector');
    const b = body as { enabled?: boolean; config?: Record<string, string[] | boolean> };
    if (b.enabled != null) { c.enabled = b.enabled; c.status = (c.key === 'yazio_login' && new URLSearchParams(location.search).get('yazio') === 'unset') || (c.key === 'vision' && c.info.model === null) ? 'not_configured' : b.enabled ? (c.key === 'cookidoo' || c.key === 'yazio_login' || c.key === 'vision' ? 'ready' : 'ok') : 'off'; }
    if (b.config) Object.assign(c.config, b.config);
    if (c.key === 'demo_account' && b.enabled) c.info.exists = true;
    return clone(c);
  }
  if (p === 'admin/catalog/refresh') {
    if (method === 'POST') {
      if (mockRefresh.state === 'running') throw new ApiError(409, 'a refresh is already running');
      mockRefresh = { state: 'running', started_at: nowSec(), finished_at: null, progress: '200,000 rows read, 31,204 kept, 12 s', countries: ['en:germany'], result: null, error: null };
      setTimeout(() => { mockRefresh = { ...mockRefresh, state: 'done', finished_at: nowSec(), result: { rows_read: 3_100_000, products: 612_480, seconds: 410, truncated: false } }; }, 6000);
    }
    return clone(mockRefresh);
  }
  return NOT_MINE;
}


// ---- Cookidoo accounts (shared in the admin area, own in the profile) and the Yazio import: invented, nothing leaves the page ----
type CkAccount = { source: 'stored' | 'none'; email: string; country: string; language: string };
const ckAccounts: Record<'shared' | 'own', CkAccount> = {
  shared: { source: 'stored', email: 'h***@example.org', country: 'de', language: 'de-DE' },
  own: { source: 'none', email: '', country: 'de', language: 'de-DE' },
};
if (new URLSearchParams(location.search).get('ck') === 'none') ckAccounts.shared = { source: 'none', email: '', country: 'de', language: 'de-DE' };
const ckEnv = new URLSearchParams(location.search).get('ck') === 'env';
const maskMail = (mail: string) => { const [local, domain] = mail.split('@'); return domain ? `${local.slice(0, 1)}***@${domain}` : '***'; };
function ckView(scope: 'shared' | 'own', admin: boolean) {
  const a = ckAccounts[scope];
  const personal = (mockConnectors.find((c) => c.key === 'cookidoo')!.config.personal) !== false;
  const env = scope === 'shared' && ckEnv;
  return {
    source: env ? 'env' : a.source, email: env ? 'h***@example.org' : a.source === 'stored' ? a.email : null,
    country: env || a.source === 'stored' ? a.country : null, language: env || a.source === 'stored' ? a.language : null,
    editable: !env && (scope === 'shared' || personal), allowed: scope === 'shared' ? true : personal,
    key: admin ? 'file' : null, error: null,
  };
}
type YzStage = { token: string; source: 'upload' | 'login'; files: Record<string, number> };
let yzStage: YzStage | null = null;
let yzRun: { startedAt: number; months: number; failAfter: number | null; cancelled: boolean } | null = null;
let yzTokenSeq = 1;
const YZ_PHASES = ['discover', 'days', 'products', 'weights'] as const;
function yzRunView() {
  if (!yzRun) return null;
  const elapsed = Date.now() - yzRun.startedAt;
  if (yzRun.cancelled) return { state: 'cancelled', phase: 'days', done: 0, total: 0, requests: 0, error: 'cancelled', error_kind: 'cancelled' };
  if (yzRun.failAfter != null && elapsed > yzRun.failAfter) return { state: 'error', phase: 'login', done: 0, total: 0, requests: 1, error: 'Yazio refused the sign-in (check the e-mail address and the password)', error_kind: 'auth' };
  const total = 5200;
  if (elapsed >= total) {
    if (!yzStage) yzStage = { token: `t${yzTokenSeq++}`, source: 'login', files: { 'days.json': 4_812_330, 'products.json': 1_204_118, 'weight.json': 6_120 } };
    return { state: 'done', phase: 'done', done: 1, total: 1, requests: 1234, error: null, error_kind: null };
  }
  const f = elapsed / total;
  const phase = YZ_PHASES[Math.min(3, Math.floor(f * 4))];
  const within = (f * 4) % 1;
  const sizes = { discover: yzRun.months, days: 380, products: 640, weights: 380 };
  return { state: 'running', phase, done: Math.round(within * sizes[phase]), total: sizes[phase], requests: Math.round(f * 1234), error: null, error_kind: null };
}
function yzPreviewData(): Record<string, unknown> {
  return {
    token: yzStage!.token, days: 412, entries: { product: 3100, recipe: 340, quick: 200 }, entries_total: 3640, foods_created: 520, foods_reused: 14,
    weights: 180, weights_kept: 12, water: 390, water_kept: 0, activity_days: 220, activity_kept: 0, workouts: 64, workouts_already: 0, goal_set: true,
    already_imported: 0, skipped: [{ reason: 'product not in products.json', count: 7 }, { reason: 'entry with an invalid amount', count: 2 }],
    notes: [], unknown_keys: 3, dropped_values: 5, missing_files: [], batch_id: null, dry_run: true,
  };
}
function mockConnections(method: string, p: string, body: unknown, raw?: Blob): unknown {
  let r: RegExpExecArray | null;
  const scopeOf = (path: string): 'shared' | 'own' | null => (path.startsWith('admin/cookidoo/account') ? 'shared' : path.startsWith('me/cookidoo-account') ? 'own' : null);
  const scope = scopeOf(p);
  if (scope) {
    const admin = scope === 'shared';
    const view = ckView(scope, admin);
    if (p.endsWith('/check')) {
      if (ckAccounts[scope].source !== 'stored' && !(admin && ckEnv)) throw new ApiError(409, 'no Cookidoo account is stored');
      if (/wrong/i.test(ckAccounts[scope].email)) throw new ApiError(502, 'Cookidoo sign-in failed (check the e-mail address and the password of the account)');
      return { ok: true };
    }
    if (method === 'GET') return view;
    if (method === 'PUT') {
      if (!view.editable) throw new ApiError(admin ? 409 : 403, admin ? 'fixed by the environment (MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD)' : 'own Cookidoo accounts are switched off (admin area)');
      const b = body as { email: string; password: string; country: string; language: string };
      if (!b.email?.trim() || !b.password) throw new ApiError(422, 'e-mail address and password are required; the country is two letters (de) and the language like de-DE');
      ckAccounts[scope] = { source: 'stored', email: maskMail(b.email.trim()), country: b.country, language: b.language };
      if (/wrong/i.test(b.password)) ckAccounts[scope].email = 'wrong@example.org';
      return ckView(scope, admin);
    }
    if (method === 'DELETE') { ckAccounts[scope] = { source: 'none', email: '', country: 'de', language: 'de-DE' }; return ckView(scope, admin); }
  }
  if (p === 'me/yazio' && method === 'GET') {
    const run = yzRunView();
    const login = mockConnectors.find((c) => c.key === 'yazio_login')!;
    return { stage: yzStage ? clone(yzStage) : null, login: { enabled: login.enabled, available: login.enabled && login.status !== 'not_configured', run, max_months: 24, default_months: 12 }, max_file_bytes: 24 * 1024 * 1024 };
  }
  if (p === 'me/yazio' && method === 'DELETE') { if (yzRun && yzRunView()?.state === 'running') yzRun.cancelled = true; yzStage = null; return undefined; }
  if ((r = /^me\/yazio\/files\/([\w.]+)$/.exec(p)) && method === 'PUT') {
    if (!['days.json', 'products.json', 'weight.json', 'export.zip'].includes(r[1])) throw new ApiError(422, 'unexpected file name (days.json, products.json, weight.json or a ZIP)');
    const size = raw?.size ?? 0;
    if (size > 24 * 1024 * 1024) throw new ApiError(413, 'request body too large (at most 25165824 bytes)');
    const keep = r[1] === 'export.zip' || yzStage?.source !== 'upload' ? {} : yzStage.files;
    const files = r[1] === 'export.zip' ? { 'days.json': size * 4, 'products.json': size, 'weight.json': 6120 } : { ...keep, [r[1]]: Math.max(size, 1) };
    yzStage = { token: `t${yzTokenSeq++}`, source: 'upload', files };
    return clone(yzStage);
  }
  if (p === 'me/yazio/preview' && method === 'POST') {
    if (!yzStage) throw new ApiError(410, 'nothing is waiting to be imported (it may have expired): upload the files again');
    return yzPreviewData();
  }
  if (p === 'me/yazio/confirm' && method === 'POST') {
    if (!yzStage) throw new ApiError(410, 'nothing is waiting to be imported (it may have expired): upload the files again');
    if ((body as { token: string }).token !== yzStage.token) throw new ApiError(409, 'the files changed since the preview: look at the preview again');
    const id = Math.max(0, ...importBatches.map((b) => b.id)) + 1;
    importBatches.unshift({ id, kind: 'yazio', created_at: Math.floor(Date.now() / 1000), counts: { days: 412, entries: 3640, product_entries: 3100, recipe_entries: 340, quick_entries: 200, foods: 520, weights: 180, water: 390, goal_set: true, activity_days: 220, workouts: 64 } });
    const done = { ...yzPreviewData(), batch_id: id, dry_run: false };
    yzStage = null;
    return done;
  }
  if (p === 'me/yazio/login' && method === 'POST') {
    const b = body as { email: string; password: string; months: number };
    if (!b.email?.trim() || !b.password) throw new ApiError(422, 'e-mail address and password are required');
    if (yzRun && yzRunView()?.state === 'running') throw new ApiError(409, 'a fetch of yours is already running');
    yzStage = null;
    yzRun = { startedAt: Date.now(), months: b.months, failAfter: /wrong/i.test(b.password) ? 900 : null, cancelled: false };
    return yzRunView();
  }
  return NOT_MINE;
}

/** The built-in demo account in the mock: the switch, its card, and what a demo request may not do (the server's table is demo_account.py). */
const SHARED_OR_OUTWARD = /^(foods|recipes|recipe-groups|catalog\/adopt|cookidoo|web-recipes|me\/(tokens|webhooks|yazio|cookidoo-account|demo-data|imports)|admin)(\/|$)/;
function mockDemoAccount(method: string, p: string): unknown {
  const card = mockConnectors.find((c) => c.key === 'demo_account')!;
  if (p === 'me/demo-view/enter' && method === 'POST') {
    if (!card.enabled) throw new ApiError(404, 'the demo account is switched off');
    demoViewing = true;
    return { can_switch: false, viewing: true, real_username: 'me', real_display_name: 'me' } satisfies DemoAccountState;
  }
  if (p === 'me/demo-view/leave' && method === 'POST') { demoViewing = false; return null; }
  if (p === 'admin/demo-account/reset' && method === 'POST') return clone(card);
  if (p === 'admin/demo-account' && method === 'DELETE') { card.enabled = false; card.status = 'off'; card.info.exists = false; return clone(card); }
  if (demoViewing && (p === 'me' ? method === 'PATCH' : SHARED_OR_OUTWARD.test(p) && (method !== 'GET' || /^(admin|me\/(tokens|webhooks|yazio|cookidoo-account)|cookidoo)/.test(p)))) throw new ApiError(403, DEMO_BLOCKED);
  return NOT_MINE;
}
function mockDemoMe<T extends { username: string; display_name: string | null; is_admin?: boolean; demo: { available: boolean }; features: object }>(me: T): T & { demo_account: DemoAccountState } {
  const on = mockConnectors.find((c) => c.key === 'demo_account')!.enabled;
  if (!demoViewing) return { ...me, demo_account: { can_switch: on && me.is_admin === true, viewing: false, real_username: null, real_display_name: null } };
  return {
    ...me, username: 'demo', display_name: 'Demo', display_name_custom: false, provider_name: null, is_admin: false, demo: { ...me.demo, available: false },
    features: { access_tokens: false, webhooks: false, cookidoo: false, web_recipes: false },
    demo_account: { can_switch: false, viewing: true, real_username: me.username, real_display_name: me.display_name },
  };
}

let recipePhotos = 0; // photo recognition: the 1st, 3rd … photo is page one, the 2nd, 4th … page two of a recipe
export async function mockRequest(method: string, path: string, body?: unknown, raw?: Blob): Promise<unknown> {
  await wait();
  const url = new URL(path, 'http://x/');
  const p = url.pathname.replace(/^\/+/, '');
  const m = (re: RegExp) => re.exec(p);
  let r: RegExpExecArray | null;

  const sign = mockAuthRequest(method, p, body);
  if (sign !== NOT_MINE) return sign;
  if (!mockAuth.signedIn) throw new ApiError(401, 'not authenticated');
  const acct = mockDemoAccount(method, p);
  if (acct !== NOT_MINE) return acct;
  const integration = mockIntegrations(method, p, body);
  if (integration !== NOT_MINE) return integration;
  const connection = mockConnections(method, p, body, raw);
  if (connection !== NOT_MINE) return connection;
  if (p === 'nutrients') return clone(NUTRIENTS);
  if (p === 'me' && method === 'PATCH') {
    const next = (body as { display_name: string | null }).display_name;
    const clean = (next ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(next ?? '') || [...clean].length > 60) throw new ApiError(422, 'invalid name');
    mockOwnName = clean || null;
  }
  if (p === 'me') {
    return mockDemoMe({ username: localMock ? mockAuth.user : 'me', display_name: mockOwnName ?? mockProviderName(), display_name_custom: mockOwnName !== null, provider_name: mockOwnName !== null && mockProviderName() !== mockOwnName ? mockProviderName() : null, goal: clone(goal), settings: { playful, fasting: { ...fastSettings }, activity: { ...activitySettings }, tour_seen: tourSeen, suggestions: suggestionsOn }, demo: { available: true, entries: demoEntryIds.size, weights: demoWeightDays.size, water: demoWaterDays.size, activity: demoActivityDays.size, workouts: demoWorkoutIds.size }, catalog: { products: catalog.length, updated_at: catalogUpdatedAt, bls: { products: basics.length, updated_at: catalogUpdatedAt } }, is_admin: localMock ? (mockAccounts.find((a) => a.username === mockAuth.user)?.admin ?? false) : true, features: { access_tokens: mockConnectors.find((c) => c.key === 'access_tokens')!.enabled, webhooks: mockConnectors.find((c) => c.key === 'webhooks')!.enabled, cookidoo: mockConnectors.find((c) => c.key === 'cookidoo')!.enabled, web_recipes: mockConnectors.find((c) => c.key === 'web_recipes')!.enabled } });
  }
  if (p === 'me/settings' && method === 'PATCH') {
    const b = body as { playful?: boolean; tour_seen?: boolean; suggestions?: boolean; fasting?: Partial<typeof fastSettings>; activity?: Partial<typeof activitySettings> };
    if (typeof b.playful === 'boolean') playful = b.playful;
    if (typeof b.tour_seen === 'boolean') tourSeen = b.tour_seen;
    if (typeof b.suggestions === 'boolean') suggestionsOn = b.suggestions;
    if (b.fasting) Object.assign(fastSettings, b.fasting);
    if (b.activity) Object.assign(activitySettings, b.activity);
    return { playful, fasting: { ...fastSettings }, activity: { ...activitySettings }, tour_seen: tourSeen, suggestions: suggestionsOn };
  }
  if (p === 'badges' && method === 'GET') return badgesView();
  if (p === 'badges/seen' && method === 'POST') {
    for (const c of (body as { codes: string[] }).codes) seenBadges.add(c);
    return badgesView();
  }
  if (p === 'review' && method === 'GET') return reviewView(url.searchParams.get('week') ?? isoWeek(shiftDay(today(), -7)));
  if (p === 'me/demo-data') {
    if (method === 'POST') return createDemo(Math.min(365, Math.max(1, (body as { days?: number })?.days ?? 30)));
    if (method === 'DELETE') return deleteDemo();
  }
  if (p === 'me/imports' && method === 'GET') return clone(importBatches);
  if ((r = m(/^me\/imports\/(\d+)$/)) && method === 'DELETE') {
    const at = importBatches.findIndex((b) => b.id === Number(r![1]));
    if (at < 0) throw new ApiError(404, 'unknown import');
    const { counts } = importBatches.splice(at, 1)[0];
    return { entries: counts.entries, weights: counts.weights, water: counts.water, foods: counts.foods, goal: counts.goal_set };
  }
  if (p === 'catalog' && method === 'GET') {
    const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.join('').length < 2) return [];
    const stored = new Set(foods.map((f) => f.code));
    const only = url.searchParams.get('source');
    const hit = (c: CatalogItem) => words.every((w) => `${c.name} ${c.name_en ?? ''} ${c.brand ?? ''}`.toLowerCase().includes(w));
    const basic = only === 'openfoodfacts' ? [] : basics.filter((c) => !adoptedBasics.has(c.code) && hit(c)).slice(0, 8);
    const packaged = only === 'bls' ? [] : catalog.filter((c) => !stored.has(c.code) && hit(c));
    return clone([...basic, ...packaged]);
  }
  // Cookidoo connector: invented recipes, values per portion; a portion is booked as 100 g
  if (p.startsWith('cookidoo/')) {
    if (!mockConnectors.find((c) => c.key === 'cookidoo')!.enabled) throw new ApiError(404, 'the Cookidoo connector is switched off (admin area)');
    if (p === 'cookidoo/week') return clone(COOKIDOO_WEEK);
    if (p === 'cookidoo/collections') return clone(COOKIDOO_COLLECTIONS);
    if (p === 'cookidoo/import/preview') {
      const scope = (url.searchParams.get('scope') ?? 'all') as 'all' | 'collection' | 'week';
      const { items, names } = bulkPlan(scope, url.searchParams.get('collection'));
      const fresh = items.filter((i) => bulkFresh(i.id)).length;
      return { total: items.length, fresh, to_fetch: items.length - fresh, eta_seconds: (items.length - fresh) * 4, seconds_per_recipe: 4, limit: 500,
        groups: Object.entries(names).map(([collection, name]) => ({ collection, name, exists: groupRows.some((g) => g.source === `cookidoo:${collection}`), dismissed: dismissedSources.has(`cookidoo:${collection}`) && !groupRows.some((g) => g.source === `cookidoo:${collection}`) })) };
    }
    if (p === 'cookidoo/images/preview') {
      const missing = foods.filter((f) => f.source === 'cookidoo' && !f.image);
      return { enabled: mockConnectors.find((c) => c.key === 'cookidoo')!.config.images === true, total: missing.length, to_fetch: Math.min(1, missing.length), eta_seconds: missing.length * 2 + 2, limit: 500 };
    }
    if (p === 'cookidoo/images' && method === 'POST') {
      if (mockConnectors.find((c) => c.key === 'cookidoo')!.config.images !== true) throw new ApiError(409, 'storing recipe pictures is switched off for Cookidoo (admin area)');
      if (bulkRun?.state === 'running') throw new ApiError(409, 'a run for this Cookidoo account is already under way');
      const missing = foods.filter((f) => f.source === 'cookidoo' && !f.image);
      if (!missing.length) throw new ApiError(422, 'there is nothing to take over in this selection (or no recipe lacks a picture)');
      const run: MockRun = { state: 'running', scope: 'pictures' as never, items: missing.map((f) => ({ id: f.external_id ?? '', name: f.name ?? '?', cols: [] })), names: {}, i: 0, fetched: 0, toFetch: 1,
        counts: { adopted: 0, updated: 0, fresh: 0, no_nutrition: 0, failed: 0 }, failures: [], groups: [], groupNew: {}, cancel: false, started: Date.now(), finished: null, timer: null, error: null, pictures: true };
      bulkRun = run;
      run.timer = setTimeout(bulkStep, 600);
      return clone(bulkView());
    }
    if (p === 'cookidoo/import') {
      if (method === 'POST') { const b = body as { scope: 'all' | 'collection' | 'week'; collection?: string; regroup?: boolean }; return clone(bulkStart(b.scope, b.collection ?? null, b.regroup === true)); }
      if (method === 'DELETE') { if (bulkRun?.state === 'running') bulkRun.cancel = true; return undefined; }
      return clone(bulkView());
    }
    const ref = url.searchParams.get('ref') ?? (body as { recipe?: string } | undefined)?.recipe ?? '';
    const id = /^(?:https:\/\/cookidoo\.[a-z.]+\/recipes\/recipe\/(?:[A-Za-z-]+\/)?)?(r\d{3,10})\/?$/.exec(ref.trim())?.[1];
    if (!id) throw new ApiError(422, 'not a Cookidoo recipe id or recipe link');
    const recipe = ckRecipe(id);
    if (!recipe || recipe.fails) throw new ApiError(502, 'Cookidoo answered in an unexpected way (the unofficial interface may have changed)');
    if (!recipe.per) throw new ApiError(422, 'this recipe has no nutrition values per portion');
    const known = foods.find((f) => f.source === 'cookidoo' && f.external_id === `cookidoo:${id}`);
    if (p === 'cookidoo/recipe') return { id, name: recipe.name, portions: recipe.portions, per_portion: clone(recipe.per), extra: {}, complete: true, food_id: known?.id ?? null };
    if (p === 'cookidoo/adopt' && method === 'POST') {
      const food = known ?? cookidooFood(id, recipe.name, recipe.portions, recipe.per);
      const col = (body as { collection?: string }).collection;
      const coll = col ? COOKIDOO_COLLECTIONS.find((c) => c.id === col) : undefined;
      const made = coll ? sourceGroup(coll.id, coll.name) : null;
      if (made && (made.created || !known)) made.group.food_ids.add(food.id);
      return clone(food);
    }
  }
  // recipes from web pages: invented pages of `recipes.example.org`; any other address "cannot be fetched" (the same neutral answer for everything)
  if (p.startsWith('web-recipes')) {
    if (!mockConnectors.find((c) => c.key === 'web_recipes')!.enabled) throw new ApiError(404, 'the connector for recipes from web pages is switched off (admin area)');
    const reload = m(/^web-recipes\/(\d+)\/reload$/);
    const b = (body ?? {}) as { url?: string; whole?: boolean; portions?: number | null; name?: string };
    let address = b.url ?? '';
    let target: (typeof foods)[number] | undefined;
    if (reload) {
      target = foods.find((f) => f.id === Number(reload[1]) && f.source === 'web');
      if (!target) throw new ApiError(404, 'unknown web recipe');
      address = target.url ?? '';
    }
    const norm = normaliseWeb(address);
    if (typeof norm === 'string') throw new ApiError(422, norm);
    const page = WEB_PAGES[norm.key];
    if (!page && !NO_RECIPE.includes(norm.key)) throw new ApiError(502, 'the page could not be fetched');
    if (!page) throw new ApiError(422, 'no recipe data found on this page');
    const known = foods.find((f) => f.source === 'web' && f.external_id === `web:${norm.key}`);
    const opts = { whole: b.whole === true, portions: reload ? (target?.portions ?? null) : b.portions ?? null, name: reload ? (target?.name ?? undefined) : b.name };
    const item = interpretWeb(page, opts, norm.address, norm.host, known?.id ?? null);
    if (p === 'web-recipes/preview') return clone(item);
    if (item.blocked) throw new ApiError(422, ({ no_name: 'the recipe needs a name', no_energy: 'the page gives no energy value (kcal) for this recipe, so it is not taken over (it would count as 0 kcal)', too_high: 'the energy value per portion is not plausible', whole_needs_portions: 'the number of portions is needed' } as const)[item.blocked]);
    const data = { per_100: item.per_portion, portions: item.portions };
    const food = known ?? webFood(norm.key, { name: item.name, portions: item.portions }, item.per_portion);
    if (known) Object.assign(known, { name: item.name, per_100: data.per_100, portions: data.portions, fetched_at: Date.now() / 1000 });
    const gid = (body as { group_id?: number }).group_id;
    if (gid != null) groupRows.find((g) => g.id === gid)?.food_ids.add(food.id);
    return clone(food);
  }
  // what still fits today: the same rule as the server (mockSuggest.ts)
  if (p === 'recipes/suggestions' && method === 'GET') {
    const day = url.searchParams.get('date') ?? today();
    const focus = (url.searchParams.get('focus') ?? 'balanced') as SuggestFocus;
    const group = url.searchParams.get('group');
    const view = dayView(day);
    const g = view.goal;
    const goalKcal = g ? goalFor(day, g.kcal) : null;
    const rest = goalKcal == null || !g ? { kcal: null, protein: null, carbs: null, fat: null }
      : { kcal: Math.round((goalKcal - (view.totals.kcal ?? 0)) * 10) / 10, protein: g.protein ? Math.round((g.protein - (view.totals.protein ?? 0)) * 10) / 10 : null, carbs: g.carbs ? Math.round((g.carbs - (view.totals.carbs ?? 0)) * 10) / 10 : null, fat: g.fat ? Math.round((g.fat - (view.totals.fat ?? 0)) * 10) / 10 : null };
    const inGroup = (id: number) => (group == null ? true : group === 'none' ? !groupRows.some((x) => x.food_ids.has(id)) : groupRows.find((x) => String(x.id) === group)?.food_ids.has(id) === true);
    const pool = foods.filter((f) => ['recipe', 'cookidoo', 'web'].includes(f.source) && f.per_100.kcal != null && inGroup(f.id));
    const candidates = pool.map((f) => { const a = f.serving_quantity ?? 100; const k = a / 100; const n = (v: number | null) => (v == null ? null : v * k); return { id: f.id, kcal: (f.per_100.kcal as number) * k, protein: n(f.per_100.protein), carbs: n(f.per_100.carbs), fat: n(f.per_100.fat), portionAmount: a }; });
    const ago = new Map<number, number>();
    for (const [d, list] of entries) if (d <= day) for (const e of list) if (e.food_id != null) { const n = diffDays(d, day); if (!ago.has(e.food_id) || n < ago.get(e.food_id)!) ago.set(e.food_id, n); }
    const result = rankSuggestions(rest, candidates, ago, focus, Number(url.searchParams.get('limit') ?? 5), url.searchParams.get('anyway') === 'true');
    return clone({
      day, state: result.state, focus, goal_kcal: goalKcal, rest, candidates: candidates.length,
      items: result.items.map((r) => ({ food: foods.find((f) => f.id === r.id)!, portions: r.portions, amount: r.amount, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, after: r.after, reasons: r.reasons, score: r.score })),
    });
  }
  // recipe groups
  if (p === 'recipe-groups' && method === 'GET') return clone(sortedGroups().map(groupOut));
  if (p === 'recipe-groups' && method === 'POST') {
    const name = ((body as { name: string }).name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) throw new ApiError(422, 'a group needs a name');
    if (groupRows.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'a group with this name exists');
    return clone(groupOut(newGroup(name, null)));
  }
  if (p === 'recipe-groups/order' && method === 'PUT') {
    const ids = (body as { ids: number[] }).ids;
    if (ids.length !== groupRows.length || new Set(ids).size !== ids.length || !ids.every((i) => groupRows.some((g) => g.id === i))) throw new ApiError(422, 'the list must name every group exactly once');
    ids.forEach((id2, i) => { groupRows.find((g) => g.id === id2)!.position = i + 1; });
    return clone(sortedGroups().map(groupOut));
  }
  if ((r = m(/^recipe-groups\/foods\/(\d+)$/)) && method === 'PUT') {
    const foodId = Number(r[1]);
    const food = foods.find((f) => f.id === foodId);
    if (!food || !['recipe', 'cookidoo', 'web'].includes(food.source)) throw new ApiError(422, 'only recipes (own, from Cookidoo or from a web page) can be in a group');
    const ids = (body as { group_ids: number[] }).group_ids;
    if (ids.some((i) => !groupRows.some((g) => g.id === i))) throw new ApiError(404, 'unknown group');
    for (const g of groupRows) { if (ids.includes(g.id)) g.food_ids.add(foodId); else g.food_ids.delete(foodId); }
    return ids;
  }
  if ((r = m(/^recipe-groups\/(\d+)(\/members|\/members\/remove)?$/))) {
    const g = groupRows.find((x) => x.id === Number(r?.[1]));
    if (!g) throw new ApiError(404, 'unknown group');
    if (!r[2]) {
      if (method === 'DELETE') { groupRows.splice(groupRows.indexOf(g), 1); if (g.source) dismissedSources.add(g.source); return undefined; }
      const name = ((body as { name: string }).name ?? '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 60) throw new ApiError(422, 'a group needs a name');
      if (groupRows.some((x) => x !== g && x.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'a group with this name exists');
      g.name = name;
      return clone(groupOut(g));
    }
    const ids = (body as { food_ids: number[] }).food_ids;
    if (r[2] === '/members') {
      if (ids.some((i) => !['recipe', 'cookidoo', 'web'].includes(foods.find((f) => f.id === i)?.source ?? ''))) throw new ApiError(422, 'only recipes (own, from Cookidoo or from a web page) can be in a group');
      for (const i of ids) g.food_ids.add(i);
    } else for (const i of ids) g.food_ids.delete(i);
    return clone(groupOut(g));
  }
  if (p === 'catalog/adopt' && method === 'POST') {
    const ref = body as { source: string; code: string };
    const item = [...catalog, ...basics].find((c) => c.code === ref.code && c.source === ref.source);
    if (!item) throw new ApiError(404, 'unknown catalogue product');
    if (item.source === 'bls') {
      const known = foods.find((f) => f.id === adoptedBasics.get(item.code));
      if (known) return clone(known);
      const made = addFood(item.name, null, item.per_100, { extra: item.extra, code: null, source: 'bls', unit: 'g' });
      adoptedBasics.set(item.code, made.id);
      return clone(made);
    }
    const existing = foods.find((f) => f.code === item.code);
    if (existing) return clone(existing);
    return clone(addFood(item.name, item.brand, item.per_100, { extra: item.extra, code: item.code, source: 'openfoodfacts', unit: item.unit, quantity: item.quantity, serving_size: item.serving_size, serving_quantity: item.serving_quantity }));
  }
  if (p === 'me/goal' && method === 'PUT') { goal = { ...clone(body as Goal), water_ml: (body as Goal).water_ml ?? goal?.water_ml ?? 2000, steps: (body as Goal).steps ?? goal?.steps ?? 8000 }; return clone(goal); }
  if ((r = m(/^activity\/(\d{4}-\d{2}-\d{2})$/)) && method === 'PUT') {
    const b = body as Partial<Pick<ActivityRow, 'steps' | 'active_kcal' | 'distance_m'>>;
    const row: ActivityRow = { ...(activity.get(r[1]) ?? { steps: null, active_kcal: null, distance_m: null }), ...b, source: 'manual' };
    demoActivityDays.delete(r[1]);
    if (row.steps == null && row.active_kcal == null && row.distance_m == null) activity.delete(r[1]); else activity.set(r[1], row);
    return { day: r[1], ...dayActivity(r[1]) };
  }
  if (p === 'workouts' && method === 'POST') {
    const b = body as WorkoutIn;
    const kind = (b.kind in MET ? b.kind : 'other') as WorkoutKind;
    workoutRows.push({ id: nextWorkoutId++, day: b.day, started_at: b.started_at ?? null, kind, name: b.name ?? '', minutes: b.minutes, kcal: b.kcal ?? null, distance_m: b.distance_m ?? null, steps: null, note: b.note ?? null, source: 'manual' });
    return workoutOut(workoutRows[workoutRows.length - 1]);
  }
  if ((r = m(/^workouts\/(\d+)$/))) {
    const at = workoutRows.findIndex((w) => w.id === Number(r![1]));
    if (at < 0) throw new ApiError(404, 'unknown workout');
    if (method === 'DELETE') { workoutRows.splice(at, 1); return undefined; }
    if (method === 'PATCH') { Object.assign(workoutRows[at], body, { source: 'manual' }); demoWorkoutIds.delete(workoutRows[at].id); return workoutOut(workoutRows[at]); }
  }

  if ((r = m(/^water\/(\d{4}-\d{2}-\d{2})$/))) {
    const b = body as { add_ml?: number; ml?: number };
    const next = method === 'PUT' ? (b.ml ?? 0) : (water.get(r[1]) ?? 0) + (b.add_ml ?? 0);
    const ml = Math.max(0, Math.min(10000, next));
    water.set(r[1], ml);
    demoWaterDays.delete(r[1]);
    return { ml, goal_ml: goal?.water_ml ?? 2000 };
  }

  if (p.startsWith('fasting')) {
    const now = Math.floor(Date.now() / 1000);
    const out = (f: (typeof fasts)[number]) => {
      const elapsed = Math.max(0, (f.ended_at ?? now) - f.started_at);
      return { id: f.id, started_at: f.started_at, ended_at: f.ended_at, target_hours: f.target_hours, elapsed_seconds: elapsed,
        duration_seconds: f.ended_at == null ? null : elapsed, target_reached: elapsed >= f.target_hours * 3600 };
    };
    const open = () => fasts.find((f) => f.ended_at == null);
    if (p === 'fasting' && method === 'GET') {
      const recent = fasts.filter((f) => f.ended_at != null).sort((a, b) => (b.ended_at as number) - (a.ended_at as number)).slice(0, 14).map(out);
      const cur = open();
      return { current: cur ? out(cur) : null, last: recent[0] ?? null, recent };
    }
    if (p === 'fasting/start' && method === 'POST') {
      if (open()) throw new ApiError(409, 'a fast is already running');
      const b = (body ?? {}) as { started_at?: number; target_hours?: number };
      const f = { id: nextFastId++, started_at: b.started_at ?? now, ended_at: null, target_hours: b.target_hours ?? fastSettings.target_hours };
      fasts.push(f);
      return out(f);
    }
    if (p === 'fasting/stop' && method === 'POST') {
      const f = open();
      if (!f) throw new ApiError(409, 'no fast is running');
      f.ended_at = (body as { ended_at?: number } | undefined)?.ended_at ?? now;
      return out(f);
    }
    if ((r = m(/^fasting\/(\d+)$/))) {
      const idx = fasts.findIndex((f) => f.id === Number(r![1]));
      if (idx < 0) throw new ApiError(404, 'unknown fast');
      if (method === 'DELETE') { fasts.splice(idx, 1); return undefined; }
      Object.assign(fasts[idx], body as object);
      return out(fasts[idx]);
    }
  }

  if ((r = m(/^foods\/barcode\/(\d+)$/))) {
    const code = r[1];
    if (method === 'GET') {
      const food = foods.find((f) => f.code === code);
      if (food) return clone(food);
      if (code === '4000000000000') throw new ApiError(502, 'upstream');
      if (code === gtin('400100000072')) return { ...toFood({ name: '', per_100: {} }), id: 0, code, empty: true, source: 'openfoodfacts' };
      throw new ApiError(404, 'unknown');
    }
    if (method === 'PUT') {
      const existing = foods.find((f) => f.code === code);
      const food = toFood(body as FoodIn, existing);
      food.code = code;
      if (existing) foods[foods.indexOf(existing)] = food; else foods.unshift(food);
      return clone(food);
    }
  }
  // the picture of a recipe: an own photo (the mock draws a plate instead of keeping the file; nothing leaves the browser)
  if ((r = m(/^foods\/(\d+)\/image$/)) && (method === 'PUT' || method === 'DELETE')) {
    const food = foods.find((f) => f.id === Number(r?.[1]));
    if (!food) throw new ApiError(404, 'unknown food');
    if (!['recipe', 'cookidoo', 'web'].includes(food.source)) throw new ApiError(409, 'only recipes (own, from Cookidoo or from a web page) can have a picture');
    if (method === 'PUT') {
      if (!raw || raw.size === 0) throw new ApiError(422, 'empty body');
      food.image_removed = false;
      givePicture(food, 'own', null, 40 + Math.floor((raw.size % 997) + nextPlate));
    } else { if (food.image && food.image.origin !== 'own') food.image_removed = true; food.image = null; }
    const rec = recipes.find((x) => x.food.id === food.id);
    if (rec) rec.food = food;
    return clone(food);
  }
  if ((r = m(/^foods\/(\d+)\/image\/restore$/)) && method === 'POST') {
    const food = foods.find((f) => f.id === Number(r?.[1]));
    if (!food) throw new ApiError(404, 'unknown food');
    if (!food.image_removed) throw new ApiError(409, 'the picture of this recipe was not taken away');
    food.image_removed = false;
    givePicture(food, food.source === 'web' ? 'web' : 'cookidoo', food.source === 'web' ? (food.url ?? '').replace(/^https?:\/\//, '').split('/')[0] : 'Cookidoo');
    return clone(food);
  }
  if (p === 'foods/recent') {
    const seen = new Set<number>();
    const out: unknown[] = [];
    const all = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    for (const [, es] of all) for (const e of [...es].reverse()) {
      if (e.food_id == null || seen.has(e.food_id)) continue;
      const food = foods.find((f) => f.id === e.food_id);
      if (!food) continue;
      seen.add(e.food_id);
      out.push({ food, last_amount: e.amount, last_meal: e.meal });
    }
    return clone(out.slice(0, Number(url.searchParams.get('limit') ?? 20)));
  }
  if (p === 'foods' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const only = url.searchParams.get('source');
    const leaveOut = url.searchParams.getAll('exclude_source');
    return clone(foods.filter((f) => (!only || f.source === only) && !leaveOut.includes(f.source)).filter((f) => !query || [f.name, f.brand, f.code].some((v) => v?.toLowerCase().includes(query))));
  }
  if (p === 'foods' && method === 'POST') { const f = toFood(body as FoodIn); foods.unshift(f); return clone(f); }
  if ((r = m(/^foods\/(\d+)$/))) {
    const id = Number(r[1]);
    const food = foods.find((f) => f.id === id);
    if (!food) throw new ApiError(404, 'not found');
    if (method === 'GET') return clone(food);
    if (food.source === 'recipe' && method !== 'GET') throw new ApiError(409, 'this food is calculated from a recipe');
    if (method === 'PUT') { const f = toFood(body as FoodIn, food); foods[foods.indexOf(food)] = f; return clone(f); }
    if (method === 'DELETE') {
      foods.splice(foods.indexOf(food), 1);
      dropFromGroups(food.id);
      for (const es of entries.values()) for (const e of es) if (e.food_id === id) e.food_id = null;
      return undefined;
    }
  }
  if (p === 'vision/status') {
    const v = mockConnectors.find((c) => c.key === 'vision')!;
    const configured = v.info.model !== null;
    return { enabled: v.enabled, configured, ready: v.enabled && configured, per_hour: 30 };
  }
  if (p === 'vision/meal' || p === 'vision/recipe') {
    const v = mockConnectors.find((c) => c.key === 'vision')!;
    if (!v.enabled) throw new ApiError(404, 'photo recognition is switched off (admin area)');
    if (v.info.model === null) throw new ApiError(409, 'photo recognition is not configured (MAHLWERK_VISION_URL and MAHLWERK_VISION_MODEL)');
    await wait(1400); // a model takes a moment
    void raw;
    // ?vision=busy (429 with a wait), error (502), big (413), empty (nothing recognised): the failure cases of the capture screens
    const trouble = new URLSearchParams(location.search).get('vision');
    if (trouble === 'busy') throw new ApiError(429, 'too many photos lately, try again later', 8);
    if (trouble === 'error') throw new ApiError(502, 'the image model gave no usable answer');
    if (trouble === 'big') throw new ApiError(413, 'image too large');
    const de = url.searchParams.get('lang') === 'de';
    if (p === 'vision/meal') {
      if (trouble === 'empty') return { items: [], note: null };
      return {
        items: [
          { name: de ? 'Gekochte Kartoffeln' : 'Boiled potatoes', grams: 250, kcal: 190, protein_g: 5, fat_g: 0.3, carbs_g: 40, confidence: 0.82 },
          { name: de ? 'Grüne Bohnen' : 'Green beans', grams: 120, kcal: 38, protein_g: 2.2, fat_g: 0.2, carbs_g: 6.5, confidence: 0.64 },
          { name: de ? 'Gebratenes Hähnchenfilet' : 'Pan-fried chicken breast', grams: 140, kcal: 230, protein_g: 43, fat_g: 5.5, carbs_g: 0, confidence: 0.47 },
          { name: de ? 'Dunkle Soße' : 'Dark sauce', grams: null, kcal: null, protein_g: null, fat_g: null, carbs_g: null, confidence: 0.2 },
        ],
        note: de ? 'Mengen nach dem Augenmaß geschätzt.' : 'Amounts estimated by eye.',
      };
    }
    if (trouble === 'empty') return { name: null, portions: null, ingredients: [], nutrition_per_portion: null, note: null };
    recipePhotos += 1;
    if (recipePhotos % 2 === 0) { // the second photo of a recipe on two pages
      return {
        name: null, portions: null, nutrition_per_portion: null, note: null,
        ingredients: de ? ['1 EL Tomatenmark', '200 g Kürbis', '1 Prise Pfeffer'] : ['1 tbsp tomato paste', '200 g pumpkin', '1 pinch pepper'],
      };
    }
    return {
      name: de ? 'Gemüsesuppe' : 'Vegetable soup', portions: 4,
      ingredients: de ? ['2 Karotten', '1 Zwiebel', '300 g Kartoffeln', '1 l Gemüsebrühe', '2 EL Olivenöl', '1 TL Salz'] : ['2 carrots', '1 onion', '300 g potatoes', '1 l vegetable stock', '2 tbsp olive oil', '1 tsp salt'],
      nutrition_per_portion: { kcal: 160, protein_g: 4, fat_g: 6, carbs_g: 22 }, note: null,
    };
  }
  if (p === 'label-scans') {
    await wait(900);
    void raw;
    return { per_100: per(412, 21, 6.5, 44, 12, 3.1, 8.2, 0.9), basis: '100g', warnings: ['energy_mismatch'], text: 'Nährwerte pro 100 g\nBrennwert 1724 kJ / 412 kcal\nFett 21 g\nKohlenhydrate 44 g\nEiweiß 8,2 g' };
  }

  if ((r = m(/^diary\/(\d{4}-\d{2}-\d{2})$/))) return dayView(r[1]);
  if ((r = m(/^diary\/(\d{4}-\d{2}-\d{2})\/entries$/)) && method === 'POST') {
    const b = body as { food_id: number; meal: Meal; amount: number };
    const food = foods.find((f) => f.id === b.food_id);
    if (!food) throw new ApiError(404, 'food');
    if (!(b.amount > 0 && b.amount <= 5000)) throw new ApiError(422, 'amount');
    const list = entries.get(r[1]) ?? [];
    const e = makeEntry(food, b.meal, b.amount);
    list.push(e);
    entries.set(r[1], list);
    return clone(e);
  }
  if ((r = m(/^diary\/entries\/(\d+)$/))) {
    const id = Number(r[1]);
    for (const [, es] of entries) {
      const i = es.findIndex((e) => e.id === id);
      if (i < 0) continue;
      if (method === 'DELETE') { es.splice(i, 1); return undefined; }
      const patch = body as { amount?: number; meal?: Meal };
      const e = es[i];
      const k = patch.amount != null ? patch.amount / e.amount : 1;
      es[i] = {
        ...e, ...(patch.meal ? { meal: patch.meal } : {}), amount: patch.amount ?? e.amount,
        kcal: e.kcal == null ? null : Math.round(e.kcal * k * 10) / 10, protein: e.protein == null ? null : Math.round(e.protein * k * 10) / 10,
        carbs: e.carbs == null ? null : Math.round(e.carbs * k * 10) / 10, fat: e.fat == null ? null : Math.round(e.fat * k * 10) / 10,
      };
      return clone(es[i]);
    }
    throw new ApiError(404, 'entry');
  }

  if (p === 'templates' && method === 'GET') return clone(templates.map(templateOut).reverse());
  if (p === 'templates' && method === 'POST') {
    const b = body as { name: string; from: { day: string; meal: Meal } };
    const source = (entries.get(b.from.day) ?? []).filter((e) => e.meal === b.from.meal);
    if (!source.length) throw new ApiError(404, 'that meal has no entries');
    const name = b.name.trim();
    if (!name || name.length > 80) throw new ApiError(422, 'name');
    const tpl = { id: nextTemplateId++, name, items: clone(source) };
    templates.push(tpl);
    return templateOut(tpl);
  }
  if ((r = m(/^templates\/(\d+)$/))) {
    const i = templates.findIndex((x) => x.id === Number(r?.[1]));
    if (i < 0) throw new ApiError(404, 'unknown template');
    if (method === 'DELETE') { templates.splice(i, 1); return undefined; }
    const name = (body as { name: string }).name.trim();
    if (!name || name.length > 80) throw new ApiError(422, 'name');
    templates[i].name = name;
    return templateOut(templates[i]);
  }
  if ((r = m(/^templates\/(\d+)\/apply$/)) && method === 'POST') {
    const tpl = templates.find((x) => x.id === Number(r?.[1]));
    if (!tpl) throw new ApiError(404, 'unknown template');
    const b = body as { day: string; meal: Meal };
    return { entries: addCopies(b.day, tpl.items, b.meal) };
  }
  if ((r = m(/^diary\/(\d{4}-\d{2}-\d{2})\/copy$/)) && method === 'POST') {
    const b = body as { from_day: string; meal?: Meal; to_meal?: Meal };
    if (b.from_day === r[1] && !b.to_meal) throw new ApiError(422, 'from_day equals day');
    const source = (entries.get(b.from_day) ?? []).filter((e) => !b.meal || e.meal === b.meal);
    if (!source.length) throw new ApiError(404, 'nothing to copy');
    return { entries: addCopies(r[1], source, b.to_meal) };
  }
  if (p === 'recipes/ingredients/match' && method === 'POST') {
    const text = (body as { text?: string })?.text;
    if (typeof text !== 'string') throw new ApiError(422, 'text is required');
    const rows = text.split(/\r?\n/);
    if (text.length > 20000 || rows.length > 200 || rows.some((l) => l.length > 300)) throw new ApiError(422, 'too long');
    return clone(mockMatch(text, { own: foods, catalog: [...basics, ...catalog] }));
  }
  if (p === 'recipes' && method === 'GET') return clone(recipes.map(recipeOut).reverse());
  if (p === 'recipes' && method === 'POST') {
    const b = body as RecipeIn;
    const food = recipeCalc(b);
    const rec = { id: nextRecipeId++, food, portions: b.portions, total_weight: b.total_weight ?? null, items: clone(b.items) };
    foods.unshift(food);
    recipes.push(rec);
    return clone(recipeOut(rec));
  }
  if ((r = m(/^recipes\/(\d+)$/))) {
    const rec = recipes.find((x) => x.id === Number(r?.[1]));
    if (!rec) throw new ApiError(404, 'unknown recipe');
    if (method === 'GET') return clone(recipeOut(rec));
    if (method === 'DELETE') {
      recipes.splice(recipes.indexOf(rec), 1);
      foods.splice(foods.indexOf(rec.food), 1);
      dropFromGroups(rec.food.id);
      for (const es of entries.values()) for (const e of es) if (e.food_id === rec.food.id) e.food_id = null;
      return undefined;
    }
    const b = body as RecipeIn;
    const food = recipeCalc(b, rec.food);
    foods[foods.indexOf(rec.food)] = food;
    Object.assign(rec, { food, portions: b.portions, total_weight: b.total_weight ?? null, items: clone(b.items) });
    return clone(recipeOut(rec));
  }
  if (p === 'history') {
    const n = Number(url.searchParams.get('days') ?? 14);
    return Array.from({ length: n }, (_, i) => {
      const d = shiftDay(today(), i - n + 1);
      const v = dayView(d);
      return { day: d, kcal: v.totals.kcal, protein: v.totals.protein, carbs: v.totals.carbs, fat: v.totals.fat, logged: (entries.get(d) ?? []).length > 0 };
    });
  }
  if (p === 'insights') {
    const sp = url.searchParams;
    const span = [...entries.keys()].filter((d) => (entries.get(d) ?? []).length).sort();
    const to = sp.get('to') ?? (sp.get('range') === 'all' && span.length ? span[span.length - 1] : today());
    const from = sp.get('from') ?? (sp.get('range') === 'all' && span.length ? span[0] : shiftDay(to, -29));
    return insights(from, to, sp.get('granularity'), sp.get('compare') === 'previous');
  }
  if (p === 'insights/nutrient') {
    const sp = url.searchParams;
    return mockNutrient(sp.get('key') ?? 'kcal', sp.get('from') ?? shiftDay(today(), -29), sp.get('to') ?? today(), sp.get('granularity') ?? 'auto');
  }
  if (p === 'insights/foods') {
    const sp = url.searchParams;
    const { groups, total } = foodStats(sp.get('from') ?? shiftDay(today(), -29), sp.get('to') ?? today());
    const needle = (sp.get('q') ?? '').toLowerCase();
    const sort = sp.get('sort') ?? 'kcal';
    const hit = groups.filter((g) => !needle || g.name.toLowerCase().includes(needle) || (g.brand ?? '').toLowerCase().includes(needle));
    hit.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'last' ? (a.last_day < b.last_day ? 1 : -1) : sort === 'times' ? b.times - a.times : sort === 'amount' ? b.amount_total - a.amount_total : b.kcal_total - a.kcal_total));
    const limit = Number(sp.get('limit') ?? 25), offset = Number(sp.get('offset') ?? 0);
    return { range: { from: sp.get('from'), to: sp.get('to') }, total: hit.length, offset, limit, kcal_total: Math.round(total), items: hit.slice(offset, offset + limit).map(({ dates: _d, ...g }) => g) };
  }
  if (p === 'insights/foods/detail') {
    const sp = url.searchParams;
    const from = sp.get('from') ?? shiftDay(today(), -29), to = sp.get('to') ?? today();
    const g = foodStats(from, to).groups.find((x) => x.key === sp.get('key'));
    if (!g) throw new ApiError(404, 'no entries');
    const rows: { d: string; e: Entry }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) for (const e of entries.get(d) ?? []) if ((e.food_id != null ? `id:${e.food_id}` : `n:${e.name}|${e.brand ?? ''}`) === g.key) rows.push({ d, e });
    const months = [...new Set(Array.from({ length: diffDays(from, to) + 1 }, (_, i) => addDays(from, i).slice(0, 7)))];
    const meals: Meal[] = ['breakfast', 'lunch', 'dinner', 'snack'];
    const amounts = new Map<number, number>();
    for (const r of rows) amounts.set(r.e.amount, (amounts.get(r.e.amount) ?? 0) + 1);
    const { dates: _d, share: _s, avg_amount: _a, ...head } = g;
    return {
      ...head, range: { from, to },
      monthly: months.map((m) => { const rs = rows.filter((r) => r.d.startsWith(m)); return { month: m, times: rs.length, amount: rs.reduce((a, r) => a + r.e.amount, 0), kcal: rs.reduce((a, r) => a + num(r.e.kcal), 0) }; }),
      by_meal: meals.map((m) => ({ meal: m, times: rows.filter((r) => r.e.meal === m).length, share: rows.filter((r) => r.e.meal === m).length / rows.length })),
      by_weekday: Array.from({ length: 7 }, (_, i) => { const n = rows.filter((r) => (fromDay(r.d).getDay() + 6) % 7 === i).length; return { weekday: i, times: n, share: n / rows.length }; }),
      usual_amounts: [...amounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([amount, times]) => ({ amount, times })),
    };
  }
  if (p === 'weights') {
    const n = Number(url.searchParams.get('days') ?? 90);
    const from = shiftDay(today(), -(n - 1));
    return [...weights.entries()].filter(([d]) => d >= from).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, kg]) => ({ day, kg }));
  }
  if ((r = m(/^weights\/(\d{4}-\d{2}-\d{2})$/))) {
    if (method === 'DELETE') { weights.delete(r[1]); return undefined; }
    const kg = (body as { kg: number }).kg;
    if (!(kg >= 20 && kg <= 400)) throw new ApiError(422, 'kg');
    weights.set(r[1], kg);
    return { day: r[1], kg };
  }
  void fromDay;
  throw new ApiError(404, `mock: ${method} ${path}`);
}

// Types of the API v1 contract (docs/api-v1.md).

export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEALS: Meal[] = ['breakfast', 'lunch', 'snack', 'dinner'];

export interface Per100 {
  kcal: number | null;
  fat: number | null;
  saturated_fat: number | null;
  carbs: number | null;
  sugars: number | null;
  fiber: number | null;
  protein: number | null;
  salt: number | null;
}
export type NutrientKey = keyof Per100;

/** Additional nutrients per 100 g/ml by directory key; a missing key means unknown. */
export type Extra = Record<string, number>;
export type NutrientGroup = 'fat' | 'carb' | 'mineral' | 'vitamin' | 'other';
export type NutrientUnit = 'g' | 'mg' | 'µg';
/** One row of GET /nutrients; the names come from i18n (`n_<key>`). */
export interface NutrientInfo {
  key: string;
  group: NutrientGroup;
  unit: NutrientUnit;
  nrv: number | null;
}

/** The picture of a recipe (own or taken over); the files are at `api/v1/images/<hash>/<size>`, sizes `l`, `m`, `s`. */
export interface FoodImage {
  hash: string;
  /** `own`: a photo somebody set; `cookidoo` / `web`: fetched once from the provider. */
  origin: 'own' | 'cookidoo' | 'web';
  /** Whose picture it is, for a provider picture: `Cookidoo` or the host of the page. */
  credit: string | null;
}

export interface Food {
  id: number;
  code: string | null;
  source: 'openfoodfacts' | 'own' | 'recipe' | 'yazio' | 'bls' | 'cookidoo' | 'web';
  /** The recipe this food is calculated from (source `recipe`). */
  recipe_id: number | null;
  /** Id in the system the food came from (`cookidoo:<recipe id>`, `web:<host><path>`, `bls:<code>`). */
  external_id?: string | null;
  /** Portions the dish makes (sources `cookidoo` and `web`; their values are per portion). */
  portions?: number | null;
  /** The recipe at Cookidoo (source `cookidoo`, only when the region is known). */
  url?: string | null;
  name: string | null;
  brand: string | null;
  quantity: string | null;
  serving_size: string | null;
  serving_quantity: number | null;
  unit: 'g' | 'ml';
  per_100: Per100;
  extra: Extra;
  complete: boolean;
  empty: boolean;
  cached: boolean;
  stale: boolean;
  fetched_at: number;
  image?: FoodImage | null;
  /** A person took the provider's picture away (it can be restored while the picture switch of the connector is on). */
  image_removed?: boolean;
}

/** A packaged product (Open Food Facts) or basic food (BLS) of the local catalogue; it gets an id once it is adopted as a Food. */
export interface CatalogItem {
  source: 'openfoodfacts' | 'bls';
  code: string;
  name: string;
  /** English name, basic foods only. */
  name_en?: string | null;
  brand: string | null;
  quantity: string | null;
  serving_size: string | null;
  serving_quantity: number | null;
  unit: 'g' | 'ml';
  per_100: Per100;
  extra: Extra;
  complete: boolean;
}

export interface FoodIn {
  name: string;
  brand?: string | null;
  quantity?: string | null;
  serving_size?: string | null;
  serving_quantity?: number | null;
  unit?: 'g' | 'ml';
  per_100: Partial<Per100>;
  extra?: Extra;
}

export interface Goal {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Daily water goal in ml (500–6000). */
  water_ml: number;
  /** Daily steps goal (1000–50000, default 8000). */
  steps: number;
}

export const WORKOUT_KINDS = [
  'walking', 'running', 'cycling', 'hiking', 'swimming', 'strength', 'yoga', 'pilates', 'crosstrainer', 'stairs', 'circuit',
  'squash', 'bowling', 'dancing', 'football', 'tennis', 'skiing', 'rowing', 'other',
] as const;
export type WorkoutKind = (typeof WORKOUT_KINDS)[number];
/** Where a day's values or a workout come from. */
export type ActivitySource = 'manual' | 'health' | 'yazio' | 'demo';

export interface Workout {
  id: number;
  day: string;
  /** Unix seconds; null when the start is unknown. */
  started_at: number | null;
  kind: WorkoutKind;
  /** Free description, may be empty. */
  name: string;
  minutes: number;
  /** Given, or (kcal_estimated) MET x weight x hours. */
  kcal: number;
  kcal_estimated: boolean;
  distance_m: number | null;
  steps: number | null;
  note: string | null;
  source: ActivitySource;
}

export interface WorkoutIn {
  day: string;
  kind: WorkoutKind;
  name?: string | null;
  minutes: number;
  kcal?: number | null;
  distance_m?: number | null;
  started_at?: number | null;
  note?: string | null;
}

export interface DayActivity {
  steps: number | null;
  steps_goal: number;
  active_kcal: number | null;
  distance_m: number | null;
  source: ActivitySource | null;
  /** kcal this day adds to the calorie goal (0 unless the setting is on). */
  bonus_kcal: number;
  workouts: Workout[];
}

export interface ActivityDayOut extends DayActivity { day: string }

export interface Entry {
  id: number;
  food_id: number | null;
  meal: Meal;
  name: string | null;
  brand: string | null;
  amount: number;
  unit: 'g' | 'ml';
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface Day {
  day: string;
  goal: Goal | null;
  /** The calorie goal that counts today: goal.kcal plus the active energy when the setting is on. */
  kcal_goal: number | null;
  activity: DayActivity;
  /** Water drunk that day and the daily goal, both in ml. */
  water: { ml: number; goal_ml: number };
  totals: Partial<Per100>;
  extra_totals: Record<string, { amount: number; coverage: number }>;
  meals: Record<Meal, { kcal: number; entries: Entry[] }>;
  streak: number;
  week: { day: string; logged: boolean; kcal: number }[];
  /** Meals of the previous day that had entries (for "same as yesterday"). */
  yesterday: Partial<Record<Meal, { kcal: number; names: string[] }>>;
}

export interface FastingSettings {
  enabled: boolean;
  /** Target in hours, 8–72. */
  target_hours: number;
}

export interface ActivitySettings {
  /** Add the day's active energy to its calorie goal. */
  add_to_goal: boolean;
}

export interface Settings {
  /** Badges, celebration moment and the weekly review card on the day view. */
  playful: boolean;
  fasting: FastingSettings;
  activity: ActivitySettings;
  /** The first-run tour of the day view was shown (or skipped). */
  tour_seen: boolean;
  /** The day view shows the card "what still fits today" (the API answers either way). */
  suggestions: boolean;
}

export interface SettingsPatch {
  playful?: boolean;
  tour_seen?: boolean;
  suggestions?: boolean;
  fasting?: Partial<FastingSettings>;
  activity?: Partial<ActivitySettings>;
}

/** One fast. Times are Unix seconds (UTC); the open fast has `ended_at` null. */
export interface Fast {
  id: number;
  started_at: number;
  ended_at: number | null;
  target_hours: number;
  elapsed_seconds: number;
  duration_seconds: number | null;
  target_reached: boolean;
}

export interface Fasting {
  current: Fast | null;
  last: Fast | null;
  recent: Fast[];
}

export interface DemoAccountState {
  can_switch: boolean;
  viewing: boolean;
  /** While `viewing`: the admin who is really signed in. */
  real_username: string | null;
  real_display_name: string | null;
}
export interface Me {
  /** Sign-in name; cannot be changed. */
  username: string;
  /** The name shown: the one the user chose, else the provider's, else the user name. */
  display_name: string | null;
  /** The user chose `display_name` themself (it is then kept over the provider's name). */
  display_name_custom?: boolean;
  /** The name the provider delivered, when it differs from `display_name` (for "reset to ..."). */
  provider_name?: string | null;
  /** May open the admin area (decided by the server for each request). */
  is_admin?: boolean;
  goal: Goal | null;
  settings: Settings;
  demo: { available: boolean; entries: number; weights: number; water: number; activity?: number; workouts?: number };
  /** The built-in demo account: an admin may switch to it (`can_switch`); while switched, this answer is the demo account's (`viewing`). */
  demo_account?: DemoAccountState;
  catalog: { products: number; updated_at: number | null; bls: { products: number; updated_at: number | null } };
  /** Integrations the admin has switched on; the profile hides the cards of switched-off ones. */
  features?: { access_tokens: boolean; webhooks: boolean; cookidoo?: boolean; web_recipes?: boolean };
}

/** One import run (see `python -m mahlwerk.yazio`); the counts are what the run created. */
export interface ImportBatch {
  id: number;
  kind: 'yazio';
  /** Unix seconds. */
  created_at: number;
  counts: {
    days: number; entries: number; product_entries: number; recipe_entries: number; quick_entries: number;
    foods: number; weights: number; water: number; goal_set: boolean; activity_days?: number; workouts?: number;
  };
}

export interface ImportRemoved { entries: number; weights: number; water: number; foods: number; goal: boolean; activity?: number; workouts?: number }

export interface DemoResult {
  entries: number;
  weights: number;
  water: number;
  foods: number;
  activity?: number;
  workouts?: number;
}

export interface RecentFood {
  food: Food;
  last_amount: number;
  last_meal: Meal;
}

export interface HistoryDay {
  day: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  logged: boolean;
}

export interface WeightPoint {
  day: string;
  kg: number;
}

export interface LabelScan {
  per_100: Partial<Per100>;
  basis: string | null;
  warnings: string[];
  text: string;
}

/** GET vision/status: what the capture screen needs to know (no address, no key). */
export interface VisionState { enabled: boolean; configured: boolean; ready: boolean; per_hour: number }
/** One recognised part of a meal; amounts and values are ESTIMATES for the amount in the photo, every number may be missing. */
export interface VisionMealItem { name: string; grams: number | null; kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null; confidence: number | null }
export interface VisionMeal { items: VisionMealItem[]; note: string | null }
export interface VisionRecipe {
  name: string | null; portions: number | null; ingredients: string[];
  nutrition_per_portion: { kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null } | null; note: string | null;
}

export interface InsightDay {
  day: string;
  logged: boolean;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  sugars: number;
  fiber: number;
  salt: number;
  saturated_fat: number;
  weight: number | null;
  /** Water drunk that day; null without a value. */
  water_ml: number | null;
  steps: number | null;
  active_kcal: number | null;
  workout_minutes: number;
  /** The day's calorie goal (with the active energy when the setting is on). */
  goal_kcal: number | null;
}

export interface InsightFood {
  name: string;
  brand: string | null;
  amount_total: number;
  value: number;
  share: number;
  times: number;
}

export type TopMetric = 'kcal' | 'sugars' | 'salt' | 'protein';

export interface InsightHint {
  code: string;
  params: Record<string, string | number | string[] | null>;
}

export interface InsightMicro {
  key: string;
  group: NutrientGroup;
  unit: NutrientUnit;
  nrv: number | null;
  average: number;
  coverage: number;
  percent_nrv: number | null;
}

export type Granularity = 'day' | 'week' | 'month';
export type Averages = Record<'kcal' | 'protein' | 'carbs' | 'fat' | 'sugars' | 'fiber' | 'salt' | 'saturated_fat' | 'water_ml' | 'steps' | 'active_kcal' | 'workout_minutes', number>;
export type Adherence = { in_range_days: number; over_days: number; under_days: number };
export type InsightWeight = { first: number; last: number; change: number; trend: { day: string; kg: number }[]; raw?: { day: string; kg: number }[] };

/** One section (day, ISO week or month) of the range: means per logged day. */
export interface Section {
  start: string;
  end: string;
  /** day: the date; week: "2026-W07"; month: "2026-02" */
  label_key: string;
  logged_days: number;
  days: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  sugars: number;
  fiber: number;
  salt: number;
  saturated_fat: number;
  water_ml: number | null;
  weight: number | null;
  /** Mean per day with a value; null without any. */
  steps: number | null;
  active_kcal: number | null;
  /** Sum of the section. */
  workout_minutes: number;
  /** Mean calorie goal of the logged days. */
  goal_kcal: number | null;
  in_range_days: number;
  over_days: number;
  under_days: number;
}

export type CalendarState = 'none' | 'under' | 'in_range' | 'over' | 'no_goal';

export interface Expenditure {
  kcal: number;
  low: number;
  high: number;
  intake: number;
  weight_change_kg: number;
  kg_per_week: number;
  days: number;
  weigh_ins: number;
  goal_gap: number | null;
}

export interface Delta { abs: number; pct: number | null }
export type DeltaKey = 'kcal' | 'protein' | 'carbs' | 'fat' | 'sugars' | 'fiber' | 'salt' | 'water_ml' | 'steps' | 'active_kcal' | 'workout_minutes' | 'weight_change' | 'in_range_share';

export interface InsightRange { from: string; to: string; days: number; logged_days: number }

export interface Insights {
  range: InsightRange;
  first_day?: string | null;
  last_day?: string | null;
  granularity?: Granularity;
  goal: Goal | null;
  /** Mean calorie goal of the logged days; differs from goal.kcal only when active energy is added. */
  goal_kcal?: number | null;
  steps_goal?: number;
  days: InsightDay[];
  series?: Section[];
  calendar?: { day: string; state: CalendarState }[];
  expenditure?: Expenditure | null;
  expenditure_missing?: string[];
  previous?: { range: InsightRange; averages: Averages; adherence: Adherence | null; weight: InsightWeight | null; logged_days: number; series: Section[] } | null;
  deltas?: Record<DeltaKey, Delta | null> | null;
  averages: Averages;
  by_weekday: { weekday: number; logged_days: number; kcal: number }[];
  by_meal: { meal: Meal; kcal: number; share: number }[];
  top_foods: Record<TopMetric, InsightFood[]>;
  weight: InsightWeight | null;
  adherence: Adherence | null;
  micros: InsightMicro[];
  hints: InsightHint[];
}

export interface NutrientCurve {
  key: string;
  group: 'core' | NutrientGroup;
  unit: string;
  nrv: number | null;
  goal: number | null;
  range: InsightRange;
  granularity: Granularity;
  has_data: boolean;
  series: { start: string; end: string; average: number | null; coverage: number }[];
}

export type FoodSort = 'kcal' | 'times' | 'amount' | 'last' | 'name';
export interface FoodStat {
  key: string;
  food_id: number | null;
  name: string;
  brand: string | null;
  times: number;
  days: number;
  amount_total: number;
  unit: 'g' | 'ml';
  kcal_total: number;
  share: number;
  avg_amount: number;
  first_day: string;
  last_day: string;
}
export interface FoodList { range: { from: string; to: string }; total: number; offset: number; limit: number; kcal_total: number; items: FoodStat[] }
export interface FoodDetail extends Omit<FoodStat, 'share' | 'avg_amount'> {
  range: { from: string; to: string };
  monthly: { month: string; times: number; amount: number; kcal: number }[];
  by_meal: { meal: Meal; times: number; share: number }[];
  by_weekday: { weekday: number; times: number; share: number }[];
  usual_amounts: { amount: number; times: number }[];
}

export interface TemplateItem {
  name: string;
  brand: string | null;
  amount: number;
  unit: 'g' | 'ml';
  kcal: number | null;
}

export interface Template {
  id: number;
  name: string;
  kcal: number;
  items: TemplateItem[];
}

export interface RecipeItem {
  food_id: number | null;
  name: string;
  brand: string | null;
  amount: number;
  unit: 'g' | 'ml';
  kcal: number | null;
}

export interface Recipe {
  id: number;
  food: Food;
  portions: number;
  total_weight: number | null;
  items: RecipeItem[];
  kcal_per_portion: number | null;
}

export interface RecipeIn {
  name: string;
  portions: number;
  total_weight?: number | null;
  items: { food_id: number; amount: number }[];
}

/** A food that may be meant by a pasted ingredient line: a stored one (`food_id`) or a catalogue item that is stored when it is taken over (`source` + `code`). */
export interface IngredientCandidate {
  source: 'own' | 'openfoodfacts' | 'bls' | 'yazio';
  food_id: number | null;
  code: string | null;
  name: string;
  brand: string | null;
  unit: 'g' | 'ml';
  per_100: Per100;
}

/** One line of a pasted ingredient list, read by the server (`POST /recipes/ingredients/match`). */
export interface IngredientLine {
  line: number;
  text: string;
  quantity: number | null;
  unit: string | null;
  name: string;
  note: string | null;
  optional: boolean;
  grams: number | null;
  ml: number | null;
  /** grams rests on an assumption (typical piece weight, assumed density, a cup of uncertain size). */
  estimated: boolean;
  basis: 'mass' | 'volume' | 'explicit' | 'piece' | 'unit' | 'none';
  candidates: IngredientCandidate[];
  suggestion: IngredientCandidate | null;
}

export interface IngredientMatches { lines: IngredientLine[]; ignored: number }

export type BadgeCode =
  | 'first_entry' | 'streak_3' | 'streak_7' | 'streak_30' | 'streak_100' | 'scans_10' | 'scans_50' | 'first_recipe'
  | 'protein_week' | 'balanced_week' | 'fiber_5' | 'weigh_in_4' | 'full_day_10';

export interface Badges {
  earned: { code: BadgeCode; earned_at: number; seen: boolean }[];
  open: { code: BadgeCode; progress: { current: number; target: number } }[];
  new: BadgeCode[];
}

export interface ReviewHighlight {
  code: string;
  params: Record<string, number>;
}

export interface Review {
  week: string;
  from: string;
  to: string;
  logged_days: number;
  kcal_avg: number;
  goal: Goal | null;
  days: { day: string; logged: boolean; kcal: number; state: 'in' | 'over' | 'under' | null }[];
  best: ReviewHighlight | null;
  improve: ReviewHighlight | null;
  /** Badge codes first reached during the week; `quiet_week` marks a week with too few entries. */
  badges: string[];
}

// ---- integrations and admin area ----

export type TokenScope = 'read' | 'write';
export interface AccessToken {
  id: number;
  name: string;
  /** The first characters of the key, to recognise it in the list. */
  prefix: string;
  scope: TokenScope;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}
/** The response to creating a key: the only time the clear text exists. */
export interface AccessTokenCreated extends AccessToken { token: string }

export const WEBHOOK_EVENTS = [
  'entry.created', 'entry.updated', 'entry.deleted', 'weight.recorded', 'water.changed',
  'fasting.started', 'fasting.ended', 'goal.changed', 'badge.earned', 'activity.recorded', 'workout.created',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export interface Webhook {
  id: number;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  created_at: number;
}
export interface WebhookCreated extends Webhook { secret: string }
export interface WebhookIn { name: string; url: string; events: WebhookEvent[]; enabled?: boolean }
export interface WebhookDelivery {
  id: number;
  event: string;
  status_code: number | null;
  error: string | null;
  attempts: number;
  created_at: number;
  /** null while it is still being tried. */
  finished_at: number | null;
}

export interface AdminOverview {
  version: string;
  auth_mode: 'single' | 'proxy' | 'local' | 'oidc';
  db_size_bytes: number;
  schema_version: number;
  users: number;
  entries: number;
  foods: number;
  catalog: Me['catalog'];
}
export interface AdminUser {
  username: string;
  display_name: string;
  created_at: number;
  entries: number;
  first_day: string | null;
  last_day: string | null;
  tokens: number;
  webhooks: number;
  /** Local sign-in mode only (false in the other modes). */
  disabled: boolean;
  admin: boolean;
  has_password: boolean;
  /** oidc mode only: signed in through the provider at least once. */
  sso?: boolean;
  /** The built-in demo account (invented data, nobody signs in as it). */
  demo?: boolean;
}
export type SignInMode = 'single' | 'proxy' | 'local' | 'oidc';
export interface AuthStatus {
  mode: SignInMode;
  /** Local mode: nobody has a password yet, the first admin can be created. */
  setup_required: boolean;
  /** The database already holds users: the setup needs the setup code (environment variable or server log). */
  setup_code_required?: boolean;
  /** oidc mode: the provider's name for the sign-in button (null: none configured). */
  oidc_label?: string | null;
  authenticated: boolean;
  username: string | null;
  display_name: string | null;
  is_admin: boolean | null;
}
export interface Account {
  username: string;
  display_name: string;
  is_admin: boolean;
  disabled?: boolean;
}
export type ConnectorKey =
  | 'openfoodfacts_lookup' | 'openfoodfacts_catalog' | 'bls' | 'yazio_import' | 'yazio_login' | 'label_reader' | 'demo_data' | 'demo_account' | 'access_tokens' | 'webhooks' | 'cookidoo' | 'web_recipes' | 'vision';
export interface Connector {
  key: ConnectorKey;
  kind: 'source' | 'import' | 'interface';
  enabled: boolean;
  status: string;
  configurable: boolean;
  /** Settings fixed by an environment variable: `enabled` or `config.<name>`. */
  locked: string[];
  config: { countries?: string[]; hosts?: string[]; personal?: boolean; images?: boolean };
  info: Record<string, unknown>;
}
/** One line of the technical notes of a connector card: a sentence, a command or variable (mono, with a copy button), or both. */
export interface TechItem { text?: string; cmd?: string }
export interface RefreshState {
  state: 'idle' | 'running' | 'done' | 'error';
  started_at: number | null;
  finished_at: number | null;
  progress: string | null;
  countries: string[];
  result: { rows_read: number; products: number; seconds: number; truncated: boolean } | null;
  error: string | null;
}

/** Cookidoo connector (see docs/api-v1.md): the shared account's meal plan, collections and one recipe's values per portion. */
export interface CookidooRecipeRef { id: string; name: string }
export interface CookidooPlanDay { day: string; title: string; recipes: CookidooRecipeRef[] }
export interface CookidooCollection { id: string; name: string; managed: boolean; recipes: CookidooRecipeRef[] }
export interface CookidooPreview {
  id: string;
  name: string;
  portions: number | null;
  per_portion: Per100;
  extra: Record<string, number>;
  complete: boolean;
  /** The food it already is here, if it was taken over before. */
  food_id: number | null;
}

/** What "take over" would do for a selection (collection, week or everything) and the run that does it in the background. */
export type CookidooBulkScope = 'all' | 'collection' | 'week';
export interface CookidooBulkPreview {
  total: number;
  fresh: number;
  to_fetch: number;
  eta_seconds: number;
  seconds_per_recipe: number;
  limit: number;
  groups: { collection: string; name: string; exists: boolean; dismissed: boolean }[];
}
/** What a picture catch-up would do (GET cookidoo/images/preview). */
export interface CookidooPicturePreview { enabled: boolean; total: number; to_fetch: number; eta_seconds: number; limit: number }
export interface CookidooBulkRun {
  state: 'running' | 'done' | 'cancelled' | 'error';
  cancelling: boolean;
  scope: CookidooBulkScope | 'pictures';
  /** `pictures`: the catch-up for the pictures of recipes taken over before. */
  mode?: 'recipes' | 'pictures';
  pictures?: number;
  no_picture?: number;
  total: number;
  done: number;
  fetched: number;
  adopted: number;
  updated: number;
  fresh: number;
  no_nutrition: number;
  failed: number;
  current: string | null;
  failures: { id: string; name: string; kind: string; reason: string }[];
  groups: string[];
  error: string | null;
  error_kind: string | null;
  reason: string | null;
  reason_kind: 'user' | 'account' | 'off' | 'shutdown' | null;
  eta_seconds: number;
  started_at: number;
  finished_at: number | null;
}

/** A group of recipes (own and Cookidoo recipes alike); `food_ids` are food ids (an own recipe's is `Recipe.food.id`). */
export interface RecipeGroup { id: number; name: string; position: number; auto: boolean; count: number; food_ids: number[] }

/** A Cookidoo account as the server describes it: never the password, the e-mail address masked. */
export interface CookidooAccount {
  /** env: fixed by the environment; stored: set in the app; none; unreadable: stored but the key is missing or does not fit. */
  source: 'env' | 'stored' | 'none' | 'unreadable';
  email: string | null;
  country: string | null;
  language: string | null;
  editable: boolean;
  /** Own accounts are allowed (admin switch). */
  allowed: boolean;
  /** Admin view only: where the key for stored secrets comes from. */
  key: 'env' | 'file' | 'none' | 'invalid' | null;
  error: string | null;
}
export type CookidooScope = 'shared' | 'own';

/** The Yazio import in the app: files waiting for a preview, and the direct one-time sign-in. */
export interface YazioStage { token: string; source: 'upload' | 'login'; files: Record<string, number> }
export interface YazioRun { state: 'running' | 'done' | 'error' | 'cancelled'; phase: string; done: number; total: number; requests: number; error: string | null; error_kind: string | null }
export interface YazioState {
  stage: YazioStage | null;
  login: { enabled: boolean; available: boolean; run: YazioRun | null; max_months: number; default_months: number };
  max_file_bytes: number;
}
export interface YazioPreview {
  token: string;
  days: number;
  entries: { product: number; recipe: number; quick: number };
  entries_total: number;
  foods_created: number;
  foods_reused: number;
  weights: number;
  weights_kept: number;
  water: number;
  water_kept: number;
  activity_days: number;
  activity_kept: number;
  workouts: number;
  workouts_already: number;
  goal_set: boolean;
  already_imported: number;
  skipped: { reason: string; count: number }[];
  notes: { text: string; count: number }[];
  unknown_keys: number;
  dropped_values: number;
  missing_files: string[];
  batch_id: number | null;
  dry_run: boolean;
}

/** Recipes from web pages (see docs/api-v1.md): what a page says, as it would be taken over. Ingredient lines are for looking at only. */
export interface WebPreview {
  url: string;
  host: string;
  name: string;
  portions: number | null;
  page_portions: number | null;
  per_portion: Per100;
  extra: Record<string, number>;
  complete: boolean;
  whole: boolean;
  serving_size: string;
  ingredients: string[];
  warnings: ('no_portions' | 'portions_range' | 'energy_mismatch' | 'maybe_whole' | 'maybe_per_100' | 'rounded_off')[];
  blocked: null | 'no_name' | 'no_energy' | 'too_high' | 'whole_needs_portions';
  food_id: number | null;
}
export interface WebPreviewIn { url: string; whole?: boolean; portions?: number | null; name?: string }

/** "What still fits today" (GET /recipes/suggestions). */
export type SuggestFocus = 'balanced' | 'protein' | 'light' | 'rotation';
export type SuggestReason = 'fills_protein' | 'high_protein' | 'fits_kcal' | 'not_eaten_lately' | 'light' | 'slightly_over';
export interface SuggestRest { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null }
export interface SuggestionItem {
  food: Food;
  portions: number;
  amount: number;
  kcal: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  after: SuggestRest;
  reasons: SuggestReason[];
  score: number;
}
export interface Suggestions {
  day: string;
  state: 'ok' | 'goal_reached' | 'no_goal' | 'nothing_fits' | 'no_recipes';
  focus: SuggestFocus;
  goal_kcal: number | null;
  rest: SuggestRest;
  candidates: number;
  items: SuggestionItem[];
}

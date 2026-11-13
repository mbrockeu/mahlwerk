// API client. All paths are relative (`api/v1/...`) so the app works below any path prefix.
import type {
  Account, ActivityDayOut, CookidooAccount, CookidooBulkPreview, CookidooBulkRun, CookidooBulkScope, CookidooPicturePreview, RecipeGroup, CookidooScope, YazioPreview, YazioRun, YazioState, AccessToken, AuthStatus, AccessTokenCreated, AdminOverview, AdminUser, DemoAccountState, Badges, CatalogItem, Connector, CookidooCollection, CookidooPlanDay, CookidooPreview, RefreshState, TokenScope, Webhook, WebhookCreated, WebhookDelivery, WebhookIn, FoodDetail, FoodList, FoodSort, Granularity, NutrientCurve, DemoResult, Day, Entry, Fast, Fasting, Food, FoodIn, Goal, HistoryDay, ImportBatch, ImportRemoved, Insights, LabelScan, Me, Meal, NutrientInfo, RecentFood, Recipe, RecipeIn, Review, Settings, SettingsPatch, SuggestFocus, Suggestions, Template, WebPreview, WebPreviewIn, WeightPoint, Workout, WorkoutIn,
} from './types';

export class ApiError extends Error {
  status: number;
  detail: unknown;
  /** Seconds to wait, from a 429 answer. */
  retryAfter: number | null;
  constructor(status: number, detail: unknown, retryAfter: number | null = null) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

/** The store hooks in here (api.ts must not import it): called when the server says "not signed in". */
export const hooks: { unauthorized: () => void; blocked: () => void; viewChanged: (announce: boolean) => void } = {
  unauthorized: () => {}, blocked: () => {}, viewChanged: () => {},
};
/** Which account the interface believes it is looking at (`own` or the built-in `demo` account); null until the profile is known.
 * Sent with every request; the server refuses a WRITE for another account (409 `view changed`) and names the real one in every answer. */
export const view: { current: 'own' | 'demo' | null } = { current: null };
export const VIEW_CHANGED = 'view changed';
/** What the server answers (403) when the demo account tries something it may not (see demo_account.py). */
export const DEMO_BLOCKED = 'not available in the demo account';

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob, signal?: AbortSignal): Promise<T> {
  if (import.meta.env.VITE_MOCK || import.meta.env.VITE_DEMO) {
    const { mockRequest } = await import('./mock');
    try {
      return (await mockRequest(method, path, body, raw)) as T;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && path !== 'auth/login') hooks.unauthorized();
      if (err instanceof ApiError && err.status === 403 && err.detail === DEMO_BLOCKED) hooks.blocked();
      throw err;
    }
  }
  // Always sent. The server in local sign-in mode refuses writes without it (CSRF guard); the other modes ignore it.
  const headers: Record<string, string> = { 'X-Mahlwerk-Request': '1' };
  if (view.current) headers['X-Mahlwerk-View'] = view.current;
  let payload: BodyInit | undefined;
  if (raw) {
    headers['Content-Type'] = raw.type || 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`api/v1/${path}`, { method, headers, body: payload, signal });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'network');
  }
  const actual = response.headers.get('X-Mahlwerk-View');
  if (actual && view.current && actual !== view.current) hooks.viewChanged(true); // another tab switched, or the switch ended: look again
  if (!response.ok) {
    let detail: unknown = response.statusText;
    try { detail = (await response.json()).detail ?? detail; } catch { /* keep status text */ }
    if (response.status === 409 && detail === VIEW_CHANGED) hooks.viewChanged(true); // the action was NOT done, and is not repeated
    if (response.status === 401 && path !== 'auth/login') hooks.unauthorized();
    if (response.status === 403 && detail === DEMO_BLOCKED) hooks.blocked();
    const wait = Number(response.headers.get('Retry-After'));
    throw new ApiError(response.status, detail, wait > 0 ? wait : null);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const cookidooPath = (scope: CookidooScope) => (scope === 'shared' ? 'admin/cookidoo/account' : 'me/cookidoo-account');

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const text = s.toString();
  return text ? `?${text}` : '';
};

export const api = {
  authStatus: () => request<AuthStatus>('GET', 'auth/status'),
  setup: (body: { username: string; display_name: string; password: string; setup_code?: string }) => request<Account>('POST', 'auth/setup', body),
  login: (body: { username: string; password: string }) => request<Account>('POST', 'auth/login', body),
  logout: () => request<void>('POST', 'auth/logout'),
  changePassword: (body: { current_password: string; new_password: string }) => request<void>('POST', 'auth/password', body),
  createUser: (body: { username: string; display_name: string; password: string; is_admin: boolean }) => request<Account>('POST', 'admin/users', body),
  patchUser: (username: string, body: { disabled?: boolean; is_admin?: boolean }) => request<Account>('PATCH', `admin/users/${encodeURIComponent(username)}`, body),
  resetPassword: (username: string, password: string) => request<void>('POST', `admin/users/${encodeURIComponent(username)}/password`, { password }),
  me: () => request<Me>('GET', 'me'),
  setDisplayName: (display_name: string | null) => request<Me>('PATCH', 'me', { display_name }),
  setGoal: (goal: Goal) => request<Goal>('PUT', 'me/goal', goal),
  setSettings: (patch: SettingsPatch) => request<Settings>('PATCH', 'me/settings', patch),
  badges: () => request<Badges>('GET', 'badges'),
  badgesSeen: (codes: string[]) => request<Badges>('POST', 'badges/seen', { codes }),
  review: (week?: string) => request<Review>('GET', `review${q({ week })}`),
  createDemo: (days: number) => request<DemoResult & { goal_set: boolean }>('POST', 'me/demo-data', { days }),
  deleteDemo: () => request<DemoResult>('DELETE', 'me/demo-data'),
  imports: () => request<ImportBatch[]>('GET', 'me/imports'),
  deleteImport: (id: number) => request<ImportRemoved>('DELETE', `me/imports/${id}`),

  nutrients: () => request<NutrientInfo[]>('GET', 'nutrients'),
  foodByBarcode: (code: string) => request<Food>('GET', `foods/barcode/${code}`),
  putFoodByBarcode: (code: string, food: FoodIn) => request<Food>('PUT', `foods/barcode/${code}`, food),
  food: (id: number) => request<Food>('GET', `foods/${id}`),
  foods: (query = '', limit = 50, filter: { source?: Food['source']; exclude?: Food['source'][] } = {}) =>
    request<Food[]>('GET', `foods${q({ q: query, limit, source: filter.source })}${(filter.exclude ?? []).map((s) => `&exclude_source=${s}`).join('')}`),
  recent: (limit = 20) => request<RecentFood[]>('GET', `foods/recent${q({ limit })}`),
  createFood: (food: FoodIn) => request<Food>('POST', 'foods', food),
  updateFood: (id: number, food: FoodIn) => request<Food>('PUT', `foods/${id}`, food),
  deleteFood: (id: number) => request<void>('DELETE', `foods/${id}`),
  /** An own photo for a recipe (the file as the request body; the interface shrinks it first). */
  setFoodImage: (id: number, image: Blob) => request<Food>('PUT', `foods/${id}/image`, undefined, image),
  removeFoodImage: (id: number) => request<Food>('DELETE', `foods/${id}/image`),
  /** Lift the "taken away" mark of a provider's picture; a reload then fetches it again. */
  restoreFoodImage: (id: number) => request<Food>('POST', `foods/${id}/image/restore`),
  catalog: (query: string, limit = 25, signal?: AbortSignal, source?: CatalogItem['source']) =>
    request<CatalogItem[]>('GET', `catalog${q({ q: query, limit, source })}`, undefined, undefined, signal),
  adoptCatalogItem: (item: Pick<CatalogItem, 'source' | 'code'>) =>
    request<Food>('POST', 'catalog/adopt', { source: item.source, code: item.code }),
  cookidooWeek: () => request<CookidooPlanDay[]>('GET', 'cookidoo/week'),
  cookidooCollections: () => request<CookidooCollection[]>('GET', 'cookidoo/collections'),
  cookidooRecipe: (ref: string) => request<CookidooPreview>('GET', `cookidoo/recipe${q({ ref })}`),
  cookidooAdopt: (recipe: string, collection?: string, refreshImage = false) =>
    request<Food>('POST', 'cookidoo/adopt', { recipe, ...(collection ? { collection } : {}), ...(refreshImage ? { refresh_image: true } : {}) }),
  cookidooImportPreview: (scope: CookidooBulkScope, collection?: string) =>
    request<CookidooBulkPreview>('GET', `cookidoo/import/preview${q({ scope, collection })}`),
  cookidooImportStart: (scope: CookidooBulkScope, collection?: string, regroup = false) =>
    request<CookidooBulkRun>('POST', 'cookidoo/import', { scope, ...(collection ? { collection } : {}), regroup }),
  cookidooImport: () => request<CookidooBulkRun | null>('GET', 'cookidoo/import'),
  cookidooImagesPreview: () => request<CookidooPicturePreview>('GET', 'cookidoo/images/preview'),
  cookidooImagesStart: () => request<CookidooBulkRun>('POST', 'cookidoo/images'),
  webRecipePreview: (body: WebPreviewIn) => request<WebPreview>('POST', 'web-recipes/preview', body),
  webRecipeAdopt: (body: WebPreviewIn & { refresh?: boolean; group_id?: number }) => request<Food>('POST', 'web-recipes', body),
  webRecipeReload: (foodId: number) => request<Food>('POST', `web-recipes/${foodId}/reload`),
  suggestions: (day: string, opts: { focus?: SuggestFocus; group?: string; limit?: number; anyway?: boolean } = {}) =>
    request<Suggestions>('GET', `recipes/suggestions${q({ date: day, focus: opts.focus, group: opts.group, limit: opts.limit, anyway: opts.anyway ? 'true' : undefined })}`),
  cookidooImportCancel: () => request<void>('DELETE', 'cookidoo/import'),
  recipeGroups: () => request<RecipeGroup[]>('GET', 'recipe-groups'),
  createRecipeGroup: (name: string) => request<RecipeGroup>('POST', 'recipe-groups', { name }),
  renameRecipeGroup: (id: number, name: string) => request<RecipeGroup>('PUT', `recipe-groups/${id}`, { name }),
  deleteRecipeGroup: (id: number) => request<void>('DELETE', `recipe-groups/${id}`),
  orderRecipeGroups: (ids: number[]) => request<RecipeGroup[]>('PUT', 'recipe-groups/order', { ids }),
  addToRecipeGroup: (id: number, foodIds: number[]) => request<RecipeGroup>('POST', `recipe-groups/${id}/members`, { food_ids: foodIds }),
  removeFromRecipeGroup: (id: number, foodIds: number[]) => request<RecipeGroup>('POST', `recipe-groups/${id}/members/remove`, { food_ids: foodIds }),
  setRecipeGroups: (foodId: number, groupIds: number[]) => request<number[]>('PUT', `recipe-groups/foods/${foodId}`, { group_ids: groupIds }),
  cookidooAccount: (scope: CookidooScope) => request<CookidooAccount>('GET', cookidooPath(scope)),
  cookidooSetAccount: (scope: CookidooScope, body: { email: string; password: string; country: string; language: string }) =>
    request<CookidooAccount>('PUT', cookidooPath(scope), body),
  cookidooRemoveAccount: (scope: CookidooScope) => request<CookidooAccount>('DELETE', cookidooPath(scope)),
  cookidooCheck: (scope: CookidooScope) => request<{ ok: boolean }>('POST', `${cookidooPath(scope)}/check`),
  labelScan: (image: Blob) => request<LabelScan>('POST', 'label-scans', undefined, image),

  day: (day: string) => request<Day>('GET', `diary/${day}`),
  addEntry: (day: string, entry: { food_id: number; meal: Meal; amount: number }) =>
    request<Entry>('POST', `diary/${day}/entries`, entry),
  copyEntries: (day: string, body: { from_day: string; meal?: Meal; to_meal?: Meal }) =>
    request<{ entries: Entry[] }>('POST', `diary/${day}/copy`, body),
  patchEntry: (id: number, patch: { amount?: number; meal?: Meal }) =>
    request<Entry>('PATCH', `diary/entries/${id}`, patch),
  deleteEntry: (id: number) => request<void>('DELETE', `diary/entries/${id}`),

  templates: () => request<Template[]>('GET', 'templates'),
  createTemplate: (name: string, from: { day: string; meal: Meal }) => request<Template>('POST', 'templates', { name, from }),
  renameTemplate: (id: number, name: string) => request<Template>('PATCH', `templates/${id}`, { name }),
  deleteTemplate: (id: number) => request<void>('DELETE', `templates/${id}`),
  applyTemplate: (id: number, to: { day: string; meal: Meal }) => request<{ entries: Entry[] }>('POST', `templates/${id}/apply`, to),

  recipes: () => request<Recipe[]>('GET', 'recipes'),
  createRecipe: (recipe: RecipeIn) => request<Recipe>('POST', 'recipes', recipe),
  updateRecipe: (id: number, recipe: RecipeIn) => request<Recipe>('PUT', `recipes/${id}`, recipe),
  deleteRecipe: (id: number) => request<void>('DELETE', `recipes/${id}`),

  history: (days = 14) => request<HistoryDay[]>('GET', `history${q({ days })}`),
  /** `range: 'all'` asks for everything from the first to the last entry; `from`/`to` win over it. */
  insights: (p: { from?: string; to?: string; range?: 'all'; granularity?: Granularity | 'auto'; compare?: boolean }, signal?: AbortSignal) =>
    request<Insights>('GET', `insights${q({ from: p.from, to: p.to, range: p.range, granularity: p.granularity, compare: p.compare ? 'previous' : undefined })}`, undefined, undefined, signal),
  insightsNutrient: (key: string, from: string, to: string, granularity: Granularity | 'auto', signal?: AbortSignal) =>
    request<NutrientCurve>('GET', `insights/nutrient${q({ key, from, to, granularity })}`, undefined, undefined, signal),
  insightsFoods: (p: { from: string; to: string; q: string; sort: FoodSort; limit: number; offset: number }, signal?: AbortSignal) =>
    request<FoodList>('GET', `insights/foods${q(p)}`, undefined, undefined, signal),
  insightsFoodDetail: (key: string, from: string, to: string, signal?: AbortSignal) =>
    request<FoodDetail>('GET', `insights/foods/detail${q({ key, from, to })}`, undefined, undefined, signal),
  weights: (days = 90) => request<WeightPoint[]>('GET', `weights${q({ days })}`),
  setWeight: (day: string, kg: number) => request<WeightPoint>('PUT', `weights/${day}`, { kg }),
  deleteWeight: (day: string) => request<void>('DELETE', `weights/${day}`),

  addWater: (day: string, addMl: number) => request<Day['water']>('POST', `water/${day}`, { add_ml: addMl }),
  setWater: (day: string, ml: number) => request<Day['water']>('PUT', `water/${day}`, { ml }),

  activity: (days = 14) => request<ActivityDayOut[]>('GET', `activity${q({ days })}`),
  /** Partial: only the fields that are sent change, `null` clears a value. */
  setActivity: (day: string, values: { steps?: number | null; active_kcal?: number | null; distance_m?: number | null }) =>
    request<ActivityDayOut>('PUT', `activity/${day}`, values),
  addWorkout: (workout: WorkoutIn) => request<Workout>('POST', 'workouts', workout),
  patchWorkout: (id: number, patch: Partial<WorkoutIn>) => request<Workout>('PATCH', `workouts/${id}`, patch),
  deleteWorkout: (id: number) => request<void>('DELETE', `workouts/${id}`),

  fasting: () => request<Fasting>('GET', 'fasting'),
  startFast: (body: { started_at?: number; target_hours?: number } = {}) => request<Fast>('POST', 'fasting/start', body),
  stopFast: (body: { ended_at?: number } = {}) => request<Fast>('POST', 'fasting/stop', body),
  patchFast: (id: number, body: { started_at?: number; ended_at?: number; target_hours?: number }) =>
    request<Fast>('PATCH', `fasting/${id}`, body),
  deleteFast: (id: number) => request<void>('DELETE', `fasting/${id}`),

  tokens: () => request<AccessToken[]>('GET', 'me/tokens'),
  createToken: (body: { name: string; scope: TokenScope; expires_in_days?: number }) => request<AccessTokenCreated>('POST', 'me/tokens', body),
  revokeToken: (id: number) => request<void>('DELETE', `me/tokens/${id}`),
  webhooks: () => request<Webhook[]>('GET', 'me/webhooks'),
  createWebhook: (body: WebhookIn) => request<WebhookCreated>('POST', 'me/webhooks', body),
  patchWebhook: (id: number, body: Partial<WebhookIn>) => request<Webhook>('PATCH', `me/webhooks/${id}`, body),
  deleteWebhook: (id: number) => request<void>('DELETE', `me/webhooks/${id}`),
  testWebhook: (id: number) => request<{ queued: boolean }>('POST', `me/webhooks/${id}/test`),
  webhookDeliveries: (id: number) => request<WebhookDelivery[]>('GET', `me/webhooks/${id}/deliveries`),

  yazioState: () => request<YazioState>('GET', 'me/yazio'),
  /** One file of the Yazio export (plain or gzip-packed) or `export.zip`, sent as the request body. */
  yazioUpload: (name: string, file: Blob) => request<NonNullable<YazioState['stage']>>('PUT', `me/yazio/files/${name}`, undefined, file),
  yazioPreview: (all_products = false) => request<YazioPreview>('POST', 'me/yazio/preview', { all_products }),
  yazioConfirm: (token: string, all_products = false) => request<YazioPreview>('POST', 'me/yazio/confirm', { token, all_products }),
  yazioDiscard: () => request<void>('DELETE', 'me/yazio'),
  yazioLogin: (body: { email: string; password: string; months: number }) => request<YazioRun>('POST', 'me/yazio/login', body),

  enterDemoView: () => request<DemoAccountState>('POST', 'me/demo-view/enter'),
  leaveDemoView: () => request<void>('POST', 'me/demo-view/leave'),
  resetDemoAccount: () => request<Connector>('POST', 'admin/demo-account/reset'),
  deleteDemoAccount: () => request<Connector>('DELETE', 'admin/demo-account'),
  adminOverview: () => request<AdminOverview>('GET', 'admin/overview'),
  adminUsers: () => request<AdminUser[]>('GET', 'admin/users'),
  adminConnectors: () => request<Connector[]>('GET', 'admin/connectors'),
  patchConnector: (key: string, body: { enabled?: boolean; config?: Record<string, unknown> }) => request<Connector>('PATCH', `admin/connectors/${key}`, body),
  refreshState: () => request<RefreshState>('GET', 'admin/catalog/refresh'),
  startRefresh: () => request<RefreshState>('POST', 'admin/catalog/refresh'),
};

// Taking over many Cookidoo recipes at once ("take over all"), as a background run inside the server (cookidoo_bulk.py).
//
// THIS TALKS TO AN UNOFFICIAL INTERFACE (see cookidoo.ts), and every recipe needs its own detail call there (the nutrition values are
// not in the lists). The run is therefore deliberately slow and careful.
//
// Rules this module keeps:
// - One run per Cookidoo account at a time (the key of the account, so everybody who uses the shared account sees and shares the one
//   run), at most two on the server (MAX_RUNNING). A new start while one runs is refused.
// - Paced: at least BULK_GAP (3 s) between two calls to Cookidoo, measured with the injected clock; cache hits and recipes that are up
//   to date cost no call and no waiting. The calls count against a budget of their own (BULK_CALL_LIMIT), not against the interactive
//   one, so a run neither uses up what the pages need nor can be hurried.
// - Idempotent and resumable: a recipe that is already a food and was fetched less than FRESH_SECONDS (7 days) ago is skipped without a
//   call; older ones are updated. Everything is saved recipe by recipe, so a stopped run (or a restart, which ends every run: the state
//   is in memory only) loses nothing, and starting again continues where it left off.
// - Stops at once, without a retry, when Cookidoo refuses the sign-in, says to slow down, when the sign-in is braked or locked (auth,
//   busy, wait, locked) or when the account was changed meanwhile (gone). A single recipe that fails stays in the list of failures and
//   the run goes on; after MAX_STREAK failures in a row it stops too.
// - A run ends when its account is forgotten (Hub.forget), when the connector is switched off, when somebody cancels it and when the
//   server shuts down. A run is an async task; "cancel" sets a flag the task looks at before each call and after each wait.
// - Pictures (only when the admin switched "store recipe pictures" on): a recipe that was taken over or updated gets its picture
//   fetched once, behind the same gap. The variant "catch up pictures" does only that for recipes already taken over.
// - At most MAX_RECIPES (500) recipes per run. Automatic groups: each collection is linked to a group (`cookidoo:<collection id>`),
//   made when the run starts, found again by the link, not made again when the household deleted it unless the run is started with
//   `regroup`. Recipes are added to a group when the group is new or the recipe is new to the server.
import type { Db } from './db.ts';
import { BULK_GAP, CookidooError, EXTERNAL_PREFIX, MESSAGES, SOURCE, foodData, RecipeRejected, type Access, type Hub, type RecipeDetails } from './cookidoo.ts';
import type { Fetcher } from './webrecipes.ts';
import { addToGroup, getGroup } from './store/recipes.ts';
import { foodsWithoutImage, sourceGroup, undismissSource } from './store/cookidoo.ts';
import { getFood, getFoodByExternalId, putExternalFood, updateFood, type FoodRow } from './store/foods.ts';

export const MAX_RECIPES = 500;
export const MAX_RUNNING = 2; // runs on the server at once
export const FRESH_SECONDS = 7 * 86400; // a recipe fetched more recently than this is not asked for again
export const SECONDS_PER_RECIPE = BULK_GAP + 1.0; // the gap plus a typical call; shown as the estimate, never promised
export const MAX_STREAK = 3; // failures in a row (not refusals) after which the run stops
const MAX_FAILURES_LISTED = 40;
const KEEP_FINISHED = 3600; // a finished run's state is kept this long
const STOP_KINDS = ['auth', 'busy', 'wait', 'locked', 'person', 'gone'];
const PICTURES_EVERY = 600.0; // a catch-up for pictures may be started at most this often per account
const IMAGE_GAP = 1.0; // seconds between two picture fetches when no call to Cookidoo is made in between
export const GROUP_PREFIX = 'cookidoo:';

export const REASONS: Record<string, string> = {
  user: 'cancelled',
  account: 'the account was changed, removed or signed out meanwhile',
  off: 'the Cookidoo connector was switched off',
  shutdown: 'the server was stopped',
};

/** The run cannot be planned or started; `kind`: not_found, too_many, empty, running, busy, wait. */
export class BulkError extends Error {
  kind: string;
  detail: number;
  constructor(kind: string, detail = 0) { super(kind); this.kind = kind; this.detail = detail; }
}

export interface Item { id: string; name: string; collections: string[] }
export interface Plan {
  scope: string;
  items: Item[];
  groups: Map<string, string>; // collection id -> its name: the groups the run keeps up
  pictures: boolean; // the catch-up variant: only pictures of recipes taken over already
  knownUrls: Map<string, string>; // recipe id -> picture address remembered from an earlier detail call
}

/** The recipes taken over from Cookidoo that have no picture (and nobody set one or took it away): from what is stored, no call. */
export async function makeImagePlan(db: Db, now: number | null = null): Promise<Plan> {
  const items: Item[] = [];
  const urls = new Map<string, string>();
  for (const row of await foodsWithoutImage(db, SOURCE, now)) {
    const external = row.external_id ?? '';
    if (!external.startsWith(EXTERNAL_PREFIX)) continue;
    const rid = external.slice(EXTERNAL_PREFIX.length);
    const food = await getFood(db, row.id);
    items.push({ id: rid, name: food?.data?.name || rid, collections: [] });
    if (row.image_url) urls.set(rid, row.image_url);
  }
  if (!items.length) throw new BulkError('empty');
  if (items.length > MAX_RECIPES) throw new BulkError('too_many', items.length);
  return { scope: 'pictures', items, groups: new Map(), pictures: true, knownUrls: urls };
}

/** What the catch-up would do: pictures to fetch, and the calls to Cookidoo among them (recipes whose picture address is not known). */
export function summarizeImages(plan: Plan): { total: number; fresh: number; to_fetch: number; eta_seconds: number } {
  const calls = plan.items.filter((i) => !plan.knownUrls.has(i.id)).length;
  return { total: plan.items.length, fresh: 0, to_fetch: calls, eta_seconds: Math.trunc(calls * SECONDS_PER_RECIPE + (plan.items.length - calls) * IMAGE_GAP) };
}

/** The recipes of the chosen scope without duplicates (from the lists Cookidoo gave, cached for a minute). */
export async function makePlan(hub: Hub, access: Access, scope: string, collection: string | null): Promise<Plan> {
  const items = new Map<string, Item>();
  const groups = new Map<string, string>();
  const put = (ref: { id: string; name: string }, collectionId: string | null) => {
    let item = items.get(ref.id);
    if (item === undefined) items.set(ref.id, (item = { id: ref.id, name: ref.name, collections: [] }));
    if (collectionId !== null && !item.collections.includes(collectionId)) item.collections.push(collectionId);
  };
  if (scope === 'all' || scope === 'collection') {
    let found = await hub.collections(access);
    if (scope === 'collection') {
      found = found.filter((c) => c.id === collection);
      if (!found.length) throw new BulkError('not_found');
    }
    for (const c of found) {
      if (c.recipes.length) groups.set(c.id, c.name);
      for (const ref of c.recipes) put(ref, c.id);
    }
  }
  if (scope === 'all' || scope === 'week') {
    for (const day of await hub.week(access)) for (const ref of day.recipes) put(ref, null);
  }
  if (!items.size) throw new BulkError('empty');
  if (items.size > MAX_RECIPES) throw new BulkError('too_many', items.size);
  return { scope, items: [...items.values()], groups, pictures: false, knownUrls: new Map() };
}

export const isFresh = (food: FoodRow | undefined, now: number): boolean => food !== undefined && now - (food.fetched_at || 0) < FRESH_SECONDS;

/** What a run would do, counted from what is stored (no call to Cookidoo). */
export async function summarize(db: Db, plan: Plan, now: number): Promise<{ total: number; fresh: number; to_fetch: number; eta_seconds: number }> {
  let fresh = 0;
  for (const i of plan.items) if (isFresh(await getFoodByExternalId(db, EXTERNAL_PREFIX + i.id), now)) fresh += 1;
  const toFetch = plan.items.length - fresh;
  return { total: plan.items.length, fresh, to_fetch: toFetch, eta_seconds: Math.trunc(toFetch * SECONDS_PER_RECIPE) };
}

export interface RunFailure { id: string; name: string; kind: string; reason: string }

export class Run {
  key: string; // the account: `shared` or `user:<id>`
  scope: string;
  total: number;
  toFetch: number;
  started: number;
  state: 'running' | 'done' | 'cancelled' | 'error' = 'running';
  done = 0;
  fetched = 0;
  counts = { adopted: 0, updated: 0, fresh: 0, no_nutrition: 0, failed: 0, pictures: 0, no_picture: 0 };
  mode: 'recipes' | 'pictures';
  current: string | null = null;
  failures: RunFailure[] = [];
  groups: string[] = [];
  error: string | null = null; // a key of MESSAGES
  reason: string | null = null; // why it was cancelled: a key of REASONS
  finished: number | null = null;
  cancelFlag = false;
  task: Promise<void> = Promise.resolve();

  constructor(key: string, scope: string, total: number, toFetch: number, started: number, mode: 'recipes' | 'pictures') {
    this.key = key; this.scope = scope; this.total = total; this.toFetch = toFetch; this.started = started; this.mode = mode;
  }

  view() {
    const left = this.state === 'running' ? Math.max(0, this.toFetch - this.fetched) : 0;
    return {
      state: this.state, cancelling: this.cancelFlag && this.state === 'running', scope: this.scope, mode: this.mode,
      total: this.total, done: this.done, fetched: this.fetched,
      pictures: this.counts.pictures, no_picture: this.counts.no_picture,
      adopted: this.counts.adopted, updated: this.counts.updated, fresh: this.counts.fresh,
      no_nutrition: this.counts.no_nutrition, failed: this.counts.failed,
      current: this.state === 'running' ? this.current : null,
      failures: [...this.failures], groups: [...this.groups],
      error: (this.error && MESSAGES[this.error]) || null, error_kind: this.error,
      reason: (this.reason && REASONS[this.reason]) || null, reason_kind: this.reason,
      eta_seconds: Math.trunc(left * SECONDS_PER_RECIPE), started_at: Math.trunc(this.started),
      finished_at: this.finished !== null ? Math.trunc(this.finished) : null,
    };
  }
}

/** The run was cancelled while it waited for its turn. */
class Stop extends Error {}

/** What the runs need of the picture service (RecipeImages) and of the picture fetcher. */
export interface ImagesPort {
  wants(foodId: number): Promise<boolean>;
  fetchProvider(fetcher: Fetcher, foodId: number, url: string | null, origin: string, opts?: { force?: boolean; permit?: () => boolean }): Promise<boolean>;
}

export interface BulkOptions {
  hub: Hub;
  db: Db;
  /** whether the connector is still switched on */
  enabled: () => boolean | Promise<boolean>;
  /** replaced by the tests (a sleep that advances their clock); the default can be cut short by `shutdown` */
  sleep?: (seconds: number) => Promise<void>;
  clock?: () => number;
  images?: ImagesPort;
  fetcher?: Fetcher;
  imagesOn?: () => boolean | Promise<boolean>;
}

/** Starts and tracks the runs. */
export class BulkRuns {
  private hub: Hub;
  private db: Db;
  private enabled: () => boolean | Promise<boolean>;
  private sleep: (seconds: number) => Promise<void>;
  private clock: () => number;
  private images: ImagesPort | undefined;
  private fetcher: Fetcher | undefined;
  private imagesOn: () => boolean | Promise<boolean>;
  private runs = new Map<string, Run>();
  private picturesStarted = new Map<string, number>(); // account key -> when its last catch-up started
  private sleepers = new Set<() => void>();

  constructor(o: BulkOptions) {
    this.hub = o.hub; this.db = o.db; this.enabled = o.enabled; this.images = o.images; this.fetcher = o.fetcher;
    this.imagesOn = o.imagesOn ?? (() => false);
    this.clock = o.clock ?? o.hub.clock;
    this.sleep = o.sleep ?? ((s) => new Promise<void>((resolve) => {
      const wake = () => { clearTimeout(timer); this.sleepers.delete(wake); resolve(); };
      const timer = setTimeout(wake, s * 1000);
      this.sleepers.add(wake);
    }));
    o.hub.listeners.push((key) => this.cancel(key, 'account'));
  }

  private forgetOld(): void {
    const now = this.clock();
    for (const [k, r] of [...this.runs]) if (r.finished !== null && now - r.finished > KEEP_FINISHED) this.runs.delete(k);
  }

  get(key: string): Run | undefined { this.forgetOld(); return this.runs.get(key); }
  running(): number { return [...this.runs.values()].filter((r) => r.state === 'running').length; }
  keys(): string[] { return [...this.runs.keys()]; }

  async start(access: Access, plan: Plan, userId: number | null, regroup = false): Promise<Run> {
    // the counting comes first: from the checks to the entry of the new run there is no wait, so two starts cannot both pass
    const stats = plan.pictures ? summarizeImages(plan) : await summarize(this.db, plan, this.clock());
    this.forgetOld();
    const current = this.runs.get(access.key);
    if (current !== undefined && current.state === 'running') throw new BulkError('running');
    if (this.running() >= MAX_RUNNING) throw new BulkError('busy');
    const now = this.clock();
    if (plan.pictures) {
      const last = this.picturesStarted.get(access.key);
      if (last !== undefined && now - last < PICTURES_EVERY) throw new BulkError('wait');
      this.picturesStarted.set(access.key, now);
    }
    const run = new Run(access.key, plan.scope, stats.total, stats.to_fetch, now, plan.pictures ? 'pictures' : 'recipes');
    this.runs.set(access.key, run);
    // the first step happens after the caller has had the chance to take the state of the new run (the answer of the start)
    run.task = Promise.resolve().then(() => this.work(run, access, plan, userId, regroup));
    return run;
  }

  cancel(key: string, reason = 'user'): void {
    const run = this.runs.get(key);
    if (run !== undefined && run.state === 'running' && !run.cancelFlag) { run.cancelFlag = true; run.reason = reason; }
  }

  cancelAll(reason = 'off'): void { for (const key of [...this.runs.keys()]) this.cancel(key, reason); }

  /** A catch-up for pictures ends when pictures go off; a run that takes recipes over goes on without pictures. */
  cancelPictureRuns(reason = 'off'): void { for (const r of this.runs.values()) if (r.mode === 'pictures') this.cancel(r.key, reason); }
  /** Runs on people's own accounts end (the shared account's run goes on). */
  cancelOwnRuns(reason = 'account'): void { for (const key of [...this.runs.keys()]) if (key.startsWith('user:')) this.cancel(key, reason); }

  /** The server stops: every run ends (what was saved stays). */
  async shutdown(): Promise<void> {
    this.cancelAll('shutdown');
    for (const wake of [...this.sleepers]) wake();
    for (const run of [...this.runs.values()]) {
      await run.task;
      if (run.state === 'running') { run.state = 'cancelled'; run.reason = run.reason || 'shutdown'; run.finished = this.clock(); }
    }
  }

  // ---- the run itself ----

  private async work(run: Run, access: Access, plan: Plan, userId: number | null, regroup: boolean): Promise<void> {
    try {
      await this.loop(run, access, plan, userId, regroup);
      if (run.cancelFlag) run.state = 'cancelled';
      else if (run.state === 'running') run.state = 'done';
    } catch (e) { // whatever happens, the person only learns the category
      console.warn(`cookidoo bulk run failed (${e instanceof Error ? e.constructor.name : typeof e})`);
      run.state = 'error';
      run.error = 'unexpected';
    } finally {
      run.current = null;
      run.finished = this.clock();
    }
  }

  private stop(run: Run, kind: string): void { run.state = 'error'; run.error = kind; }

  /** With pictures switched on: fetch the picture (not again when one of the same address is stored). True when a fetch was tried (for the pace). */
  private async picture(run: Run, foodId: number, url: string | null): Promise<boolean> {
    if (!url || this.images === undefined || this.fetcher === undefined || !(await this.imagesOn()) || !(await this.images.wants(foodId))) return false;
    const stored = await this.images.fetchProvider(this.fetcher, foodId, url, SOURCE);
    run.counts[stored ? 'pictures' : 'no_picture'] += 1;
    return true;
  }

  private fail(run: Run, item: Item, kind: string, text: string | null = null): void {
    if (run.failures.length < MAX_FAILURES_LISTED) run.failures.push({ id: item.id, name: item.name, kind, reason: text ?? MESSAGES[kind] ?? kind });
  }

  private makePace(run: Run, lastCall: [number | null]): () => Promise<void> {
    return async () => {
      if (lastCall[0] !== null) {
        const wait = lastCall[0] + BULK_GAP - this.clock();
        if (wait > 0) await this.sleep(wait);
      }
      if (run.cancelFlag) throw new Stop();
    };
  }

  /** The detail call of a run; the outcome is `details`, or `null` when the run must end or the recipe was dealt with (failed). */
  private async detail(run: Run, access: Access, item: Item, lastCall: [number | null], streak: { n: number }): Promise<{ details: RecipeDetails } | 'end' | 'failed'> {
    let details: RecipeDetails;
    let fetched: boolean;
    try {
      [details, fetched] = await this.hub.recipeFetched(access, item.id, { bulk: true, pace: this.makePace(run, lastCall) });
    } catch (e) {
      if (e instanceof Stop) return 'end';
      if (!(e instanceof CookidooError)) throw e;
      if (!['busy', 'wait', 'locked', 'person', 'gone'].includes(e.kind)) lastCall[0] = this.clock(); // a call was made
      if (STOP_KINDS.includes(e.kind)) { this.stop(run, e.kind); return 'end'; }
      run.counts.failed += 1;
      this.fail(run, item, e.kind);
      streak.n += 1;
      run.done += 1;
      if (streak.n >= MAX_STREAK) { this.stop(run, e.kind); return 'end'; }
      return 'failed';
    }
    if (fetched) { lastCall[0] = this.clock(); run.fetched += 1; }
    streak.n = 0;
    return { details };
  }

  /** The catch-up: a picture for every recipe taken over that has none. Calls Cookidoo only where the address is not known. */
  private async picturesLoop(run: Run, access: Access, plan: Plan): Promise<void> {
    const { hub, db } = this;
    let gen = hub.generation(access.key);
    const lastCall: [number | null] = [null];
    let lastPicture: number | null = null;
    const streak = { n: 0 };
    for (const item of plan.items) {
      if (run.cancelFlag) return;
      if (!(await this.enabled()) || !(await this.imagesOn())) { this.cancel(run.key, 'off'); return; }
      const nowGen = hub.generation(access.key);
      if (gen === null) gen = nowGen; // no call to Cookidoo yet (the plan came from what is stored): the account exists from the first call on
      else if (nowGen !== gen) { this.cancel(run.key, 'account'); return; }
      run.current = item.name;
      const known = await getFoodByExternalId(db, EXTERNAL_PREFIX + item.id);
      if (known === undefined || !(await this.images!.wants(known.id))) { // gone, or somebody set a picture meanwhile
        run.counts.fresh += 1;
        run.done += 1;
        continue;
      }
      let url = plan.knownUrls.get(item.id) || known.image_url;
      if (!url) {
        const got = await this.detail(run, access, item, lastCall, streak);
        if (got === 'end') return;
        if (got === 'failed') continue;
        url = got.details.image ?? null;
        if (!url) { run.counts.no_picture += 1; run.done += 1; continue; }
      } else if (lastPicture !== null) {
        const wait = lastPicture + IMAGE_GAP - this.clock();
        if (wait > 0) await this.sleep(wait);
        if (run.cancelFlag) return;
      }
      if (await this.picture(run, known.id, url)) lastPicture = this.clock();
      run.done += 1;
    }
  }

  private async loop(run: Run, access: Access, plan: Plan, userId: number | null, regroup: boolean): Promise<void> {
    if (plan.pictures) return this.picturesLoop(run, access, plan);
    const { hub, db } = this;
    const gen = hub.generation(access.key);
    const groupOf = new Map<string, [number, boolean]>(); // collection id -> [group id, made by this run]
    for (const [collectionId, name] of plan.groups) {
      const source = GROUP_PREFIX + collectionId;
      if (regroup) await undismissSource(db, source);
      const [groupId, created] = await sourceGroup(db, source, name, userId);
      if (groupId !== null) {
        groupOf.set(collectionId, [groupId, created]);
        const group = await getGroup(db, groupId);
        run.groups.push(group ? group.name : name);
      }
    }
    const lastCall: [number | null] = [null];
    const streak = { n: 0 };
    for (const item of plan.items) {
      if (run.cancelFlag) return;
      if (!(await this.enabled())) { this.cancel(run.key, 'off'); return; }
      if (hub.generation(access.key) !== gen) { this.cancel(run.key, 'account'); return; }
      run.current = item.name;
      const external = EXTERNAL_PREFIX + item.id;
      const known = await getFoodByExternalId(db, external);
      let foodId: number | null = known ? known.id : null;
      let newFood = false;
      if (isFresh(known, this.clock())) {
        run.counts.fresh += 1;
        if (known && !known.image_hash && known.image_url && (await this.picture(run, known.id, known.image_url))) await this.sleep(IMAGE_GAP);
      } else {
        const got = await this.detail(run, access, item, lastCall, streak);
        if (got === 'end') return;
        if (got === 'failed') continue;
        const { details } = got;
        let data;
        try {
          data = { ...foodData(details), region: [access.settings.country, access.settings.language] };
        } catch (e) {
          if (!(e instanceof RecipeRejected)) throw e;
          run.counts.no_nutrition += 1;
          this.fail(run, item, 'no_nutrition', e.message);
          run.done += 1;
          continue;
        }
        // looked at again: while the detail call was on its way another run (of another account) may have taken the same recipe over
        const exists = known ?? (await getFoodByExternalId(db, external));
        if (exists !== undefined) {
          await updateFood(db, exists.id, SOURCE, data as never);
          foodId = exists.id;
          run.counts.updated += 1;
        } else {
          [foodId] = await putExternalFood(db, external, SOURCE, data as never);
          newFood = true;
          run.counts.adopted += 1;
        }
        if (foodId !== null) await this.picture(run, foodId, details.image ?? null);
      }
      if (foodId !== null) {
        for (const collectionId of item.collections) {
          const g = groupOf.get(collectionId);
          if (g !== undefined && (newFood || g[1])) await addToGroup(db, g[0], [foodId]);
        }
      }
      run.done += 1;
    }
  }
}

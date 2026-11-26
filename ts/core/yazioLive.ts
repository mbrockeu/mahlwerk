// One-time direct sign-in at Yazio (yazio_live.py): fetch the diary of the signed-in account and hand it over in the structure of the
// exporter's files, so that the import core (yazio.ts) is the same as for an uploaded export.
//
// THIS TALKS TO AN UNOFFICIAL INTERFACE (see the Python module and docs/integrations.md). It is switched off by default and an admin has
// to switch it on, on their own responsibility.
//
// Rules this module keeps:
// - Fixed target: only `https://yzapi.yazio.com/v15` (a constant, not a setting), no redirects are followed (`ctx.services.out` never
//   follows any, and a 3xx answer is a failure), every id that goes into a path is checked against a strict pattern first, every
//   request has a time limit and every answer a size limit.
// - The e-mail address and the password are used for ONE sign-in request and then forgotten; the access token lives in the memory of the
//   run and is dropped with it. No refresh token is used or kept. None of it is stored, logged or put into an error message; failures
//   are reduced to the neutral categories of MESSAGES.
// - The app identifiers come from `MAHLWERK_YAZIO_CLIENT_ID` / `MAHLWERK_YAZIO_CLIENT_SECRET` (the environment of the context).
// - Politeness and brakes: at most 4 requests at once, 48 MB of answers per run, a budget of requests and of time per run, a bounded
//   period (at most 24 months, or 31 days for a refresh), one run per person at a time, at most 2 runs on the server at once, at most 3 sign-in attempts per person
//   and hour and 30 seconds between two of them, at most 10 per hour on the whole server.
import type { Ctx } from './http.ts';
import { OutError, outgoing, type Outgoing } from './outgoing.ts';

export const BASE = 'https://yzapi.yazio.com/v15';
const REQUEST_TIMEOUT = 20.0;
export const MAX_ANSWER = 2 * 1024 * 1024; // bytes of one answer
const CONCURRENCY = 4;
const MAX_REQUESTS = 8000;
const MAX_SECONDS = 20 * 60;
export const MAX_MONTHS = 24;
export const DEFAULT_MONTHS = 12;
const MAX_DAYS = 800;
export const MAX_REFRESH_DAYS = 31; // the refresh period ("last N days"): 1 to 31
const RETRIES = 2;
const MAX_RUN_BYTES = 48 * 1024 * 1024; // all answers of one run together; more is a clean stop ("too_large")
const GLOBAL_ATTEMPTS = [10, 3600] as const; // sign-in attempts per hour for the whole server, whoever makes them
const ATTEMPTS = [3, 3600] as const; // sign-in attempts per person: at most 3 in an hour
const ATTEMPT_GAP = 30.0; // and 30 seconds between two
const MAX_RUNNING = 2; // runs on the server at once
const KEEP_FINISHED = 1800; // a finished run's state is kept this long

export const MESSAGES: Record<string, string> = {
  auth: 'Yazio refused the sign-in (check the e-mail address and the password)',
  busy: 'Yazio asked to slow down (too many requests); try again later',
  unavailable: 'Yazio is not reachable',
  unexpected: 'Yazio answered in an unexpected way (the unofficial interface may have changed)',
  too_large: 'an answer of Yazio was larger than allowed',
  limit: 'the run needed more requests or time than allowed; choose a shorter period',
  expired: 'the sign-in with Yazio ran out during the run; start again',
  no_data: 'no diary days were found in the chosen period',
  cancelled: 'cancelled',
};

const ID = /^[A-Za-z0-9_-]{1,64}$/; // one safe path segment (real ids are UUIDs); no `$`, so no trailing newline gets through
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A neutral failure: `kind` is a key of MESSAGES. Never carries text from Yazio or from the credentials. */
export class LiveError extends Error {
  kind: string;
  constructor(kind: string) { super(MESSAGES[kind]); this.kind = kind; }
}

/** The app identifiers from the environment, or null (then the direct sign-in is not available). */
export function appIdentity(env: Record<string, string | undefined>): [string, string] | null {
  const id = (env.MAHLWERK_YAZIO_CLIENT_ID ?? '').trim(), secret = (env.MAHLWERK_YAZIO_CLIENT_SECRET ?? '').trim();
  return id && secret ? [id, secret] : null;
}

/** E-mail address and password for one sign-in; `take` hands them out once and forgets them. */
export class Credentials {
  #email: string;
  #password: string;
  constructor(email: string, password: string) { this.#email = email; this.#password = password; }
  take(): [string, string] {
    const out: [string, string] = [this.#email, this.#password];
    this.#email = this.#password = '';
    return out;
  }
  toString(): string { return 'Credentials(...)'; }
  toJSON(): string { return 'Credentials(...)'; }
}

export interface Progress { phase: string; done: number; total: number; requests: number; bytes: number; cancelled: boolean }
const newProgress = (): Progress => ({ phase: 'login', done: 0, total: 0, requests: 0, bytes: 0, cancelled: false });

const isDict = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullMap = (): Record<string, any> => Object.create(null);

function isRealDay(text: string): boolean {
  const t = new Date(0);
  const [y, m, d] = [Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10))];
  t.setUTCFullYear(y, m - 1, d);
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function liveDay(value: unknown): string | null {
  if (typeof value === 'string' && DAY.test(value.slice(0, 10)) && (value.length === 10 || value[10] === 'T' || value[10] === ' ') && isRealDay(value.slice(0, 10))) return value.slice(0, 10);
  return null;
}

const localToday = (): { year: number; month: number; iso: string } => {
  const n = new Date();
  const [year, month, day] = [n.getFullYear(), n.getMonth() + 1, n.getDate()];
  return { year, month, iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
};

export interface FetcherOptions { clock?: () => number; sleep?: (seconds: number) => Promise<void>; today?: () => { year: number; month: number; iso: string } }

/** Fetches the diary through the outgoing HTTP of the context (purpose `yazio`). */
export class Fetcher {
  private out: Outgoing;
  private identity: [string, string];
  private clock: () => number;
  private sleep: (seconds: number) => Promise<void>;
  private today: () => { year: number; month: number; iso: string };
  private deadline = 0;

  constructor(out: Outgoing, identity: [string, string], opts: FetcherOptions = {}) {
    this.out = out;
    this.identity = identity;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.sleep = opts.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
    this.today = opts.today ?? localToday;
  }

  /** The parsed JSON answer, or null for 404. Throws LiveError. */
  private async send(progress: Progress, method: string, path: string, opts: { token?: string; params?: Record<string, string>; body?: Record<string, string>; retries?: number } = {}): Promise<any> {
    const retries = opts.retries ?? RETRIES;
    if (progress.cancelled) throw new LiveError('cancelled');
    if (this.clock() > this.deadline || progress.requests >= MAX_REQUESTS) throw new LiveError('limit');
    const headers: Record<string, string> = { 'user-agent': 'Mahlwerk (one-time import)', accept: 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let payload: string | undefined;
    if (opts.body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(opts.body); }
    const query = opts.params ? '?' + new URLSearchParams(opts.params).toString() : '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      progress.requests++;
      let status: number;
      let data: Uint8Array;
      try {
        const r = await this.out.fetch('yazio', { method, url: BASE + path + query, headers, body: payload, timeout: REQUEST_TIMEOUT, maxBytes: MAX_ANSWER });
        status = r.status;
        if ([301, 302, 303, 307, 308].includes(status)) throw new LiveError('unexpected'); // redirects are never followed
        data = r.body;
        progress.bytes += data.length;
        if (progress.bytes > MAX_RUN_BYTES) throw new LiveError('too_large');
      } catch (e) {
        if (e instanceof LiveError) throw e;
        if (e instanceof OutError && e.kind === 'too_large') throw new LiveError('too_large');
        if (attempt < retries) { await this.sleep(2 ** attempt); continue; }
        throw new LiveError('unavailable');
      }
      if (status === 404) return null;
      if (status === 401 || status === 403) throw new LiveError(path === '/oauth/token' ? 'auth' : 'expired');
      if (status === 400 && path === '/oauth/token') throw new LiveError('auth');
      if (status === 429) throw new LiveError('busy');
      if (status >= 500) {
        if (attempt < retries) { await this.sleep(2 ** attempt); continue; }
        throw new LiveError('unavailable');
      }
      if (status >= 400) throw new LiveError('unexpected');
      if (status === 204 || !data.length) return null;
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw new LiveError('unexpected'); }
    }
    throw new LiveError('unavailable');
  }

  /** Sign in once, fetch the period, return `{"days.json": ..., "products.json": ..., "weight.json": ...}`. */
  async run(credentials: Credentials, months: number, progress: Progress, days: number | null = null): Promise<Record<string, any>> {
    months = Math.max(1, Math.min(MAX_MONTHS, months));
    this.deadline = this.clock() + MAX_SECONDS;
    let token = await this.login(progress, credentials);
    try {
      if (days !== null) return await this.fetchRefresh(progress, token, Math.max(1, Math.min(MAX_REFRESH_DAYS, days)));
      return await this.fetchAll(progress, token, months);
    } finally { token = ''; }
  }

  private async login(progress: Progress, credentials: Credentials): Promise<string> {
    const [email, password] = credentials.take();
    const [clientId, clientSecret] = this.identity;
    const answer = await this.send(progress, 'POST', '/oauth/token', {
      body: { client_id: clientId, client_secret: clientSecret, username: email, password, grant_type: 'password' }, retries: 0 });
    const token = isDict(answer) ? answer.access_token : null;
    if (typeof token !== 'string' || !token || token.length > 8192 || token.includes('\n') || token.includes('\r')) throw new LiveError('unexpected');
    return token;
  }

  /** Run `work(job)` for every job, a few at a time; the first LiveError stops everything. */
  private async many<J, R>(progress: Progress, jobs: J[], work: (job: J) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(jobs.length);
    let next = 0;
    let failure: unknown;
    let failed = false;
    const worker = async () => {
      while (!failed && next < jobs.length) {
        const index = next++;
        try {
          results[index] = await work(jobs[index]!);
          progress.done++;
        } catch (e) {
          if (!failed) { failed = true; failure = e; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    if (failed) throw failure;
    return results;
  }

  private async fetchAll(progress: Progress, token: string, months: number): Promise<Record<string, any>> {
    const get = (path: string, params?: Record<string, string>) => this.send(progress, 'GET', path, { token, params });
    // 1. which days have entries: one request per month
    progress.phase = 'discover'; progress.done = 0; progress.total = months;
    const today = this.today();
    const first = today.year * 12 + today.month - 1 - (months - 1);
    let days: string[] = [];
    for (let index = 0; index < months; index++) {
      const year = Math.floor((first + index) / 12), month = ((first + index) % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const listing = await get('/user/consumed-items/nutrients-daily', {
        start: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`, end: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` });
      for (const item of Array.isArray(listing) ? listing : []) {
        const day = isDict(item) ? liveDay(item.date) : null;
        if (day && day <= today.iso) days.push(day);
      }
      progress.done++;
    }
    days = [...new Set(days)].sort();
    if (!days.length) throw new LiveError('no_data');
    if (days.length > MAX_DAYS) throw new LiveError('limit');

    // 2. the days: entries, exercises and the daily summary (water, steps, active energy, goals)
    progress.phase = 'days'; progress.done = 0; progress.total = days.length;
    const oneDay = async (day: string) => {
      const consumed = await get('/user/consumed-items', { date: day });
      if (!isDict(consumed)) return null;
      const exercises = await get('/user/exercises', { date: day });
      const summary = await get('/user/widgets/daily-summary', { date: day });
      const content: Record<string, any> = { consumed: Object.fromEntries(['products', 'recipe_portions', 'simple_products'].map((k) => [k, Array.isArray(consumed[k]) ? consumed[k] : []])) };
      if (isDict(exercises)) content.exercises = exercises;
      if (isDict(summary)) content.daily_summary = summary;
      return content;
    };
    const fetched = await this.many(progress, days, oneDay);
    const dayMap = nullMap();
    days.forEach((day, i) => { if (fetched[i] !== null) dayMap[day] = fetched[i]; });
    if (!Object.keys(dayMap).length) throw new LiveError('no_data');

    const catalog = await this.catalogOf(progress, get, dayMap);

    // 4. the weight: the last value at or before each logged day
    const dayList = Object.keys(dayMap);
    progress.phase = 'weights'; progress.done = 0; progress.total = dayList.length;
    const answers = await this.many(progress, dayList, (day) => get('/user/bodyvalues/weight/last', { date: day }));
    const weights = weightsOf(dayList, answers);
    progress.phase = 'done';
    return { 'days.json': dayMap, 'products.json': catalog, 'weight.json': weights };
  }

  /** The products and recipes the entries of the fetched days refer to. */
  private async catalogOf(progress: Progress, get: (path: string, params?: Record<string, string>) => Promise<any>, dayMap: Record<string, any>): Promise<Record<string, any>> {
    const productIds = new Set<string>(), recipeIds = new Set<string>();
    for (const content of Object.values<any>(dayMap)) {
      for (const item of content.consumed.products) if (isDict(item) && typeof item.product_id === 'string' && ID.test(item.product_id)) productIds.add(item.product_id);
      for (const item of content.consumed.recipe_portions) if (isDict(item) && typeof item.recipe_id === 'string' && ID.test(item.recipe_id)) recipeIds.add(item.recipe_id);
    }
    progress.phase = 'products'; progress.done = 0;
    const wanted: ['products' | 'recipes', string][] = [...[...productIds].sort().map((id): ['products', string] => ['products', id]), ...[...recipeIds].sort().map((id): ['recipes', string] => ['recipes', id])];
    progress.total = wanted.length;
    const found = await this.many(progress, wanted, ([kind, ident]) => get(`/${kind}/${ident}`));
    const catalog: Record<string, any> = { products: nullMap(), recipes: nullMap() };
    wanted.forEach(([kind, ident], i) => { if (isDict(found[i])) catalog[kind][ident] = found[i]; });
    return catalog;
  }

  /** Refresh mode (see yazio_live.py `_fetch_refresh`): EVERY day of the last `days` days ending today is asked for directly, so that an
   * empty day is a real answer; a day whose consumed items or exercises do not come back as an object with ALL their lists (404, no content, a missing list),
   * or any failed request, ends the whole run (no partial refresh). `no_data` is not an error here. */
  private async fetchRefresh(progress: Progress, token: string, days: number): Promise<Record<string, any>> {
    const get = (path: string, params?: Record<string, string>) => this.send(progress, 'GET', path, { token, params });
    const today = this.today();
    const base = Date.UTC(Number(today.iso.slice(0, 4)), Number(today.iso.slice(5, 7)) - 1, Number(today.iso.slice(8, 10)));
    const dayBack = (n: number) => new Date(base - n * 86400000).toISOString().slice(0, 10);
    const dayList = Array.from({ length: days }, (_, i) => dayBack(days - 1 - i));
    progress.phase = 'days'; progress.done = 0; progress.total = dayList.length;
    const oneDay = async (day: string) => {
      const consumed = await get('/user/consumed-items', { date: day });
      const exercises = await get('/user/exercises', { date: day });
      const summary = await get('/user/widgets/daily-summary', { date: day });
      if (!isDict(consumed) || !isDict(exercises)) throw new LiveError('unexpected');
      const lists: Record<string, any> = {};
      for (const key of ['products', 'recipe_portions', 'simple_products']) {
        if (!Array.isArray(consumed[key])) throw new LiveError('unexpected');
        lists[key] = consumed[key];
      }
      for (const key of ['training', 'custom_training']) if (!Array.isArray(exercises[key])) throw new LiveError('unexpected'); // as strict as consumed: a missing list would read as "no workouts"
      const content: Record<string, any> = { consumed: lists, exercises };
      if (isDict(summary)) content.daily_summary = summary; // water, steps and goals are only ever set or updated, never taken away
      return content;
    };
    const fetched = await this.many(progress, dayList, oneDay);
    const dayMap = nullMap();
    dayList.forEach((day, i) => { dayMap[day] = fetched[i]; });
    const catalog = await this.catalogOf(progress, get, dayMap);

    // the weight: the last value at or before each day; the day before the period is asked too, so that the first day does not take over
    // an older measurement, and only values of the period itself are kept
    const asked = [dayBack(days), ...dayList];
    progress.phase = 'weights'; progress.done = 0; progress.total = asked.length;
    const answers = await this.many(progress, asked, (day) => get('/user/bodyvalues/weight/last', { date: day }));
    const weights = nullMap();
    for (const [day, kg] of Object.entries(weightsOf(asked, answers))) if (day >= dayList[0]! && day <= dayList[dayList.length - 1]!) weights[day] = kg;
    progress.phase = 'done';
    return { 'days.json': dayMap, 'products.json': catalog, 'weight.json': weights, 'refresh.json': { first_day: dayList[0], last_day: dayList[dayList.length - 1] } };
  }
}

/** The answers say the LAST weight up to a date, so the same value comes back on many days. With a date in the answer that is the day of
 * the measurement; without one, a day counts only when the value differs from the day before. */
export function weightsOf(days: string[], answers: unknown[]): Record<string, number> {
  const out = nullMap();
  let previous: number | null = null;
  days.forEach((day, i) => {
    const answer = answers[i];
    const value = isDict(answer) ? answer.value : null;
    if (typeof value !== 'number') return;
    const measured = isDict(answer) ? liveDay(answer.date) : null;
    if (measured) out[measured] = value;
    else if (value !== previous) out[day] = value;
    previous = value;
  });
  return out;
}

// ---- runs in the background, one per person ----

export interface Run {
  user_id: number; progress: Progress; state: 'running' | 'done' | 'error' | 'cancelled'; error: string | null; started: number; finished: number | null;
  /** Settles when the run has ended (for the tests). */
  done: Promise<void>;
}

export const runView = (run: Run) => ({
  state: run.state, phase: run.progress.phase, done: run.progress.done, total: run.progress.total, requests: run.progress.requests,
  error: run.error ? MESSAGES[run.error] ?? null : null, error_kind: run.error,
});

/** A new run is not allowed now; `kind`: running, busy (too many on the server), gap, hourly, global. */
export class Refused extends Error {
  kind: string;
  wait: number;
  constructor(kind: string, wait = 0) { super(kind); this.kind = kind; this.wait = wait; }
}

/** Starts and tracks the background runs. `deliver(userId, files)` is called with the fetched files of a run that succeeded (it puts them
 * into the person's staging area); the credentials never leave the run. */
export class Runs {
  private ctx: Ctx;
  private deliver: (userId: number, files: Record<string, any>) => Promise<void>;
  private clock: () => number;
  /** The tests replace these two. */
  sleep?: (seconds: number) => Promise<void>;
  today?: () => { year: number; month: number; iso: string };
  private runs = new Map<number, Run>();
  private attempts = new Map<number, number[]>();
  private global: number[] = [];

  constructor(ctx: Ctx, deliver: (userId: number, files: Record<string, any>) => Promise<void>) {
    this.ctx = ctx;
    this.deliver = deliver;
    this.clock = () => ctx.now();
  }

  private forgetOld(now: number): void {
    for (const [uid, r] of this.runs) if (r.finished !== null && now - r.finished > KEEP_FINISHED) this.runs.delete(uid);
    for (const [uid, times] of this.attempts) if (!times.length || now - times[times.length - 1]! > ATTEMPTS[1]) this.attempts.delete(uid);
  }

  start(userId: number, credentials: Credentials, months: number, days: number | null = null): Run {
    const identity = appIdentity(this.ctx.env);
    if (identity === null) throw new LiveError('unexpected');
    const now = this.clock();
    this.forgetOld(now);
    const current = this.runs.get(userId);
    if (current && current.state === 'running') throw new Refused('running');
    if ([...this.runs.values()].filter((r) => r.state === 'running').length >= MAX_RUNNING) throw new Refused('busy');
    this.global = this.global.filter((t) => now - t < GLOBAL_ATTEMPTS[1]);
    if (this.global.length >= GLOBAL_ATTEMPTS[0]) throw new Refused('global', Math.floor(GLOBAL_ATTEMPTS[1] - (now - this.global[0]!)) + 1);
    const times = (this.attempts.get(userId) ?? []).filter((t) => now - t < ATTEMPTS[1]);
    if (times.length && now - times[times.length - 1]! < ATTEMPT_GAP) throw new Refused('gap', Math.floor(ATTEMPT_GAP - (now - times[times.length - 1]!)) + 1);
    if (times.length >= ATTEMPTS[0]) throw new Refused('hourly', Math.floor(ATTEMPTS[1] - (now - times[0]!)) + 1);
    times.push(now);
    this.global.push(now);
    this.attempts.set(userId, times);
    const run = { user_id: userId, progress: newProgress(), state: 'running', error: null, started: now, finished: null } as Run;
    this.runs.set(userId, run);
    const fetcher = new Fetcher(outgoing(this.ctx), identity, { sleep: this.sleep, today: this.today });
    run.done = this.work(run, fetcher, credentials, months, days);
    return run;
  }

  private async work(run: Run, fetcher: Fetcher, credentials: Credentials, months: number, days: number | null): Promise<void> {
    try {
      const files = await fetcher.run(credentials, months, run.progress, days);
      if (run.progress.cancelled) throw new LiveError('cancelled');
      await this.deliver(run.user_id, files);
      run.state = 'done';
    } catch (e) {
      if (e instanceof LiveError) {
        run.error = e.kind;
        run.state = e.kind === 'cancelled' ? 'cancelled' : 'error';
      } else { // whatever happens, the person only learns the category
        console.warn(`yazio run failed (${e instanceof Error ? e.name : typeof e})`);
        run.error = 'unexpected';
        run.state = 'error';
      }
    } finally {
      credentials.take();
      run.finished = this.clock();
    }
  }

  get(userId: number): Run | undefined {
    this.forgetOld(this.clock());
    return this.runs.get(userId);
  }

  cancel(userId: number): void {
    const run = this.get(userId);
    if (run && run.state === 'running') run.progress.cancelled = true;
  }

  cancelAll(): void {
    for (const run of this.runs.values()) if (run.state === 'running') run.progress.cancelled = true;
  }
}

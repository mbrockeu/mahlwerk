// Cookidoo connector (cookidoo.py): recipes from the Thermomix recipe platform as foods with nutrition values per portion.
//
// Cookidoo has no public interface. The client behind `CookidooClient` (cookidooClient.ts) talks to it the way the unofficial
// `cookidoo-api` package 0.19.0 does; it can break whenever Cookidoo changes. Everything else here (settings, link parsing, unit
// conversion, caching, limits) is plain code and is tested with a stand-in client, so no test needs the network.
//
// Rules this module keeps (1:1 with the Python module):
// - The credentials come from the environment (MAHLWERK_COOKIDOO_EMAIL, _PASSWORD, _COUNTRY, _LANGUAGE, which win for the shared
//   household account) or from the encrypted store (vault: the shared account set in the admin area, and an own account per user).
//   They are never returned, logged or put into an error message; errors are reduced to a neutral category.
// - Accounts are never mixed: the hub keeps a separate client, cache, call counter and sign-in brake for the shared account and for
//   each user's own account. A user who has an own account uses only that one; everybody else uses the shared one.
// - Only a recipe id is ever sent to Cookidoo; a pasted link is reduced to the id by a strict pattern and is never fetched.
// - Recipe texts (ingredients, steps) are not kept: only the name, the portions, the nutrition values and the id.
// - The sign-in (token) lives in the memory of the process. Sign-ins are rationed so that Cookidoo is not hammered with wrong
//   passwords, whatever accounts are typed in: a refused sign-in is not retried for five minutes; per account holder (the shared
//   account, or one person) at most 5 refused sign-ins an hour are tolerated, after that sign-ins are not even tried until the hour
//   has passed (changing the stored account does not reset that count); at most 20 sign-ins an hour for all accounts together. This
//   limits the load and the risk of Cookidoo locking an account; it cannot promise that it never does. Changing an account drops its
//   client and cache, and an answer that arrives after a change is not cached.
// - Runs that take over many recipes (cookidooBulk.ts) call `Hub.recipeFetched(..., { bulk: true })`: they are paced by the run
//   (BULK_GAP), counted against a budget of their own (BULK_CALL_LIMIT, GLOBAL_BULK_CALL_LIMIT) so that the interactive limits stay
//   free, and their answers are not cached. `Hub.forget` tells the runs (`listeners`) so that they end with the account.
import { roundHalfEven } from './num.ts';
import { PER_100_KEYS } from './nutrition.ts';

export const SOURCE = 'cookidoo';
export const EXTERNAL_PREFIX = 'cookidoo:';
export const REFERENCE_AMOUNT = 100.0; // g: one portion is stored as 100 g whose "per 100 g" values are the values of the portion
export const REQUEST_TIMEOUT = 20; // seconds, for each request to Cookidoo
export const LIST_CACHE_SECONDS = 60; // the meal plan and the collections are loaded from Cookidoo at most once a minute
export const RECIPE_CACHE_SECONDS = 600;
export const RECIPE_CACHE_MAX = 200;
export const AUTH_COOLDOWN = 300; // after a failed sign-in no new attempt for this long
export const FAIL_LIMIT: [number, number] = [5, 3600]; // refused sign-ins tolerated per account holder per hour
export const LOGIN_LIMIT: [number, number] = [20, 3600]; // sign-in attempts per hour for all accounts together
export const LOGIN_GAP = 30; // a new sign-in after a refusal, and two "check the connection" in a row, are held back this long
export const CALL_LIMIT: [number, number] = [30, 300]; // at most 30 calls to Cookidoo in 300 seconds for each account
export const GLOBAL_CALL_LIMIT: [number, number] = [120, 300]; // and for all accounts together
export const MAX_CLIENTS = 6; // signed-in clients held at once; the one unused longest is closed when another is needed
export const IDLE_SECONDS = 1800; // a client unused this long is closed (its token is forgotten)
export const MAX_ACCOUNTS = 200; // accounts remembered (caches, brakes); the oldest idle ones are forgotten
export const SHARED = 'shared';
export const MAX_COLLECTION_RECIPES = 500;
// bulk runs have a budget of their own, so that they neither use up the calls that interactive requests need nor can be run faster
// than is polite: one detail call every BULK_GAP seconds is 100 calls in 300 seconds, the limit leaves a little room above that
export const BULK_GAP = 3.0;
export const BULK_CALL_LIMIT: [number, number] = [110, 300]; // per account
export const GLOBAL_BULK_CALL_LIMIT: [number, number] = [200, 300]; // all accounts together (at most two runs at once)

const COUNTRY = /^[a-z]{2}$/;
const LANGUAGE = /^[a-z]{2}-[A-Z]{2}$/;
const RECIPE_ID = /^r\d{3,10}$/;
const RECIPE_LINK = new RegExp(
  '^https://(?:www\\.)?cookidoo\\.(?:thermomix\\.com|[a-z]{2,3}(?:\\.[a-z]{2})?)'
  + '/recipes/recipe/(?:[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?/)?(r\\d{3,10})/?(?:[?#]\\S{0,300})?$');

export const MESSAGES: Record<string, string> = {
  auth: 'Cookidoo sign-in failed (check the e-mail address and the password of the account)',
  unavailable: 'Cookidoo is not reachable',
  unexpected: 'Cookidoo answered in an unexpected way (the unofficial interface may have changed)',
  busy: 'too many requests to Cookidoo, try again in a minute',
  wait: 'a sign-in was tried a moment ago, wait half a minute before the next try',
  locked: 'too many refused sign-ins within the last hour, no new try for now (change nothing and wait)',
  gone: 'the account was changed or removed meanwhile, try again',
};

/** A neutral failure: `kind` is one of MESSAGES. Never carries text from Cookidoo or from the credentials. */
export class CookidooError extends Error {
  kind: string;
  constructor(kind: string) { super(MESSAGES[kind]); this.kind = kind; }
}

/** The recipe cannot become a food (the text says why). */
export class RecipeRejected extends Error {}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Settings {
  readonly email: string;
  readonly password: string;
  readonly country: string;
  readonly language: string;
  private constructor(email: string, password: string, country: string, language: string) {
    this.email = email; this.password = password; this.country = country; this.language = language;
  }

  /** null unless the account and a valid localisation are given (the country and language default to de / de-DE). */
  static build(email: unknown, password: unknown, country: unknown, language: unknown): Settings | null {
    const mail = typeof email === 'string' ? email.trim() : '';
    const pw = typeof password === 'string' ? password : '';
    const cc = (typeof country === 'string' ? country.trim().toLowerCase() : '') || 'de';
    const lang = (typeof language === 'string' ? language.trim() : '') || 'de-DE';
    if (!mail || !pw || [...mail].length > 200 || [...pw].length > 500 || mail.includes('\n') || !COUNTRY.test(cc) || !LANGUAGE.test(lang)) return null;
    return new Settings(mail, pw, cc, lang);
  }

  static fromEnv(env: Record<string, string | undefined>): Settings | null {
    return Settings.build(env.MAHLWERK_COOKIDOO_EMAIL, env.MAHLWERK_COOKIDOO_PASSWORD, env.MAHLWERK_COOKIDOO_COUNTRY, env.MAHLWERK_COOKIDOO_LANGUAGE);
  }

  /** From a value of the encrypted store (see `toStored`). */
  static fromStored(value: Record<string, unknown> | null | undefined): Settings | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return Settings.build(value.email, value.password, value.country, value.language);
  }

  toStored(): Record<string, string> { return { email: this.email, password: this.password, country: this.country, language: this.language }; }
  equals(other: Settings | null): boolean {
    return other !== null && this.email === other.email && this.password === other.password && this.country === other.country && this.language === other.language;
  }
  // a stray log line or error dump must not show the credentials
  toString(): string { return `Settings(country=${this.country}, language=${this.language})`; }
  toJSON(): unknown { return { country: this.country, language: this.language }; }
  [INSPECT](): string { return this.toString(); }
}

/** Which account a request uses: `key` is `shared` or `user:<id>`; never mix the settings of two keys. */
export class Access {
  readonly key: string;
  readonly settings: Settings;
  readonly scope: 'shared' | 'own';
  constructor(key: string, settings: Settings, scope: 'shared' | 'own') { this.key = key; this.settings = settings; this.scope = scope; }
  toString(): string { return `Access(key=${this.key}, scope=${this.scope})`; }
  toJSON(): unknown { return { key: this.key, scope: this.scope }; }
  [INSPECT](): string { return this.toString(); }
}

/** The id of a recipe from an id (`r59322`) or a Cookidoo recipe link, else null. Nothing is fetched from the link. */
export function recipeId(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (RECIPE_ID.test(t)) return t;
  const m = RECIPE_LINK.exec(t);
  return m ? m[1]! : null;
}

// Cookidoo's web domain by country, only where it is certain; a country not listed gets no link (nothing is guessed)
const SITES: Record<string, string> = {
  de: 'cookidoo.de', at: 'cookidoo.at', ch: 'cookidoo.ch', fr: 'cookidoo.fr', es: 'cookidoo.es',
  it: 'cookidoo.it', pl: 'cookidoo.pl', pt: 'cookidoo.pt', gb: 'cookidoo.co.uk',
};

/** The page of a taken-over recipe at Cookidoo (from `cookidoo:<id>` and the region stored with the food, else the environment's),
 * else null. Only built, never fetched. */
export function recipeUrl(externalId: string | null | undefined, env: Record<string, string | undefined>, region?: unknown): string | null {
  if (!externalId || !externalId.startsWith(EXTERNAL_PREFIX)) return null;
  let country: string;
  let language: string;
  if (Array.isArray(region) && region.length === 2 && region.every((v) => typeof v === 'string')) [country, language] = region as [string, string];
  else {
    const s = Settings.fromEnv(env);
    if (s === null) return null;
    [country, language] = [s.country, s.language];
  }
  const rid = externalId.slice(EXTERNAL_PREFIX.length);
  const host = Object.hasOwn(SITES, country) ? SITES[country] : undefined;
  if (host === undefined || !RECIPE_ID.test(rid) || !LANGUAGE.test(language)) return null;
  return `https://${host}/recipes/recipe/${language}/${rid}`;
}

// ---- what the client returns (plain data) ----

export interface PlannedRecipe { id: string; name: string }
export interface PlanDay { day: string; title: string; recipes: PlannedRecipe[] }
export interface Collection { id: string; name: string; managed: boolean; recipes: PlannedRecipe[] }
/** One block of nutrition values as Cookidoo sends it: for `quantity` x `unit` (e.g. 1 x "portion"). */
export interface NutritionEntry { quantity: number; unit: string; values: Map<string, [number, string]> }
export interface RecipeDetails {
  id: string; name: string; portions: number | null; nutrition: NutritionEntry[];
  /** the address of the recipe picture Cookidoo gave (only ever fetched when the admin switched pictures on) */
  image?: string | null;
}

/** What the connector needs from Cookidoo. The real one is `LibraryClient` (cookidooClient.ts); tests bring a stand-in. */
export interface CookidooClient {
  week(day: string): Promise<PlanDay[]>; // `day`: YYYY-MM-DD
  collections(): Promise<Collection[]>;
  recipe(recipeId: string): Promise<RecipeDetails>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// ---- unit conversion ----

// Cookidoo nutrition type -> key in per_100. Only types seen in real answers are mapped.
const GRAM_TYPES: [string, string][] = [['fat', 'fat'], ['saturatedFat', 'saturated_fat'], ['carb2', 'carbs'], ['protein', 'protein'], ['dietaryFibre', 'fiber']];
const TO_GRAMS: Record<string, number> = { g: 1.0, mg: 1e-3, 'µg': 1e-6, ug: 1e-6, mcg: 1e-6 };
const TO_MG: Record<string, number> = { mg: 1.0, g: 1e3, 'µg': 1e-3, ug: 1e-3, mcg: 1e-3 };
const KJ_PER_KCAL = 4.184;
const SALT_PER_SODIUM = 2.5; // salt = sodium x 2.5 (EU labelling convention)
const MAX_KCAL = 5000.0; // per portion; more means a unit error in the source
const MAX_GRAMS = 500.0;

function amount(values: Map<string, [number, string]>, key: string, factors: Record<string, number>): number | null {
  const entry = values.get(key);
  if (entry === undefined) return null;
  const [number, unit] = entry;
  const factor = Object.hasOwn(factors, unit.trim().toLowerCase()) ? factors[unit.trim().toLowerCase()] : undefined;
  if (factor === undefined || number === null || number < 0) return null;
  return number * factor;
}

/** The block that holds the values for ONE portion (quantity 1), if Cookidoo sent one. */
export const perPortion = (entries: NutritionEntry[]): NutritionEntry | null => entries.find((e) => e.quantity === 1 && e.values.size > 0) ?? null;

/** [per_100, extra] for one portion, from Cookidoo's values. The portion is stored as 100 g (REFERENCE_AMOUNT), so the numbers are the
 * values of one portion as they are. Energy comes from kcal, else from kJ. A value in an unknown unit or outside what a portion can
 * hold counts as missing (unknown, not zero). Without energy the recipe is refused: a food without calories would silently log zero. */
export function nutritionFrom(entries: NutritionEntry[]): [Record<string, number | null>, Record<string, number>] {
  const block = perPortion(entries);
  if (block === null) throw new RecipeRejected('this recipe has no nutrition values per portion');
  const values = block.values;
  let kcal: number | null = null;
  const kc = values.get('kcal');
  const kj = values.get('kJ');
  if (kc && kc[1].trim().toLowerCase() === 'kcal' && kc[0] >= 0) kcal = kc[0];
  else if (kj && kj[1].trim().toLowerCase() === 'kj' && kj[0] >= 0) kcal = kj[0] / KJ_PER_KCAL;
  if (kcal === null) throw new RecipeRejected('this recipe has no energy value');
  if (kcal > MAX_KCAL) throw new RecipeRejected('the energy value of this recipe is not plausible');
  const per100: Record<string, number | null> = Object.fromEntries(PER_100_KEYS.map((k) => [k, null]));
  per100.kcal = roundHalfEven(kcal, 1);
  for (const [source, key] of GRAM_TYPES) {
    const grams = amount(values, source, TO_GRAMS);
    if (grams !== null && grams <= MAX_GRAMS) per100[key] = roundHalfEven(grams, 2);
  }
  const extra: Record<string, number> = {};
  const sodium = amount(values, 'sodium', TO_MG);
  if (sodium !== null && sodium <= 40000) {
    extra.sodium = roundHalfEven(sodium, 1);
    per100.salt = roundHalfEven((sodium * SALT_PER_SODIUM) / 1000, 2);
  }
  return [per100, extra];
}

/** The data of the food that stands for the recipe: values per portion, booked as 100 g = 1 portion. */
export function foodData(details: RecipeDetails) {
  const [per100, extra] = nutritionFrom(details.nutrition);
  const name = [...(details.name ?? '').trim()].slice(0, 200).join('');
  if (!name) throw new RecipeRejected('this recipe has no name');
  const portions = details.portions;
  return {
    name, brand: 'Cookidoo', quantity: null, serving_size: '1 portion', serving_quantity: REFERENCE_AMOUNT, unit: 'g' as const,
    per_100: per100, extra, complete: ['kcal', 'fat', 'carbs', 'protein'].every((k) => per100[k] !== null && per100[k] !== undefined),
    portions: portions && portions > 0 ? portions : null,
  };
}

// ---- the connector the routes use ----

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  locked(): boolean { return this.count > 0; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.count++;
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    await before;
    try { return await fn(); } finally { this.count--; release(); }
  }
}

class HubTimeout extends Error {}
function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HubTimeout()), seconds * 1000); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** The state of one account: client (with the sign-in), caches, call counter, brake and last error. */
class AccountState {
  key: string;
  settings: Settings | null = null;
  client: CookidooClient | null = null;
  lists = new Map<string, [number, unknown]>();
  recipes = new Map<string, [number, RecipeDetails]>();
  calls: number[] = [];
  bulkCalls: number[] = [];
  blockedUntil = 0.0;
  lastFail = -1e12; // when a sign-in of this account was refused
  lastCheck = -1e12; // when "check the connection" signed in last
  lastError: string | null = null;
  lastUsed = 0.0;
  gen = 0; // bumped whenever the account is changed or forgotten: an older answer is then not cached
  lock = new Mutex();
  constructor(key: string) { this.key = key; }
}

/** Drops entries older than `window` from the front of an ascending list of times; returns what is left. */
function recent(times: number[], window: number, now: number): number {
  while (times.length && now - times[0]! > window) times.shift();
  return times.length;
}

export interface HubOptions { factory: (settings: Settings) => CookidooClient; clock: () => number }

/** Holds one account state per account in use (the shared one and each user's own), the global call limit and the cap on the number
 * of clients held at once. `factory` builds the client from the settings; the tests pass one that returns a stand-in. */
export class Hub {
  factory: (settings: Settings) => CookidooClient;
  clock: () => number;
  private accounts = new Map<string, AccountState>();
  private calls: number[] = [];
  private bulkCalls: number[] = [];
  /** told when an account is forgotten (sign-out, change, removal) */
  listeners: ((key: string) => void)[] = [];
  // refused sign-ins per account holder and all sign-in attempts: kept here, apart from the accounts, so that neither changing the
  // account nor the eviction of an idle account forgets them
  private fails = new Map<string, number[]>();
  private logins: number[] = [];

  constructor(opts: HubOptions) { this.factory = opts.factory; this.clock = opts.clock; }

  /** The last failure of the shared account (a key of MESSAGES, never text from Cookidoo). */
  get lastError(): string | null { return this.accounts.get(SHARED)?.lastError ?? null; }
  errorOf(key: string): string | null { return this.accounts.get(key)?.lastError ?? null; }

  /** off / not_configured / error / ready (`not_installed` of the Python module has no counterpart: nothing is installed here). */
  status(enabled: boolean, access: Access | null, key: string = SHARED): string {
    if (access === null) return 'not_configured';
    if (this.errorOf(key) !== null) return 'error';
    return enabled ? 'ready' : 'off';
  }

  clientCount(): number { let n = 0; for (const a of this.accounts.values()) if (a.client !== null) n++; return n; }
  accountKeys(): string[] { return [...this.accounts.keys()]; }

  private reserveCall(account: AccountState, bulk = false): void {
    const now = this.clock();
    const [mine, everyone] = bulk ? [account.bulkCalls, this.bulkCalls] : [account.calls, this.calls];
    const limits = bulk ? [BULK_CALL_LIMIT, GLOBAL_BULK_CALL_LIMIT] : [CALL_LIMIT, GLOBAL_CALL_LIMIT];
    [mine, everyone].forEach((calls, i) => {
      const [limit, window] = limits[i]!;
      if (recent(calls, window, now) >= limit) throw new CookidooError('busy');
    });
    mine.push(now);
    everyone.push(now);
  }

  /** Bumped whenever the account is changed or forgotten (null: nothing is held for it). */
  generation(key: string): number | null { return this.accounts.get(key)?.gen ?? null; }

  private async drop(account: AccountState): Promise<void> {
    const client = account.client;
    account.client = null;
    if (client !== null) {
      try { await client.close(); } catch { /* closing is best effort */ }
    }
  }

  /** The account of `access`, with its state reset when the settings changed since the last call. */
  private async account(access: Access): Promise<AccountState> {
    let account = this.accounts.get(access.key);
    if (account === undefined) {
      account = new AccountState(access.key);
      this.accounts.set(access.key, account);
      while (this.accounts.size > MAX_ACCOUNTS) {
        const oldest = [...this.accounts].find(([k, a]) => a.client === null && !a.lock.locked() && k !== access.key);
        if (oldest === undefined) break;
        this.accounts.delete(oldest[0]);
      }
    }
    if (account.settings !== null && !account.settings.equals(access.settings)) {
      await this.drop(account); // changed: nothing of the old account stays
      account.gen += 1;
      account.lists.clear();
      account.recipes.clear();
      account.blockedUntil = 0.0;
      account.lastError = null;
    }
    account.settings = access.settings;
    this.accounts.delete(access.key); // move to the end
    this.accounts.set(access.key, account);
    account.lastUsed = this.clock();
    for (const other of [...this.accounts.values()]) { // sign-ins nobody uses are not kept
      if (other !== account && other.client !== null && !other.lock.locked() && account.lastUsed - other.lastUsed > IDLE_SECONDS) await this.drop(other);
    }
    return account;
  }

  private async makeRoom(keep: AccountState): Promise<void> {
    while (this.clientCount() >= MAX_CLIENTS) {
      const victim = [...this.accounts.values()].find((a) => a.client !== null && a !== keep && !a.lock.locked());
      if (victim === undefined) throw new CookidooError('busy');
      await this.drop(victim);
    }
  }

  private checkLoginAllowed(key: string, now: number): void {
    const fails = this.fails.get(key);
    if (fails !== undefined && recent(fails, FAIL_LIMIT[1], now) >= FAIL_LIMIT[0]) throw new CookidooError('locked');
    if (recent(this.logins, LOGIN_LIMIT[1], now) >= LOGIN_LIMIT[0]) throw new CookidooError('busy');
  }

  private noteRefusal(key: string, now: number): void {
    let list = this.fails.get(key);
    if (list === undefined) this.fails.set(key, (list = []));
    list.push(now);
    if (this.fails.size > 5000) { // bounded: forget the holders whose last refusal is oldest
      const oldest = [...this.fails].sort((a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0)).slice(0, 1000);
      for (const [k] of oldest) this.fails.delete(k);
    }
  }

  private async run<T>(account: AccountState, work: (c: CookidooClient) => Promise<T>, bulk = false): Promise<T> {
    const now = this.clock();
    if (now < account.blockedUntil) throw new CookidooError('auth');
    const settings = account.settings;
    const gen = account.gen;
    if (settings === null) throw new CookidooError('gone');
    if (account.client === null) {
      this.checkLoginAllowed(account.key, now);
      if (now - account.lastFail < LOGIN_GAP) throw new CookidooError('wait'); // new credentials after a refusal: not at once
    }
    this.reserveCall(account, bulk);
    if (account.client === null) {
      await this.makeRoom(account);
      this.logins.push(now);
      account.client = this.factory(settings);
    }
    const client = account.client;
    const current = () => gen === account.gen;
    let result: T;
    try {
      result = await withTimeout(work(client), REQUEST_TIMEOUT * 3);
    } catch (exc) {
      if (exc instanceof HubTimeout) {
        if (current()) account.lastError = 'unavailable';
        throw new CookidooError('unavailable');
      }
      if (exc instanceof CookidooError) {
        if (current()) {
          account.lastError = exc.kind;
          if (exc.kind === 'auth') {
            account.lastFail = this.clock();
            account.blockedUntil = this.clock() + AUTH_COOLDOWN;
            this.noteRefusal(account.key, this.clock());
            await this.drop(account);
          }
        }
        throw exc;
      }
      // whatever the client throws, the caller only learns the category (and the log only the class, never the message)
      console.warn(`cookidoo call failed (${exc instanceof Error ? exc.constructor.name : typeof exc})`);
      if (current()) account.lastError = 'unexpected';
      throw new CookidooError('unexpected');
    }
    if (current()) account.lastError = null;
    return result;
  }

  private async cachedList<T>(access: Access, key: string, work: (c: CookidooClient) => Promise<T>): Promise<T> {
    const account = await this.account(access);
    return account.lock.run(async () => {
      const hit = account.lists.get(key);
      if (hit && this.clock() - hit[0] < LIST_CACHE_SECONDS) return hit[1] as T;
      const gen = account.gen;
      const result = await this.run(account, work);
      if (gen === account.gen) account.lists.set(key, [this.clock(), result]); // not cached when the account was changed while the answer was on its way
      return result;
    });
  }

  week(access: Access): Promise<PlanDay[]> {
    const d = new Date(this.clock() * 1000); // the local calendar day (date.fromtimestamp)
    const today = `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return this.cachedList(access, 'week', (c) => c.week(today));
  }

  collections(access: Access): Promise<Collection[]> { return this.cachedList(access, 'collections', (c) => c.collections()); }

  async recipe(access: Access, rid: string): Promise<RecipeDetails> { return (await this.recipeFetched(access, rid))[0]; }

  /** The recipe and whether it was asked of Cookidoo now (false: it came from the cache). `bulk` is for the background runs: the call is
   * counted against the bulk budget and the answer is not cached. `pace` is awaited just before a call to Cookidoo is made (not on a
   * cache hit) and before the account's lock is taken, so that waiting never holds up other requests. */
  async recipeFetched(access: Access, rid: string, opts: { bulk?: boolean; pace?: () => Promise<void> } = {}): Promise<[RecipeDetails, boolean]> {
    const bulk = opts.bulk ?? false;
    const account = await this.account(access);
    let hit = account.recipes.get(rid);
    if (hit && this.clock() - hit[0] < RECIPE_CACHE_SECONDS) return [hit[1], false];
    if (opts.pace) await opts.pace();
    return account.lock.run(async () => {
      hit = account.recipes.get(rid);
      if (hit && this.clock() - hit[0] < RECIPE_CACHE_SECONDS) return [hit[1], false] as [RecipeDetails, boolean];
      const gen = account.gen;
      const details = await this.run(account, (c) => c.recipe(rid), bulk);
      if (gen === account.gen && !bulk) {
        if (account.recipes.size >= RECIPE_CACHE_MAX) account.recipes.delete(account.recipes.keys().next().value!);
        account.recipes.set(rid, [this.clock(), details]);
      }
      return [details, true] as [RecipeDetails, boolean];
    });
  }

  /** One fresh sign-in attempt (an existing sign-in is dropped first), braked like every other sign-in: not within 30 seconds of the
   * last check, not within five minutes after a refusal (unless the account was changed, and then not within 30 seconds of the refusal). */
  async check(access: Access): Promise<void> {
    const account = await this.account(access);
    await account.lock.run(async () => {
      const now = this.clock();
      if (now - account.lastCheck < LOGIN_GAP) throw new CookidooError('wait');
      account.lastCheck = now;
      await this.drop(account);
      await this.run(account, (c) => c.ping());
    });
  }

  /** Remove everything held for an account (client, caches, brake, error): after it was removed or changed. */
  async forget(key: string): Promise<void> {
    for (const listener of this.listeners) listener(key);
    const account = this.accounts.get(key);
    if (account !== undefined) { // the record stays (it holds the times of the last refusal and check), emptied
      await this.drop(account);
      account.gen += 1;
      account.settings = null;
      account.lists.clear();
      account.recipes.clear();
      account.blockedUntil = 0.0;
      account.lastError = null;
    }
  }

  async aclose(): Promise<void> { for (const account of [...this.accounts.values()]) await this.drop(account); }
}

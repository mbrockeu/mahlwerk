// The real client behind `CookidooClient` (cookidoo.ts): the three calls Mahlwerk needs from Cookidoo (sign in, recipe details, the
// meal plan of a week) plus the two reads of the collection lists, done the way the unofficial package cookidoo-api 0.19.0 does them
// (MIT licence, Copyright (c) 2024 Cyrill Raccaud). It talks through `Outgoing` (core/outgoing.ts), purpose `cookidoo`; the hosts are
// constants (there is no way to point it elsewhere): tests give it an `Outgoing` that answers locally.
//
// The flow, as the package does it:
//  1. sign in (OAuth2 authorisation code + PKCE, public client, no secret): discovery document of the identity provider; the
//     authorisation page (redirects followed, cookies kept) which holds a `requestId`; the credentials posted to the login service,
//     whose redirects are followed by hand (never off the identity provider's host) until the one to the app's address
//     `com.vorwerk.cookidoo://code-grant?code=..&state=..`; the code exchanged for tokens at the token endpoint.
//  2. every request carries `Authorization: Bearer <token>`; the token is renewed (refresh token) shortly before it ends.
//  3. the paths of the API are not constants: each service lists its endpoints in `<service>/.well-known/home` (HAL); only the
//     services Mahlwerk uses are asked (recipes/recipe, planning, organize), once per client, retried once.
// Credentials and tokens never leave this class: not into logs, not into errors (an error is only a category of MESSAGES).
import { b64url, randomBytes, sha256, tokenUrlsafe, utf8 } from './crypto.ts';
import { CookidooError, MAX_COLLECTION_RECIPES, Mutex, REQUEST_TIMEOUT, type Collection, type CookidooClient, type NutritionEntry, type PlanDay, type RecipeDetails, type Settings } from './cookidoo.ts';
import { LOCALIZATION } from './cookidooLocalization.ts';
import { OutError, type Outgoing, type OutResponse } from './outgoing.ts';
import { VERSION } from './version.ts';

const CIAM_BASE_URL = 'https://ciam.prod.cookidoo.vorwerk-digital.com';
const CIAM_LOGIN_SRV_URL = `${CIAM_BASE_URL}/login-srv/login`;
const OIDC_DISCOVERY_URL = `${CIAM_BASE_URL}/.well-known/openid-configuration`;
const OAUTH_CLIENT_ID = 'mobile-android'; // public identifiers of the Cookidoo app, not credentials
const OAUTH_REDIRECT_URI = 'com.vorwerk.cookidoo://code-grant';
const OAUTH_SCOPE = 'openid profile email offline offline_access';
const TOKEN_EXPIRY_MARGIN_S = 300;
// the login runs behind a bot filter that flags clients without a browser-like User-Agent: sent with the login and discovery requests only
const LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const API_UA = `Mahlwerk/${VERSION}`;
const JSON_ACCEPT = 'application/json';
const CUSTOM_COLLECTIONS_ACCEPT = 'application/vnd.vorwerk.organize.custom-list.mobile+json';
const MANAGED_COLLECTIONS_ACCEPT = 'application/vnd.vorwerk.organize.managed-list.mobile+json';
const MAX_BODY = 20_000_000; // bytes of one answer
const MAX_REDIRECTS = 10;

// rel of the well-known document -> [service, shape of the path as we use it]
const RELS: Record<string, [string, string]> = {
  'recipe:details': ['recipes/recipe', 'recipes/recipe/{language}/{id}'],
  'organize:api-custom-list': ['organize', 'organize/{language}/api/custom-list'],
  'organize:api-managed-list': ['organize', 'organize/{language}/api/managed-list'],
  'planning:api-my-week-from-date': ['planning', 'planning/{language}/api/my-week/{day}'],
};
const TOKEN_RE = /(\{\/?)([A-Za-z0-9_]+)(\})/g;
// Cookidoo's own token names mapped to the names of ours they may stand for (a swap of two placeholders is caught)
const KNOWN_TOKEN_ALIASES: Record<string, string[]> = { lang: ['language', 'locale'], id: ['id'], dayKey: ['day'], recipeId: ['recipe'] };

/** A discovered href turned into our own template shape (`well_known._normalize_href`); null when its shape cannot be reconciled. */
export function normalizeHref(href: string, shape: string): string | null {
  const path = href.replace(/^https?:\/\/[^/]+/, '').replace(/\{[?&].*$/, '');
  const ours = [...shape.matchAll(TOKEN_RE)].map((m) => m[2]!);
  const found = [...path.matchAll(TOKEN_RE)].map((m) => m[2]!);
  if (ours.length !== found.length) return null;
  for (const [i, name] of found.entries()) {
    const expected = Object.hasOwn(KNOWN_TOKEN_ALIASES, name) ? KNOWN_TOKEN_ALIASES[name] : undefined;
    if (expected !== undefined && !expected.includes(ours[i]!)) return null;
  }
  let i = 0;
  return path.replace(TOKEN_RE, (_m, open: string) => `${open === '{/' ? '/' : ''}{${ours[i++]}}`).replace(/^\/+/, '');
}

class Parse extends Error {} // the answer does not have the shape that is needed (becomes `unexpected`)

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new Parse();
}
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Parse(); // null is no number (a recipe without a value must not become 0)
  return n;
}
const obj = (v: unknown): Record<string, unknown> => { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Parse(); return v as Record<string, unknown>; };
const arr = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Parse(); return v; };
const need = (o: Record<string, unknown>, key: string): unknown => { if (!Object.hasOwn(o, key)) throw new Parse(); return o[key]; };

// ---- a small cookie jar (the login needs the cookies of the identity provider across its redirects) ----

interface Cookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number | null }

class Jar {
  private items: Cookie[] = [];
  /** `headers`: the raw Set-Cookie values of an answer to `url`. */
  store(url: URL, headers: string[], now: number): void {
    for (const raw of headers) {
      const parts = raw.split(';');
      const eq = parts[0]!.indexOf('=');
      if (eq <= 0) continue;
      const cookie: Cookie = { name: parts[0]!.slice(0, eq).trim(), value: parts[0]!.slice(eq + 1).trim(), domain: url.hostname, hostOnly: true,
        path: url.pathname.replace(/\/[^/]*$/, '') || '/', secure: false, expires: null };
      let drop = false;
      for (const attr of parts.slice(1)) {
        const [k, ...rest] = attr.split('=');
        const v = rest.join('=').trim();
        switch (k!.trim().toLowerCase()) {
          case 'domain': {
            const d = v.replace(/^\./, '').toLowerCase();
            if (d && (url.hostname === d || url.hostname.endsWith('.' + d))) { cookie.domain = d; cookie.hostOnly = false; } else drop = true;
            break;
          }
          case 'path': if (v.startsWith('/')) cookie.path = v; break;
          case 'secure': cookie.secure = true; break;
          case 'max-age': { const n = Number(v); if (Number.isFinite(n)) cookie.expires = now + n; break; }
          case 'expires': { const t = Date.parse(v); if (!Number.isNaN(t) && cookie.expires === null) cookie.expires = t / 1000; break; }
        }
      }
      if (drop) continue;
      this.items = this.items.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
      if (cookie.expires === null || cookie.expires > now) this.items.push(cookie);
      if (this.items.length > 100) this.items.shift();
    }
  }
  header(url: URL, now: number): string | null {
    const mine = this.items.filter((c) => (c.expires === null || c.expires > now) && (c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith('.' + c.domain))
      && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')) && (!c.secure || url.protocol === 'https:'));
    return mine.length ? mine.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  }
}

/** The raw Set-Cookie values of an answer: the host's list when it has one, else the joined header split where a new cookie starts. */
function setCookies(r: OutResponse): string[] {
  if (r.setCookies) return r.setCookies;
  const joined = r.headers['set-cookie'];
  return joined ? joined.split(/,\s*(?=[^;,=\s]+=)/) : [];
}

const textOf = (r: OutResponse): string => new TextDecoder().decode(r.body);
const jsonContent = (r: OutResponse): boolean => /^application\/(?:[\w.+-]+?\+)?json/i.test(r.headers['content-type'] ?? '');

const form = (data: Record<string, string>): string => new URLSearchParams(data).toString();

/** The real client. One instance is one signed-in session (cookies, tokens, discovered paths); `close()` forgets all of it. */
export class LibraryClient implements CookidooClient {
  private settings: Settings;
  private out: Outgoing;
  private now: () => number;
  private lock = new Mutex();
  private jar = new Jar();
  private oidc: { authorization_endpoint: string; token_endpoint: string } | null = null;
  private paths: Record<string, string> | null = null;
  private token: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  private loggedIn = false;
  private base: string | null = null;
  private localization: { country: string; language: string } | null = null;

  constructor(settings: Settings, out: Outgoing, now: () => number = () => Date.now() / 1000) { this.settings = settings; this.out = out; this.now = now; }

  // ---- transport ----

  /** One request with the cookies of the jar. Redirects are followed by hand when `follow` is set (at most 10). Transport errors become categories. */
  private async send(method: string, url: string, headers: Record<string, string>, body: string | undefined, follow: boolean): Promise<OutResponse> {
    let current = url;
    let verb = method;
    let payload = body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(current);
      const h = { ...headers };
      const cookie = this.jar.header(u, this.now());
      if (cookie) h.cookie = cookie;
      let r: OutResponse;
      try {
        r = await this.out.fetch('cookidoo', { method: verb, url: current, headers: h, body: payload, timeout: REQUEST_TIMEOUT, maxBytes: MAX_BODY });
      } catch (e) {
        if (e instanceof OutError) throw new CookidooError(e.kind === 'too_large' ? 'unexpected' : 'unavailable');
        throw new CookidooError('unavailable');
      }
      this.jar.store(u, setCookies(r), this.now());
      const location = r.headers.location;
      if (!follow || ![301, 302, 303, 307, 308].includes(r.status) || !location) return r;
      let next: URL;
      try { next = new URL(location, u); } catch { throw new CookidooError('unavailable'); }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') return r;
      current = next.href;
      if (r.status !== 307 && r.status !== 308) { verb = 'GET'; payload = undefined; }
    }
    throw new CookidooError('unavailable'); // too many redirects
  }

  private json(r: OutResponse): unknown {
    try { return JSON.parse(textOf(r)); } catch { throw new CookidooError('unexpected'); }
  }

  // ---- sign in ----

  private async discovery(): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
    if (this.oidc === null) {
      const r = await this.send('GET', OIDC_DISCOVERY_URL, { 'user-agent': LOGIN_UA, accept: '*/*' }, undefined, false);
      if (r.status < 200 || r.status >= 300) throw new CookidooError('unavailable');
      const doc = this.json(r) as Record<string, unknown>;
      if (typeof doc?.authorization_endpoint !== 'string' || typeof doc?.token_endpoint !== 'string') throw new CookidooError('unexpected');
      this.oidc = { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint };
    }
    return this.oidc;
  }

  private localizationOf(): { country: string; language: string; base: string } {
    if (this.localization === null || this.base === null) {
      const hit = LOCALIZATION.find(([c, l]) => c === this.settings.country && l === this.settings.language);
      if (!hit) throw new CookidooError('unexpected');
      this.localization = { country: hit[0], language: hit[1] };
      this.base = new URL(hit[2]).origin;
    }
    return { ...this.localization, base: this.base };
  }

  async login(): Promise<void> {
    const oidc = await this.discovery();
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(await sha256(utf8(verifier)));
    const state = tokenUrlsafe(12);
    const loc = this.localizationOf();
    const params = new URLSearchParams({ response_type: 'code', client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT_URI, market: loc.country,
      scope: OAUTH_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', ui_locales: loc.language });
    const authorize = new URL(oidc.authorization_endpoint);
    for (const [k, v] of params) authorize.searchParams.set(k, v);
    // step 2: reach the login form (redirects followed, cookies kept)
    const page = await this.send('GET', authorize.href, { 'user-agent': LOGIN_UA, accept: '*/*' }, undefined, true);
    if (page.status !== 200) throw new CookidooError('auth');
    // step 3: the request id of the form, then the credentials; step 4: the code from the redirect to the app's address
    const html = textOf(page);
    const id = /<input[^>]*name=["']requestId["'][^>]*value=["']([^"']+)["']/.exec(html) ?? /<input[^>]*value=["']([0-9a-f-]{36})["'][^>]*name=["']requestId["']/.exec(html);
    if (!id) throw new CookidooError('unexpected');
    const code = await this.submitCredentials(id[1]!, state);
    // step 5: the code for the tokens
    const r = await this.send('POST', oidc.token_endpoint, { 'user-agent': LOGIN_UA, accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' },
      form({ grant_type: 'authorization_code', code, redirect_uri: OAUTH_REDIRECT_URI, code_verifier: verifier, client_id: OAUTH_CLIENT_ID }), false);
    if (r.status !== 200) throw new CookidooError('auth');
    this.applyTokens(this.json(r));
  }

  private async submitCredentials(requestId: string, state: string): Promise<string> {
    let url = CIAM_LOGIN_SRV_URL;
    let method = 'POST';
    let body: string | undefined = form({ requestId, username: this.settings.email, password: this.settings.password });
    for (let i = 0; i < 10; i++) {
      const headers: Record<string, string> = { 'user-agent': LOGIN_UA, accept: '*/*' };
      if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
      const r = await this.send(method, url, headers, body, false);
      const location = r.headers.location;
      if ([301, 302, 303, 307, 308].includes(r.status) && location) {
        if (location.startsWith(OAUTH_REDIRECT_URI)) {
          const query = new URL(location).searchParams;
          if (query.getAll('state').length !== 1 || query.get('state') !== state) throw new CookidooError('auth'); // a missing state is a mismatch too
          const codes = query.getAll('code');
          if (!codes.length) break;
          return codes[0]!;
        }
        let next: URL;
        try { next = new URL(location, url); } catch { throw new CookidooError('auth'); }
        if (next.origin !== new URL(CIAM_BASE_URL).origin) throw new CookidooError('auth'); // the login never leaves the identity provider's host
        url = next.href;
        [method, body] = ['GET', undefined];
        continue;
      }
      break;
    }
    throw new CookidooError('auth'); // no authorisation code: the credentials were refused
  }

  private applyTokens(payload: unknown): void {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== 'object' || typeof p.access_token !== 'string') throw new CookidooError('auth');
    const refresh = Object.hasOwn(p, 'refresh_token') ? p.refresh_token : this.refreshToken; // a refresh answer may omit a new one: keep the old
    const expires = Object.hasOwn(p, 'expires_in') ? Number(p.expires_in) : 43200;
    if (!Number.isFinite(expires) || (refresh !== null && typeof refresh !== 'string')) throw new CookidooError('auth');
    this.token = p.access_token;
    this.refreshToken = refresh as string | null;
    this.expiresAt = this.now() + Math.trunc(expires);
    this.loggedIn = true;
  }

  private get signedIn(): boolean { return this.loggedIn && this.refreshToken !== null; }

  private async refresh(): Promise<void> {
    if (this.refreshToken === null) throw new CookidooError('auth');
    const oidc = await this.discovery();
    const r = await this.send('POST', oidc.token_endpoint, { 'user-agent': LOGIN_UA, accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' },
      form({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: OAUTH_CLIENT_ID }), false);
    if (r.status !== 200) throw new CookidooError('auth');
    this.applyTokens(this.json(r));
  }

  private async ensureToken(): Promise<void> {
    if (this.loggedIn && this.now() >= this.expiresAt - TOKEN_EXPIRY_MARGIN_S) await this.refresh();
  }

  // ---- the API ----

  private async wellKnown(): Promise<Record<string, string>> {
    if (this.paths !== null) return this.paths;
    const base = this.localizationOf().base;
    const attempt = async (): Promise<Record<string, string>> => {
      const services = [...new Set(Object.values(RELS).map(([s]) => s))].sort();
      const links = new Map<string, Record<string, string> | null>();
      await Promise.all(services.map(async (service) => {
        let found: Record<string, string> | null = null;
        try {
          const r = await this.send('GET', `${base}/${service}/.well-known/home`, { 'user-agent': LOGIN_UA, accept: JSON_ACCEPT }, undefined, false);
          const doc = r.status === 200 ? JSON.parse(textOf(r)) : null;
          const raw = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc._links : null;
          if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
            found = {};
            for (const [rel, value] of Object.entries(raw as Record<string, unknown>)) {
              const first = Array.isArray(value) ? value[0] : value;
              const href = first !== null && typeof first === 'object' ? (first as Record<string, unknown>).href : undefined;
              if (typeof href === 'string') found[rel] = href;
            }
          }
        } catch { found = null; }
        links.set(service, found);
      }));
      const out: Record<string, string> = {};
      for (const [rel, [service, shape]] of Object.entries(RELS)) {
        const l = links.get(service);
        if (!l) throw new CookidooError('unavailable'); // the service's document could not be reached
        if (!Object.hasOwn(l, rel)) throw new CookidooError('unexpected');
        const normal = normalizeHref(l[rel]!, shape);
        if (normal === null) throw new CookidooError('unexpected');
        out[rel] = normal;
      }
      return out;
    };
    try { this.paths = await attempt(); } catch (e) {
      if (!(e instanceof CookidooError) || (e.kind !== 'unavailable' && e.kind !== 'unexpected')) throw e;
      this.paths = await attempt(); // once more: a hiccup should not need a whole new request cycle
    }
    return this.paths;
  }

  private async api(rel: string, values: Record<string, string>, query?: Record<string, string>, accept?: string): Promise<Record<string, unknown>> {
    const paths = await this.wellKnown();
    const loc = this.localizationOf();
    const all: Record<string, string> = { language: loc.language, ...values };
    const path = paths[rel]!.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(all[name] ?? ''));
    const url = new URL(`${loc.base}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    await this.ensureToken();
    const r = await this.send('GET', url.href, { 'user-agent': API_UA, accept: accept ?? JSON_ACCEPT, authorization: `Bearer ${this.token}` }, undefined, false);
    if (r.status === 401) throw new CookidooError('auth');
    if (r.status !== 200) throw new CookidooError('unavailable'); // 204 has no body: nothing to read either
    if (!jsonContent(r)) throw new CookidooError('unavailable');
    return obj(this.json(r));
  }

  // ---- what Mahlwerk asks ----

  private async call<T>(work: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      this.localizationOf();
      try {
        if (!this.signedIn) await this.login();
        try {
          return await work();
        } catch (e) {
          if (!(e instanceof CookidooError) || e.kind !== 'auth') throw e;
          await this.login(); // the token was refused: sign in afresh, once
          return await work();
        }
      } catch (e) {
        if (e instanceof CookidooError) {
          if (e.kind === 'auth') await this.close();
          throw e;
        }
        throw new CookidooError('unexpected'); // a parse problem or anything unforeseen (never the text of it)
      }
    });
  }

  week(day: string): Promise<PlanDay[]> {
    return this.call(async () => {
      const result = await this.api('planning:api-my-week-from-date', { day });
      return arr(need(result, 'myDays')).map((d) => {
        const o = obj(d);
        return { day: str(need(o, 'id')), title: str(need(o, 'title')), recipes: arr(need(o, 'recipes')).map((r) => refOf(r)) }; // custom recipes (`customerRecipes`) are not read
      });
    });
  }

  collections(): Promise<Collection[]> {
    return this.call(async () => {
      const result: Collection[] = [];
      for (const [managed, rel, key, accept] of [[false, 'organize:api-custom-list', 'customlists', CUSTOM_COLLECTIONS_ACCEPT], [true, 'organize:api-managed-list', 'managedlists', MANAGED_COLLECTIONS_ACCEPT]] as const) {
        const answer = await this.api(rel, {}, { page: '0' }, accept);
        for (const item of arr(need(answer, key))) {
          const o = obj(item);
          const recipes = arr(need(o, 'chapters')).flatMap((ch) => arr(need(obj(ch), 'recipes')).map((r) => refOf(r)));
          result.push({ id: str(need(o, 'id')), name: str(need(o, 'title')), managed, recipes: recipes.slice(0, MAX_COLLECTION_RECIPES) });
        }
      }
      return result;
    });
  }

  recipe(recipeId: string): Promise<RecipeDetails> {
    return this.call(async () => {
      const r = await this.api('recipe:details', { id: recipeId });
      const nutrition: NutritionEntry[] = [];
      for (const group of arr(r.nutritionGroups ?? [])) {
        for (const rn of arr(need(obj(group), 'recipeNutritions'))) {
          const n = obj(rn);
          const values = new Map<string, [number, string]>();
          for (const item of arr(need(n, 'nutritions'))) {
            const v = obj(item);
            values.set(str(need(v, 'type')), [num(need(v, 'number')), str(need(v, 'unittype'))]);
          }
          nutrition.push({ quantity: num(need(n, 'quantity')), unit: str(need(n, 'unitNotation')), values });
        }
      }
      const serving = obj(need(obj(need(r, 'servingSize')), 'quantity')).value;
      const portions = serving === null || serving === undefined || serving === '' ? 0 : num(serving);
      return { id: str(need(r, 'id')), name: str(need(r, 'title')), portions: portions || null, nutrition, image: imageOf(r.descriptiveAssets) };
    });
  }

  /** Sign in (when there is no token yet) and do nothing else. */
  ping(): Promise<void> { return this.call(async () => undefined); }

  async close(): Promise<void> {
    this.jar = new Jar();
    this.oidc = null;
    this.paths = null;
    this.token = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.loggedIn = false;
  }
}

function refOf(v: unknown): { id: string; name: string } {
  const o = obj(v);
  return { id: str(need(o, 'id')), name: str(need(o, 'title')) };
}

/** The address of the recipe picture: the first of the assets that has a square, portrait or landscape picture, in the size of the
 * recipe page (the placeholder `{transformation}` of the address is filled). */
function imageOf(assets: unknown): string | null {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (asset === null || typeof asset !== 'object') continue;
    for (const [variant, url] of Object.entries(asset as Record<string, unknown>)) {
      if (url && ['square', 'portrait', 'landscape'].includes(variant)) return String(url).replaceAll('{transformation}', 't_web_rdp_recipe_584x480_1_5x') || null;
    }
  }
  return null;
}

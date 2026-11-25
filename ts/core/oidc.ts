// Sign-in through an OpenID Connect provider (oidc.py): configuration, the provider client and the checks of the ID token. The
// routes are in routes/oidc.ts. The flow is the Authorization Code Flow with PKCE (S256), with `state` and `nonce`.
//
// About the signature of the ID token (SECURITY.md has the long version): it is NOT verified, on purpose and as the standard
// allows. OpenID Connect Core 3.1.3.7 step 6: when the ID token is received directly from the token endpoint over TLS, "the TLS
// server validation MAY be used to validate the issuer in place of checking the token signature". Everything else in 3.1.3.7 IS
// checked: iss, aud (and azp), exp, iat, nonce, and the presence of sub. The price: whoever can terminate or forge TLS to the
// provider can forge identities, and the check fails open if the issuer is `http` (MAHLWERK_OIDC_ALLOW_HTTP, for tests and
// localhost only). No JWT library and no key fetching are needed.
import { b64url, compareDigest, hmacSha256, sha256, tokenUrlsafe, unb64url, utf8 } from './crypto.ts';
import type { Ctx } from './http.ts';
import { parseIp, ipv4Mapped } from './netutil.ts';
import { OutError, outgoing } from './outgoing.ts';
import { urlsplit } from './urlsplit.ts';

export const CALLBACK_PATH = '/api/v1/auth/oidc/callback';
const DEFAULT_SCOPES = 'openid profile groups';
const DISCOVERY_TTL = 3600;
const STALE_MAX = 86400; // a failed refresh may keep using the cached document for this long
const MAX_BODY = 256 * 1024;
export const PENDING_TTL = 600;
const TOTAL_DEADLINE = 10.0; // seconds for one request to the provider, however slowly the bytes trickle in
const CONNECT_TIMEOUT = 5.0;
const DISCOVERY_PAUSE = 60; // after a failed discovery fetch nobody tries again for this long
const RATE_LIMIT = 30; // login and callback requests per address and minute, each
const RATE_WINDOW = 60;
const RATE_MAX_KEYS = 20000;
const CLOCK_SKEW = 60; // seconds of tolerance for exp, iat and nbf
const IAT_MAX_AGE = 600; // a token issued longer ago than this is not the answer to the request we just made
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/; // checked on the RAW value, lower-cased only afterwards
const TRUE = ['1', 'true', 'yes'];

/** A sign-in that must end. `code` is shown to the browser (a fixed word); `detail` goes to the log only and never contains
 * tokens, codes, secrets or claim values. */
export class OidcError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail = '') {
    super(detail || code);
    this.code = code;
    this.detail = detail || code;
  }
}

const flag = (env: Record<string, string | undefined>, name: string) => TRUE.includes((env[name] ?? '').trim().toLowerCase());
const chars = (s: string) => [...s];
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);
/** str.isprintable() per character */
const printable = (ch: string) => ch === ' ' || !/[\p{C}\p{Z}]/u.test(ch);

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[+|\]+$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  const ip = parseIp(h);
  if (!ip) return false;
  if (ip.v === 4) return ip.bytes[0] === 127;
  const mapped = ipv4Mapped(ip);
  if (mapped !== null) return mapped.startsWith('127.');
  return ip.bytes.slice(0, 15).every((b) => b === 0) && ip.bytes[15] === 1;
}

/** An https URL with a host, no user info, no fragment. With `allowHttp` plain http is accepted for loopback hosts only. */
export function isUrl(value: string, allowHttp: boolean): boolean {
  let parsed;
  try {
    parsed = urlsplit(value);
    void parsed.port; // raises for a bad port
  } catch { return false; }
  if (!parsed.hostname || parsed.netloc.includes('@') || parsed.fragment) return false;
  return parsed.scheme === 'https' || (allowHttp && parsed.scheme === 'http' && isLoopback(parsed.hostname));
}

export interface OidcConfig {
  issuer: string;
  client_id: string;
  client_secret: string; // never printed, never in an answer
  client_auth: string;
  scopes: string;
  scopes_given: boolean;
  username_claim: string;
  name_claim: string;
  groups_claim: string;
  admin_group: string;
  household_groups: Set<string> | null;
  redirect_url: string;
  home_path: string;
  button_label: string;
  link_existing: boolean;
  allow_http: boolean;
}

const tail = (path: string) => path.replace(/\/+$/, '');

/** Read and check the settings; throws an Error (naming the variable, never a value) if something is missing or wrong, so that a
 * half configured server does not start. */
export function oidcConfigFromEnv(env: Record<string, string | undefined>, adminGroup: string, householdGroups: Set<string> | null = null): OidcConfig {
  const get = (name: string) => env[name] ?? '';
  const allowHttp = flag(env, 'MAHLWERK_OIDC_ALLOW_HTTP');
  const issuer = get('MAHLWERK_OIDC_ISSUER').trim();
  const clientId = get('MAHLWERK_OIDC_CLIENT_ID').trim();
  const pub = get('MAHLWERK_PUBLIC_URL').trim();
  let redirect = get('MAHLWERK_OIDC_REDIRECT_URL').trim();
  const missing = ([['MAHLWERK_OIDC_ISSUER', issuer], ['MAHLWERK_OIDC_CLIENT_ID', clientId]] as const).filter(([, v]) => !v).map(([n]) => n as string);
  if (!redirect && !pub) missing.push('MAHLWERK_PUBLIC_URL (or MAHLWERK_OIDC_REDIRECT_URL)');
  if (missing.length) throw new Error('MAHLWERK_AUTH=oidc needs ' + missing.join(', '));
  const scheme = !allowHttp ? 'https' : 'https (or http on loopback)';
  if (!isUrl(issuer, allowHttp) || urlsplit(issuer).query) {
    throw new Error(`MAHLWERK_OIDC_ISSUER must be a ${scheme} URL without query or fragment (http only on loopback and only with MAHLWERK_OIDC_ALLOW_HTTP=1)`);
  }
  let home = '/';
  if (!redirect) {
    if (!isUrl(pub, allowHttp) || urlsplit(pub).query) {
      throw new Error(`MAHLWERK_PUBLIC_URL must be a ${scheme} URL (http only on loopback and only with MAHLWERK_OIDC_ALLOW_HTTP=1)`);
    }
    redirect = tail(pub) + CALLBACK_PATH;
    home = tail(urlsplit(pub).path) + '/';
  } else if (!isUrl(redirect, allowHttp) || urlsplit(redirect).query) {
    throw new Error(`MAHLWERK_OIDC_REDIRECT_URL must be a ${scheme} URL (http only on loopback and only with MAHLWERK_OIDC_ALLOW_HTTP=1)`);
  } else if (redirect.endsWith(CALLBACK_PATH)) {
    const path = urlsplit(redirect).path;
    home = tail(path.slice(0, path.length - CALLBACK_PATH.length)) + '/';
  }
  const method = (env.MAHLWERK_OIDC_CLIENT_AUTH ?? 'basic').trim().toLowerCase(); // set but empty is refused, like in Python
  if (method !== 'basic' && method !== 'post') throw new Error("MAHLWERK_OIDC_CLIENT_AUTH must be 'basic' or 'post'");
  const label = chars(get('MAHLWERK_OIDC_BUTTON_LABEL').trim()).filter(printable).slice(0, 60).join('');
  const scopesRaw = get('MAHLWERK_OIDC_SCOPES').replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  const scopes = scopesRaw || DEFAULT_SCOPES;
  if (!scopes.split(' ').includes('openid')) throw new Error("MAHLWERK_OIDC_SCOPES must contain 'openid'");
  return {
    issuer, client_id: clientId, client_secret: get('MAHLWERK_OIDC_CLIENT_SECRET').trim(), client_auth: method, scopes, scopes_given: Boolean(scopesRaw),
    username_claim: get('MAHLWERK_OIDC_USERNAME_CLAIM').trim() || 'preferred_username',
    name_claim: get('MAHLWERK_OIDC_NAME_CLAIM').trim() || 'name',
    groups_claim: get('MAHLWERK_OIDC_GROUPS_CLAIM').trim() || 'groups',
    admin_group: adminGroup, household_groups: householdGroups, redirect_url: redirect, home_path: home, button_label: label,
    link_existing: flag(env, 'MAHLWERK_OIDC_LINK_EXISTING'), allow_http: allowHttp,
  };
}

/** The user name from the claim, normalised like the local mode does (lower case, a-z 0-9 . _ -, up to 40), or null. */
export function cleanUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  // ASCII and the pattern on the raw value first: lower() on "K" (Kelvin sign) gives a plain "k", and a name must not become
  // something else than what the provider sent
  if (!isAscii(v) || !USERNAME.test(v)) return null;
  return v.toLowerCase();
}

export function cleanDisplay(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const v = chars(value.trim()).filter(printable).slice(0, 80).join('').trim();
    if (v) return v;
  }
  return fallback;
}

/** Group names from the claim: a list of strings (or one string). */
export function groupsOf(value: unknown): Set<string> {
  if (typeof value === 'string') return value ? new Set([value]) : new Set();
  if (Array.isArray(value)) return new Set(value.filter((x): x is string => typeof x === 'string' && x !== ''));
  return new Set();
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await sha256(utf8(verifier)));
}

/** Where to go after the sign-in: only a plain path on this site, anything else becomes the start page. */
export function safeNext(value: string | null | undefined, homePath = '/'): string {
  if (!value || chars(value).length > 300 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.startsWith('/api')) return homePath;
  if (chars(value).some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127)) return homePath;
  try {
    const parsed = urlsplit(value);
    if (parsed.scheme || parsed.netloc) return homePath;
  } catch { return homePath; }
  return value;
}

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function jsonSegment(segment: string): Record<string, unknown> {
  let data: unknown;
  try {
    const raw = unb64url(segment);
    if (raw === null) throw new Error('b64');
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch { throw new OidcError('failed', 'id token is not a JWT'); }
  if (!isDict(data)) throw new OidcError('failed', 'id token is not a JWT');
  return data;
}

/** A finite number, else null: no bool, no NaN or Infinity. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The claims of an ID token received from the token endpoint over TLS, after the checks of OpenID Connect Core 3.1.3.7 except the
 * signature (see the top of this file). Throws OidcError. */
export function checkIdToken(token: string, o: { issuer: string; clientId: string; nonce: string; now: number }): Record<string, any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('failed', 'id token is not a JWT');
  jsonSegment(parts[0]!); // the header must at least be JSON
  const claims = jsonSegment(parts[1]!);
  if (claims.iss !== o.issuer) throw new OidcError('failed', 'id token: wrong issuer');
  const aud = claims.aud;
  const audiences: string[] = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every((a) => typeof a === 'string') ? aud : [];
  if (!audiences.includes(o.clientId)) throw new OidcError('failed', 'id token: client is not in aud');
  const azp = claims.azp ?? null;
  if ((audiences.length > 1 && azp === null) || (azp !== null && azp !== o.clientId)) throw new OidcError('failed', 'id token: azp does not match');
  const exp = num(claims.exp), iat = num(claims.iat), nbf = num(claims.nbf);
  if (exp === null || exp + CLOCK_SKEW <= o.now) throw new OidcError('failed', 'id token: expired or no exp');
  if (iat === null || iat > o.now + CLOCK_SKEW || iat < o.now - IAT_MAX_AGE) throw new OidcError('failed', 'id token: iat is not recent');
  if ('nbf' in claims && (nbf === null || nbf > o.now + CLOCK_SKEW)) throw new OidcError('failed', 'id token: not yet valid');
  const got = claims.nonce;
  if (typeof got !== 'string' || !compareDigest(got, o.nonce)) throw new OidcError('failed', 'id token: nonce differs');
  const sub = claims.sub;
  if (typeof sub !== 'string' || !sub || chars(sub).length > 255) throw new OidcError('failed', 'id token: no usable sub');
  return claims;
}

export interface Pending { state: string; nonce: string; verifier: string; next: string }

/** The pending sign-in as ONE cookie value: the data, the expiry and an HMAC-SHA256 over both. Nothing is kept on the server. The
 * content is signed, not encrypted: it is an HttpOnly cookie that only this browser sends back (Secure behind HTTPS). */
export async function sealLogin(key: Uint8Array, pending: Pending, now: number): Promise<string> {
  const body = b64url(utf8(JSON.stringify({ s: pending.state, n: pending.nonce, v: pending.verifier, x: pending.next, e: Math.trunc(now) + PENDING_TTL })));
  return body + '.' + b64url(await hmacSha256(key, utf8(body)));
}

/** The pending sign-in in a cookie value, or null when the signature or the data is wrong or the 10 minutes are over (decided from
 * the signed expiry, on the server's clock). Single use is NOT enforced here: the cookie is deleted by the callback's answer, and
 * the real guard is the provider, which accepts an authorization code once. The state in the URL must equal the one in the
 * cookie, which binds the answer to the browser that started the sign-in (login CSRF). */
export async function openLogin(key: Uint8Array, value: string, now: number): Promise<Pending | null> {
  const dot = value.indexOf('.');
  const body = dot < 0 ? value : value.slice(0, dot);
  const tag = dot < 0 ? '' : value.slice(dot + 1);
  if (!body || !tag || value.length > 4000) return null;
  if (!compareDigest(tag, b64url(await hmacSha256(key, utf8(body))))) return null;
  try {
    const raw = unb64url(body);
    if (raw === null) return null;
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!isDict(data)) return null;
    if (typeof data.e !== 'number' || data.e <= now) return null;
    if (!('s' in data && 'n' in data && 'v' in data && 'x' in data)) return null;
    return { state: String(data.s), nonce: String(data.n), verifier: String(data.v), next: String(data.x) };
  } catch { return null; }
}

/** At most `limit` requests per key within `window` seconds (sliding), in memory: keeps one address from making the server call the
 * provider without end. */
export class RateLimit {
  private hits = new Map<string, number[]>();
  private clock: () => number;
  private limit: number;
  private window: number;
  constructor(clock: () => number, limit = RATE_LIMIT, window = RATE_WINDOW) { this.clock = clock; this.limit = limit; this.window = window; }

  /** 0 = go ahead (and counted), else the seconds to wait. */
  allow(key: string): number {
    const now = this.clock();
    const hits = (this.hits.get(key) ?? []).filter((t) => t > now - this.window);
    if (hits.length >= this.limit) {
      this.hits.set(key, hits);
      return Math.max(1, Math.trunc(hits[0]! + this.window - now) + 1);
    }
    hits.push(now);
    this.hits.set(key, hits);
    if (this.hits.size > RATE_MAX_KEYS) {
      for (const [k, v] of [...this.hits]) if (!v.length || v[v.length - 1]! <= now - this.window) this.hits.delete(k);
    }
    return 0;
  }
}

/** Python's urllib.parse.quote(text, safe=''): everything but letters, digits and `_.-~` is percent-encoded. */
export const quote = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** urllib.parse.parse_qsl(query, keep_blank_values=True) */
function parseQsl(query: string): [string, string][] {
  const un = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  return query.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? [un(pair), ''] : [un(pair.slice(0, eq)), un(pair.slice(eq + 1))];
  });
}

/** Talks to the provider: discovery (cached), authorization URL, code exchange, userinfo. Never follows redirects (the outgoing
 * interface never does), has time limits and reads at most MAX_BODY bytes of an answer. */
export class OidcClient {
  config: OidcConfig;
  private ctx: Ctx;
  private doc: Record<string, any> | null = null;
  private fetched = 0;
  private retryAt = 0;
  private fetching = false; // one discovery fetch at a time

  constructor(ctx: Ctx, config: OidcConfig) { this.ctx = ctx; this.config = config; }

  private async readJson(method: string, url: string, what: string, o: { form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Record<string, any>> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Mahlwerk', ...(o.headers ?? {}) };
    let body: string | undefined;
    if (o.form) {
      body = Object.entries(o.form).map(([k, v]) => `${quote(k)}=${quote(v)}`.replace(/%20/g, '+')).join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    let res;
    try {
      res = await outgoing(this.ctx).fetch('oidc', { method, url, headers, body, timeout: TOTAL_DEADLINE, connectTimeout: CONNECT_TIMEOUT, maxBytes: MAX_BODY });
    } catch (e) {
      if (e instanceof OutError) throw new OidcError('failed', e.kind === 'too_large' ? `${what}: answer too large` : e.kind === 'timeout' ? `${what}: took longer than ${TOTAL_DEADLINE} s` : `${what}: ${e.kind}`);
      throw new OidcError('failed', `${what}: error`); // the exception text is not logged: it could carry a URL
    }
    if (res.status !== 200) throw new OidcError('failed', `${what}: HTTP ${res.status}`);
    if (!(res.headers['content-type'] ?? '').toLowerCase().includes('json')) throw new OidcError('failed', `${what}: not JSON`);
    if (res.body.length > MAX_BODY) throw new OidcError('failed', `${what}: answer too large`);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(res.body)); } catch { throw new OidcError('failed', `${what}: not JSON`); }
    if (!isDict(data)) throw new OidcError('failed', `${what}: unexpected JSON`);
    return data;
  }

  private urlOk(value: unknown): boolean {
    // an https issuer never has http endpoints; plain http (loopback only) exists only for an http issuer in the test setup
    return typeof value === 'string' && isUrl(value, this.config.allow_http && this.config.issuer.startsWith('http://'));
  }

  /** The provider's discovery document, cached for an hour. The issuer inside must be exactly the configured one and the endpoints
   * must be https (unless MAHLWERK_OIDC_ALLOW_HTTP on loopback). Nobody waits for the provider here: only one request refreshes at a
   * time, the others get the cached copy (up to a day old) or an immediate error. After a failed fetch nobody tries again for a minute. */
  async discovery(): Promise<Record<string, any>> {
    const now = this.ctx.now();
    const doc = this.doc;
    const age = now - this.fetched;
    const paused = now < this.retryAt;
    if (doc !== null && age < DISCOVERY_TTL) return doc;
    const stale = doc !== null && age < STALE_MAX ? doc : null;
    if (paused || this.fetching) {
      if (stale !== null) return stale;
      throw new OidcError('failed', 'discovery: provider not reachable (pause after a failure, or a fetch is running)');
    }
    this.fetching = true;
    try {
      let fresh: Record<string, any>;
      try {
        fresh = await this.fetchDiscovery();
      } catch (e) {
        if (!(e instanceof OidcError)) throw e;
        this.retryAt = this.ctx.now() + DISCOVERY_PAUSE;
        if (stale !== null) return stale;
        throw e;
      }
      this.doc = fresh;
      this.fetched = this.ctx.now();
      this.retryAt = 0;
      return fresh;
    } finally { this.fetching = false; }
  }

  private async fetchDiscovery(): Promise<Record<string, any>> {
    const url = this.config.issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
    const doc = await this.readJson('GET', url, 'discovery');
    if (doc.issuer !== this.config.issuer) throw new OidcError('failed', 'discovery: issuer differs from the configured one');
    for (const key of ['authorization_endpoint', 'token_endpoint']) {
      if (!this.urlOk(doc[key])) throw new OidcError('failed', `discovery: ${key} missing or not https`);
    }
    if (doc.userinfo_endpoint != null && !this.urlOk(doc.userinfo_endpoint)) throw new OidcError('failed', 'discovery: userinfo_endpoint not https');
    return doc;
  }

  /** The scopes to ask for. Configured ones are used as they are. The default is cut down to what the provider lists in
   * scopes_supported, because some providers answer an unknown scope with an error. */
  scopes(doc: Record<string, any>): string {
    let wanted = this.config.scopes.split(' ');
    const supported = doc.scopes_supported;
    if (!this.config.scopes_given && Array.isArray(supported) && supported.length) wanted = wanted.filter((s) => s === 'openid' || supported.includes(s));
    return wanted.join(' ');
  }

  async authorizationUrl(state: string, nonce: string, challenge: string): Promise<string> {
    const doc = await this.discovery();
    const parsed = urlsplit(doc.authorization_endpoint);
    const query = [...parseQsl(parsed.query), ['response_type', 'code'], ['client_id', this.config.client_id], ['redirect_uri', this.config.redirect_url],
      ['scope', this.scopes(doc)], ['state', state], ['nonce', nonce], ['code_challenge', challenge], ['code_challenge_method', 'S256']] as [string, string][];
    const q = query.map(([k, v]) => `${quote(k)}=${quote(v)}`).join('&');
    return `${parsed.scheme}://${parsed.netloc}${parsed.path}?${q}${parsed.fragment ? '#' + parsed.fragment : ''}`;
  }

  /** Trade the code for the tokens at the token endpoint (PKCE verifier included). Returns the JSON answer. */
  async exchange(code: string, verifier: string): Promise<Record<string, any>> {
    const doc = await this.discovery();
    const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: this.config.redirect_url, code_verifier: verifier };
    const headers: Record<string, string> = {};
    const c = this.config;
    if (c.client_secret && c.client_auth === 'basic') {
      // RFC 6749 2.3.1: id and secret are form-encoded before they are joined
      headers.Authorization = 'Basic ' + btoa(String.fromCharCode(...utf8(`${quote(c.client_id)}:${quote(c.client_secret)}`)));
    } else {
      form.client_id = c.client_id;
      if (c.client_secret) form.client_secret = c.client_secret;
    }
    return this.readJson('POST', doc.token_endpoint, 'token endpoint', { form, headers });
  }

  async userinfo(accessToken: string): Promise<Record<string, any>> {
    const doc = await this.discovery();
    const endpoint = doc.userinfo_endpoint;
    if (!endpoint) return {};
    return this.readJson('GET', endpoint, 'userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
  }

  /** The whole back half of the flow: exchange the code, check the ID token, complete the claims from userinfo when the ones we need
   * are not in the token. Returns {sub, username, display_name, admin, issuer, household}; throws OidcError. */
  async identity(code: string, verifier: string, nonce: string) {
    const config = this.config;
    const tokens = await this.exchange(code, verifier);
    const idToken = tokens.id_token;
    if (typeof idToken !== 'string' || !idToken) throw new OidcError('failed', 'token endpoint: no id_token');
    const claims = checkIdToken(idToken, { issuer: config.issuer, clientId: config.client_id, nonce, now: this.ctx.now() });
    const wanted = [config.username_claim, config.name_claim, config.groups_claim];
    const access = tokens.access_token;
    if (wanted.some((name) => claims[name] == null) && typeof access === 'string' && access) {
      const extra = await this.userinfo(access);
      if (Object.keys(extra).length) {
        if (extra.sub !== claims.sub) throw new OidcError('failed', 'userinfo: sub differs from the id token');
        for (const name of wanted) if (claims[name] == null && extra[name] != null) claims[name] = extra[name];
      }
    }
    const username = cleanUsername(claims[config.username_claim]);
    if (username === null) throw new OidcError('name', 'no usable user name in the claims');
    const display = cleanDisplay(claims[config.name_claim], username);
    const groups = groupsOf(claims[config.groups_claim]);
    return {
      issuer: config.issuer, sub: claims.sub as string, username, display_name: display, admin: groups.has(config.admin_group),
      household: config.household_groups === null || [...config.household_groups].some((g) => groups.has(g)),
    };
  }
}

/** (state, nonce, PKCE verifier, challenge): all random, the verifier 86 characters (limit 43 to 128). */
export async function newLogin(): Promise<[string, string, string, string]> {
  const verifier = tokenUrlsafe(64);
  return [tokenUrlsafe(32), tokenUrlsafe(32), verifier, await pkceChallenge(verifier)];
}

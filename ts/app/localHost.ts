// The app host: core for ONE device, in the page itself (no network server). Builds the ctx like server/main.ts and services.ts,
// with the database, the catalogue and outgoing HTTP over the native bridge, and answers requests in-process through the router the
// Node server uses (core/dispatch.ts).
//
// Left out on purpose (the middleware of a network server): the host check (no host name, no DNS rebinding in-process), the CSRF
// header (no cookie, no foreign page can reach this function), proxy headers, the security headers and the static files. The body
// limit stays: it also caps what a handler has to hold in memory.
//
// Off in the app, and why:
// - sign-in: `single` (one person, no password, no session); OIDC and the demo account (switch) do not exist;
// - access tokens, webhooks: nothing outside the device can reach it (switches fixed off, the profile hides their cards);
// - web recipes, Yazio sign-in, photo recognition and the label reader: switches fixed off; web recipes would need DNS and a pinned
//   address on the bridge (see outgoing.ts), the photo parts the parked vision ops;
// On: the Yazio file import (export ZIP or JSON files, unpacked in memory with DecompressionStream, like on the server; the direct
// sign-in stays off: it needs the Yazio app's client id and secret, which an app bundle must not carry);
// Cookidoo (its client follows redirects by hand and keeps its own cookies, so the plain `http` op is enough; the account is
// stored in the vault, whose key comes from the keychain, see vaultKey.ts; its pictures stay links, as there is no picture service);
// - recipe pictures: no picture service (no sharp): the picture routes answer 501 like a server without one;
// - the catalogue refresh: no refresh service (501, like a server without one); the catalogue files come with the app;
// - demo data (MAHLWERK_DEMO_DATA unset).
import { initAuth } from '../core/auth.ts';
import { installCookidoo } from '../core/cookidooService.ts';
import { bodyOf, decodePath, errorRes, makeRouter } from '../core/dispatch.ts';
import type { FoodLinks } from '../core/foodView.ts';
import { HttpError, type Ctx, type Res, type Route } from '../core/http.ts';
import { ROUTES } from '../core/routes/index.ts';
import { yazioOf } from '../core/routes/yazio.ts';
import { WRITE_METHODS, limitFor } from '../core/security.ts';
import { hostLabel, safeLink } from '../core/webrecipes.ts';
import type { Bridge } from './bridge.ts';
import { bridgeCatalog } from './catalog.ts';
import { openNativeDb } from './nativeDb.ts';
import { bridgeOutgoing } from './outgoing.ts';
import { bridgeKeyFile } from './vaultKey.ts';

/** Fixed: the app's own environment cannot switch these back on. */
export const APP_ENV: Record<string, string> = {
  MAHLWERK_AUTH: 'single', MAHLWERK_TOKENS: 'off', MAHLWERK_WEBHOOKS: 'off', MAHLWERK_COOKIDOO: 'on', MAHLWERK_COOKIDOO_IMAGES: 'off', MAHLWERK_COOKIDOO_PERSONAL: 'on', MAHLWERK_WEB_RECIPES: 'off',
  MAHLWERK_YAZIO_LOGIN: 'off', MAHLWERK_DEMO_ACCOUNT: 'off', MAHLWERK_VISION: 'off', MAHLWERK_CATALOG_REFRESH: 'off', MAHLWERK_DEMO_DATA: '',
};

/** The routes of the app: all of core (the direct Yazio sign-in answers "switched off" like a server without it). */
export const APP_ROUTES: Route[] = ROUTES;

export interface LocalAnswer { status: number; headers: Record<string, string>; body: Uint8Array | null }
export type Dispatch = (method: string, path: string, query: string, headers: Record<string, string>, body?: Uint8Array | null) => Promise<LocalAnswer>;

export interface LocalOptions {
  bridge: Bridge;
  /** core/schema.sql as text (the bundle imports it; core has no file system). */
  schemaSql: string;
  /** More MAHLWERK_* settings (e.g. MAHLWERK_SINGLE_USER, MAHLWERK_CONTACT); APP_ENV wins over them. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export async function openLocal(opts: LocalOptions): Promise<{ ctx: Ctx; dispatch: Dispatch }> {
  const db = await openNativeDb(opts.bridge, opts.schemaSql);
  const foodLinks: FoodLinks = { cookidooUrl: () => null, webLink: safeLink, hostLabel };
  const ctx: Ctx = {
    db, env: { ...(opts.env ?? {}), ...APP_ENV }, now: opts.now ?? (() => Date.now() / 1000),
    services: { out: bridgeOutgoing(opts.bridge, ['off', 'cookidoo']), catalog: bridgeCatalog(opts.bridge), foodLinks, keyFile: bridgeKeyFile(opts.bridge) },
  };
  initAuth(ctx);
  yazioOf(ctx); // the staging area of the Yazio import
  installCookidoo(ctx); // no picture service: the Cookidoo pictures stay links (MAHLWERK_COOKIDOO_IMAGES off)
  const routeRequest = makeRouter(APP_ROUTES);

  async function answer(method: string, rawPath: string, query: string, headers: Record<string, string>, raw: Uint8Array): Promise<Res> {
    const path = decodePath(rawPath);
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    if (WRITE_METHODS.includes(method) && path.startsWith('/api/') && raw.length > limitFor(path)) {
      return { status: 413, body: { detail: `request body too large (at most ${limitFor(path)} bytes)` } };
    }
    const body = WRITE_METHODS.includes(method) && path.startsWith('/api/') ? raw : new Uint8Array(0); // like the server: no other body is read
    try {
      const routed = await routeRequest({
        method, path, params: {}, query: new URLSearchParams(query.replace(/^\?/, '')), headers: lower, body: undefined, raw: body,
        scheme: 'https', peer: 'app', ctx,
      }, bodyOf(body, lower['content-type'] ?? ''));
      if (!('pathMatched' in routed)) return routed;
      return errorRes(new HttpError(routed.pathMatched ? 405 : 404, routed.pathMatched ? 'Method Not Allowed' : 'Not Found'));
    } catch (e) {
      return errorRes(e);
    }
  }

  const dispatch: Dispatch = async (method, path, query, headers, body) => {
    const m = method.toUpperCase();
    return wire(await answer(m, path, query, headers, body ?? new Uint8Array(0)), m === 'HEAD');
  };
  return { ctx, dispatch };
}

/** The answer as bytes, like server/app.ts `write`: JSON for a value, raw bytes or text as they are, nothing for 204. */
function wire(res: Res, head: boolean): LocalAnswer {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
  const status = res.status ?? 200;
  let body: Uint8Array | null;
  if (res.body === undefined || status === 204) body = null;
  else if (res.body instanceof Uint8Array) body = res.body;
  else if (typeof res.body === 'string' && headers['content-type']) body = new TextEncoder().encode(res.body);
  else {
    body = new TextEncoder().encode(JSON.stringify(res.body));
    headers['content-type'] ??= 'application/json';
  }
  return { status, headers, body: head ? null : body };
}

/** A fetch-like function over `dispatch` for the frontend (`window.mahlwerkLocal`): only relative `api/v1/...` addresses. */
export function localFetch(dispatch: Dispatch) {
  return async (url: string, init: { method?: string; headers?: Record<string, string>; body?: Blob | string | Uint8Array | null } = {}): Promise<Response> => {
    const parsed = new URL(url, 'http://app.invalid/');
    if (parsed.origin !== 'http://app.invalid') throw new TypeError('only relative addresses are answered locally');
    const b = init.body;
    const bytes = b == null ? null : typeof b === 'string' ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer());
    const headers = { ...(init.headers ?? {}) };
    if (b instanceof Blob && b.type && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = b.type;
    const a = await dispatch(init.method ?? 'GET', parsed.pathname, parsed.search, headers, bytes);
    return new Response(a.body as BodyInit | null, { status: a.status, headers: a.headers });
  };
}

/** A request of the native side (window.mahlwerkHost.request): the Health sync, the history, summary/today and the water button of the
 * widget. Runs in core like a request of the page (the one person of the app); `query` an object, `body` JSON text, an object or null.
 * Answers `{status, body}` with the body as JSON text (or null for an empty answer). */
export interface HostRequest { method: string; path: string; query?: Record<string, string | number> | null; body?: unknown }
export function hostRequest(dispatch: Dispatch): (r: HostRequest) => Promise<{ status: number; body: string | null }> {
  return async (r) => {
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/api/')) return { status: 400, body: JSON.stringify({ detail: 'path must start with /api/' }) };
    const query = new URLSearchParams(Object.entries(r.query ?? {}).map(([k, v]) => [k, String(v)])).toString();
    const text = r.body === null || r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const a = await dispatch(String(r.method || 'GET'), r.path, query, { 'content-type': 'application/json', 'x-mahlwerk-request': '1' },
      text === null ? null : new TextEncoder().encode(text));
    return { status: a.status, body: a.body && a.body.length ? new TextDecoder().decode(a.body) : null };
  };
}

// The match of a request to a core route, shared by every host (the Node server in server/app.ts, the app in app/localHost.ts):
// the route table, the lazy body, the dependencies of the route (who is calling), the handler, the headers and cookies the auth step
// collected, and an HttpError as `{"detail": ...}`. What only a network server needs (body limit, host check, CSRF header, the
// static files, the security headers) stays with that host.
import { currentUser } from './auth.ts';
import { HttpError, RES, type Req, type Res, type Route } from './http.ts';

interface Compiled { route: Route; re: RegExp; names: string[] }

function compile(routes: Route[]): Compiled[] {
  return routes.map((route) => {
    const names: string[] = [];
    const re = new RegExp('^' + route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)(:path)?\}/g, (_m, n, p) => {
      names.push(n);
      return p ? '(.*)' : '([^/]+)';
    }) + '$', 's');
    return { route, re, names };
  });
}

/** The path as the application sees it: percent escapes decoded once (like an ASGI server), nothing decoded a second time. */
export function decodePath(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** The body as a handler reads it: JSON for a JSON content type (422 when it is none), else the bytes; undefined when empty. */
export const bodyOf = (raw: Uint8Array, type: string) => (): unknown => {
  if (!raw.length) return undefined;
  if (!type.includes('json')) return new Uint8Array(raw);
  try { return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw)); } catch {
    throw new HttpError(422, [{ type: 'json_invalid', loc: ['body', 0], msg: 'JSON decode error' }]);
  }
};

const isRes = (o: unknown): o is Res => typeof o === 'object' && o !== null && (o as any)[RES] === true;

/** Headers and cookies the auth step collected (session renewal, the view header) go onto the answer of a successful request. */
function mergeOut(req: Req, res: Res): Res {
  if (!req.out) return res;
  return { ...res, headers: { ...req.out.headers, ...(res.headers ?? {}) }, cookies: [...(res.cookies ?? []), ...req.out.cookies] };
}

/** The router: the answer of the first route that matches, else `{ pathMatched }` (a route with this path but another method
 * exists: 405, not 404). HttpError and every other error are thrown; `errorRes` turns them into the answer. `beforeHandler` runs once
 * the route and the caller are known, right before the handler: the server reads the body there, so nobody who may not call the route
 * can make it read (and hold) a large body. */
export function makeRouter(routes: Route[]) {
  const table = compile(routes);
  return async function routeRequest(req: Req, body: () => unknown, beforeHandler?: () => Promise<void>): Promise<Res | { pathMatched: boolean }> {
    // the body is parsed when a handler first reads it, i.e. after the dependencies of the route (a 401 beats a 422)
    let parsed: { value: unknown } | undefined;
    Object.defineProperty(req, 'body', { configurable: true, enumerable: true, get() { return (parsed ??= { value: body() }).value; } });

    let pathMatched = false;
    for (const { route, re, names } of table) {
      const m = re.exec(req.path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method && !(route.method === 'GET' && req.method === 'HEAD')) continue;
      req.params = Object.fromEntries(names.map((n, i) => [n, m[i + 1]!]));
      req.route = route.path;
      if (route.auth !== false) req.user = await currentUser(req);
      if (beforeHandler) await beforeHandler();
      const out = await route.handler(req);
      const res: Res = isRes(out) ? out : { status: route.status ?? 200, body: out };
      return mergeOut(req, res);
    }
    return { pathMatched };
  };
}

/** The answer for an error: an HttpError as `{"detail": ...}` with its status and headers, anything else a 500 (logged). */
export function errorRes(e: unknown): Res {
  if (e instanceof HttpError) return { status: e.status, body: { detail: e.detail }, headers: e.headers };
  console.error(e);
  return { status: 500, body: 'Internal Server Error' };
}

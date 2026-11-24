// The HTTP side of the server: the middleware of security.py (body limit, host check, CSRF header, security headers), then the match
// of a request to a core route, auth, the handler, and the answer.
//
// The order is that of the Python app: the body limit is outermost (the body is never read for an oversized request), then the host
// check (421, not for /healthz), then the CSRF header (403 for a write under /api/ unless an access token is used), then routing,
// then the dependencies of the route (who is calling), then validation and the handler. The security headers go on every answer.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, initAuth, normalizeHost } from '../core/auth.ts';
import { bodyOf, decodePath, errorRes, makeRouter } from '../core/dispatch.ts';
import { HttpError, type Ctx, type Req, type Res, type Route } from '../core/http.ts';
import { startLocal } from '../core/routes/auth.ts';
import { ROUTES } from '../core/routes/index.ts';
import { BODY_LIMIT_HEADERS, CSRF_HEADER, CSRF_VALUE, WRITE_METHODS, buildCsp, limitFor, withSecurityHeaders } from '../core/security.ts';
import { VERSION } from '../core/version.ts';
import { openWeb } from './web.ts';

const DEFAULT_WEB_DIR = new URL('../../web/dist', import.meta.url).pathname;

class Refused extends Error {
  status: number;
  limit: number;
  constructor(status: number, limit: number) { super('refused'); this.status = status; this.limit = limit; }
}

export function makeApp(ctx: Ctx, routes: Route[] = ROUTES) {
  const routeRequest = makeRouter(routes);
  const config = initAuth(ctx).config;
  const web = openWeb(ctx.env.MAHLWERK_WEB_DIR || DEFAULT_WEB_DIR);
  const csp = web ? web.csp : buildCsp(null);
  // the interactive API docs list every route and invite probing: off in every mode unless MAHLWERK_DOCS=1. Only a stand-in here: the
  // route list as an OpenAPI skeleton (no schemas) and two plain pages, not the Swagger UI of the Python server.
  const docsOn = ['1', 'true', 'yes'].includes((ctx.env.MAHLWERK_DOCS ?? '').trim().toLowerCase());
  const paths: Record<string, Record<string, object>> = {};
  for (const r of routes) (paths[r.path] ??= {})[r.method.toLowerCase()] = {};
  const openapi = { openapi: '3.1.0', info: { title: 'Mahlwerk', version: VERSION }, paths };
  const ready = startLocal(ctx); // before the first request: the dummy hash and the setup code
  ready.catch(() => undefined);

  async function dispatch(req: Req, body: () => unknown): Promise<Res> {
    // the host check: a page on an attacker's name that resolves to this server must not be able to talk to it (DNS rebinding)
    if (config.allowed_hosts !== null && req.path !== '/healthz' && !config.allowed_hosts.has(normalizeHost(req.headers.host ?? ''))) {
      throw new HttpError(421, 'host not allowed: add the name you use to MAHLWERK_ALLOWED_HOSTS');
    }
    // CSRF: the session lives in a cookie, which a foreign page could make the browser send. A request that needs the custom header
    // cannot be forged that way (a cross-origin fetch needs a CORS pre-flight, and this app sends no CORS headers). The header is
    // required in ALL modes. Access tokens are sent in the Authorization header, which a foreign page cannot add either: exempt.
    if (WRITE_METHODS.includes(req.method) && req.path.startsWith('/api/') && bearerToken(req) === null && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new HttpError(403, 'missing X-Mahlwerk-Request header');
    }
    const routed = await routeRequest(req, body);
    if (!('pathMatched' in routed)) return routed;
    const { pathMatched } = routed;
    if (docsOn && (req.method === 'GET' || req.method === 'HEAD') && ['/docs', '/redoc', '/openapi.json'].includes(req.path)) {
      if (req.path === '/openapi.json') return { status: 200, body: openapi };
      const list = Object.entries(paths).map(([p, m]) => `<li><code>${Object.keys(m).join(', ').toUpperCase()} ${p.replace(/</g, '&lt;')}</code></li>`).join('');
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><title>Mahlwerk API</title><h1>Mahlwerk API</h1><ul>${list}</ul>` };
    }
    if (web !== null && (req.method === 'GET' || req.method === 'HEAD')) {
      const path = req.path.replace(/^\/+/, '');
      if (path === 'api' || path.startsWith('api/')) throw new HttpError(404, 'Not Found');
      const file = web.serve(path);
      if (file) return file;
      throw new HttpError(404, 'Not Found');
    }
    throw new HttpError(pathMatched || web !== null ? 405 : 404, pathMatched || web !== null ? 'Method Not Allowed' : 'Not Found');
  }

  return async function handle(nreq: IncomingMessage, nres: ServerResponse, peer?: string, scheme?: string): Promise<void> {
    let res: Res;
    let path = '/';
    let plain = false; // an answer of the body limit: it carries only its own headers
    try {
      await ready;
      // the request target as sent, like uvicorn: no WHATWG parsing (it reads `//x/api/…` as host x and path /api/…, and folds
      // dot segments), only the percent escapes of the path decoded once
      const target = nreq.url ?? '/';
      if (!target.startsWith('/')) throw new HttpError(400, 'Bad Request');
      const q = target.indexOf('?');
      path = decodePath(q < 0 ? target : target.slice(0, q));
      const query = new URLSearchParams(q < 0 ? '' : target.slice(q + 1));
      const method = nreq.method ?? 'GET';
      const checked = WRITE_METHODS.includes(method) && path.startsWith('/api/');
      // only a write under /api/ has a body that is read (and limited); the Python app never reads any other one
      const raw = checked ? await readBody(nreq, limitFor(path), nreq.headers['content-length']) : discard(nreq);
      const type = String(nreq.headers['content-type'] ?? '');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const body = bodyOf(raw, type);
      res = await dispatch({ method, path, params: {}, query, headers, body: undefined, raw, scheme: scheme ?? 'http',
        peer: peer ?? nreq.socket.remoteAddress ?? 'unknown', ctx }, body);
    } catch (e) {
      if (e instanceof Refused) {
        plain = true;
        res = { status: e.status, headers: BODY_LIMIT_HEADERS, body: e.status === 413 ? { detail: `request body too large (at most ${e.limit} bytes)` } : { detail: 'bad Content-Length' } };
      } else res = errorRes(e);
    }
    if (!plain) res = { ...res, headers: withSecurityHeaders(res.headers, path, await csp) };
    try {
      write(nres, res, nreq.method === 'HEAD');
    } catch (e) { // e.g. a header value Node refuses: a 500 instead of an unhandled rejection that ends the process
      console.error(e);
      if (!nres.headersSent) write(nres, { status: 500, body: 'Internal Server Error', headers: { 'content-type': 'text/plain' } }, false);
      else nres.destroy();
    }
    if (plain) nres.on('finish', () => nreq.destroy()); // the refusal is on its way; whatever the client still sends is not read
  };
}

/** A body nobody asked for: thrown away unread. */
function discard(req: IncomingMessage): Buffer {
  req.resume();
  return Buffer.alloc(0);
}

/** Reads the body; for a write under /api/ it checks Content-Length up front and counts the bytes of a streamed body as they arrive
 * (413 as soon as the limit is passed, 400 for a Content-Length that is no number). */
function readBody(req: IncomingMessage, limit: number, declared: string | undefined): Promise<Buffer> {
  if (declared !== undefined) {
    if (!/^\s*[+-]?\d+\s*$/.test(declared)) throw new Refused(400, limit);
    if (Number(declared) > limit) throw new Refused(413, limit);
  }
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let seen = 0;
    req.on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > limit) { req.removeAllListeners('data'); reject(new Refused(413, limit)); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function write(nres: ServerResponse, res: Res, head: boolean): void {
  const headers: Record<string, string | string[]> = { ...(res.headers ?? {}) };
  if (res.cookies?.length) headers['set-cookie'] = res.cookies;
  let payload: string | Uint8Array | undefined;
  if (res.body === undefined || res.status === 204) payload = undefined;
  else if (res.body instanceof Uint8Array) payload = res.body;
  else if (typeof res.body === 'string' && headers['content-type']) payload = res.body;
  else {
    payload = JSON.stringify(res.body);
    headers['content-type'] ??= 'application/json';
  }
  nres.writeHead(res.status ?? 200, headers);
  nres.end(head ? undefined : payload);
}

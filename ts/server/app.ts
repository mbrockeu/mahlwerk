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

const EMPTY = Buffer.alloc(0);
const SMALL_BODY = 64 * 1024; // an unread body up to this size (by Content-Length) is drained; a larger one or one of unknown size is cut off
// An upload: a body that may be larger than the default limit (photos, Health sync, Yazio files, an own export to import: up to 32 MB).
// At most MAX_UPLOADS are read at the same time on the server; one more gets a 429.
const UPLOAD = 1024 * 1024;
const MAX_UPLOADS = 2;

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

  async function dispatch(req: Req, body: () => unknown, beforeHandler?: () => Promise<void>): Promise<Res> {
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
    const routed = await routeRequest(req, body, beforeHandler);
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

  let uploads = 0; // large bodies being read now (see MAX_UPLOADS)

  return async function handle(nreq: IncomingMessage, nres: ServerResponse, peer?: string, scheme?: string): Promise<void> {
    let res: Res;
    let path = '/';
    let plain = false; // an answer of the body limit: it carries only its own headers
    let checked = false; // a write under /api/: its body is read only for a request that reaches its handler
    let declared: number | null = null; // the Content-Length, if sent
    let bodyRead = false;
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
      checked = WRITE_METHODS.includes(method) && path.startsWith('/api/');
      // only a write under /api/ has a body that is read (and limited); the Python app never reads any other one
      const limit = limitFor(path);
      if (checked) declared = checkDeclared(nreq.headers['content-length'], limit); // 400/413 from the header alone, before anything else
      else discard(nreq);
      const type = String(nreq.headers['content-type'] ?? '');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const req: Req = { method, path, params: {}, query, headers, body: undefined, raw: EMPTY, scheme: scheme ?? 'http',
        peer: peer ?? nreq.socket.remoteAddress ?? 'unknown', ctx };
      // the body is read only once the route and the caller are known (right before the handler): a request that is refused (host,
      // CSRF header, 401/403, no such route) never makes the server hold its body. A large one also needs one of MAX_UPLOADS slots.
      const load = async () => {
        const large = limit > UPLOAD && !(declared !== null && declared <= UPLOAD);
        if (large && uploads >= MAX_UPLOADS) throw new HttpError(429, 'too many uploads at the same time, try again in a moment', { 'Retry-After': '5' });
        if (large) uploads++;
        try { req.raw = await readBody(nreq, limit); } finally { if (large) uploads--; }
        bodyRead = true;
      };
      res = await dispatch(req, () => bodyOf(req.raw ?? EMPTY, type)(), checked ? load : undefined);
    } catch (e) {
      if (e instanceof Refused) {
        plain = true;
        res = { status: e.status, headers: BODY_LIMIT_HEADERS, body: e.status === 413 ? { detail: `request body too large (at most ${e.limit} bytes)` } : { detail: 'bad Content-Length' } };
      } else res = errorRes(e);
    }
    if (!plain) res = { ...res, headers: withSecurityHeaders(res.headers, path, await csp) };
    // a body that was not read and may be large is not waited for: the connection ends with the answer (a small one is drained)
    const unread = checked && !bodyRead && !plain && !(declared !== null && declared <= SMALL_BODY);
    if (unread) res = { ...res, headers: { ...res.headers, connection: 'close' } };
    try {
      write(nres, res, nreq.method === 'HEAD');
    } catch (e) { // e.g. a header value Node refuses: a 500 instead of an unhandled rejection that ends the process
      console.error(e);
      if (!nres.headersSent) write(nres, { status: 500, body: 'Internal Server Error', headers: { 'content-type': 'text/plain' } }, false);
      else nres.destroy();
    }
    if (plain || unread) nres.on('finish', () => nreq.destroy()); // the refusal is on its way; whatever the client still sends is not read
  };
}

/** A body nobody asked for: thrown away unread. */
function discard(req: IncomingMessage): Buffer {
  req.resume();
  return Buffer.alloc(0);
}

/** The Content-Length of a write under /api/, checked before anything else: 400 for one that is no number, 413 above the limit. */
function checkDeclared(declared: string | undefined, limit: number): number | null {
  if (declared === undefined) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(declared)) throw new Refused(400, limit);
  if (Number(declared) > limit) throw new Refused(413, limit);
  return Number(declared);
}

/** Reads the body, counting the bytes of a streamed body as they arrive (413 as soon as the limit is passed). Settles when the client
 * goes away in the middle, so an aborted upload never keeps its slot. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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
    req.on('close', () => { if (!req.complete) reject(new HttpError(400, 'the request body was cut off')); });
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

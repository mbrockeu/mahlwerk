// The HTTP side of the server: matches a request to a core route, runs auth and the handler, writes the answer.
// Security headers, host check, CSRF header and body limits come with package 2c (security.py); here only the CSRF
// header, because nearly every API test relies on it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { identify } from '../core/auth.ts';
import { HttpError, RES, type Ctx, type Req, type Res, type Route } from '../core/http.ts';
import { ROUTES } from '../core/routes/index.ts';

interface Compiled { route: Route; re: RegExp; names: string[] }

function compile(routes: Route[]): Compiled[] {
  return routes.map((route) => {
    const names: string[] = [];
    const re = new RegExp('^' + route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)(:path)?\}/g, (_m, n, p) => {
      names.push(n);
      return p ? '(.+)' : '([^/]+)';
    }) + '$');
    return { route, re, names };
  });
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function makeApp(ctx: Ctx, routes: Route[] = ROUTES) {
  const table = compile(routes);

  async function dispatch(req: Req): Promise<Res> {
    let pathMatched = false;
    for (const { route, re, names } of table) {
      const m = re.exec(req.path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method && !(route.method === 'GET' && req.method === 'HEAD')) continue;
      req.params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      if (req.path.startsWith('/api/') && WRITE.has(req.method) && req.headers['x-mahlwerk-request'] !== '1') {
        throw new HttpError(403, 'missing X-Mahlwerk-Request header');
      }
      if (route.auth !== false) req.user = await identify(req);
      const out = await route.handler(req);
      if (isRes(out)) return out;
      return { status: route.status ?? 200, body: out };
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method Not Allowed' : 'Not Found');
  }

  return async function handle(nreq: IncomingMessage, nres: ServerResponse, peer?: string): Promise<void> {
    let res: Res;
    try {
      const url = new URL(nreq.url ?? '/', 'http://x');
      const raw = await readBody(nreq);
      const type = String(nreq.headers['content-type'] ?? '');
      let body: unknown;
      if (raw.length) {
        if (type.includes('json')) {
          try { body = JSON.parse(raw.toString('utf8')); } catch {
            throw new HttpError(422, [{ type: 'json_invalid', loc: ['body', 0], msg: 'JSON decode error' }]);
          }
        } else body = new Uint8Array(raw);
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      res = await dispatch({ method: nreq.method ?? 'GET', path: url.pathname, params: {}, query: url.searchParams, headers, body,
        peer: peer ?? nreq.socket.remoteAddress ?? 'unknown', ctx });
    } catch (e) {
      if (e instanceof HttpError) res = { status: e.status, body: { detail: e.detail }, headers: e.headers };
      else {
        console.error(e);
        res = { status: 500, body: 'Internal Server Error' };
      }
    }
    write(nres, res, nreq.method === 'HEAD');
  };
}

const isRes = (o: unknown): o is Res => typeof o === 'object' && o !== null && (o as any)[RES] === true;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
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

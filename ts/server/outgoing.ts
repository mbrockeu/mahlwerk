// The Node implementation of `Outgoing` (core/outgoing.ts): node:http(s), no redirects, no proxy from the environment, optional connection
// to a pre-checked address (DNS rebinding protection), a size limit while the body arrives, httpx-like time limits (`connectTimeout` for
// the connection, `timeout` for every wait afterwards and for the whole call).
import { lookup, Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { OutError, type Outgoing, type OutRequest, type OutResponse } from '../core/outgoing.ts';

const TIMEOUT = 30;
const RESOLVE_DEADLINE_MS = 3000; // a caller stops waiting for a name after this long
const RESOLVE_PARALLEL = 2; // name resolutions in flight at once, server-wide (hung ones count until they end)

export interface ResolveDeps {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  /** getaddrinfo (threadpool, uncancellable): the fallback after DNS answered "no such name" (/etc/hosts, single labels). */
  lookup(host: string): Promise<string[]>;
  /** Abandon the DNS queries in flight (Resolver.cancel); called when the deadline passes, so the slot is freed for real. */
  cancel?(): void;
}

const NO_SUCH_NAME = /ENOTFOUND|ENODATA/;
const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? (e instanceof Error ? e.message : e));

/** A resolver with a deadline and a limit on lookups in flight. Names are asked of the DNS servers directly (c-ares, off the libuv
 * threadpool, own timeout); after a definitive "no such name" the system lookup (getaddrinfo) is asked too, never after a timeout or
 * another error. A caller never waits longer than `deadlineMs`, and a resolution holds its place for `deadlineMs` at most: then the DNS
 * queries are cancelled and the place is free. Errors: `connect` = definitive "no such name", `timeout`/`other` = could not tell. `deps` may
 * be a factory, so that every resolution has its own Resolver to cancel. */
export function makeResolve(deps: ResolveDeps | (() => ResolveDeps), deadlineMs = RESOLVE_DEADLINE_MS, parallel = RESOLVE_PARALLEL): (host: string) => Promise<string[]> {
  let running = 0;
  const queue: (() => void)[] = [];
  const release = () => { running--; queue.shift()?.(); };
  const acquire = (): Promise<void> => new Promise((ok) => {
    const go = () => { running++; ok(); };
    if (running < parallel) go(); else queue.push(go);
  });
  const work = async (host: string, d: ResolveDeps): Promise<string[]> => {
    const [a, b] = await Promise.allSettled([d.resolve4(host), d.resolve6(host)]);
    const found = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])];
    if (found.length) return [...new Set(found)];
    const errors = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => codeOf(r.reason));
    const bad = errors.find((c) => !NO_SUCH_NAME.test(c));
    if (bad !== undefined) throw new OutError(/TIMEOUT|CANCELLED/.test(bad) ? 'timeout' : 'other', `resolving ${host} failed`); // not a definitive answer: no fallback
    let looked: string[];
    try { looked = [...new Set(await d.lookup(host))]; } catch (e) {
      throw new OutError(/ENOTFOUND|ENODATA/.test(codeOf(e)) ? 'connect' : 'other', `cannot resolve ${host}`);
    }
    if (!looked.length) throw new OutError('connect', `cannot resolve ${host}`);
    return looked;
  };
  return (host) => new Promise<string[]>((ok, fail) => {
    if (isIP(host)) return ok([host]);
    const d = typeof deps === 'function' ? deps() : deps;
    let over = false;
    let held = false;
    const free = () => { if (held) { held = false; release(); } };
    const timer = setTimeout(() => {
      over = true;
      fail(new OutError('timeout', `resolving ${host} took too long`));
      try { d.cancel?.(); } catch { /* best effort */ }
      free(); // the place goes back at the deadline, however slow the name is
    }, deadlineMs);
    acquire().then(async () => {
      held = true;
      if (over) return free(); // gave up while waiting for a place: do not start
      try {
        const r = await work(host, d);
        if (!over) ok(r);
      } catch (e) {
        if (!over) fail(e);
      } finally {
        clearTimeout(timer);
        free();
      }
    }).catch(() => free());
  });
}

const newDeps = (): ResolveDeps => {
  const r = new Resolver({ timeout: RESOLVE_DEADLINE_MS, tries: 1 });
  return {
    resolve4: (h) => r.resolve4(h),
    resolve6: (h) => r.resolve6(h),
    lookup: async (h) => (await lookup(h, { all: true })).map((a) => a.address),
    cancel: () => r.cancel(),
  };
};
const systemResolve = makeResolve(newDeps);
// The server's own names have their own places: names an attacker picks cannot starve the own-address check (which fails closed).
const ownResolve = makeResolve(newDeps, RESOLVE_DEADLINE_MS, RESOLVE_PARALLEL);

export function nodeOutgoing(): Outgoing {
  return {
    fetch: (_purpose, req) => send(req),
    resolve: (host, _port) => systemResolve(host),
    resolveOwn: (host, _port) => ownResolve(host),
  };
}

function send(r: OutRequest): Promise<OutResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(r.url); } catch { return reject(new OutError('other', 'invalid URL')); }
    const tls = url.protocol === 'https:';
    if (!tls && url.protocol !== 'http:') return reject(new OutError('other', 'unsupported scheme'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const readMs = (r.timeout ?? TIMEOUT) * 1000;
    const connectMs = (r.connectTimeout ?? r.timeout ?? TIMEOUT) * 1000;
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) headers.host = url.host; // the name of the URL, whatever address is connected
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['content-length'] = String(body.length);
    let done = false;
    let req: http.ClientRequest;
    const finish = (v: OutResponse | OutError) => {
      if (done) return;
      done = true;
      clearTimeout(total);
      if (v instanceof OutError) { req?.destroy(); reject(v); } else resolve(v);
    };
    const total = setTimeout(() => finish(new OutError('timeout')), readMs);
    req = (tls ? https : http).request({
      method: r.method ?? 'GET',
      // The pinned address is connected to directly: the name of the URL stays in the Host header and, for TLS, in SNI and the certificate check.
      host: r.address ?? host,
      port: url.port || (tls ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      agent: false,
      ...(tls ? { servername: isIP(host) ? undefined : host } : {}),
    }, (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.setTimeout(readMs, () => finish(new OutError('timeout')));
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (r.maxBytes !== undefined && size > r.maxBytes) return finish(new OutError('too_large'));
        parts.push(c);
      });
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v;
        finish({ status: res.statusCode ?? 0, headers: h, setCookies: res.headers['set-cookie'], body: new Uint8Array(Buffer.concat(parts)) });
      });
      res.on('error', (e) => finish(toError(e)));
    });
    req.on('socket', (s) => {
      s.setTimeout(connectMs, () => finish(new OutError('timeout'))); // while connecting; after that the wait for the answer is limited by `timeout`
      s.once(tls ? 'secureConnect' : 'connect', () => s.setTimeout(readMs, () => finish(new OutError('timeout'))));
    });
    req.on('error', (e) => finish(toError(e)));
    req.end(body);
  });
}

const toError = (e: NodeJS.ErrnoException): OutError =>
  e instanceof OutError ? e : new OutError(/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET)/.test(e.code ?? '') ? 'connect' : e.code === 'ETIMEDOUT' ? 'timeout' : 'other', e.message);

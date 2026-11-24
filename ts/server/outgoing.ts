// The Node implementation of `Outgoing` (core/outgoing.ts): node:http(s), no redirects, no proxy from the environment,
// optional connection to a pre-checked address (DNS rebinding protection), a size limit while the body arrives.
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { OutError, type Outgoing, type OutRequest, type OutResponse } from '../core/outgoing.ts';

const TIMEOUT = 30;

export function nodeOutgoing(): Outgoing {
  return {
    fetch: (_purpose, req) => send(req),
    async resolve(host, _port) {
      const all = await lookup(host, { all: true });
      return [...new Set(all.map((a) => a.address))];
    },
  };
}

function send(r: OutRequest): Promise<OutResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(r.url);
    const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!mod) return reject(new OutError('other', 'unsupported scheme'));
    const total = (r.timeout ?? TIMEOUT) * 1000;
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['content-length'] = String(body.length);
    const address = r.address;
    const req = mod.request({
      method: r.method ?? 'GET',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers,
      agent: false,
      servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      lookup: address ? ((_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, address, isIP(address) || 4)) as any : undefined,
      timeout: (r.connectTimeout ?? r.timeout ?? TIMEOUT) * 1000,
    }, (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (r.maxBytes !== undefined && size > r.maxBytes) {
          req.destroy();
          fail(new OutError('too_large'));
          return;
        }
        parts.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ status: res.statusCode ?? 0, headers: h, body: new Uint8Array(Buffer.concat(parts)) });
      });
      res.on('error', (e) => fail(toError(e)));
    });
    const timer = setTimeout(() => { req.destroy(); fail(new OutError('timeout')); }, total);
    let done = false;
    const fail = (e: OutError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    };
    req.on('timeout', () => { req.destroy(); fail(new OutError('timeout')); });
    req.on('error', (e) => fail(toError(e)));
    req.end(body);
  });
}

const toError = (e: NodeJS.ErrnoException): OutError =>
  e instanceof OutError ? e : new OutError(/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET)/.test(e.code ?? '') ? 'connect' : e.code === 'ETIMEDOUT' ? 'timeout' : 'other', e.message);

// The Node implementation of `Outgoing` (core/outgoing.ts): node:http(s), no redirects, no proxy from the environment, optional connection
// to a pre-checked address (DNS rebinding protection), a size limit while the body arrives, httpx-like time limits (`connectTimeout` for
// the connection, `timeout` for every wait afterwards and for the whole call).
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

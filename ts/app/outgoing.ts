// Outgoing HTTP of the app over the bridge (`http` op), the app's version of server/outgoing.ts: no redirects, no proxy, a size
// limit and a time limit. Two things the bridge cannot do are refused instead of weakened:
// - DNS: there is no resolve op, so `resolve` always fails and netguard (pickAddress) refuses every target it is asked about;
// - a pinned address (`OutRequest.address`, the DNS rebinding protection): such a request is refused, never sent by name.
// Only the purposes the app has switched on may leave the device (the Open Food Facts lookup); every other one is refused.
import { OutError, type Outgoing, type Purpose } from '../core/outgoing.ts';
import { errorText, fromB64, toB64, type Bridge } from './bridge.ts';

const TIMEOUT = 30; // seconds, like the server
/** Without a limit of the caller: the most an answer may have (it travels as base64 through the bridge). */
const MAX_BYTES = 16 * 1024 * 1024;
const KINDS = ['connect', 'timeout', 'too_large'] as const;

export function bridgeOutgoing(bridge: Bridge, purposes: Purpose[] = ['off']): Outgoing {
  return {
    async fetch(purpose, r) {
      if (!purposes.includes(purpose)) throw new OutError('connect', `no outgoing ${purpose} requests in the app`);
      if (r.address) throw new OutError('connect', 'the app cannot connect to a checked address');
      let url: URL;
      try { url = new URL(r.url); } catch { throw new OutError('other', 'invalid URL'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutError('other', 'unsupported scheme');
      const body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body;
      const maxBytes = Math.min(r.maxBytes ?? MAX_BYTES, MAX_BYTES);
      let a: any;
      try {
        a = await bridge({
          op: 'http', method: r.method ?? 'GET', url: r.url, headers: r.headers ?? {}, bodyB64: body ? toB64(body) : null,
          timeoutMs: (r.timeout ?? TIMEOUT) * 1000, connectTimeoutMs: (r.connectTimeout ?? r.timeout ?? TIMEOUT) * 1000, maxBytes,
        });
      } catch (e) {
        const text = errorText(e);
        throw new OutError(KINDS.find((k) => text.startsWith(k)) ?? 'other', text);
      }
      const bytes = a?.bodyB64 ? fromB64(a.bodyB64) : new Uint8Array(0);
      if (bytes.length > maxBytes) throw new OutError('too_large'); // checked here too: the limit must not depend on the native side
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((a?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
      return { status: Number(a?.status ?? 0), headers, body: bytes };
    },
    async resolve() {
      throw new OutError('connect', 'no DNS lookups in the app');
    },
  };
}

// Outgoing HTTP as core sees it: one fetch-like interface in `ctx.services.out`. The server supplies the Node
// implementation (server/outgoing.ts); the test host a stand-in that hands the request to the Python mock transports.
// Redirects are never followed (every caller handles them itself), environment proxies are never used.
import type { Ctx } from './http.ts';

/** What a request is for; the tests answer each purpose with its own mock. */
export type Purpose = 'off' | 'oidc' | 'yazio' | 'web' | 'vision' | 'webhook';

export interface OutRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Total time and time to connect, in seconds (httpx.Timeout). */
  timeout?: number;
  connectTimeout?: number;
  /** Connect to exactly this (already checked) address; Host, SNI and the certificate check keep the URL's name. */
  address?: string;
  /** The body is cut off with `OutError('too_large')` as soon as it is longer than this. */
  maxBytes?: number;
}

export interface OutResponse {
  status: number;
  /** lower-case names; a repeated header is joined with ", " */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** `connect` (cannot connect or resolve), `timeout`, `too_large`, `other` (any other transport error). */
export class OutError extends Error {
  kind: 'connect' | 'timeout' | 'too_large' | 'other';
  constructor(kind: OutError['kind'], message: string = kind) {
    super(message);
    this.kind = kind;
  }
}

export interface Outgoing {
  fetch(purpose: Purpose, req: OutRequest): Promise<OutResponse>;
  /** All addresses of a host as the system resolves them (netguard.system_resolver); rejects when it does not resolve. */
  resolve(host: string, port: number): Promise<string[]>;
}

export function outgoing(ctx: Ctx): Outgoing {
  const out = ctx.services.out as Outgoing | undefined;
  if (!out) throw new OutError('connect', 'no outgoing HTTP configured');
  return out;
}

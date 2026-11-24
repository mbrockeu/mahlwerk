// The handler contract: a route is a method, a path pattern and an async function of a request context. Nothing here
// knows about node:http; the server (or later the app) builds the `Req` and turns the result into a response.
import { z } from 'zod';
import type { Db } from './db.ts';
import { pyInt } from './models/common.ts';

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  via_token: boolean;
  household: boolean;
  /** The caller is an admin who has switched to the demo account (auth.ts `currentUser`): this user is the demo account. */
  is_demo?: boolean;
  session_hash?: string | null;
  provider_name?: string | null;
  name_custom?: boolean;
  demo_real?: { username: string; display_name: string };
  [k: string]: unknown;
}

/** Everything a handler may use. `env` replaces os.environ, `now()` the clock (seconds, like time.time()). */
export interface Ctx {
  db: Db;
  env: Record<string, string | undefined>;
  now: () => number;
  /** Services of the host (catalog, outgoing HTTP, images …); typed where they are defined. */
  services: Record<string, unknown>;
}

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string>; // lower-case names
  body: unknown; // parsed JSON, or a Uint8Array for binary uploads, or undefined
  peer: string;
  /** `http` or `https`: how the request reached the server (the test host passes what the test client used). */
  scheme?: string;
  /** The matched route template (FastAPI's `route.path`), set before auth runs. */
  route?: string;
  /** Headers and cookies the auth step adds to the answer of a successful request (FastAPI's injected `response`). */
  out?: { headers: Record<string, string>; cookies: string[] };
  /** Set by the auth step before the handler runs (routes with `auth: false` have none). */
  user?: User;
  ctx: Ctx;
}

export interface Res {
  status?: number;
  headers?: Record<string, string>;
  /** JSON-serialisable value, a Uint8Array/string for raw bodies, or undefined for no body. */
  body?: unknown;
  cookies?: string[]; // full Set-Cookie values
}

/** HTTPException of FastAPI: `{"detail": ...}` with the status. */
export class HttpError extends Error {
  status: number;
  detail: unknown;
  headers?: Record<string, string>;
  constructor(status: number, detail: unknown, headers?: Record<string, string>) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** Marks a full answer (status, headers, cookies) as opposed to a plain JSON value. */
export const RES = Symbol('res');
/** The side channel for headers and cookies of the auth step; merged into the answer when the handler succeeds. */
export const outOf = (req: Req): { headers: Record<string, string>; cookies: string[] } => (req.out ??= { headers: {}, cookies: [] });

export const respond = (res: Res): Res => Object.assign(res, { [RES]: true });

export type Handler = (req: Req) => Promise<Res | unknown>;

export interface Route {
  method: string;
  path: string; // FastAPI style: /api/v1/foods/{food_id}
  handler: Handler;
  auth?: boolean; // default true: needs a user
  status?: number; // default status of a successful answer (FastAPI status_code=)
}

export const route = (method: string, path: string, handler: Handler, opts: Partial<Route> = {}): Route =>
  ({ method, path, handler, ...opts });

/** A FastAPI-like 422 from a zod error: `{"detail": [{"type", "loc", "msg"}]}`. Never echoes the input. */
export function invalid(error: z.ZodError, where: 'body' | 'query' | 'path'): HttpError {
  const detail = error.issues.map((i) => ({ type: i.code, loc: [where, ...i.path.map((p) => (typeof p === 'number' ? p : String(p)))], msg: i.message }));
  return new HttpError(422, detail);
}

/** Parse `value` with `schema` or throw the 422. */
export function parse<T extends z.ZodType>(schema: T, value: unknown, where: 'body' | 'query' | 'path' = 'body'): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(r.error, where);
  return r.data;
}

/** Query parameters as a plain object (the last value of a repeated name wins, like FastAPI for scalar parameters). */
export const queryObject = (q: URLSearchParams): Record<string, string> => Object.fromEntries(q.entries());

/** An `int` path parameter like FastAPI: a 422 with loc `["path", name]` when it is none. */
export const pathInt = (req: Req, name: string): number => parse(z.object({ [name]: pyInt() }), { [name]: req.params[name] }, 'path')[name] as number;

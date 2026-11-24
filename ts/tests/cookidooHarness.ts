// A test app for the Cookidoo tests: a real app (routes, auth in proxy mode, vault, SQLite in a temp folder) on a local port, with the
// stand-in client behind `ctx.services.cookidooFactory`. Nothing leaves the machine: the outgoing HTTP is one that refuses everything.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSchema } from '../core/db.ts';
import { readFileSync } from 'node:fs';
import type { Ctx } from '../core/http.ts';
import { OutError, type Outgoing } from '../core/outgoing.ts';
import { CookidooError, type Collection, type CookidooClient, type NutritionEntry, type PlanDay, type RecipeDetails, type Settings } from '../core/cookidoo.ts';
import { cookidooHub, cookidooRuns } from '../core/cookidooService.ts';
import { makeApp } from '../server/app.ts';
import { authServices } from '../server/authServices.ts';
import { addServices } from '../server/services.ts';
import { openSqlite } from '../server/sqlite.ts';

export const refusing: Outgoing = {
  async fetch() { throw new OutError('connect', 'no network in tests'); },
  async resolve() { throw new OutError('connect', 'no network in tests'); },
};

export const entry = (values: Record<string, [number, string]>, quantity = 1): NutritionEntry[] => [{ quantity, unit: 'Portion', values: new Map(Object.entries(values)) }];

export const LENTILS: RecipeDetails = {
  id: 'r100001', name: 'Red lentil salad', portions: 4.0,
  nutrition: entry({ sodium: [1168, 'mg'], protein: [37, 'g'], kJ: [2081, 'kJ'], fat: [8, 'g'], kcal: [497, 'kcal'], dietaryFibre: [12.2, 'g'], saturatedFat: [5, 'g'], carb2: [73, 'g'] }),
};

/** Stands in for the real client: answers from dictionaries, counts calls, can fail, remembers whose it is. */
export class FakeClient implements CookidooClient {
  calls: string[] = [];
  fail: string | null = null;
  recipes: Record<string, RecipeDetails> = { r100001: LENTILS };
  closed = false;
  settings: Settings;
  constructor(settings: Settings) { this.settings = settings; }
  private go(name: string): void {
    this.calls.push(name);
    if (this.fail === 'boom') throw new Error(`boom with ${this.settings.password}`); // an unexpected failure that mentions the secret
    if (this.fail) throw new CookidooError(this.fail);
  }
  async week(): Promise<PlanDay[]> {
    this.go('week');
    return [{ day: '2026-01-12', title: this.settings.email, recipes: [{ id: 'r100001', name: `from ${this.settings.email}` }] }, { day: '2026-01-13', title: 'Tuesday', recipes: [] }];
  }
  async collections(): Promise<Collection[]> {
    this.go('collections');
    return [{ id: 'c1', name: 'Favourites', managed: false, recipes: [{ id: 'r100001', name: 'Red lentil salad' }] }, { id: 'c2', name: 'Quick dinners', managed: true, recipes: [] }];
  }
  async recipe(id: string): Promise<RecipeDetails> {
    this.go('recipe');
    const r = this.recipes[id];
    if (!r) throw new CookidooError('unexpected');
    return r;
  }
  async ping(): Promise<void> { this.go('ping'); }
  async close(): Promise<void> { this.closed = true; }
}

export interface Reply { status: number; json: any; text: string; headers: Headers }
export interface Who { get(path: string): Promise<Reply>; post(path: string, body?: unknown): Promise<Reply>; put(path: string, body?: unknown): Promise<Reply>; patch(path: string, body?: unknown): Promise<Reply>; delete(path: string): Promise<Reply>; name: string }

export interface World {
  ctx: Ctx;
  env: Record<string, string | undefined>;
  clock: { now: number };
  built: FakeClient[];
  logs: string[];
  port: number;
  admin: Who; ann: Who; ben: Who;
  who(name: string, groups?: string): Who;
  hub: ReturnType<typeof cookidooHub>;
  runs: ReturnType<typeof cookidooRuns>;
  close(): Promise<void>;
}

/** An app with the connector switched on (unless `on: false`), proxy sign-in, the stand-in client; `root` is the admin. */
export async function makeWorld(opts: { env?: Record<string, string>; on?: boolean } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'cookidoo-test-'));
  const dbPath = join(dir, 'w.db');
  const db = openSqlite(dbPath);
  await openSchema(db, readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8'));
  const env: Record<string, string | undefined> = { MAHLWERK_AUTH: 'proxy', MAHLWERK_TRUSTED_PROXIES: '10.0.0.5', MAHLWERK_ALLOWED_HOSTS: '*',
    MAHLWERK_WEB_DIR: join(dir, 'no-web'), ...opts.env };
  const clock = { now: 1_000_000.0 };
  const built: FakeClient[] = [];
  const ctx: Ctx = { db, env, now: () => clock.now, services: { ...authServices(dbPath), cookidooFactory: (s: Settings) => { const c = new FakeClient(s); built.push(c); return c; } } };
  addServices(ctx, dbPath, refusing);
  if (opts.on !== false) await db.run("INSERT OR REPLACE INTO setting (key, value) VALUES ('cookidoo.enabled', 'true')");
  const logs: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) (console as any)[level] = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  const handle = makeApp(ctx);
  const server: Server = createServer((q, r) => void handle(q, r, '10.0.0.5'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const who = (name: string, groups?: string): Who => {
    const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'remote-user': name, ...(groups ? { 'remote-groups': groups } : {}), 'x-mahlwerk-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, headers: res.headers };
    };
    return { name, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), delete: (p) => call('DELETE', p) };
  };
  return {
    ctx, env, clock, built, logs, port, who, admin: who('root', 'admin'), ann: who('ann'), ben: who('ben'),
    hub: cookidooHub(ctx), runs: cookidooRuns(ctx),
    async close() { await cookidooRuns(ctx).shutdown(); server.close(); db.close?.(); rmSync(dir, { recursive: true, force: true }); },
  };
}

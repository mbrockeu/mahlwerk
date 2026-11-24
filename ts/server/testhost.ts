// FOR TESTS ONLY, never run in production: one process that holds many apps, each with its own database, environment
// and clock, so that the Python API tests can run against the TS server (tests/ts_bridge.py). It trusts the headers
// x-test-app (which app) and x-test-peer (the TCP address the app sees) – exactly what a real server must never do.
// Listens on 127.0.0.1 only; prints the port on stdout.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openSchema } from '../core/db.ts';
import { testToday } from '../core/dates.ts';
import { makeApp } from './app.ts';
import { OutError, type Outgoing } from '../core/outgoing.ts';
import type { Ctx } from '../core/http.ts';
import { addServices } from './services.ts';
import { openSqlite } from './sqlite.ts';

console.info = console.debug = console.warn; // the port line is the only thing on stdout; the rest goes to stderr
const schema = readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8');
const apps = new Map<string, { handle: ReturnType<typeof makeApp>; clock: { now: number | null }; db: { close?(): void }; env: Record<string, string | undefined> }>();
const KEEP = 40; // a test uses at most a few apps; older ones are closed (file handles)
let next = 1;

/** Outgoing HTTP of a test app: nothing leaves the machine. Every request (and every DNS question) goes to the Python side
 * (tests/ts_bridge.py), which answers it with the mock transport the test gave `create_app` for that purpose and with the fake
 * resolver of conftest. The original URL travels in the JSON body; this exists only here, a production server has no such path. */
function bridgeOutgoing(bridge: string, appId: string): Outgoing {
  const call = async (path: string, payload: unknown) => {
    const r = await fetch(`${bridge}/${path}/${appId}`, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    return (await r.json()) as any;
  };
  return {
    async fetch(purpose, req) {
      const body = typeof req.body === 'string' ? Buffer.from(req.body) : req.body;
      const a = await call(`out/${purpose}`, {
        method: req.method ?? 'GET', url: req.url, headers: req.headers ?? {}, body: body ? Buffer.from(body).toString('base64') : null,
        timeout: req.timeout ?? null, address: req.address ?? null,
      });
      if (a.error) throw new OutError(a.error, a.message);
      const bytes = Buffer.from(a.body, 'base64');
      if (req.maxBytes !== undefined && bytes.length > req.maxBytes) throw new OutError('too_large');
      return { status: a.status, headers: a.headers, body: new Uint8Array(bytes) };
    },
    async resolve(host, port) {
      const a = await call('dns', { host, port });
      if (a.error) throw new OutError('connect', a.message);
      return a.addresses;
    },
  };
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/__test/app' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const { env, db: path, bridge } = JSON.parse(Buffer.concat(chunks).toString());
      const db = openSqlite(path);
      await openSchema(db, schema);
      const clock = { now: null as number | null };
      const id = String(next++);
      const ctx: Ctx = { db, env, now: () => clock.now ?? Date.now() / 1000, services: {} };
      addServices(ctx, path, bridgeOutgoing(bridge, id));
      apps.set(id, { handle: makeApp(ctx), clock, db, env });
      for (const [old, a] of apps) {
        if (apps.size <= KEEP) break;
        a.db.close?.();
        apps.delete(old);
      }
      return json(res, 200, { id });
    }
    if (req.url?.startsWith('/__test/clock/') && req.method === 'POST') {
      const [, , , id, value] = req.url.split('/');
      apps.get(id)!.clock.now = value === 'real' ? null : Number(value);
      return json(res, 200, {});
    }
    if (req.url?.startsWith('/__test/app/') && req.method === 'DELETE') {
      apps.delete(req.url.split('/')[3]);
      return json(res, 200, {});
    }
    const app = apps.get(String(req.headers['x-test-app'] ?? ''));
    if (!app) return json(res, 400, { detail: 'unknown x-test-app' });
    const newEnv = req.headers['x-test-env']; // the environment of the test process as it is now (it changes after the app was made)
    if (typeof newEnv === 'string') {
      for (const k of Object.keys(app.env)) delete app.env[k];
      Object.assign(app.env, JSON.parse(newEnv));
    }
    testToday.day = typeof req.headers['x-test-today'] === 'string' ? req.headers['x-test-today'] : null; // tests run one request at a time
    await app.handle(req, res, String(req.headers['x-test-peer'] ?? '127.0.0.1'));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { detail: String(e) });
  }
});
server.listen(Number(process.env.TESTHOST_PORT ?? 0), '127.0.0.1', () => {
  const addr = server.address();
  console.log(typeof addr === 'object' && addr ? addr.port : addr);
});

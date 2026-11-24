// FOR TESTS ONLY, never run in production: one process that holds many apps, each with its own database, environment
// and clock, so that the Python API tests can run against the TS server (tests/ts_bridge.py). It trusts the headers
// x-test-app (which app) and x-test-peer (the TCP address the app sees) – exactly what a real server must never do.
// Listens on 127.0.0.1 only; prints the port on stdout.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openSchema } from '../core/db.ts';
import { makeApp } from './app.ts';
import { openSqlite } from './sqlite.ts';

const schema = readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8');
const apps = new Map<string, { handle: ReturnType<typeof makeApp>; clock: { now: number | null }; db: { close?(): void } }>();
const KEEP = 40; // a test uses at most a few apps; older ones are closed (file handles)
let next = 1;

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/__test/app' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const { env, db: path } = JSON.parse(Buffer.concat(chunks).toString());
      const db = openSqlite(path);
      await openSchema(db, schema);
      const clock = { now: null as number | null };
      const id = String(next++);
      apps.set(id, { handle: makeApp({ db, env, now: () => clock.now ?? Date.now() / 1000, services: {} }), clock, db });
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

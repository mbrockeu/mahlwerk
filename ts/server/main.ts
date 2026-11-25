// Production entry: MAHLWERK_* environment like the Python server (see docs), listens on MAHLWERK_PORT (default 8120).
import { createServer } from 'node:http';
import { openServerSchema } from './schema.ts';
import { makeApp } from './app.ts';
import { nodeOutgoing } from './outgoing.ts';
import type { Ctx } from '../core/http.ts';
import type { RecipeImages } from '../core/recipeImages.ts';
import { authServices } from './authServices.ts';
import { addServices } from './services.ts';
import { openSqlite } from './sqlite.ts';

const env = process.env;
const dbPath = env.MAHLWERK_DB ?? './data/mahlwerk.db';
const db = openSqlite(dbPath);
await openServerSchema(db);
const ctx: Ctx = { db, env, now: () => Date.now() / 1000, services: { ...authServices(dbPath) } };
addServices(ctx, dbPath, nodeOutgoing());
await (ctx.services.images as RecipeImages).sweep(); // what no food refers to any more is tidied at start
const handle = makeApp(ctx);
const port = Number(env.MAHLWERK_PORT ?? 8120);
const server = createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
}).listen(port, env.MAHLWERK_HOST ?? '127.0.0.1', () =>
  console.log(`mahlwerk-ts listening on ${port}`));
// as PID 1 in a container Node would ignore SIGTERM (docker stop would wait ten seconds, then kill): stop listening and leave
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { setTimeout(() => process.exit(0), 3000).unref(); server.close(() => process.exit(0)); server.closeAllConnections(); });
}

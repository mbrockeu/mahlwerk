// Production entry: MAHLWERK_* environment like the Python server (see docs), listens on MAHLWERK_PORT (default 8120).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openSchema } from '../core/db.ts';
import { makeApp } from './app.ts';
import { openSqlite } from './sqlite.ts';

const env = process.env;
const db = openSqlite(env.MAHLWERK_DB ?? './data/mahlwerk.db');
await openSchema(db, readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8'));
const handle = makeApp({ db, env, now: () => Date.now() / 1000, services: {} });
const port = Number(env.MAHLWERK_PORT ?? 8120);
createServer((req, res) => void handle(req, res)).listen(port, env.MAHLWERK_HOST ?? '127.0.0.1', () =>
  console.log(`mahlwerk-ts listening on ${port}`));

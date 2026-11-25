// The server's database schema step: a new file gets the current schema, version 20 is migrated to 21 here, older ones are refused.
import { readFileSync } from 'node:fs';
import { openSchema, SchemaMismatch } from '../core/db.ts';
import type { Db } from '../core/db.ts';

const schemaSql = readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8');
const v21Sql = readFileSync(new URL('../core/migrations/v21.sql', import.meta.url), 'utf8');

export async function openServerSchema(db: Db): Promise<void> {
  try {
    await openSchema(db, schemaSql, { 20: v21Sql });
  } catch (e) {
    if (e instanceof SchemaMismatch) {
      throw new SchemaMismatch(`${e.message}. This server migrates schema version 20 only: start the Python server once on this file `
        + '(Docker: `docker compose run --rm -p 127.0.0.1:8110:8110 tools uvicorn mahlwerk.main:app --factory --host 0.0.0.0 --port 8110`, or `Dockerfile.python`) '
        + 'to bring it up to date, then start this one again.');
    }
    throw e;
  }
}

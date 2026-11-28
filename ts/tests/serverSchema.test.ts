// The server's schema step: a new file, v20 and v21 migrated to v22, older versions refused with a hint.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SchemaMismatch } from '../core/db.ts';
import { openServerSchema } from '../server/schema.ts';
import { openSqlite } from '../server/sqlite.ts';

const dir = mkdtempSync(join(tmpdir(), 'mw-srv-schema-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const v20 = readFileSync(new URL('./fixtures/schema-v20.sql', import.meta.url), 'utf8');
const version = (p: string) => { const c = new DatabaseSync(p); const v = (c.prepare('PRAGMA user_version').get() as any).user_version; c.close(); return v; };
const makeDb = (name: string, v: number) => {
  const p = join(dir, name);
  const c = new DatabaseSync(p);
  c.exec(`BEGIN; ${v20} PRAGMA user_version = ${v}; COMMIT;`);
  c.close();
  return p;
};

test('a new file gets schema 22', async () => {
  const p = join(dir, 'new.db');
  await openServerSchema(openSqlite(p));
  assert.equal(version(p), 22);
});

test('a v20 file is migrated to v22: uid and weekday goal columns exist and rows keep their data', async () => {
  const p = makeDb('v20.db', 20);
  const c = new DatabaseSync(p);
  c.exec("INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'me', 'Me', 1); INSERT INTO fast (id, user_id, started_at, target_hours) VALUES (1, 1, 1, 16);");
  c.close();
  await openServerSchema(openSqlite(p));
  assert.equal(version(p), 22);
  const d = new DatabaseSync(p);
  const cols = (d.prepare("PRAGMA table_info('fast')").all() as any[]).map((r) => r.name);
  assert.ok(cols.includes('uid'));
  for (const t of ['goal', 'goal_history']) assert.ok(['alt_days', 'alt_kcal', 'alt_protein', 'alt_carbs', 'alt_fat'].every((c) => (d.prepare(`PRAGMA table_info('${t}')`).all() as any[]).some((r) => r.name === c)), t);
  const row = d.prepare('SELECT uid, target_hours FROM fast').get() as any;
  assert.equal(row.target_hours, 16);
  assert.ok(typeof row.uid === 'string' && row.uid.length > 0);
  d.close();
});

test('v19 is refused and the message says what to do', async () => {
  const p = makeDb('v19.db', 19);
  await assert.rejects(openServerSchema(openSqlite(p)), (e: Error) => e instanceof SchemaMismatch && /version 19/.test(e.message) && /Python server once/.test(e.message));
  assert.equal(version(p), 19);
});

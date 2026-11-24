// User settings (db.py: get_settings, set_setting).
import type { Db } from '../db.ts';
import { toJson } from '../db.ts';

export async function getSettings(db: Db, userId: number): Promise<Record<string, any>> {
  const rows = await db.all('SELECT key, value FROM user_setting WHERE user_id = ?', [userId]);
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

export async function setSetting(db: Db, userId: number, key: string, value: unknown): Promise<void> {
  await db.run('INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
    [userId, key, toJson(value)]);
}

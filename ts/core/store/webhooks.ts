// Webhooks and their delivery log (db.py: create_webhook … list_deliveries).
import type { Db, Row } from '../db.ts';
import { toJson } from '../db.ts';

export interface Hook { id: number; name: string; url: string; events: string[]; enabled: boolean; created_at: number; secret?: string }

const hook = (row: Row, secret = false): Hook => ({
  id: row.id, name: row.name, url: row.url, events: JSON.parse(row.events), enabled: Boolean(row.enabled), created_at: row.created_at,
  ...(secret ? { secret: row.secret } : {}),
});
const now = () => Math.floor(Date.now() / 1000);

export async function createWebhook(db: Db, userId: number, name: string, url: string, secret: string, events: string[]): Promise<Hook> {
  const r = await db.run('INSERT INTO webhook (user_id, name, url, secret, events, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [userId, name, url, secret, toJson(events), now()]);
  return hook((await db.get('SELECT * FROM webhook WHERE id = ?', [r.lastId]))!);
}

export async function listWebhooks(db: Db, userId: number): Promise<Hook[]> {
  return (await db.all('SELECT * FROM webhook WHERE user_id = ? ORDER BY id', [userId])).map((r) => hook(r));
}

export async function getWebhook(db: Db, userId: number, hookId: number, secret = false): Promise<Hook | null> {
  const row = await db.get('SELECT * FROM webhook WHERE id = ? AND user_id = ?', [hookId, userId]);
  return row ? hook(row, secret) : null;
}

/** A hook with its secret, whoever owns it (for the sender only). */
export async function webhookById(db: Db, hookId: number): Promise<Hook | null> {
  const row = await db.get('SELECT * FROM webhook WHERE id = ?', [hookId]);
  return row ? hook(row, true) : null;
}

/** The user's enabled hooks that listen to `event`, with their secret (for the sender only). */
export async function hooksForEvent(db: Db, userId: number, event: string): Promise<Hook[]> {
  const rows = await db.all('SELECT * FROM webhook WHERE user_id = ? AND enabled = 1 ORDER BY id', [userId]);
  return rows.map((r) => hook(r, true)).filter((h) => h.events.includes(event));
}

export async function updateWebhook(db: Db, userId: number, hookId: number, changes: Record<string, unknown>): Promise<boolean> {
  const columns = new Set(['name', 'url', 'events', 'enabled']);
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!columns.has(key)) throw new Error(`unknown column ${key}`);
    sets.push(`${key} = ?`);
    values.push(key === 'events' ? toJson(value) : key === 'enabled' ? Number(value) : value);
  }
  if (!sets.length) return (await getWebhook(db, userId, hookId)) !== null;
  return (await db.run(`UPDATE webhook SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...values, hookId, userId])).changes > 0;
}

export async function deleteWebhook(db: Db, userId: number, hookId: number): Promise<boolean> {
  return db.tx(async (tx) => {
    await tx.run('DELETE FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE id = ? AND user_id = ?)', [hookId, userId]);
    return (await tx.run('DELETE FROM webhook WHERE id = ? AND user_id = ?', [hookId, userId])).changes > 0;
  });
}

export async function startDelivery(db: Db, hookId: number, event: string): Promise<number> {
  return (await db.run('INSERT INTO webhook_delivery (webhook_id, event, attempts, created_at) VALUES (?, ?, 0, ?)', [hookId, event, now()])).lastId;
}

export async function updateDelivery(db: Db, id: number, attempts: number, status: number | null, error: string | null, finished: boolean): Promise<void> {
  await db.run('UPDATE webhook_delivery SET attempts = ?, status_code = ?, error = ?, finished_at = ? WHERE id = ?',
    [attempts, status, error, finished ? now() : null, id]);
}

export async function pruneDeliveries(db: Db, hookId: number, keep = 20): Promise<void> {
  await db.run('DELETE FROM webhook_delivery WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_delivery WHERE webhook_id = ? ORDER BY id DESC LIMIT ?)',
    [hookId, hookId, keep]);
}

export async function listDeliveries(db: Db, hookId: number): Promise<Row[]> {
  return db.all('SELECT id, event, status_code, error, attempts, created_at, finished_at FROM webhook_delivery WHERE webhook_id = ? ORDER BY id DESC', [hookId]);
}

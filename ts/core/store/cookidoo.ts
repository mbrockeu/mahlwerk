// What the Cookidoo connector needs from the database beyond foods and groups (db.py: source_group, source_dismissed, undismiss_source,
// foods_without_image).
import type { Db } from '../db.ts';

const now = (): number => Math.floor(Date.now() / 1000);

/** [group id, created] of the group that belongs to `source` (`cookidoo:<collection id>`): the existing one, a new one named like the
 * collection (made distinct when the name is taken), or [null, false] when the household deleted it. */
export async function sourceGroup(db: Db, source: string, name: string, userId: number | null): Promise<[number | null, boolean]> {
  return db.tx(async (tx) => {
    const row = await tx.get('SELECT id FROM recipe_group WHERE source = ?', [source]);
    if (row) return [row.id as number, false] as [number, boolean];
    if (await tx.get('SELECT 1 FROM recipe_group_dismissed WHERE source = ?', [source])) return [null, false] as [null, boolean];
    const base = [...(name.trim() || 'Cookidoo')].slice(0, 60).join('');
    const taken = new Set((await tx.all('SELECT name FROM recipe_group')).map((r) => String(r.name).toLowerCase()));
    let candidate = base;
    let n = 1;
    while (taken.has(candidate.toLowerCase())) {
      n += 1;
      candidate = [...`${base} (${n === 2 ? 'Cookidoo' : n})`].slice(0, 70).join('');
    }
    const position = (await tx.get('SELECT coalesce(max(position), 0) + 1 AS p FROM recipe_group'))!.p;
    const made = await tx.run('INSERT INTO recipe_group (name, position, source, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [candidate, position, source, userId, now()]);
    return [made.lastId, true] as [number, boolean];
  });
}

export async function sourceDismissed(db: Db, source: string): Promise<boolean> {
  return (await db.get('SELECT 1 FROM recipe_group_dismissed WHERE source = ?', [source])) !== undefined;
}

export async function undismissSource(db: Db, source: string): Promise<void> {
  await db.run('DELETE FROM recipe_group_dismissed WHERE source = ?', [source]);
}

/** Taken-over recipes of a source that have no picture yet and where nobody opted out (`none`) or set an own one; a recipe whose last
 * try failed less than `skipFailedSeconds` ago is left out. */
export async function foodsWithoutImage(db: Db, source: string, at: number | null = null, skipFailedSeconds = 7 * 86400): Promise<{ id: number; external_id: string | null; image_url: string | null }[]> {
  const limit = Math.trunc(at ?? Date.now() / 1000) - skipFailedSeconds;
  return db.all("SELECT id, external_id, image_url FROM food WHERE source = ? AND found = 1 AND image_hash IS NULL "
    + "AND (image_origin IS NULL OR image_origin NOT IN ('own', 'none')) "
    + "AND (image_origin IS NULL OR image_origin != 'failed' OR image_at <= ?) ORDER BY id", [source, limit]);
}

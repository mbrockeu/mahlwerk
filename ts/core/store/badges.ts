// Badges and the reads they need (db.py: badge_inputs, badges_earned, record_badges, mark_badges_seen, entry span, last entry).
import type { Db } from '../db.ts';
import type { Per100 } from '../nutrition.ts';

export interface BadgeEntry { day: string; meal: string; food_id: number | null; name: string; brand: string | null; amount: number; per_100: Per100; demo: number }
export interface BadgeRow { code: string; earned_at: number; seen: number; demo: number }

/** Everything the badges look at: all entries and weights (with their demo flag) and the recipe count. */
export async function badgeInputs(db: Db, userId: number): Promise<[BadgeEntry[], { day: string; demo: number }[], number]> {
  const entries = await db.all('SELECT day, meal, food_id, name, brand, amount, per_100, demo FROM diary_entry WHERE user_id = ?', [userId]);
  const weights = await db.all('SELECT day, demo FROM weight WHERE user_id = ?', [userId]);
  const recipes = (await db.get('SELECT count(*) AS n FROM recipe WHERE created_by = ?', [userId]))!.n;
  return [entries.map((r) => ({ ...r, per_100: JSON.parse(r.per_100) }) as BadgeEntry), weights as any, recipes];
}

export const badgesEarned = (db: Db, userId: number): Promise<BadgeRow[]> =>
  db.all('SELECT code, earned_at, seen, demo FROM badge_earned WHERE user_id = ? ORDER BY earned_at, code', [userId]) as Promise<BadgeRow[]>;

/** Remember newly reached badges. A badge that real data alone does not reach is marked as demo-only; once real data reaches
 * it too, the mark goes away. */
export async function recordBadges(db: Db, userId: number, reached: Set<string>, byRealData: Set<string>, now: number): Promise<void> {
  await db.tx(async (tx) => {
    const known = new Map((await tx.all('SELECT code, demo FROM badge_earned WHERE user_id = ?', [userId])).map((r) => [r.code, r.demo]));
    for (const code of [...reached].sort()) {
      if (!known.has(code)) {
        await tx.run('INSERT INTO badge_earned (user_id, code, earned_at, seen, demo) VALUES (?, ?, ?, 0, ?)', [userId, code, now, byRealData.has(code) ? 0 : 1]);
      } else if (known.get(code) && byRealData.has(code)) {
        await tx.run('UPDATE badge_earned SET demo = 0 WHERE user_id = ? AND code = ?', [userId, code]);
      }
    }
  });
}

export async function markBadgesSeen(db: Db, userId: number, codes: string[]): Promise<void> {
  if (!codes.length) return;
  await db.run(`UPDATE badge_earned SET seen = 1 WHERE user_id = ? AND code IN (${codes.map(() => '?').join(', ')})`, [userId, ...codes]);
}

/** First and last day with an entry of this user, null without any. */
export async function entrySpan(db: Db, userId: number): Promise<[string, string] | null> {
  const row = await db.get('SELECT MIN(day) AS a, MAX(day) AS b FROM diary_entry WHERE user_id = ?', [userId]);
  return row?.a ? [row.a, row.b] : null;
}

export async function lastEntryAt(db: Db, userId: number): Promise<number | null> {
  return (await db.get('SELECT max(created_at) AS t FROM diary_entry WHERE user_id = ?', [userId]))!.t;
}

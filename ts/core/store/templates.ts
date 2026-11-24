// Meal templates, per user (db.py: create_template, get_template, list_templates, rename_template, delete_template).
import type { Db, Row } from '../db.ts';
import { toJson } from '../db.ts';
import type { Per100 } from '../nutrition.ts';

export interface TemplateItemRow {
  id: number; template_id: number; food_id: number | null; amount: number; unit: 'g' | 'ml'; name: string; brand: string | null;
  per_100: Per100; extra: Record<string, number>;
}
export interface TemplateRow { id: number; user_id: number; name: string; created_at: number; items: TemplateItemRow[] }

/** What a template or recipe item keeps of a food (the same copy as a diary entry). */
export interface ItemIn {
  food_id: number | null; amount: number; unit: string; name: string; brand: string | null; per_100: Per100; extra?: Record<string, number> | null;
}

export const itemRow = (row: Row): TemplateItemRow => ({ ...row, per_100: JSON.parse(row.per_100), extra: JSON.parse(row.extra || '{}') }) as TemplateItemRow;

async function withItems(db: Db, row: Row): Promise<TemplateRow> {
  const items = await db.all('SELECT * FROM template_item WHERE template_id = ? ORDER BY id', [row.id]);
  return { ...row, items: items.map(itemRow) } as TemplateRow;
}

export async function createTemplate(db: Db, userId: number, name: string, items: ItemIn[]): Promise<number> {
  return db.tx(async (tx) => {
    const id = (await tx.run('INSERT INTO template (user_id, name, created_at) VALUES (?, ?, ?)', [userId, name, Math.floor(Date.now() / 1000)])).lastId;
    for (const item of items) {
      await tx.run('INSERT INTO template_item (template_id, food_id, amount, unit, name, brand, per_100, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, item.food_id, item.amount, item.unit, item.name, item.brand, toJson(item.per_100), toJson(item.extra || {})]);
    }
    return id;
  });
}

export async function getTemplate(db: Db, userId: number, templateId: number): Promise<TemplateRow | undefined> {
  const row = await db.get('SELECT * FROM template WHERE id = ? AND user_id = ?', [templateId, userId]);
  return row ? withItems(db, row) : undefined;
}

/** The user's templates, most recently created first. */
export async function listTemplates(db: Db, userId: number): Promise<TemplateRow[]> {
  const rows = await db.all('SELECT * FROM template WHERE user_id = ? ORDER BY id DESC', [userId]);
  return Promise.all(rows.map((r) => withItems(db, r)));
}

export async function renameTemplate(db: Db, userId: number, templateId: number, name: string): Promise<boolean> {
  return (await db.run('UPDATE template SET name = ? WHERE id = ? AND user_id = ?', [name, templateId, userId])).changes > 0;
}

export async function deleteTemplate(db: Db, userId: number, templateId: number): Promise<boolean> {
  return db.tx(async (tx) => {
    if (!(await tx.get('SELECT 1 FROM template WHERE id = ? AND user_id = ?', [templateId, userId]))) return false;
    await tx.run('DELETE FROM template_item WHERE template_id = ?', [templateId]);
    await tx.run('DELETE FROM template WHERE id = ?', [templateId]);
    return true;
  });
}

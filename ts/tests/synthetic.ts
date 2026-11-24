// FOR TESTS: a long diary written straight into a database (years of entries in seconds), to measure the export and the import.
import type { Db } from '../core/db.ts';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const EXTRA_KEYS = ['calcium', 'iron', 'potassium', 'magnesium', 'zinc', 'sodium', 'water', 'cholesterol', 'starch', 'iodine'];

/** `entries` diary entries over the days before `lastDay` (about 14 a day), 300 own foods (60 with a barcode), weights, water and
 * workouts on every day, a few templates. Entries carry 10 more nutrients each, like a Yazio import. */
export async function fillSynthetic(db: Db, userId: number, entries: number, lastDay = '2026-11-20'): Promise<void> {
  const days = Math.ceil(entries / 14);
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  const day = (i: number) => new Date(end - i * 86400000).toISOString().slice(0, 10);
  const extra = (i: number) => Object.fromEntries(EXTRA_KEYS.map((k, j) => [k, ((i * 7 + j * 3) % 90) + 0.5]));
  await db.tx(async (tx) => {
    for (let f = 0; f < 300; f++) {
      const data = { name: `Food ${f}`, brand: f % 3 ? `Brand ${f % 17}` : null, unit: 'g', per_100: { kcal: 50 + f, protein: f % 30, carbs: f % 60, fat: f % 20, sugars: f % 9, saturated_fat: null, fiber: 2, salt: 0.1 }, extra: extra(f) };
      await tx.run("INSERT INTO food (id, code, source, found, data, fetched_at, created_by) VALUES (?, ?, 'own', 1, ?, 1, ?)",
        [100000 + f, f < 60 ? String(4000000000000 + f * 10) : null, JSON.stringify(data), userId]);
    }
    for (let start = 0; start < entries; start += 500) {
      const rows = [];
      for (let i = start; i < Math.min(entries, start + 500); i++) {
        const f = (i * 31) % 300;
        rows.push({ day: day(Math.floor(i / 14)), meal: MEALS[i % 4], food_id: 100000 + f, amount: 20 + (i % 180), name: `Food ${f}`, brand: f % 3 ? `Brand ${f % 17}` : null,
          per_100: JSON.stringify({ kcal: 50 + f, protein: f % 30, carbs: f % 60, fat: f % 20, sugars: f % 9, saturated_fat: null, fiber: 2, salt: 0.1 }), extra: JSON.stringify(extra(f)), created_at: 1700000000 + i * 600 });
      }
      await tx.run(`INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, created_at)
        SELECT ?, j.value ->> 'day', j.value ->> 'meal', j.value ->> 'food_id', j.value ->> 'amount', 'g', j.value ->> 'name', j.value ->> 'brand',
          j.value ->> 'per_100', j.value ->> 'extra', j.value ->> 'created_at' FROM json_each(?) j`, [userId, JSON.stringify(rows)]);
    }
    for (let i = 0; i < days; i++) {
      await tx.run('INSERT INTO weight (user_id, day, kg) VALUES (?, ?, ?)', [userId, day(i), 70 + (i % 50) / 10]);
      await tx.run('INSERT INTO water (user_id, day, ml) VALUES (?, ?, ?)', [userId, day(i), 1500 + (i % 10) * 100]);
      if (i % 3 === 0) await tx.run("INSERT INTO workout (user_id, day, kind, name, minutes, kcal, created_at) VALUES (?, ?, 'running', 'Run', 30, 300, 1)", [userId, day(i)]);
    }
    for (let t = 0; t < 10; t++) {
      const id = (await tx.run('INSERT INTO template (user_id, name, created_at) VALUES (?, ?, ?)', [userId, `Template ${t}`, 1700000000 + t])).lastId;
      await tx.run("INSERT INTO template_item (template_id, food_id, amount, unit, name, per_100, extra) VALUES (?, ?, 50, 'g', 'x', '{\"kcal\":100}', '{}')", [id, 100000 + t]);
    }
  });
}

// Meal templates: a saved set of entries a user logs often, applied to a day and meal with one tap (routes/templates.py).
import { HttpError, parse, pathInt, route, type Req, type Route } from '../http.ts';
import { templateApply, templateIn, templatePatch, type Template } from '../models/recipe.ts';
import { r1, scale } from '../nutrition.ts';
import { pySum } from '../num.ts';
import { addEntries, entriesOn, getEntries, getEntry } from '../store/diary.ts';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, renameTemplate, type ItemIn, type TemplateRow } from '../store/templates.ts';
import { emitEntries, entriesOut, foodCopy, parseDay, snapshot } from './diary.ts';

export function templateOut(row: TemplateRow): Template {
  const items = row.items.map((item) => {
    const kcal = scale(item.per_100, item.amount).kcal;
    return { name: item.name, brand: item.brand, amount: item.amount, unit: item.unit, kcal: kcal === null ? null : r1(kcal) };
  });
  return { id: row.id, name: row.name, kcal: r1(pySum(items.map((i) => i.kcal ?? 0))), items };
}

async function own(req: Req, templateId: number): Promise<TemplateRow> {
  const row = await getTemplate(req.ctx.db, req.user!.id, templateId);
  if (!row) throw new HttpError(404, 'unknown template');
  return row;
}

export const routes: Route[] = [
  route('GET', '/api/v1/templates', async (req): Promise<Template[]> => (await listTemplates(req.ctx.db, req.user!.id)).map(templateOut)),

  // Save a template: a logged meal of this user (`from`), or foods with amounts (`items`, e.g. a favourite combo).
  route('POST', '/api/v1/templates', async (req): Promise<Template> => {
    const body = parse(templateIn, req.body);
    const { db } = req.ctx;
    const uid = req.user!.id;
    let items: ItemIn[];
    if (body.items !== null) {
      items = [];
      for (const it of body.items) {
        const { id, copy } = await foodCopy(req, it.food_id);
        items.push({ food_id: id, amount: it.amount, ...copy });
      }
    } else {
      parseDay(body.from!.day);
      const rows = await entriesOn(db, uid, body.from!.day, body.from!.meal);
      if (!rows.length) throw new HttpError(404, 'that meal has no entries');
      items = rows.map((r) => snapshot(r));
    }
    return templateOut((await getTemplate(db, uid, await createTemplate(db, uid, body.name, items)))!);
  }, { status: 201 }),

  route('PATCH', '/api/v1/templates/{template_id}', async (req): Promise<Template> => {
    const templateId = pathInt(req, 'template_id');
    const body = parse(templatePatch, req.body);
    await own(req, templateId);
    await renameTemplate(req.ctx.db, req.user!.id, templateId, body.name);
    return templateOut(await own(req, templateId));
  }),

  route('DELETE', '/api/v1/templates/{template_id}', async (req) => {
    if (!(await deleteTemplate(req.ctx.db, req.user!.id, pathInt(req, 'template_id')))) throw new HttpError(404, 'unknown template');
    return undefined;
  }, { status: 204 }),

  route('POST', '/api/v1/templates/{template_id}/apply', async (req) => {
    const templateId = pathInt(req, 'template_id');
    const body = parse(templateApply, req.body);
    parseDay(body.day);
    const row = await own(req, templateId);
    const { db } = req.ctx;
    const uid = req.user!.id;
    const ids = await addEntries(db, uid, body.day, row.items.map((i) => snapshot(i as any, body.meal)));
    const added = await getEntries(db, uid, ids);
    await emitEntries(req, added);
    return entriesOut(added);
  }, { status: 201 }),
];

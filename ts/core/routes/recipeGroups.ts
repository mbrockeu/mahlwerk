// Groups of recipes: a shared list of the household, like the recipes themselves (routes/recipe_groups.py).
// A member is a recipe in the wide sense: an own recipe or a recipe taken over from Cookidoo; both are foods, so a group holds FOOD ids.
// A recipe can be in several groups. Deleting a group keeps its recipes; deleting a recipe removes it from its groups. A group made
// automatically from a Cookidoo collection (`auto`) can be renamed, reordered and deleted like any other; deleting it is remembered.
import { HttpError, parse, pathInt, route, type Req, type Route, type User } from '../http.ts';
import { foodGroupsIn, groupIn, MAX_GROUPS, membersIn, orderIn, type Group } from '../models/recipe.ts';
import { canEdit, isHousehold, needEdit, needHousehold, NOT_YOURS } from '../ownership.ts';
import { pySplit } from '../text.ts';
import {
  addToGroup, createGroup, deleteGroup, getGroup, groupNameTaken, listGroups, recipeFoodIds, removeFromGroup, renameGroup, reorderGroups, setFoodGroups,
  type GroupRow,
} from '../store/recipes.ts';

const groupOut = (row: GroupRow, user: User): Group => ({
  id: row.id, name: row.name, position: row.position, auto: row.source !== null, count: row.food_ids.length, food_ids: row.food_ids,
  can_edit: canEdit(user, row.created_by),
});

function cleanName(name: string): string {
  const out = pySplit(name).join(' ');
  if (!out || [...out].some((c) => c.codePointAt(0)! < 32)) throw new HttpError(422, 'a group needs a name (no control characters)');
  return out;
}

async function existing(req: Req, groupId: number): Promise<GroupRow> {
  const row = await getGroup(req.ctx.db, groupId);
  if (!row) throw new HttpError(404, 'unknown group');
  return row;
}

async function recipesOnly(req: Req, foodIds: number[]): Promise<number[]> {
  const ids = [...new Set(foodIds)];
  const recipes = await recipeFoodIds(req.ctx.db, ids);
  if (recipes.size !== ids.length || !ids.every((i) => recipes.has(i))) {
    throw new HttpError(422, 'only recipes (own or from Cookidoo) can be in a group: unknown food id or not a recipe');
  }
  return ids;
}

const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

export const routes: Route[] = [
  route('GET', '/api/v1/recipe-groups', async (req): Promise<Group[]> => (await listGroups(req.ctx.db)).map((g) => groupOut(g, req.user!))),

  route('POST', '/api/v1/recipe-groups', async (req): Promise<Group> => {
    const body = parse(groupIn, req.body);
    const { db } = req.ctx;
    const name = cleanName(body.name);
    if ((await listGroups(db)).length >= MAX_GROUPS) throw new HttpError(422, `at most ${MAX_GROUPS} groups`);
    if (await groupNameTaken(db, name)) throw new HttpError(409, 'a group with this name exists');
    return groupOut(await createGroup(db, name, req.user!.id), req.user!);
  }, { status: 201 }),

  // Every group id exactly once, in the order they should have. The order is shared by all: household only.
  route('PUT', '/api/v1/recipe-groups/order', async (req): Promise<Group[]> => {
    const body = parse(orderIn, req.body);
    needHousehold(req.user!, 'the order of the groups');
    if (!(await reorderGroups(req.ctx.db, body.ids))) throw new HttpError(422, 'the list must name every group exactly once');
    return (await listGroups(req.ctx.db)).map((g) => groupOut(g, req.user!));
  }),

  // The groups of one recipe (by food id), exactly these. Returns the ids now set. A guest can change only the membership in groups they
  // made: the list must keep the recipe in every other group it is in now and add it to none.
  route('PUT', '/api/v1/recipe-groups/foods/{food_id}', async (req): Promise<number[]> => {
    const foodId = pathInt(req, 'food_id');
    const body = parse(foodGroupsIn, req.body);
    const user = req.user!;
    await recipesOnly(req, [foodId]);
    const ids = [...new Set(body.group_ids)];
    const groups = await listGroups(req.ctx.db);
    const known = new Set(groups.map((g) => g.id));
    if (ids.some((i) => !known.has(i))) throw new HttpError(404, 'unknown group');
    if (!isHousehold(user)) {
      const foreign = new Set(groups.filter((g) => g.created_by !== user.id).map((g) => g.id));
      const now = new Set(groups.filter((g) => g.food_ids.includes(foodId) && foreign.has(g.id)).map((g) => g.id));
      if (!sameSet(now, new Set(ids.filter((i) => foreign.has(i))))) throw new HttpError(403, NOT_YOURS);
    }
    await setFoodGroups(req.ctx.db, foodId, ids);
    return ids;
  }),

  route('PUT', '/api/v1/recipe-groups/{group_id}', async (req): Promise<Group> => {
    const groupId = pathInt(req, 'group_id');
    const body = parse(groupIn, req.body);
    needEdit(req.user!, (await existing(req, groupId)).created_by);
    const name = cleanName(body.name);
    if (await groupNameTaken(req.ctx.db, name, groupId)) throw new HttpError(409, 'a group with this name exists');
    await renameGroup(req.ctx.db, groupId, name);
    return groupOut(await existing(req, groupId), req.user!);
  }),

  // The group goes, its recipes stay. Deleting a group made from a Cookidoo collection is remembered for everybody (household only).
  route('DELETE', '/api/v1/recipe-groups/{group_id}', async (req) => {
    const groupId = pathInt(req, 'group_id');
    const row = await getGroup(req.ctx.db, groupId);
    if (row) {
      needEdit(req.user!, row.created_by);
      if (row.source) needHousehold(req.user!, 'a group made from a Cookidoo collection');
    }
    if (!(await deleteGroup(req.ctx.db, groupId))) throw new HttpError(404, 'unknown group');
    return undefined;
  }, { status: 204 }),

  route('POST', '/api/v1/recipe-groups/{group_id}/members', async (req): Promise<Group> => {
    const groupId = pathInt(req, 'group_id');
    const body = parse(membersIn, req.body);
    needEdit(req.user!, (await existing(req, groupId)).created_by);
    await addToGroup(req.ctx.db, groupId, await recipesOnly(req, body.food_ids));
    return groupOut(await existing(req, groupId), req.user!);
  }),

  route('POST', '/api/v1/recipe-groups/{group_id}/members/remove', async (req): Promise<Group> => {
    const groupId = pathInt(req, 'group_id');
    const body = parse(membersIn, req.body);
    needEdit(req.user!, (await existing(req, groupId)).created_by);
    await removeFromGroup(req.ctx.db, groupId, [...new Set(body.food_ids)]);
    return groupOut(await existing(req, groupId), req.user!);
  }),
];

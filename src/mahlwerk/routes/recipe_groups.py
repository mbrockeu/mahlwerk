"""Groups of recipes: a shared list of the household, like the recipes themselves.

A member is a recipe in the wide sense: an own recipe or a recipe taken over from Cookidoo. Both are foods, so a group holds
FOOD ids (`Food.id`; an own recipe's food id is `Recipe.food.id`). A recipe can be in several groups. Deleting a group keeps its
recipes; deleting a recipe removes it from its groups. A group made automatically from a Cookidoo collection (`auto`) can be renamed,
reordered and deleted like any other; deleting it is remembered, so a later "take over all" does not bring it back unasked.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ownership
from ..auth import current_user
from ..db import Store
from ..deps import get_store

router = APIRouter(prefix="/api/v1/recipe-groups", dependencies=[Depends(current_user)])

MAX_GROUPS = 200
MAX_MEMBERS_PER_CALL = 1000


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class GroupOut(BaseModel):
    id: int
    name: str
    position: int
    auto: bool = Field(description="made from a Cookidoo collection by a run that takes over many recipes")
    count: int
    food_ids: list[int] = Field(description="the members: food ids of own recipes and of Cookidoo recipes")
    can_edit: bool = Field(True, description="the caller may rename, delete and fill this group (a guest only the groups they made; the household all)")


class OrderIn(BaseModel):
    ids: list[int] = Field(max_length=MAX_GROUPS, description="every group id exactly once, in the new order")


class MembersIn(BaseModel):
    food_ids: list[int] = Field(min_length=1, max_length=MAX_MEMBERS_PER_CALL)


class FoodGroupsIn(BaseModel):
    group_ids: list[int] = Field(max_length=MAX_GROUPS, description="exactly the groups this recipe should be in")


def group_out(row: dict, user: dict | None = None) -> GroupOut:
    return GroupOut(can_edit=True if user is None else ownership.can_edit(user, row["created_by"]), id=row["id"], name=row["name"], position=row["position"], auto=row["source"] is not None,
                    count=len(row["food_ids"]), food_ids=row["food_ids"])


def _name(body: GroupIn) -> str:
    name = " ".join(body.name.split())
    if not name or any(ord(c) < 32 for c in name):
        raise HTTPException(422, "a group needs a name (no control characters)")
    return name


def _existing(store: Store, group_id: int) -> dict:
    row = store.get_group(group_id)
    if row is None:
        raise HTTPException(404, "unknown group")
    return row


def _recipes_only(store: Store, food_ids: list[int]) -> list[int]:
    ids = list(dict.fromkeys(food_ids))
    if store.recipe_food_ids(ids) != set(ids):
        raise HTTPException(422, "only recipes (own or from Cookidoo) can be in a group: unknown food id or not a recipe")
    return ids


@router.get("", response_model=list[GroupOut])
def list_groups(user: dict = Depends(current_user), store: Store = Depends(get_store)) -> list[GroupOut]:
    return [group_out(g, user) for g in store.list_groups()]


@router.post("", response_model=GroupOut, status_code=201)
def create_group(body: GroupIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> GroupOut:
    name = _name(body)
    if len(store.list_groups()) >= MAX_GROUPS:
        raise HTTPException(422, f"at most {MAX_GROUPS} groups")
    if store.group_name_taken(name):
        raise HTTPException(409, "a group with this name exists")
    return group_out(store.create_group(name, user["id"]), user)


@router.put("/order", response_model=list[GroupOut])
def order_groups(body: OrderIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> list[GroupOut]:
    """Every group id exactly once, in the order they should have. The order is shared by all: household only."""
    ownership.need_household(user, "the order of the groups")
    if not store.reorder_groups(body.ids):
        raise HTTPException(422, "the list must name every group exactly once")
    return [group_out(g, user) for g in store.list_groups()]


@router.put("/foods/{food_id}", response_model=list[int])
def set_groups_of_recipe(food_id: int, body: FoodGroupsIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> list[int]:
    """The groups of one recipe (by food id), exactly these. Returns the ids now set. A guest can change only the membership in groups
    they made: the list must keep the recipe in every other group it is in now and add it to none."""
    _recipes_only(store, [food_id])
    ids = list(dict.fromkeys(body.group_ids))
    groups = store.list_groups()
    if set(ids) - {g["id"] for g in groups}:
        raise HTTPException(404, "unknown group")
    if not ownership.is_household(user):
        foreign = {g["id"] for g in groups if g["created_by"] != user["id"]}
        if {g["id"] for g in groups if food_id in g["food_ids"]} & foreign != set(ids) & foreign:
            raise HTTPException(403, ownership.NOT_YOURS)
    store.set_food_groups(food_id, ids)
    return ids


@router.put("/{group_id}", response_model=GroupOut)
def rename_group(group_id: int, body: GroupIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> GroupOut:
    ownership.need_edit(user, _existing(store, group_id)["created_by"])
    name = _name(body)
    if store.group_name_taken(name, group_id):
        raise HTTPException(409, "a group with this name exists")
    store.rename_group(group_id, name)
    return group_out(_existing(store, group_id), user)


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> None:
    """The group goes, its recipes stay. Deleting a group made from a Cookidoo collection is remembered for everybody (household only)."""
    if (row := store.get_group(group_id)) is not None:
        ownership.need_edit(user, row["created_by"])
        if row["source"]:
            ownership.need_household(user, "a group made from a Cookidoo collection")
    if not store.delete_group(group_id):
        raise HTTPException(404, "unknown group")


@router.post("/{group_id}/members", response_model=GroupOut)
def add_members(group_id: int, body: MembersIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> GroupOut:
    ownership.need_edit(user, _existing(store, group_id)["created_by"])
    store.add_to_group(group_id, _recipes_only(store, body.food_ids))
    return group_out(_existing(store, group_id), user)


@router.post("/{group_id}/members/remove", response_model=GroupOut)
def remove_members(group_id: int, body: MembersIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> GroupOut:
    ownership.need_edit(user, _existing(store, group_id)["created_by"])
    store.remove_from_group(group_id, list(dict.fromkeys(body.food_ids)))
    return group_out(_existing(store, group_id), user)

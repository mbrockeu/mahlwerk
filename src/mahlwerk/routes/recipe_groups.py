"""Groups of recipes: a shared list of the household, like the recipes themselves.

A member is a recipe in the wide sense: an own recipe or a recipe taken over from Cookidoo. Both are foods, so a group holds
FOOD ids (`Food.id`; an own recipe's food id is `Recipe.food.id`). A recipe can be in several groups. Deleting a group keeps its
recipes; deleting a recipe removes it from its groups. A group made automatically from a Cookidoo collection (`auto`) can be renamed,
reordered and deleted like any other; deleting it is remembered, so a later "take over all" does not bring it back unasked.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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


class OrderIn(BaseModel):
    ids: list[int] = Field(max_length=MAX_GROUPS, description="every group id exactly once, in the new order")


class MembersIn(BaseModel):
    food_ids: list[int] = Field(min_length=1, max_length=MAX_MEMBERS_PER_CALL)


class FoodGroupsIn(BaseModel):
    group_ids: list[int] = Field(max_length=MAX_GROUPS, description="exactly the groups this recipe should be in")


def group_out(row: dict) -> GroupOut:
    return GroupOut(id=row["id"], name=row["name"], position=row["position"], auto=row["source"] is not None,
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
def list_groups(store: Store = Depends(get_store)) -> list[GroupOut]:
    return [group_out(g) for g in store.list_groups()]


@router.post("", response_model=GroupOut, status_code=201)
def create_group(body: GroupIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> GroupOut:
    name = _name(body)
    if len(store.list_groups()) >= MAX_GROUPS:
        raise HTTPException(422, f"at most {MAX_GROUPS} groups")
    if store.group_name_taken(name):
        raise HTTPException(409, "a group with this name exists")
    return group_out(store.create_group(name, user["id"]))


@router.put("/order", response_model=list[GroupOut])
def order_groups(body: OrderIn, store: Store = Depends(get_store)) -> list[GroupOut]:
    """Every group id exactly once, in the order they should have."""
    if not store.reorder_groups(body.ids):
        raise HTTPException(422, "the list must name every group exactly once")
    return [group_out(g) for g in store.list_groups()]


@router.put("/foods/{food_id}", response_model=list[int])
def set_groups_of_recipe(food_id: int, body: FoodGroupsIn, store: Store = Depends(get_store)) -> list[int]:
    """The groups of one recipe (by food id), exactly these. Returns the ids now set."""
    _recipes_only(store, [food_id])
    ids = list(dict.fromkeys(body.group_ids))
    if set(ids) - {g["id"] for g in store.list_groups()}:
        raise HTTPException(404, "unknown group")
    store.set_food_groups(food_id, ids)
    return ids


@router.put("/{group_id}", response_model=GroupOut)
def rename_group(group_id: int, body: GroupIn, store: Store = Depends(get_store)) -> GroupOut:
    _existing(store, group_id)
    name = _name(body)
    if store.group_name_taken(name, group_id):
        raise HTTPException(409, "a group with this name exists")
    store.rename_group(group_id, name)
    return group_out(_existing(store, group_id))


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, store: Store = Depends(get_store)) -> None:
    """The group goes, its recipes stay."""
    if not store.delete_group(group_id):
        raise HTTPException(404, "unknown group")


@router.post("/{group_id}/members", response_model=GroupOut)
def add_members(group_id: int, body: MembersIn, store: Store = Depends(get_store)) -> GroupOut:
    _existing(store, group_id)
    store.add_to_group(group_id, _recipes_only(store, body.food_ids))
    return group_out(_existing(store, group_id))


@router.post("/{group_id}/members/remove", response_model=GroupOut)
def remove_members(group_id: int, body: MembersIn, store: Store = Depends(get_store)) -> GroupOut:
    _existing(store, group_id)
    store.remove_from_group(group_id, list(dict.fromkeys(body.food_ids)))
    return group_out(_existing(store, group_id))

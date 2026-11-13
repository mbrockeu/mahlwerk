"""Recipes: a shared food of the household that is calculated from its ingredients."""

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import ingredients, nutrients
from ..auth import current_user
from ..catalog import Catalog
from ..db import Store
from ..deps import get_catalog, get_store
from ..models import IngredientCandidate, IngredientLine, IngredientMatches, IngredientsIn, Recipe, RecipeIn
from ..nutrition import r1, recipe_food, scale
from .foods import build_food

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


def recipe_out(row: dict) -> Recipe:
    items = []
    for item in row["items"]:
        kcal = scale(item["per_100"], item["amount"])["kcal"]
        items.append({
            "food_id": item["food_id"], "name": item["name"], "brand": item["brand"], "amount": item["amount"],
            "unit": item["unit"], "kcal": None if kcal is None else r1(kcal),
        })
    known = [i["kcal"] for i in items if i["kcal"] is not None]
    return Recipe(
        id=row["id"],
        food=build_food(row["food"]),
        portions=row["portions"],
        total_weight=row["total_weight"],
        items=items,
        kcal_per_portion=r1(sum(known) / row["portions"]) if known else None,
    )


def _ingredients(store: Store, body: RecipeIn) -> list[dict]:
    items = []
    for position, item in enumerate(body.items, start=1):
        food = store.get_food(item.food_id)
        if food is None or not food["found"]:
            raise HTTPException(422, f"ingredient {position}: unknown food")
        if food["source"] == "recipe":
            raise HTTPException(422, f"ingredient {position}: a recipe cannot be an ingredient of a recipe")
        data = food["data"]
        items.append({
            "food_id": food["id"],
            "amount": item.amount,
            "unit": data.get("unit") or "g",
            "name": data.get("name") or food["code"] or "Unnamed",
            "brand": data.get("brand"),
            "per_100": data["per_100"],
            "extra": nutrients.clean(data.get("extra")),
        })
    return items


def _save(store: Store, user_id: int, recipe_id: int | None, body: RecipeIn) -> dict:
    items = _ingredients(store, body)
    data = {**recipe_food(items, body.portions, body.total_weight), "name": body.name}
    saved = store.save_recipe(recipe_id, user_id, data, body.portions, body.total_weight, items)
    if saved is None:
        raise HTTPException(404, "unknown recipe")
    return store.get_recipe(saved)


def _existing(store: Store, recipe_id: int) -> dict:
    row = store.get_recipe(recipe_id)
    if row is None:
        raise HTTPException(404, "unknown recipe")
    return row


@router.post("/recipes/ingredients/match", response_model=IngredientMatches)
def match_ingredients(
    body: IngredientsIn, user: dict = Depends(current_user), store: Store = Depends(get_store), catalog: Catalog = Depends(get_catalog)
) -> IngredientMatches:
    """Reads a pasted ingredient list (one per line, German or English): amount, unit, name, grams and the foods that may be
    meant. Writes nothing; a recipe is made with `POST /recipes` from what the person confirms. Deterministic, no network."""
    parsed, ignored = ingredients.parse_text(body.text)
    own = [f for f in store.list_foods("", None, 100_000, ("recipe", "cookidoo", "web"), demo_account=bool(user.get("is_demo")))]
    lines = []
    for number, line in parsed:
        found = ingredients.candidates(line.name, own, catalog, store.known_catalog, context=line.text, canned=line.canned)
        out = [IngredientCandidate(**{k: v for k, v in vars(c).items() if k != "good"}) for c in found]
        lines.append(IngredientLine(
            line=number, text=line.text, quantity=line.quantity, unit=line.unit, name=line.name, note=line.note, optional=line.optional,
            grams=line.grams, ml=line.ml, estimated=line.estimated, basis=line.basis, candidates=out, suggestion=out[0] if out and found[0].good else None))
    return IngredientMatches(lines=lines, ignored=ignored)


@router.get("/recipes", response_model=list[Recipe])
def list_recipes(store: Store = Depends(get_store)) -> list[Recipe]:
    return [recipe_out(row) for row in store.list_recipes()]


@router.post("/recipes", response_model=Recipe, status_code=201)
def create_recipe(body: RecipeIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Recipe:
    return recipe_out(_save(store, user["id"], None, body))


@router.get("/recipes/{recipe_id}", response_model=Recipe)
def get_recipe(recipe_id: int, store: Store = Depends(get_store)) -> Recipe:
    return recipe_out(_existing(store, recipe_id))


@router.put("/recipes/{recipe_id}", response_model=Recipe)
def replace_recipe(
    recipe_id: int, body: RecipeIn, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Recipe:
    """Recalculates the food; diary entries logged before keep their copy."""
    _existing(store, recipe_id)
    return recipe_out(_save(store, user["id"], recipe_id, body))


@router.delete("/recipes/{recipe_id}", status_code=204)
def delete_recipe(recipe_id: int, request: Request, store: Store = Depends(get_store)) -> None:
    """Removes the recipe and its food (and its picture); diary entries and templates keep their copies."""
    row = store.get_recipe(recipe_id)
    if row is None or not store.delete_recipe(recipe_id):
        raise HTTPException(404, "unknown recipe")
    request.app.state.images.release_food(row["food"].get("image_hash"))

"""Suggestions "what still fits today": recipes that suit the rest of the day (see suggest.py for the rule).

Everything is computed from data that is on this server already: the goal of the person (with the active energy of the day if
that setting is on), what they ate, and when they last ate each recipe. Nothing is fetched and nothing leaves the server.
Goals and history are per person; the recipes are the household's.
"""

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .. import activity, suggest
from ..activity_views import day_activities
from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..models import Food
from ..nutrition import scale, total
from .diary import parse_day, today
from .foods import build_food

router = APIRouter(prefix="/api/v1/recipes", dependencies=[Depends(current_user)])

Focus = Literal["balanced", "protein", "light", "rotation"]


class RestOut(BaseModel):
    kcal: float | None = Field(description="what is left of the day's energy goal (negative: over it); null without a goal")
    protein: float | None = None
    carbs: float | None = None
    fat: float | None = None


class SuggestionOut(BaseModel):
    food: Food
    portions: float = Field(description="the recommended amount in portions: 0.5, 1, 1.5 or 2")
    amount: float = Field(description="the same as an amount of the food in its unit (what to log: 100 g = 1 portion for Cookidoo and web recipes)")
    kcal: float
    protein: float | None
    carbs: float | None
    fat: float | None
    after: RestOut = Field(description="what would be left of the day after this amount")
    reasons: list[str] = Field(description="one or two of fills_protein, high_protein, fits_kcal, not_eaten_lately, light, slightly_over")
    score: float


class Suggestions(BaseModel):
    day: str
    state: Literal["ok", "goal_reached", "no_goal", "nothing_fits", "no_recipes"] = Field(
        description="ok; goal_reached (nothing left: no suggestions unless `anyway`); no_goal (no energy goal: ranked by protein and variety); "
                    "nothing_fits (no amount fits the rest); no_recipes")
    focus: Focus
    goal_kcal: float | None = Field(description="the energy goal that counts on this day (with the active energy added when that setting is on)")
    rest: RestOut
    candidates: int = Field(description="recipes that were looked at (after the group filter)")
    items: list[SuggestionOut]


def _rest(goal: dict | None, goal_kcal: float | None, eaten: dict) -> suggest.Rest:
    if goal is None or goal_kcal is None:
        return suggest.Rest(None)
    return suggest.Rest(
        round(goal_kcal - eaten["kcal"], 1), round(goal["protein"] - eaten["protein"], 1) if goal.get("protein") else None,
        round(goal["carbs"] - eaten["carbs"], 1) if goal.get("carbs") else None, round(goal["fat"] - eaten["fat"], 1) if goal.get("fat") else None)


@router.get("/suggestions", response_model=Suggestions)
def suggestions(
    day: str | None = Query(None, alias="date", description="the day (default today)"),
    limit: int = Query(5, ge=1, le=20),
    group: str | None = Query(None, pattern=r"^(\d{1,9}|none)$", description="only recipes of this group (id) or `none` for those in no group"),
    focus: Focus = "balanced",
    anyway: bool = Query(False, description="after the goal is reached: light ideas all the same"),
    user: dict = Depends(current_user), store: Store = Depends(get_store),
) -> Suggestions:
    """Recipes that fit the rest of the day, best first, each with the best amount and one or two reasons. Cheap: a handful of
    queries however many recipes there are."""
    iso = parse_day(day).isoformat() if day else today().isoformat()
    uid = user["id"]
    goal = store.get_goal(uid)
    eaten = total([scale(r["per_100"], r["amount"]) for r in store.entries_on(uid, iso)])
    goal_kcal = None
    if goal:
        bonus = day_activities(store, uid, iso, iso, goal)[iso].bonus_kcal
        goal_kcal = activity.day_goal_kcal(goal["kcal"], {iso: bonus}, iso)
    rest = _rest(goal, goal_kcal, eaten)
    rows = store.recipe_foods(group)
    candidates, by_id = [], {}
    for row in rows:
        data = row["data"]
        per = data.get("per_100") or {}
        if per.get("kcal") is None:
            continue
        portion = data.get("serving_quantity") or 100.0
        values = scale(per, portion)
        candidates.append(suggest.Candidate(row["id"], values["kcal"], values["protein"], values["carbs"], values["fat"], portion))
        by_id[row["id"]] = row
    here = date.fromisoformat(iso)
    ago = {fid: (here - date.fromisoformat(d)).days for fid, d in store.last_eaten(uid, iso).items() if fid in by_id}
    result = suggest.rank(rest, candidates, {c.food_id: ago.get(c.food_id) for c in candidates}, focus, limit, anyway)
    items = []
    for s in result.items:
        row = store.get_food(s.food_id)
        items.append(SuggestionOut(
            food=build_food(row), portions=s.portions, amount=s.amount, kcal=s.kcal, protein=s.protein, carbs=s.carbs, fat=s.fat,
            after=RestOut(**vars(s.after)), reasons=list(s.reasons), score=s.score))
    return Suggestions(day=iso, state=result.state, focus=focus, goal_kcal=goal_kcal, rest=RestOut(**vars(rest)), candidates=len(candidates), items=items)

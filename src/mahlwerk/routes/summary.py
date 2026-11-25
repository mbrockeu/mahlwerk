"""A compact read-only summary for home automation (and an access token with scope `read` is enough)."""

import math
import time

from fastapi import APIRouter, Depends

from .. import activity
from ..activity_views import day_activities
from ..admin_models import SummaryToday
from ..auth import current_user
from ..db import DEFAULT_WATER_GOAL, Store
from ..deps import get_store
from ..models import MEALS
from ..hydration import day_drinks_ml
from ..nutrition import r1, scale, total
from .diary import today

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


@router.get("/summary/today", response_model=SummaryToday)
def summary_today(user: dict = Depends(current_user), store: Store = Depends(get_store)) -> dict:
    uid = user["id"]
    day = today().isoformat()
    rows = store.entries_on(uid, day)
    sums = total([scale(r["per_100"], r["amount"]) for r in rows])
    by_meal = {m: [r for r in rows if r["meal"] == m] for m in MEALS}
    goal = store.goal_on(uid, day)
    today_activity = day_activities(store, uid, day, day, goal)[day]
    kcal_goal = round(activity.day_goal_kcal(goal["kcal"], {day: today_activity.bonus_kcal}, day)) if goal else None
    eaten = r1(sums["kcal"])
    weight = store.latest_weight(uid)
    current = store.current_fast(uid)
    fasting = store.get_settings(uid).get("fasting", {})
    if current is not None:
        fast = {"active": True, "elapsed_seconds": max(0, int(time.time()) - current["started_at"]),
                "target_hours": current["target_hours"]}
    elif fasting.get("enabled"):
        fast = {"active": False, "elapsed_seconds": 0, "target_hours": fasting.get("target_hours", 16)}
    else:
        fast = None
    return {
        "day": day,
        "kcal_eaten": eaten,
        "kcal_goal": kcal_goal,
        # whole kcal, as the day view shows it: the goal minus the eaten kcal rounded half up (Math.round in the interface)
        "kcal_left": kcal_goal - math.floor(sums["kcal"] + 0.5) if goal else None,
        "kcal_goal_bonus": today_activity.bonus_kcal,
        "steps": today_activity.steps,
        "steps_goal": today_activity.steps_goal,
        "active_kcal": today_activity.active_kcal,
        "workouts": len(today_activity.workouts),
        "protein": r1(sums["protein"]),
        "carbs": r1(sums["carbs"]),
        "fat": r1(sums["fat"]),
        "water_ml": store.get_water(uid, day),
        "water_goal_ml": (goal or {}).get("water_ml", DEFAULT_WATER_GOAL),
        "water_drinks_ml": day_drinks_ml(store, uid, day),
        "weight_kg": weight["kg"] if weight else None,
        "weight_day": weight["day"] if weight else None,
        "body_fat_pct": weight["body_fat_pct"] if weight else None,
        "lean_kg": weight["lean_kg"] if weight else None,
        "fasting": fast,
        "logged_today": bool(rows),
        "meals": {m: r1(total([scale(r["per_100"], r["amount"]) for r in by_meal[m]])["kcal"]) for m in MEALS},
        "meal_entries": {m: len(by_meal[m]) for m in MEALS},
        "last_entry_at": store.last_entry_at(uid),
    }

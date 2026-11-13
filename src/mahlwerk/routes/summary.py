"""A compact read-only summary for home automation (and an access token with scope `read` is enough)."""

import time

from fastapi import APIRouter, Depends

from .. import activity
from ..activity_views import day_activities
from ..admin_models import SummaryToday
from ..auth import current_user
from ..db import DEFAULT_WATER_GOAL, Store
from ..deps import get_store
from ..nutrition import r1, scale, total
from .diary import today

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


@router.get("/summary/today", response_model=SummaryToday)
def summary_today(user: dict = Depends(current_user), store: Store = Depends(get_store)) -> dict:
    uid = user["id"]
    day = today().isoformat()
    rows = store.entries_on(uid, day)
    sums = total([scale(r["per_100"], r["amount"]) for r in rows])
    goal = store.get_goal(uid)
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
        "kcal_left": r1(kcal_goal - sums["kcal"]) if goal else None,
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
        "weight_kg": weight["kg"] if weight else None,
        "weight_day": weight["day"] if weight else None,
        "fasting": fast,
        "logged_today": bool(rows),
        "last_entry_at": store.last_entry_at(uid),
    }

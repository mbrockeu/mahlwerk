"""The activity of a day as the API shows it (shared by the day view, the activity routes and the summary)."""

from datetime import date, timedelta

from . import activity
from .db import Store
from .models import DayActivity, Workout


def workout_out(row: dict, weight_kg: float | None) -> Workout:
    """A stored workout; without a kcal value it is estimated from MET, body weight and minutes."""
    estimated = row["kcal"] is None
    kcal = activity.estimate_kcal(row["kind"], row["minutes"], weight_kg) if estimated else row["kcal"]
    return Workout(
        id=row["id"], day=row["day"], started_at=row["started_at"], kind=row["kind"], name=row["name"] or "",
        minutes=row["minutes"], kcal=round(kcal, 1), kcal_estimated=estimated, distance_m=row["distance_m"],
        steps=row["steps"], note=row["note"], source=row["source"],
    )


def day_activities(store: Store, uid: int, first: str, last: str, goal: dict | None = None, settings: dict | None = None) -> dict[str, DayActivity]:
    """The activity of every day in the range (also those without any data), by day."""
    settings = store.get_settings(uid) if settings is None else settings
    add = activity.add_to_goal_on(settings)
    steps_goal = (goal or store.get_goal(uid) or {}).get("steps", activity.DEFAULT_STEPS_GOAL)
    rows = store.activity_between(uid, first, last)
    by_day: dict[str, list[dict]] = {}
    for w in store.workouts_between(uid, first, last):
        by_day.setdefault(w["day"], []).append(w)
    weights: dict[str, float | None] = {}

    def weight(day: str) -> float | None:
        if day not in weights:
            weights[day] = store.weight_for(uid, day)
        return weights[day]

    out: dict[str, DayActivity] = {}
    cursor, end = date.fromisoformat(first), date.fromisoformat(last)
    while cursor <= end:
        day = cursor.isoformat()
        row = rows.get(day)
        out[day] = DayActivity(
            steps=row["steps"] if row else None, steps_goal=steps_goal,
            active_kcal=row["active_kcal"] if row else None, distance_m=row["distance_m"] if row else None,
            source=row["source"] if row else None, bonus_kcal=activity.goal_bonus(row["active_kcal"], add) if row else 0,
            workouts=[workout_out(w, weight(day)) for w in by_day.get(day, [])],
        )
        cursor += timedelta(days=1)
    return out

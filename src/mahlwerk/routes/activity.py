"""Activity: steps and active energy per day, workouts, and the bulk interface for Apple Health (see docs/api-v1.md)."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import activity
from ..activity_views import day_activities, workout_out
from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..models import ActivityDay, ActivityPut, DayActivity, HealthSync, HealthSyncResult, Workout, WorkoutIn, WorkoutPatch
from ..webhooks import emit
from .diary import parse_day, today

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


def activity_event(day: str, a: DayActivity) -> dict:
    return {"day": day, "steps": a.steps, "active_kcal": a.active_kcal, "distance_m": a.distance_m, "source": a.source}


def workout_event(w: Workout) -> dict:
    return w.model_dump()


def _own(store: Store, uid: int, workout_id: int) -> dict:
    row = store.get_workout(uid, workout_id)
    if row is None:
        raise HTTPException(404, "unknown workout")
    return row


@router.get("/activity", response_model=list[ActivityDay])
def list_activity(
    days: int = Query(14, ge=1, le=366), user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> list[ActivityDay]:
    """The last N days ending today, oldest first, each with its steps, active energy and workouts."""
    last = today()
    first = last - timedelta(days=days - 1)
    found = day_activities(store, user["id"], first.isoformat(), last.isoformat())
    return [ActivityDay(day=day, **a.model_dump()) for day, a in found.items()]


@router.put("/activity/{day}", response_model=ActivityDay)
def put_activity(
    day: str, body: ActivityPut, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> ActivityDay:
    """Set steps, active energy and/or distance of a day by hand: only the fields sent change, `null` clears one."""
    parse_day(day)
    changes = {k: getattr(body, k) for k in body.model_fields_set}
    if not changes:
        raise HTTPException(422, "nothing to change")
    store.put_activity(user["id"], day, changes)
    result = day_activities(store, user["id"], day, day)[day]
    emit(request, user, "activity.recorded", activity_event(day, result))
    return ActivityDay(day=day, **result.model_dump())


def _kind(body_kind: str | None, name: str | None) -> tuple[str, str]:
    return activity.resolve_kind(body_kind, name)


@router.post("/workouts", response_model=Workout, status_code=201)
def create_workout(
    body: WorkoutIn, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Workout:
    parse_day(body.day)
    kind, name = _kind(body.kind, body.name)
    workout_id = store.add_workout(user["id"], {**body.model_dump(), "kind": kind, "name": name})
    out = workout_out(store.get_workout(user["id"], workout_id), store.weight_for(user["id"], body.day))
    emit(request, user, "workout.created", workout_event(out))
    return out


@router.patch("/workouts/{workout_id}", response_model=Workout)
def patch_workout(
    workout_id: int, body: WorkoutPatch, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Workout:
    row = _own(store, user["id"], workout_id)
    changes = {k: getattr(body, k) for k in body.model_fields_set}
    if not changes:
        raise HTTPException(422, "nothing to change")
    for key in ("day", "kind", "minutes"):  # these have no empty value
        if key in changes and changes[key] is None:
            raise HTTPException(422, f"{key} cannot be cleared")
    if "day" in changes:
        parse_day(changes["day"])
    if "kind" in changes:  # an unknown kind becomes `other` and its text the name
        changes["kind"], changes["name"] = _kind(changes["kind"], changes.get("name", row["name"]))
    elif "name" in changes:
        changes["name"] = (changes["name"] or "").strip()
    store.update_workout(user["id"], workout_id, changes)
    updated = store.get_workout(user["id"], workout_id)
    return workout_out(updated, store.weight_for(user["id"], updated["day"]))


@router.delete("/workouts/{workout_id}", status_code=204)
def delete_workout(workout_id: int, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> None:
    if not store.delete_workout(user["id"], workout_id):
        raise HTTPException(404, "unknown workout")


@router.post("/health/sync", response_model=HealthSyncResult)
def health_sync(
    body: HealthSync, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> dict:
    """Bulk interface for a shortcut that reads Apple Health: idempotent, see docs/api-v1.md."""
    days = []
    for item in body.days:
        parse_day(item.day)
        data = item.model_dump()
        data["workouts"] = [
            {**w, **dict(zip(("kind", "name"), _kind(w["kind"], w["name"])))} for w in data["workouts"]
        ]
        days.append(data)
    uid = user["id"]
    result = store.health_sync(uid, days, body.overwrite_manual)
    changed = result["changed"]
    if changed["activity"]:
        first, last = min(changed["activity"]), max(changed["activity"])
        found = day_activities(store, uid, first, last)
        for day in dict.fromkeys(changed["activity"]):
            emit(request, user, "activity.recorded", activity_event(day, found[day]))
    for workout_id in changed["workouts"]:
        row = store.get_workout(uid, workout_id)
        emit(request, user, "workout.created", workout_event(workout_out(row, store.weight_for(uid, row["day"]))))
    return {"days": len(days), **result["counts"]}

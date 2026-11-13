"""The food diary: one day with its meals, entries, and the history across days."""

import re
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import activity, nutrients
from ..activity_views import day_activities
from ..auth import current_user
from ..db import DEFAULT_WATER_GOAL, Store
from ..deps import get_store
from ..models import MEALS, CopyIn, Day, Entries, Entry, EntryIn, EntryPatch, HistoryDay
from ..nutrition import PER_100_KEYS, r1, scale, total
from ..webhooks import emit

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def today() -> date:
    return date.today()


def parse_day(day: str) -> date:
    try:
        if _DAY.match(day):
            return date.fromisoformat(day)
    except ValueError:
        pass
    raise HTTPException(422, "day must be a date like 2025-01-31")


def _scaled(row: dict) -> dict:
    return scale(row["per_100"], row["amount"])


def _scaled_extra(row: dict) -> dict:
    return nutrients.scale_extra(row["extra"], row["amount"])


def entry_out(row: dict) -> Entry:
    nutrients = _scaled(row)
    return Entry(
        id=row["id"],
        food_id=row["food_id"],
        meal=row["meal"],
        name=row["name"],
        brand=row["brand"],
        amount=row["amount"],
        unit=row["unit"],
        **{k: None if nutrients[k] is None else r1(nutrients[k]) for k in ("kcal", "protein", "carbs", "fat")},
    )


def snapshot(row: dict, meal: str | None = None) -> dict:
    """The stored copy of an entry (or a template item), ready to be inserted again."""
    return {
        "meal": meal or row.get("meal"),
        "food_id": row["food_id"],
        "amount": row["amount"],
        "unit": row["unit"],
        "name": row["name"],
        "brand": row["brand"],
        "per_100": row["per_100"],
        "extra": row["extra"],
    }


def entry_event(store: Store, user_id: int, row: dict) -> dict:
    """The payload of the entry webhooks: the entry in short and the energy of its day so far."""
    entry = entry_out(row)
    day_kcal = sum(_scaled(r)["kcal"] or 0 for r in store.entries_on(user_id, row["day"]))
    return {
        "entry": {"id": entry.id, "name": entry.name, "brand": entry.brand, "amount": entry.amount, "unit": entry.unit,
                  "kcal": entry.kcal, "meal": entry.meal, "day": row["day"]},
        "day": row["day"],
        "day_kcal": r1(day_kcal),
    }


def emit_entries(request: Request, store: Store, user: dict, rows: list[dict]) -> None:
    for row in rows:
        emit(request, user, "entry.created", entry_event(store, user["id"], row))


def entries_out(store: Store, user_id: int, ids: list[int]) -> Entries:
    return Entries(entries=[entry_out(store.get_entry(user_id, i)) for i in ids])


def _own_entry(store: Store, user_id: int, entry_id: int) -> dict:
    row = store.get_entry(user_id, entry_id)
    if row is None:
        raise HTTPException(404, "unknown entry")
    return row


@router.get("/diary/{day}", response_model=Day)
def get_day(day: str, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Day:
    current = parse_day(day)
    uid = user["id"]
    week_start = current - timedelta(days=6)
    rows = store.entries_between(uid, week_start.isoformat(), day)
    todays = [r for r in rows if r["day"] == day]

    meals = {meal: {"kcal": 0.0, "entries": []} for meal in MEALS}
    for row in todays:
        meals[row["meal"]]["entries"].append(entry_out(row))
    for meal in MEALS:
        meals[meal]["kcal"] = r1(sum(_scaled(r)["kcal"] or 0 for r in todays if r["meal"] == meal))

    kcal_by_day: dict[str, float] = {}
    for row in rows:
        kcal_by_day[row["day"]] = kcal_by_day.get(row["day"], 0) + (_scaled(row)["kcal"] or 0)
    week = []
    for offset in range(6, -1, -1):
        d = (current - timedelta(days=offset)).isoformat()
        week.append({"day": d, "logged": d in kcal_by_day, "kcal": r1(kcal_by_day.get(d, 0))})

    previous = (current - timedelta(days=1)).isoformat()
    yesterday = {}
    for meal in MEALS:
        before = [r for r in rows if r["day"] == previous and r["meal"] == meal]
        if before:
            yesterday[meal] = {
                "kcal": r1(sum(_scaled(r)["kcal"] or 0 for r in before)),
                "names": [r["name"] for r in before],
            }

    logged = set(store.logged_days_until(uid, day))
    streak, cursor = 0, current
    while cursor.isoformat() in logged:
        streak += 1
        cursor -= timedelta(days=1)

    goal = store.get_goal(uid)
    sums = total([_scaled(r) for r in todays])
    extra_totals = nutrients.aggregate((_scaled(r)["kcal"] or 0, _scaled_extra(r)) for r in todays)
    todays_activity = day_activities(store, uid, day, day, goal)[day]
    return Day(
        day=day,
        goal=goal,
        kcal_goal=round(activity.day_goal_kcal(goal["kcal"], {day: todays_activity.bonus_kcal}, day)) if goal else None,
        activity=todays_activity,
        water={"ml": store.get_water(uid, day), "goal_ml": (goal or {}).get("water_ml", DEFAULT_WATER_GOAL)},
        totals={k: r1(sums[k]) for k in PER_100_KEYS},
        extra_totals={
            k: {"amount": round(v["amount"], 3), "coverage": round(v["coverage"], 3)} for k, v in extra_totals.items()
        },
        meals=meals,
        yesterday=yesterday,
        streak=streak,
        week=week,
    )


@router.post("/diary/{day}/entries", response_model=Entry, status_code=201)
def add_entry(
    day: str, body: EntryIn, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Entry:
    parse_day(day)
    food = store.get_food(body.food_id, demo_view=bool(user.get("is_demo")))
    if food is None or not food["found"]:
        raise HTTPException(404, "unknown food")
    data = food["data"]
    copy = {
        "name": data.get("name") or food["code"] or "Unnamed",
        "brand": data.get("brand"),
        "unit": data.get("unit") or "g",
        "per_100": data["per_100"],
        "extra": nutrients.clean(data.get("extra")),
    }
    entry_id = store.add_entry(user["id"], day, body.meal, food["id"], body.amount, copy)
    row = store.get_entry(user["id"], entry_id)
    emit_entries(request, store, user, [row])
    return entry_out(row)


@router.post("/diary/{day}/copy", response_model=Entries, status_code=201)
def copy_entries(
    day: str, body: CopyIn, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Entries:
    """Copy the stored entries of another day (or one meal of it) to this day, snapshots and all."""
    parse_day(day)
    parse_day(body.from_day)
    if body.from_day == day and body.to_meal is None:
        raise HTTPException(422, "from_day equals day: say which meal to copy into (to_meal)")
    rows = store.entries_on(user["id"], body.from_day, body.meal)
    if not rows:
        raise HTTPException(404, "nothing to copy")
    ids = store.add_entries(user["id"], day, [snapshot(r, body.to_meal or r["meal"]) for r in rows])
    emit_entries(request, store, user, [store.get_entry(user["id"], i) for i in ids])
    return entries_out(store, user["id"], ids)


@router.patch("/diary/entries/{entry_id}", response_model=Entry)
def patch_entry(
    entry_id: int, body: EntryPatch, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Entry:
    _own_entry(store, user["id"], entry_id)
    if body.amount is None and body.meal is None:
        raise HTTPException(422, "nothing to change")
    store.update_entry(user["id"], entry_id, body.amount, body.meal)
    row = store.get_entry(user["id"], entry_id)
    emit(request, user, "entry.updated", entry_event(store, user["id"], row))
    return entry_out(row)


@router.delete("/diary/entries/{entry_id}", status_code=204)
def delete_entry(
    entry_id: int, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> None:
    row = store.get_entry(user["id"], entry_id)
    if row is None or not store.delete_entry(user["id"], entry_id):
        raise HTTPException(404, "unknown entry")
    emit(request, user, "entry.deleted", entry_event(store, user["id"], row))


@router.get("/history", response_model=list[HistoryDay])
def history(
    days: int = Query(14, ge=1, le=366), user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> list[dict]:
    last = today()
    first = last - timedelta(days=days - 1)
    by_day: dict[str, list[dict]] = {}
    for row in store.entries_between(user["id"], first.isoformat(), last.isoformat()):
        by_day.setdefault(row["day"], []).append(_scaled(row))
    result = []
    for offset in range(days):
        d = (first + timedelta(days=offset)).isoformat()
        sums = total(by_day.get(d, []))
        result.append(
            {"day": d, "logged": d in by_day, **{k: r1(sums[k]) for k in ("kcal", "protein", "carbs", "fat")}}
        )
    return result

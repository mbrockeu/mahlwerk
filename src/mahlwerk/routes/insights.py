"""Evaluation of a date range (see docs/api-v1.md)."""

import re
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import activity, analysis, food_stats, insights, review
from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..models import Insights, Review
from .diary import parse_day, today

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

MAX_DAYS = 3660  # ten years
DEFAULT_DAYS = 30
Granularity = Literal["day", "week", "month", "auto"]


def entry_span(store: Store, uid: int) -> tuple[date, date] | None:
    """First and last day with an entry of this user (one indexed aggregate query), None without any."""
    with store._connect() as con:
        row = con.execute("SELECT MIN(day) AS a, MAX(day) AS b FROM diary_entry WHERE user_id = ?", (uid,)).fetchone()
    return (date.fromisoformat(row["a"]), date.fromisoformat(row["b"])) if row and row["a"] else None


def resolve_period(
    store: Store, uid: int, from_: str | None, to: str | None, range_: str | None, max_days: int = MAX_DAYS
) -> tuple[date, date]:
    """The requested days (both included). `range=all` is first to last entry (the last 30 days without entries),
    `range=<n>` the last n days; explicit `from`/`to` win."""
    span = entry_span(store, uid) if range_ == "all" and not from_ and not to else None
    if range_ == "all" and not from_ and not to:
        last = span[1] if span else today()
        first = span[0] if span else last - timedelta(days=DEFAULT_DAYS - 1)
        first = max(first, last - timedelta(days=max_days - 1))
        return first, last
    last = parse_day(to) if to else today()
    if from_:
        first = parse_day(from_)
    elif range_ and range_.isdigit() and int(range_) > 0:
        first = last - timedelta(days=int(range_) - 1)
    else:
        first = last - timedelta(days=DEFAULT_DAYS - 1)
    if first > last:
        raise HTTPException(422, "from must not be after to")
    if (last - first).days + 1 > max_days:
        raise HTTPException(422, f"at most {max_days} days")
    return first, last


@router.get("/insights", response_model=Insights, response_model_by_alias=True)
def get_insights(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    range: str | None = Query(None, description="`all` or a number of days ending `to`"),
    granularity: Granularity = "auto",
    compare: Literal["previous"] | None = None,
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
) -> dict:
    if range is not None and range != "all" and not (range.isdigit() and int(range) > 0):
        raise HTTPException(422, "range must be 'all' or a number of days")
    uid = user["id"]
    first, last = resolve_period(store, uid, from_, to, range)
    f, t = first.isoformat(), last.isoformat()
    goal = store.get_goal(uid)
    settings = store.get_settings(uid)

    def period(a: str, b: str) -> dict:
        """What one period needs besides entries and weights: water, activity, workouts and the goal bonus per day."""
        return {"water": store.water_between(uid, a, b), "activity": store.activity_between(uid, a, b),
                "workouts": store.workouts_between(uid, a, b), "bonus": activity.goal_bonuses(store, uid, a, b, settings)}

    extra = period(f, t)
    result = insights.compute(first, last, store.entries_between(uid, f, t), store.weights_between(uid, f, t), goal,
                              extra.pop("water"), granularity=granularity, **extra)
    span = entry_span(store, uid)
    result["first_day"], result["last_day"] = (span[0].isoformat(), span[1].isoformat()) if span else (None, None)
    if compare == "previous":
        n = result["range"]["days"]
        p_last = first - timedelta(days=1)
        p_first = p_last - timedelta(days=n - 1)
        pf, pt = p_first.isoformat(), p_last.isoformat()
        before = period(pf, pt)
        prev = insights.compute(p_first, p_last, store.entries_between(uid, pf, pt), store.weights_between(uid, pf, pt),
                                goal, before.pop("water"), granularity=result["granularity"], light=True, **before)
        block, deltas = analysis.compare_blocks(result, prev)
        block["series"] = prev["series"]
        result["previous"], result["deltas"] = block, deltas
    return result


@router.get("/insights/nutrient")
def get_nutrient(
    key: str,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    granularity: Granularity = "auto",
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
) -> dict:
    info = analysis.nutrient_info(key)
    if info is None:
        raise HTTPException(422, "unknown nutrient key")
    uid = user["id"]
    first, last = resolve_period(store, uid, from_, to, None)
    rows = store.entries_between(uid, first.isoformat(), last.isoformat())
    resolved = analysis.resolve_granularity(granularity, (last - first).days + 1)
    goal = store.get_goal(uid)
    curve = analysis.nutrient_series(rows, key, first, last, resolved)
    logged = len({r["day"] for r in rows})
    known = [s for s in curve["series"] if s["average"] is not None and s["coverage"] > 0]
    return {
        "key": key, "group": info["group"], "unit": info["unit"], "nrv": info["nrv"],
        "goal": goal[key] if goal and key in analysis.CORE_GOAL else None,
        "range": {"from": first.isoformat(), "to": last.isoformat(), "days": (last - first).days + 1, "logged_days": logged},
        "granularity": resolved,
        "series": curve["series"],
        "has_data": bool(known),
    }


@router.get("/insights/foods")
def get_foods(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    q: str = "",
    sort: Literal["kcal", "times", "amount", "last", "name"] = "kcal",
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
) -> dict:
    uid = user["id"]
    first, last = resolve_period(store, uid, from_, to, None)
    rows = store.entries_between(uid, first.isoformat(), last.isoformat())
    return {"range": {"from": first.isoformat(), "to": last.isoformat()}, **food_stats.foods_list(rows, q, sort, limit, offset)}


@router.get("/insights/foods/detail")
def get_food_detail(
    key: str,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
) -> dict:
    uid = user["id"]
    first, last = resolve_period(store, uid, from_, to, None)
    rows = store.entries_between(uid, first.isoformat(), last.isoformat())
    detail = food_stats.food_detail(rows, key, first, last)
    if detail is None:
        raise HTTPException(404, "no entries of this food in the period")
    return {"range": {"from": first.isoformat(), "to": last.isoformat()}, **detail}


_WEEK = re.compile(r"^(\d{4})-W(\d{2})$")


def parse_week(week: str) -> date:
    """'2026-W02' -> the Monday of that ISO week."""
    match = _WEEK.match(week)
    try:
        if match:
            return date.fromisocalendar(int(match.group(1)), int(match.group(2)), 1)
    except ValueError:
        pass
    raise HTTPException(422, "week must look like 2026-W07")


@router.get("/review", response_model=Review, response_model_by_alias=True)
def get_review(
    week: str | None = None, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> dict:
    monday = parse_week(week) if week else review.week_start(today()) - timedelta(days=7)
    sunday = monday + timedelta(days=6)
    uid = user["id"]
    rows = store.entries_between(uid, (monday - timedelta(days=7)).isoformat(), sunday.isoformat())
    codes: list[str] = []
    if store.get_settings(uid).get("playful", True):
        for b in store.badges_earned(uid):
            if monday <= datetime.fromtimestamp(b["earned_at"]).date() <= sunday:
                codes.append(b["code"])
    bonus = activity.goal_bonuses(store, uid, (monday - timedelta(days=7)).isoformat(), sunday.isoformat())
    return review.compute(monday, rows, store.get_goal(uid), codes, bonus)

"""Long-range analysis on top of the daily totals: series per day/week/month, comparison with the period before,
calendar states, nutrient curves and the estimated real energy expenditure.

Everything here is a pure function of data already loaded (one query per request), see docs/api-v1.md (Insights).
"""

import calendar as _calendar
from datetime import date, timedelta

from . import nutrients
from .activity import day_goal_kcal
from .nutrition import scale

GRANULARITIES = ("day", "week", "month")
DAY_LIMIT = 45  # auto: single days up to this many days
WEEK_LIMIT = 370  # auto: weeks up to this many days, months beyond
DETAIL_DAYS = 370  # `days` and `calendar` are only delivered up to this many days
SERIES_KEYS = ("kcal", "protein", "carbs", "fat", "sugars", "fiber", "salt", "saturated_fat")
RANGE_LOW, RANGE_HIGH, EPS = 0.9, 1.1, 1e-9  # same 90-110 % band as insights.adherence_class

# Expenditure estimate: thresholds and constants (see estimate_expenditure)
KCAL_PER_KG = 7700.0
EXP_MIN_DAYS = 21
EXP_MIN_LOGGED_SHARE = 0.70
EXP_MIN_WEIGHTS = 6
EXP_MIN_WEIGHT_SPREAD = 14
EXP_MIN_MARGIN = 0.10


def _r(value: float, digits: int = 1) -> float:
    return round(value + 0.0, digits)


def _mean(values) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def adherence_class(kcal: float, goal_kcal: float) -> str:
    if kcal > goal_kcal * RANGE_HIGH + EPS:
        return "over"
    if kcal < goal_kcal * RANGE_LOW - EPS:
        return "under"
    return "in"


# buckets ------------------------------------------------------------------------------------------------------


def resolve_granularity(granularity: str, n_days: int) -> str:
    """`auto` picks days up to 45 days, weeks up to 370 days, otherwise months; explicit values are kept."""
    if granularity in GRANULARITIES:
        return granularity
    if n_days <= DAY_LIMIT:
        return "day"
    return "week" if n_days <= WEEK_LIMIT else "month"


def buckets(first: date, last: date, granularity: str) -> list[tuple[date, date, str]]:
    """Sections (start, end, label_key) covering `first`..`last`, clipped to it.

    Weeks are ISO weeks (Monday to Sunday, label `2026-W07` with the ISO year), months are calendar months
    (label `2026-02`), days are single days (label the date). The first and last section may be partial.
    """
    out: list[tuple[date, date, str]] = []
    if granularity == "day":
        d = first
        while d <= last:
            out.append((d, d, d.isoformat()))
            d += timedelta(days=1)
    elif granularity == "week":
        monday = first - timedelta(days=first.weekday())
        while monday <= last:
            year, week, _ = monday.isocalendar()
            out.append((max(monday, first), min(monday + timedelta(days=6), last), f"{year}-W{week:02d}"))
            monday += timedelta(days=7)
    else:
        year, month = first.year, first.month
        while date(year, month, 1) <= last:
            month_end = date(year, month, _calendar.monthrange(year, month)[1])
            out.append((max(date(year, month, 1), first), min(month_end, last), f"{year}-{month:02d}"))
            year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


def month_keys(first: date, last: date) -> list[str]:
    return [label for _, _, label in buckets(first, last, "month")]


def build_series(
    first: date, last: date, granularity: str, totals: dict, logged: set, water: dict, weight_by_day: dict, goal: dict | None,
    bonus: dict | None = None, activity: dict | None = None, workout_minutes: dict | None = None,
) -> list[dict]:
    """One item per section: means per logged day (nutrients), per day with a value (water, weight, steps, active
    energy), the workout minutes, the mean goal and the adherence counts. `bonus` is the per-day addition to the
    calorie goal (see activity.goal_bonuses), `activity` the activity rows by day."""
    activity, workout_minutes = activity or {}, workout_minutes or {}
    result = []
    for start, end, label in buckets(first, last, granularity):
        days = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
        got = [d for d in days if d in logged]
        item = {"start": start.isoformat(), "end": end.isoformat(), "label_key": label, "logged_days": len(got),
                "days": len(days)}
        for key in SERIES_KEYS:
            item[key] = _r(_mean(totals[d][key] for d in got))
        waters = [water[d] for d in days if d in water]
        weights = [weight_by_day[d] for d in days if d in weight_by_day]
        item["water_ml"] = round(_mean(waters)) if waters else None
        item["weight"] = _r(_mean(weights), 2) if weights else None
        steps = [activity[d]["steps"] for d in days if d in activity and activity[d]["steps"] is not None]
        energy = [activity[d]["active_kcal"] for d in days if d in activity and activity[d]["active_kcal"] is not None]
        item["steps"] = round(_mean(steps)) if steps else None
        item["active_kcal"] = round(_mean(energy)) if energy else None
        item["workout_minutes"] = _r(sum(workout_minutes.get(d, 0) for d in days))
        item["goal_kcal"] = _r(_mean(day_goal_kcal(goal["kcal"], bonus, d) for d in got)) if goal and got else (
            goal["kcal"] if goal else None)
        counts = {"in": 0, "over": 0, "under": 0}
        if goal:
            for d in got:
                counts[adherence_class(totals[d]["kcal"], day_goal_kcal(goal["kcal"], bonus, d))] += 1
        item.update(in_range_days=counts["in"], over_days=counts["over"], under_days=counts["under"])
        result.append(item)
    return result


def build_calendar(day_keys: list[str], totals: dict, logged: set, goal: dict | None, bonus: dict | None = None) -> list[dict]:
    """State per day for a heat map: none (nothing logged), no_goal, under, in_range or over."""
    out = []
    for d in day_keys:
        if d not in logged:
            state = "none"
        elif not goal:
            state = "no_goal"
        else:
            state = {"in": "in_range", "over": "over", "under": "under"}[adherence_class(totals[d]["kcal"], day_goal_kcal(goal["kcal"], bonus, d))]
        out.append({"day": d, "state": state})
    return out


# comparison ---------------------------------------------------------------------------------------------------


def delta(current: float | None, previous: float | None) -> dict | None:
    """Absolute and percentage difference; the percentage is null when the earlier value is 0."""
    if current is None or previous is None:
        return None
    diff = current - previous
    return {"abs": _r(diff, 2), "pct": _r(diff / previous * 100, 1) if previous else None}


def compare_blocks(current: dict, previous: dict) -> tuple[dict, dict | None]:
    """`previous` block and `deltas` from two light results of `insights.compute`.

    deltas is null when the earlier period has no logged day (nothing to compare with). `weight_change` is the
    difference of the weight changes inside the two periods, `in_range_share` the difference in percentage points
    of the days within the goal range.
    """
    block = {
        "range": previous["range"],
        "averages": previous["averages"],
        "adherence": previous["adherence"],
        "weight": previous["weight"],
        "logged_days": previous["range"]["logged_days"],
    }
    if previous["range"]["logged_days"] == 0 or current["range"]["logged_days"] == 0:
        return block, None

    def share(res: dict) -> float | None:
        adh, n = res["adherence"], res["range"]["logged_days"]
        return adh["in_range_days"] / n * 100 if adh and n else None

    cur_a, prev_a = current["averages"], previous["averages"]
    deltas = {
        k: delta(cur_a[k], prev_a[k])
        for k in ("kcal", "protein", "carbs", "fat", "sugars", "fiber", "salt", "water_ml", "steps", "active_kcal", "workout_minutes")
    }
    cw, pw = current["weight"], previous["weight"]
    deltas["weight_change"] = delta(cw["change"], pw["change"]) if cw and pw else None
    cs, ps = share(current), share(previous)
    deltas["in_range_share"] = None if cs is None or ps is None else {"abs": _r(cs - ps, 1), "pct": None}
    return block, deltas


# expenditure --------------------------------------------------------------------------------------------------


def estimate_expenditure(
    n_days: int, logged_days: int, intake: float, weights: list[tuple[int, float]], goal_kcal: float | None = None
) -> tuple[dict | None, list[str]]:
    """Estimated real daily energy expenditure from mean intake and the weight trend.

    kcal = intake - slope * 7700, where `slope` (kg per day) is the least-squares line through the weight
    measurements `weights` = [(day offset, kg)] - not first against last value, which one wet day could swing.
    7700 kcal per kg of body mass is the usual rule of thumb. A falling weight (negative slope) means the body
    burned more than was eaten, so the expenditure lies above the intake.

    Needed: at least 21 days, 70 % of them logged, 6 weights spread over at least 14 days; otherwise the result is
    None and the second value lists the missing prerequisites (`short_period`, `few_logged_days`, `few_weights`,
    `weights_not_spread`).

    Range: half-width is the larger of 2 standard errors of the slope (about 95 %, converted to kcal) and 10 % of
    the estimate. The regression term catches a noisy weight curve (water balance), the 10 % floor covers what it
    cannot see: diaries are rarely complete and a few-week slope is never exact, so a spread narrower than 10 % would
    claim too much. `goal_gap` = goal - estimate (negative: the goal lies below the estimated expenditure).
    """
    missing = []
    if n_days < EXP_MIN_DAYS:
        missing.append("short_period")
    if n_days and logged_days / n_days < EXP_MIN_LOGGED_SHARE:
        missing.append("few_logged_days")
    if len(weights) < EXP_MIN_WEIGHTS:
        missing.append("few_weights")
    if len(weights) < 2 or max(x for x, _ in weights) - min(x for x, _ in weights) < EXP_MIN_WEIGHT_SPREAD:
        missing.append("weights_not_spread")
    if missing:
        return None, missing
    n = len(weights)
    mx, my = sum(x for x, _ in weights) / n, sum(y for _, y in weights) / n
    sxx = sum((x - mx) ** 2 for x, _ in weights)
    slope = sum((x - mx) * (y - my) for x, y in weights) / sxx
    intercept = my - slope * mx
    resid = sum((y - (intercept + slope * x)) ** 2 for x, y in weights)
    se = (resid / (n - 2) / sxx) ** 0.5 if n > 2 else 0.0
    kcal = intake - slope * KCAL_PER_KG
    half = max(2 * se * KCAL_PER_KG, EXP_MIN_MARGIN * abs(kcal))
    return {
        "kcal": round(kcal),
        "low": round(kcal - half),
        "high": round(kcal + half),
        "intake": round(intake),
        "weight_change_kg": _r(slope * n_days, 2),
        "kg_per_week": _r(slope * 7, 2),
        "days": n_days,
        "weigh_ins": n,
        "goal_gap": round(goal_kcal - kcal) if goal_kcal else None,
    }, []


# nutrient curve -----------------------------------------------------------------------------------------------

CORE_UNITS = {"kcal": "kcal", "protein": "g", "carbs": "g", "fat": "g", "sugars": "g", "fiber": "g", "salt": "g",
              "saturated_fat": "g"}
CORE_GOAL = ("kcal", "protein", "carbs", "fat")


def nutrient_info(key: str) -> dict | None:
    """{unit, nrv, group} of a core value or a directory nutrient; None for an unknown key."""
    if key in CORE_UNITS:
        return {"unit": CORE_UNITS[key], "nrv": None, "group": "core"}
    info = nutrients.BY_KEY.get(key)
    return {"unit": info.unit, "nrv": info.nrv, "group": info.group} if info else None


def nutrient_series(rows: list[dict], key: str, first: date, last: date, granularity: str) -> dict:
    """Curve of one nutrient: per section the mean per logged day and the coverage.

    As in `micros`, a missing value is not a zero: the mean divides by the logged days of the section and
    `coverage` (0..1) is the share of the section's kcal from entries that state the nutrient (1 for kcal itself;
    the share of entries when the section has no kcal). `average` is null for a section without logged days.
    """
    core = key in CORE_UNITS
    per_day: dict[str, list[float]] = {}  # day -> [sum, kcal, known_kcal, entries, known_entries]
    for row in rows:
        values = scale(row["per_100"], row["amount"])
        kcal = values["kcal"] or 0.0
        if core:
            value = values[key]
        else:
            extra = row.get("extra") or {}
            value = extra[key] * row["amount"] / 100 if key in extra else None
        slot = per_day.setdefault(row["day"], [0.0, 0.0, 0.0, 0, 0])
        slot[1] += kcal
        slot[3] += 1
        if value is not None:
            slot[0] += value
            slot[2] += kcal
            slot[4] += 1
    series = []
    for start, end, _ in buckets(first, last, granularity):
        days = [per_day[d] for i in range((end - start).days + 1) if (d := (start + timedelta(days=i)).isoformat()) in per_day]
        total = sum(s[0] for s in days)
        kcal, known = sum(s[1] for s in days), sum(s[2] for s in days)
        n, n_known = sum(s[3] for s in days), sum(s[4] for s in days)
        coverage = (known / kcal if kcal > 0 else n_known / n if n else 0.0)
        series.append({
            "start": start.isoformat(), "end": end.isoformat(),
            "average": _r(total / len(days), 3) if days else None,
            "coverage": round(min(1.0, coverage), 3),
        })
    return {"series": series}

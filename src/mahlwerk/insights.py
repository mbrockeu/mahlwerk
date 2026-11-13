"""Evaluation of a date range: totals, averages, distributions, top foods, weight trend and hints.

Everything here is a pure function of the entries, weights and goal passed in, so it is easy to test.
See docs/api-v1.md (GET /api/v1/insights) for the response shape.
"""

from datetime import date, timedelta

from . import analysis, nutrients
from .activity import DEFAULT_STEPS_GOAL, day_goal_kcal
from .models import MEALS
from .nutrition import scale

NUTRIENTS = ("kcal", "protein", "carbs", "fat", "sugars", "fiber", "salt", "saturated_fat")
TOP_METRICS = ("kcal", "sugars", "salt", "protein")
TRACKED = TOP_METRICS + ("fiber",)  # fibre is tracked per food for the hint, but not exposed as a list
TOP_N = 8
# "within the goal" = 90 % to 110 % of the calorie goal (inclusive)
RANGE_LOW, RANGE_HIGH = 0.9, 1.1
EPS = 1e-9
MIN_LOGGED_DAYS = 7
MAX_HINTS = 4
TREND_HALF_WINDOW = 3  # centred 7-day window


def _r(value: float, digits: int = 1) -> float:
    return round(value + 0.0, digits)  # "+ 0.0" turns -0.0 into 0.0


_mean = analysis._mean

adherence_class = analysis.adherence_class  # 'in', 'over' or 'under' for one logged day (90-110 % of the goal)


def compute(
    first: date, last: date, rows: list[dict], weights: list[dict], goal: dict | None, water: dict[str, int] | None = None,
    *, granularity: str = "auto", light: bool = False, activity: dict[str, dict] | None = None,
    workouts: list[dict] | None = None, bonus: dict[str, int] | None = None,
) -> dict:
    """Build the whole response for the days `first`..`last` (both included).

    `light` leaves out everything that is only needed for the main period (foods, micros, hints, series, calendar);
    it is used for the period before when comparing.

    `activity` holds the activity rows by day, `workouts` the workouts of the range and `bonus` the kcal that the active
    energy adds to a day's calorie goal (`activity.goal_bonuses`, empty while that setting is off). Every judgement
    against the goal (adherence, calendar, series counts, the expenditure's gap) uses `day_goal_kcal`; the estimate of
    the expenditure itself is unchanged, it measures the total.
    """
    n_days = (last - first).days + 1
    day_keys = [(first + timedelta(days=i)).isoformat() for i in range(n_days)]
    key_set = set(day_keys)
    weights = [w for w in weights if w["day"] in key_set]
    weight_by_day = {w["day"]: w["kg"] for w in weights}
    water = {d: ml for d, ml in (water or {}).items() if d in key_set}
    activity = {d: a for d, a in (activity or {}).items() if d in key_set}
    workout_minutes: dict[str, float] = {}
    for w in workouts or []:
        if w["day"] in key_set:
            workout_minutes[w["day"]] = workout_minutes.get(w["day"], 0.0) + w["minutes"]
    bonus = bonus or {}

    totals = {d: dict.fromkeys(NUTRIENTS, 0.0) for d in day_keys}
    logged: set[str] = set()
    meal_kcal = dict.fromkeys(MEALS, 0.0)
    foods: dict[str, dict[tuple, dict]] = {m: {} for m in TRACKED}
    grand = dict.fromkeys(TRACKED, 0.0)
    micro_parts = []  # (kcal, scaled extra nutrients) per entry, collected in the same pass

    for row in rows:
        day = row["day"]
        if day not in totals:
            continue
        values = {k: v or 0.0 for k, v in scale(row["per_100"], row["amount"]).items()}
        logged.add(day)
        for key in NUTRIENTS:
            totals[day][key] += values[key]
        meal_kcal[row["meal"]] += values["kcal"]
        if light:
            continue
        micro_parts.append((values["kcal"], nutrients.scale_extra(row["extra"], row["amount"]) if row.get("extra") else {}))
        ident = ("id", row["food_id"]) if row["food_id"] is not None else ("name", row["name"], row["brand"])
        for metric in TRACKED:
            grand[metric] += values[metric]
            slot = foods[metric].setdefault(
                ident, {"name": row["name"], "brand": row["brand"], "amount_total": 0.0, "value": 0.0, "times": 0}
            )
            slot["amount_total"] += row["amount"]
            slot["value"] += values[metric]
            slot["times"] += 1

    logged_days = [d for d in day_keys if d in logged]
    micros = [] if light else micro_from_parts(micro_parts, len(logged_days))
    n_logged = len(logged_days)
    averages = {k: _r(_mean([totals[d][k] for d in logged_days])) for k in NUTRIENTS}
    averages["water_ml"] = _r(_mean(list(water.values())), 0)
    averages["steps"] = _r(_mean([a["steps"] for a in activity.values() if a["steps"] is not None]), 0)
    averages["active_kcal"] = _r(_mean([a["active_kcal"] for a in activity.values() if a["active_kcal"] is not None]), 0)
    averages["workout_minutes"] = _r(sum(workout_minutes.values()) / n_days if n_days else 0.0)

    by_weekday = []
    for wd in range(7):
        vals = [totals[d]["kcal"] for d in logged_days if date.fromisoformat(d).weekday() == wd]
        by_weekday.append({"weekday": wd, "logged_days": len(vals), "kcal": _r(_mean(vals))})

    meal_mean = {m: meal_kcal[m] / n_logged if n_logged else 0.0 for m in MEALS}
    meal_sum = sum(meal_mean.values())
    by_meal = [
        {"meal": m, "kcal": _r(meal_mean[m]), "share": round(meal_mean[m] / meal_sum, 3) if meal_sum else 0.0}
        for m in MEALS
    ]

    top_foods: dict[str, list[dict]] = {}
    for metric in TOP_METRICS:
        ranked = sorted((s for s in foods[metric].values() if s["value"] > 0), key=lambda s: -s["value"])
        top_foods[metric] = [
            {
                "name": s["name"],
                "brand": s["brand"],
                "amount_total": _r(s["amount_total"]),
                "value": _r(s["value"]),
                "share": round(s["value"] / grand[metric], 3) if grand[metric] else 0.0,
                "times": s["times"],
            }
            for s in ranked[:TOP_N]
        ]

    adherence = None
    if goal:
        counts = {"in": 0, "over": 0, "under": 0}
        for d in logged_days:
            counts[adherence_class(totals[d]["kcal"], day_goal_kcal(goal["kcal"], bonus, d))] += 1
        adherence = {"in_range_days": counts["in"], "over_days": counts["over"], "under_days": counts["under"]}

    weight = weight_summary(weights)
    # the goal that counts, as a mean over the days with entries (the plain goal unless active energy is added)
    goal_kcal = (
        _r(_mean([day_goal_kcal(goal["kcal"], bonus, d) for d in logged_days]) if logged_days else goal["kcal"]) if goal else None
    )
    resolved = analysis.resolve_granularity(granularity, n_days)
    expenditure, missing = analysis.estimate_expenditure(
        n_days, n_logged, averages["kcal"],
        [((date.fromisoformat(w["day"]) - first).days, w["kg"]) for w in weights], goal_kcal,
    )
    result = {
        "range": {"from": first.isoformat(), "to": last.isoformat(), "days": n_days, "logged_days": n_logged},
        "goal": goal,
        "goal_kcal": goal_kcal,
        "steps_goal": (goal or {}).get("steps", DEFAULT_STEPS_GOAL),
        "averages": averages,
        "weight": weight,
        "adherence": adherence,
        "expenditure": expenditure,
        "expenditure_missing": missing,
        "granularity": resolved,
        "series": analysis.build_series(first, last, resolved, totals, logged, water, weight_by_day, goal, bonus, activity, workout_minutes),
    }
    if light:
        return result
    ctx = Context(
        logged_days=logged_days, totals=totals, averages=averages, goal=goal, by_meal=by_meal,
        adherence=adherence, foods=foods, grand=grand,
    )
    detailed = n_days <= analysis.DETAIL_DAYS  # beyond this the per-day lists would only bloat the response
    return {
        **result,
        "days": [
            {"day": d, "logged": d in logged, **{k: _r(totals[d][k]) for k in NUTRIENTS}, "weight": weight_by_day.get(d),
             "water_ml": water.get(d), "steps": activity[d]["steps"] if d in activity else None,
             "active_kcal": activity[d]["active_kcal"] if d in activity else None,
             "workout_minutes": _r(workout_minutes.get(d, 0.0)),
             "goal_kcal": day_goal_kcal(goal["kcal"], bonus, d) if goal else None}
            for d in day_keys
        ] if detailed else [],
        "calendar": analysis.build_calendar(day_keys, totals, logged, goal, bonus) if detailed else [],
        "by_weekday": by_weekday,
        "by_meal": by_meal,
        "top_foods": top_foods,
        "micros": micros,
        "hints": hints(ctx),
    }


def micro_from_parts(parts: list[tuple[float, dict]], n_logged: int) -> list[dict]:
    """Vitamins, minerals and other additional nutrients: mean per day with entries and how well they are known.

    `parts` are (kcal, scaled extra nutrients) per entry. The mean divides by ALL days with entries, also those where
    the nutrient is unknown, because a missing value is not a zero but does not add anything either: the figure is
    therefore rather too low, and `coverage` (share of the period's kcal from entries that state the nutrient) says
    by how much to trust it. Most covered first; nutrients no entry states are left out. There are no hints on
    these values, the data is too thin for that.
    """
    found = nutrients.aggregate(parts)
    result = []
    for key, v in found.items():
        info = nutrients.BY_KEY[key]
        average = v["amount"] / n_logged if n_logged else 0.0
        result.append({
            "key": key, "group": info.group, "unit": info.unit, "nrv": info.nrv,
            "average": _r(average, 3), "coverage": round(v["coverage"], 3),
            "percent_nrv": _r(average / info.nrv * 100, 1) if info.nrv else None,
        })
    result.sort(key=lambda m: -m["coverage"])  # stable: ties keep the directory order
    return [m for m in result if m["coverage"] > 0]


def weight_summary(weights: list[dict]) -> dict | None:
    """First, last and change of the raw values plus a smoothed trend; null without any weight.

    `trend` has one point per weight day (mean of the values within 3 days around it, a sliding window over the sorted
    values, so it stays fast with years of data); `raw` repeats the measured values for clients that have no
    per-day list (long periods).
    """
    if not weights:
        return None
    points = sorted(weights, key=lambda w: w["day"])
    ords = [date.fromisoformat(w["day"]).toordinal() for w in points]
    kgs = [w["kg"] for w in points]
    trend = []
    lo = hi = 0  # window [lo, hi) of the points within TREND_HALF_WINDOW days
    running = 0.0
    for i, o in enumerate(ords):
        while hi < len(ords) and ords[hi] <= o + TREND_HALF_WINDOW:
            running += kgs[hi]
            hi += 1
        while ords[lo] < o - TREND_HALF_WINDOW:
            running -= kgs[lo]
            lo += 1
        trend.append({"day": points[i]["day"], "kg": _r(running / (hi - lo), 2)})
    return {
        "first": kgs[0],
        "last": kgs[-1],
        "change": _r(kgs[-1] - kgs[0], 2),
        "trend": trend,
        "raw": [{"day": w["day"], "kg": w["kg"]} for w in points],
    }


# hints ---------------------------------------------------------------------------------------------------------


class Context:
    """What the hint rules look at."""

    def __init__(self, **kw):
        self.__dict__.update(kw)

    def top_names(self, metric: str, n: int) -> list[str]:
        ranked = sorted((s for s in self.foods[metric].values() if s["value"] > 0), key=lambda s: -s["value"])
        return [s["name"] for s in ranked[:n]]


def hint_low_protein(c: Context) -> dict | None:
    """Protein averages below 80 % of the protein goal. Why: a steady shortfall is worth knowing about."""
    if not c.goal or c.goal["protein"] <= 0:
        return None
    avg, goal = c.averages["protein"], c.goal["protein"]
    if avg < 0.8 * goal:
        return {"code": "low_protein", "params": {"avg": _r(avg, 0), "goal": _r(goal, 0), "pct": round(avg / goal * 100)}}
    return None


def hint_low_fiber(c: Context) -> dict | None:
    """Fibre averages below 25 g a day (common adult recommendation: at least 30 g, 25 g is the lenient floor).
    Names the two foods that supplied the most fibre in the period."""
    if c.averages["fiber"] < 25:
        return {"code": "low_fiber", "params": {"avg": _r(c.averages["fiber"], 0), "top": c.top_names("fiber", 2)}}
    return None


def hint_high_sugar(c: Context) -> dict | None:
    """Sugars average above 50 g a day (about 10 % of 2000 kcal, the WHO ceiling for free sugars).
    Names the biggest sugar supplier."""
    if c.averages["sugars"] > 50:
        top = c.top_names("sugars", 1)
        return {"code": "high_sugar", "params": {"avg": _r(c.averages["sugars"], 0), "top": top[0] if top else None}}
    return None


def hint_high_salt(c: Context) -> dict | None:
    """Salt averages above 6 g a day (the usual upper recommendation for adults)."""
    if c.averages["salt"] > 6:
        return {"code": "high_salt", "params": {"avg": _r(c.averages["salt"], 1)}}
    return None


def hint_weekend_higher(c: Context) -> dict | None:
    """Saturday and Sunday average more than 15 % above Monday to Friday. Needs at least two weekend days and
    three weekdays with entries, otherwise one odd day would decide."""
    weekend, workdays = [], []
    for d in c.logged_days:
        (weekend if date.fromisoformat(d).weekday() >= 5 else workdays).append(c.totals[d]["kcal"])
    if len(weekend) < 2 or len(workdays) < 3:
        return None
    w_avg, d_avg = _mean(weekend), _mean(workdays)
    if d_avg > 0 and w_avg > d_avg * 1.15:
        return {"code": "weekend_higher", "params": {"weekend": round(w_avg), "weekday": round(d_avg), "pct": round((w_avg / d_avg - 1) * 100)}}
    return None


def hint_meal_dominant(c: Context) -> dict | None:
    """One meal makes up more than 45 % of the day's calories (on average). Why: a very uneven spread."""
    top = max(c.by_meal, key=lambda m: m["share"])
    if top["share"] > 0.45:
        return {"code": "meal_dominant", "params": {"meal": top["meal"], "pct": round(top["share"] * 100), "kcal": round(top["kcal"])}}
    return None


def hint_protein_goal_met(c: Context) -> dict | None:
    """Positive: the protein goal was reached on at least 70 % of the days with entries."""
    if not c.goal or c.goal["protein"] <= 0 or not c.logged_days:
        return None
    hit = sum(1 for d in c.logged_days if c.totals[d]["protein"] >= c.goal["protein"] - EPS)
    pct = hit / len(c.logged_days)
    if pct >= 0.7:
        return {"code": "protein_goal_met", "params": {"days": hit, "of": len(c.logged_days), "pct": round(pct * 100)}}
    return None


def hint_in_range(c: Context) -> dict | None:
    """Positive: at least 70 % of the days with entries were within 90-110 % of the calorie goal."""
    if not c.adherence or not c.logged_days:
        return None
    hit, total = c.adherence["in_range_days"], len(c.logged_days)
    if hit / total >= 0.7:
        return {"code": "in_range", "params": {"days": hit, "of": total, "pct": round(hit / total * 100)}}
    return None


# order = importance: things to look at first, then the positive notes
RULES = (
    hint_low_protein, hint_low_fiber, hint_high_sugar, hint_high_salt, hint_weekend_higher, hint_meal_dominant,
    hint_in_range, hint_protein_goal_met,
)


def hints(c: Context) -> list[dict]:
    """At most four hints, most important first; a single `few_days` below seven days with entries."""
    if len(c.logged_days) < MIN_LOGGED_DAYS:
        return [{"code": "few_days", "params": {"logged_days": len(c.logged_days), "min": MIN_LOGGED_DAYS}}]
    found = [h for rule in RULES if (h := rule(c))]
    return found[:MAX_HINTS]

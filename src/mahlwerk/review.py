"""Weekly review: one strength and at most one thing to improve for a calendar week (Monday to Sunday).

A pure function of the entries of that week and the week before, plus the goal. Reuses the 90-110 % rule
(`insights.adherence_class`). See docs/api-v1.md (GET /api/v1/review).

Choice of the strength: the candidates are checked in a fixed order and the first match wins (all seven days,
then days in range, protein days, fibre, more days than last week). The order goes from "most about the habit" to
"most about the plate"; it is not a ranking of worth, any of them is a fine thing to hear.
Choice of the improvement: also in a fixed order, the first match wins; at most one is ever shown.
"""

from datetime import date, timedelta

from .activity import day_goal_kcal
from .analysis import _mean
from .insights import EPS, adherence_class
from .nutrition import scale

QUIET_BELOW = 2  # fewer logged days: no verdict, only "quiet_week"
FEW_DAYS = 4
IN_RANGE_DAYS = 5
PROTEIN_DAYS = 5
FIBER_STRONG = 30.0
FIBER_WEAK = 20.0
PROTEIN_WEAK = 0.8
WEEKEND_OVER = 1.2


def week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def week_label(monday: date) -> str:
    iso = monday.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _totals(rows: list[dict], first: date) -> dict[str, dict]:
    """Per logged day of the week starting at `first`: kcal, protein, fiber."""
    last = (first + timedelta(days=6)).isoformat()
    out: dict[str, dict] = {}
    for row in rows:
        if not first.isoformat() <= row["day"] <= last:
            continue
        values = scale(row["per_100"], row["amount"])
        day = out.setdefault(row["day"], {"kcal": 0.0, "protein": 0.0, "fiber": 0.0})
        for key in day:
            day[key] += values[key] or 0.0
    return out


def compute(monday: date, rows: list[dict], goal: dict | None, badge_codes: list[str], bonus: dict[str, int] | None = None) -> dict:
    """`rows` hold the entries of this week and of the week before; `badge_codes` the badges reached this week;
    `bonus` the kcal the active energy adds to a day's goal (`activity.goal_bonuses`, empty when that is off)."""
    this = _totals(rows, monday)
    before = _totals(rows, monday - timedelta(days=7))
    logged = sorted(this)
    n = len(logged)
    avg = {k: _mean([this[d][k] for d in logged]) for k in ("kcal", "protein", "fiber")}
    days = []
    for i in range(7):
        iso = (monday + timedelta(days=i)).isoformat()
        state = adherence_class(this[iso]["kcal"], day_goal_kcal(goal["kcal"], bonus, iso)) if goal and iso in this else None
        days.append({"day": iso, "logged": iso in this, "kcal": round(this[iso]["kcal"]) if iso in this else 0, "state": state})
    result = {
        "week": week_label(monday),
        "from": monday.isoformat(),
        "to": (monday + timedelta(days=6)).isoformat(),
        "logged_days": n,
        "kcal_avg": round(avg["kcal"]),
        "goal": goal,
        "days": days,
        "best": None,
        "improve": None,
        "badges": badge_codes,
    }
    if n < QUIET_BELOW:
        result["badges"] = ["quiet_week", *badge_codes]
        return result
    result["best"] = best(this, before, avg, goal, bonus)
    result["improve"] = improve(this, avg, goal)
    return result


def best(this: dict, before: dict, avg: dict, goal: dict | None, bonus: dict[str, int] | None = None) -> dict | None:
    n = len(this)
    if n == 7:
        return {"code": "all_days", "params": {"days": 7}}
    if goal:
        hit = sum(1 for d, v in this.items() if adherence_class(v["kcal"], day_goal_kcal(goal["kcal"], bonus, d)) == "in")
        if hit >= IN_RANGE_DAYS:
            return {"code": "in_range_days", "params": {"days": hit, "of": n}}
        if goal["protein"] > 0:
            hit = sum(1 for v in this.values() if v["protein"] >= goal["protein"] * 0.9 - EPS)
            if hit >= PROTEIN_DAYS:
                return {"code": "protein_days", "params": {"days": hit, "of": n}}
    if avg["fiber"] >= FIBER_STRONG:
        return {"code": "fiber_avg", "params": {"avg": round(avg["fiber"])}}
    if n > len(before) >= 1:
        return {"code": "more_days", "params": {"days": n, "before": len(before)}}
    return None


def improve(this: dict, avg: dict, goal: dict | None) -> dict | None:
    n = len(this)
    if n < FEW_DAYS:
        return {"code": "few_days", "params": {"days": n}}
    if goal and goal["protein"] > 0 and avg["protein"] < goal["protein"] * PROTEIN_WEAK:
        return {"code": "low_protein", "params": {
            "avg": round(avg["protein"]), "goal": round(goal["protein"]), "pct": round(avg["protein"] / goal["protein"] * 100)}}
    if avg["fiber"] < FIBER_WEAK:
        return {"code": "low_fiber", "params": {"avg": round(avg["fiber"])}}
    weekend = [v["kcal"] for d, v in this.items() if date.fromisoformat(d).weekday() >= 5]
    workdays = [v["kcal"] for d, v in this.items() if date.fromisoformat(d).weekday() < 5]
    if weekend and len(workdays) >= 2 and _mean(workdays) > 0 and _mean(weekend) > _mean(workdays) * WEEKEND_OVER:
        return {"code": "weekend_higher", "params": {
            "weekend": round(_mean(weekend)), "weekday": round(_mean(workdays)),
            "pct": round((_mean(weekend) / _mean(workdays) - 1) * 100)}}
    return None

"""Foods eaten in a period: list with totals per food, and the detail of one food.

Foods are grouped like `top_foods`: by `food_id`, entries whose food was deleted by name + brand. The group key
is `id:<food_id>` or `n:<hash of name and brand>` and is stable for the same data.
"""

import hashlib
from datetime import date

from . import analysis
from .models import MEALS
from .nutrition import scale

SORTS = ("kcal", "times", "amount", "last", "name")


def group_key(row: dict) -> str:
    if row["food_id"] is not None:
        return f"id:{row['food_id']}"
    digest = hashlib.sha1(f"{row['name']}\x00{row['brand'] or ''}".encode()).hexdigest()[:16]
    return f"n:{digest}"


def _kcal(row: dict) -> float:
    return scale(row["per_100"], row["amount"])["kcal"] or 0.0


def foods_list(rows: list[dict], q: str, sort: str, limit: int, offset: int) -> dict:
    """Grouped foods, filtered by a case-insensitive search in name and brand, sorted, one page.

    `share` is the part of the whole period's kcal (also of foods the search leaves out). Ties are broken by name so
    that paging is stable.
    """
    groups: dict[str, dict] = {}
    total_kcal = 0.0
    for row in rows:
        kcal = _kcal(row)
        total_kcal += kcal
        g = groups.get(key := group_key(row))
        if g is None:
            g = groups[key] = {"key": key, "food_id": row["food_id"], "name": row["name"], "brand": row["brand"],
                               "unit": row["unit"], "times": 0, "day_set": set(), "amount_total": 0.0,
                               "kcal_total": 0.0, "first_day": row["day"], "last_day": row["day"]}
        g["times"] += 1
        g["day_set"].add(row["day"])
        g["amount_total"] += row["amount"]
        g["kcal_total"] += kcal
        if row["day"] >= g["last_day"]:  # rows come oldest first: the latest spelling wins
            g["last_day"], g["name"], g["brand"], g["unit"] = row["day"], row["name"], row["brand"], row["unit"]
        g["first_day"] = min(g["first_day"], row["day"])
    needle = q.strip().casefold()
    items = [g for g in groups.values() if not needle or needle in g["name"].casefold() or needle in (g["brand"] or "").casefold()]
    by_name = sorted(items, key=lambda g: (g["name"].casefold(), g["brand"] or ""))
    if sort == "name":
        ordered = by_name
    elif sort == "last":
        ordered = sorted(by_name, key=lambda g: g["last_day"], reverse=True)
    else:
        field = {"kcal": "kcal_total", "times": "times", "amount": "amount_total"}[sort]
        ordered = sorted(by_name, key=lambda g: g[field], reverse=True)  # stable: ties stay in name order
    page = ordered[offset:offset + limit]
    return {
        "total": len(ordered),
        "offset": offset,
        "limit": limit,
        "kcal_total": round(total_kcal, 1),
        "items": [
            {
                "key": g["key"], "food_id": g["food_id"], "name": g["name"], "brand": g["brand"], "times": g["times"],
                "days": len(g["day_set"]), "amount_total": round(g["amount_total"], 1), "unit": g["unit"],
                "kcal_total": round(g["kcal_total"], 1),
                "share": round(g["kcal_total"] / total_kcal, 4) if total_kcal else 0.0,
                "avg_amount": round(g["amount_total"] / g["times"], 1), "first_day": g["first_day"],
                "last_day": g["last_day"],
            }
            for g in page
        ],
    }


def food_detail(rows: list[dict], key: str, first: date, last: date) -> dict | None:
    """Monthly series (frequency, amount, kcal; every month of the period, also empty ones), distribution over meals
    and weekdays and the three most common amounts of one food. None when the food has no entry in the period."""
    mine = [r for r in rows if group_key(r) == key]
    if not mine:
        return None
    latest = mine[-1]
    monthly = {m: {"month": m, "times": 0, "amount": 0.0, "kcal": 0.0} for m in analysis.month_keys(first, last)}
    meals = dict.fromkeys(MEALS, 0)
    weekdays = [0] * 7
    amounts: dict[float, int] = {}
    days = set()
    for r in mine:
        slot = monthly[r["day"][:7]]
        slot["times"] += 1
        slot["amount"] += r["amount"]
        slot["kcal"] += _kcal(r)
        meals[r["meal"]] += 1
        weekdays[date.fromisoformat(r["day"]).weekday()] += 1
        amounts[round(r["amount"], 1)] = amounts.get(round(r["amount"], 1), 0) + 1
        days.add(r["day"])
    n = len(mine)
    usual = sorted(amounts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return {
        "key": key, "food_id": latest["food_id"], "name": latest["name"], "brand": latest["brand"],
        "unit": latest["unit"], "times": n, "days": len(days),
        "amount_total": round(sum(r["amount"] for r in mine), 1),
        "kcal_total": round(sum(_kcal(r) for r in mine), 1),
        "first_day": mine[0]["day"], "last_day": mine[-1]["day"],
        "monthly": [{**m, "amount": round(m["amount"], 1), "kcal": round(m["kcal"], 1)} for m in monthly.values()],
        "by_meal": [{"meal": m, "times": meals[m], "share": round(meals[m] / n, 3)} for m in MEALS],
        "by_weekday": [{"weekday": i, "times": weekdays[i], "share": round(weekdays[i] / n, 3)} for i in range(7)],
        "usual_amounts": [{"amount": a, "times": c} for a, c in usual],
    }

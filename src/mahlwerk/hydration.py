"""Drinks of the diary that count towards the day's fluid total (computed on read, nothing is written to the water table).

Per diary entry, only entries in ml are looked at:
  * the food's own setting decides first: `drink` = 0 never counts, 1 always counts (amount x water share, or the whole amount
    when the water content is unknown);
  * without a setting the entry counts when it is no soup, has at most ALCOHOL_MAX g alcohol per 100 and either holds at least
    WATER_MIN % water or, when the water content is unknown, looks like a plain drink (`plain_drink`: at most 70 kcal, 0.5 g salt and 5 g protein per 100).
The water share is amount x water content / 100; the content is the nutrient `water` (per 100 g/ml) of the entry, else of its food.
"""

import re

WATER_MIN = 80.0  # % water per 100 g/ml for the automatic rule
ALCOHOL_MAX = 0.5  # g alcohol per 100 g/ml
# fallback without a water content: the proxy for "a plain drink" (milk 65 kcal, juice 45 and cola 42 pass; soy sauce, ketchup, oil do not)
FALLBACK_KCAL_MAX = 70.0
FALLBACK_SALT_MAX = 0.5  # g salt per 100: keeps soy sauce and stock out although they have few kcal
FALLBACK_PROTEIN_MAX = 5.0  # g protein per 100: keeps skyr and quark out (milk has 3.4, soy and oat drinks less)

_SOUP = re.compile(r"suppe|soup|eintopf|br[uü]he|bouillon|consomm[eé]|broth|stew|chowder|bisque|gazpacho", re.IGNORECASE)


def is_soup(name: str | None) -> bool:
    return bool(name and _SOUP.search(name))


def _num(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def water_content(entry: dict) -> float | None:
    """% water per 100 g/ml: the entry's own value, else what its food says; None when neither knows it."""
    for extra in (entry.get("extra"), entry.get("food_extra")):
        value = _num((extra or {}).get("water"))
        if value is not None:
            return min(max(value, 0.0), 100.0)
    return None


def alcohol_content(entry: dict) -> float:
    for extra in (entry.get("extra"), entry.get("food_extra")):
        value = _num((extra or {}).get("alcohol"))
        if value is not None:
            return value
    return 0.0


def plain_drink(entry: dict) -> bool:
    """For an unknown water content: few kcal, hardly any salt and not much protein per 100 (nothing known about the energy: no)."""
    per_100 = entry.get("per_100") or {}
    kcal, salt, protein = _num(per_100.get("kcal")), _num(per_100.get("salt")), _num(per_100.get("protein"))
    return kcal is not None and kcal <= FALLBACK_KCAL_MAX and (salt or 0.0) <= FALLBACK_SALT_MAX and (protein or 0.0) <= FALLBACK_PROTEIN_MAX


def drink_ml(entry: dict) -> float:
    """The water (ml) one entry adds to the fluid total; entry: unit-ml row with amount, name, per_100, extra, food_extra, drink."""
    drink = entry.get("drink")
    if drink is not None and not drink:
        return 0.0
    content = water_content(entry)
    if drink is None:
        if is_soup(entry.get("name")) or alcohol_content(entry) > ALCOHOL_MAX:
            return 0.0
        if not (content >= WATER_MIN if content is not None else plain_drink(entry)):
            return 0.0
    share = 1.0 if content is None else content / 100
    return float(entry["amount"]) * share


def drinks_by_day(entries: list[dict]) -> dict[str, int]:
    """Whole ml per day for the entries `Store.drink_entries` returns."""
    sums: dict[str, float] = {}
    for e in entries:
        ml = drink_ml(e)
        if ml > 0:
            sums[e["day"]] = sums.get(e["day"], 0.0) + ml
    return {day: round(ml) for day, ml in sums.items()}


def day_drinks_ml(store, user_id: int, day: str) -> int:
    """The drinks of one day (0 when the user switched the feature off with the setting `water_drinks`)."""
    if not store.get_settings(user_id).get("water_drinks", True):
        return 0
    return drinks_by_day(store.drink_entries(user_id, day, day)).get(day, 0)

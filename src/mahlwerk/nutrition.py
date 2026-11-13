"""Pure helpers: barcode check, unit and serving detection, scaling nutrients to an amount."""

import re

PER_100_KEYS = ("kcal", "fat", "saturated_fat", "carbs", "sugars", "fiber", "protein", "salt")
CORE = ("kcal", "fat", "carbs", "protein")

_VOLUME = re.compile(r"\d\s*(?:ml|cl|dl|l|fl\.?\s*oz)\b", re.IGNORECASE)
_SERVING = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\b", re.IGNORECASE)


def valid_gtin(code: str) -> bool:
    """Check length and the GS1 check digit (EAN-8, UPC-A, EAN-13, GTIN-14)."""
    if not code.isdigit() or len(code) not in (8, 12, 13, 14):
        return False
    digits = [int(c) for c in code]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits[:-1])))
    return (10 - total % 10) % 10 == digits[-1]


def guess_unit(per: str | None, quantity: str | None, serving_size: str | None) -> str:
    """Liquids are measured in ml: either the table says so or the package size is a volume."""
    if per and per.replace(" ", "").lower() == "100ml":
        return "ml"
    if any(text and _VOLUME.search(text) for text in (quantity, serving_size)):
        return "ml"
    return "g"


def parse_serving(serving_size: str | None) -> tuple[float, str] | None:
    """'30 g' -> (30.0, 'g'); anything that is not a plain weight or volume gives None."""
    match = _SERVING.match(serving_size or "")
    if not match:
        return None
    value = float(match.group(1).replace(",", "."))
    return (value, match.group(2).lower()) if value > 0 else None


def is_complete(per_100: dict) -> bool:
    return all(per_100.get(k) is not None for k in CORE)


def scale(per_100: dict, amount: float) -> dict:
    """Nutrients for `amount` g/ml; missing values stay None."""
    return {k: None if per_100.get(k) is None else per_100[k] * amount / 100 for k in PER_100_KEYS}


def total(parts: list[dict]) -> dict:
    """Sum scaled nutrients; None counts as 0."""
    return {k: sum(p[k] or 0 for p in parts) for k in PER_100_KEYS}


def r1(value: float) -> float:
    return round(value, 1)


def recipe_food(items: list[dict], portions: float, total_weight: float | None) -> dict:
    """Food data of a recipe, calculated from its ingredients.

    `items` are snapshots with `amount` (g/ml, millilitres count like grams), `per_100` and `extra`. The reference
    weight is `total_weight` (the cooked dish) or, without it, the sum of the amounts. A value is only set when at
    least one ingredient states it; ingredients without it add nothing (unknown, not zero).
    """
    weight = sum(i["amount"] for i in items)
    reference = total_weight or weight
    per_100: dict[str, float | None] = {}
    for key in PER_100_KEYS:
        known = [i["per_100"][key] * i["amount"] for i in items if i["per_100"].get(key) is not None]
        per_100[key] = round(sum(known) / reference, 2) if known else None
    sums: dict[str, float] = {}
    for item in items:
        for key, value in (item.get("extra") or {}).items():
            sums[key] = sums.get(key, 0.0) + value * item["amount"]
    extra = {key: round(value / reference, 4) for key, value in sums.items()}
    serving = round(reference / portions, 2)
    return {
        "name": None,  # filled in by the caller
        "brand": None,
        "quantity": None,
        "serving_size": f"{round(serving, 1):g} g",
        "serving_quantity": serving,
        "unit": "g",
        "per_100": per_100,
        "extra": extra,
        "complete": is_complete(per_100),
    }

"""Directory of the additional nutrients (everything beyond the eight core values in `Per100`).

Every nutrient has a snake_case `key`, a `group`, the `unit` it is usually quoted in (per 100 g or 100 ml), the
EU reference intake for adults (`nrv`, nutrient reference value) where one exists, the column of the Open Food
Facts export and the key of the Yazio export.

Sources:
- NRV: Regulation (EU) No 1169/2011 on food information to consumers, Annex XIII part A point 1 (vitamins and
  minerals). Nutrients without an NRV there (fats, sugars, sodium, caffeine, ...) have `nrv = None`.
- Open Food Facts: the CSV export and the API give *every* nutrient in GRAMS per 100 g, whatever unit people use
  for it. `from_off` converts to `unit`.
- BLS (Bundeslebensmittelschlüssel): tag, unit and mapping are in bls.py; `from_unit` converts its values.
- Yazio: key names of the Yazio data export (see yazio.py). Its values are in GRAMS per 1 g/ml of product;
  `extra_from_yazio` converts them like `extra_from_off`.

`max` is the highest value per 100 g/ml (in `unit`) still believable for a food, including supplements and very
nutrient-dense foods (dried kelp, liver, brazil nuts). Anything above is a unit error in the source: it is
discarded rather than stored (no value is better than a wrong one).
"""

import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass

GROUPS = ("fat", "carb", "mineral", "vitamin", "other")
UNIT_FACTOR = {"g": 1.0, "mg": 1e3, "µg": 1e6}  # grams -> unit


@dataclass(frozen=True)
class Nutrient:
    key: str
    group: str
    unit: str
    nrv: float | None
    off: str | None  # column / nutriments key in the Open Food Facts export (grams per 100 g)
    yazio: str | None
    max: float  # plausible upper bound per 100 g/ml in `unit`


def _n(key, group, unit, nrv, off, yazio, max_):
    return Nutrient(key, group, unit, nrv, off, yazio, max_)


NUTRIENTS: tuple[Nutrient, ...] = (
    # fats
    _n("monounsaturated_fat", "fat", "g", None, "monounsaturated-fat_100g", "nutrient.monounsaturated", 100),
    _n("polyunsaturated_fat", "fat", "g", None, "polyunsaturated-fat_100g", "nutrient.polyunsaturated", 100),
    _n("trans_fat", "fat", "g", None, "trans-fat_100g", "nutrient.transfat", 100),
    _n("cholesterol", "fat", "mg", None, "cholesterol_100g", "nutrient.cholesterol", 5000),
    _n("omega_3", "fat", "g", None, "omega-3-fat_100g", None, 100),
    # carbohydrates
    _n("added_sugars", "carb", "g", None, "added-sugars_100g", "nutrient.addedsugar", 100),
    _n("starch", "carb", "g", None, "starch_100g", None, 100),
    # other
    _n("alcohol", "other", "g", None, "alcohol_100g", "nutrient.alcohol", 100),
    _n("water", "other", "g", None, "water_100g", "nutrient.water", 100),
    _n("sodium", "other", "mg", None, "sodium_100g", "nutrient.sodium", 40000),
    _n("caffeine", "other", "mg", None, "caffeine_100g", None, 5000),
    # minerals
    _n("calcium", "mineral", "mg", 800, "calcium_100g", "mineral.calcium", 10000),
    _n("iron", "mineral", "mg", 14, "iron_100g", "mineral.iron", 500),
    _n("potassium", "mineral", "mg", 2000, "potassium_100g", "mineral.potassium", 20000),
    _n("magnesium", "mineral", "mg", 375, "magnesium_100g", "mineral.magnesium", 5000),
    _n("zinc", "mineral", "mg", 10, "zinc_100g", "mineral.zinc", 300),
    _n("phosphorus", "mineral", "mg", 700, "phosphorus_100g", "mineral.phosphorus", 5000),
    _n("iodine", "mineral", "µg", 150, "iodine_100g", "mineral.iodine", 200000),
    _n("copper", "mineral", "mg", 1, "copper_100g", "mineral.copper", 50),
    _n("manganese", "mineral", "mg", 2, "manganese_100g", "mineral.manganese", 100),
    _n("selenium", "mineral", "µg", 55, "selenium_100g", "mineral.selenium", 5000),
    _n("chloride", "mineral", "mg", 800, "chloride_100g", "mineral.chlorine", 40000),
    _n("fluoride", "mineral", "mg", 3.5, "fluoride_100g", "mineral.fluoride", 50),
    _n("chromium", "mineral", "µg", 40, "chromium_100g", "mineral.chrome", 2000),
    _n("molybdenum", "mineral", "µg", 50, "molybdenum_100g", "mineral.molybdenum", 2000),
    # vitamins
    _n("vitamin_a", "vitamin", "µg", 800, "vitamin-a_100g", "vitamin.a", 100000),
    _n("vitamin_b1", "vitamin", "mg", 1.1, "vitamin-b1_100g", "vitamin.b1", 100),
    _n("vitamin_b2", "vitamin", "mg", 1.4, "vitamin-b2_100g", "vitamin.b2", 100),
    _n("vitamin_b3", "vitamin", "mg", 16, "vitamin-pp_100g", "vitamin.b3", 500),
    _n("vitamin_b5", "vitamin", "mg", 6, "pantothenic-acid_100g", "vitamin.b5", 100),
    _n("vitamin_b6", "vitamin", "mg", 1.4, "vitamin-b6_100g", "vitamin.b6", 100),
    _n("vitamin_b7", "vitamin", "µg", 50, "biotin_100g", "vitamin.b7", 5000),
    _n("vitamin_b9", "vitamin", "µg", 200, "vitamin-b9_100g", "vitamin.b11", 10000),
    _n("vitamin_b12", "vitamin", "µg", 2.5, "vitamin-b12_100g", "vitamin.b12", 5000),
    _n("vitamin_c", "vitamin", "mg", 80, "vitamin-c_100g", "vitamin.c", 10000),
    _n("vitamin_d", "vitamin", "µg", 5, "vitamin-d_100g", "vitamin.d", 1000),
    _n("vitamin_e", "vitamin", "mg", 12, "vitamin-e_100g", "vitamin.e", 1000),
    _n("vitamin_k", "vitamin", "µg", 75, "vitamin-k_100g", "vitamin.k", 10000),
)

BY_KEY: dict[str, Nutrient] = {n.key: n for n in NUTRIENTS}
KEYS: tuple[str, ...] = tuple(BY_KEY)
OFF_COLUMNS: dict[str, str] = {n.key: n.off for n in NUTRIENTS if n.off}

# Yazio uses more than one spelling for some minerals; the first one is listed on the nutrient itself.
YAZIO_ALIASES: dict[str, str] = {"mineral.fluorine": "fluoride"}
YAZIO_KEYS: dict[str, str] = {
    **{n.yazio: n.key for n in NUTRIENTS if n.yazio},
    **YAZIO_ALIASES,
}

# sub-values that can never exceed their parent (small tolerance for rounding in the source)
_PARTS_OF_FAT = ("monounsaturated_fat", "polyunsaturated_fat", "trans_fat", "omega_3")
_PARTS_OF_CARBS = ("added_sugars", "starch")
TOLERANCE = 1.0


def directory() -> list[dict]:
    """The directory as served by GET /api/v1/nutrients."""
    return [{"key": n.key, "group": n.group, "unit": n.unit, "nrv": n.nrv} for n in NUTRIENTS]


def parse_number(value) -> float | None:
    """A finite float from text or a number, otherwise None. No rounding."""
    try:
        number = float(str(value).strip()) if isinstance(value, str) else float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def plausible(key: str, value: float) -> bool:
    return key in BY_KEY and 0 <= value <= BY_KEY[key].max


def from_off(key: str, grams: float | None) -> float | None:
    """Open Food Facts gives grams per 100 g; return the value in the nutrient's unit, or None when it is missing,
    negative or implausibly large."""
    if grams is None or key not in BY_KEY or grams < 0:
        return None
    nutrient = BY_KEY[key]
    value = round(grams * UNIT_FACTOR[nutrient.unit], 4)
    return value if value <= nutrient.max else None


def from_unit(key: str, value: float | None, unit: str) -> float | None:
    """`value` quoted in `unit` (g, mg or µg) as a value in the nutrient's own unit; None when it is missing,
    negative, implausibly large or the unit is unknown."""
    if value is None or key not in BY_KEY or unit not in UNIT_FACTOR or value < 0:
        return None
    nutrient = BY_KEY[key]
    converted = round(value / UNIT_FACTOR[unit] * UNIT_FACTOR[nutrient.unit], 6)
    return converted if converted <= nutrient.max else None


def part_fits(key: str, value: float, fat: float | None = None, carbs: float | None = None) -> bool:
    """False for a fat or carbohydrate part that is larger than its parent (`fat`, `carbs` in g)."""
    if fat is not None and key in _PARTS_OF_FAT and value > fat + TOLERANCE:
        return False
    return not (carbs is not None and key in _PARTS_OF_CARBS and value > carbs + TOLERANCE)


def extra_from_off(lookup: Callable[[str], float | None], fat: float | None = None, carbs: float | None = None) -> dict:
    """Additional nutrients of one Open Food Facts product.

    `lookup(column)` returns the value of an OFF column in grams (or None). Values that are missing or implausible
    are left out, so is a fat or carbohydrate part larger than its parent (`fat`, `carbs` in g).
    """
    result: dict[str, float] = {}
    for key, column in OFF_COLUMNS.items():
        value = from_off(key, lookup(column))
        if value is None:
            continue
        if fat is not None and key in _PARTS_OF_FAT and value > fat + TOLERANCE:
            continue
        if carbs is not None and key in _PARTS_OF_CARBS and value > carbs + TOLERANCE:
            continue
        result[key] = value
    return result


def extra_from_yazio(
    values: dict, per: float, fat: float | None = None, carbs: float | None = None
) -> tuple[dict[str, float], int]:
    """Additional nutrients from a Yazio nutrient object, and how many values had to be discarded.

    `values` maps Yazio keys to grams; `per` turns such a value into grams per 100 g/ml (100 for the Yazio per-gram
    products, 1 for the absolute values of an entry that is stored as exactly 100 g). Keys without a counterpart here
    (including the core values of `Per100`) are ignored: the caller counts them. A value that is not a number, is
    negative, implausibly large or larger than its parent (`fat`, `carbs` in g) is discarded and counted.
    """
    result: dict[str, float] = {}
    dropped = 0
    for yazio_key, raw in values.items():
        key = YAZIO_KEYS.get(yazio_key)
        if key is None:
            continue
        number = parse_number(raw)
        value = None if number is None else from_off(key, number * per)
        if value is None:
            dropped += 1
        elif fat is not None and key in _PARTS_OF_FAT and value > fat + TOLERANCE:
            dropped += 1
        elif carbs is not None and key in _PARTS_OF_CARBS and value > carbs + TOLERANCE:
            dropped += 1
        else:
            result[key] = value
    return result, dropped


def clean(extra) -> dict[str, float]:
    """Stored `extra` as a plain dict of known, plausible numbers (older rows have none)."""
    if not isinstance(extra, dict):
        return {}
    return {k: v for k, v in extra.items() if isinstance(v, int | float) and plausible(k, v)}


def scale_extra(extra: dict, amount: float) -> dict[str, float]:
    """Nutrients for `amount` g/ml."""
    return {k: v * amount / 100 for k, v in extra.items()}


def aggregate(parts: Iterable[tuple[float, dict]]) -> dict[str, dict]:
    """Sum scaled extra nutrients and measure how much of the energy they are known for.

    `parts` are (kcal, scaled extra) per diary entry. Returns {key: {"amount", "coverage"}} for the keys at least
    one entry knows. `coverage` (0..1) is the share of the entries' kcal that come from entries with a value for
    the key; when no entry has any kcal it is the share of entries instead. A missing value is not a zero: it only
    lowers the coverage.
    """
    parts = list(parts)
    kcal_total = sum(kcal for kcal, _ in parts)
    by_energy = kcal_total > 0
    whole = kcal_total if by_energy else len(parts)
    sums: dict[str, float] = {}
    known: dict[str, float] = {}
    for kcal, extra in parts:
        for key, value in extra.items():
            sums[key] = sums.get(key, 0.0) + value
            known[key] = known.get(key, 0.0) + (kcal if by_energy else 1)
    return {
        key: {"amount": sums[key], "coverage": min(1.0, known[key] / whole) if whole else 0.0}
        for key in sorted(sums, key=KEYS.index)
    }

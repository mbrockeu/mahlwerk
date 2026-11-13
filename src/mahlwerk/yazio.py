"""Import the diary of an exported Yazio account.

The unofficial "yazio-exporter" writes the data of a Yazio account as JSON files into a folder. This module reads
ONLY those files and never talks to Yazio:

    python -m mahlwerk.yazio import --user NAME --dir EXPORT_FOLDER [--db FILE] [--all-products] [--dry-run]
    python -m mahlwerk.yazio list [--user NAME]
    python -m mahlwerk.yazio remove --batch ID

Files (a missing one is skipped and reported, any other file is ignored):

- `products.json`: `{"products": {uuid: product}, "recipes": {uuid: recipe}}`. Product nutrients are per 1 g/ml in kcal
  (`energy.energy`) or grams; recipe nutrients are per portion, also in kcal or grams.
- `days.json`: `{"YYYY-MM-DD": day}`; a day holds `consumed.products` (product + total amount in g/ml),
  `consumed.recipe_portions` (recipe + number of portions) and `consumed.simple_products` (quick entries with
  ABSOLUTE nutrients), a `daily_summary` with water, goals, steps and activity energy, and `exercises` with the day's
  activity (steps, energy, distance, duration) and its `training` / `custom_training` lists.
- `weight.json`: `{"YYYY-MM-DD": kg}`.

How things map:

- Product entry: a diary entry with a snapshot of the product (per 100 = value per gram x 100). Each used product also
  becomes a food (`source: "yazio"`), unless its barcode already belongs to a food: that one is used and left as it
  is (the entry still carries the Yazio values).
- Recipe portion: one food per recipe (`source: "yazio"`) whose reference portion is the sum of the ingredient
  amounts divided by the portion count, in g; per 100 g is calculated back from the nutrients per portion. The
  entry is in grams (portions x portion weight), so kcal and macros come out as nutrients per portion x portions.
  The recipes are not created as editable Mahlwerk recipes.
- Quick entry: no food; the entry is 100 g with per 100 g = the absolute values, so its kcal and macros equal them.
- Weights and water only on days the user has no value yet; the goal of the most recent day only if the user has none.
- Activity: steps and active energy of a day (`daily_summary.steps` / `activity_energy`, else `exercises.activity`)
  and its distance become a row of the activity table with source `yazio`, only on days that have no row yet. Every
  training becomes a workout (`external_id` `yazio:<id>`, kind from the Yazio name, unknown names become `other` and
  keep the name). The steps goal comes with the goal. A second run over an export that was imported before adds the
  activity as a batch of its own and nothing else twice.

Everything is written in one transaction as one import batch; the Yazio ids of the entries make a second run add
nothing, and `remove` takes the batch back (see `Store.remove_import`).
"""

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from . import activity as act
from . import nutrients
from .db import MAX_WATER_ML, Store, is_reserved_name
from .models import MEALS
from .nutrition import PER_100_KEYS, is_complete

FILES = ("products.json", "days.json", "weight.json")
CORE = {
    "energy.energy": "kcal",
    "nutrient.fat": "fat",
    "nutrient.saturated": "saturated_fat",
    "nutrient.carb": "carbs",
    "nutrient.sugar": "sugars",
    "nutrient.dietaryfiber": "fiber",
    "nutrient.protein": "protein",
    "nutrient.salt": "salt",
}
MAX_KCAL_100 = 950  # as in the catalogue import
MAX_GRAMS_100 = 100
MAX_AMOUNT = 50_000  # g/ml of one entry
MAX_PORTIONS = 1_000
WEIGHT_RANGE = (20.0, 500.0)
GOAL_KCAL = (500, 10_000)
GOAL_GRAMS = (0, 1_000)
GOAL_WATER = (500, 6_000)
DEFAULT_WATER_GOAL = 2000
QUICK_PORTION = 100.0  # a quick entry is stored as 100 g with per 100 g = its absolute values
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class YazioError(Exception):
    """The export cannot be used (folder or file unreadable, wrong shape, unknown user)."""


@dataclass
class Summary:
    days: int = 0
    entries: Counter = field(default_factory=Counter)  # product / recipe / quick
    foods_created: int = 0
    foods_reused: int = 0
    weights: int = 0
    weights_kept: int = 0  # the day already had a value
    activity_days: int = 0
    activity_kept: int = 0  # the day already had an activity row
    workouts: int = 0
    workouts_already: int = 0
    water: int = 0
    water_kept: int = 0
    goal_set: bool = False
    already_imported: int = 0
    skipped: Counter = field(default_factory=Counter)  # reason -> how many
    notes: Counter = field(default_factory=Counter)  # things that were adjusted, not skipped
    unknown_keys: Counter = field(default_factory=Counter)  # Yazio nutrient keys without a counterpart
    dropped_values: int = 0  # implausible or unreadable nutrient values that were left out
    missing_files: list[str] = field(default_factory=list)
    batch_id: int | None = None
    dry_run: bool = False
    seconds: float = 0.0

    @property
    def total_entries(self) -> int:
        return sum(self.entries.values())

    def lines(self) -> list[str]:
        e = self.entries
        out = [
            ("Dry run, nothing was written." if self.dry_run else f"Import batch {self.batch_id} written.")
            if self.batch_id or self.dry_run else "Nothing new to import.",
            f"Days with entries: {self.days}",
            f"Entries: {self.total_entries} (products {e['product']}, recipe portions {e['recipe']}, "
            f"quick entries {e['quick']})",
            f"Foods: {self.foods_created} created, {self.foods_reused} reused",
            f"Weights: {self.weights} (kept {self.weights_kept} existing)",
            f"Water: {self.water} days (kept {self.water_kept} existing)",
            f"Activity: {self.activity_days} days (kept {self.activity_kept} existing), {self.workouts} workouts"
            + (f" ({self.workouts_already} already imported earlier)" if self.workouts_already else ""),
            f"Goal set: {'yes' if self.goal_set else 'no'}",
        ]
        if self.already_imported:
            out.append(f"Already imported earlier: {self.already_imported} entries")
        if self.skipped:
            out.append(f"Skipped: {sum(self.skipped.values())}")
            out += [f"  {count} x {reason}" for reason, count in sorted(self.skipped.items())]
        out += [f"Note: {count} x {text}" for text, count in sorted(self.notes.items())]
        if self.dropped_values:
            out.append(f"Nutrient values left out as implausible or unreadable: {self.dropped_values}")
        if self.unknown_keys:
            keys = ", ".join(f"{k} ({n})" for k, n in sorted(self.unknown_keys.items()))
            out.append(f"Unknown nutrient keys (ignored): {keys}")
        for name in self.missing_files:
            out.append(f"File missing, part skipped: {name}")
        out.append(f"Took {self.seconds:.1f} s")
        return out


def _read(directory: Path, name: str):
    path = directory / name
    if not path.is_file():
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeDecodeError) as exc:
        raise YazioError(f"{name}: cannot be read ({exc})") from exc
    except json.JSONDecodeError as exc:
        raise YazioError(f"{name}: not valid JSON (line {exc.lineno}, column {exc.colno}: {exc.msg})") from exc
    if not isinstance(data, dict):
        raise YazioError(f"{name}: expected a JSON object at the top level")
    return data


def _is_day(text) -> bool:
    if not isinstance(text, str) or not _DAY.match(text):
        return False
    try:
        date.fromisoformat(text)
    except ValueError:
        return False
    return True


def _text(value, limit: int = 200) -> str | None:
    return " ".join(value.split())[:limit] or None if isinstance(value, str) else None


class _Convert:
    """Turns Yazio nutrient objects into the per-100 values and extra nutrients of a snapshot."""

    def __init__(self, summary: Summary):
        self.summary = summary

    def nutrients(self, values, factor: float, strict: bool = True) -> tuple[dict, dict]:
        """`values` x `factor` = per 100 g/ml. `strict` checks the limits of the catalogue import (a quick entry is
        absolute, so only sanity limits apply). Returns (per_100 with all eight keys, extra)."""
        per_100: dict[str, float | None] = dict.fromkeys(PER_100_KEYS)
        if not isinstance(values, dict):
            return per_100, {}
        for yazio_key, key in CORE.items():
            if yazio_key not in values:
                continue
            number = nutrients.parse_number(values[yazio_key])
            if number is None:
                self.summary.dropped_values += 1
                continue
            value = round(number * factor, 6)
            top = MAX_KCAL_100 if key == "kcal" else MAX_GRAMS_100
            if not strict:
                top = GOAL_KCAL[1] if key == "kcal" else 5 * GOAL_GRAMS[1]
            if not 0 <= value <= top:
                self.summary.dropped_values += 1
                continue
            per_100[key] = value
        for key in values:
            if key not in CORE and key not in nutrients.YAZIO_KEYS:
                self.summary.unknown_keys[str(key)] += 1
        extra, dropped = nutrients.extra_from_yazio(values, factor, fat=per_100["fat"], carbs=per_100["carbs"])
        self.summary.dropped_values += dropped
        return per_100, extra


def _food_data(name, brand, serving: tuple[float, str] | None, unit: str, per_100: dict, extra: dict) -> dict:
    return {
        "name": name or "?",
        "brand": brand,
        "quantity": None,
        "serving_size": f"{serving[0]:g} {serving[1]}" if serving else None,
        "serving_quantity": serving[0] if serving else None,
        "unit": unit,
        "per_100": per_100,
        "extra": extra,
        "complete": is_complete(per_100),
    }


def _first_serving(servings, unit: str) -> tuple[float, str] | None:
    """The portion of a product: `portion` if there is one, else the first usable one."""
    usable = []
    for item in servings if isinstance(servings, list) else []:
        amount = nutrients.parse_number(item.get("amount")) if isinstance(item, dict) else None
        if amount is not None and 0 < amount <= 5000:
            usable.append((item.get("serving"), amount))
    usable.sort(key=lambda s: s[0] != "portion")  # stable: `portion` first, the rest in file order
    return (usable[0][1], unit) if usable else None


def load_folder(directory: str | Path) -> dict[str, dict | None]:
    """The files of an export folder as parsed JSON objects (None for a file that is missing)."""
    folder = Path(directory)
    if not folder.is_dir():
        raise YazioError(f"{folder}: not a folder")
    return {name: _read(folder, name) for name in FILES}


def build_plan(directory: str | Path, all_products: bool, summary: Summary) -> dict:
    """Read the export and prepare everything `Store.import_yazio` writes. Touches no database."""
    return build_plan_from(load_folder(directory), all_products, summary, str(directory))


def build_plan_from(loaded: dict[str, dict | None], all_products: bool, summary: Summary, where: str = "the export") -> dict:
    """Prepare everything `Store.import_yazio` writes from the parsed files (`FILES` -> object or None). The one core
    behind the command line, the file upload and the direct sign-in: all three hand over the same structure."""
    summary.missing_files = [name for name, data in loaded.items() if data is None]
    if len(summary.missing_files) == len(FILES):
        raise YazioError(f"{where}: none of {', '.join(FILES)} found")
    catalog = loaded["products.json"] or {}
    products = catalog.get("products") if isinstance(catalog.get("products"), dict) else {}
    recipes = catalog.get("recipes") if isinstance(catalog.get("recipes"), dict) else {}
    days = loaded["days.json"] or {}
    convert = _Convert(summary)

    foods: dict[str, dict] = {}
    recipe_meta: dict[str, tuple[float, str] | None] = {}

    def product_food(uuid) -> tuple[str, dict] | None:
        key = f"yazio:product:{uuid}"
        if key not in foods:
            product = products.get(uuid)
            if not isinstance(product, dict):
                return None
            unit = product.get("base_unit") if product.get("base_unit") in ("g", "ml") else "g"
            per_100, extra = convert.nutrients(product.get("nutrients"), 100)
            eans = product.get("eans")
            ean = eans[0].strip() if isinstance(eans, list) and eans and isinstance(eans[0], str) else ""
            foods[key] = {
                "code": ean if ean.isdigit() and len(ean) <= 14 else None,
                "data": _food_data(
                    _text(product.get("name")), _text(product.get("producer")),
                    _first_serving(product.get("servings"), unit), unit, per_100, extra),
            }
        return key, foods[key]["data"]

    def recipe_food(uuid) -> tuple[str, dict, float] | None:
        """(key, food data, grams per portion). The portion weight is the sum of the ingredients / portions."""
        key = f"yazio:recipe:{uuid}"
        recipe = recipes.get(uuid)
        if not isinstance(recipe, dict):
            return None
        if key not in foods:
            portions = nutrients.parse_number(recipe.get("portion_count"))
            ingredients = recipe.get("servings") if isinstance(recipe.get("servings"), list) else []
            total = sum(
                a for i in ingredients if isinstance(i, dict)
                and (a := nutrients.parse_number(i.get("amount"))) is not None and a > 0
            )
            grams = total / portions if portions and portions > 0 and total > 0 else QUICK_PORTION
            per_100, extra = convert.nutrients(recipe.get("nutrients"), 100 / grams)
            foods[key] = {
                "code": None,
                "data": _food_data(_text(recipe.get("name")), None, (round(grams, 4), "g"), "g", per_100, extra),
            }
            recipe_meta[key] = (grams, "g")
        return key, foods[key]["data"], recipe_meta[key][0]

    entries: list[dict] = []
    skip = summary.skipped
    water: list[dict] = []
    activity: list[dict] = []
    workouts: list[dict] = []
    valid_days = []
    for day in sorted(days):
        content = days[day]
        if not _is_day(day) or not isinstance(content, dict):
            skip["day with an invalid date or shape"] += 1
            continue
        valid_days.append(day)
        consumed = content.get("consumed") if isinstance(content.get("consumed"), dict) else {}
        found: list[tuple[str, dict, str]] = []
        for kind, name in (("product", "products"), ("recipe", "recipe_portions"), ("quick", "simple_products")):
            for item in consumed.get(name) if isinstance(consumed.get(name), list) else []:
                found.append((str(item.get("date", "")) if isinstance(item, dict) else "", item, kind))
        found.sort(key=lambda f: f[0])  # by time of day; stable for equal times
        for _, item, kind in found:
            entry = _entry(item, kind, day, product_food, recipe_food, convert, skip, summary, bool(catalog))
            if entry:
                entries.append(entry)
        summary_block = content.get("daily_summary") if isinstance(content.get("daily_summary"), dict) else {}
        ml = nutrients.parse_number(summary_block.get("water_intake"))
        if ml and ml > 0:
            if ml <= MAX_WATER_ML:
                water.append({"day": day, "ml": round(ml)})
            else:
                skip["water amount above 10 l"] += 1
        exercises = content.get("exercises") if isinstance(content.get("exercises"), dict) else {}
        day_activity = _activity_day(day, summary_block, exercises.get("activity"), skip)
        if day_activity:
            activity.append(day_activity)
        for list_name in ("training", "custom_training"):
            for item in exercises.get(list_name) if isinstance(exercises.get(list_name), list) else []:
                workout = _workout(item, day, skip)
                if workout:
                    workouts.append(workout)

    if all_products:
        for uuid in products:
            product_food(uuid)

    weights = []
    for day, kg in (loaded["weight.json"] or {}).items():
        value = nutrients.parse_number(kg)
        if not _is_day(day) or value is None or not WEIGHT_RANGE[0] <= value <= WEIGHT_RANGE[1]:
            skip["weight with an invalid date or value"] += 1
        else:
            weights.append({"day": day, "kg": round(value, 2)})

    return {
        "foods": foods, "entries": entries, "weights": weights, "water": water, "all_products": all_products,
        "goal": _goal(days, valid_days), "activity": activity, "workouts": workouts,
    }


def _positive(value, top: float) -> float | None:
    """A number above 0 and at most `top`, else None."""
    number = nutrients.parse_number(value)
    return number if number is not None and 0 < number <= top else None


def _activity_day(day: str, summary_block: dict, activity, skip: Counter) -> dict | None:
    """Steps, active energy and distance of one day: the daily summary first, the day's activity as a fallback."""
    activity = activity if isinstance(activity, dict) else {}
    steps = _positive(summary_block.get("steps"), act.MAX_STEPS) or _positive(activity.get("steps"), act.MAX_STEPS)
    energy = (_positive(summary_block.get("activity_energy"), act.MAX_ACTIVE_KCAL)
              or _positive(activity.get("energy"), act.MAX_ACTIVE_KCAL))
    distance = _positive(activity.get("distance"), act.MAX_DISTANCE_M)
    raw = [summary_block.get("steps"), summary_block.get("activity_energy"), activity.get("steps"), activity.get("energy"),
           activity.get("distance")]
    if steps is None and energy is None and distance is None:
        if any((nutrients.parse_number(v) or 0) > 0 for v in raw):
            skip["activity values out of range"] += 1
        return None
    return {"day": day, "steps": round(steps) if steps is not None else None,
            "active_kcal": round(energy, 1) if energy is not None else None,
            "distance_m": round(distance, 1) if distance is not None else None}


def _started_at(text) -> int | None:
    if not isinstance(text, str):
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return int(parsed.timestamp()) if parsed.tzinfo else None


def _workout(item, day: str, skip: Counter) -> dict | None:
    if not isinstance(item, dict) or not item.get("id"):
        skip["training without id"] += 1
        return None
    minutes = _positive(item.get("duration"), act.MAX_MINUTES)
    if minutes is None:
        skip["training without a usable duration"] += 1
        return None
    name = _text(item.get("name"), 100)
    kind, kept_name = act.resolve_kind(name, None)
    steps = _positive(item.get("steps"), act.MAX_STEPS)
    return {
        "external_id": f"yazio:{item['id']}", "day": day, "started_at": _started_at(item.get("date")), "kind": kind,
        "name": kept_name, "minutes": float(minutes), "kcal": _positive(item.get("energy"), act.MAX_WORKOUT_KCAL),
        "distance_m": _positive(item.get("distance"), act.MAX_DISTANCE_M),
        "steps": round(steps) if steps is not None else None, "note": _text(item.get("note"), 500),
    }


def _entry(item, kind, day, product_food, recipe_food, convert, skip, summary, have_catalog) -> dict | None:
    if not isinstance(item, dict) or not item.get("id"):
        skip["entry without id"] += 1
        return None
    meal = item.get("daytime")
    if meal not in MEALS:
        meal = "snack"
        summary.notes["entry with an unknown meal put into snack"] += 1
    entry = {
        "kind": kind, "external_id": str(item["id"]), "day": day, "meal": meal, "food_key": None, "brand": None,
    }
    if kind == "product":
        hit = product_food(item.get("product_id"))
        if hit is None:
            skip["product not in products.json" if have_catalog else "products.json missing"] += 1
            return None
        key, data = hit
        amount = nutrients.parse_number(item.get("amount"))
        if amount is None or not 0 < amount <= MAX_AMOUNT:
            skip["entry with an invalid amount"] += 1
            return None
        entry.update(food_key=key, amount=amount, unit=data["unit"], name=data["name"], brand=data["brand"],
                     per_100=data["per_100"], extra=data["extra"])
    elif kind == "recipe":
        hit = recipe_food(item.get("recipe_id"))
        if hit is None:
            skip["recipe not in products.json" if have_catalog else "products.json missing"] += 1
            return None
        key, data, grams = hit
        portions = nutrients.parse_number(item.get("portion_count"))
        if portions is None or not 0 < portions <= MAX_PORTIONS:
            skip["entry with an invalid portion count"] += 1
            return None
        entry.update(food_key=key, amount=round(portions * grams, 6), unit="g", name=data["name"], brand=None,
                     per_100=data["per_100"], extra=data["extra"])
    else:
        values = item.get("nutrients")
        if not isinstance(values, dict) or nutrients.parse_number(values.get("energy.energy")) is None:
            skip["quick entry without energy value"] += 1
            return None
        per_100, extra = convert.nutrients(values, 1.0, strict=False)
        if per_100["kcal"] is None:
            skip["quick entry with an unusable energy value"] += 1
            return None
        entry.update(amount=QUICK_PORTION, unit="g", name=_text(item.get("name")) or "?", per_100=per_100, extra=extra)
    return entry


def _goal(days: dict, valid_days: list[str]) -> dict | None:
    """The goal of the most recent day that has a usable one."""
    for day in reversed(valid_days):
        block = days[day].get("daily_summary")
        goals = block.get("goals") if isinstance(block, dict) else None
        if not isinstance(goals, dict):
            continue
        kcal, protein = (nutrients.parse_number(goals.get(k)) for k in ("energy.energy", "nutrient.protein"))
        carbs, fat = (nutrients.parse_number(goals.get(k)) for k in ("nutrient.carb", "nutrient.fat"))
        if kcal is None or not GOAL_KCAL[0] <= kcal <= GOAL_KCAL[1]:
            continue
        if any(v is None or not GOAL_GRAMS[0] <= v <= GOAL_GRAMS[1] for v in (protein, carbs, fat)):
            continue
        water = nutrients.parse_number(goals.get("water"))
        if water is None or not GOAL_WATER[0] <= water <= GOAL_WATER[1]:
            water = DEFAULT_WATER_GOAL
        steps = nutrients.parse_number(goals.get("activity.step"))
        steps = round(steps) if steps is not None and act.STEPS_GOAL_RANGE[0] <= steps <= act.STEPS_GOAL_RANGE[1] else None
        return {"kcal": round(kcal), "protein": protein, "carbs": carbs, "fat": fat, "water_ml": round(water), "steps": steps}
    return None


def run_import(
    store: Store, user_id: int, directory: str | Path, all_products: bool = False, dry_run: bool = False
) -> Summary:
    """Import the export in `directory` into the account of one user."""
    return run_import_from(store, user_id, load_folder(directory), all_products, dry_run, str(directory))


def run_import_from(
    store: Store, user_id: int, loaded: dict[str, dict | None], all_products: bool = False, dry_run: bool = False,
    where: str = "the export",
) -> Summary:
    """Import parsed export files into the account of one user (with `dry_run`: count only, write nothing)."""
    started = time.monotonic()
    summary = Summary(dry_run=dry_run)
    plan = build_plan_from(loaded, all_products, summary, where)
    result = store.import_yazio(user_id, plan, dry_run=dry_run)
    summary.days = result["days"]
    summary.entries = Counter({
        "product": result["product_entries"], "recipe": result["recipe_entries"], "quick": result["quick_entries"]})
    summary.foods_created, summary.foods_reused = result["foods"], result["foods_reused"]
    summary.weights, summary.weights_kept = result["weights"], len(plan["weights"]) - result["weights"]
    summary.water, summary.water_kept = result["water"], len(plan["water"]) - result["water"]
    summary.goal_set = result["goal_set"]
    summary.activity_days, summary.activity_kept = result["activity_days"], result["activity_kept"]
    summary.workouts, summary.workouts_already = result["workouts"], result["workouts_already"]
    summary.already_imported = result["already_imported"]
    summary.batch_id = result["batch_id"]
    summary.seconds = time.monotonic() - started
    return summary


def _default_db() -> str:
    return os.environ.get("MAHLWERK_DB", "./data/mahlwerk.db")


def _open(args) -> Store:
    path = args.db or _default_db()
    if not os.path.isfile(path) and not getattr(args, "create_user", False):
        raise YazioError(f"{path}: database file not found (use --db to name it)")
    return Store(path)


def _find_user(store: Store, username: str, create: bool) -> dict:
    if is_reserved_name(username):  # the demo account holds invented data only; a real diary never goes there
        raise YazioError(f"{username!r} is reserved for the demo account")
    user = store.find_user(username)
    if user is None and create:
        user = store.get_or_create_user(username, username)
    if user is None:
        names = ", ".join(store.usernames()) or "(none yet)"
        raise YazioError(f"unknown user {username!r}; existing users: {names} (--create-user adds one)")
    return user


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mahlwerk.yazio", description="Import an exported Yazio diary.")
    sub = parser.add_subparsers(dest="command", required=True)
    db_help = "database file (default: MAHLWERK_DB or ./data/mahlwerk.db)"
    imp = sub.add_parser("import", help="import the files of an export folder into one user's account")
    imp.add_argument("--user", required=True, help="user name (the name the app knows you by)")
    imp.add_argument("--dir", required=True, help="folder with products.json, days.json and weight.json")
    imp.add_argument("--db", default=None, help=db_help)
    imp.add_argument("--all-products", action="store_true", help="also import products that were never eaten")
    imp.add_argument("--dry-run", action="store_true", help="only show the summary, write nothing")
    imp.add_argument("--create-user", action="store_true", help="create the user if the name is unknown")
    lst = sub.add_parser("list", help="show import batches")
    lst.add_argument("--user", default=None)
    lst.add_argument("--db", default=None, help=db_help)
    rem = sub.add_parser("remove", help="take back one import batch")
    rem.add_argument("--batch", type=int, required=True)
    rem.add_argument("--db", default=None, help=db_help)
    args = parser.parse_args(argv)

    try:
        store = _open(args)
        if args.command == "import":
            user = _find_user(store, args.user, args.create_user and not args.dry_run)
            summary = run_import(store, user["id"], args.dir, args.all_products, args.dry_run)
            print("\n".join(summary.lines()))
        elif args.command == "list":
            user = _find_user(store, args.user, False) if args.user else None
            batches = store.list_imports(user["id"] if user else None)
            for b in batches:
                when = time.strftime("%Y-%m-%d %H:%M", time.localtime(b["created_at"]))
                print(f"batch {b['id']}  {when}  {b['username']}  {b['kind']}  {json.dumps(b['counts'])}")
            if not batches:
                print("No import batches.")
        else:
            removed = store.remove_import(args.batch)
            if removed is None:
                raise YazioError(f"unknown batch {args.batch}")
            print(
                f"Batch {args.batch} removed: {removed['entries']} entries, {removed['weights']} weights, "
                f"{removed['water']} water days, {removed['activity']} activity days, {removed['workouts']} workouts, "
                f"{removed['foods']} foods, goal {'removed' if removed['goal'] else 'kept'}."
            )
    except YazioError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

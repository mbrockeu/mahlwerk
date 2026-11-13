"""Demo data: invented but plausible diary entries and weights, so the app can be tried out.

The catalog below holds everyday foods with typical nutrition values per 100 g or 100 ml. The numbers are
rounded approximations from general nutrition tables, good enough for a demo and not meant as reference data.

Generation is deterministic per user and day (the random generator is seeded from the user id and the date),
so repeating a call changes nothing and tests are stable. Days with real entries or real weights are never touched.
"""

import random
from datetime import date, datetime, timedelta

from . import activity as act
from .db import Store
from . import nutrients
from .nutrition import PER_100_KEYS, parse_serving

DEFAULT_GOAL = {"kcal": 2100, "protein": 120.0, "carbs": 230.0, "fat": 70.0}

# name, unit, serving, meals (b = breakfast, l = lunch, d = dinner, s = snack), typical portion range,
# per 100: kcal, fat, saturated fat, carbs, sugars, fiber, protein, salt
_CATALOG = [
    ("Haferflocken", "g", "40 g", "b", (40, 80), (372, 7.0, 1.2, 58.7, 1.2, 10.0, 13.5, 0.02)),
    ("Vollmilch 3,5 %", "ml", "200 ml", "bd", (150, 250), (65, 3.5, 2.4, 4.8, 4.8, 0.0, 3.4, 0.1)),
    ("Banane", "g", "120 g", "bs", (100, 150), (93, 0.3, 0.1, 20.0, 16.0, 2.0, 1.1, 0.0)),
    ("Vollkornbrot", "g", "50 g", "bd", (50, 110), (215, 1.2, 0.3, 40.0, 3.5, 8.0, 7.5, 1.3)),
    ("Weißbrötchen", "g", "50 g", "b", (50, 100), (270, 1.0, 0.2, 54.0, 3.0, 3.0, 9.0, 1.3)),
    ("Gouda", "g", "30 g", "bd", (20, 60), (356, 27.0, 17.5, 0.1, 0.1, 0.0, 25.0, 1.8)),
    ("Butter", "g", "10 g", "bd", (5, 15), (741, 82.0, 52.0, 0.6, 0.6, 0.0, 0.7, 0.02)),
    ("Frischkäse natur", "g", "30 g", "bd", (20, 40), (250, 23.0, 15.0, 3.0, 3.0, 0.0, 6.0, 0.7)),
    ("Putenbrust Aufschnitt", "g", "30 g", "bd", (20, 60), (105, 1.5, 0.5, 1.0, 1.0, 0.0, 22.0, 1.8)),
    ("Ei", "g", "55 g", "bd", (55, 110), (137, 9.7, 2.8, 0.7, 0.7, 0.0, 12.5, 0.4)),
    ("Joghurt natur", "g", "150 g", "bs", (150, 250), (66, 3.8, 2.5, 4.7, 4.7, 0.0, 3.5, 0.13)),
    ("Skyr natur", "g", "150 g", "bs", (150, 250), (63, 0.2, 0.1, 4.0, 4.0, 0.0, 11.0, 0.1)),
    ("Honig", "g", "15 g", "b", (10, 25), (306, 0.0, 0.0, 75.0, 75.0, 0.0, 0.4, 0.0)),
    ("Orangensaft", "ml", "200 ml", "b", (150, 250), (43, 0.2, 0.0, 9.5, 9.0, 0.2, 0.7, 0.0)),
    ("Erdnussbutter", "g", "15 g", "bs", (10, 25), (600, 50.0, 10.0, 10.0, 6.0, 6.0, 25.0, 1.0)),
    ("Apfel", "g", "150 g", "bs", (120, 200), (54, 0.2, 0.0, 11.4, 10.0, 2.0, 0.3, 0.0)),
    ("Erdbeeren", "g", "150 g", "bs", (100, 200), (32, 0.4, 0.0, 5.5, 5.5, 2.0, 0.7, 0.0)),
    ("Nussmischung", "g", "30 g", "s", (20, 40), (620, 54.0, 7.0, 10.0, 5.0, 7.0, 20.0, 0.0)),
    ("Zartbitterschokolade", "g", "25 g", "s", (15, 40), (540, 36.0, 22.0, 40.0, 30.0, 10.0, 7.0, 0.02)),
    ("Butterkekse", "g", "25 g", "s", (15, 40), (450, 12.0, 7.0, 74.0, 20.0, 2.5, 7.0, 0.7)),
    ("Salzstangen", "g", "30 g", "s", (20, 40), (380, 2.0, 0.4, 75.0, 3.0, 3.0, 10.0, 5.0)),
    ("Apfelschorle", "ml", "250 ml", "ls", (200, 400), (24, 0.0, 0.0, 5.8, 5.8, 0.0, 0.0, 0.0)),
    ("Karotte", "g", "80 g", "ls", (60, 150), (36, 0.2, 0.0, 7.0, 6.0, 2.8, 0.9, 0.1)),
    ("Hähnchenbrust", "g", "150 g", "ld", (120, 200), (150, 3.5, 0.9, 0.0, 0.0, 0.0, 30.0, 0.2)),
    ("Lachs", "g", "150 g", "ld", (120, 180), (202, 12.0, 2.5, 0.0, 0.0, 0.0, 22.0, 0.15)),
    ("Hackfleisch gebraten", "g", "120 g", "ld", (100, 150), (260, 19.0, 8.0, 0.0, 0.0, 0.0, 22.0, 0.5)),
    ("Reis gekocht", "g", "180 g", "ld", (150, 250), (130, 0.3, 0.1, 28.0, 0.1, 0.4, 2.7, 0.01)),
    ("Spaghetti gekocht", "g", "220 g", "ld", (200, 300), (158, 0.9, 0.2, 31.0, 0.6, 1.8, 5.8, 0.01)),
    ("Kartoffeln gekocht", "g", "250 g", "ld", (200, 350), (71, 0.1, 0.0, 14.8, 0.8, 1.7, 2.0, 0.01)),
    ("Linsen gekocht", "g", "200 g", "l", (150, 250), (116, 0.4, 0.1, 20.0, 1.0, 8.0, 9.0, 0.01)),
    ("Tomatensoße", "g", "150 g", "l", (100, 200), (55, 2.5, 0.3, 6.5, 5.5, 1.5, 1.6, 0.8)),
    ("Brokkoli gegart", "g", "150 g", "ld", (100, 200), (28, 0.4, 0.1, 2.4, 1.4, 3.0, 3.1, 0.02)),
    ("Paprika", "g", "120 g", "ld", (80, 150), (31, 0.3, 0.1, 6.0, 5.0, 2.0, 1.0, 0.01)),
    ("Tomate", "g", "100 g", "ld", (80, 200), (18, 0.2, 0.0, 2.6, 2.5, 1.2, 0.9, 0.01)),
    ("Gurke", "g", "100 g", "ld", (60, 150), (12, 0.2, 0.0, 1.8, 1.7, 0.5, 0.6, 0.01)),
    ("Blattsalat", "g", "60 g", "ld", (50, 100), (15, 0.2, 0.0, 1.5, 1.2, 1.5, 1.3, 0.05)),
    ("Mozzarella", "g", "125 g", "ld", (60, 125), (241, 17.5, 11.0, 1.0, 1.0, 0.0, 18.0, 0.6)),
    ("Hüttenkäse", "g", "100 g", "ld", (80, 150), (98, 4.3, 2.7, 3.3, 3.3, 0.0, 12.5, 0.8)),
    ("Olivenöl", "ml", "10 ml", "ld", (5, 15), (884, 100.0, 14.0, 0.0, 0.0, 0.0, 0.0, 0.0)),
]

# A few realistic micronutrients per 100 g/ml for about a third of the foods (units as in nutrients.py), so that the
# evaluation has something to show and the coverage stays visibly below 100 %. Rounded table values.
_MICROS: dict[str, dict[str, float]] = {
    "Haferflocken": {"magnesium": 129, "iron": 4.3, "zinc": 4.3, "phosphorus": 410, "potassium": 370, "manganese": 4.9, "vitamin_b1": 0.5, "vitamin_b9": 87},
    "Vollmilch 3,5 %": {"calcium": 120, "potassium": 155, "phosphorus": 92, "iodine": 10, "vitamin_b2": 0.18, "vitamin_b12": 0.4, "vitamin_d": 0.1},
    "Banane": {"potassium": 360, "magnesium": 27, "vitamin_c": 9, "vitamin_b6": 0.37, "manganese": 0.27},
    "Vollkornbrot": {"magnesium": 70, "iron": 2.5, "zinc": 2.5, "potassium": 230, "vitamin_b1": 0.2, "vitamin_b9": 40},
    "Ei": {"vitamin_d": 2.0, "vitamin_b12": 1.9, "iodine": 12, "selenium": 30, "vitamin_b7": 25, "vitamin_a": 160, "vitamin_b2": 0.4, "iron": 1.9, "cholesterol": 400},
    "Skyr natur": {"calcium": 120, "phosphorus": 170, "potassium": 150, "vitamin_b12": 0.5, "iodine": 4},
    "Orangensaft": {"vitamin_c": 40, "potassium": 180, "vitamin_b9": 30, "vitamin_b1": 0.07, "magnesium": 10},
    "Nussmischung": {"magnesium": 170, "vitamin_e": 10, "zinc": 3.0, "copper": 1.2, "manganese": 2.0, "potassium": 700, "phosphorus": 400},
    "Karotte": {"vitamin_a": 835, "potassium": 320, "vitamin_k": 13, "vitamin_c": 6, "vitamin_b6": 0.14},
    "Lachs": {"vitamin_d": 8.0, "vitamin_b12": 3.5, "selenium": 36, "potassium": 380, "omega_3": 2.0, "vitamin_b6": 0.6, "vitamin_b3": 8.0, "iodine": 30, "cholesterol": 60},
    "Linsen gekocht": {"iron": 3.3, "vitamin_b9": 180, "potassium": 370, "magnesium": 36, "zinc": 1.3, "phosphorus": 180},
    "Hähnchenbrust": {"vitamin_b3": 11.0, "vitamin_b6": 0.5, "potassium": 330, "phosphorus": 220, "selenium": 14, "vitamin_b12": 0.3, "zinc": 0.9},
    "Gouda": {"calcium": 800, "phosphorus": 500, "vitamin_b12": 1.5, "vitamin_a": 250, "vitamin_b2": 0.3, "zinc": 4.0, "iodine": 20},
    "Spaghetti gekocht": {"magnesium": 18, "iron": 0.5, "zinc": 0.7, "phosphorus": 58, "selenium": 10, "vitamin_b1": 0.02},
    "Brokkoli gegart": {"vitamin_c": 90, "vitamin_k": 100, "vitamin_b9": 110, "potassium": 320, "calcium": 47, "vitamin_e": 0.8},
}
assert all(nutrients.plausible(k, v) for micros in _MICROS.values() for k, v in micros.items())

_MEAL_CODES = {"b": "breakfast", "l": "lunch", "d": "dinner", "s": "snack"}
_SHARES = {"breakfast": 0.25, "lunch": 0.35, "snack": 0.10, "dinner": 0.30}
_PICKS = {"breakfast": (2, 3), "lunch": (3, 3), "snack": (1, 2), "dinner": (2, 3)}


def _food_data(row: tuple) -> dict:
    name, unit, serving, _meals, _portion, values = row
    parsed = parse_serving(serving)
    return {
        "name": name,
        "brand": None,
        "quantity": None,
        "serving_size": serving,
        "serving_quantity": parsed[0] if parsed else None,
        "unit": unit,
        "per_100": dict(zip(PER_100_KEYS, values)),
        "extra": _MICROS.get(name, {}),
        "complete": True,
    }


FOODS: dict[str, dict] = {row[0]: _food_data(row) for row in _CATALOG}
_BY_MEAL: dict[str, list[tuple]] = {
    meal: [row for row in _CATALOG if code in row[3]] for code, meal in _MEAL_CODES.items()
}


def _step(amount: float) -> int:
    return max(1, round(amount / 5) * 5 if amount >= 40 else round(amount))


def _meal(rng: random.Random, meal: str, kcal: float) -> list[tuple[str, int]]:
    """Pick foods for one meal and size the portions so that the meal lands near `kcal`."""
    pool = _BY_MEAL[meal]
    picked: list[tuple] = []
    for _ in range(12):
        picked = rng.sample(pool, rng.randint(*_PICKS[meal]))
        reach = sum(r[5][0] * r[4][1] * 2 / 100 for r in picked)  # what the largest sensible portions give
        if reach >= kcal:
            break
    base = [rng.uniform(*r[4]) for r in picked]
    have = sum(a * r[5][0] / 100 for a, r in zip(base, picked))
    factor = kcal / have if have else 1
    return [
        (r[0], min(5000, _step(min(max(a * factor, r[4][0] * 0.4), r[4][1] * 2))))
        for a, r in zip(base, picked)
    ]


def _day(rng: random.Random, target: float, today: bool) -> list[dict]:
    meals = ["breakfast", "lunch"] if today else ["breakfast", "lunch", "dinner"]
    if not today and rng.random() < 0.75:
        meals.append("snack")
    scale_to = 1.0 if today else 1 / sum(_SHARES[m] for m in meals)
    return [
        {"meal": meal, "food": name, "amount": amount}
        for meal in meals
        for name, amount in _meal(rng, meal, target * _SHARES[meal] * scale_to)
    ]


# Demo workouts: a kind with its usual minutes range and kilometres per hour (None: no distance)
_WORKOUTS = (
    ("running", (25, 55), 9.5), ("cycling", (40, 110), 18.0), ("walking", (30, 70), 5.0), ("strength", (35, 65), None),
    ("swimming", (25, 50), 2.0), ("yoga", (30, 60), None), ("hiking", (90, 180), 4.5), ("crosstrainer", (25, 45), None),
)


def _training_weekdays(user_id: int, monday: date) -> set[int]:
    """The weekdays (Monday = 0) with a workout in the week starting at `monday`: two to four of them."""
    rng = random.Random(f"mahlwerk-demo:{user_id}:training-week:{monday.isoformat()}")
    return set(rng.sample(range(7), rng.randint(2, 4)))


def _activity_day(rng: random.Random, today: bool, weekday: int, weight: float, trains: bool) -> tuple[dict, list[dict]]:
    """Steps, active energy and, when `trains`, one workout of a demo day."""
    steps = round(rng.gauss(8600 if weekday < 5 else 10200, 2400))
    steps = max(1800, min(steps, 22000))
    workouts: list[dict] = []
    if trains and not today:
        kind, (low, high), speed = _WORKOUTS[rng.randrange(len(_WORKOUTS))]
        minutes = round(rng.uniform(low, high) / 5) * 5
        hour = rng.choice((6, 7, 12, 17, 18, 19))
        workouts.append({
            "kind": kind, "minutes": float(minutes), "started_at": hour * 3600 + rng.randrange(0, 3600, 300),  # shifted to the day below
            "kcal": round(act.estimate_kcal(kind, minutes, weight) * rng.uniform(0.85, 1.1)),
            "distance_m": round(speed * minutes / 60 * 1000 / 10) * 10 if speed else None,
            "steps": round(minutes * 150) if kind in ("running", "walking", "hiking") else None,
        })
    if today:  # the day is still young
        steps = round(steps * rng.uniform(0.2, 0.5))
    energy = round(steps * 0.04 + sum(w["kcal"] for w in workouts) + rng.uniform(40, 110))
    return {"steps": steps, "active_kcal": float(energy), "distance_m": float(round(steps * 0.74 / 10) * 10)}, workouts


def _rng(user_id: int, day: str, kind: str) -> random.Random:
    return random.Random(f"mahlwerk-demo:{user_id}:{kind}:{day}")


def generate(store: Store, user_id: int, today: date, days: int, marker: str = "demo") -> dict:
    """Fill the last `days` days up to `today`. Returns the number of new rows and whether a goal was set.
    `marker` says which kind of demo food the entries refer to (see Store.add_demo)."""
    first = today - timedelta(days=days - 1)
    real_days, demo_days = store.diary_days(user_id, first.isoformat(), today.isoformat())
    weighed = store.weight_days(user_id, first.isoformat(), today.isoformat())
    watered = store.water_days(user_id, first.isoformat(), today.isoformat())
    active_days, workout_days = store.activity_days(user_id, first.isoformat(), today.isoformat())

    goal = store.get_goal(user_id)
    goal_set = goal is None
    if goal_set:
        goal = DEFAULT_GOAL

    entries: list[dict] = []
    weights: list[dict] = []
    water: list[dict] = []
    activity: list[dict] = []
    workouts: list[dict] = []
    start_kg = 74 + (user_id * 7) % 12
    for offset in range(days):
        current = first + timedelta(days=offset)
        iso = current.isoformat()
        is_today = current == today
        if iso not in real_days and iso not in demo_days:
            rng = _rng(user_id, iso, "diary")
            if is_today or rng.random() >= 1 / 12:  # about every twelfth day stays empty
                low, high = (-0.08, 0.15) if current.weekday() >= 5 else (-0.15, 0.10)
                target = goal["kcal"] * (1 + rng.uniform(low, high))
                entries += [{"day": iso, **e} for e in _day(rng, target, is_today)]
        if iso not in weighed:
            rng = _rng(user_id, iso, "weight")
            if rng.random() < 5 / 7:
                kg = start_kg + 0.035 * (today - current).days + rng.uniform(-0.4, 0.4)
                weights.append({"day": iso, "kg": round(kg, 1)})
        if iso not in watered:
            rng = _rng(user_id, iso, "water")
            if is_today:  # the day is still young
                water.append({"day": iso, "ml": rng.randint(1, 4) * 250})
            elif rng.random() >= 1 / 10:
                water.append({"day": iso, "ml": rng.randint(5, 11) * 250})

        if iso not in active_days:
            rng = _rng(user_id, iso, "activity")
            weight = start_kg + 0.035 * (today - current).days
            day_activity, day_workouts = _activity_day(
                rng, is_today, current.weekday(), weight,
                current.weekday() in _training_weekdays(user_id, current - timedelta(days=current.weekday())))
            activity.append({"day": iso, **day_activity})
            if iso not in workout_days:
                midnight = int(datetime(current.year, current.month, current.day).timestamp())
                workouts += [{"day": iso, **w, "started_at": midnight + w["started_at"]} for w in day_workouts]

    if not (entries or weights or water or activity or workouts):
        return {"entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0, "foods": 0, "goal_set": False}
    if goal_set:
        store.set_goal(user_id, DEFAULT_GOAL)
    return {**store.add_demo(user_id, FOODS, entries, weights, water, activity, workouts, marker=marker), "goal_set": goal_set}


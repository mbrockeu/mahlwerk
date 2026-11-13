"""Badges: small rewards for habits (keeping at it, logging, eating in balance), never for eating less or losing weight.

Every badge is a pure function of the person's data and returns its progress as `(current, target)`; the badge is
reached when `current >= target`. Nothing here compares people, and nothing is ever taken away because of a bad
day: once a badge is reached it is remembered (table `badge_earned`). The only exception is a badge that was reached
with demo entries alone; it goes away when the demo data is removed (see Store.record_badges / remove_demo).

See docs/api-v1.md (GET /api/v1/badges).
"""

from datetime import date
from typing import Callable

from . import activity
from .activity import day_goal_kcal
from .insights import adherence_class
from .models import MEALS
from .nutrition import scale

WINDOW = 7  # "x of 7 days" badges look at every run of seven consecutive calendar days
PROTEIN_SHARE = 0.9  # protein goal reached = at least 90 % of it
FIBER_GOAL = 25.0  # grams a day; the lenient floor also used by the evaluation hints
MAIN_MEALS = ("breakfast", "lunch", "dinner")


class Data:
    """What the badges look at, prepared once from the stored rows."""

    def __init__(
        self, entries: list[dict], weight_days: list[str], recipes: int, goal: dict | None, bonus: dict[str, int] | None = None
    ):
        self.days: dict[str, dict] = {}
        self.foods: set[tuple] = set()
        for e in entries:
            values = scale(e["per_100"], e["amount"])
            day = self.days.setdefault(e["day"], {"kcal": 0.0, "protein": 0.0, "fiber": 0.0, "meals": set()})
            for key in ("kcal", "protein", "fiber"):
                day[key] += values[key] or 0.0
            day["meals"].add(e["meal"])
            self.foods.add(("id", e["food_id"]) if e["food_id"] is not None else ("name", e["name"], e["brand"]))
        self.weight_days = set(weight_days)
        self.recipes = recipes
        self.goal = goal
        self.bonus = bonus or {}  # per day: kcal the active energy adds to the calorie goal (empty while that is off)


def _ordinals(days) -> list[int]:
    return sorted(date.fromisoformat(d).toordinal() for d in days)


def longest_run(ordinals: list[int]) -> int:
    """Longest stretch of consecutive numbers in a sorted list without duplicates."""
    best = run = 0
    for i, n in enumerate(ordinals):
        run = run + 1 if i and n == ordinals[i - 1] + 1 else 1
        best = max(best, run)
    return best


def best_window(days) -> int:
    """The most days of `days` that fall into any seven consecutive calendar days."""
    nums = _ordinals(days)
    best, start = 0, 0
    for end, n in enumerate(nums):
        while n - nums[start] >= WINDOW:
            start += 1
        best = max(best, end - start + 1)
    return best


def _capped(current: int, target: int) -> tuple[int, int]:
    return min(current, target), target


def first_entry(d: Data) -> tuple[int, int]:
    """The first entry ever. Why: starting is the hardest part."""
    return _capped(len(d.days), 1)


def _streak(d: Data, target: int) -> tuple[int, int]:
    return _capped(longest_run(_ordinals(d.days)), target)


def streak_3(d: Data) -> tuple[int, int]:
    """Three days in a row with at least one entry (the longest run ever counts). Why: a first rhythm."""
    return _streak(d, 3)


def streak_7(d: Data) -> tuple[int, int]:
    """Seven days in a row with at least one entry. Why: a whole week of logging."""
    return _streak(d, 7)


def streak_30(d: Data) -> tuple[int, int]:
    """Thirty days in a row with at least one entry. Why: a habit that has settled in."""
    return _streak(d, 30)


def streak_100(d: Data) -> tuple[int, int]:
    """One hundred days in a row with at least one entry. Why: long-term staying power."""
    return _streak(d, 100)


def scans_10(d: Data) -> tuple[int, int]:
    """Ten different foods logged (scanned, searched or typed). Why: the diary starts to know your kitchen."""
    return _capped(len(d.foods), 10)


def scans_50(d: Data) -> tuple[int, int]:
    """Fifty different foods logged. Why: variety on the plate."""
    return _capped(len(d.foods), 50)


# Not offered: `own_product` (a product created or corrected by the person). Foods are shared by all users and
# store no author, so it cannot be told per user. `first_recipe` is possible because recipes keep `created_by`.


def first_recipe(d: Data) -> tuple[int, int]:
    """A recipe saved by the person. Why: cooking for yourself is worth noting."""
    return _capped(d.recipes, 1)


def protein_week(d: Data) -> tuple[int, int]:
    """The protein goal (at least 90 % of it) on 5 of any 7 consecutive days. Needs a goal."""
    if not d.goal or d.goal["protein"] <= 0:
        return 0, 5
    hit = [k for k, v in d.days.items() if v["protein"] >= d.goal["protein"] * PROTEIN_SHARE]
    return _capped(best_window(hit), 5)


def balanced_week(d: Data) -> tuple[int, int]:
    """Calories within 90-110 % of the goal on 5 of any 7 consecutive days. Needs a goal.
    Why: a steady rhythm, not a perfect day."""
    if not d.goal:
        return 0, 5
    hit = [k for k, v in d.days.items() if adherence_class(v["kcal"], day_goal_kcal(d.goal["kcal"], d.bonus, k)) == "in"]
    return _capped(best_window(hit), 5)


def fiber_5(d: Data) -> tuple[int, int]:
    """At least 25 g of fibre on 5 of any 7 consecutive days. Why: vegetables, pulses and whole grains."""
    return _capped(best_window([k for k, v in d.days.items() if v["fiber"] >= FIBER_GOAL]), 5)


def weigh_in_4(d: Data) -> tuple[int, int]:
    """At least one weight entered in each of 4 consecutive calendar weeks (Monday to Sunday).
    Why: looking now and then is enough; no particular value is rewarded."""
    weeks = sorted({(date.fromisoformat(x).toordinal() - date.fromisoformat(x).weekday()) // 7 for x in d.weight_days})
    return _capped(longest_run(weeks), 4)


def full_day_10(d: Data) -> tuple[int, int]:
    """Ten days on which breakfast, lunch and dinner were all logged. Why: a complete picture of the day."""
    return _capped(sum(1 for v in d.days.values() if all(m in v["meals"] for m in MAIN_MEALS)), 10)


assert set(MAIN_MEALS) <= set(MEALS)

# the order is the order of the badge wall
BADGES: tuple[tuple[str, Callable[[Data], tuple[int, int]]], ...] = (
    ("first_entry", first_entry),
    ("streak_3", streak_3),
    ("streak_7", streak_7),
    ("streak_30", streak_30),
    ("streak_100", streak_100),
    ("scans_10", scans_10),
    ("scans_50", scans_50),
    ("first_recipe", first_recipe),
    ("protein_week", protein_week),
    ("balanced_week", balanced_week),
    ("fiber_5", fiber_5),
    ("weigh_in_4", weigh_in_4),
    ("full_day_10", full_day_10),
)
CODES = tuple(code for code, _ in BADGES)


def progress(d: Data) -> dict[str, tuple[int, int]]:
    return {code: fn(d) for code, fn in BADGES}


def reached(d: Data) -> set[str]:
    return {code for code, (cur, target) in progress(d).items() if cur >= target}


def overview(store, user_id: int, goal: dict | None) -> dict:
    """Bring the remembered badges up to date and describe them: earned, still open (with progress) and new."""
    entries, weights, recipes = store.badge_inputs(user_id)
    bonus = activity.goal_bonuses(store, user_id, "0000-01-01", "9999-12-31")
    everything = Data(entries, [w["day"] for w in weights], recipes, goal, bonus)
    real = Data([e for e in entries if not e["demo"]], [w["day"] for w in weights if not w["demo"]], recipes, goal, bonus)
    store.record_badges(user_id, reached(everything), reached(real))
    return describe(store.badges_earned(user_id), progress(everything))


def describe(earned_rows: list[dict], current: dict[str, tuple[int, int]]) -> dict:
    earned = [r for r in earned_rows if r["code"] in current]
    got = {r["code"] for r in earned}
    return {
        "earned": [{"code": r["code"], "earned_at": r["earned_at"], "seen": bool(r["seen"])} for r in earned],
        "open": [
            {"code": code, "progress": {"current": cur, "target": target}}
            for code, (cur, target) in current.items()
            if code not in got
        ],
        "new": [r["code"] for r in earned if not r["seen"]],
    }


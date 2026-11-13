"""Activity: steps, active energy and workouts.

This module holds everything that is a rule rather than storage:

- the directory of workout kinds (key, MET value for the estimate, icon name) and the names other systems use,
- the kcal estimate of a workout (MET x body weight x hours),
- the ONE place that decides the kcal goal of a day: `day_goal_kcal`. With the user setting `activity.add_to_goal`
  switched on, a day's goal is the calorie goal plus that day's active energy; without it the goal is the plain
  calorie goal. The day view, "kcal left", the summary for home automation, the adherence of the insights (bars,
  calendar, counts), the badges and the weekly review all ask here, none of them adds anything on its own.

See docs/api-v1.md (Activity).
"""

from dataclasses import dataclass

DEFAULT_STEPS_GOAL = 8000
STEPS_GOAL_RANGE = (1000, 50000)
DEFAULT_WEIGHT_KG = 75.0  # used for the estimate when the user has never entered a weight

MAX_STEPS = 200_000
MAX_ACTIVE_KCAL = 20_000
MAX_DISTANCE_M = 500_000
MAX_MINUTES = 1440
MAX_WORKOUT_KCAL = 20_000

SOURCES = ("manual", "health", "yazio", "demo")


@dataclass(frozen=True)
class Kind:
    key: str
    met: float  # metabolic equivalent: kcal per kg of body weight per hour (Compendium of Physical Activities, rounded)
    icon: str


KINDS: dict[str, Kind] = {k.key: k for k in (
    Kind("walking", 3.5, "walk"),
    Kind("running", 9.8, "run"),
    Kind("cycling", 7.5, "bike"),
    Kind("hiking", 6.0, "mountain"),
    Kind("swimming", 6.0, "swim"),
    Kind("strength", 5.0, "dumbbell"),
    Kind("yoga", 2.5, "lotus"),
    Kind("pilates", 3.0, "lotus"),
    Kind("crosstrainer", 5.0, "bolt"),
    Kind("stairs", 8.8, "stairs"),
    Kind("circuit", 8.0, "bolt"),
    Kind("squash", 7.3, "ball"),
    Kind("bowling", 3.0, "ball"),
    Kind("dancing", 5.0, "music"),
    Kind("football", 7.0, "ball"),
    Kind("tennis", 7.3, "ball"),
    Kind("skiing", 7.0, "mountain"),
    Kind("rowing", 7.0, "swim"),
    Kind("other", 4.0, "bolt"),
)}

# Names other systems use, compared in lower case without spaces, dashes and underscores. Yazio: walking, running,
# cycling, hiking, strengthtraining, yoga, pilates, crosstrainer, stairclimbing, circuittrainingcardio, squash, bowling.
_ALIASES = {
    "strengthtraining": "strength", "traditionalstrengthtraining": "strength", "functionalstrengthtraining": "strength",
    "stairclimbing": "stairs", "stairstepper": "stairs", "stairs": "stairs",
    "circuittrainingcardio": "circuit", "circuittraining": "circuit", "highintensityintervaltraining": "circuit",
    "elliptical": "crosstrainer", "ellipticaltrainer": "crosstrainer",
    "dance": "dancing", "socialdance": "dancing", "soccer": "football",
    "downhillskiing": "skiing", "crosscountryskiing": "skiing", "skiing": "skiing",
    "indoorrowing": "rowing", "rower": "rowing",
    "bike": "cycling", "biking": "cycling", "outdoorcycling": "cycling", "indoorcycling": "cycling",
    "walk": "walking", "outdoorwalk": "walking", "outdoorrun": "running", "run": "running", "jogging": "running",
    "hike": "hiking", "swim": "swimming", "poolswim": "swimming", "openwaterswim": "swimming",
}


def _norm(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum())


def resolve_kind(kind: str | None, name: str | None = None) -> tuple[str, str]:
    """(key, name) for a workout described by a kind and/or a free name: a key of `KINDS` or a known alias wins, then
    the name is tried the same way. Anything unknown becomes `other` and keeps the text that was given as its name."""
    given = (name or "").strip()[:100]
    for text in (kind, name):
        if text:
            n = _norm(text)
            key = n if n in KINDS else _ALIASES.get(n)
            if key:
                return key, given
    return "other", given or (kind or "").strip()[:100]


def estimate_kcal(kind: str, minutes: float, weight_kg: float | None) -> float:
    """MET x body weight (kg) x hours."""
    return KINDS.get(kind, KINDS["other"]).met * (weight_kg or DEFAULT_WEIGHT_KG) * minutes / 60


# the one rule for the day's goal ------------------------------------------------------------------------------


def goal_bonus(active_kcal: float | None, add_to_goal: bool) -> int:
    """The kcal that the active energy adds to the day's goal: 0 unless the setting is on."""
    return round(active_kcal) if add_to_goal and active_kcal and active_kcal > 0 else 0


def day_goal_kcal(goal_kcal: float | None, bonus: dict[str, int] | None, day: str) -> float | None:
    """The kcal goal that counts on `day`: the calorie goal plus that day's bonus (see `goal_bonuses`).
    None without a goal."""
    if goal_kcal is None:
        return None
    return goal_kcal + (bonus or {}).get(day, 0)


def add_to_goal_on(settings: dict) -> bool:
    """The user setting, from `Store.get_settings`."""
    value = settings.get("activity")
    return bool(isinstance(value, dict) and value.get("add_to_goal"))


def goal_bonuses(store, user_id: int, first: str, last: str, settings: dict | None = None) -> dict[str, int]:
    """Bonus per day for `first`..`last` (both included); empty while the setting is off, so callers can pass the
    result around and `day_goal_kcal` simply adds nothing."""
    settings = store.get_settings(user_id) if settings is None else settings
    if not add_to_goal_on(settings):
        return {}
    return {
        day: bonus for day, row in store.activity_between(user_id, first, last).items()
        if (bonus := goal_bonus(row["active_kcal"], True))
    }

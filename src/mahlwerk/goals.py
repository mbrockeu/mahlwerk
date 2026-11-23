"""The goal over time: a change counts from the day it was made, earlier days keep the goal they had then.

Table `goal` holds the current goal, `goal_history` one row per day on which the goal was set (`valid_from`, a later save on
the same day overwrites that day). The row with `valid_from = SINCE_START` means "always": the goal a user had before the
history existed (schema 19) or the one an import brought. A day is judged against the row with the latest `valid_from` on or
before it; a day before the first row gets the first row.

Every judgement per day (calendar, adherence, series, weekly review, badges, the day view, suggestions, water and steps of a
past day) asks `Timeline.on`; a judgement over a period (mean protein against the goal, the nutrient curve's goal line) uses
`Timeline.period`, the mean of the days' goals. The pure functions accept a plain goal dict as well (a goal that never
changed), see `timeline`. See docs/api-v1.md (Goal history).
"""

from bisect import bisect_right

from .activity import day_goal_kcal

SINCE_START = "0001-01-01"
KEYS = ("kcal", "protein", "carbs", "fat", "water_ml", "steps")
_WHOLE = ("water_ml", "steps")


class Timeline:
    """The goals of one user by `valid_from` (never empty)."""

    __slots__ = ("_days", "_goals")

    def __init__(self, rows: list[tuple[str, dict]]):
        if not rows:
            raise ValueError("a timeline needs at least one goal")
        rows = sorted(rows, key=lambda r: r[0])
        self._days = [d for d, _ in rows]
        self._goals = [g for _, g in rows]

    @property
    def current(self) -> dict:
        return self._goals[-1]

    def on(self, day: str) -> dict:
        """The goal that counted on `day` (ISO date)."""
        return self._goals[max(bisect_right(self._days, day) - 1, 0)]

    def period(self, days, fallback: str | None = None) -> dict:
        """The mean goal of `days` (one decimal for kcal and the macros, like `goal_kcal`; whole water and steps). Without days the goal
        of `fallback`, without that the current one."""
        days = list(days)
        if not days:
            return self.on(fallback) if fallback else self.current
        goals = [self.on(d) for d in days]
        out = {}
        for key in KEYS:
            if any(g.get(key) is None for g in goals):  # a hand-made goal dict (tests) may lack water and steps
                continue
            mean = sum(g[key] for g in goals) / len(goals)
            out[key] = round(mean) if key in _WHOLE else round(mean + 0.0, 1)
        return out

    def changes(self) -> list[tuple[str, dict]]:
        return list(zip(self._days, self._goals))


def timeline(goal) -> Timeline | None:
    """None, a Timeline or a plain goal dict (taken as a goal that always counted) -> Timeline or None."""
    if goal is None or isinstance(goal, Timeline):
        return goal
    return Timeline([(SINCE_START, goal)])


def kcal_on(tl: Timeline | None, bonus: dict[str, int] | None, day: str) -> float | None:
    """The kcal goal that counts on `day`: that day's goal plus its active-energy bonus (`activity.day_goal_kcal`)."""
    return None if tl is None else day_goal_kcal(tl.on(day)["kcal"], bonus, day)

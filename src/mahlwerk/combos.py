"""Favourite combos: foods a person often eats TOGETHER in one meal, and which foods fit a meal best.

Pure functions over diary rows (no database, no clock), so they are easy to test. A row is a dict with
`day` (YYYY-MM-DD), `food_id` and `amount`, already limited to ONE meal type and to foods that still exist,
in the order they were logged (`day`, then entry id).

Mining rule:
- Per day the foods of the meal form one set (a food logged twice that day: the amounts are summed).
- Candidates are the day sets with at least 2 foods plus the pairwise intersections of those sets
  (size >= 2). Not every subset is tried; a set larger than MAX_SIZE foods is no candidate itself.
- The support of a candidate is the number of DISTINCT days whose set contains it. It needs MIN_SUPPORT days.
- Maximality: a candidate is dropped when a larger candidate that contains it has at least
  KEEP_RATIO (3/4) of its support, because the larger one then says the same, with more. A smaller set that is
  clearly more common than its supersets stays next to them.
- Ranking: support, then the latest day, then size (all descending). Sets equal to one in `skip` (the food sets
  of existing templates) are left out before the cut to `limit`.
"""

from datetime import date, timedelta

WINDOW_DAYS = 42  # about six weeks
MIN_SUPPORT = 3
MAX_SIZE = 8
KEEP_RATIO = 0.75
LIMIT = 3
HALF_LIFE_DAYS = 14.0  # a day this much older counts half as much for "fits this meal"


def window_start(today: date) -> str:
    return (today - timedelta(days=WINDOW_DAYS - 1)).isoformat()


def _day_sets(rows: list[dict]) -> dict[str, dict[int, float]]:
    """day -> {food_id: amount}, in logging order; the amounts of a food logged twice are summed."""
    days: dict[str, dict[int, float]] = {}
    for row in rows:
        foods = days.setdefault(row["day"], {})
        foods[row["food_id"]] = foods.get(row["food_id"], 0) + row["amount"]
    return days


def mine(rows: list[dict], skip: set[frozenset[int]] | None = None, limit: int = LIMIT) -> list[dict]:
    """The best combos of the rows' meal: `{"foods": [(food_id, amount)], "days", "last_day"}`, best first.
    `amount` is the one of the latest day on which the whole combo was eaten."""
    days = _day_sets(rows)
    sets = {day: frozenset(foods) for day, foods in days.items()}
    big = [s for s in sets.values() if len(s) >= 2]
    candidates: set[frozenset[int]] = {s for s in big if len(s) <= MAX_SIZE}
    unique = list(set(big))
    for i, a in enumerate(unique):
        for b in unique[i + 1:]:
            both = a & b
            if 2 <= len(both) <= MAX_SIZE:
                candidates.add(both)

    found: dict[frozenset[int], tuple[int, str]] = {}
    for cand in candidates:
        eaten = [day for day, s in sets.items() if cand <= s]
        if len(eaten) >= MIN_SUPPORT:
            found[cand] = (len(eaten), max(eaten))

    kept = [
        c for c, (support, _) in found.items()
        if not any(c < other and found[other][0] >= KEEP_RATIO * support for other in found)
    ]
    kept.sort(key=lambda c: (found[c][0], found[c][1], len(c)), reverse=True)

    out = []
    for cand in kept:
        if skip and cand in skip:
            continue
        support, last = found[cand]
        amounts = days[last]
        out.append({"foods": [(f, amounts[f]) for f in amounts if f in cand], "days": support, "last_day": last})
        if len(out) >= limit:
            break
    return out


def fit_scores(rows: list[dict], today: date) -> dict[int, dict]:
    """How well each food fits the rows' meal: `{food_id: {"score", "amount"}}`. The score adds up one weight per
    day the food was eaten in this meal, halving every HALF_LIFE_DAYS (so recent habits count more);
    `amount` is the one of the latest such entry."""
    out: dict[int, dict] = {}
    for row in rows:  # logging order, so the last write is the latest entry
        age = max(0, (today - date.fromisoformat(row["day"])).days)
        item = out.setdefault(row["food_id"], {"score": 0.0, "amount": row["amount"], "days": set()})
        if row["day"] not in item["days"]:
            item["days"].add(row["day"])
            item["score"] += 0.5 ** (age / HALF_LIFE_DAYS)
        item["amount"] = row["amount"]
    return {f: {"score": v["score"], "amount": v["amount"]} for f, v in out.items()}

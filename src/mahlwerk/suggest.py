""""What still fits today": which recipes suit the rest of the day. A pure function, no storage, no network, no clock.

Input: what is left of the day (`Rest`), the recipes as values per portion (`Candidate`), when each was last eaten (days ago,
None = never) and a focus. Output: a ranking with the best amount (a half, one, one and a half or two portions) and one or two
reason codes per recipe. Deterministic: the same input gives the same order (ties go to the lower food id).

The rule, in words:
  * Every recipe is tried at 1, 1/2, 1 1/2 and 2 portions. An amount is possible when its energy does not go beyond the rest of
    the day by more than a little (5 %, at least 30 kcal). The best possible amount of each recipe counts (1 portion wins ties).
    Exception: with the focus "light" (and for the light ideas after the goal) the amount is one portion, a half only when one
    portion does not fit, because lightness would otherwise always pick the smallest amount.
  * fit      how well the energy fills the rest: best when the recipe takes about 60 % of it (room for the other meals), falling
             to 0 at nothing and at the whole rest; a little over the rest scores 0.1.
  * protein  with a protein goal: the share of the protein still missing that the amount covers (at most 1). Without a goal the
             protein density (energy share of protein, 40 % counts as full).
  * variety  days since the recipe was last in the diary (never = full, 21 days or more = full, today = 0); a recipe that was
             eaten in the last two days also loses 0.2 / 0.1, so it moves back.
  * light    the less energy the amount has, the better (800 kcal = 0).
  * carbs and fat beyond what is left cost a little (0.25 for 30 g over, each); protein is never held against a recipe.
  Weights by focus: balanced .40 fit + .30 protein + .30 variety; protein .25 fit + .55 protein + .20 variety; light .55 light +
  .25 fit + .20 variety; rotation .65 variety + .20 fit + .15 protein. Without an energy goal fit does not exist: its weight goes
  to variety and protein ("no_goal" is then said in the state).
  * Goal reached (nothing left): no suggestions, unless the person asks for light ones (`anyway`): then recipes up to 300 kcal
    at a half or one portion, lightest first. Nobody is told what to do; the state only says how things stand.

Reason codes (at most two, in the order the focus cares about): fills_protein, high_protein, fits_kcal, not_eaten_lately, light,
slightly_over. States: ok, goal_reached, no_goal, nothing_fits, no_recipes.
"""

from dataclasses import dataclass, field

FOCI = ("balanced", "protein", "light", "rotation")
FACTORS = (1.0, 0.5, 1.5, 2.0)  # tried in this order; a later one must be strictly better to win
OVER_TOLERANCE = 0.05
OVER_MIN = 30.0
IDEAL_SHARE = 0.6
LONG_AGO = 21
NOT_LATELY = 14
LIGHT_KCAL = 350.0
LIGHT_REFERENCE = 800.0
ANYWAY_MAX_KCAL = 300.0
PROTEIN_FULL_DENSITY = 0.4
FILLS_PROTEIN_SHARE = 0.35
FILLS_PROTEIN_MIN_G = 15.0
HIGH_PROTEIN_DENSITY = 0.25

WEIGHTS = {
    "balanced": {"fit": 0.40, "protein": 0.30, "variety": 0.30, "light": 0.0},
    "protein": {"fit": 0.25, "protein": 0.55, "variety": 0.20, "light": 0.0},
    "light": {"fit": 0.25, "protein": 0.0, "variety": 0.20, "light": 0.55},
    "rotation": {"fit": 0.20, "protein": 0.15, "variety": 0.65, "light": 0.0},
}
REASON_ORDER = {
    "balanced": ("fills_protein", "not_eaten_lately", "fits_kcal", "high_protein", "light", "slightly_over"),
    "protein": ("fills_protein", "high_protein", "fits_kcal", "not_eaten_lately", "slightly_over", "light"),
    "light": ("light", "fits_kcal", "not_eaten_lately", "fills_protein", "high_protein", "slightly_over"),
    "rotation": ("not_eaten_lately", "fits_kcal", "fills_protein", "high_protein", "light", "slightly_over"),
}


@dataclass(frozen=True)
class Rest:
    """What is left of the day; None = no goal for it (so nothing is known)."""
    kcal: float | None
    protein: float | None = None
    carbs: float | None = None
    fat: float | None = None


@dataclass(frozen=True)
class Candidate:
    """A recipe as the values of ONE portion. `portion_amount` is how much of the food one portion is (g or ml)."""
    food_id: int
    kcal: float
    protein: float | None = None
    carbs: float | None = None
    fat: float | None = None
    portion_amount: float = 100.0


@dataclass(frozen=True)
class Suggestion:
    food_id: int
    portions: float
    amount: float
    kcal: float
    protein: float | None
    carbs: float | None
    fat: float | None
    after: Rest
    reasons: tuple[str, ...]
    score: float


@dataclass(frozen=True)
class Result:
    state: str
    items: tuple[Suggestion, ...] = field(default_factory=tuple)
    eligible: int = 0  # recipes that have a possible amount (before the limit)


def _sub(left: float | None, value: float | None) -> float | None:
    return None if left is None or value is None else round(left - value, 1)


def _variety(days_since: int | None) -> float:
    return 1.0 if days_since is None else min(max(days_since, 0), LONG_AGO) / LONG_AGO


def _recency_penalty(days_since: int | None) -> float:
    return 0.2 if days_since is not None and days_since <= 1 else 0.1 if days_since == 2 else 0.0


def _evaluate(c: Candidate, factor: float, rest: Rest, days_since: int | None, focus: str) -> tuple[float, tuple[str, ...]] | None:
    """(score, flags) of this amount, or None when it goes beyond the rest of the day."""
    kcal = c.kcal * factor
    protein = None if c.protein is None else c.protein * factor
    ratio = None
    fit = None
    slightly_over = False
    if rest.kcal is not None:
        if kcal > rest.kcal + max(OVER_MIN, OVER_TOLERANCE * rest.kcal):
            return None
        ratio = kcal / rest.kcal if rest.kcal > 0 else 2.0
        if ratio <= 1.0:
            fit = max(0.0, 1.0 - abs(ratio - IDEAL_SHARE) / IDEAL_SHARE)
        else:
            fit, slightly_over = 0.1, True
    if protein is None:
        prot, flag_protein = 0.0, None
    elif rest.protein is not None and rest.protein > 0:
        share = min(1.0, protein / rest.protein)
        prot = share
        flag_protein = "fills_protein" if share >= FILLS_PROTEIN_SHARE and protein >= FILLS_PROTEIN_MIN_G else None
    else:
        density = 4 * protein / kcal if kcal > 0 else 0.0
        prot = min(1.0, density / PROTEIN_FULL_DENSITY)
        flag_protein = "high_protein" if density >= HIGH_PROTEIN_DENSITY and rest.protein is None else None
    weights = dict(WEIGHTS[focus])
    if fit is None:  # no energy goal: the weight of fit goes to variety and protein
        extra, weights["fit"], fit = weights["fit"], 0.0, 0.0
        weights["variety"] += extra * 0.5
        weights["protein"] += extra * 0.5
    light = 1.0 - min(kcal, LIGHT_REFERENCE) / LIGHT_REFERENCE
    over = 0.0
    for value, left in ((c.carbs, rest.carbs), (c.fat, rest.fat)):
        if value is not None and left is not None:
            over += 0.25 * min(1.0, max(0.0, value * factor - max(left, 0.0)) / 30.0)
    score = (weights["fit"] * fit + weights["protein"] * prot + weights["variety"] * _variety(days_since)
             + weights["light"] * light - over - _recency_penalty(days_since))
    flags = []
    if flag_protein:
        flags.append(flag_protein)
    if ratio is not None and 0.25 <= ratio <= 1.0:
        flags.append("fits_kcal")
    if days_since is None or days_since >= NOT_LATELY:
        flags.append("not_eaten_lately")
    if kcal <= LIGHT_KCAL:
        flags.append("light")
    if slightly_over:
        flags.append("slightly_over")
    return round(score, 6), tuple(flags)


def _reasons(flags: tuple[str, ...], focus: str) -> tuple[str, ...]:
    return tuple(code for code in REASON_ORDER[focus] if code in flags)[:2]


def rank(rest: Rest, candidates: list[Candidate], days_since: dict[int, int | None], focus: str = "balanced",
         limit: int = 5, anyway: bool = False) -> Result:
    """The suggestions for the rest of the day, best first (see the module text)."""
    if focus not in FOCI:
        raise ValueError(f"unknown focus: {focus}")
    usable = [c for c in candidates if c.kcal is not None and c.kcal > 0 and c.portion_amount > 0]
    if not usable:
        return Result("no_recipes")
    reached = rest.kcal is not None and rest.kcal < 1
    if reached and not anyway:
        return Result("goal_reached")
    # asked for light ideas after the goal: no energy fit exists any more (there is nothing left to fit), only lightness
    basis = Rest(None, rest.protein, rest.carbs, rest.fat) if reached else rest
    ranked: list[tuple[float, int, Suggestion]] = []
    for c in sorted(usable, key=lambda x: x.food_id):
        ds = days_since.get(c.food_id)
        best = None
        # "light" ranks recipes by what one portion weighs; the amount is one portion, a half only when one does not fit
        first_fit = reached or focus == "light"
        for factor in ((1.0, 0.5) if reached or focus == "light" else FACTORS):
            if reached and c.kcal * factor > ANYWAY_MAX_KCAL:
                continue
            scored = _evaluate(c, factor, basis, ds, "light" if reached else focus)
            if scored is not None and (best is None or (not first_fit and scored[0] > best[1][0])):
                best = (factor, scored)
        if best is None:
            continue
        factor, (score, flags) = best
        kcal = round(c.kcal * factor, 1)
        item = Suggestion(
            food_id=c.food_id, portions=factor, amount=round(c.portion_amount * factor, 1), kcal=kcal,
            protein=None if c.protein is None else round(c.protein * factor, 1),
            carbs=None if c.carbs is None else round(c.carbs * factor, 1),
            fat=None if c.fat is None else round(c.fat * factor, 1),
            after=Rest(_sub(rest.kcal, kcal), _sub(rest.protein, None if c.protein is None else c.protein * factor),
                       _sub(rest.carbs, None if c.carbs is None else c.carbs * factor), _sub(rest.fat, None if c.fat is None else c.fat * factor)),
            reasons=_reasons(flags, "light" if reached else focus), score=score,
        )
        ranked.append((-score, c.food_id, item))
    ranked.sort(key=lambda t: (t[0], t[1]))
    if not ranked:
        return Result("goal_reached" if reached else "nothing_fits")
    items = tuple(t[2] for t in ranked[:max(1, limit)])
    return Result("goal_reached" if reached else "no_goal" if rest.kcal is None else "ok", items, len(ranked))

"""Request and response bodies of API v1 (see docs/api-v1.md)."""

import unicodedata
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator

from . import activity, ingredients, nutrients

Meal = Literal["breakfast", "lunch", "dinner", "snack"]
Unit = Literal["g", "ml"]
MEALS: tuple[str, ...] = ("breakfast", "lunch", "dinner", "snack")


class Per100(BaseModel):
    kcal: float | None = None
    fat: float | None = None
    saturated_fat: float | None = None
    carbs: float | None = None
    sugars: float | None = None
    fiber: float | None = None
    protein: float | None = None
    salt: float | None = None


def _grams() -> float | None:
    return Field(None, ge=0, le=100)


class Per100In(Per100):
    """Per-100 values typed in by the user: physically possible values only."""

    kcal: float | None = Field(None, ge=0, le=1000)
    fat: float | None = _grams()
    saturated_fat: float | None = _grams()
    carbs: float | None = _grams()
    sugars: float | None = _grams()
    fiber: float | None = _grams()
    protein: float | None = _grams()
    salt: float | None = _grams()


Extra = dict[str, float]
_EXTRA_DESCRIPTION = "additional nutrients per 100 g/ml by key (see GET /api/v1/nutrients); a missing key means unknown"


class FoodImage(BaseModel):
    hash: str = Field(description="32 hex characters; the picture is at `GET /api/v1/images/{hash}/{size}`, sizes `l`, `m`, `s`")
    origin: Literal["own", "cookidoo", "web"] = Field(description="own: a photo somebody set; cookidoo / web: fetched once from the provider")
    credit: str | None = Field(None, description="whose picture it is, for a provider picture: `Cookidoo` or the host of the page")


class Food(BaseModel):
    id: int
    code: str | None = None
    source: Literal["openfoodfacts", "own", "recipe", "yazio", "bls", "cookidoo", "web"] = "openfoodfacts"
    recipe_id: int | None = Field(None, description="the recipe this food is calculated from (source recipe)")
    external_id: str | None = Field(None, description="the id in the system the food came from (`cookidoo:<recipe id>`, `web:<host><path>`, `bls:<code>`)")
    portions: float | None = Field(None, description="how many portions the dish makes (sources cookidoo and web; their values are per portion)")
    url: str | None = Field(None, description="the recipe at its origin (source cookidoo, when the country is known; source web: the address that was taken over, http or https only)")
    name: str | None = None
    brand: str | None = None
    quantity: str | None = None
    serving_size: str | None = None
    serving_quantity: float | None = None
    unit: Unit = "g"
    per_100: Per100
    extra: Extra = Field(default_factory=dict, description=_EXTRA_DESCRIPTION)
    complete: bool = Field(description="kcal, fat, carbs and protein are all present")
    empty: bool = Field(False, description="upstream knows the barcode but has neither a name nor nutrition facts")
    cached: bool
    stale: bool = Field(False, description="served from an expired cache entry because the upstream failed")
    fetched_at: int
    image: FoodImage | None = Field(None, description="the picture of a recipe (own or taken over), if it has one")
    image_removed: bool = Field(False, description="a person took the provider's picture away (`POST /foods/{id}/image/restore` brings it back when the picture switch is on)")


class FoodIn(BaseModel):
    """A product entered or corrected by the user."""

    name: str = Field(min_length=1, max_length=200)
    brand: str | None = Field(None, max_length=200)
    quantity: str | None = Field(None, max_length=60)
    serving_size: str | None = Field(None, max_length=60)
    serving_quantity: float | None = Field(None, gt=0, le=5000)
    unit: Unit = "g"
    per_100: Per100In
    extra: Extra = Field(default_factory=dict, description=_EXTRA_DESCRIPTION)

    @field_validator("extra")
    @classmethod
    def _known_and_plausible(cls, extra: Extra) -> Extra:
        for key, value in extra.items():
            if key not in nutrients.BY_KEY:
                raise ValueError(f"unknown nutrient: {key}")
            if not nutrients.plausible(key, value):
                raise ValueError(f"{key} must be between 0 and {nutrients.BY_KEY[key].max:g} {nutrients.BY_KEY[key].unit}")
        return extra


class RecentFood(BaseModel):
    food: Food
    last_amount: float
    last_meal: Meal


class LabelScan(BaseModel):
    per_100: Per100
    basis: Literal["100g", "100ml"] | None
    warnings: list[str]
    text: str = Field(description="raw OCR text, to judge what went wrong")


class Goal(BaseModel):
    kcal: int = Field(ge=500, le=10000)
    protein: float = Field(ge=0, le=1000)
    carbs: float = Field(ge=0, le=1000)
    fat: float = Field(ge=0, le=1000)
    water_ml: int = Field(2000, ge=500, le=6000, description="daily water goal in ml; goals saved earlier read 2000")
    steps: int = Field(
        activity.DEFAULT_STEPS_GOAL, ge=activity.STEPS_GOAL_RANGE[0], le=activity.STEPS_GOAL_RANGE[1],
        description="daily steps goal; goals saved earlier read 8000, a PUT without it keeps the saved value")


class DemoInfo(BaseModel):
    available: bool = Field(description="the server has demo data switched on (MAHLWERK_DEMO_DATA)")
    entries: int = Field(description="demo diary entries of this user")
    weights: int = Field(description="demo weight values of this user")
    water: int = Field(0, description="demo water days of this user")
    activity: int = Field(0, description="demo activity days of this user")
    workouts: int = Field(0, description="demo workouts of this user")


class CatalogSourceInfo(BaseModel):
    products: int = Field(description="foods in the file of this source; 0 when none is loaded")
    updated_at: int | None = Field(description="when the file was built (unix time), null without file")


class CatalogInfo(CatalogSourceInfo):
    """Open Food Facts (`products`, `updated_at`) and the basic foods of the BLS (`bls`)."""

    bls: CatalogSourceInfo


class FastingSettings(BaseModel):
    enabled: bool = Field(False, description="show the fasting timer on the day view")
    target_hours: float = Field(16, ge=8, le=72)


class FastingSettingsPatch(BaseModel):
    enabled: bool | None = None
    target_hours: float | None = Field(None, ge=8, le=72)


class ActivitySettings(BaseModel):
    add_to_goal: bool = Field(
        False, description="the day's active energy is added to its calorie goal (day view, kcal left, insights, badges)")


class Settings(BaseModel):
    playful: bool = Field(True, description="badges, celebration moment and weekly review card on the day view")
    fasting: FastingSettings = Field(default_factory=FastingSettings)
    activity: ActivitySettings = Field(default_factory=ActivitySettings)
    tour_seen: bool = Field(False, description="the first-run tour of the day view was shown (or skipped) for this user")
    suggestions: bool = Field(True, description="the day view shows the card \"what still fits today\" (suggestions from the recipes; the API answers either way)")


class SettingsPatch(BaseModel):
    playful: bool | None = None
    fasting: FastingSettingsPatch | None = Field(None, description="only the given fields change")
    activity: ActivitySettings | None = None
    tour_seen: bool | None = None
    suggestions: bool | None = None


class MeFeatures(BaseModel):
    access_tokens: bool = Field(description="personal access tokens can be created and used (admin switch)")
    webhooks: bool = Field(description="outgoing webhooks can be set up and are delivered (admin switch)")
    cookidoo: bool = Field(False, description="the Cookidoo connector is switched on (admin switch); see /api/v1/cookidoo")
    web_recipes: bool = Field(False, description="the connector for recipes from web pages is switched on (admin switch); see /api/v1/web-recipes")


def clean_name(value: str | None) -> str | None:
    """A chosen display name: no control characters, blanks collapsed, 1-60 characters; empty or None means "unset"."""
    if value is None:
        return None
    if any(unicodedata.category(ch) in ("Cc", "Cs", "Co", "Zl", "Zp") or (unicodedata.category(ch) == "Cf" and ch != "\u200d") for ch in value):
        raise ValueError("the name must not contain control characters or line breaks")
    text = " ".join(value.split())
    if len(text) > 60:
        raise ValueError("the name may have at most 60 characters")
    return text or None


class NamePatch(BaseModel):
    display_name: str | None = Field(None, description="the name to show; empty or null goes back to the provider's name / user name")

    @field_validator("display_name")
    @classmethod
    def _check(cls, value: str | None) -> str | None:
        return clean_name(value)


class DemoAccountInfo(BaseModel):
    can_switch: bool = Field(False, description="the caller is an admin, the demo account is switched on and exists: it may be switched to (POST /me/demo-view/enter)")
    viewing: bool = Field(False, description="this answer is the demo account's: the signed-in admin has switched to it (POST /me/demo-view/leave goes back)")
    real_username: str | None = Field(None, description="while `viewing`: the user name of the admin who is really signed in")
    real_display_name: str | None = Field(None, description="while `viewing`: the name to show for that admin")


class Me(BaseModel):
    username: str = Field(description="sign-in name; cannot be changed")
    display_name: str = Field(description="the name to show: the one the user chose, else the provider's name, else the user name")
    display_name_custom: bool = Field(False, description="the user chose display_name themself")
    provider_name: str | None = Field(None, description="the name the provider delivered (proxy header, OIDC claim, local account), only when it differs from display_name")
    is_admin: bool = Field(False, description="may use the admin area; decided per request, never for an access token")
    goal: Goal | None
    settings: Settings
    demo: DemoInfo
    demo_account: DemoAccountInfo = Field(default_factory=DemoAccountInfo)
    catalog: CatalogInfo
    features: MeFeatures = Field(default_factory=lambda: MeFeatures(access_tokens=True, webhooks=True))


class CatalogItem(BaseModel):
    """A product of the local catalogue; it has no id until it is adopted as a food."""

    source: Literal["openfoodfacts", "bls"]
    code: str
    name: str
    name_en: str | None = Field(None, description="English name (basic foods of the BLS only)")
    brand: str | None
    quantity: str | None
    serving_size: str | None
    serving_quantity: float | None
    unit: Unit
    per_100: Per100
    extra: Extra = Field(default_factory=dict)
    complete: bool


class CatalogRef(BaseModel):
    source: Literal["openfoodfacts", "bls"]
    code: str = Field(min_length=1, max_length=64)


class DemoIn(BaseModel):
    days: int = Field(30, ge=1, le=365)


class DemoCreated(BaseModel):
    entries: int
    weights: int
    water: int = 0
    activity: int = 0
    workouts: int = 0
    foods: int
    goal_set: bool = Field(description="the user had no goal, so a default one was set")


class DemoRemoved(BaseModel):
    entries: int
    weights: int
    water: int = 0
    activity: int = 0
    workouts: int = 0
    foods: int


class ImportCounts(BaseModel):
    days: int = Field(0, description="days that got entries")
    entries: int = 0
    product_entries: int = 0
    recipe_entries: int = 0
    quick_entries: int = 0
    foods: int = Field(0, description="foods this import created")
    weights: int = 0
    water: int = Field(0, description="days with a water value")
    activity_days: int = Field(0, description="days with steps or active energy")
    workouts: int = 0
    goal_set: bool = False


class ImportBatch(BaseModel):
    id: int
    kind: Literal["yazio"]
    created_at: int = Field(description="unix seconds")
    counts: ImportCounts = Field(description="what the run created")


class ImportRemoved(BaseModel):
    entries: int
    weights: int
    water: int
    activity: int = Field(0, description="activity days removed")
    workouts: int = 0
    foods: int = Field(description="created foods that nothing refers to any more")
    goal: bool = Field(description="the goal this import set was removed (only while it was not changed)")


class EntryIn(BaseModel):
    food_id: int
    meal: Meal
    amount: float = Field(gt=0, le=5000)


class EntryPatch(BaseModel):
    amount: float | None = Field(None, gt=0, le=5000)
    meal: Meal | None = None


class Entry(BaseModel):
    id: int
    food_id: int | None
    meal: Meal
    name: str
    brand: str | None
    amount: float
    unit: Unit
    kcal: float | None
    protein: float | None
    carbs: float | None
    fat: float | None


class CopyIn(BaseModel):
    from_day: str
    meal: Meal | None = Field(None, description="only this meal of from_day; without it the whole day")
    to_meal: Meal | None = Field(None, description="put everything into this meal; without it each keeps its own")


class Entries(BaseModel):
    entries: list[Entry]


class MealSummary(BaseModel):
    kcal: float
    entries: list[Entry]


class WeekDay(BaseModel):
    day: str
    logged: bool
    kcal: float


class ExtraTotal(BaseModel):
    amount: float = Field(description="sum of the day in the nutrient's unit; entries without a value count as 0")
    coverage: float = Field(ge=0, le=1, description="share of the day's kcal from entries that state this nutrient")


class NutrientInfo(BaseModel):
    key: str
    group: Literal["fat", "carb", "mineral", "vitamin", "other"]
    unit: Literal["g", "mg", "µg"]
    nrv: float | None = Field(description="EU reference intake for adults per day, null where there is none")


class YesterdayMeal(BaseModel):
    kcal: float
    names: list[str]


class WaterDay(BaseModel):
    ml: int = Field(description="water drunk that day")
    goal_ml: int


class WaterAdd(BaseModel):
    add_ml: int = Field(ge=-2000, le=2000, description="the total stays between 0 and 10000 ml")


class WaterSet(BaseModel):
    ml: int = Field(ge=0, le=10000)


WorkoutKind = Literal[
    "walking", "running", "cycling", "hiking", "swimming", "strength", "yoga", "pilates", "crosstrainer", "stairs",
    "circuit", "squash", "bowling", "dancing", "football", "tennis", "skiing", "rowing", "other",
]
Source = Literal["manual", "health", "yazio", "demo"]


class Workout(BaseModel):
    id: int
    day: str
    started_at: int | None = Field(description="unix seconds, null when the start is unknown")
    kind: WorkoutKind
    name: str = Field(description="free description, may be empty")
    minutes: float
    kcal: float = Field(description="given or, without a value, estimated (see kcal_estimated)")
    kcal_estimated: bool = Field(description="kcal is MET x weight x hours because none was given")
    distance_m: float | None
    steps: int | None
    note: str | None
    source: Source


class DayActivity(BaseModel):
    steps: int | None = None
    steps_goal: int = Field(activity.DEFAULT_STEPS_GOAL)
    active_kcal: float | None = None
    distance_m: float | None = None
    source: Source | None = Field(None, description="where the day's values come from, null without any")
    bonus_kcal: int = Field(0, description="kcal this day adds to the calorie goal (0 unless activity.add_to_goal is on)")
    workouts: list[Workout] = Field(default_factory=list)


class ActivityDay(DayActivity):
    day: str


class ActivityPut(BaseModel):
    """Partial: only the fields that are sent change, `null` clears a value."""

    steps: int | None = Field(None, ge=0, le=activity.MAX_STEPS)
    active_kcal: float | None = Field(None, ge=0, le=activity.MAX_ACTIVE_KCAL)
    distance_m: float | None = Field(None, ge=0, le=activity.MAX_DISTANCE_M)


class WorkoutIn(BaseModel):
    day: str
    kind: str = Field(max_length=100, description="a key of the workout kinds; anything else becomes `other`")
    name: str | None = Field(None, max_length=100)
    minutes: float = Field(gt=0, le=activity.MAX_MINUTES)
    kcal: float | None = Field(None, ge=0, le=activity.MAX_WORKOUT_KCAL, description="without it the kcal are estimated")
    distance_m: float | None = Field(None, ge=0, le=activity.MAX_DISTANCE_M)
    steps: int | None = Field(None, ge=0, le=activity.MAX_STEPS)
    started_at: int | None = Field(None, ge=0)
    note: str | None = Field(None, max_length=500)


class WorkoutPatch(BaseModel):
    """Partial: only the fields that are sent change; `null` clears kcal (back to the estimate), distance, steps, start
    and note."""

    day: str | None = None
    kind: str | None = Field(None, max_length=100)
    name: str | None = Field(None, max_length=100)
    minutes: float | None = Field(None, gt=0, le=activity.MAX_MINUTES)
    kcal: float | None = Field(None, ge=0, le=activity.MAX_WORKOUT_KCAL)
    distance_m: float | None = Field(None, ge=0, le=activity.MAX_DISTANCE_M)
    steps: int | None = Field(None, ge=0, le=activity.MAX_STEPS)
    started_at: int | None = Field(None, ge=0)
    note: str | None = Field(None, max_length=500)


class HealthWorkout(BaseModel):
    external_id: str = Field(min_length=1, max_length=100, description="the id the workout has in Health; makes a resend harmless")
    kind: str | None = Field(None, max_length=100)
    name: str | None = Field(None, max_length=100)
    started_at: int | None = Field(None, ge=0)
    minutes: float = Field(gt=0, le=activity.MAX_MINUTES)
    kcal: float | None = Field(None, ge=0, le=activity.MAX_WORKOUT_KCAL)
    distance_m: float | None = Field(None, ge=0, le=activity.MAX_DISTANCE_M)

    @model_validator(mode="after")
    def _kind_or_name(self):
        if not (self.kind or self.name):
            raise ValueError("kind or name is required")
        return self


class HealthDay(BaseModel):
    day: str
    steps: int | None = Field(None, ge=0, le=activity.MAX_STEPS)
    active_kcal: float | None = Field(None, ge=0, le=activity.MAX_ACTIVE_KCAL)
    distance_m: float | None = Field(None, ge=0, le=activity.MAX_DISTANCE_M)
    weight_kg: float | None = Field(None, ge=20, le=400)
    water_ml: int | None = Field(None, ge=0, le=10000)
    workouts: list[HealthWorkout] = Field(default_factory=list, max_length=50)


class HealthSync(BaseModel):
    days: list[HealthDay] = Field(max_length=400)
    overwrite_manual: bool = Field(False, description="also replace daily activity values that were typed in by hand")


class SyncCounts(BaseModel):
    new: int = 0
    updated: int = 0
    unchanged: int = Field(0, description="already stored with these values")
    skipped: int = Field(0, description="kept as they are because a value typed in by hand exists")


class HealthSyncResult(BaseModel):
    days: int
    activity: SyncCounts
    workouts: SyncCounts
    weights: SyncCounts
    water: SyncCounts


class Day(BaseModel):
    day: str
    goal: Goal | None
    kcal_goal: int | None = Field(
        None, description="the calorie goal that counts today: goal.kcal, plus the day's active energy when activity.add_to_goal is on")
    water: WaterDay
    activity: DayActivity = Field(default_factory=DayActivity)
    totals: Per100
    extra_totals: dict[str, ExtraTotal] = Field(default_factory=dict)
    meals: dict[Meal, MealSummary]
    yesterday: dict[Meal, YesterdayMeal] = Field(
        default_factory=dict, description="the meals of the previous day that had entries (for \"same as yesterday\")"
    )
    streak: int
    week: list[WeekDay]


class HistoryDay(BaseModel):
    day: str
    kcal: float
    protein: float
    carbs: float
    fat: float
    logged: bool


class WeightIn(BaseModel):
    kg: float = Field(ge=20, le=400)


class Weight(BaseModel):
    day: str
    kg: float


class InsightRange(BaseModel):
    # `from` is a Python keyword, so the field is aliased
    model_config = {"populate_by_name": True}
    from_: str = Field(alias="from")
    to: str
    days: int
    logged_days: int


class InsightDay(BaseModel):
    day: str
    logged: bool
    kcal: float
    protein: float
    carbs: float
    fat: float
    sugars: float
    fiber: float
    salt: float
    saturated_fat: float
    weight: float | None
    water_ml: int | None = Field(None, description="water drunk that day, null without a value")
    steps: int | None = Field(None, description="null without a value")
    active_kcal: float | None = None
    workout_minutes: float = 0
    goal_kcal: float | None = Field(None, description="the day's calorie goal (with the active energy when add_to_goal is on)")


class InsightAverages(BaseModel):
    kcal: float
    protein: float
    carbs: float
    fat: float
    sugars: float
    fiber: float
    salt: float
    saturated_fat: float
    water_ml: float = Field(0, description="mean over the days with a water value, 0 without any")
    steps: float = Field(0, description="mean over the days with a steps value, 0 without any")
    active_kcal: float = Field(0, description="mean over the days with an active energy value, 0 without any")
    workout_minutes: float = Field(0, description="mean workout minutes per day of the range")


class InsightWeekday(BaseModel):
    weekday: int = Field(ge=0, le=6, description="Monday = 0")
    logged_days: int
    kcal: float


class InsightMeal(BaseModel):
    meal: Meal
    kcal: float
    share: float


class InsightFood(BaseModel):
    name: str
    brand: str | None
    amount_total: float
    value: float
    share: float
    times: int


class InsightTopFoods(BaseModel):
    kcal: list[InsightFood]
    sugars: list[InsightFood]
    salt: list[InsightFood]
    protein: list[InsightFood]


class InsightTrendPoint(BaseModel):
    day: str
    kg: float


class InsightWeight(BaseModel):
    first: float
    last: float
    change: float
    trend: list[InsightTrendPoint]
    raw: list[InsightTrendPoint] = Field(default_factory=list, description="the measured values, oldest first")


class InsightAdherence(BaseModel):
    in_range_days: int
    over_days: int
    under_days: int


class InsightHint(BaseModel):
    code: str
    params: dict


class InsightMicro(BaseModel):
    key: str
    group: Literal["fat", "carb", "mineral", "vitamin", "other"]
    unit: Literal["g", "mg", "µg"]
    nrv: float | None
    average: float = Field(description="mean per day with entries, in the unit")
    coverage: float = Field(ge=0, le=1, description="share of the range's kcal from entries that state this nutrient")
    percent_nrv: float | None = Field(description="average as a percentage of the NRV, null without an NRV")


class InsightSeriesPoint(BaseModel):
    start: str
    end: str
    label_key: str = Field(description="day: the date; week: 2026-W07 (ISO); month: 2026-02")
    logged_days: int
    days: int
    kcal: float
    protein: float
    carbs: float
    fat: float
    sugars: float
    fiber: float
    salt: float
    saturated_fat: float
    water_ml: int | None = Field(description="mean over the days with a water value, null without any")
    weight: float | None = Field(description="mean of the measurements in the section, null without any")
    steps: int | None = Field(None, description="mean per day with a steps value, null without any")
    active_kcal: int | None = Field(None, description="mean per day with an active energy value, null without any")
    workout_minutes: float = Field(0, description="workout minutes in the section (sum)")
    goal_kcal: float | None = Field(None, description="mean calorie goal of the section's logged days, null without a goal")
    in_range_days: int
    over_days: int
    under_days: int


class InsightCalendarDay(BaseModel):
    day: str
    state: Literal["none", "under", "in_range", "over", "no_goal"]


class InsightExpenditure(BaseModel):
    kcal: int
    low: int
    high: int
    intake: int
    weight_change_kg: float
    kg_per_week: float
    days: int
    weigh_ins: int
    goal_gap: int | None = Field(description="goal minus estimate, null without a goal")


class InsightDelta(BaseModel):
    abs: float
    pct: float | None = None


class InsightDeltas(BaseModel):
    kcal: InsightDelta | None
    protein: InsightDelta | None
    carbs: InsightDelta | None
    fat: InsightDelta | None
    sugars: InsightDelta | None
    fiber: InsightDelta | None
    salt: InsightDelta | None
    water_ml: InsightDelta | None
    steps: InsightDelta | None = None
    active_kcal: InsightDelta | None = None
    workout_minutes: InsightDelta | None = None
    weight_change: InsightDelta | None
    in_range_share: InsightDelta | None


class InsightPrevious(BaseModel):
    range: InsightRange
    averages: InsightAverages
    adherence: InsightAdherence | None
    weight: InsightWeight | None
    logged_days: int
    series: list[InsightSeriesPoint] = Field(default_factory=list)


class Insights(BaseModel):
    range: InsightRange
    first_day: str | None = Field(None, description="first day with an entry of this user, null without any")
    last_day: str | None = None
    granularity: Literal["day", "week", "month"] = "day"
    goal: Goal | None
    goal_kcal: float | None = Field(None, description="mean calorie goal of the logged days (differs from goal.kcal only with add_to_goal)")
    steps_goal: int = activity.DEFAULT_STEPS_GOAL
    days: list[InsightDay]
    series: list[InsightSeriesPoint] = Field(default_factory=list)
    calendar: list[InsightCalendarDay] = Field(default_factory=list)
    expenditure: InsightExpenditure | None = None
    expenditure_missing: list[str] = Field(default_factory=list)
    previous: InsightPrevious | None = None
    deltas: InsightDeltas | None = None
    averages: InsightAverages
    by_weekday: list[InsightWeekday]
    by_meal: list[InsightMeal]
    top_foods: InsightTopFoods
    weight: InsightWeight | None
    adherence: InsightAdherence | None
    micros: list[InsightMicro]
    hints: list[InsightHint]


TemplateName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class TemplateSource(BaseModel):
    day: str
    meal: Meal


class TemplateIn(BaseModel):
    # `from` is a Python keyword, so the field is aliased
    model_config = {"populate_by_name": True}
    name: TemplateName
    from_: TemplateSource = Field(alias="from")


class TemplatePatch(BaseModel):
    name: TemplateName


class TemplateApply(BaseModel):
    day: str
    meal: Meal


class TemplateItem(BaseModel):
    name: str
    brand: str | None
    amount: float
    unit: Unit
    kcal: float | None


class Template(BaseModel):
    id: int
    name: str
    kcal: float
    items: list[TemplateItem]


class RecipeItemIn(BaseModel):
    food_id: int
    amount: float = Field(gt=0, le=20000)


class RecipeIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    portions: float = Field(gt=0, le=1000)
    total_weight: float | None = Field(None, gt=0, le=100000, description="weight of the finished dish in g")
    items: list[RecipeItemIn] = Field(min_length=1, max_length=60)


class RecipeItem(BaseModel):
    food_id: int | None
    name: str
    brand: str | None
    amount: float
    unit: Unit
    kcal: float | None


class Recipe(BaseModel):
    id: int
    food: Food
    portions: float
    total_weight: float | None
    items: list[RecipeItem]
    kcal_per_portion: float | None


class IngredientsIn(BaseModel):
    text: str = Field(description=f"one ingredient per line, German or English; at most {ingredients.MAX_LINES} lines, {ingredients.MAX_LINE} characters each, {ingredients.MAX_TEXT} in all")

    @field_validator("text")
    @classmethod
    def _limits(cls, value: str) -> str:
        if len(value) > ingredients.MAX_TEXT:
            raise ValueError(f"at most {ingredients.MAX_TEXT} characters")
        lines = value.splitlines()
        if len(lines) > ingredients.MAX_LINES:
            raise ValueError(f"at most {ingredients.MAX_LINES} lines")
        if any(len(line) > ingredients.MAX_LINE for line in lines):
            raise ValueError(f"a line may have at most {ingredients.MAX_LINE} characters")
        return value


class IngredientCandidate(BaseModel):
    source: Literal["own", "openfoodfacts", "bls", "yazio"]
    food_id: int | None = Field(None, description="the stored food; null for a catalogue item, which `POST /catalog/adopt` (source + code) turns into one")
    code: str | None = Field(None, description="barcode (stored foods) or catalogue code")
    name: str
    brand: str | None
    unit: Unit
    per_100: Per100


class IngredientLine(BaseModel):
    line: int = Field(description="line number in the text, from 1")
    text: str = Field(description="the line as it was sent")
    quantity: float | None = Field(description="a range such as 2-3 counts as its mean; null when the line has no amount")
    unit: str | None = Field(description="the unit as written (`EL`, `cups`, `Dose`); null without one")
    name: str = Field(description="the ingredient without amount, unit and cutting words")
    note: str | None = Field(description="what was left out of the name: brackets, text after a comma, 'gehackt'")
    optional: bool
    grams: float | None = Field(description="the amount in grams; null when it cannot be worked out")
    ml: float | None = Field(description="the amount in ml, where it is known (a volume was given, or the density of the food is known)")
    estimated: bool = Field(description="grams rests on an assumption: a typical piece weight, an assumed density (1 g/ml) or a spoon or cup of uncertain size")
    basis: Literal["mass", "volume", "explicit", "piece", "unit", "none"] = Field(
        description="where grams comes from: the given mass, a volume, a weight given in brackets, a typical piece weight, a typical weight of the unit (bunch, clove, ...), or nothing")
    candidates: list[IngredientCandidate] = Field(description="at most 5 foods that may be meant: own foods, then basic foods, then packaged products")
    suggestion: IngredientCandidate | None = Field(description="the best candidate (the first); null when there is none")


class IngredientMatches(BaseModel):
    lines: list[IngredientLine]
    ignored: int = Field(description="non-empty lines that hold no ingredient (headings such as 'For the dough:') and are left out")


class BadgeEarned(BaseModel):
    code: str
    earned_at: int = Field(description="unix time when the badge was first reached")
    seen: bool


class BadgeProgress(BaseModel):
    current: int
    target: int


class BadgeOpen(BaseModel):
    code: str
    progress: BadgeProgress


class Badges(BaseModel):
    earned: list[BadgeEarned]
    open: list[BadgeOpen]
    new: list[str] = Field(description="codes reached but not yet marked as seen")


class BadgesSeenIn(BaseModel):
    codes: list[str] = Field(max_length=100)


class ReviewHighlight(BaseModel):
    code: str
    params: dict


class ReviewDay(BaseModel):
    day: str
    logged: bool
    kcal: float
    state: Literal["in", "over", "under"] | None = Field(description="against the calorie goal; null when not logged or no goal")


class Review(BaseModel):
    model_config = {"populate_by_name": True}
    week: str
    from_: str = Field(alias="from")
    to: str
    logged_days: int
    kcal_avg: float
    goal: Goal | None
    days: list[ReviewDay]
    best: ReviewHighlight | None
    improve: ReviewHighlight | None
    badges: list[str]


class Fast(BaseModel):
    id: int
    started_at: int = Field(description="unix seconds (UTC)")
    ended_at: int | None
    target_hours: float
    elapsed_seconds: int = Field(description="until ended_at, or until now for the open fast")
    duration_seconds: int | None = Field(description="only for a finished fast")
    target_reached: bool


class Fasting(BaseModel):
    current: Fast | None
    last: Fast | None = Field(description="the latest finished fast")
    recent: list[Fast] = Field(description="up to 14 finished fasts, newest first")


class FastStart(BaseModel):
    started_at: int | None = Field(None, description="unix seconds, up to 48 h back, never in the future")
    target_hours: float | None = Field(None, ge=8, le=72, description="default: the setting")


class FastStop(BaseModel):
    ended_at: int | None = Field(None, description="unix seconds, not before the start and not in the future")


class FastPatch(BaseModel):
    started_at: int | None = None
    ended_at: int | None = None
    target_hours: float | None = Field(None, ge=8, le=72)


assert set(get_args(WorkoutKind)) == set(activity.KINDS), "WorkoutKind and activity.KINDS must list the same kinds"

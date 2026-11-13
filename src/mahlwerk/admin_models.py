"""Request and response bodies of the integrations and the admin area (see docs/api-v1.md)."""

from typing import Literal

from pydantic import BaseModel, Field, StringConstraints
from typing import Annotated

from .models import CatalogInfo

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
EventName = Literal[
    "entry.created", "entry.updated", "entry.deleted", "weight.recorded", "water.changed",
    "fasting.started", "fasting.ended", "goal.changed", "badge.earned", "activity.recorded", "workout.created",
]


class TokenIn(BaseModel):
    name: Name
    scope: Literal["read", "write"]
    expires_in_days: int | None = Field(None, ge=1, le=3650, description="without it the token does not expire")


class Token(BaseModel):
    id: int
    name: str
    prefix: str = Field(description="the first characters of the token, to recognise it in the list")
    scope: Literal["read", "write"]
    created_at: int
    expires_at: int | None
    last_used_at: int | None = Field(description="rounded to a minute: it is written at most once per minute")
    revoked_at: int | None


class TokenCreated(Token):
    token: str = Field(description="the token in clear text; shown only in this response")


class WebhookIn(BaseModel):
    name: Name
    url: str = Field(max_length=500)
    events: list[EventName] = Field(min_length=1)
    enabled: bool = True


class WebhookPatch(BaseModel):
    name: Name | None = None
    url: str | None = Field(None, max_length=500)
    events: list[EventName] | None = Field(None, min_length=1)
    enabled: bool | None = None


class Webhook(BaseModel):
    id: int
    name: str
    url: str
    events: list[str]
    enabled: bool
    created_at: int


class WebhookCreated(Webhook):
    secret: str = Field(description="the signing secret; shown only in this response")


class Delivery(BaseModel):
    id: int
    event: str
    status_code: int | None
    error: str | None
    attempts: int
    created_at: int
    finished_at: int | None = Field(description="null while the delivery is still being tried")


class FastingToday(BaseModel):
    active: bool
    elapsed_seconds: int
    target_hours: float


class SummaryToday(BaseModel):
    day: str
    kcal_eaten: float
    kcal_goal: int | None = Field(description="the goal that counts today (with the active energy when add_to_goal is on)")
    kcal_left: float | None = Field(description="goal minus eaten; negative when over the goal, null without a goal")
    protein: float
    carbs: float
    fat: float
    water_ml: int
    water_goal_ml: int
    steps: int | None = Field(None, description="today's steps, null without a value")
    steps_goal: int = 8000
    active_kcal: float | None = None
    workouts: int = Field(0, description="number of workouts today")
    kcal_goal_bonus: int = Field(0, description="kcal the active energy adds to kcal_goal (0 unless activity.add_to_goal is on)")
    weight_kg: float | None = Field(description="the latest recorded weight")
    weight_day: str | None
    fasting: FastingToday | None = Field(description="null when the fasting timer is off and no fast is running")
    logged_today: bool
    last_entry_at: int | None = Field(description="unix seconds of the latest entry ever made")


class AdminOverview(BaseModel):
    version: str
    auth_mode: Literal["single", "proxy", "local", "oidc"]
    db_size_bytes: int
    schema_version: int
    users: int
    entries: int
    foods: int
    catalog: CatalogInfo


class AdminUser(BaseModel):
    username: str
    display_name: str
    created_at: int
    entries: int
    first_day: str | None
    last_day: str | None
    tokens: int = Field(description="active access tokens")
    webhooks: int
    disabled: bool = Field(False, description="local sign-in mode: the account is blocked")
    admin: bool = Field(False, description="local sign-in mode: the account may use the admin area")
    has_password: bool = Field(False, description="local sign-in mode: the account has a password")
    demo: bool = Field(False, description="this is the built-in demo account (it holds invented data and nobody signs in as it)")
    sso: bool = Field(False, description="oidc sign-in mode: the account is linked to an identity at the provider (it has signed in through it)")


class Connector(BaseModel):
    key: str
    kind: Literal["source", "import", "interface"]
    enabled: bool
    status: str = Field(description="machine-readable state, e.g. ok, off, empty, running, unavailable")
    configurable: bool = Field(description="can be changed with PATCH /admin/connectors/{key}")
    locked: list[str] = Field(default_factory=list, description="settings (`enabled`, `config.<name>`) fixed by an environment variable")
    config: dict = Field(default_factory=dict)
    info: dict = Field(default_factory=dict, description="facts to show: counts, dates, hints")


class ConnectorPatch(BaseModel):
    enabled: bool | None = None
    config: dict | None = None


class RefreshState(BaseModel):
    state: Literal["idle", "running", "done", "error"]
    started_at: int | None
    finished_at: int | None
    progress: str | None
    countries: list[str]
    result: dict | None
    error: str | None

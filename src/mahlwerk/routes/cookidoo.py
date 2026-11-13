"""Cookidoo: the meal plan and collections of a Cookidoo account, and recipes taken over as foods.

Whose account: a person who stored an own account (profile) uses that one; everybody else uses the shared household
account (the environment's, else the one an admin stored). Credentials are kept encrypted (vault.py) and are never
returned: the account endpoints only tell whether one is set and show the e-mail address masked.

For signed-in users only (an access token is refused). Switched off, not installed or not set up: 404 or 409 with the
reason. Anything that goes wrong at Cookidoo becomes 502 with a neutral message (see cookidoo.MESSAGES).
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .. import cookidoo, cookidoo_bulk, webrecipes
from ..auth import require_admin, session_user
from ..db import Store
from ..deps import get_store
from ..models import Food
from ..vault import HOUSEHOLD, Vault, VaultError, mask_email
from .foods import build_food

SECRET_NAME = "cookidoo"
KEY_MESSAGE = ("the key for stored secrets is unusable or cannot be created (MAHLWERK_SECRET_KEY or the key file next "
               "to the database, see the README)")


router = APIRouter(prefix="/api/v1/cookidoo", dependencies=[Depends(session_user)])
admin_router = APIRouter(prefix="/api/v1/admin/cookidoo", dependencies=[Depends(require_admin)])
me_router = APIRouter(prefix="/api/v1/me/cookidoo-account", dependencies=[Depends(session_user)])


class CookidooState(BaseModel):
    state: str = Field(description="off, not_installed, not_configured, error or ready")
    error: str | None = Field(None, description="neutral text of the last failure")
    account: Literal["own", "shared"] | None = Field(None, description="whose account this person's requests use")
    personal_allowed: bool = Field(True, description="people may store an own account (admin switch)")


class AccountIn(BaseModel):
    """The credentials. No limits are declared here on purpose: a validation error must never echo the password, so the
    checks run in the handler and answer with a fixed text."""

    email: str = ""
    password: str = ""
    country: str = "de"
    language: str = "de-DE"

    def __repr__(self) -> str:
        return "AccountIn(...)"


class AccountOut(BaseModel):
    source: Literal["env", "stored", "none", "unreadable"] = Field(
        description="env: fixed by the environment; stored: set here; none; unreadable: stored but the key is missing or does not fit, enter it again")
    email: str | None = Field(None, description="the e-mail address, masked (a***@example.org); the password is never returned")
    country: str | None = None
    language: str | None = None
    editable: bool = Field(description="false when the environment fixes it or own accounts are forbidden")
    allowed: bool = Field(True, description="own accounts are allowed (admin switch)")
    key: Literal["env", "file", "none", "invalid"] | None = Field(None, description="admin only: where the key for stored secrets comes from")
    error: str | None = Field(None, description="neutral text of the last failure at Cookidoo")


class CheckResult(BaseModel):
    ok: bool


class RecipeRef(BaseModel):
    id: str
    name: str


class PlanDayOut(BaseModel):
    day: str
    title: str
    recipes: list[RecipeRef]


class CollectionOut(BaseModel):
    id: str
    name: str
    managed: bool = Field(description="a collection Cookidoo offers (true) or one the account made itself (false)")
    recipes: list[RecipeRef]


class RecipePreview(BaseModel):
    id: str
    name: str
    portions: float | None
    per_portion: dict[str, float | None] = Field(description="kcal, fat, saturated_fat, carbs, sugars, fiber, protein, salt per portion")
    extra: dict[str, float] = Field(description="further values per portion (sodium in mg)")
    complete: bool = Field(description="kcal, fat, carbs and protein are all present")
    food_id: int | None = Field(description="the food it already is on this server, if it was taken over before")


COLLECTION_ID = r"^[A-Za-z0-9_.:-]{1,100}$"


class AdoptIn(BaseModel):
    recipe: str = Field(min_length=1, max_length=400, description="a Cookidoo recipe id (r59322) or a recipe link")
    collection: str | None = Field(
        None, pattern=COLLECTION_ID,
        description="the collection the recipe was picked from: it goes into the group of that collection (made if needed, "
                    "not made again once the household deleted it)")
    refresh_image: bool = Field(False, description="fetch the picture again even if one of the same address is stored (an explicit reload; braked)")


class BulkIn(BaseModel):
    scope: Literal["all", "collection", "week"] = Field(
        description="all: every collection and the meal plan of the account; collection: one (`collection`); week: the meal plan")
    collection: str | None = Field(None, pattern=COLLECTION_ID, description="the collection id, for scope `collection`")
    regroup: bool = Field(False, description="make the groups again that the household deleted")


class BulkGroup(BaseModel):
    collection: str
    name: str
    exists: bool = Field(description="there is a group for this collection already")
    dismissed: bool = Field(description="the household deleted it: no new one unless `regroup`")


class BulkPreview(BaseModel):
    total: int = Field(description="recipes in the scope, without duplicates")
    fresh: int = Field(description="of them taken over less than 7 days ago: they cost no call")
    to_fetch: int = Field(description="calls to Cookidoo the run will make")
    eta_seconds: int = Field(description="an estimate: to_fetch x seconds_per_recipe; Cookidoo may be slower")
    seconds_per_recipe: float
    limit: int = Field(description="recipes per run at most")
    groups: list[BulkGroup]


class BulkFailure(BaseModel):
    id: str
    name: str
    kind: str = Field(description="no_nutrition (skipped: no values per portion) or an error kind (unavailable, unexpected)")
    reason: str


class BulkRun(BaseModel):
    state: Literal["running", "done", "cancelled", "error"]
    cancelling: bool = Field(description="cancelled, but still finishing the call it is in")
    scope: str
    mode: Literal["recipes", "pictures"] = Field("recipes", description="recipes: taking recipes over; pictures: the catch-up for pictures of recipes taken over already")
    pictures: int = Field(0, description="pictures stored by this run")
    no_picture: int = Field(0, description="recipes without a picture (Cookidoo has none, or it could not be fetched or processed)")
    total: int
    done: int = Field(description="recipes dealt with so far (including skipped and failed ones)")
    fetched: int = Field(description="calls made to Cookidoo")
    adopted: int
    updated: int
    fresh: int = Field(description="skipped without a call: taken over less than 7 days ago")
    no_nutrition: int = Field(description="skipped: Cookidoo has no energy value per portion for them")
    failed: int
    current: str | None
    failures: list[BulkFailure] = Field(description="at most 40")
    groups: list[str] = Field(description="the groups the run keeps up (names as they are now)")
    error: str | None = Field(None, description="why the run stopped by itself (neutral text)")
    error_kind: str | None = None
    reason: str | None = Field(None, description="why it was cancelled")
    reason_kind: str | None = Field(None, description="user, account, off or shutdown")
    eta_seconds: int
    started_at: int
    finished_at: int | None


def vault_of(request: Request) -> Vault:
    return request.app.state.vault


def _stored_access(request: Request, user_id: int, key: str, scope: str) -> tuple["cookidoo.Access | None", str]:
    vault = vault_of(request)
    state = vault.state(user_id, SECRET_NAME)
    if state != "stored":
        return None, state
    settings = cookidoo.Settings.from_stored(vault.get(user_id, SECRET_NAME))
    return (cookidoo.Access(key, settings, scope), "stored") if settings else (None, "unreadable")


def shared_access(request: Request) -> tuple["cookidoo.Access | None", str]:
    """The household account and where it comes from (`env`, `stored`, `unreadable`, `none`). The environment wins."""
    env = cookidoo.Settings.from_env()
    if env is not None:
        return cookidoo.Access(cookidoo.SHARED, env, "shared"), "env"
    return _stored_access(request, HOUSEHOLD, cookidoo.SHARED, "shared")


def own_access(request: Request, user_id: int) -> tuple["cookidoo.Access | None", str]:
    """The user's own account (`stored`, `unreadable`, `none`), whether or not own accounts are allowed right now."""
    return _stored_access(request, user_id, f"user:{user_id}", "own")


def access_for(request: Request, user: dict) -> "cookidoo.Access | None":
    """The account this user's requests go to: their own (if allowed and readable), else the shared one."""
    if request.app.state.features.cookidoo_personal:
        own, _ = own_access(request, user["id"])
        if own is not None:
            return own
    return shared_access(request)[0]


def _ready(request: Request, user: dict) -> tuple[cookidoo.Hub, "cookidoo.Access"]:
    """The connector and the account to use, once it is switched on, installed and set up; otherwise the matching HTTP error."""
    if not request.app.state.features.cookidoo:
        raise HTTPException(404, "the Cookidoo connector is switched off (admin area)")
    if not cookidoo.installed():
        raise HTTPException(409, "Cookidoo support is not installed (pip install mahlwerk[cookidoo])")
    access = access_for(request, user)
    if access is None:
        raise HTTPException(409, "Cookidoo is not configured (an account in the admin area or in your profile, "
                                 "or MAHLWERK_COOKIDOO_EMAIL and MAHLWERK_COOKIDOO_PASSWORD)")
    return request.app.state.cookidoo, access


def _fail(exc: cookidoo.CookidooError) -> HTTPException:
    return HTTPException(429 if exc.kind in ("busy", "wait", "locked") else 502, str(exc))


def _ref(item: cookidoo.PlannedRecipe) -> RecipeRef:
    return RecipeRef(id=item.id, name=item.name)


def _parse(text: str) -> str:
    rid = cookidoo.recipe_id(text)
    if rid is None:
        raise HTTPException(422, "not a Cookidoo recipe id or recipe link")
    return rid


@router.get("/status", response_model=CookidooState)
def status(request: Request, user: dict = Depends(session_user)) -> CookidooState:
    hub: cookidoo.Hub = request.app.state.cookidoo
    access = access_for(request, user)
    key = access.key if access else cookidoo.SHARED
    return CookidooState(
        state=hub.status(request.app.state.features.cookidoo, access, key), error=cookidoo.MESSAGES.get(hub.error_of(key) or ""),
        account=access.scope if access else None, personal_allowed=request.app.state.features.cookidoo_personal)


@router.get("/week", response_model=list[PlanDayOut])
async def week(request: Request, user: dict = Depends(session_user)) -> list[PlanDayOut]:
    """The meal plan of the current week (catalogue recipes only). Loaded from Cookidoo at most once a minute."""
    hub, access = _ready(request, user)
    try:
        days = await hub.week(access)
    except cookidoo.CookidooError as exc:
        raise _fail(exc) from exc
    return [PlanDayOut(day=d.day, title=d.title, recipes=[_ref(r) for r in d.recipes]) for d in days]


@router.get("/collections", response_model=list[CollectionOut])
async def collections(request: Request, user: dict = Depends(session_user)) -> list[CollectionOut]:
    """The collections of the account (own lists and managed ones). Loaded from Cookidoo at most once a minute."""
    hub, access = _ready(request, user)
    try:
        found = await hub.collections(access)
    except cookidoo.CookidooError as exc:
        raise _fail(exc) from exc
    return [CollectionOut(id=c.id, name=c.name, managed=c.managed, recipes=[_ref(r) for r in c.recipes]) for c in found]


async def _details(request: Request, user: dict, text: str) -> tuple[cookidoo.RecipeDetails, "cookidoo.Access"]:
    rid = _parse(text)
    hub, access = _ready(request, user)
    try:
        return await hub.recipe(access, rid), access
    except cookidoo.CookidooError as exc:
        raise _fail(exc) from exc


@router.get("/recipe", response_model=RecipePreview)
async def preview(
    request: Request, ref: str = Query(min_length=1, max_length=400, description="recipe id or recipe link"),
    store: Store = Depends(get_store), user: dict = Depends(session_user),
) -> RecipePreview:
    """Name, portions and nutrition per portion of one recipe (id or link), without saving anything."""
    details, _ = await _details(request, user, ref)
    try:
        data = cookidoo.food_data(details)
    except cookidoo.RecipeRejected as exc:
        raise HTTPException(422, str(exc)) from exc
    known = store.get_food_by_external_id(cookidoo.EXTERNAL_PREFIX + details.id)
    return RecipePreview(
        id=details.id, name=data["name"], portions=data["portions"], per_portion=data["per_100"], extra=data["extra"],
        complete=data["complete"], food_id=known["id"] if known else None,
    )


async def _group_for(request: Request, access: "cookidoo.Access", store: Store, user: dict, collection: str, food_id: int, new: bool) -> None:
    """A recipe taken over from a collection goes into that collection's group (the same rules as a run that takes over many)."""
    try:
        found = await request.app.state.cookidoo.collections(access)
    except cookidoo.CookidooError:
        return  # the recipe is taken over all the same; only the group is left out
    named = next((c for c in found if c.id == collection), None)
    if named is None:
        return
    group_id, created = store.source_group(cookidoo_bulk.GROUP_PREFIX + collection, named.name, user["id"])
    if group_id is not None and (created or new):
        store.add_to_group(group_id, [food_id])


@router.post("/adopt", response_model=Food)
async def adopt(body: AdoptIn, request: Request, store: Store = Depends(get_store), user: dict = Depends(session_user)) -> Food:
    """Take a recipe over as a food (source `cookidoo`, external id `cookidoo:<id>`). Doing it again updates the food.
    With `collection` the recipe also goes into the group of that collection.

    The values per portion are stored as 100 g of the food, so 100 g = 1 portion when logging. The food belongs to the
    household: everybody on this server sees it, also when it came from somebody's own Cookidoo account.
    """
    details, access = await _details(request, user, body.recipe)
    try:
        data = {**cookidoo.food_data(details), "region": [access.settings.country, access.settings.language]}
    except cookidoo.RecipeRejected as exc:
        raise HTTPException(422, str(exc)) from exc
    external = cookidoo.EXTERNAL_PREFIX + details.id
    known = store.get_food_by_external_id(external)
    if known is not None:
        store.update_food(known["id"], cookidoo.SOURCE, data)
        food_id = known["id"]
        if body.collection:
            await _group_for(request, access, store, user, body.collection, food_id, False)
    else:
        food_id, _ = store.put_external_food(external, cookidoo.SOURCE, data)
        if body.collection:
            await _group_for(request, access, store, user, body.collection, food_id, True)
    await _picture(request, store, user, food_id, details.image, body.refresh_image)
    return build_food(store.get_food(food_id))


async def _picture(request: Request, store: Store, user: dict, food_id: int, url: str | None, force: bool) -> None:
    """When the admin switched pictures on for Cookidoo, fetch the picture Cookidoo named (best effort: never makes taking the recipe over
    fail; a picture somebody set or took away is left alone). A picture stored already for the same address is not fetched again unless
    `force` (an explicit reload); every fetch counts against a brake per person and for the server. Nothing is remembered about the address
    while the switch is off."""
    if not url or not request.app.state.features.cookidoo_images:
        return
    brake: webrecipes.Brake = request.app.state.image_brake
    await run_in_threadpool(
        request.app.state.images.fetch_provider, request.app.state.web_fetcher, food_id, url, cookidoo.SOURCE, force=force,
        permit=lambda: brake.allow(user["id"]) == 0)


# ---- taking over many recipes at once (a background run, see cookidoo_bulk.py) ----


def _bulk_error(exc: cookidoo_bulk.BulkError) -> HTTPException:
    if exc.kind == "not_found":
        return HTTPException(404, "unknown collection")
    if exc.kind == "empty":
        return HTTPException(422, "there is nothing to take over in this selection (or no recipe lacks a picture)")
    if exc.kind == "too_many":
        return HTTPException(422, f"{exc.detail} recipes: at most {cookidoo_bulk.MAX_RECIPES} per run, take over collection by collection")
    if exc.kind == "wait":
        return HTTPException(429, "the picture catch-up was started a moment ago: try again in a few minutes", headers={"Retry-After": "600"})
    if exc.kind == "running":
        return HTTPException(409, "a run for this Cookidoo account is already under way")
    return HTTPException(429, "the server is already taking over recipes for other accounts, try again in a few minutes",
                         headers={"Retry-After": "120"})


async def _plan(request: Request, user: dict, scope: str, collection: str | None):
    if scope == "collection" and not collection:
        raise HTTPException(422, "scope collection needs a collection id")
    hub, access = _ready(request, user)
    try:
        return access, await cookidoo_bulk.make_plan(hub, access, scope, collection)
    except cookidoo_bulk.BulkError as exc:
        raise _bulk_error(exc) from exc
    except cookidoo.CookidooError as exc:
        raise _fail(exc) from exc


@router.get("/import/preview", response_model=BulkPreview)
async def import_preview(
    request: Request, scope: Literal["all", "collection", "week"], collection: str | None = Query(None, pattern=COLLECTION_ID),
    store: Store = Depends(get_store), user: dict = Depends(session_user),
) -> BulkPreview:
    """What taking over the selection would do, counted from the lists Cookidoo gave (cached for a minute) and from what is
    stored. Makes no detail call. `eta_seconds` is an honest estimate for the calls the run will make."""
    _, plan = await _plan(request, user, scope, collection)
    stats = cookidoo_bulk.summarize(store, plan, request.app.state.clock())
    groups = []
    for cid, name in plan.groups.items():
        source = cookidoo_bulk.GROUP_PREFIX + cid
        exists = any(g["source"] == source for g in store.list_groups())
        groups.append(BulkGroup(collection=cid, name=name, exists=exists, dismissed=not exists and store.source_dismissed(source)))
    return BulkPreview(**stats, seconds_per_recipe=cookidoo_bulk.SECONDS_PER_RECIPE, limit=cookidoo_bulk.MAX_RECIPES, groups=groups)


@router.post("/import", response_model=BulkRun, status_code=202)
async def import_start(body: BulkIn, request: Request, user: dict = Depends(session_user)) -> BulkRun:
    """Take over the selection in the background: one detail call to Cookidoo every 3 seconds at least, one run per Cookidoo
    account, at most two on the server, at most 500 recipes. Poll `GET /cookidoo/import`; cancel with `DELETE`. Everything is
    saved recipe by recipe; a run does not survive a restart of the server (start again: what is up to date is skipped)."""
    access, plan = await _plan(request, user, body.scope, body.collection)
    try:
        run = request.app.state.cookidoo_runs.start(access, plan, user["id"], body.regroup)
    except cookidoo_bulk.BulkError as exc:
        raise _bulk_error(exc) from exc
    return BulkRun(**run.view())


@router.get("/import", response_model=BulkRun | None)
def import_state(request: Request, user: dict = Depends(session_user)) -> BulkRun | None:
    """The latest run of the Cookidoo account this person uses (running, or finished within the last hour), else null."""
    access = access_for(request, user)
    run = request.app.state.cookidoo_runs.get(access.key) if access else None
    return BulkRun(**run.view()) if run else None


class PicturePreview(BaseModel):
    enabled: bool = Field(description="the admin switched \"store recipe pictures\" on for Cookidoo; without it nothing is fetched")
    total: int = Field(description="recipes taken over from Cookidoo that have no picture (and none was set or taken away by a person)")
    to_fetch: int = Field(description="calls to Cookidoo the catch-up will make (recipes whose picture address is not known yet)")
    eta_seconds: int
    limit: int


@router.get("/images/preview", response_model=PicturePreview)
def images_preview(request: Request, store: Store = Depends(get_store), user: dict = Depends(session_user)) -> PicturePreview:
    """How many recipes lack a picture and what a catch-up would cost. Counted from what is stored; no call to Cookidoo."""
    if not request.app.state.features.cookidoo:
        raise HTTPException(404, "the Cookidoo connector is switched off (admin area)")
    enabled = request.app.state.features.cookidoo_images
    try:
        stats = cookidoo_bulk.summarize_images(cookidoo_bulk.make_image_plan(store, request.app.state.clock()))
    except cookidoo_bulk.BulkError:
        return PicturePreview(enabled=enabled, total=0, to_fetch=0, eta_seconds=0, limit=cookidoo_bulk.MAX_RECIPES)
    return PicturePreview(enabled=enabled, total=stats["total"], to_fetch=stats["to_fetch"], eta_seconds=stats["eta_seconds"], limit=cookidoo_bulk.MAX_RECIPES)


@router.post("/images", response_model=BulkRun, status_code=202)
async def images_start(request: Request, store: Store = Depends(get_store), user: dict = Depends(session_user)) -> BulkRun:
    """Catch up the pictures of recipes taken over before pictures were switched on: in the background, paced like taking recipes over
    (one detail call every 3 seconds at most, only for recipes whose picture address is not known), one run per Cookidoo account.
    Needs "store recipe pictures" for Cookidoo (admin area). Poll `GET /cookidoo/import`; cancel with `DELETE /cookidoo/import`."""
    if not request.app.state.features.cookidoo_images:
        raise HTTPException(409, "storing recipe pictures is switched off for Cookidoo (admin area)")
    hub, access = _ready(request, user)
    try:
        plan = cookidoo_bulk.make_image_plan(store, request.app.state.clock())
        run = request.app.state.cookidoo_runs.start(access, plan, user["id"])
    except cookidoo_bulk.BulkError as exc:
        raise _bulk_error(exc) from exc
    return BulkRun(**run.view())


@router.delete("/import", status_code=204)
def import_cancel(request: Request, user: dict = Depends(session_user)) -> None:
    """Cancel the running run (it stops before its next call; what was saved stays)."""
    access = access_for(request, user)
    if access:
        request.app.state.cookidoo_runs.cancel(access.key, "user")


# ---- the accounts: shared (admin) and own (profile) ----


def _account_out(request: Request, user_id: int, key: str, env: bool, allowed: bool, admin: bool) -> AccountOut:
    vault = vault_of(request)
    hub: cookidoo.Hub = request.app.state.cookidoo
    if env:
        settings = cookidoo.Settings.from_env()
        source, editable = "env", False
    else:
        state = vault.state(user_id, SECRET_NAME)
        settings = cookidoo.Settings.from_stored(vault.get(user_id, SECRET_NAME)) if state == "stored" else None
        source = state if settings or state != "stored" else "unreadable"
        editable = allowed
    return AccountOut(
        source=source, email=mask_email(settings.email) if settings else None, country=settings.country if settings else None,
        language=settings.language if settings else None, editable=editable, allowed=allowed,
        key=vault.key_status() if admin else None, error=cookidoo.MESSAGES.get(hub.error_of(key) or ""))


def _settings_of(body: AccountIn) -> cookidoo.Settings:
    settings = cookidoo.Settings.build(body.email, body.password, body.country, body.language)
    if settings is None:
        raise HTTPException(422, "e-mail address and password are required; the country is two letters (de) and the language like de-DE")
    return settings


def _store(request: Request, user_id: int, settings: cookidoo.Settings) -> None:
    try:
        vault_of(request).put(user_id, SECRET_NAME, settings.to_stored())
    except VaultError as exc:
        raise HTTPException(503, KEY_MESSAGE) from exc


async def _check(request: Request, access: "cookidoo.Access | None") -> CheckResult:
    if not request.app.state.features.cookidoo:
        raise HTTPException(404, "the Cookidoo connector is switched off (admin area)")
    if not cookidoo.installed():
        raise HTTPException(409, "Cookidoo support is not installed (pip install mahlwerk[cookidoo])")
    if access is None:
        raise HTTPException(409, "no Cookidoo account is stored")
    try:
        await request.app.state.cookidoo.check(access)
    except cookidoo.CookidooError as exc:
        raise _fail(exc) from exc
    return CheckResult(ok=True)


@admin_router.get("/account", response_model=AccountOut)
def admin_account(request: Request) -> AccountOut:
    """The shared household account: where it comes from and the masked e-mail address."""
    env = cookidoo.Settings.from_env() is not None
    return _account_out(request, HOUSEHOLD, cookidoo.SHARED, env, True, True)


@admin_router.put("/account", response_model=AccountOut)
async def admin_set_account(body: AccountIn, request: Request) -> AccountOut:
    if cookidoo.Settings.from_env() is not None:
        raise HTTPException(409, "fixed by the environment (MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD)")
    _store(request, HOUSEHOLD, _settings_of(body))
    await request.app.state.cookidoo.forget(cookidoo.SHARED)
    return _account_out(request, HOUSEHOLD, cookidoo.SHARED, False, True, True)


@admin_router.delete("/account", response_model=AccountOut)
async def admin_remove_account(request: Request) -> AccountOut:
    if cookidoo.Settings.from_env() is not None:
        raise HTTPException(409, "fixed by the environment (MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD)")
    vault_of(request).delete(HOUSEHOLD, SECRET_NAME)
    await request.app.state.cookidoo.forget(cookidoo.SHARED)
    return _account_out(request, HOUSEHOLD, cookidoo.SHARED, False, True, True)


@admin_router.post("/account/check", response_model=CheckResult)
async def admin_check_account(request: Request) -> CheckResult:
    """One sign-in attempt with the shared account (braked: not within 30 seconds of the last one, not for five minutes after a failure)."""
    return await _check(request, shared_access(request)[0])


def _need_personal(request: Request) -> None:
    if not request.app.state.features.cookidoo:
        raise HTTPException(404, "the Cookidoo connector is switched off (admin area)")


def _own_out(request: Request, user: dict) -> AccountOut:
    return _account_out(request, user["id"], f"user:{user['id']}", False, request.app.state.features.cookidoo_personal, False)


@me_router.get("", response_model=AccountOut)
def my_account(request: Request, user: dict = Depends(session_user)) -> AccountOut:
    """This person's own account (never the password). `allowed` is false when an admin forbade own accounts."""
    return _own_out(request, user)


@me_router.put("", response_model=AccountOut)
async def my_set_account(body: AccountIn, request: Request, user: dict = Depends(session_user)) -> AccountOut:
    _need_personal(request)
    if not request.app.state.features.cookidoo_personal:
        raise HTTPException(403, "own Cookidoo accounts are switched off (admin area)")
    _store(request, user["id"], _settings_of(body))
    await request.app.state.cookidoo.forget(f"user:{user['id']}")
    return _own_out(request, user)


@me_router.delete("", response_model=AccountOut)
async def my_remove_account(request: Request, user: dict = Depends(session_user)) -> AccountOut:
    vault_of(request).delete(user["id"], SECRET_NAME)
    await request.app.state.cookidoo.forget(f"user:{user['id']}")
    return _own_out(request, user)


@me_router.post("/check", response_model=CheckResult)
async def my_check_account(request: Request, user: dict = Depends(session_user)) -> CheckResult:
    """One sign-in attempt with this person's own account (braked like every sign-in)."""
    if not request.app.state.features.cookidoo_personal:
        raise HTTPException(403, "own Cookidoo accounts are switched off (admin area)")
    return await _check(request, own_access(request, user["id"])[0])

"""The current user, their goal and their weights."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import activity, demo
from ..auth import current_user
from ..webhooks import emit
from ..db import DEFAULT_WATER_GOAL, Store
from ..catalog import Catalog
from ..deps import get_catalog, get_store
from ..models import DemoAccountInfo, DemoCreated, DemoIn, DemoRemoved, Goal, ImportBatch, ImportRemoved, Me, NamePatch, Settings, SettingsPatch, Weight, WeightIn
from .diary import parse_day, today

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


def demo_enabled(request: Request) -> bool:
    return request.app.state.demo_enabled


def need_demo(request: Request) -> None:
    if not demo_enabled(request):
        raise HTTPException(404, "demo data is switched off")


def user_settings(store: Store, user_id: int) -> Settings:
    return Settings(**{k: v for k, v in store.get_settings(user_id).items() if k in Settings.model_fields})


def _provider_name(user: dict) -> str | None:
    """The name the provider delivered, when it differs from the shown one (for "reset to ...")."""
    name = user["provider_name"] or user["username"]
    return name if name != user["display_name"] else None


@router.get("/me", response_model=Me)
def me(
    request: Request,
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
    catalog: Catalog = Depends(get_catalog),
) -> Me:
    is_demo = bool(user.get("is_demo"))
    real = user.get("demo_real") or {}
    features = request.app.state.features
    can_switch = bool(user["is_admin"] and not is_demo and features.demo_account and store.demo_account_ready() is not None)
    return Me(
        username=user["username"],
        display_name=user["display_name"],
        display_name_custom=user["name_custom"],
        provider_name=_provider_name(user),
        is_admin=user["is_admin"],
        goal=store.get_goal(user["id"]),
        settings=user_settings(store, user["id"]),
        # the demo account has no test-data switch of its own and no connectors (demo_account.py closes them)
        demo={"available": demo_enabled(request) and not is_demo, **store.demo_counts(user["id"])},
        demo_account=DemoAccountInfo(can_switch=can_switch, viewing=is_demo, real_username=real.get("username"), real_display_name=real.get("display_name")),
        catalog=catalog.info(),
        features={"access_tokens": features.tokens and not is_demo, "webhooks": features.webhooks and not is_demo,
                  "cookidoo": features.cookidoo and not is_demo, "web_recipes": features.web_recipes and not is_demo},
    )


@router.patch("/me", response_model=Me)
def patch_me(
    body: NamePatch, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store),
    catalog: Catalog = Depends(get_catalog),
) -> Me:
    """Choose the display name (kept over the provider's name at every sign-in) or, with an empty/null name, go back to the
    provider's. Like the settings this needs a write token; the user name stays."""
    store.set_own_name(user["id"], body.display_name)
    own = body.display_name
    user = {**user, "display_name": own or user["provider_name"] or user["username"], "name_custom": own is not None}
    return me(request, user, store, catalog)


@router.post("/me/demo-data", response_model=DemoCreated, dependencies=[Depends(need_demo)])
def create_demo_data(
    body: DemoIn | None = None, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> dict:
    """Fill the last N days with invented entries, weights, water, steps and workouts; days with real data stay untouched."""
    return demo.generate(store, user["id"], today(), (body or DemoIn()).days)


@router.delete("/me/demo-data", response_model=DemoRemoved, dependencies=[Depends(need_demo)])
def delete_demo_data(request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> dict:
    """Remove this user's demo entries and weights and the demo foods nothing refers to any more."""
    removed = store.remove_demo(user["id"])
    request.app.state.images.sweep()  # foods are gone: tidy the files nothing refers to
    return removed


@router.get("/me/imports", response_model=list[ImportBatch])
def list_imports(user: dict = Depends(current_user), store: Store = Depends(get_store)) -> list[dict]:
    """This user's import batches (see `python -m mahlwerk.yazio`), newest first."""
    return store.list_imports(user["id"])


@router.delete("/me/imports/{import_id}", response_model=ImportRemoved)
def delete_import(import_id: int, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> dict:
    """Remove what one batch created and the user has not changed since; the other data stays."""
    removed = store.remove_import(import_id, user["id"])
    if removed is None:
        raise HTTPException(404, "unknown import")
    request.app.state.images.sweep()
    return removed


@router.put("/me/goal", response_model=Goal)
def set_goal(goal: Goal, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Goal:
    data = goal.model_dump()
    saved = store.get_goal(user["id"]) or {}
    if "water_ml" not in goal.model_fields_set:  # an older client does not know the water goal: keep it
        data["water_ml"] = saved.get("water_ml", DEFAULT_WATER_GOAL)
    if "steps" not in goal.model_fields_set:  # nor the steps goal
        data["steps"] = saved.get("steps", activity.DEFAULT_STEPS_GOAL)
    store.set_goal(user["id"], data)
    emit(request, user, "goal.changed", data)
    return Goal(**data)


@router.patch("/me/settings", response_model=Settings)
def patch_settings(body: SettingsPatch, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Settings:
    for key, value in body.model_dump(exclude_none=True).items():
        if key in ("fasting", "activity"):  # only the given fields change
            value = {**getattr(user_settings(store, user["id"]), key).model_dump(), **value}
        store.set_setting(user["id"], key, value)
    return user_settings(store, user["id"])


@router.get("/weights", response_model=list[Weight])
def weights(
    days: int = Query(90, ge=1, le=3660), user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> list[dict]:
    last = today()
    return store.weights_between(user["id"], (last - timedelta(days=days - 1)).isoformat(), last.isoformat())


@router.put("/weights/{day}", response_model=Weight)
def put_weight(day: str, body: WeightIn, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Weight:
    parse_day(day)
    store.put_weight(user["id"], day, body.kg)
    emit(request, user, "weight.recorded", {"day": day, "kg": body.kg})
    return Weight(day=day, kg=body.kg)


@router.delete("/weights/{day}", status_code=204)
def delete_weight(day: str, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> None:
    parse_day(day)
    if not store.delete_weight(user["id"], day):
        raise HTTPException(404, "no weight for this day")

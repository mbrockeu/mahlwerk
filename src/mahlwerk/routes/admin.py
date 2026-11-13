"""The admin area: overview, user list (counts only), connectors and the catalogue refresh.

Only for admins signed in the normal way; an access token never gets in (see auth.require_admin).
"""

import os
import re

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import __version__, cookidoo, label
from ..admin_models import AdminOverview, AdminUser, Connector, ConnectorPatch, RefreshState
from ..auth import require_admin
from .. import demo_account
from .diary import today
from ..catalog import Catalog
from ..db import Store
from ..deps import get_catalog, get_store
from ..features import ENV, Features
from .. import vision, yazio_live
from .cookidoo import shared_access

router = APIRouter(prefix="/api/v1/admin", dependencies=[Depends(require_admin)])

COUNTRY = re.compile(r"^[a-z]{2}:[a-z0-9-]{2,40}$")
HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
MAX_LIST = 50


@router.get("/overview", response_model=AdminOverview)
def overview(request: Request, store: Store = Depends(get_store), catalog: Catalog = Depends(get_catalog)) -> dict:
    counts = store.admin_counts()
    try:
        size = os.path.getsize(store.path)
    except OSError:
        size = 0
    return {
        "version": __version__, "auth_mode": request.app.state.auth.mode, "db_size_bytes": size,
        "schema_version": store.schema_version(), "users": counts["users"], "entries": counts["entries"],
        "foods": counts["foods"], "catalog": catalog.info(),
    }


@router.get("/users", response_model=list[AdminUser], response_model_exclude_unset=True)
def users(request: Request, store: Store = Depends(get_store)) -> list[dict]:
    """Who uses this server, with counts. Never diary content, weights or goals. `sso` appears only in oidc mode."""
    rows = [r for r in store.admin_users() if not r["demo"] or store.demo_account_ready() is not None]  # a deleted demo account is not listed
    for row in rows:  # the name they chose themself wins over the provider's
        row["display_name"] = row.pop("own_name") or row["display_name"] or row["username"]
    if request.app.state.auth.mode != "oidc":
        for row in rows:
            del row["sso"]
    return rows


def _locked(features: Features, *keys: str) -> list[str]:
    return [("enabled" if key.endswith(".enabled") else "config." + key.rsplit(".", 1)[1]) for key in keys if features.locked(key)]


def _cookidoo_account(request: Request) -> dict:
    """What the card shows about the shared account: where it comes from and the masked address (never the password)."""
    from .cookidoo import admin_account
    out = admin_account(request)
    return out.model_dump()


def _demo_account_connector(request: Request) -> dict:
    """The card of the built-in demo account: switch, what it holds and whether a real user of the reserved name stands in the way."""
    store: Store = request.app.state.store
    features: Features = request.app.state.features
    user_id = store.demo_account_ready()
    taken = user_id is None and store.demo_name_taken()
    info = {"exists": user_id is not None, "name_taken": taken, "env": "MAHLWERK_DEMO_ACCOUNT",
            **(store.demo_account_summary(user_id) if user_id is not None else {})}
    status = "conflict" if taken else ("ok" if user_id is not None else "empty") if features.demo_account else "off"
    return {"key": "demo_account", "kind": "import", "enabled": features.demo_account, "status": status, "configurable": True,
            "locked": _locked(features, "demo_account.enabled"), "config": {}, "info": info}


def _vision_connector(request: Request) -> dict:
    """The card of photo recognition: switch, whether the operator configured a model, its name (never the address or the key)."""
    features: Features = request.app.state.features
    settings = vision.settings_from_env()
    return {"key": "vision", "kind": "source", "enabled": features.vision,
            "status": "not_configured" if settings is None else "ready" if features.vision else "off", "configurable": True,
            "locked": _locked(features, "vision.enabled"), "config": {},
            "info": {"model": settings.model if settings else None, "per_hour": vision.per_hour_from_env(),
                     "env": "MAHLWERK_VISION_URL, MAHLWERK_VISION_MODEL, MAHLWERK_VISION_KEY"}}


def connector_list(request: Request) -> list[dict]:
    app = request.app
    features: Features = app.state.features
    store: Store = app.state.store
    info = app.state.catalog.info()
    refresh = app.state.refresh.status()
    counts = store.admin_counts()
    return [
        {"key": "openfoodfacts_lookup", "kind": "source", "enabled": features.lookup,
         "status": "ok" if features.lookup else "off", "configurable": True,
         "locked": _locked(features, "openfoodfacts_lookup.enabled"), "config": {},
         "info": {"base_url": app.state.off.base}},
        {"key": "openfoodfacts_catalog", "kind": "source", "enabled": info["products"] > 0,
         "status": "running" if refresh["state"] == "running" else "ok" if info["products"] else "empty",
         "configurable": True, "locked": _locked(features, "openfoodfacts_catalog.countries"),
         "config": {"countries": features.countries},
         "info": {"products": info["products"], "updated_at": info["updated_at"]}},
        {"key": "bls", "kind": "source", "enabled": info["bls"]["products"] > 0,
         "status": "ok" if info["bls"]["products"] else "empty", "configurable": False, "locked": [], "config": {},
         "info": {"products": info["bls"]["products"], "updated_at": info["bls"]["updated_at"], "cli": True}},
        {"key": "cookidoo", "kind": "source", "enabled": features.cookidoo,
         "status": app.state.cookidoo.status(features.cookidoo, shared_access(request)[0]), "configurable": True,
         "locked": _locked(features, "cookidoo.enabled", "cookidoo.personal", "cookidoo.images"),
         "config": {"personal": features.cookidoo_personal, "images": features.cookidoo_images},
         "info": {"error": cookidoo.MESSAGES.get(app.state.cookidoo.last_error or ""), "shared_account": True,
                  "account": _cookidoo_account(request), "env": "MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD"}},
        {"key": "web_recipes", "kind": "source", "enabled": features.web_recipes,
         "status": "ok" if features.web_recipes else "off", "configurable": True,
         "locked": _locked(features, "web_recipes.enabled", "web_recipes.images"), "config": {"images": features.web_images}, "info": {}},
        {"key": "yazio_import", "kind": "import", "enabled": True, "status": "upload", "configurable": False,
         "locked": [], "config": {}, "info": {"batches": counts["import_batches"], "cli": True, "upload": True}},
        {"key": "yazio_login", "kind": "import", "enabled": features.yazio_login,
         "status": ("not_configured" if yazio_live.app_identity() is None else "ready" if features.yazio_login else "off"),
         "configurable": True, "locked": _locked(features, "yazio_login.enabled"), "config": {},
         "info": {"unofficial": True, "env": "MAHLWERK_YAZIO_CLIENT_ID, MAHLWERK_YAZIO_CLIENT_SECRET"}},
        _vision_connector(request),
        {"key": "label_reader", "kind": "import", "enabled": label.available(),
         "status": "ok" if label.available() else "unavailable", "configurable": False, "locked": [], "config": {},
         "info": {}},
        {"key": "demo_data", "kind": "import", "enabled": app.state.demo_enabled,
         "status": "ok" if app.state.demo_enabled else "off", "configurable": False, "locked": [], "config": {},
         "info": {"env": "MAHLWERK_DEMO_DATA"}},
        _demo_account_connector(request),
        {"key": "access_tokens", "kind": "interface", "enabled": features.tokens,
         "status": "ok" if features.tokens else "off", "configurable": True,
         "locked": _locked(features, "access_tokens.enabled"), "config": {},
         "info": {"active": store.count_active_tokens()}},
        {"key": "webhooks", "kind": "interface", "enabled": features.webhooks,
         "status": "ok" if features.webhooks else "off", "configurable": True,
         "locked": _locked(features, "webhooks.enabled", "webhooks.hosts"),
         "config": {"hosts": features.webhook_hosts}, "info": {"hooks": counts["webhooks"]}},
    ]


@router.get("/connectors", response_model=list[Connector])
def connectors(request: Request) -> list[dict]:
    return connector_list(request)


def _names(raw, pattern: re.Pattern, what: str, fix=lambda v: v) -> list[str]:
    if not isinstance(raw, list) or len(raw) > MAX_LIST or not all(isinstance(v, str) for v in raw):
        raise HTTPException(422, f"{what} must be a list of at most {MAX_LIST} texts")
    values = list(dict.fromkeys(fix(v.strip().lower()) for v in raw if v.strip()))
    if not all(pattern.match(v) for v in values):
        raise HTTPException(422, f"{what}: invalid entry")
    return values


def _country(value: str) -> str:
    return value if ":" in value else f"en:{value}"


@router.patch("/connectors/{key}", response_model=Connector)
def patch_connector(key: str, body: ConnectorPatch, request: Request, store: Store = Depends(get_store)) -> dict:
    features: Features = request.app.state.features
    switch = {"openfoodfacts_lookup": "openfoodfacts_lookup.enabled", "access_tokens": "access_tokens.enabled",
              "webhooks": "webhooks.enabled", "cookidoo": "cookidoo.enabled", "web_recipes": "web_recipes.enabled", "yazio_login": "yazio_login.enabled",
              "demo_account": "demo_account.enabled", "vision": "vision.enabled"}
    listing = {"openfoodfacts_catalog": ("openfoodfacts_catalog.countries", "countries", COUNTRY, _country),
               "webhooks": ("webhooks.hosts", "hosts", HOST, lambda v: v)}
    known = {c["key"] for c in connector_list(request)}
    if key not in known:
        raise HTTPException(404, "unknown connector")
    if key not in switch and key not in listing:
        raise HTTPException(422, "this connector cannot be configured here")
    updates: dict = {}
    if body.enabled is not None:
        if key not in switch:
            raise HTTPException(422, "this connector has no switch")
        updates[switch[key]] = body.enabled
    if body.config and key in ("cookidoo", "web_recipes"):
        names = {"cookidoo": ("personal", "images"), "web_recipes": ("images",)}[key]
        if not set(body.config) <= set(names) or not all(isinstance(v, bool) for v in body.config.values()):
            raise HTTPException(422, f"{key}: the settings are {' and '.join(names)} (true or false)")
        for name, value in body.config.items():
            updates[f"{'cookidoo' if key == 'cookidoo' else 'web_recipes'}.{name}"] = value
    elif body.config:
        if key not in listing:
            raise HTTPException(422, "this connector has no settings")
        setting, name, pattern, fix = listing[key]
        unknown = set(body.config) - {name}
        if unknown:
            raise HTTPException(422, f"unknown setting: {sorted(unknown)[0]}")
        values = _names(body.config.get(name), pattern, name, fix)
        if key == "openfoodfacts_catalog" and not values:
            raise HTTPException(422, "at least one country")
        updates[setting] = values
    for setting in updates:
        if features.locked(setting):
            raise HTTPException(409, f"fixed by the environment ({ENV[setting][0]})")
    if key == "demo_account" and updates.get("demo_account.enabled") is True:  # make it (and fill it) before it counts as on
        try:
            demo_account.provision(store, today())
        except demo_account.DemoAccountError as exc:
            raise HTTPException(409, exc.message) from None
    for setting, value in updates.items():
        store.set_global(setting, value)
    if updates.get("cookidoo.enabled") is False:  # a run that takes over many recipes ends (what it saved stays)
        request.app.state.cookidoo_runs.cancel_all("off")
    if updates.get("cookidoo.images") is False:  # a catch-up for pictures ends (what it saved stays); a run that takes recipes over goes on without pictures
        for run in list(request.app.state.cookidoo_runs._runs.values()):
            if run.mode == "pictures":
                request.app.state.cookidoo_runs.cancel(run.key, "off")
    if updates.get("cookidoo.personal") is False:  # runs on people's own accounts end, the shared account's run goes on
        for run_key in [k for k in request.app.state.cookidoo_runs._runs if k.startswith("user:")]:
            request.app.state.cookidoo_runs.cancel(run_key, "account")
    if updates.get("yazio_login.enabled") is False:  # fetches under way end, what they fetched is dropped
        request.app.state.yazio_runs.cancel_all()
    return next(c for c in connector_list(request) if c["key"] == key)


@router.post("/demo-account/reset", response_model=Connector)
def demo_account_reset(request: Request, store: Store = Depends(get_store)) -> dict:
    """Start the demo account over: everything it holds goes, fresh sample data up to today is made."""
    if not request.app.state.features.demo_account:
        raise HTTPException(409, "the demo account is switched off")
    try:
        demo_account.reset(store, today())
    except demo_account.DemoAccountError as exc:
        raise HTTPException(409, exc.message) from None
    return _demo_account_connector(request)


@router.delete("/demo-account", response_model=Connector)
def demo_account_delete(request: Request, store: Store = Depends(get_store)) -> dict:
    """Remove the demo account with everything it holds. The switch goes off (unless the environment fixes it); a running
    switch ends with the next request."""
    features: Features = request.app.state.features
    if not demo_account.delete(store):
        raise HTTPException(404, "there is no demo account")
    if not features.locked("demo_account.enabled"):
        store.set_global("demo_account.enabled", False)
    return _demo_account_connector(request)


@router.get("/catalog/refresh", response_model=RefreshState)
def refresh_state(request: Request) -> dict:
    return request.app.state.refresh.status()


@router.post("/catalog/refresh", response_model=RefreshState, status_code=202)
def refresh_start(request: Request) -> dict:
    """Rebuild the Open Food Facts catalogue in the background (a download of several hundred MB). One at a time."""
    if not request.app.state.refresh.start():
        raise HTTPException(409, "a refresh is already running")
    return request.app.state.refresh.status()

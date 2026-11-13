"""Mahlwerk: self-hosted nutrition diary. Builds the FastAPI app (see docs/api-v1.md)."""

import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from . import __version__
from . import security
from .auth import AuthConfig
from .oidc import OidcClient, RateLimit
from .passwords import PasswordHasher
from .throttle import LoginThrottle
from .catalog import Catalog, default_path
from .db import Store
from .cookidoo import Hub
from .cookidoo_bulk import BulkRuns
from .vault import Vault
from . import yazio_live, yazio_stage
import json
from .features import Features
from .jobs import CatalogRefresh
from .webhooks import Dispatcher
from . import vision, webrecipes
from .imagestore import ImageStore
from .recipeimages import RecipeImages
from .nutrition import valid_gtin  # noqa: F401  (kept importable from here)
from .routes import yazio as yazio_routes
from .routes import activity as activity_routes, admin, badges, catalog, cookidoo as cookidoo_routes, diary, fasting, foods, insights, nutrients, profile, recipe_groups, recipes, summary, suggestions, templates, tokens, water, web_recipes, images as image_routes, vision as vision_routes
from .routes import auth as auth_routes
from .routes import demo_view as demo_view_routes
from .routes import oidc as oidc_routes
from .routes import webhooks as webhook_routes

DEFAULT_WEB_DIR = Path(__file__).resolve().parents[2] / "web" / "dist"


def mount_web(app: FastAPI, web_dir: Path) -> None:
    """Serve the built frontend; unknown paths get index.html so client-side routes survive a reload."""
    root = web_dir.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def web(path: str) -> FileResponse:
        if path.startswith("api/") or path == "api":
            raise HTTPException(404, "Not Found")
        target = (root / path).resolve()
        if target.is_file() and target.is_relative_to(root):
            return FileResponse(target)
        index = root / "index.html"
        if not index.is_file():
            raise HTTPException(404, "Not Found")
        return FileResponse(index)


def create_app(
    db_path: str | None = None,
    transport: httpx.BaseTransport | None = None,
    *,
    password_cost: tuple[int, int, int] | None = None,
    clock=time.time,
    oidc_transport: httpx.BaseTransport | None = None,
    yazio_transport: httpx.AsyncBaseTransport | None = None,
    web_transport: httpx.BaseTransport | None = None,
    vision_transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    """`password_cost` (scrypt N, r, p), `clock` and `oidc_transport` (a stand-in for the provider) and `yazio_transport` (a stand-in for Yazio) and `web_transport` (a stand-in for the web pages of recipes) and `vision_transport` (a stand-in for the image model) exist for the tests only: there is deliberately no environment
    variable that could weaken password hashing in production."""
    contact = os.environ.get("MAHLWERK_CONTACT", "no-contact-configured")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        app.state.webhooks.stop()  # finish or drop running deliveries; nothing is left behind
        await app.state.cookidoo_runs.shutdown()  # a run that takes over many recipes ends; what it saved stays
        await app.state.cookidoo.aclose()
        app.state.vision.client.close()
        if app.state.oidc is not None:
            app.state.oidc.close()

    config = AuthConfig.from_env()
    # the interactive API docs list every route and invite probing: off in local mode unless MAHLWERK_DOCS=1
    docs_on = config.mode not in ("local", "oidc") or os.environ.get("MAHLWERK_DOCS", "").strip().lower() in ("1", "true", "yes")
    app = FastAPI(
        title="Mahlwerk", version=__version__, lifespan=lifespan,
        docs_url="/docs" if docs_on else None, redoc_url="/redoc" if docs_on else None, openapi_url="/openapi.json" if docs_on else None,
    )
    app.state.store = Store(db_path or os.environ.get("MAHLWERK_DB", "./data/mahlwerk.db"))
    app.state.catalog = Catalog(default_path(app.state.store.path))
    app.state.auth = config
    app.state.clock = clock
    app.state.hasher = PasswordHasher(password_cost) if password_cost else PasswordHasher()
    app.state.throttle = LoginThrottle(clock)
    app.state.setup_token = None
    app.state.oidc = OidcClient(config.oidc, oidc_transport, clock) if config.oidc else None
    app.state.oidc_key = None  # the cookie signing key, read from the database at first use
    app.state.demo_key = None  # the same for the cookie of the demo switch
    app.state.oidc_rate = {"login": RateLimit(clock), "callback": RateLimit(clock)}
    if config.mode == "local":
        app.state.hasher.dummy()  # made now, so that the first unknown user name does not cost an extra scrypt run
        # a database that already holds users (switch from single/proxy) needs a code for the setup; an empty one does not
        if app.state.store.needs_setup() and app.state.store.has_users():
            given = os.environ.get("MAHLWERK_SETUP_TOKEN", "").strip()
            if given:
                app.state.setup_token = given
            else:
                auth_routes.setup_code(app)  # makes a random one and writes it once to the log
    app.state.features = Features(app.state.store)
    app.state.cookidoo = Hub(clock=clock)
    # pictures of recipes: files in the `images` folder next to the database; whatever no food refers to any more is tidied at start
    app.state.images = RecipeImages(app.state.store, ImageStore(Path(app.state.store.path).with_name(Path(app.state.store.path).name + ".images")))
    app.state.images.sweep()
    app.state.vault = Vault(app.state.store)
    app.state.yazio_stage = yazio_stage.Staging(clock)

    def deliver(user_id: int, files: dict) -> None:
        """What a direct Yazio fetch brought goes into the person's staging area (as the JSON files of the exporter)."""
        if not app.state.features.yazio_login:  # switched off while the run was under way
            raise yazio_live.LiveError("cancelled")
        try:
            app.state.yazio_stage.add(user_id, {n: json.dumps(v).encode() for n, v in files.items()}, "login", replace=True)
        except yazio_stage.StageError:
            raise yazio_live.LiveError("too_large") from None

    app.state.yazio_runs = yazio_live.Runs(deliver, yazio_transport, clock)
    app.state.webhooks = Dispatcher(app.state.store, app.state.features)
    app.state.web_fetcher = webrecipes.Fetcher(f"Mahlwerk/{__version__} ({contact})", web_transport)
    app.state.cookidoo_runs = BulkRuns(
        app.state.cookidoo, app.state.store, lambda: app.state.features.cookidoo, clock=clock,
        images=app.state.images, fetcher=app.state.web_fetcher, images_on=lambda: app.state.features.cookidoo_images)
    app.state.vision = vision.Vision(clock, vision_transport)
    app.state.web_brake = webrecipes.Brake(clock)
    app.state.web_cache = webrecipes.Cache(clock)
    app.state.image_brake = webrecipes.Brake(clock, per_user=30, total=120)  # fetches of Cookidoo pictures
    app.state.upload_brake = webrecipes.Brake(clock, per_user=20, total=200)  # own photos
    app.state.refresh = CatalogRefresh(app.state.catalog, app.state.features, contact)
    app.state.off = foods.OffClient(
        http=httpx.Client(
            timeout=8,
            transport=transport,
            headers={"User-Agent": f"Mahlwerk/{__version__} ({contact})"},
        ),
        base=os.environ.get("MAHLWERK_OFF_BASE", "https://world.openfoodfacts.org").rstrip("/"),
        cache_seconds=int(os.environ.get("MAHLWERK_CACHE_DAYS", "30")) * 86400,
    )
    app.state.demo_enabled = os.environ.get("MAHLWERK_DEMO_DATA", "").strip().lower() in ("1", "true")
    # optional: keep the last uploaded label photos to improve the reader (off by default)
    app.state.label_debug_dir = os.environ.get("MAHLWERK_LABEL_DEBUG_DIR")

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc: RequestValidationError):
        """Like FastAPI's own 422, but without the offending input: a field that holds a password must never be echoed."""
        errors = [{k: v for k, v in e.items() if k not in ("input", "ctx")} for e in exc.errors()]
        return JSONResponse({"detail": jsonable_encoder(errors)}, status_code=422)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok", "version": __version__}

    app.include_router(auth_routes.router)
    app.include_router(auth_routes.admin_router)
    app.include_router(oidc_routes.router)
    app.include_router(demo_view_routes.router)
    for module in (profile, catalog, foods, diary, insights, nutrients, templates, suggestions, recipes, recipe_groups, badges, water, fasting,
                   summary, tokens, webhook_routes, admin, activity_routes, cookidoo_routes, web_recipes, image_routes, vision_routes):
        app.include_router(module.router)
    app.include_router(yazio_routes.router)
    app.include_router(cookidoo_routes.admin_router)
    app.include_router(cookidoo_routes.me_router)

    web_dir = Path(os.environ.get("MAHLWERK_WEB_DIR") or DEFAULT_WEB_DIR)
    security.install(app, security.build_csp(web_dir if web_dir.is_dir() else None))
    if web_dir.is_dir():
        mount_web(app, web_dir)
    return app


def app() -> FastAPI:
    """Factory for `uvicorn mahlwerk.main:app --factory`."""
    return create_app()

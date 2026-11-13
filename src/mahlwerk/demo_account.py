"""The built-in demo account: one invented user per installation that an ADMIN can switch to, so that the real account holds
only real entries while the whole app can still be tried and shown with full sample data.

What this is NOT: a general "sign in as another user". Exactly one user can be switched to (the reserved user name `demo`),
nobody can sign in as it (see `db.RESERVED_USERNAME`), and only a signed-in admin gets there.

How a request becomes a demo request (see `auth.current_user`):
  * the real sign-in stays as it is (session cookie, proxy header or single user);
  * a second cookie, HMAC-signed with a key kept in the table `setting`, says "show me the demo account". It names the real user
    (and, where the sign-in is a session, binds itself to that very session), and has an expiry;
  * on EVERY request the real identity is checked again and the cookie only counts while the real user is (still) an admin, the
    demo account is switched on and exists, the signature, the binding and the expiry fit. Otherwise it is ignored and removed;
  * an access token never looks at the cookie.
The request then runs as the demo user: `is_admin` is false, `is_demo` is true.

What a demo request may do is decided by ONE table (`POLICY`) that every route of the app must appear in (a test enforces
it). Demo sessions must not change the real household: everything shared (products, recipes, recipe groups and pictures,
connectors, imports) and everything that reaches outwards (webhooks, access keys, Cookidoo, Yazio, web recipes) is closed to
them, whatever the route does. Unknown routes are closed too (fail closed)."""

import base64
import binascii
import hashlib
import hmac
import json
import logging

from fastapi import HTTPException, Request

from . import demo
from .db import RESERVED_USERNAME, NameTaken, Store
from .oidc import b64url

log = logging.getLogger("mahlwerk.demo_account")

COOKIE = "mahlwerk_demo"
KEY_NAME = "demo_view_cookie"
TTL = 12 * 3600  # how long a switch lasts at most where the sign-in is a session (local, oidc): it is also tied to that session
TTL_UNBOUND = 2 * 3600  # in single and proxy mode there is no session to tie it to (it would outlive a sign-out at the proxy), so it is shorter
VIEW_HEADER = "X-Mahlwerk-View"  # `own` or `demo`: what the interface believes it is looking at (requests) and what the server says it is (answers)
VIEW_CHANGED = "view changed"  # the 409 detail: the account behind the cookie is not the one the interface thinks
DAYS = 90  # how much sample history is made
READ_METHODS = ("GET", "HEAD")
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")
BLOCKED_MESSAGE = "not available in the demo account"

# "read": a GET the demo account may do; "own": a write on the user's own data (the demo account's own); "blocked": closed to
# demo requests; "public": no identity is involved (sign-in, sign-out, health check).
POLICY: dict[tuple[str, str], str] = {}


def _classify(kind: str, *routes: str) -> None:
    for route in routes:
        method, path = route.split(" ", 1)
        assert (method, "/api/v1" + path) not in POLICY, route
        POLICY[(method, "/api/v1" + path)] = kind


# no demo identity is involved: the switch itself works with the REAL identity (`auth.real_user`) and never as the demo account
_classify("public", "POST /auth/setup", "POST /auth/login", "POST /auth/logout", "GET /auth/oidc/login", "GET /auth/oidc/callback",
          "POST /me/demo-view/enter", "POST /me/demo-view/leave")
_classify(
    "read",
    "GET /auth/status", "GET /me", "GET /me/imports", "GET /weights", "GET /catalog", "GET /foods", "GET /foods/recent", "GET /foods/{food_id}",
    "GET /diary/{day}", "GET /history", "GET /insights", "GET /insights/nutrient", "GET /insights/foods", "GET /insights/foods/detail",
    "GET /review", "GET /nutrients", "GET /templates", "GET /recipes/suggestions", "GET /recipes", "GET /recipes/{recipe_id}",
    "GET /recipe-groups", "GET /badges", "GET /fasting", "GET /summary/today", "GET /activity", "GET /images/{digest}/{size}",
)
_classify(
    "own",  # these write only rows of the signed-in user, which for a demo request is the demo account
    "PATCH /me/settings", "PUT /me/goal", "PUT /weights/{day}", "DELETE /weights/{day}",
    "POST /diary/{day}/entries", "POST /diary/{day}/copy", "PATCH /diary/entries/{entry_id}", "DELETE /diary/entries/{entry_id}",
    "POST /templates", "PATCH /templates/{template_id}", "DELETE /templates/{template_id}", "POST /templates/{template_id}/apply",
    "POST /badges/seen", "POST /water/{day}", "PUT /water/{day}",
    "POST /fasting/start", "POST /fasting/stop", "PATCH /fasting/{fast_id}", "DELETE /fasting/{fast_id}",
    "PUT /activity/{day}", "POST /workouts", "PATCH /workouts/{workout_id}", "DELETE /workouts/{workout_id}", "POST /health/sync",
    "POST /recipes/ingredients/match",  # reads a pasted ingredient list and looks up foods; writes nothing
    "POST /label-scans",  # reads a photo; writes nothing for the demo account (the debug copy of MAHLWERK_LABEL_DEBUG_DIR is skipped for it)
)
_classify(
    "blocked",
    # the account itself: no name change, no password, no own test data, no accounts
    "PATCH /me", "POST /me/demo-data", "DELETE /me/demo-data", "POST /auth/password",
    "POST /admin/users", "PATCH /admin/users/{username}", "POST /admin/users/{username}/password",
    # shared products, recipes, groups and pictures: the household's, read and book yes, change no
    "GET /foods/barcode/{code}",  # a lookup stores the product it finds (and asks Open Food Facts)
    "PUT /foods/barcode/{code}", "POST /foods", "PUT /foods/{food_id}", "DELETE /foods/{food_id}", "POST /catalog/adopt",
    "POST /recipes", "PUT /recipes/{recipe_id}", "DELETE /recipes/{recipe_id}",
    "POST /recipe-groups", "PUT /recipe-groups/order", "PUT /recipe-groups/foods/{food_id}", "PUT /recipe-groups/{group_id}",
    "DELETE /recipe-groups/{group_id}", "POST /recipe-groups/{group_id}/members", "POST /recipe-groups/{group_id}/members/remove",
    "PUT /foods/{food_id}/image", "DELETE /foods/{food_id}/image", "POST /foods/{food_id}/image/restore",
    # what reaches outwards or lets something in: keys, webhooks, connectors, imports
    "GET /me/tokens", "POST /me/tokens", "DELETE /me/tokens/{token_id}",
    "GET /me/webhooks", "POST /me/webhooks", "PATCH /me/webhooks/{hook_id}", "DELETE /me/webhooks/{hook_id}",
    "POST /me/webhooks/{hook_id}/test", "GET /me/webhooks/{hook_id}/deliveries",
    "DELETE /me/imports/{import_id}",
    "GET /cookidoo/status", "GET /cookidoo/week", "GET /cookidoo/collections", "GET /cookidoo/recipe", "POST /cookidoo/adopt",
    "GET /cookidoo/import/preview", "POST /cookidoo/import", "GET /cookidoo/import", "GET /cookidoo/images/preview",
    "POST /cookidoo/images", "DELETE /cookidoo/import",
    "POST /web-recipes/preview", "POST /web-recipes", "POST /web-recipes/{food_id}/reload",
    "GET /me/yazio", "PUT /me/yazio/files/{name}", "DELETE /me/yazio", "POST /me/yazio/preview", "POST /me/yazio/confirm", "POST /me/yazio/login",
    "GET /me/cookidoo-account", "PUT /me/cookidoo-account", "DELETE /me/cookidoo-account", "POST /me/cookidoo-account/check",
    # the admin area (also closed by is_admin = false; listed so that the table is complete)
    "GET /admin/overview", "GET /admin/users", "GET /admin/connectors", "PATCH /admin/connectors/{key}",
    "GET /admin/catalog/refresh", "POST /admin/catalog/refresh",
    "GET /admin/cookidoo/account", "PUT /admin/cookidoo/account", "DELETE /admin/cookidoo/account", "POST /admin/cookidoo/account/check",
    "POST /admin/demo-account/reset", "DELETE /admin/demo-account",
)


def verdict(method: str, path: str) -> str | None:
    return POLICY.get((method.upper(), path))


def check_view(request: Request, actual: str, via_token: bool) -> None:
    """The interface says which account it shows (header `X-Mahlwerk-View`); a WRITE for another one is refused before it runs,
    so that a tab that did not notice a switch (another tab, an end by time, a switch-off, the loss of the admin right) cannot book
    into the wrong diary. Without the header a write is accepted as before (scripts with a session cookie), except as the demo
    account: a demo write must say `demo`. Reads are never refused; access keys carry no view."""
    if via_token or request.method not in WRITE_METHODS:
        return
    claimed = request.headers.get(VIEW_HEADER)
    if claimed is None and actual == "own":
        return
    if claimed != actual:
        raise HTTPException(409, VIEW_CHANGED, headers={VIEW_HEADER: actual})


def enforce(request: Request, user: dict) -> None:
    """Refuse (403) what a demo request may not do. Fails closed: a route that is not in the table is closed."""
    route = request.scope.get("route")
    kind = verdict(request.method, getattr(route, "path", ""))
    if kind in ("read", "public") and request.method in READ_METHODS:
        return
    if kind == "own" and request.method not in READ_METHODS:
        return
    raise HTTPException(403, BLOCKED_MESSAGE, headers={VIEW_HEADER: "demo"})


# --- the switch cookie ---------------------------------------------------------------------------------------------


def _mac(key: bytes, body: str) -> str:
    return b64url(hmac.new(key, body.encode(), hashlib.sha256).digest())


def bind(key: bytes, session_hash: str | None) -> str:
    """What ties the cookie to the real sign-in session (empty where there is none: single and proxy mode)."""
    return hmac.new(key, b"session:" + session_hash.encode(), hashlib.sha256).hexdigest()[:32] if session_hash else ""


def seal(key: bytes, real_user_id: int, session_hash: str | None, now: float) -> str:
    ttl = TTL if session_hash else TTL_UNBOUND
    body = b64url(json.dumps({"u": real_user_id, "s": bind(key, session_hash), "e": int(now) + ttl}, separators=(",", ":")).encode())
    return body + "." + _mac(key, body)


def open_cookie(key: bytes, value: str, real_user_id: int, session_hash: str | None, now: float) -> bool:
    """Whether the cookie value is a genuine, unexpired switch of THIS real user (and session)."""
    body, _, mac = value.partition(".")
    if not body or not mac or len(value) > 1000:
        return False
    if not hmac.compare_digest(mac.encode(), _mac(key, body).encode()):
        return False
    try:
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        return (
            data["u"] == real_user_id and data["e"] > now and isinstance(data["s"], str)
            and hmac.compare_digest(data["s"].encode(), bind(key, session_hash).encode())
        )
    except (ValueError, KeyError, TypeError, binascii.Error):
        return False


# --- making, filling, resetting and deleting the account -----------------------------------------------------------


class DemoAccountError(Exception):
    """`code`: `exists` (a real user has the reserved name)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def fill(store: Store, user_id: int, today) -> dict:
    """Sample data up to today for the demo account (the days that are there stay), and the settings that fit it."""
    result = demo.generate(store, user_id, today, DAYS, marker="demo_account")
    store.set_setting(user_id, "tour_seen", True)  # the first-run tour would otherwise start again at every switch
    return result


def provision(store: Store, today) -> int:
    """Make the demo account if it is not there (idempotent), fill it up to today, return its id. Never takes over a real user."""
    try:
        user_id, _ = store.create_demo_user()
    except NameTaken:
        raise DemoAccountError(
            "exists", f"a user named '{RESERVED_USERNAME}' already exists: the name is reserved for the demo account, so it cannot be switched on") from None
    fill(store, user_id, today)
    return user_id


def reset(store: Store, today) -> int:
    """Back to a fresh start: everything the demo account holds goes, new sample data up to today is made."""
    user_id = store.demo_account_ready()
    if user_id is None:
        raise DemoAccountError("missing", "there is no demo account")
    store.erase_user_data(user_id)
    fill(store, user_id, today)
    return user_id


def delete(store: Store) -> bool:
    """Empty the account and mark it deleted (the row stays, see db.RESERVED_USERNAME); the switch to it ends at once."""
    user_id = store.demo_account_ready()
    if user_id is None:
        return False
    store.erase_user_data(user_id, deactivate=True)
    return True

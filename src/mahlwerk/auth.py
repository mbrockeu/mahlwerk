"""Who is calling: one fixed user (single), the user a trusted reverse proxy has authenticated (proxy), an account of this
server signed in with a password and a session cookie (local), or a user the OpenID Connect provider has signed in, who then
holds the same kind of session cookie (oidc). An access token (`mw_...`) works in every mode.

An admin who has switched to the built-in demo account (see demo_account.py) is still signed in as themself; `current_user`
then hands the demo user to the routes (`is_demo`), `_identity` and `real_user` always say who really is there."""

import hashlib
import ipaddress
import os
import secrets
from dataclasses import dataclass
from urllib.parse import urlparse

from fastapi import Depends, HTTPException, Request, Response

from . import demo_account
from .db import RESERVED_USERNAME, is_reserved_name
from .oidc import OidcConfig

TOKEN_PREFIX = "mw_"
READ_METHODS = ("GET", "HEAD")
SESSION_COOKIE = "mahlwerk_session"
HOST_PREFIX = "__Host-"  # the browser then insists on Secure, Path=/ and no Domain: no sibling site can plant or overwrite it
OIDC_SESSION_DAYS = 7  # the oidc mode asks the provider again after a week of silence (a withdrawn right then ends sooner)
OIDC_SESSION_MAX_DAYS = 30
SESSION_DAYS = 30
SESSION_TTL = SESSION_DAYS * 86400
SESSION_MAX_AGE = 180 * 86400  # absolute: a session never lives longer than this, however often it is used
MODES = ("single", "proxy", "local", "oidc")
SESSION_MODES = ("local", "oidc")  # the modes whose sign-in is a session cookie


LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})


def normalize_host(value: str) -> str:
    """A Host header or a configured host as a bare lower-case name: port removed, IPv6 in brackets."""
    value = value.strip().lower()
    if value.startswith("["):
        return value[: value.index("]") + 1] if "]" in value else value
    if value.count(":") > 1:  # a bare IPv6 address in the configuration
        return f"[{value}]"
    return value.rsplit(":", 1)[0] if ":" in value else value


def allowed_hosts(mode: str, public_host: str | None = None) -> frozenset | None:
    """MAHLWERK_ALLOWED_HOSTS (comma separated, `*` = any). Unset: only loopback names in `single` mode (no login, so a
    rebinding page could otherwise reach everything); in `oidc` mode the host of MAHLWERK_PUBLIC_URL plus the loopback names;
    no check in `proxy` and `local` (document: set it)."""
    raw = os.environ.get("MAHLWERK_ALLOWED_HOSTS", "").strip()
    if not raw:
        if mode == "oidc" and public_host:
            return LOOPBACK_HOSTS | {normalize_host(public_host)}
        return LOOPBACK_HOSTS if mode == "single" else None
    names = [normalize_host(part) for part in raw.split(",") if part.strip()]
    return None if "*" in names else frozenset(names)


@dataclass
class AuthConfig:
    mode: str = "single"
    single_user: str = "me"
    user_header: str = "Remote-User"
    name_header: str = "Remote-Name"
    groups_header: str = "Remote-Groups"
    admin_group: str = "admin"
    trusted: frozenset = frozenset()
    cookie_secure: bool = False
    # Host names this server answers to (None = any). Against DNS rebinding: a page on an attacker's name that
    # resolves to this server must not be able to talk to it with the visitor's browser.
    allowed_hosts: frozenset | None = None
    # sliding lifetime of a session and the absolute limit (local and oidc mode)
    session_ttl: int = SESSION_TTL
    session_max_age: int = SESSION_MAX_AGE
    oidc: OidcConfig | None = None

    @classmethod
    def from_env(cls) -> "AuthConfig":
        mode = os.environ.get("MAHLWERK_AUTH", "single").strip().lower()
        if mode not in MODES:
            raise ValueError(f"MAHLWERK_AUTH must be 'single', 'proxy', 'local' or 'oidc', not {mode!r}")
        trusted = frozenset(
            ipaddress.ip_address(part.strip())
            for part in os.environ.get("MAHLWERK_TRUSTED_PROXIES", "").split(",")
            if part.strip()
        )
        admin_group = os.environ.get("MAHLWERK_ADMIN_GROUP", "admin").strip() or "admin"
        single_user = os.environ.get("MAHLWERK_SINGLE_USER", "me")
        if mode == "single" and is_reserved_name(single_user):
            raise ValueError(f"MAHLWERK_SINGLE_USER must not be {RESERVED_USERNAME!r}: that name is reserved for the demo account")
        oidc = OidcConfig.from_env(admin_group) if mode == "oidc" else None
        oidc_mode = mode == "oidc"
        days = _days("MAHLWERK_SESSION_DAYS", OIDC_SESSION_DAYS if oidc_mode else SESSION_DAYS)
        max_days = max(days, _days("MAHLWERK_SESSION_MAX_DAYS", OIDC_SESSION_MAX_DAYS if oidc_mode else SESSION_MAX_AGE // 86400))
        return cls(
            mode=mode,
            session_ttl=days * 86400,
            session_max_age=max_days * 86400,
            oidc=oidc,
            allowed_hosts=allowed_hosts(mode, urlparse(oidc.redirect_url).netloc if oidc else None),
            single_user=single_user,
            user_header=os.environ.get("MAHLWERK_PROXY_USER_HEADER", "Remote-User"),
            name_header=os.environ.get("MAHLWERK_PROXY_NAME_HEADER", "Remote-Name"),
            groups_header=os.environ.get("MAHLWERK_PROXY_GROUPS_HEADER", "Remote-Groups"),
            admin_group=admin_group,
            trusted=trusted,
            # behind a TLS proxy the app itself only sees HTTP: an https public address of the oidc mode says "secure" too
            cookie_secure=os.environ.get("MAHLWERK_COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes")
            or (oidc is not None and oidc.redirect_url.startswith("https://")),
        )


def _days(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if not 1 <= value <= 3650:
        raise ValueError(f"{name} must be a whole number of days from 1 to 3650")
    return value


def _header_text(value: str) -> str:
    """Servers hand UTF-8 header bytes over as latin-1 text; undo that."""
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def _peer_is_trusted(request: Request, trusted: frozenset) -> bool:
    # Only the TCP peer counts. X-Forwarded-For is client-controlled and never consulted.
    if request.client is None:
        return False
    try:
        return ipaddress.ip_address(request.client.host) in trusted
    except ValueError:
        return False


def new_token() -> str:
    """A fresh access token: `mw_` and 43 URL-safe characters (32 random bytes)."""
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _bearer_token(request: Request) -> str | None:
    """The access token in `Authorization: Bearer mw_...`, if there is one. Never read from the URL."""
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    value = value.strip()
    if scheme.lower() == "bearer" and value.startswith(TOKEN_PREFIX):
        return value
    return None


def _token_user(request: Request, token: str) -> dict:
    if not request.app.state.features.tokens:
        raise HTTPException(401, "access tokens are switched off")
    store = request.app.state.store
    # in local mode a user without a password (left over from single/proxy) has no valid keys
    row = store.find_token(hash_token(token), require_password=request.app.state.auth.mode == "local")
    if row is None:
        raise HTTPException(401, "invalid, expired or revoked access token")
    if row["scope"] == "read" and request.method not in READ_METHODS:
        raise HTTPException(403, "this access token may only read")
    store.touch_token(row["token_id"])
    # a token never makes its owner an admin and cannot manage tokens or webhooks (see `session_user`)
    return {"id": row["id"], "username": row["username"], "display_name": row["display_name"], "is_admin": False, "via_token": True}


def _is_admin(request: Request, config: AuthConfig) -> bool:
    if config.mode == "single":
        return True
    raw = _header_text(request.headers.get(config.groups_header, ""))
    return config.admin_group in {part.strip() for part in raw.split(",") if part.strip()}


def client_ip(request: Request, config: AuthConfig) -> str:
    """The address the brake counts: the TCP peer, or, when the peer is a trusted proxy, the last X-Forwarded-For entry
    (the one that proxy appended itself; earlier entries are client-controlled)."""
    peer = request.client.host if request.client else "unknown"
    if request.client is not None and _peer_is_trusted(request, config.trusted):
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
        if forwarded:
            return forwarded[:64]
    return peer


def is_secure(request: Request, config: AuthConfig) -> bool:
    """Whether the session cookie gets the `Secure` flag: the request came over HTTPS, a trusted proxy says so, or
    MAHLWERK_COOKIE_SECURE is set (behind a TLS proxy the app itself only sees HTTP)."""
    if config.cookie_secure or request.url.scheme == "https":
        return True
    return _peer_is_trusted(request, config.trusted) and request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower() == "https"


def session_cookie_name(request: Request) -> str:
    """`__Host-mahlwerk_session` when the cookie is Secure, else `mahlwerk_session`. Only the name that fits the request is
    read: over HTTPS the unprefixed cookie (which a sibling site could have planted) is never looked at."""
    return HOST_PREFIX + SESSION_COOKIE if is_secure(request, request.app.state.auth) else SESSION_COOKIE


def set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        session_cookie_name(request), token, max_age=request.app.state.auth.session_ttl, path="/", httponly=True, samesite="lax",
        secure=is_secure(request, request.app.state.auth),
    )


def clear_session_cookie(request: Request, response: Response) -> None:
    response.delete_cookie(session_cookie_name(request), path="/", httponly=True, samesite="lax", secure=is_secure(request, request.app.state.auth))


def start_session(request: Request, response: Response, store, user_id: int) -> None:
    """Sign this browser in as the user: a new session (the one it had before ends) and its cookie."""
    config = request.app.state.auth
    if old := request.cookies.get(session_cookie_name(request)):
        store.delete_session(hash_token(old))
    token = secrets.token_urlsafe(32)
    store.create_session(user_id, hash_token(token), int(request.app.state.clock()), config.session_ttl)
    set_session_cookie(request, response, token)


def _session_user(request: Request, response: Response) -> dict:
    """The account behind the session cookie (local and oidc mode). Remote-User headers are never looked at in these modes."""
    token = request.cookies.get(session_cookie_name(request), "")
    config: AuthConfig = request.app.state.auth
    row = request.app.state.store.find_session(
        hash_token(token), int(request.app.state.clock()), config.session_ttl, config.session_max_age,
        require_password=config.mode == "local", oidc_issuer=config.oidc.issuer if config.oidc else None,
    ) if token else None
    if row is None:
        raise HTTPException(401, "not authenticated")
    if row.pop("renewed"):
        set_session_cookie(request, response, token)  # keep the cookie as long-lived as the sliding session
    return {"id": row["id"], "username": row["username"], "display_name": row["display_name"],
            "is_admin": row["local_admin"], "via_token": False, "session_hash": hash_token(token)}


def demo_cookie_name(request: Request) -> str:
    """The cookie of the demo switch: `__Host-mahlwerk_demo` when Secure, else `mahlwerk_demo` (same reasoning as the session cookie)."""
    return HOST_PREFIX + demo_account.COOKIE if is_secure(request, request.app.state.auth) else demo_account.COOKIE


def set_demo_cookie(request: Request, response: Response, value: str) -> None:
    response.set_cookie(
        demo_cookie_name(request), value, max_age=demo_account.TTL if is_session_mode(request) else demo_account.TTL_UNBOUND, path="/", httponly=True, samesite="lax",
        secure=is_secure(request, request.app.state.auth),
    )


def is_session_mode(request: Request) -> bool:
    return request.app.state.auth.mode in SESSION_MODES


def clear_demo_cookie(request: Request, response: Response) -> None:
    response.delete_cookie(demo_cookie_name(request), path="/", httponly=True, samesite="lax", secure=is_secure(request, request.app.state.auth))


def demo_key(request: Request) -> bytes:
    state = request.app.state
    if state.demo_key is None:
        state.demo_key = state.store.secret_key(demo_account.KEY_NAME)
    return state.demo_key


def _demo_view(request: Request, response: Response, real: dict) -> dict:
    """`real` itself, or, while it has switched to the demo account, the demo user.

    The cookie is looked at on every request and counts only while ALL of this holds: the caller did not use an access token,
    the real identity is an admin right now (proxy: from the group header of THIS request), the demo account is switched on and
    exists, and the cookie is genuine, unexpired and made for this very user and session. Anything else: the cookie is ignored
    (and removed), the request is simply the real user's. The demo user is never an admin and never a token caller."""
    if real["via_token"]:
        return real
    value = request.cookies.get(demo_cookie_name(request))
    if not value:
        return real
    state = request.app.state
    demo_row = None
    if real["is_admin"] and state.features.demo_account and (demo_id := state.store.demo_account_ready()) is not None:
        if demo_account.open_cookie(demo_key(request), value, real["id"], real.get("session_hash"), state.clock()):
            demo_row = state.store.find_user(RESERVED_USERNAME)
            if demo_row is not None and demo_row["id"] != demo_id:
                demo_row = None
    if demo_row is None:
        clear_demo_cookie(request, response)
        return real
    return {"id": demo_row["id"], "username": demo_row["username"], "display_name": demo_row["display_name"], "is_admin": False,
            "via_token": False, "is_demo": True, "session_hash": real.get("session_hash")}


def effective_name(store, user_id: int, provider_name: str, username: str) -> str:
    """The name shown for a user: the one they chose, else the provider's (proxy header, OIDC claim, local setup), else the user name."""
    return store.own_name(user_id) or provider_name or username


def current_user(request: Request, response: Response) -> dict:
    """The caller (see `_identity`) with the display name they chose, which wins over the provider's name in every mode.

    `provider_name` keeps the name the provider delivered; `name_custom` says whether the shown name is the user's own.
    """
    real = _identity(request, response)
    user = _demo_view(request, response, real)
    store = request.app.state.store
    own = store.own_name(user["id"])
    actual = "demo" if user.get("is_demo") else "own"
    demo_account.check_view(request, actual, real["via_token"])
    if not real["via_token"]:
        response.headers[demo_account.VIEW_HEADER] = actual  # every answer says which account it is for
    out = {"is_demo": False, **user, "display_name": own or user["display_name"] or user["username"], "provider_name": user["display_name"], "name_custom": own is not None}
    if user.get("is_demo"):
        demo_account.enforce(request, user)  # a demo request may do only what the table in demo_account.py allows
        out["demo_real"] = {"username": real["username"], "display_name": store.own_name(real["id"]) or real["display_name"] or real["username"]}
    return out


def _identity(request: Request, response: Response) -> dict:
    """FastAPI dependency: the user row (id, username, display_name), created on first sight (single, proxy).

    Besides the identity it says whether the caller is an admin (single: always; proxy: decided per request from the
    proxy's group header, never stored; local: the stored admin flag; oidc: the flag set at the last sign-in from the
    provider's groups) and whether an access token was used (`via_token`;
    such a caller is never an admin). A token wins over proxy headers and cookies and works in every mode, from any peer.
    This is the REAL identity; `current_user` may turn it into the demo account (see `_demo_view`).
    """
    if (token := _bearer_token(request)) is not None:
        return _token_user(request, token)
    config: AuthConfig = request.app.state.auth
    if config.mode in SESSION_MODES:
        return _session_user(request, response)
    if config.mode == "single":
        username, display = config.single_user, config.single_user
    else:
        denied = HTTPException(401, "not authenticated")
        if not _peer_is_trusted(request, config.trusted):
            raise denied
        username = _header_text(request.headers.get(config.user_header, "")).strip()
        if not username or len(username) > 200:
            raise denied
        display = _header_text(request.headers.get(config.name_header, "")).strip()[:200] or username
    if is_reserved_name(username):  # nobody is the demo account, whatever the proxy or the configuration says
        raise HTTPException(403, "this user name is reserved")
    user = request.app.state.store.get_or_create_user(username, display)
    return {**user, "is_admin": _is_admin(request, config), "via_token": False}


def real_user(request: Request, response: Response) -> dict:
    """The caller as they really are, never the demo account (starting and ending the demo switch): signed in the normal
    way, so an access token is refused."""
    user = _identity(request, response)
    if user["via_token"]:
        raise HTTPException(403, "not available with an access token")
    return user


def session_user(user: dict = Depends(current_user)) -> dict:
    """The caller signed in the normal way: an access token is refused (managing tokens or webhooks)."""
    if user["via_token"]:
        raise HTTPException(403, "not available with an access token")
    return user


def require_admin(user: dict = Depends(session_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(403, "admin only")
    return user

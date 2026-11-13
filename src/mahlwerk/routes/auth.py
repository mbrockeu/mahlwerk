"""Accounts of this server (MAHLWERK_AUTH=local): first-start setup, sign-in and out, own password, and the admin's
user management. In the modes `single` and `proxy` these endpoints answer 404, except `status`."""

import hmac
import ipaddress
import logging
import re
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, StringConstraints, field_validator

from .. import passwords
from ..throttle import PRESSURE_DELAY, QUEUE_WAIT
from ..auth import (
    SESSION_MODES, client_ip, clear_demo_cookie, clear_session_cookie, current_user, effective_name, hash_token, require_admin, session_cookie_name, session_user,
    start_session,
)
from ..db import LastAdmin, NameTaken, ReservedName, SetupDone, Store, is_reserved_name
from ..deps import get_store

USERNAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$")  # raw value; _clean_name lower-cases after the check
Password = Annotated[str, Field(min_length=passwords.MIN_LENGTH, max_length=passwords.MAX_LENGTH)]
GENERIC = "invalid user name or password"
log = logging.getLogger("mahlwerk.auth")


def need_local(request: Request) -> None:
    if request.app.state.auth.mode != "local":
        raise HTTPException(404, "not available in this sign-in mode")


def need_sessions(request: Request) -> None:
    """For what works with a session cookie in both modes that have one: sign out, block and unblock."""
    if request.app.state.auth.mode not in SESSION_MODES:
        raise HTTPException(404, "not available in this sign-in mode")


class Status(BaseModel):
    mode: str = Field(description="single, proxy, local or oidc")
    oidc_label: str | None = Field(None, description="oidc mode: the provider's name for the sign-in button (null: none configured)")
    setup_required: bool = Field(description="local mode only: nobody has a password yet, the first admin can be created")
    setup_code_required: bool = Field(False, description="the setup needs the setup code (the database already holds users from another mode)")
    authenticated: bool
    username: str | None = None
    display_name: str | None = None
    is_admin: bool | None = None


def _clean_name(value: str) -> str:
    value = value.strip()
    # ASCII and the pattern on the raw value, lower-casing last: "K" (Kelvin sign) would otherwise turn into a plain "k"
    if not value.isascii() or not USERNAME.match(value):
        raise ValueError("user name: 1 to 40 letters a-z, digits, dot, dash or underscore, starting with a letter or digit")
    if is_reserved_name(value):
        raise ValueError("this user name is reserved")
    return value.lower()


class SetupIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)] = ""
    password: Password
    setup_code: str = Field("", max_length=200)

    @field_validator("username")
    @classmethod
    def _name(cls, value: str) -> str:
        return _clean_name(value)


class NewAccount(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)] = ""
    password: Password

    @field_validator("username")
    @classmethod
    def _name(cls, value: str) -> str:
        return _clean_name(value)


class NewUser(NewAccount):
    is_admin: bool = False


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=passwords.MAX_LENGTH)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=passwords.MAX_LENGTH)
    new_password: Password


class PasswordReset(BaseModel):
    password: Password


class UserPatch(BaseModel):
    disabled: bool | None = None
    is_admin: bool | None = None


class Account(BaseModel):
    username: str
    display_name: str
    is_admin: bool
    disabled: bool = False


router = APIRouter(prefix="/api/v1/auth")
admin_router = APIRouter(prefix="/api/v1/admin/users", dependencies=[Depends(require_admin)])
_start_session = start_session  # signing in again replaces this browser's earlier session


def _address_key(request: Request) -> str:
    """The client address for the brake; an IPv6 address counts as its /64 network (one customer holds a whole /64)."""
    host = client_ip(request, request.app.state.auth)
    try:
        addr = ipaddress.ip_address(host.split("%")[0])
    except ValueError:
        return "ip:" + host
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return "ip:" + str(addr.ipv4_mapped)
        return "ip:" + str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return "ip:" + host


def _brake(request: Request, name: str) -> tuple[str, str, str]:
    """Refuse with 429 while this address or this name from this address is held back. Returns (address key, pair key,
    normalised name); the name is normalised exactly like the account lookup, so "Alex " and "alex" are one."""
    name = name.strip().lower()[:200]
    address = _address_key(request)
    pair = f"p:{name}|{address}"
    wait = request.app.state.throttle.wait(address, pair)
    if wait:
        raise HTTPException(429, "too many failed attempts, try again later", headers={"Retry-After": str(wait)})
    return address, pair, name


@router.get("/status", response_model=Status, response_model_exclude_unset=True)
def status(request: Request, response: Response, store: Store = Depends(get_store)) -> dict:
    """Public. Says how people sign in here and whether this caller already is."""
    mode = request.app.state.auth.mode
    try:
        user = current_user(request, response)
    except HTTPException:
        user = None
    label = {"oidc_label": request.app.state.auth.oidc.button_label or None} if mode == "oidc" else {}  # only this mode has the key
    return {
        **label, "mode": mode, "setup_required": mode == "local" and store.needs_setup(),
        "setup_code_required": mode == "local" and store.needs_setup() and store.has_users(), "authenticated": user is not None,
        "username": user and user["username"], "display_name": user and user["display_name"], "is_admin": user and user["is_admin"],
    }


@router.post("/setup", response_model=Account, status_code=201, dependencies=[Depends(need_local)])
def setup(body: SetupIn, request: Request, response: Response, store: Store = Depends(get_store)) -> dict:
    """Create the first admin and sign in. Possible only while nobody has a password; afterwards 409. When the database
    already holds users (a switch from single or proxy mode) the setup code is required: MAHLWERK_SETUP_TOKEN, or the
    random code written once to the log at start."""
    if not store.needs_setup():
        raise HTTPException(409, "already set up")
    if store.has_users():
        keys = _brake(request, "setup code")
        if not hmac.compare_digest(body.setup_code.encode(), setup_code(request.app).encode()):
            request.app.state.throttle.fail(keys[0], keys[1])
            raise HTTPException(403, "the setup code is wrong")
    hasher: passwords.PasswordHasher = request.app.state.hasher
    try:
        user = store.setup_first_admin(body.username, body.display_name or body.username, hasher.hash(body.password))
    except SetupDone:
        raise HTTPException(409, "already set up") from None
    except ReservedName:
        raise HTTPException(422, "this user name is reserved") from None
    _start_session(request, response, store, user["id"])
    return {"username": user["username"], "display_name": user["display_name"], "is_admin": True}


def setup_code(app) -> str:
    """The code that guards the setup of a non-empty database. Made once; written to the log only when it was not given."""
    if app.state.setup_token is None:
        app.state.setup_token = secrets.token_urlsafe(16)
        log.warning("Mahlwerk setup code (needed once to create the first admin): %s", app.state.setup_token)
    return app.state.setup_token


@router.post("/login", response_model=Account, dependencies=[Depends(need_local)])
def login(body: Login, request: Request, response: Response, store: Store = Depends(get_store)) -> dict:
    address, pair, name = _brake(request, body.username)
    throttle, hasher = request.app.state.throttle, request.app.state.hasher
    pressure = throttle.under_pressure(name)
    turn = throttle.name_turn(name) if pressure else None
    if turn is not None and not turn.acquire(timeout=QUEUE_WAIT):
        raise HTTPException(429, "too many attempts for this user name, try again in a moment", headers={"Retry-After": "5"})
    try:
        row = store.local_user(name)
        if row is not None and is_reserved_name(row["username"]):
            row = None  # the demo account has no password and nobody signs in as it: answers like an unknown name
        # an unknown name still costs one scrypt run, so timing does not tell it apart from a wrong password
        ok = hasher.verify(body.password, row["password_hash"] if row else None)
        if row is None or not ok or row["disabled"]:  # a blocked account answers like a wrong password
            throttle.fail(address, pair, name=name)
            if pressure:
                throttle.sleep(PRESSURE_DELAY)
            raise HTTPException(401, GENERIC)
    finally:
        if turn is not None:
            turn.release()
    throttle.success(pair)  # the address keeps its count: one's own login must not wipe a guessing run
    if hasher.needs_rehash(row["password_hash"]):
        store.set_password(row["id"], hasher.hash(body.password))
    _start_session(request, response, store, row["id"])
    return {"username": row["username"], "display_name": effective_name(store, row["id"], row["display_name"], row["username"]),
            "is_admin": bool(row["local_admin"])}


@router.post("/logout", status_code=204, dependencies=[Depends(need_sessions)])
async def logout(request: Request, response: Response, store: Store = Depends(get_store)) -> None:
    if token := request.cookies.get(session_cookie_name(request)):
        user_id = store.session_user_id(hash_token(token))
        store.delete_session(hash_token(token))
        if user_id is not None:  # the person's own Cookidoo sign-in is not kept in memory after they sign out
            await request.app.state.cookidoo.forget(f"user:{user_id}")
            request.app.state.yazio_runs.cancel(user_id)  # a running Yazio fetch ends with the session
            request.app.state.yazio_stage.clear(user_id)
    clear_session_cookie(request, response)
    clear_demo_cookie(request, response)  # signing out ends a switch to the demo account too


@router.post("/password", status_code=204, dependencies=[Depends(need_local)])
def change_password(body: PasswordChange, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> None:
    """Change the own password (the old one is required). All other sessions of this user end; access keys stay valid."""
    address, pair, name = _brake(request, user["username"])
    hasher: passwords.PasswordHasher = request.app.state.hasher
    row = store.local_user(name)
    if row is None or not hasher.verify(body.current_password, row["password_hash"]):
        request.app.state.throttle.fail(address, pair)
        raise HTTPException(403, "the current password is wrong")
    request.app.state.throttle.success(pair)
    store.set_password(user["id"], hasher.hash(body.new_password))
    store.delete_user_sessions(user["id"], keep_hash=user["session_hash"])


def _target(store: Store, username: str) -> dict:
    row = store.local_user(username.strip())
    if row is None:
        raise HTTPException(404, "unknown user")
    if is_reserved_name(row["username"]):  # the demo account is managed on its card in the admin area, never as a user
        raise HTTPException(409, "the demo account is managed in the admin area, not here")
    return row


@admin_router.post("", response_model=Account, status_code=201, dependencies=[Depends(need_local)])
def create_user(body: NewUser, request: Request, store: Store = Depends(get_store)) -> dict:
    try:
        user = store.create_local_user(body.username, body.display_name or body.username, request.app.state.hasher.hash(body.password), body.is_admin)
    except ReservedName:
        raise HTTPException(422, "this user name is reserved") from None
    except NameTaken:
        raise HTTPException(409, "this user name is taken") from None
    return {"username": user["username"], "display_name": user["display_name"], "is_admin": body.is_admin}


@admin_router.patch("/{username}", response_model=Account, dependencies=[Depends(need_sessions)])
async def patch_user(username: str, body: UserPatch, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> dict:
    """Block or unblock, give or take the admin right. The last active admin can be neither blocked nor demoted.
    In oidc mode only blocking works: the admin right comes from the provider's groups at every sign-in, and nobody
    blocks themself (the provider's group would let them back in, the block would not)."""
    row = _target(store, username)
    if request.app.state.auth.mode == "oidc":
        if body.is_admin is not None:
            raise HTTPException(409, "the admin right comes from the provider's groups")
        if body.disabled and row["id"] == user["id"]:
            raise HTTPException(409, "you cannot block yourself")
    try:
        store.change_account(row["id"], disabled=body.disabled, admin=body.is_admin)
    except LastAdmin:
        raise HTTPException(409, "this is the last active admin") from None
    if body.disabled:
        await request.app.state.cookidoo.forget(f"user:{row['id']}")
        request.app.state.yazio_runs.cancel(row["id"])
        request.app.state.yazio_stage.clear(row["id"])
    row = store.local_user(row["username"])
    return {"username": row["username"], "display_name": effective_name(store, row["id"], row["display_name"], row["username"]),
            "is_admin": bool(row["local_admin"]), "disabled": bool(row["disabled"])}


@admin_router.post("/{username}/password", status_code=204, dependencies=[Depends(need_local)])
def reset_password(username: str, body: PasswordReset, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> None:
    """Set a new initial password for someone else; their sessions end and their access keys are revoked. For the own password use /auth/password."""
    row = _target(store, username)
    if row["id"] == user["id"]:
        raise HTTPException(409, "use the password change for your own password")
    store.set_password(row["id"], request.app.state.hasher.hash(body.password))
    store.delete_user_sessions(row["id"])
    store.revoke_user_tokens(row["id"])  # the reset is for a lost or leaked password: the keys go with it

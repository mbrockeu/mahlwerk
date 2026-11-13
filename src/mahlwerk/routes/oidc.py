"""Sign-in through an OpenID Connect provider (MAHLWERK_AUTH=oidc): the two browser endpoints of the Authorization Code
Flow. In every other mode they answer 404. Sign-out is `POST /auth/logout`, shared with the local mode.

Both endpoints are GET and both change state (login stores a pending sign-in, callback signs someone in), so the CSRF
header cannot protect them: the provider sends the browser back by a plain redirect, which cannot carry it. What protects
them instead:
  * `state` is random and sits in a short-lived HttpOnly cookie of THIS browser (one cookie: state, nonce, PKCE verifier,
    target and expiry, signed with an HMAC; nothing is kept on the server). The callback needs the cookie AND the same state
    in the URL. A page that makes a victim's browser open the callback with the attacker's code (login CSRF) fails: the
    victim's browser has no matching cookie. The code itself works once, which the provider enforces.
  * `nonce` ties the ID token to this sign-in, the PKCE verifier ties the code to this client.
  * Starting a sign-in only costs a redirect; nothing happens to an existing session until a valid callback arrives. Both
    endpoints are limited per address (30 a minute each) so nobody can make the server call the provider without end.
  * One cookie means one sign-in at a time per browser: starting a second one in another tab replaces the first, whose
    answer then fails with the plain "did not work, try again" message.
"""

import hmac
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from ..auth import HOST_PREFIX, is_secure, start_session
from ..db import SignInRefused, Store
from ..deps import get_store
from ..oidc import OidcClient, OidcError, Pending, new_login, open_login, safe_next, seal_login
from .auth import _address_key

log = logging.getLogger("mahlwerk.oidc")
COOKIE = "mahlwerk_oidc"
ERRORS = ("denied", "failed", "expired", "blocked", "conflict", "exists", "name")
KEY_NAME = "oidc_cookie"


def need_oidc(request: Request) -> None:
    if request.app.state.auth.mode != "oidc":
        raise HTTPException(404, "not available in this sign-in mode")


router = APIRouter(prefix="/api/v1/auth/oidc", dependencies=[Depends(need_oidc)])


def _secure(request: Request) -> bool:
    return is_secure(request, request.app.state.auth)


def _cookie_name(request: Request) -> str:
    """With Secure the cookie gets the `__Host-` prefix (Path=/, no Domain) and only that name is read."""
    return HOST_PREFIX + COOKIE if _secure(request) else COOKIE


def _drop_cookie(request: Request, response: RedirectResponse) -> None:
    response.delete_cookie(_cookie_name(request), path="/", httponly=True, samesite="lax", secure=_secure(request))


def _limit(request: Request, which: str) -> None:
    wait = request.app.state.oidc_rate[which].allow(_address_key(request))
    if wait:
        raise HTTPException(429, "too many sign-in attempts, try again in a moment", headers={"Retry-After": str(wait)})


def _key(request: Request) -> bytes:
    state = request.app.state
    if state.oidc_key is None:
        state.oidc_key = state.store.secret_key(KEY_NAME)
    return state.oidc_key


def _fail(request: Request, code: str, detail: str) -> RedirectResponse:
    """Back to the start page with a fixed word the sign-in page turns into a neutral message. The reason goes to the log
    (no tokens, codes, secrets or claim values in it). The pending-sign-in cookie is always deleted."""
    assert code in ERRORS
    log.warning("OpenID Connect sign-in failed (%s): %s", code, detail)
    response = RedirectResponse(request.app.state.auth.oidc.home_path + "?auth_error=" + code, status_code=303)
    _drop_cookie(request, response)
    return response


@router.get("/login", include_in_schema=False)
def login(request: Request, next: str | None = Query(None, max_length=400)) -> RedirectResponse:
    """Start a sign-in: make state, nonce and PKCE verifier, put them (signed) into a cookie of this browser and send the
    browser to the provider. `next` (optional) is a path on this site to open afterwards."""
    _limit(request, "login")
    config = request.app.state.auth.oidc
    client: OidcClient = request.app.state.oidc
    state, nonce, verifier, challenge = new_login()
    try:
        url = client.authorization_url(state, nonce, challenge)
    except OidcError as exc:
        return _fail(request, "failed", exc.detail)
    pending = Pending(state, nonce, verifier, safe_next(next, config.home_path))
    response = RedirectResponse(url, status_code=302)
    # Lax, not Strict: the way back is a top-level navigation coming from the provider, which Strict would not send it with
    response.set_cookie(_cookie_name(request), seal_login(_key(request), pending, request.app.state.clock()), max_age=600, path="/",
                        httponly=True, samesite="lax", secure=_secure(request))
    return response


@router.get("/callback", include_in_schema=False)
def callback(
    request: Request,
    code: str | None = Query(None, max_length=4096),
    state: str | None = Query(None, max_length=512),
    error: str | None = Query(None, max_length=200),
    iss: str | None = Query(None, max_length=2048),
    store: Store = Depends(get_store),
) -> RedirectResponse:
    _limit(request, "callback")
    config = request.app.state.auth.oidc
    client: OidcClient = request.app.state.oidc
    cookie = request.cookies.get(_cookie_name(request), "")
    pending = open_login(_key(request), cookie, request.app.state.clock()) if cookie else None
    if pending is None:
        return _fail(request, "expired", "no valid pending sign-in for this browser (cookie missing, forged, used up or older than 10 minutes)")
    if not state or not hmac.compare_digest(state.encode(), pending.state.encode()):
        return _fail(request, "failed", "state differs")
    try:
        doc = client.discovery()
        # RFC 9207: an answer that names another issuer is refused; when the provider says it always sends `iss`, it is required
        if (iss is not None and iss != doc["issuer"]) or (iss is None and doc.get("authorization_response_iss_parameter_supported") is True):
            raise OidcError("failed", "iss parameter missing or differs from the issuer")
        if error is not None:
            raise OidcError("denied", "the provider answered with error " + "".join(ch for ch in error[:40] if ch.isalnum() or ch in "_-"))
        if not code:
            raise OidcError("failed", "no code in the answer")
        who = client.identity(code, pending.verifier, pending.nonce)
        user = store.oidc_sign_in(who["issuer"], who["sub"], who["username"], who["display_name"], who["admin"], config.link_existing)
    except OidcError as exc:
        return _fail(request, exc.code, exc.detail)
    except SignInRefused as exc:
        return _fail(request, exc.code, {
            "blocked": "the account is blocked",
            "conflict": "the user name already belongs to another identity at the provider",
            "exists": "a user of this name exists without a link to the provider (set MAHLWERK_OIDC_LINK_EXISTING=1 to take it over)",
            "name": "the user name is reserved for the demo account",
        }[exc.code])
    response = RedirectResponse(pending.next, status_code=303)
    _drop_cookie(request, response)
    start_session(request, response, store, user["id"])
    return response

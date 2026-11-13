"""Switching an admin to the built-in demo account and back (see demo_account.py).

Both endpoints work with the REAL identity (`real_user`): a session or proxy/single sign-in, never an access token. The CSRF
header is required like for every write. Only an admin may switch, and only to the demo account: there is no way to name
another user here."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import demo_account
from ..auth import clear_demo_cookie, demo_key, real_user, set_demo_cookie
from ..db import Store
from ..deps import get_store
from ..models import DemoAccountInfo
from .diary import today

router = APIRouter(prefix="/api/v1/me/demo-view")


@router.post("/enter", response_model=DemoAccountInfo)
def enter(request: Request, response: Response, user: dict = Depends(real_user), store: Store = Depends(get_store)) -> DemoAccountInfo:
    """Switch this browser to the demo account (12 hours at most). The sample data is topped up to today first."""
    if not user["is_admin"]:
        raise HTTPException(403, "admin only")
    if not request.app.state.features.demo_account:
        raise HTTPException(404, "the demo account is switched off")
    try:
        demo_account.provision(store, today())  # makes it when only the environment switched it on, and fills it up to today
    except demo_account.DemoAccountError as exc:
        raise HTTPException(409, exc.message) from None
    response.headers[demo_account.VIEW_HEADER] = "demo"
    set_demo_cookie(request, response, demo_account.seal(demo_key(request), user["id"], user.get("session_hash"), request.app.state.clock()))
    return DemoAccountInfo(can_switch=False, viewing=True, real_username=user["username"], real_display_name=user["display_name"])


@router.post("/leave", status_code=204)
def leave(request: Request, response: Response, user: dict = Depends(real_user)) -> None:
    """Back to the own account. Always works for a signed-in caller, whatever the state of the demo account."""
    response.headers[demo_account.VIEW_HEADER] = "own"
    clear_demo_cookie(request, response)

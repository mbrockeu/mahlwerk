"""Badges: what the person has earned, what is still open, and what they have already been shown."""

from fastapi import APIRouter, Depends, Request

from .. import badges
from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..models import Badges, BadgesSeenIn
from ..webhooks import emit

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

EMPTY = {"earned": [], "open": [], "new": []}


def _playful(store: Store, user_id: int) -> bool:
    return bool(store.get_settings(user_id).get("playful", True))


def _overview(request: Request, user: dict, store: Store) -> dict:
    """Bring the badges up to date; every badge reached by this call is announced to the user's webhooks."""
    before = {b["code"] for b in store.badges_earned(user["id"])}
    result = badges.overview(store, user["id"], store.get_goal(user["id"]))
    for item in result["earned"]:
        if item["code"] not in before:
            emit(request, user, "badge.earned", {"code": item["code"], "earned_at": item["earned_at"]})
    return result


@router.get("/badges", response_model=Badges)
def get_badges(request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> dict:
    if not _playful(store, user["id"]):
        return EMPTY
    return _overview(request, user, store)


@router.post("/badges/seen", response_model=Badges)
def mark_seen(body: BadgesSeenIn, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> dict:
    if not _playful(store, user["id"]):
        return EMPTY
    store.mark_badges_seen(user["id"], body.codes)
    return _overview(request, user, store)

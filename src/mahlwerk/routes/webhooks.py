"""Outgoing webhooks of the signed-in user (see webhooks.py for the delivery)."""

import secrets
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request

from ..admin_models import Delivery, Webhook, WebhookCreated, WebhookIn, WebhookPatch
from ..auth import session_user
from ..db import Store
from ..deps import get_store
from .. import netguard
from ..webhooks import PING, check_url, host_of

MAX_HOOKS = 20


def need_webhooks(request: Request) -> None:
    if not request.app.state.features.webhooks:
        raise HTTPException(404, "webhooks are switched off")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(session_user), Depends(need_webhooks)])


def _check_target(request: Request, url: str) -> None:
    if (problem := check_url(url)) is not None:
        raise HTTPException(422, problem)
    if not request.app.state.features.host_allowed(host_of(url)):
        raise HTTPException(422, "this host is not on the list of allowed webhook targets")
    # one answer for "does not resolve", "internal" and everything else: no oracle for the inside of the network
    host = host_of(url)
    try:
        port = urlsplit(url).port or (443 if url.lower().startswith("https") else 80)
        netguard.pick_address(host, port, allow_internal=request.app.state.features.host_listed(host))
    except (netguard.TargetNotAllowed, ValueError):
        raise HTTPException(422, "target not allowed: it must be a public address, or an admin lists its host in the allowed webhook hosts") from None


def _own(store: Store, user_id: int, hook_id: int) -> dict:
    hook = store.get_webhook(user_id, hook_id)
    if hook is None:
        raise HTTPException(404, "unknown webhook")
    return hook


@router.get("/me/webhooks", response_model=list[Webhook])
def list_webhooks(user: dict = Depends(session_user), store: Store = Depends(get_store)) -> list[dict]:
    return store.list_webhooks(user["id"])


@router.post("/me/webhooks", response_model=WebhookCreated, status_code=201)
def create_webhook(
    body: WebhookIn, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)
) -> dict:
    """Register a target. The signing secret is generated here and shown only in this response."""
    _check_target(request, body.url)
    if len(store.list_webhooks(user["id"])) >= MAX_HOOKS:
        raise HTTPException(409, f"at most {MAX_HOOKS} webhooks")
    secret = "whsec_" + secrets.token_urlsafe(24)
    events = list(dict.fromkeys(body.events))
    hook = store.create_webhook(user["id"], body.name, body.url, secret, events)
    if not body.enabled:
        store.update_webhook(user["id"], hook["id"], {"enabled": False})
        hook["enabled"] = False
    return {**hook, "secret": secret}


@router.patch("/me/webhooks/{hook_id}", response_model=Webhook)
def patch_webhook(
    hook_id: int, body: WebhookPatch, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)
) -> dict:
    _own(store, user["id"], hook_id)
    changes = body.model_dump(exclude_none=True)
    if "url" in changes:
        _check_target(request, changes["url"])
    if "events" in changes:
        changes["events"] = list(dict.fromkeys(changes["events"]))
    store.update_webhook(user["id"], hook_id, changes)
    return _own(store, user["id"], hook_id)


@router.delete("/me/webhooks/{hook_id}", status_code=204)
def delete_webhook(hook_id: int, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> None:
    if not store.delete_webhook(user["id"], hook_id):
        raise HTTPException(404, "unknown webhook")


@router.post("/me/webhooks/{hook_id}/test", status_code=202)
def test_webhook(
    hook_id: int, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)
) -> dict:
    """Send a `ping` to this hook (whatever events it listens to). The result shows up in the deliveries."""
    hook = _own(store, user["id"], hook_id)
    request.app.state.webhooks.publish(
        user["id"], user["username"], PING, {"hook": hook["name"], "message": "Test delivery from Mahlwerk"}, hook_id=hook_id
    )
    return {"queued": True}


@router.get("/me/webhooks/{hook_id}/deliveries", response_model=list[Delivery])
def deliveries(hook_id: int, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> list[dict]:
    """The last 20 deliveries of this hook, newest first."""
    _own(store, user["id"], hook_id)
    return store.list_deliveries(hook_id)

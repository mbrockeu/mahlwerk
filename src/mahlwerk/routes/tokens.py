"""Personal access tokens: create, list and revoke your own. Managing them needs the normal sign-in, never a token."""

import time

from fastapi import APIRouter, Depends, HTTPException, Request

from ..admin_models import Token, TokenCreated, TokenIn
from ..auth import hash_token, new_token, session_user
from ..db import Store
from ..deps import get_store

MAX_ACTIVE = 50


def need_tokens(request: Request) -> None:
    if not request.app.state.features.tokens:
        raise HTTPException(404, "access tokens are switched off")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(session_user), Depends(need_tokens)])


@router.get("/me/tokens", response_model=list[Token])
def list_tokens(user: dict = Depends(session_user), store: Store = Depends(get_store)) -> list[dict]:
    """The tokens of this user, newest first, with their state; never the secret."""
    return store.list_tokens(user["id"])


@router.post("/me/tokens", response_model=TokenCreated, status_code=201)
def create_token(body: TokenIn, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> dict:
    """Create a token. The clear text is in this response and nowhere else; only its SHA-256 is stored."""
    now = int(time.time())
    active = [t for t in store.list_tokens(user["id"]) if t["revoked_at"] is None and (t["expires_at"] or now + 1) > now]
    if len(active) >= MAX_ACTIVE:
        raise HTTPException(409, f"at most {MAX_ACTIVE} active tokens")
    token = new_token()
    expires = now + body.expires_in_days * 86400 if body.expires_in_days else None
    row = store.create_token(user["id"], body.name, token[:8], hash_token(token), body.scope, expires)
    return {**row, "token": token}


@router.delete("/me/tokens/{token_id}", status_code=204)
def revoke_token(token_id: int, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> None:
    """Revoke a token at once. The entry stays in the list as revoked."""
    if not store.revoke_token(user["id"], token_id):
        raise HTTPException(404, "unknown token")

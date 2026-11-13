"""Intervall fasting: at most one open fast per user, finished ones as history. Times are unix seconds (UTC)."""

import time

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..models import Fast, Fasting, FastPatch, FastStart, FastStop
from ..webhooks import emit

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

MAX_BACKDATE = 48 * 3600
SKEW = 60  # tolerated clock difference between browser and server, in seconds
RECENT = 14


def fast_out(row: dict, now: int | None = None) -> Fast:
    now = int(time.time()) if now is None else now
    end = row["ended_at"] if row["ended_at"] is not None else now
    elapsed = max(0, end - row["started_at"])
    return Fast(
        id=row["id"], started_at=row["started_at"], ended_at=row["ended_at"], target_hours=row["target_hours"],
        elapsed_seconds=elapsed, duration_seconds=elapsed if row["ended_at"] is not None else None,
        target_reached=elapsed >= row["target_hours"] * 3600,
    )


def _fast_event(fast: Fast) -> dict:
    return fast.model_dump()


def _own(store: Store, uid: int, fast_id: int) -> dict:
    row = store.get_fast(uid, fast_id)
    if row is None:
        raise HTTPException(404, "unknown fast")
    return row


@router.get("/fasting", response_model=Fasting)
def get_fasting(user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Fasting:
    uid = user["id"]
    now = int(time.time())
    current = store.current_fast(uid)
    recent = [fast_out(r, now) for r in store.recent_fasts(uid, RECENT)]
    return Fasting(current=fast_out(current, now) if current else None, last=recent[0] if recent else None, recent=recent)


@router.post("/fasting/start", response_model=Fast, status_code=201)
def start_fasting(
    request: Request, body: FastStart | None = None, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Fast:
    body = body or FastStart()
    uid = user["id"]
    now = int(time.time())
    started = now if body.started_at is None else body.started_at
    if started > now + SKEW:
        raise HTTPException(422, "started_at must not be in the future")
    if started < now - MAX_BACKDATE:
        raise HTTPException(422, "started_at must not be more than 48 hours back")
    if store.current_fast(uid):
        raise HTTPException(409, "a fast is already running")
    target = body.target_hours
    if target is None:
        target = store.get_settings(uid).get("fasting", {}).get("target_hours", 16)
    fast_id = store.start_fast(uid, min(started, now), target)
    if fast_id is None:
        raise HTTPException(409, "a fast is already running")
    fast = fast_out(store.get_fast(uid, fast_id), now)
    emit(request, user, "fasting.started", _fast_event(fast))
    return fast


@router.post("/fasting/stop", response_model=Fast)
def stop_fasting(
    request: Request, body: FastStop | None = None, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Fast:
    body = body or FastStop()
    uid = user["id"]
    now = int(time.time())
    current = store.current_fast(uid)
    if current is None:
        raise HTTPException(409, "no fast is running")
    ended = now if body.ended_at is None else body.ended_at
    if ended > now + SKEW:
        raise HTTPException(422, "ended_at must not be in the future")
    if ended < current["started_at"]:
        raise HTTPException(422, "ended_at must not be before the start")
    store.update_fast(uid, current["id"], {"ended_at": min(ended, now)})
    fast = fast_out(store.get_fast(uid, current["id"]), now)
    emit(request, user, "fasting.ended", _fast_event(fast))
    return fast


@router.patch("/fasting/{fast_id}", response_model=Fast)
def patch_fast(
    fast_id: int, body: FastPatch, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Fast:
    """Correct a fast. Giving `ended_at` to the open fast finishes it."""
    uid = user["id"]
    row = _own(store, uid, fast_id)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(422, "nothing to change")
    now = int(time.time())
    merged = {**row, **changes}
    if merged["started_at"] > now + SKEW:
        raise HTTPException(422, "started_at must not be in the future")
    if merged["ended_at"] is not None:
        if merged["ended_at"] > now + SKEW:
            raise HTTPException(422, "ended_at must not be in the future")
        if merged["ended_at"] < merged["started_at"]:
            raise HTTPException(422, "ended_at must not be before the start")
    if not store.update_fast(uid, fast_id, changes):
        raise HTTPException(409, "a fast is already running")
    fast = fast_out(store.get_fast(uid, fast_id), now)
    if row["ended_at"] is None and fast.ended_at is not None:  # the open fast was finished by this correction
        emit(request, user, "fasting.ended", _fast_event(fast))
    return fast


@router.delete("/fasting/{fast_id}", status_code=204)
def delete_fast(fast_id: int, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> None:
    if not store.delete_fast(user["id"], fast_id):
        raise HTTPException(404, "unknown fast")

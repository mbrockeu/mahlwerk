"""Yazio import in the app: upload the files of the exporter (or a ZIP), look at the preview, confirm; or, when an admin
switched it on, sign in at Yazio once and let the server fetch the diary. Both ways end in the same staging area and the
same preview/confirm steps, and in the same import core as the command line (`python -m mahlwerk.yazio`).

Only for the signed-in person themself (an access token is refused) and only into their own account. The result is an
import batch like any other: it can be taken back under "Imported data" in the profile.
"""

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import yazio, yazio_live, yazio_stage
from ..auth import session_user
from ..db import Store
from ..deps import get_store

router = APIRouter(prefix="/api/v1/me/yazio", dependencies=[Depends(session_user)])


class StageView(BaseModel):
    token: str
    source: str = Field(description="upload or login")
    files: dict[str, int] = Field(description="file name -> bytes after unpacking")


class RunView(BaseModel):
    state: str = Field(description="running, done, error or cancelled")
    phase: str
    done: int
    total: int
    requests: int
    error: str | None = None
    error_kind: str | None = None


class LoginInfo(BaseModel):
    enabled: bool = Field(description="an admin switched the direct sign-in on")
    available: bool = Field(description="switched on and the app identifiers are configured")
    run: RunView | None
    max_months: int = yazio_live.MAX_MONTHS
    default_months: int = yazio_live.DEFAULT_MONTHS


class YazioState(BaseModel):
    stage: StageView | None
    login: LoginInfo
    max_file_bytes: int = yazio_stage.MAX_FILE


class Preview(BaseModel):
    token: str
    days: int
    entries: dict[str, int]
    entries_total: int
    foods_created: int
    foods_reused: int
    weights: int
    weights_kept: int
    water: int
    water_kept: int
    activity_days: int
    activity_kept: int
    workouts: int
    workouts_already: int
    goal_set: bool
    already_imported: int
    skipped: list[dict]
    notes: list[dict]
    unknown_keys: int
    dropped_values: int
    missing_files: list[str]
    batch_id: int | None
    dry_run: bool


class ConfirmIn(BaseModel):
    token: str = Field(max_length=64, description="the token of the preview")
    all_products: bool = False


class PreviewIn(BaseModel):
    all_products: bool = False


class LoginIn(BaseModel):
    """No limits declared on purpose: a validation error must never echo the password; the handler checks."""

    email: str = ""
    password: str = ""
    months: int = yazio_live.DEFAULT_MONTHS

    def __repr__(self) -> str:
        return "LoginIn(...)"


def _preview(summary: yazio.Summary, token: str) -> Preview:
    return Preview(
        token=token, days=summary.days, entries={k: summary.entries[k] for k in ("product", "recipe", "quick")},
        entries_total=summary.total_entries, foods_created=summary.foods_created, foods_reused=summary.foods_reused,
        weights=summary.weights, weights_kept=summary.weights_kept, water=summary.water, water_kept=summary.water_kept,
        activity_days=summary.activity_days, activity_kept=summary.activity_kept, workouts=summary.workouts,
        workouts_already=summary.workouts_already, goal_set=summary.goal_set, already_imported=summary.already_imported,
        skipped=[{"reason": r, "count": n} for r, n in sorted(summary.skipped.items())],
        notes=[{"text": t, "count": n} for t, n in sorted(summary.notes.items())],
        unknown_keys=len(summary.unknown_keys), dropped_values=summary.dropped_values, missing_files=summary.missing_files,
        batch_id=summary.batch_id, dry_run=summary.dry_run)


def _stage_http(exc: yazio_stage.StageError) -> HTTPException:
    status = {"too_large": 413, "busy": 503}.get(exc.code, 422)
    return HTTPException(status, exc.text)


def _login_info(request: Request, user_id: int) -> LoginInfo:
    run = request.app.state.yazio_runs.get(user_id)
    enabled = request.app.state.features.yazio_login
    return LoginInfo(enabled=enabled, available=enabled and yazio_live.app_identity() is not None,
                     run=RunView(**run.view()) if run else None)


@router.get("", response_model=YazioState)
def state(request: Request, user: dict = Depends(session_user)) -> YazioState:
    stage = request.app.state.yazio_stage.get(user["id"])
    return YazioState(stage=StageView(**stage.view()) if stage else None, login=_login_info(request, user["id"]))


def _busy(text: str, seconds: int = 3) -> HTTPException:
    return HTTPException(429, text, headers={"Retry-After": str(seconds)})


@router.put("/files/{name}", response_model=StageView)
async def upload(name: str, request: Request, user: dict = Depends(session_user)) -> StageView:
    """One file of the export (days.json, products.json, weight.json; plain or gzip-packed) or `export.zip`. The body is
    the file itself (at most 24 MB as sent). Files of one series are collected; a ZIP replaces what was there. Nothing is
    imported yet. The name is checked before the body is read, and only one heavy job (this, a preview, an import) runs on
    the server at a time: another request is answered with 429 at once."""
    if name not in yazio_stage.UPLOAD_NAMES:
        raise HTTPException(422, "unexpected file name (days.json, products.json, weight.json or a ZIP)")
    if request.headers.get("content-type", "").lower().startswith("multipart/"):
        raise HTTPException(415, "send the file itself as the request body, not as a form")
    staging = request.app.state.yazio_stage
    if not staging.begin(user["id"]):
        raise HTTPException(409, "an upload, preview or import of yours is still running")
    if not staging.try_heavy():
        staging.end(user["id"])
        raise _busy("the server is busy with another upload or import, try again in a few seconds")
    try:
        try:
            body = await asyncio.wait_for(request.body(), timeout=60)
        except TimeoutError:
            raise HTTPException(408, "the upload took too long") from None
        try:
            files = await run_in_threadpool(yazio_stage.decode_upload, name, body)
        except yazio_stage.StageError as exc:
            raise _stage_http(exc) from exc
        del body
        try:
            stage = staging.add(user["id"], files, "upload", replace=name == "export.zip")
        except yazio_stage.StageError as exc:
            raise _stage_http(exc) from exc
    finally:
        staging.release_heavy()
        staging.end(user["id"])
    return StageView(**stage.view())


@router.delete("", status_code=204)
def discard(request: Request, user: dict = Depends(session_user)) -> None:
    """Throw away what is waiting here and cancel a running sign-in fetch."""
    request.app.state.yazio_runs.cancel(user["id"])
    request.app.state.yazio_stage.clear(user["id"])


def _loaded(files: dict[str, bytes]) -> dict[str, dict | None]:
    return {name: json.loads(files[name]) if name in files else None for name in yazio.FILES}


async def _import(request: Request, user: dict, store: Store, all_products: bool, dry_run: bool, token: str | None) -> tuple[yazio.Summary, str]:
    staging = request.app.state.yazio_stage
    stage = staging.get(user["id"])
    if stage is None:
        raise HTTPException(410, "nothing is waiting to be imported (it may have expired): upload the files again")
    if token is not None and token != stage.token:
        raise HTTPException(409, "the files changed since the preview: look at the preview again")
    if stage.source == "login" and not request.app.state.features.yazio_login:
        staging.clear(user["id"])  # what a sign-in fetched is not kept once an admin switched the connector off
        raise HTTPException(404, "the direct Yazio sign-in is switched off (admin area)")
    if not staging.begin(user["id"]):
        raise HTTPException(409, "an upload, preview or import of yours is still running")
    if not staging.try_heavy():
        staging.end(user["id"])
        raise _busy("the server is busy with another upload or import, try again in a few seconds")
    try:
        def work() -> yazio.Summary:
            return yazio.run_import_from(store, user["id"], _loaded(stage.files), all_products, dry_run, "the uploaded files")
        try:
            summary = await run_in_threadpool(work)
        except yazio.YazioError as exc:
            raise HTTPException(422, str(exc)) from exc
        except (ValueError, RecursionError):
            raise HTTPException(422, "the files cannot be read") from None
    finally:
        staging.release_heavy()
        staging.end(user["id"])
    return summary, stage.token


@router.post("/preview", response_model=Preview)
async def preview(request: Request, body: PreviewIn | None = None, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> Preview:
    """What an import would do (counted exactly, nothing written): days, entries, foods, weights, activity, what exists already, what is skipped."""
    summary, token = await _import(request, user, store, (body or PreviewIn()).all_products, True, None)
    return _preview(summary, token)


@router.post("/confirm", response_model=Preview)
async def confirm(body: ConfirmIn, request: Request, user: dict = Depends(session_user), store: Store = Depends(get_store)) -> Preview:
    """Import what the preview showed (`token`), as one batch that can be taken back. The staging area is emptied."""
    summary, token = await _import(request, user, store, body.all_products, False, body.token)
    request.app.state.yazio_stage.clear(user["id"], token)  # only what was imported, not a newer upload
    return _preview(summary, token)


@router.post("/login", response_model=RunView, status_code=202)
def login(body: LoginIn, request: Request, user: dict = Depends(session_user)) -> RunView:
    """Direct one-time sign-in at Yazio (admin switch, off by default; unofficial interface). The server signs in ONCE,
    fetches the chosen period in the background and forgets e-mail address, password and token; what it fetched goes into
    the staging area for preview and confirmation. Poll GET /me/yazio for the progress."""
    if not request.app.state.features.yazio_login:
        raise HTTPException(404, "the direct Yazio sign-in is switched off (admin area)")
    if yazio_live.app_identity() is None:
        raise HTTPException(409, "the direct Yazio sign-in is not set up (MAHLWERK_YAZIO_CLIENT_ID and MAHLWERK_YAZIO_CLIENT_SECRET)")
    email, password = body.email.strip(), body.password
    if not email or not password or len(email) > 200 or len(password) > 500 or "\n" in email:
        raise HTTPException(422, "e-mail address and password are required")
    if isinstance(body.months, bool) or not 1 <= body.months <= yazio_live.MAX_MONTHS:
        raise HTTPException(422, f"the period is 1 to {yazio_live.MAX_MONTHS} months")
    try:
        run = request.app.state.yazio_runs.start(user["id"], yazio_live.Credentials(email, password), body.months)
    except yazio_live.Refused as exc:
        text = {"running": "a fetch of yours is already running", "busy": "the server is busy with other fetches, try again in a few minutes",
                "gap": f"wait {exc.wait} seconds before the next sign-in attempt",
                "hourly": "too many sign-in attempts this hour (at most 3), try again later",
                "global": "too many sign-in attempts on this server this hour, try again later"}[exc.kind]
        raise HTTPException(409 if exc.kind == "running" else 429, text) from exc
    # what waits is replaced when the run delivers (see main.deliver); clearing here would race with a fast run
    return RunView(**run.view())

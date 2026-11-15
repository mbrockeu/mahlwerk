"""Personal data export: the signed-in user downloads everything of their own (there is no export of other people's data)."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

from .. import export
from ..auth import current_user
from ..db import Store
from ..deps import get_store
from .diary import parse_day, today

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


def _language(request: Request, lang: str | None) -> str:
    """The language is kept on the device, not in the account: the interface sends it as `lang`, else the browser's counts."""
    if lang:
        return lang
    first = request.headers.get("accept-language", "").split(",")[0].strip().lower()
    return "de" if first.startswith("de") else "en"


@router.get("/me/export", response_class=Response, responses={200: {"content": {"application/zip": {}}}})
def export_me(
    request: Request,
    first: str | None = Query(None, alias="from", description="first day, YYYY-MM-DD (inclusive)"),
    to: str | None = Query(None, description="last day, YYYY-MM-DD (inclusive)"),
    lang: Literal["de", "en"] | None = Query(None, description="CSV format: de = `;` and decimal comma, en = `,` and decimal point"),
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
) -> Response:
    """A ZIP with `diary.csv`, `weight.csv`, `activity.csv`, `workouts.csv`, `water.csv`, `fasting.csv` and the complete
    `mahlwerk-export.json` of the caller's own data. `from`/`to` limit the day-based data."""
    start = parse_day(first).isoformat() if first else None
    end = parse_day(to).isoformat() if to else None
    if start and end and start > end:
        raise HTTPException(422, "from must not be after to")
    body = export.build_zip(store, user, start, end, _language(request, lang))
    name = export.file_name(user["username"], today().isoformat())
    return Response(body, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})

"""Photo recognition: what a photo of a meal or of a recipe shows, asked of the image model the operator configured (vision.py).

Only for people signed in the normal way (an access token is refused) and never for the demo account. Switched off: 404;
not configured: 409 (like Cookidoo). The photo is shrunk and made a clean JPEG first (imageproc.for_model: no EXIF, no GPS
position), sent to the model, and forgotten: nothing is stored, neither the photo nor the answer, and no log line holds
anything of either. The result is a SUGGESTION made of checked fields (see vision.py): amounts and nutrition values are
estimates the person reviews before anything is booked.

Brakes: a number of photos per person and hour (MAHLWERK_VISION_PER_HOUR, default 30) and `MAHLWERK_VISION_PARALLEL` runs (default two) at the same time on the
whole server; beyond them 429 with `Retry-After`.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .. import imageproc, imagesize, vision
from ..auth import session_user

log = logging.getLogger("mahlwerk.vision")

router = APIRouter(prefix="/api/v1/vision", dependencies=[Depends(session_user)])

MAX_IMAGE_BYTES = 8 * 1024 * 1024
BUSY_WAIT = 10
STATUS = {"too_large": 413, "too_many_pixels": 413, "busy": 429, "unavailable": 501, "format": 422, "broken": 422}
FAILURE = {"timeout": 504, "unavailable": 502, "unusable": 502, "busy": 429}


class VisionState(BaseModel):
    enabled: bool = Field(description="the admin switched the connector on")
    configured: bool = Field(description="the operator set MAHLWERK_VISION_URL and MAHLWERK_VISION_MODEL")
    ready: bool = Field(description="enabled and configured: the two routes work")
    per_hour: int = Field(description="photos per person and hour")


class MealItem(BaseModel):
    name: str = Field(description="at most 120 characters")
    grams: float | None = Field(None, description="estimated amount, 0 to 5000")
    kcal: float | None = Field(None, description="for that amount (an estimate)")
    protein_g: float | None = None
    fat_g: float | None = None
    carbs_g: float | None = None
    confidence: float | None = Field(None, description="0 to 1, how sure the model says it is")


class MealResult(BaseModel):
    items: list[MealItem] = Field(description="at most 30; empty when no food was recognised")
    note: str | None = Field(None, description="a short remark of the model (at most 300 characters)")


class PortionNutrition(BaseModel):
    kcal: float | None = None
    protein_g: float | None = None
    fat_g: float | None = None
    carbs_g: float | None = None


class RecipeResult(BaseModel):
    name: str | None = Field(None, description="at most 120 characters")
    portions: float | None = Field(None, description="0.25 to 100")
    ingredients: list[str] = Field(description="at most 80 lines of at most 300 characters, e.g. `200 g flour`")
    nutrition_per_portion: PortionNutrition | None = Field(None, description="only when the page shows a nutrition table")
    note: str | None = Field(None, description="a short remark of the model (at most 300 characters)")


@router.get("/status", response_model=VisionState)
def status(request: Request) -> VisionState:
    enabled = request.app.state.features.vision
    configured = vision.settings_from_env() is not None
    return VisionState(enabled=enabled, configured=configured, ready=enabled and configured, per_hour=vision.per_hour_from_env())


async def _run(request: Request, user: dict, kind: str, lang: str) -> dict:
    if not request.app.state.features.vision:
        raise HTTPException(404, "photo recognition is switched off (admin area)")
    settings = vision.settings_from_env()
    if settings is None:
        raise HTTPException(409, "photo recognition is not configured (MAHLWERK_VISION_URL and MAHLWERK_VISION_MODEL)")
    image = await request.body()  # the body limit (8 MB) is enforced before this, while the bytes arrive
    if not image:
        raise HTTPException(422, "empty body")
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "image too large")
    size = imagesize.dimensions(image)  # from the header: a small file can claim a huge picture
    if size is None:
        raise HTTPException(422, "the image must be a JPEG, PNG or WebP file")
    if size[0] * size[1] > imagesize.MAX_PIXELS:
        raise HTTPException(413, f"image has too many pixels (at most {imagesize.MAX_PIXELS // 1_000_000} megapixels)")
    hub: vision.Vision = request.app.state.vision
    if not hub.brake.slot():
        raise HTTPException(429, "photo recognition is busy, try again in a moment", headers={"Retry-After": str(BUSY_WAIT)})
    try:
        wait = hub.brake.allow(user["id"], vision.per_hour_from_env())
        if wait:
            raise HTTPException(429, "too many photos lately, try again later", headers={"Retry-After": str(wait)})
        try:
            jpeg = await run_in_threadpool(imageproc.for_model, image)
            return await run_in_threadpool(hub.client.describe, settings, kind, lang, jpeg)
        except imageproc.ImageRejected as exc:
            raise HTTPException(STATUS.get(exc.kind, 422), str(exc), headers={"Retry-After": "5"} if exc.kind == "busy" else None) from None
        except vision.VisionError as exc:
            if exc.kind == "busy":  # the model is busy: the person did nothing wrong, the photo does not count
                hub.brake.refund(user["id"])
                raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after or BUSY_WAIT)}) from None
            raise HTTPException(FAILURE[exc.kind], str(exc)) from None
    finally:
        hub.brake.release()


@router.post("/meal", response_model=MealResult)
async def meal(request: Request, user: dict = Depends(session_user), lang: Literal["de", "en"] = Query("en", description="language of the names")) -> dict:
    """Recognise the parts of a meal in a photo. Send the image as the request body (JPEG, PNG or WebP)."""
    return await _run(request, user, "meal", lang)


@router.post("/recipe", response_model=RecipeResult)
async def recipe(request: Request, user: dict = Depends(session_user), lang: Literal["de", "en"] = Query("en", description="language of the names")) -> dict:
    """Read name, portions and ingredient lines of a recipe in a photo (the method is not taken over). Send the image as the request body."""
    return await _run(request, user, "recipe", lang)

"""Pictures of recipes: the stored files (for signed-in people and read tokens) and an own photo for a recipe.

The browser never loads a picture from anywhere else: the content security policy allows images only from this server, and
every picture on a page is one of these routes. The hash in the address is the content hash, so the answer never changes for an
address: it is cached for a year (`immutable`) in the browser of the person (`private`, never by a shared cache). That is the one
deliberate exception to `Cache-Control: no-store` that the rest of the API carries (security.py only sets it when a route did not).
A removed picture is gone at once: an address whose hash no food refers to any more answers 404, also while its file is still on
disk waiting to be tidied.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from .. import imagestore
from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..imageproc import ImageRejected
from ..models import Food
from .foods import build_food

log = logging.getLogger("mahlwerk.images")

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

CACHE = "private, max-age=31536000, immutable"
PICTURE_SOURCES = ("recipe", "cookidoo", "web")  # the foods that can have a picture
STATUS = {"too_large": 413, "too_many_pixels": 413, "busy": 503, "unavailable": 501, "format": 422, "broken": 422}


@router.get("/images/{digest}/{size}", responses={200: {"content": {"image/webp": {}}}, 304: {}})
def get_image(digest: str, size: str, request: Request, store: Store = Depends(get_store)) -> Response:
    """One size (`l` 960 px, `m` 240 px square, `s` 96 px square) of a recipe picture, as WebP. 404 for an unknown size, a hash
    that is not 32 hex digits, a picture no recipe uses, and a file that is missing (a recipe without picture, not an error)."""
    images = request.app.state.images
    path = images.files.path(digest, size)
    if path is None or store.image_refs(digest) == 0:
        raise HTTPException(404, "unknown picture")
    etag = f'"{digest}-{size}"'
    headers = {"Cache-Control": CACHE, "ETag": etag, "X-Content-Type-Options": "nosniff"}
    if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
        return Response(status_code=304, headers=headers)
    try:
        body = path.read_bytes()
    except OSError:
        raise HTTPException(404, "unknown picture") from None
    return Response(content=body, media_type="image/webp", headers=headers)


def _recipe_food(store: Store, food_id: int) -> dict:
    row = store.get_food(food_id)
    if row is None or not row["found"]:
        raise HTTPException(404, "unknown food")
    if row["source"] not in PICTURE_SOURCES:
        raise HTTPException(409, "only recipes (own, from Cookidoo or from a web page) can have a picture")
    return row


@router.put("/foods/{food_id}/image", response_model=Food)
async def set_own_photo(food_id: int, request: Request, store: Store = Depends(get_store), user: dict = Depends(current_user)) -> Food:
    """Set an own photo for a recipe: the picture file as the request body (JPEG, PNG or WebP, at most 8 MB; the interface shrinks
    it first). It replaces any picture the recipe had and is never replaced by a reload from the provider. Always possible, whatever
    the picture switches of the connectors say."""
    _recipe_food(store, food_id)
    data = await request.body()  # the body limit is enforced while the bytes arrive (security.py)
    if not data:
        raise HTTPException(422, "empty body")
    wait = request.app.state.upload_brake.allow(user["id"])  # at most 20 photos per person in 10 minutes
    if wait:
        raise HTTPException(429, "too many photos lately, try again in a few minutes", headers={"Retry-After": str(wait)})
    try:
        await run_in_threadpool(request.app.state.images.attach, food_id, data, "own", None)
    except ImageRejected as exc:
        raise HTTPException(STATUS.get(exc.kind, 422), str(exc), headers={"Retry-After": "5"} if exc.kind == "busy" else None) from None
    except imagestore.StoreError as exc:
        raise HTTPException(507, str(exc)) from None
    except OSError:
        raise HTTPException(507, "the picture could not be written (disk full or no permission)") from None
    except LookupError:
        raise HTTPException(404, "unknown food") from None
    return build_food(store.get_food(food_id))


@router.delete("/foods/{food_id}/image", response_model=Food)
def remove_picture(food_id: int, request: Request, store: Store = Depends(get_store)) -> Food:
    """Take the picture of a recipe away. For a picture taken over from a provider this is remembered, so a reload does not bring it back."""
    _recipe_food(store, food_id)
    request.app.state.images.remove(food_id, mark=True)
    return build_food(store.get_food(food_id))



@router.post("/foods/{food_id}/image/restore", response_model=Food)
def restore_picture(food_id: int, request: Request, store: Store = Depends(get_store)) -> Food:
    """Lift the "taken away" marker of a provider's picture, so that the next reload of the recipe fetches it again (the caller reloads: the
    interface does it at once). Only while the picture switch of the recipe's connector is on; **409** otherwise or when nothing was taken away."""
    row = _recipe_food(store, food_id)
    features = request.app.state.features
    if not ((row["source"] == "cookidoo" and features.cookidoo_images) or (row["source"] == "web" and features.web_images)):
        raise HTTPException(409, "storing recipe pictures is switched off for this recipe's source (admin area)")
    if not request.app.state.images.restore(food_id):
        raise HTTPException(409, "the picture of this recipe was not taken away")
    return build_food(store.get_food(food_id))

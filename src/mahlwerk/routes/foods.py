"""Food lookup (local first, then Open Food Facts), own foods, search and label reading."""

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from .. import cookidoo, imagesize, imagestore, label, nutrients, off, webrecipes
from ..auth import current_user
from ..catalog import OFF, food_data
from ..db import Store
from ..deps import get_store
from ..models import Food, FoodImage, FoodIn, LabelScan, RecentFood
from ..nutrition import guess_unit, is_complete, parse_serving, valid_gtin

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

MAX_IMAGE_BYTES = 8 * 1024 * 1024
OCR_SLOT = threading.Semaphore(1)


@dataclass
class OffClient:
    http: httpx.Client
    base: str
    cache_seconds: int


def food_image(row: dict) -> FoodImage | None:
    digest, origin = row.get("image_hash"), row.get("image_origin")
    if not digest or origin not in ("own", "cookidoo", "web") or not imagestore.valid_hash(digest):
        return None
    credit = None
    if origin == "cookidoo":
        credit = "Cookidoo"
    elif origin == "web":
        credit = webrecipes.host_label(webrecipes.safe_link((row.get("data") or {}).get("url")) or "") or None
    return FoodImage(hash=digest, origin=origin, credit=credit)


def build_food(row: dict, **extra) -> Food:
    data = row["data"]
    own = row["source"] == "own"
    unit = data.get("unit") or guess_unit(None, data.get("quantity"), data.get("serving_size"))
    serving = data.get("serving_quantity")
    if serving is None and own and (parsed := parse_serving(data.get("serving_size"))) and parsed[1] == unit:
        serving = parsed[0]
    empty = data.get("name") is None and all(v is None for v in data["per_100"].values())
    return Food(
        id=row["id"],
        code=row["code"],
        source=row["source"],
        recipe_id=row.get("recipe_id"),
        external_id=row.get("external_id"),
        portions=data.get("portions"),
        url=(cookidoo.recipe_url(row.get("external_id"), region=data.get("region")) if row["source"] == cookidoo.SOURCE
             else webrecipes.safe_link(data.get("url")) if row["source"] == webrecipes.SOURCE else None),
        name=data.get("name"),
        brand=data.get("brand"),
        quantity=data.get("quantity"),
        serving_size=data.get("serving_size"),
        serving_quantity=serving,
        unit=unit,
        per_100=data["per_100"],
        extra=nutrients.clean(data.get("extra")),
        complete=is_complete(data["per_100"]),
        empty=empty,
        image=food_image(row),
        image_removed=row.get("image_origin") == "none",
        **{"cached": True, "fetched_at": row["fetched_at"], **extra},
    )


def own_data(food: FoodIn) -> dict:
    parsed = parse_serving(food.serving_size)
    unit = food.unit
    if "unit" not in food.model_fields_set and parsed:
        unit = parsed[1]
    serving = food.serving_quantity
    if serving is None and parsed and parsed[1] == unit:
        serving = parsed[0]
    per_100 = food.per_100.model_dump()
    return {
        "name": food.name.strip(),
        "brand": food.brand,
        "quantity": food.quantity,
        "serving_size": food.serving_size,
        "serving_quantity": serving,
        "unit": unit,
        "per_100": per_100,
        "extra": food.extra,
        "complete": is_complete(per_100),
    }


def _need_barcode(code: str) -> None:
    if not valid_gtin(code):
        raise HTTPException(422, "not a valid EAN/UPC barcode")


@router.get("/foods/barcode/{code}", response_model=Food)
def food_by_barcode(code: str, request: Request, store: Store = Depends(get_store)) -> Food:
    _need_barcode(code)
    upstream: OffClient = request.app.state.off
    cached = store.get_food_by_code(code)
    if cached is not None and cached["source"] == "own":
        # the user's own entry is never replaced by upstream data
        return build_food(cached)
    # unknown barcodes are re-checked after a day: someone may have added the product upstream
    ttl = upstream.cache_seconds if cached and cached["found"] else min(upstream.cache_seconds, 86400)
    fresh = cached is not None and time.time() - cached["fetched_at"] < ttl
    if fresh and cached["found"]:
        return build_food(cached)
    # the local catalogue comes before the live lookup: faster, and works while Open Food Facts is down
    if (item := request.app.state.catalog.get(OFF, code)) is not None:
        data = food_data(item)
        food_id, fetched_at = store.put_food(code, OFF, data)
        return build_food({"id": food_id, "code": code, "source": OFF, "data": data, "fetched_at": fetched_at}, cached=False)
    if fresh:
        raise HTTPException(404, "unknown barcode")
    if not request.app.state.features.lookup:
        # the live lookup is switched off (admin area): only what is stored or in the local catalogue is known
        if cached is not None and cached["found"]:
            return build_food(cached, stale=True)
        raise HTTPException(404, "unknown barcode")
    try:
        data = off.fetch(upstream.http, upstream.base, code)
    except off.UpstreamError as exc:
        if cached is not None and cached["found"]:
            return build_food(cached, stale=True)
        raise HTTPException(502, f"Open Food Facts unavailable: {exc}") from exc
    food_id, fetched_at = store.put_food(code, "openfoodfacts", data)
    if data is None:
        raise HTTPException(404, "unknown barcode")
    return build_food(
        {"id": food_id, "code": code, "source": "openfoodfacts", "data": data, "fetched_at": fetched_at}, cached=False
    )


@router.put("/foods/barcode/{code}", response_model=Food)
def save_barcode_food(code: str, food: FoodIn, store: Store = Depends(get_store)) -> Food:
    _need_barcode(code)
    existing = store.get_food_by_code(code)
    if existing is not None:
        _not_a_recipe(existing)
    data = own_data(food)
    food_id, fetched_at = store.put_food(code, "own", data)
    return build_food({"id": food_id, "code": code, "source": "own", "data": data, "fetched_at": fetched_at})


@router.get("/foods", response_model=list[Food])
def search_foods(
    q: str = "",
    source: Literal["own", "openfoodfacts", "recipe", "yazio", "bls", "cookidoo", "web"] | None = None,
    exclude_source: list[Literal["own", "openfoodfacts", "recipe", "yazio", "bls", "cookidoo", "web"]] = Query(
        [], description="leave these sources out (repeatable); the Products page uses `recipe`, `cookidoo` and `web`"),
    limit: int = Query(50, ge=1, le=1000),
    user: dict = Depends(current_user),
    store: Store = Depends(get_store),
) -> list[Food]:
    """Products stored on this server, newest first. The sample foods of the demo account show up only in the demo account."""
    return [build_food(row) for row in store.list_foods(q, source, limit, tuple(exclude_source), demo_account=bool(user.get("is_demo")))]


@router.get("/foods/recent", response_model=list[RecentFood])
def recent_foods(
    limit: int = Query(20, ge=1, le=200), user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> list[RecentFood]:
    result = []
    for item in store.recent_foods(user["id"], limit):
        row = store.get_food(item["food_id"], demo_view=bool(user.get("is_demo")))
        if row is None:
            continue
        result.append(RecentFood(food=build_food(row), last_amount=item["amount"], last_meal=item["meal"]))
    return result


@router.post("/foods", response_model=Food, status_code=201)
def create_food(food: FoodIn, store: Store = Depends(get_store)) -> Food:
    data = own_data(food)
    food_id, fetched_at = store.put_food(None, "own", data)
    return build_food({"id": food_id, "code": None, "source": "own", "data": data, "fetched_at": fetched_at})


def _not_a_recipe(row: dict) -> None:
    if row["source"] == "recipe":
        raise HTTPException(409, "this food is calculated from a recipe: change the recipe instead")


def _existing(store: Store, food_id: int, demo_view: bool = False) -> dict:
    row = store.get_food(food_id, demo_view=demo_view)
    if row is None or not row["found"]:
        raise HTTPException(404, "unknown food")
    return row


@router.get("/foods/{food_id}", response_model=Food)
def get_food(food_id: int, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Food:
    return build_food(_existing(store, food_id, demo_view=bool(user.get("is_demo"))))


@router.put("/foods/{food_id}", response_model=Food)
def replace_food(food_id: int, food: FoodIn, request: Request, store: Store = Depends(get_store)) -> Food:
    row = _existing(store, food_id)
    _not_a_recipe(row)
    data = own_data(food)
    fetched_at = store.update_food(food_id, "own", data)
    if row["source"] in ("cookidoo", "web") or row.get("image_hash"):
        # an own product is no recipe and has no picture: the picture of the recipe it was goes with its source (no picture that cannot be removed)
        request.app.state.images.remove(food_id)
        row = {**row, "image_hash": None, "image_origin": None}
    return build_food({**row, "source": "own", "data": data, "fetched_at": fetched_at})


@router.delete("/foods/{food_id}", status_code=204)
def delete_food(food_id: int, request: Request, store: Store = Depends(get_store)) -> None:
    """Past diary entries keep their copy of the values. The picture of a taken-over recipe goes with it."""
    row = _existing(store, food_id)
    _not_a_recipe(row)
    store.delete_food(food_id)
    request.app.state.images.release_food(row.get("image_hash"))


def keep_for_debugging(directory: str, image: bytes, text: str, keep: int = 20) -> None:
    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (folder / f"{stamp}.jpg").write_bytes(image)
    (folder / f"{stamp}.txt").write_text(text)
    for old in sorted(folder.glob("*.jpg"))[:-keep]:
        old.unlink()
        old.with_suffix(".txt").unlink(missing_ok=True)


@router.post("/label-scans", response_model=LabelScan)
async def label_scan(request: Request, user: dict = Depends(current_user)) -> LabelScan:
    """Read a photo of a nutrition table. Send the image as the request body (JPEG or PNG)."""
    if not label.available():
        raise HTTPException(501, "label reading is not installed (pip install mahlwerk[label])")
    image = await request.body()  # the body limit (8 MB) is enforced before this, while the bytes arrive
    if not image:
        raise HTTPException(422, "empty body")
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "image too large")
    # the size is read from the header: a small file can claim a huge picture and eat the memory when decoded
    size = imagesize.dimensions(image)
    if size is None:
        raise HTTPException(422, "the image must be a JPEG, PNG or WebP file")
    if size[0] * size[1] > imagesize.MAX_PIXELS:
        raise HTTPException(413, f"image has too many pixels (at most {imagesize.MAX_PIXELS // 1_000_000} megapixels)")
    # one reading at a time: it needs a few hundred MB and all CPU cores
    if not OCR_SLOT.acquire(blocking=False):
        raise HTTPException(503, "another label is being read, try again in a moment", headers={"Retry-After": "5"})
    try:
        result = await run_in_threadpool(label.read, image)
    except label.OcrFailed as exc:
        raise HTTPException(422, f"could not read the image: {exc}") from exc
    finally:
        OCR_SLOT.release()
    if (debug_dir := request.app.state.label_debug_dir) and not user.get("is_demo"):  # no copy of a demo photo is kept
        keep_for_debugging(debug_dir, image, result["text"])
    return LabelScan(**result)

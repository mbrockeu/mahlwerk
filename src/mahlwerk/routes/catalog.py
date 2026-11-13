"""The local catalogue (packaged products, basic foods): search by name and adopt an item as a food."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..auth import current_user
from ..catalog import BLS, Catalog, external_id, food_data
from ..db import Store
from ..deps import get_catalog, get_store
from ..models import CatalogItem, CatalogRef, Food
from .foods import build_food

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])

MIN_QUERY = 2


@router.get("/catalog", response_model=list[CatalogItem])
def search_catalog(
    q: str = "",
    source: Literal["openfoodfacts", "bls"] | None = None,
    limit: int = Query(25, ge=1, le=50),
    catalog: Catalog = Depends(get_catalog),
    store: Store = Depends(get_store),
) -> list[dict]:
    """Foods by name (basic foods also by English name) or product brand. Without `source`, up to 8 basic foods come
    first, then packaged products. Items already stored as a food are left out."""
    if len(q.strip()) < MIN_QUERY:
        return []
    return catalog.search(q, limit, source, skip=store.known_catalog)


@router.post("/catalog/adopt", response_model=Food, status_code=201)
def adopt(
    ref: CatalogRef,
    response: Response,
    catalog: Catalog = Depends(get_catalog),
    store: Store = Depends(get_store),
) -> Food:
    """Store a catalogue item as a regular food (201), or return the food that already exists (200)."""
    if ref.source == BLS:
        existing = store.get_food_by_external_id(external_id(BLS, ref.code))
        if existing is not None and existing["found"]:
            response.status_code = 200
            return build_food(existing)
    item = catalog.get(ref.source, ref.code)
    if item is None:
        raise HTTPException(404, "unknown catalogue item")
    data = food_data(item)
    if item["source"] == BLS:
        food_id, fetched_at = store.put_external_food(external_id(BLS, item["code"]), BLS, data)
        return build_food({"id": food_id, "code": None, "source": BLS, "data": data, "fetched_at": fetched_at})
    existing = store.get_food_by_code(item["code"])
    if existing is not None and existing["found"]:
        response.status_code = 200
        return build_food(existing)
    food_id, fetched_at = store.put_food(item["code"], item["source"], data)
    return build_food({"id": food_id, "code": item["code"], "source": item["source"], "data": data, "fetched_at": fetched_at})

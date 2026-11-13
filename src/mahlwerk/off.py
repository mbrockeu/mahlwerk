"""Open Food Facts client: fetch one product by barcode and normalise it."""

import httpx

from . import nutrients
from .nutrition import CORE, guess_unit

FIELDS = "code,product_name,product_name_de,generic_name,brands,quantity,serving_size,serving_quantity,nutrition_data_per,nutriments"

# our name -> OFF nutriment key (all per 100 g / 100 ml)
NUTRIENTS = {
    "kcal": "energy-kcal_100g",
    "fat": "fat_100g",
    "saturated_fat": "saturated-fat_100g",
    "carbs": "carbohydrates_100g",
    "sugars": "sugars_100g",
    "fiber": "fiber_100g",
    "protein": "proteins_100g",
    "salt": "salt_100g",
}


class UpstreamError(Exception):
    """Open Food Facts could not be reached or answered with an error."""


def _number(value) -> float | None:
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def normalise(product: dict) -> dict:
    nutriments = product.get("nutriments") or {}
    per_100 = {name: _number(nutriments.get(key)) for name, key in NUTRIENTS.items()}
    if per_100["kcal"] is None and (kj := _number(nutriments.get("energy-kj_100g"))) is not None:
        per_100["kcal"] = round(kj / 4.184, 1)
    extra = nutrients.extra_from_off(
        lambda column: nutrients.parse_number(nutriments.get(column)), fat=per_100["fat"], carbs=per_100["carbs"]
    )
    name = product.get("product_name_de") or product.get("product_name") or product.get("generic_name")
    return {
        "name": (name or "").strip() or None,
        "brand": (product.get("brands") or "").split(",")[0].strip() or None,
        "quantity": product.get("quantity") or None,
        "serving_size": product.get("serving_size") or None,
        "serving_quantity": _number(product.get("serving_quantity")),
        "unit": guess_unit(product.get("nutrition_data_per"), product.get("quantity"), product.get("serving_size")),
        "per_100": per_100,
        "extra": extra,
        "complete": all(per_100[k] is not None for k in CORE),
    }


def fetch(client: httpx.Client, base: str, code: str) -> dict | None:
    """Return the normalised product, or None when OFF does not know the barcode."""
    try:
        response = client.get(f"{base}/api/v2/product/{code}", params={"fields": FIELDS})
    except httpx.HTTPError as exc:
        raise UpstreamError(str(exc)) from exc
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise UpstreamError(f"HTTP {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise UpstreamError("invalid JSON") from exc
    if body.get("status") != 1 or not body.get("product"):
        return None
    return normalise(body["product"])

from conftest import NUTELLA, SHELL, UNKNOWN

from mahlwerk.main import create_app, valid_gtin

import httpx
from fastapi.testclient import TestClient


def test_check_digit():
    assert valid_gtin(NUTELLA)
    assert valid_gtin("20005726")
    assert not valid_gtin("3017620422004")
    assert not valid_gtin("12345")
    assert not valid_gtin("30176204220o3")


def test_lookup_normalises_and_caches(client, upstream):
    first = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert first["name"] == "Nutella"
    assert first["brand"] == "Ferrero"
    assert first["per_100"]["kcal"] == 539
    assert first["complete"] is True
    assert first["cached"] is False
    assert first["source"] == "openfoodfacts" and first["unit"] == "g"
    assert isinstance(first["id"], int) and first["code"] == NUTELLA

    second = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert second["cached"] is True and second["id"] == first["id"]
    assert upstream.calls == 1


def test_unknown_barcode_is_404_and_remembered(client, upstream):
    assert client.get(f"/api/v1/foods/barcode/{UNKNOWN}").status_code == 404
    assert client.get(f"/api/v1/foods/barcode/{UNKNOWN}").status_code == 404
    assert upstream.calls == 1


def test_entry_without_name_and_values_is_flagged_empty(client):
    body = client.get(f"/api/v1/foods/barcode/{SHELL}").json()
    assert body["empty"] is True and body["complete"] is False
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()["empty"] is False


def test_invalid_barcode_never_reaches_upstream(client, upstream):
    assert client.get("/api/v1/foods/barcode/3017620422004").status_code == 422
    assert upstream.calls == 0


def test_upstream_failure_is_502(client, upstream):
    upstream.fail = True
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").status_code == 502


def test_stale_cache_is_served_when_upstream_fails(tmp_path, upstream, monkeypatch):
    monkeypatch.setenv("MAHLWERK_CACHE_DAYS", "0")
    client = TestClient(create_app(str(tmp_path / "t.db"), transport=httpx.MockTransport(upstream)))
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").status_code == 200
    upstream.fail = True
    body = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert body["stale"] is True and body["name"] == "Nutella"


def test_unit_is_derived_for_liquids(tmp_path):
    def transport(request):
        code = request.url.path.rsplit("/", 1)[1]
        product = {
            "100ml": {"product_name": "A", "nutrition_data_per": "100ml", "nutriments": {}},
            "bottle": {"product_name": "B", "quantity": "1,5 l", "nutriments": {}},
            "solid": {"product_name": "C", "quantity": "500 g", "serving_size": "30 g", "nutriments": {}},
        }[{NUTELLA: "100ml", "4006381333931": "bottle", "4068706059940": "solid"}[code]]
        return httpx.Response(200, json={"status": 1, "product": product})

    client = TestClient(create_app(str(tmp_path / "u.db"), transport=httpx.MockTransport(transport)))
    units = [client.get(f"/api/v1/foods/barcode/{c}").json()["unit"] for c in (NUTELLA, UNKNOWN, SHELL)]
    assert units == ["ml", "ml", "g"]


def test_own_product_wins_over_upstream_and_keeps_its_id(client, upstream):
    body = {"name": "Apfelschorle", "brand": "Rio d'Oro", "serving_size": "250 ml",
            "per_100": {"kcal": 24, "fat": 0, "carbs": 5.6, "protein": 0}}
    saved = client.put(f"/api/v1/foods/barcode/{SHELL}", json=body).json()
    assert saved["source"] == "own" and saved["complete"] is True and saved["empty"] is False
    assert saved["unit"] == "ml" and saved["serving_quantity"] == 250

    again = client.get(f"/api/v1/foods/barcode/{SHELL}").json()
    assert again["name"] == "Apfelschorle" and again["id"] == saved["id"]
    assert upstream.calls == 0

    replaced = client.put(f"/api/v1/foods/barcode/{SHELL}", json={**body, "name": "Schorle"}).json()
    assert replaced["id"] == saved["id"]


def test_barcode_delete_and_scan_tests_are_gone(client):
    assert client.delete(f"/api/v1/foods/barcode/{SHELL}").status_code in (404, 405, 422)
    assert client.get("/api/v1/scan-tests").status_code == 404


def test_food_crud_without_barcode(client):
    created = client.post("/api/v1/foods", json={"name": " Bread ", "serving_size": "35 g", "per_100": {"kcal": 250}})
    assert created.status_code == 201
    body = created.json()
    assert body["code"] is None and body["name"] == "Bread"
    assert body["serving_quantity"] == 35 and body["unit"] == "g" and body["complete"] is False

    assert client.get(f"/api/v1/foods/{body['id']}").json()["name"] == "Bread"
    changed = client.put(f"/api/v1/foods/{body['id']}", json={"name": "Rye", "serving_quantity": 50, "per_100": {"kcal": 220}})
    assert changed.json()["name"] == "Rye" and changed.json()["serving_quantity"] == 50
    assert client.delete(f"/api/v1/foods/{body['id']}").status_code == 204
    assert client.get(f"/api/v1/foods/{body['id']}").status_code == 404
    assert client.delete(f"/api/v1/foods/{body['id']}").status_code == 404
    assert client.put("/api/v1/foods/999", json={"name": "x", "per_100": {}}).status_code == 404


def test_editing_an_upstream_food_turns_it_into_own(client):
    food = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    edited = client.put(f"/api/v1/foods/{food['id']}", json={"name": "Nutella", "per_100": {"kcal": 500}}).json()
    assert edited["source"] == "own" and edited["code"] == NUTELLA


def test_serving_is_parsed_for_milliliters_unless_unit_is_explicit(client):
    ml = client.post("/api/v1/foods", json={"name": "Juice", "serving_size": "250 ml", "per_100": {}}).json()
    assert (ml["unit"], ml["serving_quantity"]) == ("ml", 250)
    odd = client.post("/api/v1/foods", json={"name": "Jam", "serving_size": "1 jar", "per_100": {}}).json()
    assert odd["serving_quantity"] is None


def test_search_hides_empty_entries_and_filters(client):
    client.get(f"/api/v1/foods/barcode/{NUTELLA}")
    client.get(f"/api/v1/foods/barcode/{SHELL}")
    client.put(f"/api/v1/foods/barcode/{UNKNOWN}", json={"name": "Hafermilch", "per_100": {"kcal": 46}})
    listing = client.get("/api/v1/foods").json()
    assert [f["name"] for f in listing] == ["Hafermilch", "Nutella"]  # newest first, shell hidden
    assert [f["name"] for f in client.get("/api/v1/foods", params={"q": "ferrero nut"}).json()] == ["Nutella"]
    assert [f["name"] for f in client.get("/api/v1/foods", params={"q": UNKNOWN[:6]}).json()] == ["Hafermilch"]
    assert [f["code"] for f in client.get("/api/v1/foods", params={"source": "own"}).json()] == [UNKNOWN]
    assert len(client.get("/api/v1/foods", params={"limit": 1}).json()) == 1
    assert client.get("/api/v1/foods", params={"limit": 1001}).status_code == 422
    assert client.get("/api/v1/foods", params={"limit": 0}).status_code == 422


def test_food_validation(client):
    ok = {"name": "x", "per_100": {}}
    assert client.put(f"/api/v1/foods/barcode/{UNKNOWN}", json={"name": "", "per_100": {}}).status_code == 422
    assert client.put("/api/v1/foods/barcode/123", json=ok).status_code == 422
    assert client.post("/api/v1/foods", json={"name": "x" * 201, "per_100": {}}).status_code == 422
    assert client.post("/api/v1/foods", json={"name": "x", "per_100": {"kcal": -1}}).status_code == 422
    assert client.post("/api/v1/foods", json={"name": "x", "per_100": {"fat": 101}}).status_code == 422
    assert client.post("/api/v1/foods", json={**ok, "unit": "oz"}).status_code == 422
    assert client.post("/api/v1/foods", json={**ok, "serving_quantity": 0}).status_code == 422

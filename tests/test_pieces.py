"""The piece of a food ("slice" = 25 g): set, read, remove, and kept when the food is reloaded from Open Food Facts."""

import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import DROP_V15, NUTELLA
from mahlwerk.db import Store
from mahlwerk.main import create_app

SLICE = {"label": "Scheibe", "grams": 25}


def piece_url(food):
    return f"/api/v1/foods/{food['id']}/piece"


def test_set_read_and_remove(client, food):
    assert food["piece"] is None
    r = client.put(piece_url(food), json={"label": "  Scheibe ", "grams": 25})
    assert r.status_code == 200 and r.json()["piece"] == SLICE and r.json()["name"] == "Oats"
    assert client.get(f"/api/v1/foods/{food['id']}").json()["piece"] == SLICE
    assert next(f for f in client.get("/api/v1/foods").json() if f["id"] == food["id"])["piece"] == SLICE
    # a change replaces it
    assert client.put(piece_url(food), json={"label": "Stück", "grams": 12.5}).json()["piece"] == {"label": "Stück", "grams": 12.5}
    assert client.delete(piece_url(food)).status_code == 204
    assert client.get(f"/api/v1/foods/{food['id']}").json()["piece"] is None


def test_piece_comes_with_recent_foods(client, food):
    client.put(piece_url(food), json=SLICE)
    client.post("/api/v1/diary/2026-11-10/entries", json={"food_id": food["id"], "meal": "breakfast", "amount": 50})
    recent = client.get("/api/v1/foods/recent").json()
    assert recent[0]["food"]["piece"] == SLICE


@pytest.mark.parametrize("body", [
    {"label": "", "grams": 25}, {"label": "   ", "grams": 25}, {"label": "x" * 31, "grams": 25},
    {"label": "Scheibe", "grams": 0}, {"label": "Scheibe", "grams": -1}, {"label": "Scheibe", "grams": 5001}, {"label": "Scheibe"},
])
def test_invalid_piece_is_422(client, food, body):
    assert client.put(piece_url(food), json=body).status_code == 422
    assert client.get(f"/api/v1/foods/{food['id']}").json()["piece"] is None


def test_unknown_food_is_404(client):
    assert client.put("/api/v1/foods/9999/piece", json=SLICE).status_code == 404
    assert client.delete("/api/v1/foods/9999/piece").status_code == 404


@pytest.mark.parametrize("source", ["cookidoo", "web"])
def test_portion_foods_are_refused(client, source):
    data = {"name": "Soup", "serving_quantity": 100.0, "unit": "g", "portions": 4, "per_100": {"kcal": 100}}
    food_id = client.app.state.store.put_external_food(f"{source}:1", source, data)[0]
    assert client.put(f"/api/v1/foods/{food_id}/piece", json=SLICE).status_code == 409
    assert client.delete(f"/api/v1/foods/{food_id}/piece").status_code == 409


def test_piece_survives_a_reload_from_open_food_facts(tmp_path, upstream, monkeypatch):
    monkeypatch.setenv("MAHLWERK_CACHE_DAYS", "0")  # every lookup asks upstream again and replaces the stored data
    client = TestClient(create_app(str(tmp_path / "t.db"), transport=httpx.MockTransport(upstream)))
    first = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    client.put(piece_url(first), json={"label": "Löffel", "grams": 15})
    again = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert upstream.calls == 2 and again["cached"] is False
    assert again["id"] == first["id"] and again["piece"] == {"label": "Löffel", "grams": 15}
    assert client.get(f"/api/v1/foods/{first['id']}").json()["piece"] == {"label": "Löffel", "grams": 15}
    # the same with the store directly: put_food leaves the columns alone
    store = client.app.state.store
    store.put_food(NUTELLA, "openfoodfacts", {"name": "New", "per_100": {"kcal": 1}})
    assert store.get_food(first["id"])["piece_grams"] == 15


def test_taking_the_food_over_as_own_keeps_the_piece(tmp_path, upstream):
    client = TestClient(create_app(str(tmp_path / "t.db"), transport=httpx.MockTransport(upstream)))
    first = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    client.put(piece_url(first), json={"label": "Löffel", "grams": 15})
    own = client.put(f"/api/v1/foods/barcode/{NUTELLA}", json={"name": "Nutella", "per_100": {"kcal": 539}}).json()
    assert own["source"] == "own" and own["piece"] == {"label": "Löffel", "grams": 15}


def test_version_14_database_gets_the_piece_columns_without_losing_data(tmp_path):
    path = str(tmp_path / "v14.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V15)
    con.executescript(
        """
        INSERT INTO food (id, source, found, data, fetched_at) VALUES (7, 'own', 1, '{"name": "Toast", "per_100": {"kcal": 260}}', 1);
        PRAGMA user_version = 14;
        """
    )
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 17
    assert {"piece_label", "piece_grams"} <= {r[1] for r in con.execute("PRAGMA table_info(food)")}
    con.close()
    food = store.get_food(7)
    assert food["data"]["name"] == "Toast" and food["piece_label"] is None and food["piece_grams"] is None
    assert store.set_food_piece(7, "Scheibe", 25) is True and store.get_food(7)["piece_grams"] == 25
    assert store.set_food_piece(99, "x", 1) is False

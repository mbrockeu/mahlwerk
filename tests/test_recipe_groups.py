"""Groups of recipes: CRUD, both kinds of recipe as members, tidy-up on deletion, the migration from version 12."""

import sqlite3

import pytest

from conftest import DROP_V13
from mahlwerk.db import Store
from test_cookidoo import fake, on  # noqa: F401  (the fixtures of the Cookidoo tests)

G = "/api/v1/recipe-groups"


@pytest.fixture
def own_recipe(client, food):
    body = {"name": "Porridge", "portions": 2, "items": [{"food_id": food["id"], "amount": 100}]}
    return client.post("/api/v1/recipes", json=body).json()


def test_version_12_database_gets_the_group_tables_without_losing_data(tmp_path):
    path = str(tmp_path / "v12.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V13)
    con.executescript(
        """
        INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'me', 'Me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        INSERT INTO food (id, source, found, data, fetched_at, external_id) VALUES (7, 'cookidoo', 1,
            '{"name": "Soup", "per_100": {"kcal": 100}}', 1, 'cookidoo:r100001');
        PRAGMA user_version = 12;
        """
    )
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    names = {r[0] for r in con.execute("SELECT name FROM sqlite_master")}
    assert {"recipe_group", "recipe_group_item", "recipe_group_dismissed", "recipe_group_item_food_gone", "recipe_group_item_group_gone"} <= names
    con.close()
    assert store.get_goal(1)["kcal"] == 2000 and store.get_food_by_external_id("cookidoo:r100001")["id"] == 7
    group = store.create_group("Soups", 1)
    store.add_to_group(group["id"], [7])
    assert store.get_group(group["id"])["food_ids"] == [7]
    Store(path)  # opening it again changes nothing


def test_create_rename_order_delete(client):
    assert client.get(G).json() == []
    made = client.post(G, json={"name": "  Quick   dinners "})
    a = made.json()
    assert made.status_code == 201 and a["name"] == "Quick dinners" and a["auto"] is False and a["count"] == 0
    b = client.post(G, json={"name": "Baking"}).json()
    c = client.post(G, json={"name": "Sunday"}).json()
    assert [g["name"] for g in client.get(G).json()] == ["Quick dinners", "Baking", "Sunday"]
    assert client.post(G, json={"name": "baking"}).status_code == 409  # not case sensitive
    assert client.post(G, json={"name": "   "}).status_code == 422
    assert client.post(G, json={"name": "x" * 61}).status_code == 422
    assert client.post(G, json={"name": "a\x07b"}).status_code == 422
    assert client.put(f"{G}/{b['id']}", json={"name": "Quick dinners"}).status_code == 409
    assert client.put(f"{G}/{b['id']}", json={"name": "Baking"}).status_code == 200  # its own name is not a clash
    assert client.put(f"{G}/{b['id']}", json={"name": "Cakes"}).json()["name"] == "Cakes"
    assert client.put(f"{G}/999", json={"name": "Nope"}).status_code == 404
    order = client.put(f"{G}/order", json={"ids": [c["id"], a["id"], b["id"]]})
    assert [g["name"] for g in order.json()] == ["Sunday", "Quick dinners", "Cakes"]
    assert client.put(f"{G}/order", json={"ids": [a["id"], b["id"]]}).status_code == 422  # not every group
    assert client.put(f"{G}/order", json={"ids": [a["id"], a["id"], b["id"], c["id"]]}).status_code == 422
    new = client.post(G, json={"name": "Later"}).json()
    assert new["position"] > max(g["position"] for g in order.json())  # a new one goes last
    assert client.delete(f"{G}/{a['id']}").status_code == 204
    assert client.delete(f"{G}/{a['id']}").status_code == 404
    assert [g["name"] for g in client.get(G).json()] == ["Sunday", "Cakes", "Later"]


def test_both_kinds_of_recipe_can_be_members_and_a_recipe_can_be_in_several_groups(on):  # noqa: F811
    with on as cook:
        taken = cook.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
        a = cook.post(G, json={"name": "A"}).json()
        b = cook.post(G, json={"name": "B"}).json()
        # the own recipe lives in another app instance (`client`), so make one here as well
        body = {"name": "Porridge", "portions": 2, "items": [{"food_id": cook.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200}}).json()["id"], "amount": 100}]}
        mine = cook.post("/api/v1/recipes", json=body).json()["food"]["id"]
        added = cook.post(f"{G}/{a['id']}/members", json={"food_ids": [mine, taken["id"], mine]})
        assert added.status_code == 200 and added.json()["count"] == 2 and sorted(added.json()["food_ids"]) == sorted([mine, taken["id"]])
        assert cook.post(f"{G}/{b['id']}/members", json={"food_ids": [taken["id"]]}).json()["count"] == 1
        groups = {g["name"]: g["food_ids"] for g in cook.get(G).json()}
        assert taken["id"] in groups["A"] and taken["id"] in groups["B"] and mine in groups["A"]
        # exactly these groups for one recipe
        assert cook.put(f"{G}/foods/{taken['id']}", json={"group_ids": [b["id"]]}).json() == [b["id"]]
        groups = {g["name"]: g["food_ids"] for g in cook.get(G).json()}
        assert taken["id"] not in groups["A"] and taken["id"] in groups["B"]
        assert cook.put(f"{G}/foods/{taken['id']}", json={"group_ids": []}).json() == []
        assert cook.put(f"{G}/foods/{taken['id']}", json={"group_ids": [999]}).status_code == 404
        assert cook.post(f"{G}/{a['id']}/members/remove", json={"food_ids": [mine]}).json()["food_ids"] == []


def test_only_recipes_can_be_members(client, food, own_recipe):
    g = client.post(G, json={"name": "A"}).json()
    assert client.post(f"{G}/{g['id']}/members", json={"food_ids": [food["id"]]}).status_code == 422  # a product, not a recipe
    assert client.post(f"{G}/{g['id']}/members", json={"food_ids": [99999]}).status_code == 422
    assert client.post(f"{G}/{g['id']}/members", json={"food_ids": []}).status_code == 422
    assert client.post(f"{G}/999/members", json={"food_ids": [own_recipe["food"]["id"]]}).status_code == 404
    assert client.put(f"{G}/foods/{food['id']}", json={"group_ids": [g["id"]]}).status_code == 422
    ok = client.post(f"{G}/{g['id']}/members", json={"food_ids": [own_recipe["food"]["id"]]})
    assert ok.status_code == 200 and ok.json()["count"] == 1
    assert client.post(f"{G}/{g['id']}/members", json={"food_ids": [own_recipe["food"]["id"]]}).json()["count"] == 1  # twice is once


def test_deleting_a_recipe_or_a_group_tidies_up(client, own_recipe):
    food_id = own_recipe["food"]["id"]
    a = client.post(G, json={"name": "A"}).json()
    b = client.post(G, json={"name": "B"}).json()
    for g in (a, b):
        client.post(f"{G}/{g['id']}/members", json={"food_ids": [food_id]})
    assert client.delete(f"{G}/{a['id']}").status_code == 204
    assert client.get(f"/api/v1/recipes/{own_recipe['id']}").status_code == 200  # the recipe stays
    con = sqlite3.connect(client.app.state.store.path)
    assert con.execute("SELECT count(*) FROM recipe_group_item WHERE group_id = ?", (a["id"],)).fetchone()[0] == 0
    assert client.delete(f"/api/v1/recipes/{own_recipe['id']}").status_code == 204
    assert client.get(G).json()[0]["food_ids"] == []  # gone from the group it was in
    assert con.execute("SELECT count(*) FROM recipe_group_item").fetchone()[0] == 0
    con.close()


def test_removing_a_cookidoo_recipe_removes_it_from_its_groups(on):  # noqa: F811
    with on as client:
        taken = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
        g = client.post(G, json={"name": "A"}).json()
        client.post(f"{G}/{g['id']}/members", json={"food_ids": [taken["id"]]})
        assert client.delete(f"/api/v1/foods/{taken['id']}").status_code == 204
        assert client.get(G).json()[0]["food_ids"] == []
        assert client.get(G).json()[0]["count"] == 0


def test_a_deleted_automatic_group_is_remembered_but_a_manual_one_is_not(client):
    store = client.app.state.store
    auto, created = store.source_group("cookidoo:c9", "Soups", 1)
    assert created and store.source_group("cookidoo:c9", "Whatever", 1) == (auto, False)  # found by the link, not by the name
    client.put(f"{G}/{auto}", json={"name": "My soups"})
    assert store.source_group("cookidoo:c9", "Soups", 1) == (auto, False)
    assert client.get(G).json()[0]["auto"] is True
    manual = client.post(G, json={"name": "Mine"}).json()
    client.delete(f"{G}/{manual['id']}")
    assert client.delete(f"{G}/{auto}").status_code == 204
    assert store.source_dismissed("cookidoo:c9") and store.source_group("cookidoo:c9", "Soups", 1) == (None, False)
    store.undismiss_source("cookidoo:c9")
    assert store.source_group("cookidoo:c9", "Soups", 1)[1] is True


def test_groups_follow_the_rules_for_access_tokens(client, own_recipe):
    g = client.post(G, json={"name": "A"}).json()
    read = client.post("/api/v1/me/tokens", json={"name": "r", "scope": "read"}).json()["token"]
    headers = {"Authorization": f"Bearer {read}"}
    assert client.get(G, headers=headers).status_code == 200
    assert client.post(G, json={"name": "B"}, headers=headers).status_code == 403
    assert client.delete(f"{G}/{g['id']}", headers=headers).status_code == 403


def test_no_csrf_header_no_write(client):
    del client.headers["X-Mahlwerk-Request"]
    assert client.post(G, json={"name": "A"}).status_code in (400, 403)

"""Recipes: a shared food calculated from ingredients."""

import pytest

from mahlwerk.nutrition import recipe_food

DAY = "2025-03-10"


def make(client, name, per_100, extra=None, **more):
    return client.post("/api/v1/foods", json={"name": name, "per_100": per_100, "extra": extra or {}, **more}).json()


@pytest.fixture
def flour(client):
    return make(client, "Flour", {"kcal": 350, "carbs": 70, "protein": 10}, {"iron": 2})


@pytest.fixture
def milk(client):
    return make(client, "Milk", {"kcal": 50, "carbs": 5, "protein": 3}, unit="ml")


@pytest.fixture
def sugar(client):
    return make(client, "Sugar", {"kcal": 400, "carbs": 100})  # no protein stated


def body(flour, milk, sugar, **more):
    return {
        "name": "Pancakes", "portions": 4,
        "items": [
            {"food_id": flour["id"], "amount": 200},
            {"food_id": milk["id"], "amount": 300},
            {"food_id": sugar["id"], "amount": 50},
        ],
        **more,
    }


def test_calculation_without_total_weight(client, flour, milk, sugar):
    r = client.post("/api/v1/recipes", json=body(flour, milk, sugar))
    assert r.status_code == 201, r.text
    recipe = r.json()
    food = recipe["food"]
    assert food["source"] == "recipe" and food["recipe_id"] == recipe["id"] and food["name"] == "Pancakes"
    # reference weight = 200 + 300 + 50 = 550
    assert food["per_100"]["kcal"] == 190.91 and food["per_100"]["carbs"] == 37.27
    assert food["per_100"]["protein"] == 5.27  # sugar does not state protein: unknown, not zero
    assert food["per_100"]["salt"] is None and food["per_100"]["fiber"] is None
    assert food["extra"] == {"iron": 0.7273}  # only flour states iron: 4 mg over 550 g
    assert food["complete"] is False  # fat is unknown everywhere
    assert food["serving_quantity"] == 137.5 and food["serving_size"] == "137.5 g" and food["unit"] == "g"
    assert recipe["portions"] == 4 and recipe["total_weight"] is None
    assert recipe["kcal_per_portion"] == 262.5
    assert [(i["name"], i["amount"], i["unit"], i["kcal"]) for i in recipe["items"]] == [
        ("Flour", 200, "g", 700), ("Milk", 300, "ml", 150), ("Sugar", 50, "g", 200)]


def test_calculation_with_total_weight(client, flour, milk, sugar):
    recipe = client.post("/api/v1/recipes", json=body(flour, milk, sugar, total_weight=700)).json()
    food = recipe["food"]
    assert food["per_100"]["kcal"] == 150 and food["extra"] == {"iron": 0.5714}
    assert food["serving_quantity"] == 175 and food["serving_size"] == "175 g"
    assert recipe["total_weight"] == 700 and recipe["kcal_per_portion"] == 262.5  # the dish has the same energy


def test_one_portion_in_the_diary_matches_the_calculation(client, flour, milk, sugar):
    recipe = client.post("/api/v1/recipes", json=body(flour, milk, sugar, total_weight=700)).json()
    food = recipe["food"]
    r = client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "dinner", "amount": food["serving_quantity"]})
    assert r.status_code == 201
    assert r.json()["kcal"] == recipe["kcal_per_portion"] == 262.5 and r.json()["name"] == "Pancakes"
    day = client.get(f"/api/v1/diary/{DAY}").json()
    assert day["extra_totals"]["iron"]["amount"] == 1.0  # 4 mg iron / 4 portions


def test_recipe_food_function_directly():
    items = [
        {"amount": 100, "per_100": {"kcal": 100, "fat": None}, "extra": {}},
        {"amount": 100, "per_100": {"kcal": 200, "fat": 10}, "extra": {"zinc": 4}},
    ]
    data = recipe_food(items, 2, None)
    assert data["per_100"]["kcal"] == 150 and data["per_100"]["fat"] == 5  # 10 g over 200 g
    assert data["extra"] == {"zinc": 2} and data["serving_quantity"] == 100
    assert recipe_food(items, 1, 50)["per_100"]["kcal"] == 600 and recipe_food(items, 8, None)["serving_size"] == "25 g"
    assert recipe_food(items[:1], 1, None)["per_100"]["fat"] is None


def test_list_get_and_unknown(client, flour, milk, sugar):
    first = client.post("/api/v1/recipes", json=body(flour, milk, sugar)).json()
    second = client.post("/api/v1/recipes", json={**body(flour, milk, sugar), "name": "Waffles"}).json()
    assert [r["id"] for r in client.get("/api/v1/recipes").json()] == [second["id"], first["id"]]
    assert client.get(f"/api/v1/recipes/{first['id']}").json() == first
    assert client.get("/api/v1/recipes/999").status_code == 404
    assert client.put("/api/v1/recipes/999", json=body(flour, milk, sugar)).status_code == 404
    assert client.delete("/api/v1/recipes/999").status_code == 404


def test_put_recalculates_and_old_entries_stay(client, flour, milk, sugar):
    recipe = client.post("/api/v1/recipes", json=body(flour, milk, sugar)).json()
    fid = recipe["food"]["id"]
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": fid, "meal": "lunch", "amount": 100})
    changed = {**body(flour, milk, sugar), "name": "Big pancakes", "portions": 2,
               "items": [{"food_id": flour["id"], "amount": 100}, {"food_id": milk["id"], "amount": 100}]}
    r = client.put(f"/api/v1/recipes/{recipe['id']}", json=changed)
    assert r.status_code == 200
    new = r.json()
    assert new["id"] == recipe["id"] and new["food"]["id"] == fid and new["food"]["name"] == "Big pancakes"
    assert new["food"]["per_100"]["kcal"] == 200 and new["food"]["serving_quantity"] == 100
    assert len(new["items"]) == 2 and new["total_weight"] is None
    entry = client.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"][0]
    assert entry["name"] == "Pancakes" and entry["kcal"] == 190.9  # the copy from the time of logging
    assert client.get(f"/api/v1/foods/{fid}").json()["name"] == "Big pancakes"


def test_ingredient_order_is_kept(client, flour, milk, sugar):
    items = [{"food_id": f["id"], "amount": 10} for f in (sugar, flour, milk)]
    recipe = client.post("/api/v1/recipes", json={"name": "X", "portions": 1, "items": items}).json()
    assert [i["name"] for i in recipe["items"]] == ["Sugar", "Flour", "Milk"]
    items.reverse()
    recipe = client.put(f"/api/v1/recipes/{recipe['id']}", json={"name": "X", "portions": 1, "items": items}).json()
    assert [i["name"] for i in recipe["items"]] == ["Milk", "Flour", "Sugar"]


def test_delete_removes_recipe_and_food_but_not_the_diary_copies(client, flour, milk, sugar):
    recipe = client.post("/api/v1/recipes", json=body(flour, milk, sugar)).json()
    fid = recipe["food"]["id"]
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": fid, "meal": "lunch", "amount": 100})
    assert client.delete(f"/api/v1/recipes/{recipe['id']}").status_code == 204
    assert client.get(f"/api/v1/foods/{fid}").status_code == 404
    assert client.get("/api/v1/recipes").json() == []
    assert client.get(f"/api/v1/foods/{flour['id']}").status_code == 200  # ingredients stay
    entry = client.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"][0]
    assert entry["name"] == "Pancakes" and entry["food_id"] is None and entry["kcal"] == 190.9


def test_deleting_an_ingredient_keeps_the_recipe(client, flour, milk, sugar):
    recipe = client.post("/api/v1/recipes", json=body(flour, milk, sugar)).json()
    client.delete(f"/api/v1/foods/{flour['id']}")
    again = client.get(f"/api/v1/recipes/{recipe['id']}").json()
    assert again["items"][0]["name"] == "Flour" and again["items"][0]["food_id"] is None
    assert again["food"]["per_100"]["kcal"] == 190.91


def test_validation(client, flour):
    ok = {"name": "R", "portions": 2, "items": [{"food_id": flour["id"], "amount": 100}]}
    assert client.post("/api/v1/recipes", json=ok).status_code == 201
    for bad in (
        {**ok, "items": []},
        {**ok, "items": [{"food_id": flour["id"], "amount": 10}] * 61},
        {**ok, "items": [{"food_id": 999, "amount": 10}]},
        {**ok, "items": [{"food_id": flour["id"], "amount": 0}]},
        {**ok, "portions": 0},
        {**ok, "total_weight": 0},
        {**ok, "name": ""},
        {**ok, "name": "  "},
    ):
        assert client.post("/api/v1/recipes", json=bad).status_code == 422, bad
    assert client.post("/api/v1/recipes", json={**ok, "items": [{"food_id": flour["id"], "amount": 10}] * 60}).status_code == 201


def test_a_recipe_cannot_be_an_ingredient(client, flour):
    recipe = client.post("/api/v1/recipes", json={"name": "R", "portions": 1, "items": [{"food_id": flour["id"], "amount": 100}]}).json()
    nested = {"name": "Nested", "portions": 1, "items": [{"food_id": recipe["food"]["id"], "amount": 100}]}
    r = client.post("/api/v1/recipes", json=nested)
    assert r.status_code == 422 and "recipe" in r.json()["detail"]
    assert client.put(f"/api/v1/recipes/{recipe['id']}", json=nested).status_code == 422


def test_food_routes_refuse_to_change_a_recipe_food(client, flour):
    recipe = client.post("/api/v1/recipes", json={"name": "R", "portions": 1, "items": [{"food_id": flour["id"], "amount": 100}]}).json()
    fid = recipe["food"]["id"]
    r = client.put(f"/api/v1/foods/{fid}", json={"name": "Hack", "per_100": {"kcal": 1}})
    assert r.status_code == 409 and "recipe" in r.json()["detail"]
    assert client.delete(f"/api/v1/foods/{fid}").status_code == 409
    assert client.get(f"/api/v1/foods/{fid}").json()["name"] == "R"


def test_search_and_recent_show_recipes(client, flour):
    recipe = client.post("/api/v1/recipes", json={"name": "Pancake batter", "portions": 1, "items": [{"food_id": flour["id"], "amount": 100}]}).json()
    found = client.get("/api/v1/foods", params={"q": "pancake"}).json()
    assert [(f["id"], f["source"], f["recipe_id"]) for f in found] == [(recipe["food"]["id"], "recipe", recipe["id"])]
    assert [f["name"] for f in client.get("/api/v1/foods", params={"source": "recipe"}).json()] == ["Pancake batter"]
    assert "Pancake batter" not in [f["name"] for f in client.get("/api/v1/foods", params={"source": "own"}).json()]
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": recipe["food"]["id"], "meal": "lunch", "amount": 100})
    recent = client.get("/api/v1/foods/recent").json()
    assert recent[0]["food"]["source"] == "recipe"


def test_recipes_are_shared_between_users(duo):
    ann, ben = duo
    f = ann.post("/api/v1/foods", json={"name": "Flour", "per_100": {"kcal": 350}}).json()
    recipe = ann.post("/api/v1/recipes", json={"name": "R", "portions": 1, "items": [{"food_id": f["id"], "amount": 100}]}).json()
    assert [r["id"] for r in ben.get("/api/v1/recipes").json()] == [recipe["id"]]
    assert ben.put(f"/api/v1/recipes/{recipe['id']}", json={"name": "R2", "portions": 1, "items": [{"food_id": f["id"], "amount": 50}]}).status_code == 200
    assert ben.delete(f"/api/v1/recipes/{recipe['id']}").status_code == 204


def test_demo_data_removal_and_insights_keep_working(duo):
    ann, _ = duo
    ann.post("/api/v1/me/demo-data", json={"days": 10})
    demo_food = ann.get("/api/v1/foods").json()[0]
    recipe = ann.post("/api/v1/recipes", json={"name": "Mix", "portions": 2, "items": [{"food_id": demo_food["id"], "amount": 100}]}).json()
    ann.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": recipe["food"]["id"], "meal": "lunch", "amount": 150})
    insights = ann.get("/api/v1/insights", params={"from": DAY, "to": DAY})
    assert insights.status_code == 200 and insights.json()["top_foods"]["kcal"][0]["name"] == "Mix"
    removed = ann.delete("/api/v1/me/demo-data")
    assert removed.status_code == 200 and removed.json()["entries"] > 0
    # the recipe food was never a demo food and stays; the ingredient copy keeps its snapshot
    assert ann.get(f"/api/v1/recipes/{recipe['id']}").json()["items"][0]["name"] == demo_food["name"]
    assert ann.get(f"/api/v1/foods/{recipe['food']['id']}").status_code == 200
    assert ann.get("/api/v1/insights", params={"from": DAY, "to": DAY}).status_code == 200

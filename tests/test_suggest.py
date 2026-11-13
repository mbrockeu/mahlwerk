"""Suggestions "what still fits today": the ranking rule (pure) and the endpoint."""

import time

import pytest

from mahlwerk import suggest
from mahlwerk.suggest import Candidate, Rest, rank

SALAD = Candidate(1, 350, 12, 40, 14)     # light
CHICKEN = Candidate(2, 600, 55, 50, 18)   # protein rich
PASTA = Candidate(3, 800, 25, 110, 25)    # big
SOUP = Candidate(4, 180, 6, 25, 5)        # small
POOL = [SALAD, CHICKEN, PASTA, SOUP]
FRESH = {c.food_id: None for c in POOL}


def ids(result):
    return [s.food_id for s in result.items]


def test_large_rest_prefers_a_recipe_that_takes_a_good_share():
    r = rank(Rest(1200, 100, 150, 50), POOL, FRESH)
    assert r.state == "ok" and ids(r)[0] == CHICKEN.food_id
    top = r.items[0]
    assert "fills_protein" in top.reasons and top.after.kcal == pytest.approx(1200 - top.kcal) and top.kcal <= 1200


def test_small_rest_only_offers_what_fits_and_halves_when_needed():
    r = rank(Rest(250, 20, 40, 10), POOL, FRESH)
    assert r.state == "ok"
    for s in r.items:
        assert s.kcal <= 250 + 30
    assert PASTA.food_id not in ids(r)  # 400 kcal for half a portion does not fit
    half = [s for s in r.items if s.food_id == SALAD.food_id]
    assert half and half[0].portions == 0.5 and half[0].amount == 50.0  # amount in the unit of the food (100 g portion)


def test_amount_is_the_best_of_half_one_one_and_a_half_and_two():
    r = rank(Rest(900, 80, 100, 40), [SOUP], {4: None})
    assert r.items[0].portions == 2.0 or r.items[0].portions == 1.5  # the soup alone is small: more of it fills the rest better
    r = rank(Rest(300, 80, 100, 40), [SOUP], {4: None})
    assert r.items[0].portions == 1.0
    assert rank(Rest(90, 80, 100, 40), [SOUP], {4: None}).items[0].portions == 0.5


def test_protein_gap_moves_protein_rich_recipes_up_with_focus_protein():
    pool = [Candidate(1, 500, 10, 60, 15), Candidate(2, 500, 45, 40, 15)]
    r = rank(Rest(800, 90, 120, 40), pool, {1: None, 2: None}, "protein")
    assert ids(r) == [2, 1] and "fills_protein" in r.items[0].reasons
    assert r.items[0].after.protein == pytest.approx(90 - r.items[0].protein)


def test_light_focus_orders_by_lightness():
    r = rank(Rest(900, 60, 100, 40), POOL, FRESH, "light")
    assert ids(r)[0] in (SOUP.food_id, SALAD.food_id) and ids(r)[-1] in (PASTA.food_id, CHICKEN.food_id)
    assert "light" in r.items[0].reasons


def test_light_focus_recommends_one_portion_and_a_half_only_when_one_does_not_fit():
    r = rank(Rest(900, 60, 100, 40), POOL, FRESH, "light")
    assert all(s.portions == 1.0 for s in r.items)
    r = rank(Rest(200, 20, 30, 10), [SALAD, SOUP], {1: None, 4: None}, "light")
    assert {s.food_id: s.portions for s in r.items} == {1: 0.5, 4: 1.0}


def test_rotation_puts_long_ago_first_and_recent_last():
    days = {1: 1, 2: 30, 3: None, 4: 6}
    r = rank(Rest(1500, 100, 200, 60), POOL, days, "rotation")
    assert ids(r)[:2] in ([3, 2], [2, 3]) and ids(r)[-1] == 1
    assert "not_eaten_lately" in r.items[0].reasons


def test_recently_eaten_moves_back_in_every_focus():
    pool = [Candidate(1, 500, 30, 50, 15), Candidate(2, 500, 30, 50, 15)]
    for focus in suggest.FOCI:
        assert ids(rank(Rest(900, 70, 100, 40), pool, {1: 0, 2: 20}, focus)) == [2, 1]
        assert ids(rank(Rest(900, 70, 100, 40), pool, {1: 2, 2: 20}, focus)) == [2, 1]


def test_goal_reached_says_so_and_offers_light_ideas_only_on_request():
    r = rank(Rest(-40, 0, -10, 0), POOL, FRESH)
    assert r.state == "goal_reached" and r.items == ()
    r = rank(Rest(-40, 0, -10, 0), POOL, FRESH, anyway=True)
    assert r.state == "goal_reached" and ids(r) and all(s.kcal <= 300 for s in r.items)
    assert r.items[0].kcal == min(s.kcal for s in r.items)  # the lightest amount first
    only_big = rank(Rest(0, 0, 0, 0), [PASTA], {3: None}, anyway=True)  # even half a portion is 400 kcal
    assert only_big.state == "goal_reached" and only_big.items == ()


def test_no_goal_falls_back_to_protein_density_and_variety():
    r = rank(Rest(None), POOL, {1: 0, 2: 2, 3: 30, 4: None})
    assert r.state == "no_goal" and r.items
    assert ids(r)[0] in (2, 4, 3) and ids(r)[-1] == 1
    assert all(s.after.kcal is None for s in r.items)
    chicken = next(s for s in r.items if s.food_id == 2)
    assert "high_protein" in chicken.reasons


def test_everything_eaten_lately_still_gives_a_ranking():
    days = {c.food_id: 0 for c in POOL}
    r = rank(Rest(1200, 100, 150, 50), POOL, days)
    assert r.state == "ok" and len(r.items) == 4


def test_nothing_fits_and_no_recipes():
    assert rank(Rest(60, 5, 5, 2), [PASTA, CHICKEN], {3: None, 2: None}).state == "nothing_fits"
    assert rank(Rest(500), [], {}).state == "no_recipes"
    assert rank(Rest(500), [Candidate(9, 0)], {}).state == "no_recipes"


def test_slightly_over_is_allowed_and_marked():
    score, flags = suggest._evaluate(CHICKEN, 1.0, Rest(590, 50, 60, 20), None, "balanced")  # 600 kcal: 10 over, inside the tolerance
    assert "slightly_over" in flags and "fits_kcal" not in flags
    assert suggest._evaluate(CHICKEN, 1.0, Rest(500, 50, 60, 20), None, "balanced") is None  # 100 over: not possible


def test_carbs_and_fat_beyond_the_rest_cost_a_little_but_protein_never():
    low_carb, high_carb = Candidate(1, 500, 30, 10, 20), Candidate(2, 500, 30, 90, 20)
    assert ids(rank(Rest(900, 60, 20, 60), [high_carb, low_carb], {1: None, 2: None})) == [1, 2]
    heavy_protein, light_protein = Candidate(1, 500, 80, 40, 15), Candidate(2, 500, 5, 40, 15)
    assert ids(rank(Rest(900, 10, 100, 40), [light_protein, heavy_protein], {1: None, 2: None}, "protein"))[0] == 1


def test_deterministic_and_ties_go_to_the_lower_id():
    pool = [Candidate(5, 500, 30, 50, 15), Candidate(3, 500, 30, 50, 15), Candidate(4, 500, 30, 50, 15)]
    a = rank(Rest(900, 70, 100, 40), pool, {})
    b = rank(Rest(900, 70, 100, 40), list(reversed(pool)), {})
    assert ids(a) == ids(b) == [3, 4, 5]


def test_limit_and_unknown_focus():
    assert len(rank(Rest(1500, 100, 150, 50), POOL, FRESH, limit=2).items) == 2
    assert rank(Rest(1500, 100, 150, 50), POOL, FRESH, limit=2).eligible == 4
    with pytest.raises(ValueError):
        rank(Rest(1), POOL, FRESH, "tough")


def test_at_most_two_reasons():
    r = rank(Rest(1000, 50, 100, 40), [Candidate(1, 340, 30, 30, 8)], {1: None})
    assert 1 <= len(r.items[0].reasons) <= 2


# ---- the endpoint ----

DAY = "2026-03-10"


def goal(client, kcal=2000, protein=100, carbs=250, fat=70):
    assert client.put("/api/v1/me/goal", json={"kcal": kcal, "protein": protein, "carbs": carbs, "fat": fat}).status_code == 200


def recipe(store, name, kcal, protein=20, carbs=40, fat=10, source="cookidoo", n=[0]):
    n[0] += 1
    data = {"name": name, "brand": "Cookidoo", "serving_size": "1 portion", "serving_quantity": 100.0, "unit": "g", "complete": True,
            "per_100": {"kcal": kcal, "protein": protein, "carbs": carbs, "fat": fat, "saturated_fat": None, "sugars": None, "fiber": None, "salt": None},
            "extra": {}, "portions": 4}
    return store.put_external_food(f"{source}:{n[0]}", source, data)[0]


def suggestions(client, **params):
    r = client.get("/api/v1/recipes/suggestions", params={"date": DAY, **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_endpoint_rest_from_goal_and_diary(client, food):
    goal(client)
    store = client.app.state.store
    a, b = recipe(store, "Light bowl", 300, 25), recipe(store, "Big dinner", 700, 30)
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "breakfast", "amount": 500})  # 1000 kcal, 50 g protein
    body = suggestions(client)
    assert body["state"] == "ok" and body["goal_kcal"] == 2000 and body["rest"]["kcal"] == 1000 and body["rest"]["protein"] == 50
    assert body["candidates"] == 2 and {i["food"]["id"] for i in body["items"]} == {a, b}
    first = body["items"][0]
    assert first["food"]["source"] == "cookidoo" and first["amount"] == first["portions"] * 100
    assert first["after"]["kcal"] == pytest.approx(1000 - first["kcal"]) and first["reasons"]


def test_endpoint_goal_reached_then_anyway(client, food):
    goal(client, kcal=1000)
    recipe(client.app.state.store, "Soup", 200)
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 600})  # 1200 kcal
    body = suggestions(client)
    assert body["state"] == "goal_reached" and body["items"] == [] and body["rest"]["kcal"] == -200
    body = suggestions(client, anyway="true")
    assert body["state"] == "goal_reached" and [i["food"]["name"] for i in body["items"]] == ["Soup"]


def test_endpoint_without_goal_without_recipes_and_nothing_fits(client, food):
    assert suggestions(client)["state"] == "no_recipes"
    store = client.app.state.store
    recipe(store, "Soup", 200)
    body = suggestions(client)
    assert body["state"] == "no_goal" and body["goal_kcal"] is None and body["rest"]["kcal"] is None and len(body["items"]) == 1
    goal(client, kcal=1000)
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 480})  # 960 of 1000
    assert suggestions(client)["state"] == "nothing_fits"


def test_endpoint_active_energy_counts_toward_the_goal(client, food):
    goal(client, kcal=1000)
    recipe(client.app.state.store, "Soup", 400)
    client.patch("/api/v1/me/settings", json={"activity": {"add_to_goal": True}})
    client.put(f"/api/v1/activity/{DAY}", json={"active_kcal": 500})
    body = suggestions(client)
    assert body["goal_kcal"] == 1500 and body["rest"]["kcal"] == 1500


def test_endpoint_group_filter_focus_and_limit(client):
    goal(client)
    store = client.app.state.store
    ids = [recipe(store, f"R{i}", 300 + 20 * i, 10 + 5 * i) for i in range(6)]
    g = client.post("/api/v1/recipe-groups", json={"name": "Quick"}).json()
    client.post(f"/api/v1/recipe-groups/{g['id']}/members", json={"food_ids": ids[:2]})
    assert {i["food"]["id"] for i in suggestions(client, group=str(g["id"]))["items"]} == set(ids[:2])
    assert {i["food"]["id"] for i in suggestions(client, group="none")["items"]} == set(ids[2:])
    assert len(suggestions(client, limit=3)["items"]) == 3
    assert suggestions(client, focus="protein")["items"][0]["food"]["id"] == ids[5]
    assert suggestions(client, focus="light")["items"][0]["food"]["id"] == ids[0]
    assert client.get("/api/v1/recipes/suggestions", params={"focus": "x"}).status_code == 422
    assert client.get("/api/v1/recipes/suggestions", params={"group": "1;drop"}).status_code == 422
    assert client.get("/api/v1/recipes/suggestions", params={"date": "tomorrow"}).status_code == 422
    assert client.get("/api/v1/recipes/suggestions", params={"limit": 0}).status_code == 422


def test_endpoint_variety_from_the_diary_and_all_three_kinds_of_recipe(client):
    goal(client)
    store = client.app.state.store
    a, b = recipe(store, "Eaten today", 400, source="cookidoo"), recipe(store, "Never eaten", 400, source="web")
    client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": a, "meal": "lunch", "amount": 100})
    body = suggestions(client)
    assert [i["food"]["id"] for i in body["items"]] == [b, a]
    assert "not_eaten_lately" in body["items"][0]["reasons"]
    own = client.post("/api/v1/recipes", json={"name": "Own stew", "portions": 2, "items": [{"food_id": client.post("/api/v1/foods", json={"name": "Beans", "per_100": {"kcal": 100, "protein": 8, "carbs": 15, "fat": 1}}).json()["id"], "amount": 600}]}).json()
    body = suggestions(client)
    item = next(i for i in body["items"] if i["food"]["id"] == own["food"]["id"])
    assert item["kcal"] == pytest.approx(300 * item["portions"]) and item["amount"] == pytest.approx(300 * item["portions"])  # a portion is 300 g


def test_endpoint_separates_people_but_shares_recipes(duo):
    ann, ben = duo
    for c, kcal in ((ann, 2000), (ben, 1200)):
        assert c.put("/api/v1/me/goal", json={"kcal": kcal, "protein": 100, "carbs": 200, "fat": 60}).status_code == 200
    store = ann.app.state.store
    shared = recipe(store, "Shared stew", 500)
    ann.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": shared, "meal": "lunch", "amount": 100})
    a, b = suggestions(ann), suggestions(ben)
    assert a["goal_kcal"] == 2000 and b["goal_kcal"] == 1200
    assert a["rest"]["kcal"] == 1500 and b["rest"]["kcal"] == 1200  # ben's day does not contain ann's lunch (his demo data is another day)
    assert a["items"][0]["food"]["id"] == b["items"][0]["food"]["id"] == shared
    assert "not_eaten_lately" not in a["items"][0]["reasons"] and "not_eaten_lately" in b["items"][0]["reasons"]  # history is per person


def test_setting_in_the_profile(client):
    assert client.get("/api/v1/me").json()["settings"]["suggestions"] is True
    assert client.patch("/api/v1/me/settings", json={"suggestions": False}).json()["suggestions"] is False
    assert client.get("/api/v1/me").json()["settings"]["suggestions"] is False
    assert client.patch("/api/v1/me/settings", json={"playful": False}).json()["suggestions"] is False  # other changes leave it
    assert client.get("/api/v1/recipes/suggestions").status_code == 200  # the API answers either way


def test_route_does_not_shadow_a_recipe_id(client):
    assert client.get("/api/v1/recipes/99999").status_code == 404


def test_speed_with_500_recipes(client):
    goal(client)
    store = client.app.state.store
    ids = [recipe(store, f"Recipe {i}", 200 + (i * 7) % 600, 5 + i % 40, 20 + i % 60, 5 + i % 25) for i in range(500)]
    group = client.post("/api/v1/recipe-groups", json={"name": "G"}).json()
    client.post(f"/api/v1/recipe-groups/{group['id']}/members", json={"food_ids": ids[:250]})
    for i in ids[:60]:
        client.post(f"/api/v1/diary/2026-03-0{1 + i % 9}/entries", json={"food_id": i, "meal": "lunch", "amount": 100})
    timings = []
    for _ in range(5):
        start = time.perf_counter()
        body = suggestions(client)
        timings.append(time.perf_counter() - start)
    print(f"suggestions with 500 recipes: median {sorted(timings)[2] * 1000:.0f} ms, max {max(timings) * 1000:.0f} ms")
    assert body["candidates"] == 500 and len(body["items"]) == 5
    assert sorted(timings)[2] < 0.5
    queries = []
    original = store._connect

    def counting():
        queries.append(1)
        return original()

    store._connect = counting
    suggestions(client)
    store._connect = original
    assert len(queries) < 20  # connections, not rows: no query per recipe

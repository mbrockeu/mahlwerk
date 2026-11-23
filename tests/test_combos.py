"""Favourite combos (foods eaten together in one meal) and the recent foods ordered by fit to a meal."""

from datetime import date, timedelta

import pytest

from mahlwerk import combos
from mahlwerk.routes import diary

TODAY = date(2025, 6, 30)


def day(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


def rows(*days: tuple[int, dict]) -> list[dict]:
    """`(days ago, {food_id: amount})` -> mining rows."""
    return [{"day": day(n), "food_id": f, "amount": a} for n, foods in sorted(days, key=lambda d: -d[0]) for f, a in foods.items()]


# mining


def test_support_counts_distinct_days_and_needs_three():
    r = rows((1, {1: 100, 2: 50}), (2, {1: 100, 2: 50}))
    assert combos.mine(r) == []
    r = rows((1, {1: 100, 2: 50}), (2, {1: 100, 2: 50}), (3, {1: 100, 2: 50}))
    (c,) = combos.mine(r)
    assert c["days"] == 3 and {f for f, _ in c["foods"]} == {1, 2} and c["last_day"] == day(1)


def test_same_food_twice_in_a_day_is_summed_and_counts_one_day():
    r = rows((1, {1: 100, 2: 50}), (2, {1: 100, 2: 50}), (3, {1: 100, 2: 50}))
    r.append({"day": day(1), "food_id": 1, "amount": 20})
    (c,) = combos.mine(r)
    assert c["days"] == 3 and dict(c["foods"]) == {1: 120, 2: 50}  # amounts of the latest day, summed


def test_amounts_come_from_the_latest_day_the_whole_combo_was_eaten():
    r = rows((1, {1: 100, 3: 10}), (2, {1: 80, 2: 40}), (3, {1: 60, 2: 30}), (4, {1: 70, 2: 30}), (5, {1: 70, 2: 30}))
    combo = next(c for c in combos.mine(r) if {f for f, _ in c["foods"]} == {1, 2})
    assert dict(combo["foods"]) == {1: 80, 2: 40} and combo["last_day"] == day(2)


def test_only_maximal_sets_stay_unless_the_smaller_one_is_clearly_more_common():
    # {1,2,3} on 4 days: {1,2} is contained in 4 days too, so it is dropped
    r = rows(*[(n, {1: 1, 2: 1, 3: 1}) for n in range(1, 5)])
    (c,) = combos.mine(r)
    assert {f for f, _ in c["foods"]} == {1, 2, 3}
    # {1,2} on 8 days, {1,2,3} on 3 of them: 3 < 0.75 * 8, both stay (pair first: more days)
    r = rows(*[(n, {1: 1, 2: 1, 3: 1} if n <= 3 else {1: 1, 2: 1}) for n in range(1, 9)])
    found = [{f for f, _ in c["foods"]} for c in combos.mine(r)]
    assert found == [{1, 2}, {1, 2, 3}]


def test_pairwise_intersections_find_a_core_that_no_single_day_shows():
    # every day has {1,2} plus a different extra: only the intersection is frequent
    r = rows((1, {1: 1, 2: 1, 3: 1}), (2, {1: 1, 2: 1, 4: 1}), (3, {1: 1, 2: 1, 5: 1}))
    (c,) = combos.mine(r)
    assert {f for f, _ in c["foods"]} == {1, 2} and c["days"] == 3


def test_ranking_by_support_then_recency_then_size_and_at_most_three():
    r = rows(*[(n, {10: 1, 11: 1}) for n in (1, 2, 3, 4)],          # 4 days
             *[(n, {20: 1, 21: 1}) for n in (5, 6, 7)],             # 3 days, older
             *[(n, {30: 1, 31: 1}) for n in (8, 9, 10)],            # 3 days, oldest
             *[(n, {40: 1, 41: 1}) for n in (11, 12, 13)])
    out = combos.mine(r)
    assert [{f for f, _ in c["foods"]} for c in out] == [{10, 11}, {20, 21}, {30, 31}]
    assert len(combos.mine(r, limit=2)) == 2


def test_big_sets_are_capped():
    big = {f: 1 for f in range(1, 11)}
    assert combos.mine(rows((1, big), (2, big), (3, big))) == []  # 10 foods: no candidate, no intersection within the cap
    nine = {f: 1 for f in range(1, 10)}
    eight = {f: 1 for f in range(1, 9)}
    (c,) = combos.mine(rows((1, nine), (2, eight), (3, eight)))
    assert len(c["foods"]) == 8


def test_skip_leaves_out_equal_sets_only():
    r = rows(*[(n, {1: 1, 2: 1}) for n in (1, 2, 3)], *[(n, {5: 1, 6: 1}) for n in (4, 5, 6)])
    out = combos.mine(r, skip={frozenset({1, 2})})
    assert [{f for f, _ in c["foods"]} for c in out] == [{5, 6}]


def test_fit_scores_weight_recent_days_and_count_a_day_once():
    r = rows((1, {1: 5}), (2, {2: 7}), (40, {3: 9}))
    r.append({"day": day(1), "food_id": 1, "amount": 8})  # twice on one day: one weight
    scores = combos.fit_scores(r, TODAY)
    assert scores[1]["score"] > scores[2]["score"] > scores[3]["score"] > 0
    assert scores[1]["amount"] == 8 and scores[1]["score"] < 1.0


# API


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch):
    monkeypatch.setattr(diary, "today", lambda: TODAY)


def make(client, name, kcal=100):
    return client.post("/api/v1/foods", json={"name": name, "per_100": {"kcal": kcal, "carbs": 10}}).json()


def eat(client, food, amount, meal, ago):
    r = client.post(f"/api/v1/diary/{day(ago)}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text
    return r.json()


def habit(client, foods_amounts, meal, ago_list):
    for ago in ago_list:
        for food, amount in foods_amounts:
            eat(client, food, amount, meal, ago)


def test_endpoint_returns_the_combo_with_last_amounts_and_energy(client):
    quark, oats = make(client, "Quark", 60), make(client, "Haferflocken", 370)
    habit(client, [(quark, 200), (oats, 40)], "breakfast", [3, 2])
    habit(client, [(quark, 250), (oats, 50)], "breakfast", [1])
    habit(client, [(quark, 100)], "lunch", [4, 5, 6])  # another meal and only one food: nothing
    r = client.get("/api/v1/foods/combos", params={"meal": "breakfast"})
    assert r.status_code == 200
    (c,) = r.json()
    assert [(i["food"]["name"], i["amount"], i["kcal"]) for i in c["items"]] == [("Quark", 250, 150), ("Haferflocken", 50, 185)]
    assert c["kcal"] == 335 and c["days"] == 3 and c["last_day"] == day(1)
    assert client.get("/api/v1/foods/combos", params={"meal": "lunch"}).json() == []
    assert client.get("/api/v1/foods/combos", params={"meal": "brunch"}).status_code == 422
    assert client.get("/api/v1/foods/combos").status_code == 422


def test_endpoint_ignores_old_entries_and_deleted_foods(client):
    a, b, c = make(client, "A"), make(client, "B"), make(client, "C")
    habit(client, [(a, 10), (b, 10)], "dinner", [50, 51, 52, 1])  # only one day inside the 42 days
    habit(client, [(a, 10), (c, 10)], "dinner", [2, 3, 4])
    assert [[i["food"]["name"] for i in x["items"]] for x in client.get("/api/v1/foods/combos", params={"meal": "dinner"}).json()] == [["A", "C"]]
    assert client.delete(f"/api/v1/foods/{c['id']}").status_code == 204
    assert client.get("/api/v1/foods/combos", params={"meal": "dinner"}).json() == []


def test_endpoint_skips_combos_equal_to_a_template(client):
    a, b, c, d = (make(client, n) for n in "ABCD")
    habit(client, [(a, 10), (b, 10)], "snack", [1, 2, 3])
    habit(client, [(c, 10), (d, 10)], "snack", [4, 5, 6])
    r = client.post("/api/v1/templates", json={"name": "AB", "items": [{"food_id": a["id"], "amount": 10}, {"food_id": b["id"], "amount": 20}]})
    assert r.status_code == 201 and [i["name"] for i in r.json()["items"]] == ["A", "B"]
    got = client.get("/api/v1/foods/combos", params={"meal": "snack"}).json()
    assert [[i["food"]["name"] for i in x["items"]] for x in got] == [["C", "D"]]


def test_template_needs_exactly_one_source(client):
    a = make(client, "A")
    item = {"food_id": a["id"], "amount": 10}
    assert client.post("/api/v1/templates", json={"name": "x"}).status_code == 422
    both = {"name": "x", "items": [item], "from": {"day": day(1), "meal": "lunch"}}
    assert client.post("/api/v1/templates", json=both).status_code == 422
    assert client.post("/api/v1/templates", json={"name": "x", "items": []}).status_code == 422
    assert client.post("/api/v1/templates", json={"name": "x", "items": [{"food_id": 99999, "amount": 1}]}).status_code == 404
    eat(client, a, 30, "lunch", 1)
    assert client.post("/api/v1/templates", json={"name": "x", "from": {"day": day(1), "meal": "lunch"}}).status_code == 201


def test_combos_only_use_the_own_diary(duo):
    ann, ben = duo
    a, b = make(ann, "A"), make(ann, "B")
    habit(ann, [(a, 10), (b, 10)], "breakfast", [1, 2, 3])
    assert len(ann.get("/api/v1/foods/combos", params={"meal": "breakfast"}).json()) == 1
    assert ben.get("/api/v1/foods/combos", params={"meal": "breakfast"}).json() == []


def names(client, **params):
    return [r["food"]["name"] for r in client.get("/api/v1/foods/recent", params=params).json()]


def test_recent_without_meal_keeps_the_old_order(client):
    a, b, c = make(client, "A"), make(client, "B"), make(client, "C")
    for ago in (5, 4, 3):
        eat(client, a, 10, "breakfast", ago)
    eat(client, b, 10, "lunch", 2)
    eat(client, c, 10, "dinner", 1)
    assert names(client) == ["C", "B", "A"]
    first = client.get("/api/v1/foods/recent").json()[2]
    assert first["last_meal"] == "breakfast" and first["last_amount"] == 10


def test_recent_with_meal_puts_the_foods_of_that_meal_first_then_the_rest_as_before(client):
    a, b, c, d = (make(client, n) for n in "ABCD")
    for ago in (9, 7, 5):
        eat(client, a, 10, "breakfast", ago)   # often at breakfast
    eat(client, b, 10, "breakfast", 8)         # once
    eat(client, c, 10, "lunch", 2)
    eat(client, d, 10, "dinner", 1)
    assert names(client, meal="breakfast") == ["A", "B", "D", "C"]
    assert names(client, meal="lunch") == ["C", "D", "B", "A"]
    assert names(client, meal="breakfast", limit=2) == ["A", "B"]
    got = {r["food"]["name"]: r for r in client.get("/api/v1/foods/recent", params={"meal": "breakfast"}).json()}
    assert got["A"]["last_meal"] == "breakfast"
    assert client.get("/api/v1/foods/recent", params={"meal": "brunch"}).status_code == 422


def test_recent_amount_with_meal_is_the_one_from_that_meal(client):
    a = make(client, "A")
    eat(client, a, 30, "breakfast", 5)
    eat(client, a, 200, "dinner", 1)
    (r,) = client.get("/api/v1/foods/recent", params={"meal": "breakfast"}).json()
    assert (r["last_amount"], r["last_meal"]) == (30, "breakfast")
    (r,) = client.get("/api/v1/foods/recent").json()
    assert (r["last_amount"], r["last_meal"]) == (200, "dinner")

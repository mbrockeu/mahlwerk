"""Copying entries ("same as yesterday") and meal templates."""

import pytest

SRC = "2025-03-09"
DAY = "2025-03-10"


def log(client, food, amount=100, meal="lunch", day=SRC):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def banana(client):
    body = {"name": "Banana", "per_100": {"kcal": 90, "carbs": 20}, "extra": {"potassium": 360}}
    return client.post("/api/v1/foods", json=body).json()


def copy(client, body, day=DAY):
    return client.post(f"/api/v1/diary/{day}/copy", json=body)


def meals(client, day=DAY):
    return client.get(f"/api/v1/diary/{day}").json()["meals"]


# copying


def test_copy_one_meal_keeps_the_meal_and_leaves_the_rest(client, food, banana):
    log(client, food, 50, "breakfast")
    log(client, banana, 120, "breakfast")
    log(client, food, 100, "dinner")
    r = copy(client, {"from_day": SRC, "meal": "breakfast"})
    assert r.status_code == 201
    entries = r.json()["entries"]
    assert [(e["name"], e["amount"], e["meal"]) for e in entries] == [("Oats", 50, "breakfast"), ("Banana", 120, "breakfast")]
    assert [e["kcal"] for e in entries] == [100, 108]
    day = meals(client)
    assert len(day["breakfast"]["entries"]) == 2 and day["dinner"]["entries"] == []
    assert len(meals(client, SRC)["breakfast"]["entries"]) == 2  # the source is untouched


def test_copy_whole_day_keeps_each_meal(client, food):
    log(client, food, 50, "breakfast")
    log(client, food, 100, "dinner")
    entries = copy(client, {"from_day": SRC}).json()["entries"]
    assert sorted(e["meal"] for e in entries) == ["breakfast", "dinner"]
    assert meals(client)["dinner"]["kcal"] == 200


def test_copy_into_another_meal(client, food):
    log(client, food, 50, "breakfast")
    log(client, food, 100, "lunch")
    entries = copy(client, {"from_day": SRC, "to_meal": "snack"}).json()["entries"]
    assert [e["meal"] for e in entries] == ["snack", "snack"]
    entries = copy(client, {"from_day": SRC, "meal": "lunch", "to_meal": "dinner"}).json()["entries"]
    assert [(e["meal"], e["amount"]) for e in entries] == [("dinner", 100)]


def test_copy_within_the_same_day_needs_a_target_meal(client, food):
    log(client, food, 100, "lunch", DAY)
    assert copy(client, {"from_day": DAY, "meal": "lunch"}).status_code == 422
    entries = copy(client, {"from_day": DAY, "meal": "lunch", "to_meal": "dinner"}).json()["entries"]
    assert len(entries) == 1 and entries[0]["meal"] == "dinner"


def test_copy_uses_the_stored_snapshot_not_the_current_food(client, food):
    log(client, food, 100, "lunch")
    client.put(f"/api/v1/foods/{food['id']}", json={"name": "Renamed", "per_100": {"kcal": 999}})
    entry = copy(client, {"from_day": SRC}).json()["entries"][0]
    assert entry["name"] == "Oats" and entry["kcal"] == 200 and entry["food_id"] == food["id"]
    client.delete(f"/api/v1/foods/{food['id']}")
    entry = copy(client, {"from_day": SRC}).json()["entries"][0]
    assert entry["name"] == "Oats" and entry["food_id"] is None


def test_copy_keeps_extra_nutrients(client, banana):
    log(client, banana, 100, "snack")
    copy(client, {"from_day": SRC})
    totals = client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"]
    assert totals["potassium"]["amount"] == 360


def test_copy_errors(client, food):
    assert copy(client, {"from_day": SRC}).status_code == 404  # nothing to copy
    log(client, food, 100, "lunch")
    assert copy(client, {"from_day": SRC, "meal": "dinner"}).status_code == 404
    assert copy(client, {"from_day": "nonsense"}).status_code == 422
    assert copy(client, {"from_day": SRC}, day="nonsense").status_code == 422
    assert copy(client, {"from_day": SRC, "meal": "brunch"}).status_code == 422
    assert copy(client, {"from_day": SRC, "to_meal": "brunch"}).status_code == 422
    assert copy(client, {}).status_code == 422


def test_copy_only_sees_the_own_entries(duo):
    ann, ben = duo
    f = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200}}).json()
    log(ann, f, 100, "lunch")
    assert copy(ben, {"from_day": SRC}).status_code == 404
    assert len(copy(ann, {"from_day": SRC}).json()["entries"]) == 1
    assert meals(ben)["lunch"]["entries"] == []


def test_copied_entries_can_be_removed_again(client, food):
    log(client, food, 100, "lunch")
    ids = [e["id"] for e in copy(client, {"from_day": SRC}).json()["entries"]]
    for i in ids:
        assert client.delete(f"/api/v1/diary/entries/{i}").status_code == 204
    assert meals(client)["lunch"]["entries"] == []


def test_copied_demo_entries_become_real(duo):
    ann, _ = duo
    ann.post("/api/v1/me/demo-data", json={"days": 3})
    from datetime import date, timedelta
    day = (date.today() - timedelta(days=1)).isoformat()
    target = "2020-01-01"
    assert copy(ann, {"from_day": day}, day=target).status_code == 201
    ann.delete("/api/v1/me/demo-data")
    assert ann.get(f"/api/v1/diary/{target}").json()["totals"]["kcal"] > 0


# Day.yesterday


def test_day_yesterday_lists_only_meals_with_entries(client, food, banana):
    log(client, food, 100, "breakfast")
    log(client, banana, 100, "breakfast")
    log(client, food, 50, "dinner")
    log(client, food, 999, "lunch", "2025-03-08")  # the day before yesterday does not count
    log(client, food, 100, "snack", DAY)
    day = client.get(f"/api/v1/diary/{DAY}").json()
    assert day["yesterday"] == {
        "breakfast": {"kcal": 290, "names": ["Oats", "Banana"]},
        "dinner": {"kcal": 100, "names": ["Oats"]},
    }
    assert client.get("/api/v1/diary/2025-03-20").json()["yesterday"] == {}


# templates


def test_template_from_a_meal_and_apply(client, food, banana):
    log(client, food, 50, "breakfast")
    log(client, banana, 120, "breakfast")
    r = client.post("/api/v1/templates", json={"name": "  Usual breakfast ", "from": {"day": SRC, "meal": "breakfast"}})
    assert r.status_code == 201
    tpl = r.json()
    assert tpl["name"] == "Usual breakfast" and tpl["kcal"] == 208
    assert tpl["items"] == [
        {"name": "Oats", "brand": "Acme", "amount": 50, "unit": "g", "kcal": 100},
        {"name": "Banana", "brand": None, "amount": 120, "unit": "g", "kcal": 108},
    ]
    assert client.get("/api/v1/templates").json() == [tpl]

    applied = client.post(f"/api/v1/templates/{tpl['id']}/apply", json={"day": DAY, "meal": "snack"})
    assert applied.status_code == 201
    entries = applied.json()["entries"]
    assert [(e["name"], e["meal"], e["kcal"]) for e in entries] == [("Oats", "snack", 100), ("Banana", "snack", 108)]
    assert meals(client)["snack"]["kcal"] == 208
    again = client.post(f"/api/v1/templates/{tpl['id']}/apply", json={"day": DAY, "meal": "snack"})
    assert again.status_code == 201 and meals(client)["snack"]["kcal"] == 416


def test_template_holds_a_snapshot(client, food):
    log(client, food, 100, "lunch")
    tpl = client.post("/api/v1/templates", json={"name": "Oats", "from": {"day": SRC, "meal": "lunch"}}).json()
    client.put(f"/api/v1/foods/{food['id']}", json={"name": "Other", "per_100": {"kcal": 1}})
    client.delete(f"/api/v1/diary/entries/{meals(client, SRC)['lunch']['entries'][0]['id']}")
    entry = client.post(f"/api/v1/templates/{tpl['id']}/apply", json={"day": DAY, "meal": "dinner"}).json()["entries"][0]
    assert entry["name"] == "Oats" and entry["kcal"] == 200
    client.delete(f"/api/v1/foods/{food['id']}")
    entry = client.post(f"/api/v1/templates/{tpl['id']}/apply", json={"day": DAY, "meal": "dinner"}).json()["entries"][0]
    assert entry["name"] == "Oats" and entry["food_id"] is None


def test_template_rename_delete_and_validation(client, food):
    log(client, food, 100, "lunch")
    src = {"day": SRC, "meal": "lunch"}
    assert client.post("/api/v1/templates", json={"name": "x", "from": {"day": SRC, "meal": "dinner"}}).status_code == 404
    assert client.post("/api/v1/templates", json={"name": "", "from": src}).status_code == 422
    assert client.post("/api/v1/templates", json={"name": "   ", "from": src}).status_code == 422
    assert client.post("/api/v1/templates", json={"name": "x" * 81, "from": src}).status_code == 422
    assert client.post("/api/v1/templates", json={"name": "x" * 80, "from": src}).status_code == 201
    assert client.post("/api/v1/templates", json={"name": "x", "from": {"day": "bad", "meal": "lunch"}}).status_code == 422
    tid = client.post("/api/v1/templates", json={"name": "Lunch", "from": src}).json()["id"]

    assert client.patch(f"/api/v1/templates/{tid}", json={"name": "Midday"}).json()["name"] == "Midday"
    assert client.patch(f"/api/v1/templates/{tid}", json={"name": ""}).status_code == 422
    assert client.patch("/api/v1/templates/999", json={"name": "x"}).status_code == 404
    assert client.post(f"/api/v1/templates/{tid}/apply", json={"day": "bad", "meal": "lunch"}).status_code == 422
    assert client.post(f"/api/v1/templates/{tid}/apply", json={"day": DAY, "meal": "brunch"}).status_code == 422
    assert client.post("/api/v1/templates/999/apply", json={"day": DAY, "meal": "lunch"}).status_code == 404

    assert client.delete(f"/api/v1/templates/{tid}").status_code == 204
    assert client.delete(f"/api/v1/templates/{tid}").status_code == 404
    assert tid not in [t["id"] for t in client.get("/api/v1/templates").json()]


def test_templates_belong_to_one_user(duo):
    ann, ben = duo
    f = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200}}).json()
    log(ann, f, 100, "lunch")
    tid = ann.post("/api/v1/templates", json={"name": "Mine", "from": {"day": SRC, "meal": "lunch"}}).json()["id"]
    assert ben.get("/api/v1/templates").json() == []
    assert ben.patch(f"/api/v1/templates/{tid}", json={"name": "Stolen"}).status_code == 404
    assert ben.post(f"/api/v1/templates/{tid}/apply", json={"day": DAY, "meal": "lunch"}).status_code == 404
    assert ben.delete(f"/api/v1/templates/{tid}").status_code == 404
    # ben cannot build one from ann's entries either
    assert ben.post("/api/v1/templates", json={"name": "x", "from": {"day": SRC, "meal": "lunch"}}).status_code == 404
    assert [t["name"] for t in ann.get("/api/v1/templates").json()] == ["Mine"]

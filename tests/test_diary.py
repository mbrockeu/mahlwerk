from datetime import date, timedelta

import pytest

DAY = "2025-03-10"


def log(client, food, amount=100, meal="lunch", day=DAY):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text
    return r.json()


def test_entry_scales_nutrients_and_copies_food(client, food):
    entry = log(client, food, 150, "breakfast")
    assert entry["food_id"] == food["id"] and entry["name"] == "Oats" and entry["brand"] == "Acme"
    assert (entry["amount"], entry["unit"]) == (150, "g")
    assert (entry["kcal"], entry["protein"], entry["carbs"], entry["fat"]) == (300, 15, 45, 6)


def test_missing_nutrients_stay_null(client):
    f = client.post("/api/v1/foods", json={"name": "Water", "per_100": {"kcal": 0}}).json()
    entry = log(client, f, 250)
    assert entry["kcal"] == 0 and entry["protein"] is None


def test_day_totals_meals_and_goal(client, food):
    client.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70})
    log(client, food, 100, "breakfast")
    log(client, food, 50, "breakfast")
    log(client, food, 200, "dinner")
    day = client.get(f"/api/v1/diary/{DAY}").json()
    assert day["goal"] == {"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70, "water_ml": 2000, "steps": 8000}
    assert day["totals"]["kcal"] == 700 and day["totals"]["protein"] == 35
    assert day["totals"]["salt"] == 0  # null counts as 0
    assert day["meals"]["breakfast"]["kcal"] == 300 and len(day["meals"]["breakfast"]["entries"]) == 2
    assert day["meals"]["dinner"]["kcal"] == 400
    assert day["meals"]["lunch"] == {"kcal": 0, "entries": []}
    assert set(day["meals"]) == {"breakfast", "lunch", "dinner", "snack"}


def test_empty_day(client):
    day = client.get(f"/api/v1/diary/{DAY}").json()
    assert day["goal"] is None and day["streak"] == 0 and day["totals"]["kcal"] == 0
    assert len(day["week"]) == 7 and not any(w["logged"] for w in day["week"])


def test_entry_keeps_values_when_the_food_changes_or_disappears(client, food):
    entry = log(client, food, 100)
    client.put(f"/api/v1/foods/{food['id']}", json={"name": "Renamed", "per_100": {"kcal": 999}})
    after_edit = client.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"][0]
    assert after_edit["name"] == "Oats" and after_edit["kcal"] == 200

    client.delete(f"/api/v1/foods/{food['id']}")
    after_delete = client.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"][0]
    assert after_delete["id"] == entry["id"] and after_delete["food_id"] is None
    assert after_delete["name"] == "Oats" and after_delete["kcal"] == 200


def test_patch_changes_amount_and_meal(client, food):
    entry = log(client, food, 100)
    changed = client.patch(f"/api/v1/diary/entries/{entry['id']}", json={"amount": 50}).json()
    assert changed["amount"] == 50 and changed["kcal"] == 100 and changed["meal"] == "lunch"
    moved = client.patch(f"/api/v1/diary/entries/{entry['id']}", json={"meal": "snack"}).json()
    assert moved["meal"] == "snack" and moved["amount"] == 50
    assert client.patch(f"/api/v1/diary/entries/{entry['id']}", json={}).status_code == 422
    assert client.patch(f"/api/v1/diary/entries/{entry['id']}", json={"amount": 0}).status_code == 422
    assert client.patch("/api/v1/diary/entries/999", json={"amount": 5}).status_code == 404


def test_delete_entry(client, food):
    entry = log(client, food)
    assert client.delete(f"/api/v1/diary/entries/{entry['id']}").status_code == 204
    assert client.delete(f"/api/v1/diary/entries/{entry['id']}").status_code == 404
    assert client.get(f"/api/v1/diary/{DAY}").json()["totals"]["kcal"] == 0


def test_entry_validation(client, food):
    url = f"/api/v1/diary/{DAY}/entries"
    ok = {"food_id": food["id"], "meal": "lunch", "amount": 100}
    assert client.post(url, json={**ok, "amount": 0}).status_code == 422
    assert client.post(url, json={**ok, "amount": -5}).status_code == 422
    assert client.post(url, json={**ok, "amount": 5000.1}).status_code == 422
    assert client.post(url, json={**ok, "amount": 5000}).status_code == 201
    assert client.post(url, json={**ok, "meal": "brunch"}).status_code == 422
    assert client.post(url, json={**ok, "food_id": 4242}).status_code == 404
    assert client.post("/api/v1/diary/2025-13-40/entries", json=ok).status_code == 422
    assert client.post("/api/v1/diary/yesterday/entries", json=ok).status_code == 422
    assert client.get("/api/v1/diary/2025-3-1").status_code == 422


def test_ml_food_gets_ml_entries(client):
    f = client.post("/api/v1/foods", json={"name": "Milk", "unit": "ml", "per_100": {"kcal": 64}}).json()
    assert log(client, f, 250)["unit"] == "ml"


def test_streak_counts_consecutive_days_ending_at_the_day(client, food):
    for day in ("2025-03-10", "2025-03-09", "2025-03-08", "2025-03-06"):
        log(client, food, 100, day=day)
    assert client.get("/api/v1/diary/2025-03-10").json()["streak"] == 3
    assert client.get("/api/v1/diary/2025-03-09").json()["streak"] == 2
    assert client.get("/api/v1/diary/2025-03-07").json()["streak"] == 0
    assert client.get("/api/v1/diary/2025-03-11").json()["streak"] == 0


def test_week_has_seven_days_oldest_first(client, food):
    log(client, food, 100, day="2025-03-10")
    log(client, food, 50, day="2025-03-10")
    log(client, food, 100, day="2025-03-05")
    log(client, food, 100, day="2025-03-04")  # outside the window
    week = client.get("/api/v1/diary/2025-03-10").json()["week"]
    assert [w["day"] for w in week] == [f"2025-03-{d:02d}" for d in range(4, 11)]
    by_day = {w["day"]: w for w in week}
    assert by_day["2025-03-10"] == {"day": "2025-03-10", "logged": True, "kcal": 300}
    assert by_day["2025-03-07"] == {"day": "2025-03-07", "logged": False, "kcal": 0}
    assert by_day["2025-03-05"]["kcal"] == 200


def test_recent_lists_distinct_foods_newest_first(client, food):
    other = client.post("/api/v1/foods", json={"name": "Milk", "per_100": {"kcal": 64}}).json()
    log(client, food, 100, "breakfast")
    log(client, other, 200, "snack")
    log(client, food, 40, "dinner")
    recent = client.get("/api/v1/foods/recent").json()
    assert [r["food"]["name"] for r in recent] == ["Oats", "Milk"]
    assert (recent[0]["last_amount"], recent[0]["last_meal"]) == (40, "dinner")
    assert len(client.get("/api/v1/foods/recent", params={"limit": 1}).json()) == 1
    client.delete(f"/api/v1/foods/{other['id']}")
    assert [r["food"]["name"] for r in client.get("/api/v1/foods/recent").json()] == ["Oats"]


def test_history_covers_the_last_days_ending_today(client, food):
    today = date.today()
    log(client, food, 100, day=today.isoformat())
    log(client, food, 200, day=(today - timedelta(days=2)).isoformat())
    log(client, food, 100, day=(today - timedelta(days=20)).isoformat())
    history = client.get("/api/v1/history", params={"days": 3}).json()
    assert [h["day"] for h in history] == [(today - timedelta(days=n)).isoformat() for n in (2, 1, 0)]
    assert history[0] == {"day": history[0]["day"], "kcal": 400, "protein": 20, "carbs": 60, "fat": 8, "logged": True}
    assert history[1]["logged"] is False and history[1]["kcal"] == 0
    assert history[2]["kcal"] == 200
    assert len(client.get("/api/v1/history").json()) == 14
    assert len(client.get("/api/v1/history", params={"days": 366}).json()) == 366
    for bad in (0, 367):
        assert client.get("/api/v1/history", params={"days": bad}).status_code == 422


def test_weights(client):
    today = date.today()
    d = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
    assert client.put(f"/api/v1/weights/{d(3)}", json={"kg": 80.5}).json() == {"day": d(3), "kg": 80.5}
    client.put(f"/api/v1/weights/{d(3)}", json={"kg": 80.1})  # one value per day
    client.put(f"/api/v1/weights/{d(0)}", json={"kg": 79.9})
    client.put(f"/api/v1/weights/{d(100)}", json={"kg": 90})
    assert client.get("/api/v1/weights").json() == [{"day": d(3), "kg": 80.1}, {"day": d(0), "kg": 79.9}]
    assert len(client.get("/api/v1/weights", params={"days": 3660}).json()) == 3
    assert client.get("/api/v1/weights", params={"days": 2}).json() == [{"day": d(0), "kg": 79.9}]
    assert client.delete(f"/api/v1/weights/{d(3)}").status_code == 204
    assert client.delete(f"/api/v1/weights/{d(3)}").status_code == 404


@pytest.mark.parametrize("kg,status", [(19.9, 422), (20, 200), (400, 200), (400.1, 422)])
def test_weight_bounds(client, kg, status):
    assert client.put(f"/api/v1/weights/{DAY}", json={"kg": kg}).status_code == status


def test_weight_needs_a_valid_day_and_days_limits(client):
    assert client.put("/api/v1/weights/nope", json={"kg": 70}).status_code == 422
    assert client.delete("/api/v1/weights/2025-02-30").status_code == 422
    assert client.get("/api/v1/weights", params={"days": 3661}).status_code == 422
    assert client.get("/api/v1/weights", params={"days": 0}).status_code == 422


@pytest.mark.parametrize(
    "goal,status",
    [
        ({"kcal": 499, "protein": 1, "carbs": 1, "fat": 1}, 422),
        ({"kcal": 500, "protein": 0, "carbs": 0, "fat": 0}, 200),
        ({"kcal": 10000, "protein": 1000, "carbs": 1000, "fat": 1000}, 200),
        ({"kcal": 10001, "protein": 1, "carbs": 1, "fat": 1}, 422),
        ({"kcal": 2000, "protein": 1001, "carbs": 1, "fat": 1}, 422),
        ({"kcal": 2000, "protein": -1, "carbs": 1, "fat": 1}, 422),
        ({"kcal": 2000, "protein": 1}, 422),
    ],
)
def test_goal_bounds(client, goal, status):
    assert client.put("/api/v1/me/goal", json=goal).status_code == status


def test_goal_is_stored_and_replaced(client):
    client.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70})
    client.put("/api/v1/me/goal", json={"kcal": 1800, "protein": 90, "carbs": 200, "fat": 60})
    assert client.get("/api/v1/me").json()["goal"]["kcal"] == 1800


def test_users_cannot_see_each_others_data(monkeypatch, tmp_path, upstream):
    import httpx
    from fastapi.testclient import TestClient

    from mahlwerk.main import create_app

    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "multi.db"), transport=httpx.MockTransport(upstream))
    a = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "a"})
    b = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "b"})

    food = a.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200}}).json()
    today = date.today().isoformat()
    entry = a.post(f"/api/v1/diary/{today}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100}).json()
    a.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70})
    a.put(f"/api/v1/weights/{today}", json={"kg": 80})

    seen = b.get(f"/api/v1/diary/{today}").json()
    assert seen["totals"]["kcal"] == 0 and seen["goal"] is None and seen["streak"] == 0
    assert b.get("/api/v1/me").json()["goal"] is None
    assert b.get("/api/v1/weights").json() == []
    assert b.get("/api/v1/foods/recent").json() == []
    assert not any(h["logged"] for h in b.get("/api/v1/history").json())

    assert b.patch(f"/api/v1/diary/entries/{entry['id']}", json={"amount": 1}).status_code == 404
    assert b.delete(f"/api/v1/diary/entries/{entry['id']}").status_code == 404
    assert a.get(f"/api/v1/diary/{today}").json()["totals"]["kcal"] == 200  # untouched

    assert b.get(f"/api/v1/foods/{food['id']}").status_code == 200  # foods are shared
    assert b.delete(f"/api/v1/weights/{today}").status_code == 404
    assert a.get("/api/v1/weights").json() == [{"day": today, "kg": 80}]

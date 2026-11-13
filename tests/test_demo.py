import sqlite3
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from mahlwerk import demo
from mahlwerk.main import create_app

DEMO = "/api/v1/me/demo-data"


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_DEMO_DATA", "1")
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    return create_app(str(tmp_path / "demo.db"))


@pytest.fixture
def ann(app):
    return TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ann"})


@pytest.fixture
def ben(app):
    return TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ben"})


@pytest.fixture
def food(ann):
    body = {"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}
    return ann.post("/api/v1/foods", json=body).json()


def day(offset: int = 0) -> str:
    return (date.today() - timedelta(days=offset)).isoformat()


def history(client, days=30):
    return client.get(f"/api/v1/history?days={days}").json()


def test_switch_off_answers_404(client):
    assert client.post(DEMO, json={}).status_code == 404
    assert client.delete(DEMO).status_code == 404
    assert client.get("/api/v1/me").json()["demo"] == {"available": False, "entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0}


@pytest.mark.parametrize("value, enabled", [("1", True), ("true", True), ("TRUE", True), ("0", False), ("", False)])
def test_switch_values(monkeypatch, tmp_path, value, enabled):
    monkeypatch.setenv("MAHLWERK_DEMO_DATA", value)
    me = TestClient(create_app(str(tmp_path / "s.db"))).get("/api/v1/me").json()
    assert me["demo"]["available"] is enabled


def test_catalog_is_sane():
    assert 35 <= len(demo.FOODS) <= 45
    for food in demo.FOODS.values():
        assert food["unit"] in ("g", "ml") and food["serving_quantity"]
        assert all(v is not None for v in food["per_100"].values()) and len(food["per_100"]) == 8


def test_generate_fills_days_sets_goal_and_reports(ann):
    r = ann.post(DEMO, json={"days": 30})
    assert r.status_code == 200
    body = r.json()
    assert body["goal_set"] is True and body["foods"] > 20
    assert body["entries"] > 30 * 5 and 10 <= body["weights"] <= 28

    me = ann.get("/api/v1/me").json()
    assert me["goal"] == {"kcal": 2100, "protein": 120, "carbs": 230, "fat": 70, "water_ml": 2000, "steps": 8000}
    assert me["demo"] == {"available": True, "entries": body["entries"], "weights": body["weights"],
                          "water": body["water"], "activity": body["activity"], "workouts": body["workouts"]}

    days = history(ann)
    assert len(days) == 30
    assert days[-1]["logged"] and sum(not d["logged"] for d in days) <= 8
    for d in days[:-1]:
        if d["logged"]:
            assert 1600 <= d["kcal"] <= 2500
    today = ann.get(f"/api/v1/diary/{day()}").json()
    assert today["meals"]["breakfast"]["entries"] and today["meals"]["lunch"]["entries"]
    assert not today["meals"]["dinner"]["entries"] and not today["meals"]["snack"]["entries"]
    assert 0 < today["totals"]["kcal"] < 1600


def test_default_goal_is_not_reported_when_the_user_has_one(ann):
    ann.put("/api/v1/me/goal", json={"kcal": 1800, "protein": 90, "carbs": 200, "fat": 60})
    assert ann.post(DEMO, json={"days": 7}).json()["goal_set"] is False
    assert ann.get("/api/v1/me").json()["goal"]["kcal"] == 1800
    logged = [d["kcal"] for d in history(ann, 7)[:-1] if d["logged"]]
    assert logged and all(1400 <= k <= 2100 for k in logged)


def test_body_is_optional_and_days_are_validated(ann):
    assert ann.post(DEMO).json()["entries"] > 0  # default 30 days
    assert ann.post(DEMO, json={"days": 0}).status_code == 422
    assert ann.post(DEMO, json={"days": 366}).status_code == 422
    assert ann.post(DEMO, json={"days": 365}).status_code == 200


def test_second_call_creates_nothing_new_and_a_longer_range_fills_only_the_gap(ann):
    first = ann.post(DEMO, json={"days": 14}).json()
    before = history(ann, 14)
    again = ann.post(DEMO, json={"days": 14}).json()
    assert again == {"entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0, "foods": 0, "goal_set": False}
    assert history(ann, 14) == before
    assert ann.get("/api/v1/me").json()["demo"]["entries"] == first["entries"]

    more = ann.post(DEMO, json={"days": 28}).json()
    assert more["entries"] > 0 and more["foods"] < first["foods"] + 40
    assert history(ann, 14) == before  # the first 14 days did not change


def test_real_entries_and_weights_stay_untouched(ann, food):
    ann.post(f"/api/v1/diary/{day(2)}/entries", json={"food_id": food["id"], "meal": "dinner", "amount": 100})
    ann.put(f"/api/v1/weights/{day(3)}", json={"kg": 99.9})
    ann.post(DEMO, json={"days": 10})
    entries = ann.get(f"/api/v1/diary/{day(2)}").json()
    assert [e["name"] for m in entries["meals"].values() for e in m["entries"]] == ["Oats"]
    weights = {w["day"]: w["kg"] for w in ann.get("/api/v1/weights?days=10").json()}
    assert weights[day(3)] == 99.9 and len(weights) > 3


def test_about_every_twelfth_day_stays_empty(ann):
    ann.post(DEMO, json={"days": 365})
    gaps = sum(not d["logged"] for d in history(ann, 365))
    assert 15 <= gaps <= 50  # 365 / 12 is about 30


def test_weights_form_a_gently_falling_trend(ann):
    ann.post(DEMO, json={"days": 90})
    kg = [w["kg"] for w in ann.get("/api/v1/weights?days=90").json()]
    assert 40 <= len(kg) <= 80
    assert kg[0] > kg[-1]
    assert max(kg) - min(kg) < 6 and all(40 < v < 130 for v in kg)


def test_demo_foods_are_own_foods_without_the_demo_marker_in_the_api(ann):
    ann.post(DEMO, json={"days": 7})
    listed = ann.get("/api/v1/foods?q=haferflocken").json()
    assert listed and listed[0]["source"] == "own" and listed[0]["code"] is None
    assert "demo" not in listed[0]
    one = ann.get(f"/api/v1/foods/{listed[0]['id']}").json()
    assert "demo" not in one
    recent = ann.get("/api/v1/foods/recent").json()
    assert recent and all("demo" not in r["food"] for r in recent)


def test_editing_a_demo_food_makes_it_a_real_one(ann):
    ann.post(DEMO, json={"days": 7})
    banana = ann.get("/api/v1/foods?q=banane").json()[0]
    edited = ann.put(f"/api/v1/foods/{banana['id']}", json={"name": "Banane", "per_100": {"kcal": 90}})
    assert edited.status_code == 200 and "demo" not in edited.json()
    ann.delete(DEMO)
    assert ann.get(f"/api/v1/foods/{banana['id']}").status_code == 200  # survives the cleanup
    assert ann.get("/api/v1/foods?q=haferflocken").json() == []  # untouched demo foods are gone


def test_delete_removes_exactly_the_demo_data(ann, food):
    ann.post(f"/api/v1/diary/{day(2)}/entries", json={"food_id": food["id"], "meal": "dinner", "amount": 100})
    ann.put(f"/api/v1/weights/{day(3)}", json={"kg": 99.9})
    created = ann.post(DEMO, json={"days": 14}).json()

    removed = ann.delete(DEMO)
    assert removed.status_code == 200
    assert removed.json() == {"entries": created["entries"], "weights": created["weights"], "water": created["water"],
                               "activity": created["activity"], "workouts": created["workouts"], "foods": created["foods"]}

    assert [d["logged"] for d in history(ann, 14)].count(True) == 1
    assert ann.get("/api/v1/weights?days=14").json() == [{"day": day(3), "kg": 99.9}]
    assert ann.get("/api/v1/foods?q=oats").json()[0]["id"] == food["id"]
    assert ann.get("/api/v1/foods?source=own&limit=200").json()[0]["id"] == food["id"]
    assert len(ann.get("/api/v1/foods?limit=200").json()) == 1
    assert ann.get("/api/v1/me").json()["demo"] == {"available": True, "entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0}
    assert ann.get("/api/v1/me").json()["goal"]["kcal"] == 2100  # the goal set by the demo stays
    assert ann.delete(DEMO).json() == {"entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0, "foods": 0}


def test_real_entry_with_a_demo_food_keeps_that_food(ann):
    ann.post(DEMO, json={"days": 7})
    egg = ann.get("/api/v1/foods?limit=1").json()[0]
    real = ann.post(f"/api/v1/diary/{day(40)}/entries", json={"food_id": egg["id"], "meal": "breakfast", "amount": 55})
    assert real.status_code == 201
    ann.delete(DEMO)
    assert ann.get(f"/api/v1/foods/{egg['id']}").status_code == 200  # still referenced by a real entry
    assert [f["id"] for f in ann.get("/api/v1/foods?limit=200").json()] == [egg["id"]]
    assert ann.get(f"/api/v1/diary/{day(40)}").json()["meals"]["breakfast"]["entries"][0]["name"] == egg["name"]


def test_other_user_is_not_affected(ann, ben):
    ann.post(DEMO, json={"days": 14})
    ben.post(DEMO, json={"days": 14})
    ann_before = history(ann, 14)
    ben_counts = ben.get("/api/v1/me").json()["demo"]
    assert ben_counts["entries"] > 0
    assert history(ann, 14) != history(ben, 14)  # seeded per user

    ann.delete(DEMO)
    assert ben.get("/api/v1/me").json()["demo"] == ben_counts
    assert history(ann, 14) != ann_before and not any(d["logged"] for d in history(ann, 14))
    assert any(d["logged"] for d in history(ben, 14))
    assert ben.get("/api/v1/foods?limit=200").json()  # the demo foods his entries use are still there
    today = ben.get(f"/api/v1/diary/{day(1)}").json()
    assert all(e["food_id"] is not None for m in today["meals"].values() for e in m["entries"])


def test_changing_a_demo_weight_makes_it_real(ann):
    ann.post(DEMO, json={"days": 14})
    target = ann.get("/api/v1/weights?days=14").json()[0]
    ann.put(f"/api/v1/weights/{target['day']}", json={"kg": 61.5})
    ann.delete(DEMO)
    assert ann.get("/api/v1/weights?days=14").json() == [{"day": target["day"], "kg": 61.5}]


def test_database_marks_demo_rows(app, ann, tmp_path):
    ann.post(DEMO, json={"days": 5})
    con = sqlite3.connect(str(tmp_path / "demo.db"))
    assert con.execute("SELECT count(*) FROM diary_entry WHERE demo = 0").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM weight WHERE demo = 0").fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM food WHERE json_extract(data, '$.demo') = 1").fetchone()[0] > 0


def test_demo_water_is_removed_again_and_real_water_stays(ann):
    ann.put(f"/api/v1/water/{day(2)}", json={"ml": 1234})
    created = ann.post(DEMO, json={"days": 14}).json()
    assert created["water"] >= 10  # about nine in ten days, the real one is left alone
    assert ann.get(f"/api/v1/diary/{day(2)}").json()["water"]["ml"] == 1234
    assert all(d["water_ml"] % 250 == 0 for d in ann.get("/api/v1/insights?days=14").json()["days"] if d["water_ml"] and d["day"] != day(2))
    assert ann.post(DEMO, json={"days": 14}).json()["water"] == 0  # repeating changes nothing
    assert ann.delete(DEMO).json()["water"] == created["water"]
    assert ann.get(f"/api/v1/diary/{day(2)}").json()["water"]["ml"] == 1234
    assert ann.get(f"/api/v1/diary/{day(1)}").json()["water"]["ml"] == 0

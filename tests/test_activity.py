"""Activity: steps and active energy per day, workouts, the bulk interface for Apple Health, the kcal goal with
active energy added, insights fields and demo data."""

import sqlite3
from datetime import date, timedelta

import pytest
from conftest import DROP_V9
from fastapi.testclient import TestClient

from mahlwerk import activity
from mahlwerk.db import Store
from mahlwerk.main import create_app

MON = date(2025, 3, 3)  # a Monday, 2025-W10
DAY = "2025-03-10"
DEMO = "/api/v1/me/demo-data"


def d(offset: int) -> str:
    return (MON + timedelta(days=offset)).isoformat()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def token(client, scope="write") -> str:
    r = client.post("/api/v1/me/tokens", json={"name": "shortcut", "scope": scope})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def put_activity(client, day=DAY, **body):
    r = client.put(f"/api/v1/activity/{day}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def workout(client, **body):
    r = client.post("/api/v1/workouts", json={"day": DAY, "kind": "running", "minutes": 30, **body})
    assert r.status_code == 201, r.text
    return r.json()


def sync(client, days, **extra):
    r = client.post("/api/v1/health/sync", json={"days": days, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def day_of(client, day=DAY):
    return client.get(f"/api/v1/diary/{day}").json()


# --- schema --------------------------------------------------------------------------------------------------


def test_version_8_database_gets_activity_without_losing_data(tmp_path):
    path = str(tmp_path / "v8.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V9)
    con.executescript(
        """
        INSERT INTO user VALUES (1, 'me', 'me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml) VALUES (1, 2000, 100, 200, 60, 2500);
        INSERT INTO weight (user_id, day, kg, demo) VALUES (1, '2026-01-02', 80.5, 0);
        INSERT INTO water (user_id, day, ml, demo) VALUES (1, '2026-01-02', 1500, 0);
        INSERT INTO diary_entry (user_id, day, meal, amount, unit, name, per_100, created_at)
            VALUES (1, '2026-01-02', 'lunch', 150, 'g', 'Rice', '{"kcal": 130}', 5);
        INSERT INTO user_setting VALUES (1, 'playful', 'false');
        PRAGMA user_version = 8;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"activity_day", "workout"} <= tables
    assert con.execute("SELECT name, amount FROM diary_entry").fetchall() == [("Rice", 150)]
    assert con.execute("SELECT kg, health FROM weight").fetchall() == [(80.5, 0)]
    assert con.execute("SELECT ml, health FROM water").fetchall() == [(1500, 0)]
    con.close()
    assert store.get_goal(1) == {"kcal": 2000, "protein": 100, "carbs": 200, "fat": 60, "water_ml": 2500, "steps": 8000}
    assert store.get_settings(1) == {"playful": False}
    store.put_activity(1, "2026-01-02", {"steps": 5000})
    assert store.activity_between(1, "2026-01-01", "2026-01-31")["2026-01-02"]["steps"] == 5000
    Store(path)  # a second start changes nothing
    assert store.activity_between(1, "2026-01-01", "2026-01-31")["2026-01-02"]["steps"] == 5000


def test_workout_kinds_and_names():
    assert {"walking", "running", "cycling", "hiking", "swimming", "strength", "yoga", "pilates", "crosstrainer", "stairs",
            "circuit", "squash", "bowling", "dancing", "football", "tennis", "skiing", "rowing", "other"} == set(activity.KINDS)
    assert all(k.met > 0 and k.icon for k in activity.KINDS.values())
    for yazio_name, key in (("walking", "walking"), ("running", "running"), ("cycling", "cycling"), ("hiking", "hiking"),
                            ("strengthtraining", "strength"), ("yoga", "yoga"), ("pilates", "pilates"),
                            ("crosstrainer", "crosstrainer"), ("stairclimbing", "stairs"),
                            ("circuittrainingcardio", "circuit"), ("squash", "squash"), ("bowling", "bowling")):
        assert activity.resolve_kind(yazio_name) == (key, "")
    assert activity.resolve_kind("Tischtennis") == ("other", "Tischtennis")
    assert activity.resolve_kind(None, "Traditional Strength Training") == ("strength", "Traditional Strength Training")
    assert activity.resolve_kind("running", "Morning jog") == ("running", "Morning jog")


# --- daily values --------------------------------------------------------------------------------------------


def test_an_empty_day_has_null_values_and_the_default_goal(client):
    assert day_of(client)["activity"] == {
        "steps": None, "steps_goal": 8000, "active_kcal": None, "distance_m": None, "source": None, "bonus_kcal": 0,
        "workouts": []}


def test_values_are_set_partially_and_cleared_with_null(client):
    out = put_activity(client, steps=7500)
    assert out == {"day": DAY, "steps": 7500, "steps_goal": 8000, "active_kcal": None, "distance_m": None,
                   "source": "manual", "bonus_kcal": 0, "workouts": []}
    out = put_activity(client, active_kcal=410.5, distance_m=5200)
    assert (out["steps"], out["active_kcal"], out["distance_m"]) == (7500, 410.5, 5200)  # steps stay
    out = put_activity(client, steps=None)
    assert (out["steps"], out["active_kcal"]) == (None, 410.5)
    assert day_of(client)["activity"]["active_kcal"] == 410.5
    put_activity(client, active_kcal=None, distance_m=None)  # nothing left: the day is empty again
    assert day_of(client)["activity"]["source"] is None
    with sqlite3.connect(client.app.state.store.path) as con:
        assert con.execute("SELECT count(*) FROM activity_day").fetchone()[0] == 0


def test_values_are_validated(client):
    for body in ({}, {"steps": -1}, {"steps": 300000}, {"active_kcal": -5}, {"active_kcal": 30000}, {"distance_m": 600000},
                 {"steps": "many"}):
        assert client.put(f"/api/v1/activity/{DAY}", json=body).status_code == 422, body
    assert client.put("/api/v1/activity/yesterday", json={"steps": 1}).status_code == 422


def test_list_covers_every_day_oldest_first(client):
    today = date.today()
    put_activity(client, today.isoformat(), steps=4000)
    workout(client, day=(today - timedelta(days=1)).isoformat())
    rows = client.get("/api/v1/activity?days=3").json()
    assert [r["day"] for r in rows] == [(today - timedelta(days=n)).isoformat() for n in (2, 1, 0)]
    assert rows[0]["steps"] is None and rows[0]["workouts"] == []
    assert len(rows[1]["workouts"]) == 1 and rows[2]["steps"] == 4000 and rows[2]["steps_goal"] == 8000
    assert client.get("/api/v1/activity?days=0").status_code == 422
    assert client.get("/api/v1/activity?days=367").status_code == 422


def test_users_do_not_see_each_others_activity(duo):
    ann, ben = duo
    put_activity(ann, steps=9000)
    wid = workout(ann)["id"]
    assert day_of(ben)["activity"]["steps"] is None and day_of(ben)["activity"]["workouts"] == []
    assert ben.patch(f"/api/v1/workouts/{wid}", json={"minutes": 5}).status_code == 404
    assert ben.delete(f"/api/v1/workouts/{wid}").status_code == 404
    assert day_of(ann)["activity"]["workouts"][0]["minutes"] == 30


def test_the_steps_goal_defaults_is_validated_and_kept(client):
    base = {"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70}
    assert client.put("/api/v1/me/goal", json=base).json()["steps"] == 8000
    assert client.put("/api/v1/me/goal", json={**base, "steps": 12000}).json()["steps"] == 12000
    assert day_of(client)["activity"]["steps_goal"] == 12000
    assert client.put("/api/v1/me/goal", json=base).json()["steps"] == 12000  # an older client leaves it alone
    for steps in (999, 50001):
        assert client.put("/api/v1/me/goal", json={**base, "steps": steps}).status_code == 422
    assert client.put("/api/v1/me/goal", json={**base, "steps": 1000}).status_code == 200
    assert client.put("/api/v1/me/goal", json={**base, "steps": 50000}).status_code == 200


# --- workouts ------------------------------------------------------------------------------------------------


def test_workout_crud(client):
    w = workout(client, name="Morning run", kcal=300, distance_m=5000, steps=6000, started_at=1741590000, note="felt good")
    assert w["kind"] == "running" and w["name"] == "Morning run" and w["kcal"] == 300 and w["kcal_estimated"] is False
    assert (w["minutes"], w["distance_m"], w["steps"], w["started_at"], w["note"], w["source"]) == (
        30, 5000, 6000, 1741590000, "felt good", "manual")
    assert day_of(client)["activity"]["workouts"] == [w]
    changed = client.patch(f"/api/v1/workouts/{w['id']}", json={"minutes": 45, "note": None}).json()
    assert changed["minutes"] == 45 and changed["note"] is None and changed["kcal"] == 300 and changed["id"] == w["id"]
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={"kind": "cycling"}).json()["kind"] == "cycling"
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={"day": d(0)}).json()["day"] == d(0)
    assert day_of(client)["activity"]["workouts"] == []
    assert client.delete(f"/api/v1/workouts/{w['id']}").status_code == 204
    assert client.delete(f"/api/v1/workouts/{w['id']}").status_code == 404
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={"minutes": 5}).status_code == 404
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={}).status_code == 404  # unknown beats empty


def test_workout_input_is_validated(client):
    ok = {"day": DAY, "kind": "yoga", "minutes": 20}
    for bad in ({"minutes": 0}, {"minutes": 1441}, {"minutes": -3}, {"kcal": -1}, {"kcal": 30000}, {"distance_m": -1},
                {"day": "soon"}, {"started_at": -5}, {"note": "x" * 501}):
        assert client.post("/api/v1/workouts", json={**ok, **bad}).status_code == 422, bad
    assert client.post("/api/v1/workouts", json={"day": DAY, "minutes": 20}).status_code == 422  # kind is required
    w = workout(client, kind="yoga")
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={}).status_code == 422
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={"minutes": None}).status_code == 422
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={"minutes": 0}).status_code == 422


def test_an_unknown_kind_becomes_other_and_keeps_its_text_as_the_name(client):
    w = workout(client, kind="Tischtennis")
    assert (w["kind"], w["name"]) == ("other", "Tischtennis")
    assert workout(client, kind="stairclimbing")["kind"] == "stairs"
    assert workout(client, kind="other", name="Garden work")["name"] == "Garden work"


def test_kcal_is_estimated_from_met_weight_and_minutes(client):
    client.put("/api/v1/weights/2025-03-01", json={"kg": 80})
    w = workout(client, kind="running", minutes=30)
    assert w["kcal_estimated"] is True and w["kcal"] == pytest.approx(9.8 * 80 * 0.5, abs=0.1)  # 392
    assert workout(client, kind="walking", minutes=60)["kcal"] == pytest.approx(3.5 * 80, abs=0.1)
    given = workout(client, kind="running", minutes=30, kcal=250)
    assert given["kcal"] == 250 and given["kcal_estimated"] is False
    # a later weight is used for days after it, the one before for earlier days
    client.put("/api/v1/weights/2025-03-09", json={"kg": 70})
    assert workout(client, day="2025-03-10")["kcal"] == pytest.approx(9.8 * 70 * 0.5, abs=0.1)
    assert workout(client, day="2025-03-02")["kcal"] == pytest.approx(9.8 * 80 * 0.5, abs=0.1)
    # clearing the kcal goes back to the estimate; changing the minutes re-estimates
    changed = client.patch(f"/api/v1/workouts/{given['id']}", json={"kcal": None, "minutes": 60}).json()
    assert changed["kcal_estimated"] is True and changed["kcal"] == pytest.approx(9.8 * 70 * 1.0, abs=0.1)  # the weight of 2025-03-09 counts on that day


def test_the_estimate_uses_75_kg_without_any_weight(client):
    w = workout(client, kind="cycling", minutes=60)
    assert w["kcal_estimated"] is True and w["kcal"] == pytest.approx(7.5 * 75, abs=0.1)


def test_a_manual_change_makes_the_workout_manual(client):
    sync(client, [{"day": DAY, "workouts": [{"external_id": "h1", "kind": "running", "minutes": 30}]}])
    (w,) = day_of(client)["activity"]["workouts"]
    assert w["source"] == "health"
    assert client.patch(f"/api/v1/workouts/{w['id']}", json={"note": "mine"}).json()["source"] == "manual"


# --- health sync ---------------------------------------------------------------------------------------------

THREE = [
    {"day": d(0), "steps": 9000, "active_kcal": 450.5, "distance_m": 6400, "weight_kg": 80.2, "water_ml": 1500,
     "workouts": [{"external_id": "A1", "kind": "running", "started_at": 1741590000, "minutes": 32, "kcal": 310, "distance_m": 5200}]},
    {"day": d(1), "steps": 4000, "active_kcal": 180},
    {"day": d(2), "steps": 12000, "workouts": [{"external_id": "A2", "name": "Functional Strength Training", "minutes": 40}]},
]
ZERO = {"new": 0, "updated": 0, "unchanged": 0, "skipped": 0}


def test_sync_creates_and_is_idempotent(client):
    first = sync(client, THREE)
    assert first == {
        "days": 3,
        "activity": {**ZERO, "new": 3}, "workouts": {**ZERO, "new": 2}, "weights": {**ZERO, "new": 1},
        "water": {**ZERO, "new": 1}}
    a = day_of(client, d(0))
    assert a["activity"]["steps"] == 9000 and a["activity"]["active_kcal"] == 450.5 and a["activity"]["source"] == "health"
    assert a["activity"]["distance_m"] == 6400 and a["water"]["ml"] == 1500
    (w,) = a["activity"]["workouts"]
    assert (w["kind"], w["minutes"], w["kcal"], w["distance_m"], w["started_at"], w["source"]) == (
        "running", 32, 310, 5200, 1741590000, "health")
    (strength,) = day_of(client, d(2))["activity"]["workouts"]
    assert strength["kind"] == "strength" and strength["name"] == "Functional Strength Training" and strength["kcal_estimated"]
    assert client.get("/api/v1/weights?days=3660").json() == [{"day": d(0), "kg": 80.2}]

    second = sync(client, THREE)
    assert second == {
        "days": 3,
        "activity": {**ZERO, "unchanged": 3}, "workouts": {**ZERO, "unchanged": 2}, "weights": {**ZERO, "unchanged": 1},
        "water": {**ZERO, "unchanged": 1}}
    with sqlite3.connect(client.app.state.store.path) as con:
        assert con.execute("SELECT count(*) FROM workout").fetchone()[0] == 2
        assert con.execute("SELECT count(*) FROM activity_day").fetchone()[0] == 3


def test_sync_overwrites_earlier_health_values_and_workouts(client):
    sync(client, THREE)
    changed = [{**THREE[0], "steps": 9500, "weight_kg": 80.0,
                "workouts": [{"external_id": "A1", "kind": "running", "minutes": 35, "kcal": 330}]}]
    result = sync(client, changed)
    assert result["activity"]["updated"] == 1 and result["weights"]["updated"] == 1 and result["workouts"]["updated"] == 1
    a = day_of(client, d(0))
    assert a["activity"]["steps"] == 9500 and a["activity"]["active_kcal"] == 450.5  # a value left out stays
    assert a["activity"]["workouts"][0]["minutes"] == 35 and a["activity"]["workouts"][0]["kcal"] == 330
    assert len(a["activity"]["workouts"]) == 1  # recognised by the external id, not added again
    assert client.get("/api/v1/weights?days=3660").json() == [{"day": d(0), "kg": 80.0}]


def test_sync_protects_manual_values_unless_told_otherwise(client):
    put_activity(client, d(0), steps=1234)
    workout(client, day=d(0), kind="yoga")  # a manual workout has no external id and does not matter here
    client.put(f"/api/v1/weights/{d(0)}", json={"kg": 79})
    client.put(f"/api/v1/water/{d(0)}", json={"ml": 750})
    result = sync(client, THREE[:1])
    assert result["activity"] == {**ZERO, "skipped": 1} and result["weights"] == {**ZERO, "skipped": 1}
    assert result["water"] == {**ZERO, "skipped": 1} and result["workouts"]["new"] == 1
    a = day_of(client, d(0))
    assert a["activity"]["steps"] == 1234 and a["activity"]["source"] == "manual" and a["water"]["ml"] == 750
    assert client.get("/api/v1/weights?days=3660").json() == [{"day": d(0), "kg": 79}]

    forced = sync(client, THREE[:1], overwrite_manual=True)
    assert forced["activity"]["updated"] == 1
    a = day_of(client, d(0))
    assert a["activity"]["steps"] == 9000 and a["activity"]["source"] == "health"
    assert a["water"]["ml"] == 750  # weight and water are never replaced


def test_sync_does_not_touch_a_workout_the_user_changed(client):
    sync(client, THREE[:1])
    (w,) = day_of(client, d(0))["activity"]["workouts"]
    client.patch(f"/api/v1/workouts/{w['id']}", json={"name": "Parkrun"})
    result = sync(client, [{"day": d(0), "workouts": [{"external_id": "A1", "kind": "running", "minutes": 99}]}])
    assert result["workouts"] == {**ZERO, "skipped": 1}
    (w,) = day_of(client, d(0))["activity"]["workouts"]
    assert w["name"] == "Parkrun" and w["minutes"] == 32
    assert sync(client, [{"day": d(0), "workouts": [{"external_id": "A1", "kind": "running", "minutes": 99}]}],
                overwrite_manual=True)["workouts"]["updated"] == 1


def test_sync_replaces_demo_values_and_imported_ones_but_not_imported_weights(duo):
    ann, _ = duo
    ann.post(DEMO, json={"days": 3})
    today = date.today().isoformat()
    result = sync(ann, [{"day": today, "steps": 111, "weight_kg": 70.0, "water_ml": 500}])
    assert day_of(ann, today)["activity"]["steps"] == 111 and day_of(ann, today)["activity"]["source"] == "health"
    assert result["activity"]["updated"] == 1  # the demo value gave way
    assert ann.get("/api/v1/me").json()["demo"]["activity"] == 2  # the real value is no demo row any more


def test_sync_limits(client):
    assert client.post("/api/v1/health/sync", json={"days": [{"day": d(0), "steps": 1}] * 400}).status_code == 200
    assert client.post("/api/v1/health/sync", json={"days": [{"day": d(0), "steps": 1}] * 401}).status_code == 422
    assert sync(client, []) ["days"] == 0
    for bad in ({"day": "soon"}, {"day": d(0), "steps": -1}, {"day": d(0), "steps": 300000}, {"day": d(0), "active_kcal": 99999},
                {"day": d(0), "weight_kg": 10}, {"day": d(0), "weight_kg": 500}, {"day": d(0), "water_ml": 20000},
                {"day": d(0), "workouts": [{"external_id": "x", "minutes": 10}]},  # neither kind nor name
                {"day": d(0), "workouts": [{"kind": "yoga", "minutes": 10}]},  # no external id
                {"day": d(0), "workouts": [{"external_id": "x", "kind": "yoga", "minutes": 0}]},
                {"day": d(0), "workouts": [{"external_id": "x", "kind": "yoga", "minutes": 10, "kcal": -1}]}):
        assert client.post("/api/v1/health/sync", json={"days": [bad]}).status_code == 422, bad
    assert client.post("/api/v1/health/sync", json={}).status_code == 422
    # a bad day stops the whole call: nothing of it is stored
    assert client.post("/api/v1/health/sync", json={"days": [{"day": d(5), "steps": 5}, {"day": "x"}]}).status_code == 422
    assert day_of(client, d(5))["activity"]["steps"] is None


def test_a_day_that_is_sent_twice_in_one_call_ends_with_the_last_values(client):
    sync(client, [{"day": d(0), "steps": 100}, {"day": d(0), "steps": 200}])
    assert day_of(client, d(0))["activity"]["steps"] == 200


def test_sync_with_access_tokens(client):
    read, write = token(client, "read"), token(client, "write")
    anonymous = TestClient(client.app, headers={"Authorization": "Bearer mw_" + "x" * 43})
    body = {"days": [{"day": d(0), "steps": 100}]}
    assert client.post("/api/v1/health/sync", json=body, headers=bearer(read)).status_code == 403
    assert anonymous.post("/api/v1/health/sync", json=body).status_code == 401
    assert day_of(client, d(0))["activity"]["steps"] is None
    r = client.post("/api/v1/health/sync", json=body, headers=bearer(write))
    assert r.status_code == 200 and r.json()["activity"]["new"] == 1
    assert client.get(f"/api/v1/diary/{d(0)}", headers=bearer(read)).json()["activity"]["steps"] == 100  # reading is fine
    assert client.put(f"/api/v1/activity/{d(0)}", json={"steps": 1}, headers=bearer(read)).status_code == 403
    assert client.post("/api/v1/workouts", json={"day": d(0), "kind": "yoga", "minutes": 5}, headers=bearer(read)).status_code == 403


def test_sync_of_one_user_does_not_reach_another(duo):
    ann, ben = duo
    sync(ann, THREE)
    assert day_of(ben, d(0))["activity"]["steps"] is None and day_of(ben, d(0))["activity"]["workouts"] == []
    sync(ben, [{"day": d(0), "steps": 5, "workouts": [{"external_id": "A1", "kind": "yoga", "minutes": 10}]}])
    assert day_of(ann, d(0))["activity"]["steps"] == 9000 and day_of(ben, d(0))["activity"]["workouts"][0]["kind"] == "yoga"


# --- the kcal goal with active energy ------------------------------------------------------------------------


@pytest.fixture
def dense(client):
    """100 g = 200 kcal, 20 g protein: 500 g is 1000 kcal."""
    return client.post("/api/v1/foods", json={"name": "Dense", "per_100": {"kcal": 200, "protein": 20, "fiber": 10}}).json()


def log(client, food, day, amount=500):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": amount})
    assert r.status_code == 201, r.text


def add_to_goal(client, on: bool):
    r = client.patch("/api/v1/me/settings", json={"activity": {"add_to_goal": on}})
    assert r.status_code == 200, r.text
    return r.json()


def test_the_setting_defaults_to_off_and_is_kept_per_user(duo):
    ann, ben = duo
    assert ann.get("/api/v1/me").json()["settings"]["activity"] == {"add_to_goal": False}
    assert add_to_goal(ann, True)["activity"] == {"add_to_goal": True}
    assert ann.get("/api/v1/me").json()["settings"]["activity"] == {"add_to_goal": True}
    assert ben.get("/api/v1/me").json()["settings"]["activity"] == {"add_to_goal": False}
    assert ann.patch("/api/v1/me/settings", json={"playful": False}).json()["activity"] == {"add_to_goal": True}  # untouched


def test_day_and_summary_goal_with_and_without_active_energy(client, dense):
    client.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70})
    today = date.today().isoformat()
    log(client, dense, today, 500)
    put_activity(client, today, active_kcal=320.4, steps=6000)

    off = day_of(client, today)
    assert off["kcal_goal"] == 2000 and off["goal"]["kcal"] == 2000 and off["activity"]["bonus_kcal"] == 0
    s = client.get("/api/v1/summary/today").json()
    assert (s["kcal_goal"], s["kcal_left"], s["kcal_goal_bonus"]) == (2000, 1000, 0)
    assert (s["steps"], s["steps_goal"], s["active_kcal"], s["workouts"]) == (6000, 8000, 320.4, 0)

    add_to_goal(client, True)
    on = day_of(client, today)
    assert on["kcal_goal"] == 2320 and on["goal"]["kcal"] == 2000 and on["activity"]["bonus_kcal"] == 320
    s = client.get("/api/v1/summary/today").json()
    assert (s["kcal_goal"], s["kcal_left"], s["kcal_goal_bonus"]) == (2320, 1320, 320)

    workout(client, day=today)
    assert client.get("/api/v1/summary/today").json()["workouts"] == 1
    assert day_of(client, d(0))["kcal_goal"] == 2000  # a day without active energy adds nothing
    add_to_goal(client, False)
    assert client.get("/api/v1/summary/today").json()["kcal_goal"] == 2000


def test_day_without_a_goal_has_no_effective_goal(client):
    add_to_goal(client, True)
    put_activity(client, steps=100, active_kcal=300)
    assert day_of(client)["kcal_goal"] is None and day_of(client)["activity"]["bonus_kcal"] == 300
    assert client.get("/api/v1/summary/today").json()["kcal_goal"] is None


def insights(client, **params):
    q = "&".join(f"{k}={v}" for k, v in {"from": d(0), "to": d(6), "granularity": "day", **params}.items())
    r = client.get(f"/api/v1/insights?{q}")
    assert r.status_code == 200, r.text
    return r.json()


def test_insights_adherence_follows_the_effective_goal(client, dense):
    client.put("/api/v1/me/goal", json={"kcal": 1000, "protein": 100, "carbs": 100, "fat": 30})
    for n in range(3):  # 1000 kcal: exactly the goal
        log(client, dense, d(n), 500)
    for n in range(3):
        put_activity(client, d(n), active_kcal=300)
    off = insights(client)
    assert off["adherence"] == {"in_range_days": 3, "over_days": 0, "under_days": 0}
    assert off["goal_kcal"] == 1000 and all(s["goal_kcal"] in (1000, None) for s in off["series"])
    assert [c["state"] for c in off["calendar"][:3]] == ["in_range"] * 3
    assert off["expenditure"] is None

    add_to_goal(client, True)
    on = insights(client)  # the goal is 1300 on those days: 1000 kcal is under (below 90 %: 1170)
    assert on["adherence"] == {"in_range_days": 0, "over_days": 0, "under_days": 3}
    assert on["goal_kcal"] == 1300 and on["goal"]["kcal"] == 1000
    assert [c["state"] for c in on["calendar"][:3]] == ["under"] * 3
    assert [s["under_days"] for s in on["series"][:4]] == [1, 1, 1, 0]
    assert [s["goal_kcal"] for s in on["series"][:4]] == [1300, 1300, 1300, 1000]
    assert [x["goal_kcal"] for x in on["days"][:4]] == [1300, 1300, 1300, 1000]
    # eating the extra brings the days back into range
    for n in range(3):
        log(client, dense, d(n), 150)  # + 300 kcal
    assert insights(client)["adherence"] == {"in_range_days": 3, "over_days": 0, "under_days": 0}
    add_to_goal(client, False)
    assert insights(client)["adherence"] == {"in_range_days": 0, "over_days": 3, "under_days": 0}  # 1300 against 1000


def test_insights_activity_fields(client):
    for n, steps in ((0, 6000), (1, 10000), (3, 8000)):
        put_activity(client, d(n), steps=steps, active_kcal=steps / 20)
    workout(client, day=d(0), minutes=30)
    workout(client, day=d(1), minutes=45)
    workout(client, day=d(8), minutes=99)  # outside the range
    data = insights(client)
    assert data["averages"]["steps"] == 8000 and data["averages"]["active_kcal"] == 400
    assert data["averages"]["workout_minutes"] == pytest.approx(75 / 7, abs=0.1)
    day = {x["day"]: x for x in data["days"]}
    assert (day[d(0)]["steps"], day[d(0)]["active_kcal"], day[d(0)]["workout_minutes"]) == (6000, 300, 30)
    assert day[d(2)]["steps"] is None and day[d(2)]["active_kcal"] is None and day[d(2)]["workout_minutes"] == 0
    s = {x["start"]: x for x in data["series"]}
    assert (s[d(1)]["steps"], s[d(1)]["workout_minutes"]) == (10000, 45) and s[d(2)]["steps"] is None
    weekly = insights(client, granularity="week", to=d(13))
    first = weekly["series"][0]
    assert first["steps"] == 8000 and first["active_kcal"] == 400 and first["workout_minutes"] == 75
    assert weekly["series"][1]["workout_minutes"] == 99 and weekly["series"][1]["steps"] is None
    assert data["steps_goal"] == 8000


def test_insights_compare_has_activity_deltas(client):
    put_activity(client, d(0), steps=6000, active_kcal=300)
    put_activity(client, d(-7), steps=4000, active_kcal=200)
    workout(client, day=d(0), minutes=60)
    workout(client, day=d(-7), minutes=30)
    data = insights(client, to=d(6), compare="previous")
    assert data["previous"]["averages"]["steps"] == 4000
    # no logged day in either period: deltas are null, as before
    assert data["deltas"] is None


def test_insights_deltas_for_activity_when_both_periods_have_entries(client, dense):
    log(client, dense, d(0))
    log(client, dense, d(-7))
    put_activity(client, d(0), steps=6000, active_kcal=300)
    put_activity(client, d(-7), steps=4000, active_kcal=200)
    workout(client, day=d(0), minutes=70)
    workout(client, day=d(-7), minutes=7)
    deltas = insights(client, to=d(6), compare="previous")["deltas"]
    assert deltas["steps"] == {"abs": 2000, "pct": 50} and deltas["active_kcal"] == {"abs": 100, "pct": 50}
    assert deltas["workout_minutes"]["abs"] == 9 and deltas["workout_minutes"]["pct"] == 900


def test_the_expenditure_estimate_ignores_the_setting(client, dense):
    client.put("/api/v1/me/goal", json={"kcal": 1000, "protein": 100, "carbs": 100, "fat": 30})
    start = date(2025, 1, 1)
    for n in range(30):
        day = (start + timedelta(days=n)).isoformat()
        log(client, dense, day, 500)
        client.put(f"/api/v1/weights/{day}", json={"kg": 80 - n * 0.05})
        put_activity(client, day, active_kcal=400)
    q = f"/api/v1/insights?from={start}&to={start + timedelta(days=29)}"
    before = client.get(q).json()["expenditure"]
    add_to_goal(client, True)
    after = client.get(q).json()["expenditure"]
    assert before and after
    assert (after["kcal"], after["low"], after["high"], after["intake"]) == (before["kcal"], before["low"], before["high"], before["intake"])
    assert after["goal_gap"] == before["goal_gap"] + 400  # only the comparison with the goal moves


def test_the_weekly_review_follows_the_effective_goal(client, dense):
    client.put("/api/v1/me/goal", json={"kcal": 1000, "protein": 1000, "carbs": 100, "fat": 30})
    for n in range(5):
        log(client, dense, d(n), 500)
        put_activity(client, d(n), active_kcal=300)
    review = client.get("/api/v1/review?week=2025-W10").json()
    assert [x["state"] for x in review["days"][:5]] == ["in"] * 5 and review["best"]["code"] == "in_range_days"
    add_to_goal(client, True)
    review = client.get("/api/v1/review?week=2025-W10").json()
    assert [x["state"] for x in review["days"][:5]] == ["under"] * 5
    assert review["best"] is None or review["best"]["code"] != "in_range_days"


def test_the_badge_balanced_week_follows_the_effective_goal(client, dense):
    client.put("/api/v1/me/goal", json={"kcal": 1000, "protein": 100, "carbs": 100, "fat": 30})
    for n in range(5):
        log(client, dense, d(n), 650)  # 1300 kcal
        put_activity(client, d(n), active_kcal=300)

    def balanced():
        return {b["code"]: b["progress"] for b in client.get("/api/v1/badges").json()["open"]}.get("balanced_week")

    assert balanced() == {"current": 0, "target": 5}  # 1300 against 1000
    add_to_goal(client, True)
    assert "balanced_week" in {b["code"] for b in client.get("/api/v1/badges").json()["earned"]}  # 1300 against 1300


# --- demo data -----------------------------------------------------------------------------------------------


@pytest.fixture
def demo_client(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_DEMO_DATA", "1")
    return TestClient(create_app(str(tmp_path / "demo.db")))


def test_demo_data_has_steps_energy_and_two_to_four_workouts_a_week_and_goes_away(demo_client):
    c = demo_client
    created = c.post(DEMO, json={"days": 30}).json()
    assert created["activity"] == 30 and created["workouts"] > 0
    rows = c.get("/api/v1/activity?days=30").json()
    assert all(r["steps"] and r["active_kcal"] and r["source"] == "demo" for r in rows)
    assert all(1000 < r["steps"] < 30000 and 50 < r["active_kcal"] < 2500 for r in rows)
    by_week: dict = {}
    for r in rows:
        week = date.fromisoformat(r["day"]).isocalendar()[:2]
        by_week[week] = by_week.get(week, 0) + len(r["workouts"])
    full = [n for week, n in sorted(by_week.items())[1:-1]]  # the first and last week are cut off
    assert full and all(2 <= n <= 4 for n in full), by_week
    kinds = {w["kind"] for r in rows for w in r["workouts"]}
    assert kinds <= set(activity.KINDS) and all(w["source"] == "demo" and w["minutes"] > 0 for r in rows for w in r["workouts"])
    assert c.get("/api/v1/me").json()["demo"]["activity"] == 30
    assert c.get("/api/v1/activity?days=1").json()[0]["workouts"] == []  # today is still young

    again = c.post(DEMO, json={"days": 30}).json()
    assert (again["activity"], again["workouts"]) == (0, 0)  # a repeated call creates nothing twice

    removed = c.delete(DEMO).json()
    assert removed["activity"] == 30 and removed["workouts"] == created["workouts"]
    assert all(r["steps"] is None and r["workouts"] == [] for r in c.get("/api/v1/activity?days=30").json())


def test_real_activity_stays_when_the_demo_data_is_removed(demo_client):
    c = demo_client
    today = date.today().isoformat()
    put_activity(c, today, steps=1234)
    workout(c, day=today)
    c.post(DEMO, json={"days": 7})
    assert day_of(c, today)["activity"]["steps"] == 1234 and len(day_of(c, today)["activity"]["workouts"]) == 1
    c.delete(DEMO)
    assert day_of(c, today)["activity"]["steps"] == 1234 and len(day_of(c, today)["activity"]["workouts"]) == 1

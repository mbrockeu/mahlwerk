"""Goal history: a changed goal counts from the day of the change, earlier days keep the goal they had."""

import io
import json
import sqlite3
import zipfile
from datetime import date, timedelta

import pytest

from conftest import DROP_V19
from mahlwerk import goals
from mahlwerk.db import Store

D1 = date(2026, 3, 2)  # Monday of 2026-W10: goal A is set
D2 = date(2026, 3, 9)  # Monday of 2026-W11: goal B replaces it
A = {"kcal": 1000, "protein": 100, "carbs": 100, "fat": 30, "water_ml": 1500, "steps": 5000}
B = {"kcal": 2000, "protein": 200, "carbs": 200, "fat": 60, "water_ml": 2500, "steps": 10000}


def iso(day: date, offset: int = 0) -> str:
    return (day + timedelta(days=offset)).isoformat()


def set_goal(client, monkeypatch, day: date, goal: dict):
    monkeypatch.setattr("mahlwerk.routes.profile.today", lambda: day)
    r = client.put("/api/v1/me/goal", json=goal)
    assert r.status_code == 200, r.text


@pytest.fixture
def dense(client):
    """500 g = 1000 kcal, 100 g protein."""
    return client.post("/api/v1/foods", json={"name": "Dense", "per_100": {"kcal": 200, "protein": 20}}).json()


@pytest.fixture
def changed(client, monkeypatch, dense):
    """Goal A from D1, goal B from D2; 1000 kcal / 100 g protein on each day of W10 and on D2."""
    set_goal(client, monkeypatch, D1, A)
    for day in [iso(D1, i) for i in range(7)] + [iso(D2)]:
        r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": dense["id"], "meal": "lunch", "amount": 500})
        assert r.status_code == 201, r.text
    set_goal(client, monkeypatch, D2, B)
    return client


# the timeline itself ------------------------------------------------------------------------------------------------


def test_timeline_picks_the_goal_of_the_day():
    tl = goals.Timeline([("2026-03-09", B), (goals.SINCE_START, A)])
    assert tl.on("1999-01-01") is A and tl.on("2026-03-08") is A
    assert tl.on("2026-03-09") is B and tl.on("2030-01-01") is B and tl.current is B
    assert tl.period(["2026-03-08", "2026-03-09"]) == {"kcal": 1500, "protein": 150.0, "carbs": 150.0, "fat": 45.0,
                                                        "water_ml": 2000, "steps": 7500}
    assert tl.period([], "2026-03-01") == A and tl.period([]) == B


def test_days_before_the_first_row_get_the_oldest_goal():
    tl = goals.Timeline([("2026-03-09", B), ("2026-03-02", A)])
    assert tl.on("2020-01-01") is A


def test_a_plain_goal_is_a_goal_that_always_held():
    assert goals.timeline(None) is None
    tl = goals.timeline(A)
    assert tl.on("0001-01-01") is A and tl.on("9999-12-31") is A
    assert goals.timeline(tl) is tl


# storage -------------------------------------------------------------------------------------------------------------


def test_version_18_database_keeps_its_goal_as_the_goal_since_the_start(tmp_path):
    path = str(tmp_path / "v18.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V19 + """
        INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'a', 'A', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps) VALUES (1, 2150, 120, 230, 70, NULL, 9000);
        PRAGMA user_version = 18;
    """)
    con.commit()
    con.close()
    store = Store(path)
    assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone()[0] == 20
    goal = {"kcal": 2150, "protein": 120, "carbs": 230, "fat": 70, "water_ml": 2000, "steps": 9000}
    assert store.get_goal(1) == goal
    assert store.goal_history(1) == [{"valid_from": goals.SINCE_START, "changed_at": None, **goal}]
    assert store.goal_on(1, "2020-01-01") == goal
    Store(path)  # a second start changes nothing
    assert len(store.goal_history(1)) == 1


def test_saving_records_the_day_and_the_same_day_overwrites(tmp_path):
    store = Store(str(tmp_path / "s.db"))
    uid = store.get_or_create_user("a", "A")["id"]
    assert store.goal_history(uid) == [] and store.goal_timeline(uid) is None
    store.set_goal(uid, A, valid_from=iso(D1))
    store.set_goal(uid, B, valid_from=iso(D2))
    store.set_goal(uid, {**B, "kcal": 1800}, valid_from=iso(D2))
    history = store.goal_history(uid)
    assert [(h["valid_from"], h["kcal"]) for h in history] == [(iso(D2), 1800), (iso(D1), 1000)]
    assert all(isinstance(h["changed_at"], int) for h in history)
    assert store.get_goal(uid)["kcal"] == 1800
    assert store.goal_on(uid, iso(D2, -1))["kcal"] == 1000


def test_import_goal_counts_since_the_start_and_goes_with_the_import(tmp_path):
    store = Store(str(tmp_path / "i.db"))
    uid = store.get_or_create_user("a", "A")["id"]
    plan = {"entries": [], "foods": {}, "all_products": False, "weights": [], "water": [],
            "goal": {"kcal": 1900, "protein": 110, "carbs": 200, "fat": 60, "water_ml": 2200, "steps": None}}
    batch = store.import_yazio(uid, plan)["batch_id"]
    assert [(h["valid_from"], h["kcal"], h["steps"]) for h in store.goal_history(uid)] == [(goals.SINCE_START, 1900, 8000)]
    assert store.remove_import(batch, uid)["goal"] is True
    assert store.get_goal(uid) is None and store.goal_history(uid) == []
    with sqlite3.connect(store.path) as con:
        assert con.execute("SELECT count(*) FROM goal_history").fetchone()[0] == 0


def test_a_changed_import_goal_stays_with_its_history(tmp_path):
    store = Store(str(tmp_path / "i.db"))
    uid = store.get_or_create_user("a", "A")["id"]
    plan = {"entries": [], "foods": {}, "all_products": False, "weights": [], "water": [],
            "goal": {"kcal": 1900, "protein": 110, "carbs": 200, "fat": 60, "water_ml": 2200}}
    batch = store.import_yazio(uid, plan)["batch_id"]
    store.set_goal(uid, A, valid_from=iso(D1))
    assert store.remove_import(batch, uid)["goal"] is False
    assert [h["valid_from"] for h in store.goal_history(uid)] == [iso(D1), goals.SINCE_START]


def test_erasing_a_user_removes_the_history(tmp_path):
    store = Store(str(tmp_path / "e.db"))
    uid = store.get_or_create_user("a", "A")["id"]
    store.set_goal(uid, A, valid_from=iso(D1))
    store.erase_user_data(uid)
    assert store.goal_history(uid) == []
    with sqlite3.connect(store.path) as con:
        assert con.execute("SELECT count(*) FROM goal_history").fetchone()[0] == 0


# the API -------------------------------------------------------------------------------------------------------------


def test_history_endpoint_newest_first(changed, monkeypatch):
    set_goal(changed, monkeypatch, D2, {**B, "kcal": 1800})  # the same day again: overwrites
    data = changed.get("/api/v1/me/goal/history").json()
    assert [(h["valid_from"], h["kcal"]) for h in data] == [(iso(D2), 1800), (iso(D1), 1000)]
    assert changed.get("/api/v1/me").json()["goal"]["kcal"] == 1800


def test_insights_judge_each_day_against_its_own_goal(changed):
    data = changed.get(f"/api/v1/insights?from={iso(D1)}&to={iso(D2)}&granularity=day&compare=previous").json()
    assert [c["state"] for c in data["calendar"]] == ["in_range"] * 7 + ["under"]
    assert data["adherence"] == {"in_range_days": 7, "over_days": 0, "under_days": 1}
    assert [d["goal_kcal"] for d in data["days"]] == [1000] * 7 + [2000]
    assert [s["goal_kcal"] for s in data["series"]] == [1000] * 7 + [2000]
    assert data["goal"]["kcal"] == 2000  # the current goal
    assert data["period_goal"]["kcal"] == 1125 and data["period_goal"]["protein"] == 112.5
    assert data["goal_kcal"] == 1125
    assert data["steps_goal"] == 5625
    week = changed.get(f"/api/v1/insights?from={iso(D1)}&to={iso(D1, 6)}").json()
    assert week["period_goal"]["kcal"] == 1000 and week["adherence"]["in_range_days"] == 7
    assert not any(h["code"] == "low_protein" for h in week["hints"])
    nutrient = changed.get(f"/api/v1/insights/nutrient?key=protein&from={iso(D1)}&to={iso(D1, 6)}").json()
    assert nutrient["goal"] == 100


def test_a_half_kcal_mean_is_not_taken_for_active_energy(client, monkeypatch, dense):
    """3 days at 2150 and 1 at 1800: the mean 2062.5 must round the same way in period_goal and goal_kcal."""
    set_goal(client, monkeypatch, D1, {**A, "kcal": 2150})
    for i in range(4):
        client.post(f"/api/v1/diary/{iso(D1, i)}/entries", json={"food_id": dense["id"], "meal": "lunch", "amount": 500})
    set_goal(client, monkeypatch, D1 + timedelta(days=3), {**A, "kcal": 1800})
    data = client.get(f"/api/v1/insights?from={iso(D1)}&to={iso(D1, 3)}").json()
    assert data["period_goal"]["kcal"] == data["goal_kcal"] == 2062.5


def test_review_of_the_week_before_the_change_uses_the_old_goal(changed):
    data = changed.get("/api/v1/review?week=2026-W10").json()
    assert [d["state"] for d in data["days"]] == ["in"] * 7
    assert data["improve"] is None or data["improve"]["code"] != "low_protein"
    after = changed.get("/api/v1/review?week=2026-W11").json()
    assert after["days"][0]["state"] == "under"


def test_badges_count_days_against_the_goal_they_had(changed):
    earned = {b["code"] for b in changed.get("/api/v1/badges").json()["earned"]}
    assert {"balanced_week", "protein_week"} <= earned


def test_day_view_water_steps_and_suggestions_of_a_past_day(changed):
    before = changed.get(f"/api/v1/diary/{iso(D2, -1)}").json()
    assert before["goal"]["kcal"] == 1000 and before["kcal_goal"] == 1000
    assert before["water"]["goal_ml"] == 1500 and before["activity"]["steps_goal"] == 5000
    after = changed.get(f"/api/v1/diary/{iso(D2)}").json()
    assert after["goal"]["kcal"] == 2000 and after["kcal_goal"] == 2000 and after["water"]["goal_ml"] == 2500
    assert changed.put(f"/api/v1/water/{iso(D1)}", json={"ml": 500}).json()["goal_ml"] == 1500
    assert changed.put(f"/api/v1/activity/{iso(D1)}", json={"steps": 4000}).json()["steps_goal"] == 5000
    assert changed.get(f"/api/v1/recipes/suggestions?date={iso(D1)}").json()["goal_kcal"] == 1000
    assert changed.get(f"/api/v1/recipes/suggestions?date={iso(D2)}").json()["goal_kcal"] == 2000


def test_summary_today_uses_todays_goal(changed, monkeypatch):
    monkeypatch.setattr("mahlwerk.routes.summary.today", lambda: D2 - timedelta(days=1))
    assert changed.get("/api/v1/summary/today").json()["kcal_goal"] == 1000
    monkeypatch.setattr("mahlwerk.routes.summary.today", lambda: D2)
    assert changed.get("/api/v1/summary/today").json()["kcal_goal"] == 2000


def test_export_holds_the_history_oldest_first(changed):
    r = changed.get("/api/v1/me/export")
    assert r.status_code == 200, r.text
    with zipfile.ZipFile(io.BytesIO(r.content)) as archive:
        data = json.loads(archive.read("mahlwerk-export.json"))
    assert [(h["valid_from"], h["kcal"]) for h in data["goal_history"]] == [(iso(D1), 1000), (iso(D2), 2000)]
    assert data["goal"]["kcal"] == 2000


def test_goal_changed_webhook_names_the_first_day(client, monkeypatch):
    sent = []
    monkeypatch.setattr("mahlwerk.routes.profile.emit", lambda request, user, event, data: sent.append((event, data)))
    set_goal(client, monkeypatch, D2, B)
    assert sent == [("goal.changed", {**B, "valid_from": iso(D2)})]

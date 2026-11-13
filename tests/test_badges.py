"""Badges, the playful setting and the keep-what-you-earned rules."""

import sqlite3
from datetime import date, timedelta

import pytest

MON = date(2025, 3, 3)  # a Monday


def d(offset: int) -> str:
    return (MON + timedelta(days=offset)).isoformat()


def make_food(client, name="Dense", **per_100):
    per_100 = per_100 or {"kcal": 200, "protein": 20, "fiber": 10}
    return client.post("/api/v1/foods", json={"name": name, "per_100": per_100}).json()


@pytest.fixture
def dense(client):
    """100 g = 200 kcal, 20 g protein, 10 g fibre: 500 g is 1000 kcal, 100 g protein, 50 g fibre."""
    return make_food(client)


def log(client, food, day, amount=500, meal="lunch"):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text


def goal(client, kcal=1000, protein=100):
    client.put("/api/v1/me/goal", json={"kcal": kcal, "protein": protein, "carbs": 100, "fat": 30})


def badges(client):
    r = client.get("/api/v1/badges")
    assert r.status_code == 200, r.text
    return r.json()


def earned(client):
    return {b["code"] for b in badges(client)["earned"]}


def progress(client, code):
    return next(b["progress"] for b in badges(client)["open"] if b["code"] == code)


def test_nothing_earned_on_an_empty_diary(client):
    data = badges(client)
    assert data["earned"] == [] and data["new"] == []
    assert {b["code"] for b in data["open"]} >= {"first_entry", "streak_3", "protein_week", "weigh_in_4"}
    assert progress(client, "first_entry") == {"current": 0, "target": 1}


def test_first_entry_is_new_until_seen(client, dense):
    log(client, dense, d(0))
    data = badges(client)
    assert [b["code"] for b in data["earned"]] == ["first_entry"]
    assert data["earned"][0]["seen"] is False and data["earned"][0]["earned_at"] > 0
    assert data["new"] == ["first_entry"]


def test_seen_clears_new_and_ignores_unknown_codes(client, dense):
    log(client, dense, d(0))
    badges(client)
    data = client.post("/api/v1/badges/seen", json={"codes": ["first_entry", "nonsense"]}).json()
    assert data["new"] == [] and data["earned"][0]["seen"] is True
    assert badges(client)["new"] == []
    assert client.post("/api/v1/badges/seen", json={}).status_code == 422


def test_streak_badges_and_progress(client, dense):
    for i in range(6):
        log(client, dense, d(i))
    assert {"streak_3"} <= earned(client) and "streak_7" not in earned(client)
    assert progress(client, "streak_7") == {"current": 6, "target": 7}
    log(client, dense, d(6))
    assert "streak_7" in earned(client)
    assert progress(client, "streak_30") == {"current": 7, "target": 30}


def test_a_gap_breaks_the_run_but_the_longest_run_counts(client, dense):
    for i in (0, 1, 2, 4, 5):
        log(client, dense, d(i))
    assert "streak_3" in earned(client)
    assert progress(client, "streak_7") == {"current": 3, "target": 7}


@pytest.mark.parametrize("code,days", [("streak_30", 30), ("streak_100", 100)])
def test_long_streaks(client, dense, code, days):
    entries = [{"food_id": dense["id"], "meal": "lunch", "amount": 100}]
    for i in range(days - 1):
        client.post(f"/api/v1/diary/{d(i)}/entries", json=entries[0])
    assert code not in earned(client)
    assert progress(client, code) == {"current": days - 1, "target": days}
    client.post(f"/api/v1/diary/{d(days - 1)}/entries", json=entries[0])
    assert code in earned(client)


def test_different_foods_count_once(client):
    foods = [make_food(client, f"Food {i}", kcal=100) for i in range(10)]
    for f in foods[:9]:
        log(client, f, d(0), 10)
        log(client, f, d(1), 10)  # the same food again does not count twice
    assert progress(client, "scans_10") == {"current": 9, "target": 10}
    log(client, foods[9], d(0), 10)
    assert "scans_10" in earned(client)
    assert progress(client, "scans_50") == {"current": 10, "target": 50}


def test_fifty_foods(client):
    for i in range(50):
        log(client, make_food(client, f"Food {i}", kcal=10), d(0), 10)
    assert "scans_50" in earned(client)


def test_first_recipe(client, dense):
    assert progress(client, "first_recipe") == {"current": 0, "target": 1}
    r = client.post("/api/v1/recipes", json={"name": "Mix", "portions": 2, "items": [{"food_id": dense["id"], "amount": 100}]})
    assert r.status_code == 201
    assert "first_recipe" in earned(client)


def test_protein_week_needs_five_of_seven_days(client, dense):
    goal(client)
    for i in range(4):
        log(client, dense, d(i))
    assert progress(client, "protein_week") == {"current": 4, "target": 5}
    log(client, dense, d(5))
    assert "protein_week" in earned(client)


def test_protein_week_window_is_seven_days_not_a_calendar_week(client, dense):
    goal(client)
    for i in (3, 4, 5, 6, 7):  # Thursday to Monday
        log(client, dense, d(i))
    assert "protein_week" in earned(client)


def test_protein_week_five_days_spread_over_eight_days_does_not_count(client, dense):
    goal(client)
    for i in (0, 2, 4, 6, 8):
        log(client, dense, d(i))
    assert progress(client, "protein_week") == {"current": 4, "target": 5}


def test_protein_week_just_below_90_percent_does_not_count(client):
    goal(client)
    food = make_food(client, "Lean", kcal=200, protein=20, fiber=10)
    for i in range(5):
        log(client, food, d(i), 449)  # 89.8 g of 100 g
    assert "protein_week" not in earned(client)
    for i in range(5):
        log(client, food, d(i), 1)  # exactly 90 g
    assert "protein_week" in earned(client)


def test_goal_badges_need_a_goal(client, dense):
    for i in range(5):
        log(client, dense, d(i))
    data = badges(client)
    assert {"protein_week", "balanced_week"} <= {b["code"] for b in data["open"]}
    goal(client)
    assert {"protein_week", "balanced_week"} <= earned(client)


def test_balanced_week_uses_the_90_to_110_percent_range(client, dense):
    goal(client)
    for i in range(4):
        log(client, dense, d(i), 550)  # 1100 kcal = 110 %
    log(client, dense, d(4), 551)  # 110.2 %
    assert progress(client, "balanced_week") == {"current": 4, "target": 5}
    log(client, dense, d(5), 450)  # 900 kcal = 90 %, still in range
    assert "balanced_week" in earned(client)


def test_fiber_5_needs_25_g_on_five_days(client):
    fibre = make_food(client, "Bran", kcal=100, fiber=10)
    for i in range(4):
        log(client, fibre, d(i), 250)  # 25 g
    log(client, fibre, d(4), 249)  # 24.9 g
    assert progress(client, "fiber_5") == {"current": 4, "target": 5}
    log(client, fibre, d(4), 1)
    assert "fiber_5" in earned(client)


def put_weight(client, day):
    assert client.put(f"/api/v1/weights/{day}", json={"kg": 70}).status_code == 200


def test_weigh_in_4_needs_four_consecutive_weeks(client):
    for i in (0, 7, 14):
        put_weight(client, d(i))
    assert progress(client, "weigh_in_4") == {"current": 3, "target": 4}
    put_weight(client, d(28))  # a week is missing in between
    assert progress(client, "weigh_in_4") == {"current": 3, "target": 4}
    put_weight(client, d(25))  # Friday of the missing week
    assert "weigh_in_4" in earned(client)


def test_weigh_in_weeks_run_monday_to_sunday(client):
    for i in (6, 7, 13, 14, 20):  # Sun / Mon, Sun / Mon, Sun: weeks 0, 1, 1, 2, 2
        put_weight(client, d(i))
    assert progress(client, "weigh_in_4") == {"current": 3, "target": 4}


def test_weigh_in_across_the_year_boundary(client):
    for day in ("2025-12-15", "2025-12-22", "2025-12-29", "2026-01-05"):
        put_weight(client, day)
    assert "weigh_in_4" in earned(client)


def test_full_day_10_needs_all_three_main_meals(client):
    food = make_food(client, "Bit", kcal=10)
    for i in range(9):
        for meal in ("breakfast", "lunch", "dinner"):
            log(client, food, d(i), 10, meal)
    log(client, food, d(9), 10, "breakfast")
    log(client, food, d(9), 10, "lunch")
    log(client, food, d(9), 10, "snack")  # a snack does not replace dinner
    assert progress(client, "full_day_10") == {"current": 9, "target": 10}
    log(client, food, d(9), 10, "dinner")
    assert "full_day_10" in earned(client)


def test_earned_badges_stay_when_the_entries_go(client, dense):
    log(client, dense, d(0))
    assert "first_entry" in earned(client)
    entry = client.get(f"/api/v1/diary/{d(0)}").json()["meals"]["lunch"]["entries"][0]
    assert client.delete(f"/api/v1/diary/entries/{entry['id']}").status_code == 204
    assert "first_entry" in earned(client)


def test_users_are_separate(duo):
    ann, ben = duo
    food = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 100}}).json()
    log(ann, food, d(0))
    assert earned(ann) == {"first_entry"} and earned(ben) == set()
    assert ben.post("/api/v1/badges/seen", json={"codes": ["first_entry"]}).status_code == 200
    assert badges(ann)["new"] == ["first_entry"]


def test_removing_demo_data_takes_back_demo_only_badges(duo):
    ann, _ = duo
    assert ann.post("/api/v1/me/demo-data", json={"days": 40}).status_code == 200
    assert {"first_entry", "streak_7", "streak_30"} <= earned(ann)
    ann.delete("/api/v1/me/demo-data")
    assert earned(ann) == set() and badges(ann)["new"] == []


def test_removing_demo_data_keeps_what_real_data_earned(duo):
    ann, _ = duo
    food = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 100}}).json()
    log(ann, food, d(0))
    assert earned(ann) == {"first_entry"}  # earned before there was any demo data
    ann.post("/api/v1/me/demo-data", json={"days": 40})
    assert {"first_entry", "streak_30"} <= earned(ann)
    ann.delete("/api/v1/me/demo-data")
    assert earned(ann) == {"first_entry"}


def test_a_badge_first_seen_with_demo_data_is_kept_once_real_data_reaches_it(duo):
    ann, _ = duo
    ann.post("/api/v1/me/demo-data", json={"days": 5})
    assert "first_entry" in earned(ann)  # earned with demo entries only
    food = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 100}}).json()
    log(ann, food, d(0))  # a real entry on a day without demo data
    assert "first_entry" in earned(ann)
    ann.delete("/api/v1/me/demo-data")
    assert earned(ann) == {"first_entry"}


def test_settings_default_and_patch(duo):
    ann, ben = duo
    assert ann.get("/api/v1/me").json()["settings"]["playful"] is True
    assert ann.patch("/api/v1/me/settings", json={"playful": False}).json()["playful"] is False
    assert ann.get("/api/v1/me").json()["settings"]["playful"] is False
    assert ben.get("/api/v1/me").json()["settings"]["playful"] is True
    assert ann.patch("/api/v1/me/settings", json={}).json()["playful"] is False  # nothing to change
    assert ann.patch("/api/v1/me/settings", json={"playful": "maybe"}).status_code == 422
    assert ann.patch("/api/v1/me/settings", json={"playful": True}).json()["playful"] is True


def test_tour_seen_is_remembered_per_user(duo):
    ann, ben = duo
    assert ann.get("/api/v1/me").json()["settings"]["tour_seen"] is False  # new users get the tour
    assert ann.patch("/api/v1/me/settings", json={"tour_seen": True}).json()["tour_seen"] is True
    assert ann.get("/api/v1/me").json()["settings"]["tour_seen"] is True
    assert ben.get("/api/v1/me").json()["settings"]["tour_seen"] is False  # per user, not per server
    assert ann.patch("/api/v1/me/settings", json={"playful": False}).json()["tour_seen"] is True  # other patches keep it
    assert ann.patch("/api/v1/me/settings", json={"tour_seen": False}).json()["tour_seen"] is False  # "show it again"
    assert ann.patch("/api/v1/me/settings", json={"tour_seen": "later"}).status_code == 422


def test_playful_off_gives_empty_lists_and_tracks_nothing(client, dense):
    client.patch("/api/v1/me/settings", json={"playful": False})
    log(client, dense, d(0))
    empty = {"earned": [], "open": [], "new": []}
    assert client.get("/api/v1/badges").json() == empty
    assert client.post("/api/v1/badges/seen", json={"codes": ["first_entry"]}).json() == empty
    path = client.app.state.store.path
    assert sqlite3.connect(path).execute("SELECT count(*) FROM badge_earned").fetchone()[0] == 0
    client.patch("/api/v1/me/settings", json={"playful": True})
    assert earned(client) == {"first_entry"}

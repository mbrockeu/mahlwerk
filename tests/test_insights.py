from datetime import date, timedelta

import pytest

from mahlwerk.insights import adherence_class

# Monday 2025-03-03 .. Sunday 2025-03-09, then 03-10 (Monday) ...
MON = date(2025, 3, 3)


def d(offset: int) -> str:
    return (MON + timedelta(days=offset)).isoformat()


def make_food(client, name="Oats", brand=None, **per_100):
    body = {"name": name, "brand": brand, "per_100": per_100}
    return client.post("/api/v1/foods", json=body).json()


def log(client, food, amount, day, meal="lunch"):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text


def get(client, first, last):
    r = client.get(f"/api/v1/insights?from={first}&to={last}")
    assert r.status_code == 200, r.text
    return r.json()


def hint_codes(data):
    return [h["code"] for h in data["hints"]]


def goal(client, kcal=2000, protein=100):
    client.put("/api/v1/me/goal", json={"kcal": kcal, "protein": protein, "carbs": 250, "fat": 70})


def fill(client, food, amount, days, meal="lunch"):
    """Log `amount` of `food` on each of the day offsets."""
    for i in days:
        log(client, food, amount, d(i), meal)


def test_totals_averages_and_empty_days_do_not_count(client):
    f = make_food(client, kcal=200, protein=10, carbs=30, fat=4, sugars=5, fiber=2, salt=1, saturated_fat=1)
    log(client, f, 100, d(0))
    log(client, f, 300, d(2), "dinner")
    data = get(client, d(0), d(3))
    assert data["range"] == {"from": d(0), "to": d(3), "days": 4, "logged_days": 2}
    assert [x["day"] for x in data["days"]] == [d(0), d(1), d(2), d(3)]
    assert [x["logged"] for x in data["days"]] == [True, False, True, False]
    assert data["days"][2]["kcal"] == 600 and data["days"][2]["fiber"] == 6 and data["days"][1]["kcal"] == 0
    assert data["averages"]["kcal"] == 400 and data["averages"]["protein"] == 20  # (200+600)/2, not /4
    assert data["averages"]["salt"] == 2
    assert data["days"][0]["weight"] is None


def test_by_weekday_uses_logged_days_only(client):
    f = make_food(client, kcal=100)
    log(client, f, 1000, d(0))  # Monday 1000
    log(client, f, 2000, d(7))  # Monday 2000
    log(client, f, 500, d(2))  # Wednesday 500
    data = get(client, d(0), d(13))
    wd = {x["weekday"]: x for x in data["by_weekday"]}
    assert len(data["by_weekday"]) == 7
    assert wd[0] == {"weekday": 0, "logged_days": 2, "kcal": 1500}
    assert wd[2]["kcal"] == 500 and wd[1] == {"weekday": 1, "logged_days": 0, "kcal": 0}


def test_by_meal_mean_per_logged_day_and_shares(client):
    f = make_food(client, kcal=100)
    log(client, f, 400, d(0), "breakfast")
    log(client, f, 600, d(0), "dinner")
    log(client, f, 200, d(1), "breakfast")
    log(client, f, 200, d(1), "dinner")  # day 1: 200 + 200
    data = get(client, d(0), d(5))  # 2 logged days
    meals = {m["meal"]: m for m in data["by_meal"]}
    assert [m["meal"] for m in data["by_meal"]] == ["breakfast", "lunch", "dinner", "snack"]
    assert meals["breakfast"]["kcal"] == 300 and meals["dinner"]["kcal"] == 400
    assert meals["lunch"] == {"meal": "lunch", "kcal": 0, "share": 0}
    assert meals["breakfast"]["share"] == pytest.approx(300 / 700, abs=0.001)
    assert sum(m["share"] for m in data["by_meal"]) == pytest.approx(1, abs=0.002)


def test_top_foods_group_by_food_and_shares(client):
    a = make_food(client, "Apple", "Farm", kcal=50, sugars=10)
    b = make_food(client, "Bread", None, kcal=250, sugars=2, salt=1.2)
    log(client, a, 100, d(0))
    log(client, a, 200, d(1))
    log(client, b, 100, d(1))
    data = get(client, d(0), d(1))
    kcal = data["top_foods"]["kcal"]
    assert [x["name"] for x in kcal] == ["Bread", "Apple"]  # 250 vs 150
    assert kcal[1] == {"name": "Apple", "brand": "Farm", "amount_total": 300, "value": 150, "share": 0.375, "times": 2}
    assert kcal[0]["share"] == 0.625
    sugars = data["top_foods"]["sugars"]
    assert sugars[0]["name"] == "Apple" and sugars[0]["value"] == 30 and sugars[0]["share"] == pytest.approx(30 / 32, abs=0.001)
    assert [x["name"] for x in data["top_foods"]["salt"]] == ["Bread"]  # foods without salt are left out
    assert data["top_foods"]["protein"] == []


def test_top_foods_limited_to_eight_and_deleted_food_still_groups_by_name(client):
    for i in range(10):
        f = make_food(client, f"Food {i}", kcal=100 + i)
        log(client, f, 100, d(0))
    data = get(client, d(0), d(0))
    assert len(data["top_foods"]["kcal"]) == 8 and data["top_foods"]["kcal"][0]["name"] == "Food 9"
    # after the food is deleted the entries keep name and brand and are grouped by those
    f = make_food(client, "Gone", "Brand", kcal=300)
    log(client, f, 100, d(1))
    log(client, f, 100, d(2))
    client.delete(f"/api/v1/foods/{f['id']}")
    gone = [x for x in get(client, d(1), d(2))["top_foods"]["kcal"] if x["name"] == "Gone"]
    assert len(gone) == 1 and gone[0]["times"] == 2 and gone[0]["value"] == 600


def test_weight_trend_is_centred_seven_day_mean(client):
    for offset, kg in ((0, 80.0), (1, 82.0), (3, 78.0), (10, 70.0)):
        assert client.put(f"/api/v1/weights/{d(offset)}", json={"kg": kg}).status_code == 200
    data = get(client, d(0), d(12))
    w = data["weight"]
    assert (w["first"], w["last"], w["change"]) == (80.0, 70.0, -10.0)
    trend = {p["day"]: p["kg"] for p in w["trend"]}
    assert trend[d(0)] == 80.0  # 0, 1, 3 all within 3 days: (80+82+78)/3
    assert trend[d(1)] == 80.0
    assert trend[d(3)] == 80.0
    assert trend[d(10)] == 70.0
    assert [x["weight"] for x in data["days"]][:2] == [80.0, 82.0]


def test_weight_null_without_values_and_range_limits_values(client):
    client.put(f"/api/v1/weights/{d(-5)}", json={"kg": 90})
    assert get(client, d(0), d(2))["weight"] is None


@pytest.mark.parametrize(
    "kcal,expected",
    [(1799.9, "under"), (1800, "in"), (2200, "in"), (2200.1, "over"), (2000, "in")],
)
def test_adherence_class_boundaries(kcal, expected):
    assert adherence_class(kcal, 2000) == expected


def test_adherence_counts_exact_limits_through_the_api(client):
    goal(client, 2000)
    f = make_food(client, kcal=100)
    log(client, f, 1800, d(0))  # exactly 90 %
    log(client, f, 2200, d(1))  # exactly 110 %
    log(client, f, 1790, d(2))  # under
    log(client, f, 2210, d(3))  # over
    log(client, f, 100, d(4))  # nearly empty: under
    data = get(client, d(0), d(6))
    assert data["adherence"] == {"in_range_days": 2, "over_days": 1, "under_days": 2}


def test_adherence_null_without_goal(client):
    f = make_food(client, kcal=100)
    log(client, f, 100, d(0))
    data = get(client, d(0), d(0))
    assert data["adherence"] is None and data["goal"] is None
    goal(client)
    assert get(client, d(0), d(0))["goal"]["kcal"] == 2000


# hints ---------------------------------------------------------------------------------------------------------

WEEK = range(7)


def base_food(client, name="Base", **over):
    """A food that triggers no rule: plenty of fibre and protein, little sugar and salt."""
    per = dict(kcal=100, protein=10, fiber=10, sugars=1, salt=0.1)
    per.update(over)
    return make_food(client, name, **per)


def test_few_days_gives_a_single_hint(client):
    goal(client)
    f = base_food(client, fiber=0, sugars=100)  # would trigger rules, but there are only 6 days
    fill(client, f, 100, range(6))
    data = get(client, d(0), d(13))
    assert data["hints"] == [{"code": "few_days", "params": {"logged_days": 6, "min": 7}}]
    fill(client, f, 100, [6])
    assert "few_days" not in hint_codes(get(client, d(0), d(13)))


def test_empty_range_does_not_crash(client):
    data = get(client, d(0), d(5))
    assert data["range"]["logged_days"] == 0 and data["averages"]["kcal"] == 0
    assert data["by_meal"][0] == {"meal": "breakfast", "kcal": 0, "share": 0}
    assert data["top_foods"] == {"kcal": [], "sugars": [], "salt": [], "protein": []}
    assert data["weight"] is None and data["adherence"] is None
    assert hint_codes(data) == ["few_days"]
    assert all(not x["logged"] for x in data["days"])


def test_low_fiber_with_top_foods(client):
    big = make_food(client, "Beans", kcal=100, fiber=10)
    small = make_food(client, "Bread", kcal=100, fiber=3)
    tiny = make_food(client, "Rice", kcal=100, fiber=1)
    for i in WEEK:
        log(client, big, 100, d(i))  # 10 g
        log(client, small, 100, d(i))  # 3 g
        log(client, tiny, 100, d(i))  # 1 g
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "low_fiber")
    assert h["params"] == {"avg": 14, "top": ["Beans", "Bread"]}


def test_low_fiber_boundary(client):
    f = make_food(client, kcal=100, fiber=25)
    fill(client, f, 100, WEEK)
    assert "low_fiber" not in hint_codes(get(client, d(0), d(6)))  # exactly 25 g: no hint
    g = make_food(client, "Low", kcal=100, fiber=24.9)
    fill(client, g, 100, range(7, 14))
    assert "low_fiber" in hint_codes(get(client, d(7), d(13)))


def test_low_protein_needs_goal_and_threshold(client):
    f = base_food(client, protein=10)
    fill(client, f, 790, WEEK)  # 79 g, goal 100 -> 79 %
    assert "low_protein" not in hint_codes(get(client, d(0), d(6)))  # no goal
    goal(client, 2000, 100)
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "low_protein")
    assert h["params"] == {"avg": 79, "goal": 100, "pct": 79}
    g = base_food(client, "More", protein=10)
    fill(client, g, 800, range(7, 14))  # exactly 80 %
    assert "low_protein" not in hint_codes(get(client, d(7), d(13)))


def test_high_sugar_names_biggest_supplier(client):
    sweet = make_food(client, "Cola", kcal=40, sugars=11, fiber=100)
    other = make_food(client, "Cake", kcal=300, sugars=30, fiber=100)
    for i in WEEK:
        log(client, sweet, 500, d(i))  # 55 g
        log(client, other, 100, d(i))  # 30 g
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "high_sugar")
    assert h["params"] == {"avg": 85, "top": "Cola"}


def test_high_sugar_boundary(client):
    f = make_food(client, kcal=100, sugars=10, fiber=100)
    fill(client, f, 500, WEEK)  # exactly 50 g
    assert "high_sugar" not in hint_codes(get(client, d(0), d(6)))


def test_high_salt_and_boundary(client):
    f = make_food(client, kcal=100, salt=6, fiber=100)
    fill(client, f, 100, WEEK)  # exactly 6 g
    assert "high_salt" not in hint_codes(get(client, d(0), d(6)))
    g = make_food(client, "Salty", kcal=100, salt=6.5, fiber=100)
    fill(client, g, 100, range(7, 14))
    h = next(h for h in get(client, d(7), d(13))["hints"] if h["code"] == "high_salt")
    assert h["params"] == {"avg": 6.5}


def test_weekend_higher(client):
    f = base_food(client, fiber=100)
    for i in (0, 1, 2, 3, 4):
        log(client, f, 1000, d(i))  # Mon-Fri 1000 kcal
    for i in (5, 6):
        log(client, f, 1200, d(i))  # Sat/Sun 1200 = +20 %
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "weekend_higher")
    assert h["params"] == {"weekend": 1200, "weekday": 1000, "pct": 20}


def test_weekend_not_higher_at_exactly_15_percent(client):
    f = base_food(client, fiber=100)
    for i in (0, 1, 2, 3, 4):
        log(client, f, 1000, d(i))
    for i in (5, 6):
        log(client, f, 1150, d(i))  # exactly +15 %
    assert "weekend_higher" not in hint_codes(get(client, d(0), d(6)))


def meals(client, f, breakfast, lunch, dinner):
    for i in WEEK:
        log(client, f, breakfast, d(i), "breakfast")
        log(client, f, lunch, d(i), "lunch")
        log(client, f, dinner, d(i), "dinner")


def test_meal_dominant(client):
    f = base_food(client, kcal=100, fiber=100)
    meals(client, f, 270, 270, 460)  # dinner 46 %
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "meal_dominant")
    assert h["params"] == {"meal": "dinner", "pct": 46, "kcal": 460}


def test_meal_not_dominant_at_exactly_45_percent(client):
    f = base_food(client, kcal=100, fiber=100)
    meals(client, f, 275, 275, 450)
    assert "meal_dominant" not in hint_codes(get(client, d(0), d(6)))


def test_protein_goal_met_positive_hint(client):
    goal(client, 2000, 100)
    f = base_food(client, kcal=100, protein=10, fiber=100)
    fill(client, f, 1000, range(5))  # 100 g on 5 days
    fill(client, f, 900, range(5, 7))  # 90 g on 2 days -> 5 / 7 = 71 %
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "protein_goal_met")
    assert h["params"] == {"days": 5, "of": 7, "pct": 71}


def test_protein_goal_not_met_below_70_percent(client):
    goal(client, 2000, 100)
    f = base_food(client, kcal=100, protein=10, fiber=100)
    fill(client, f, 1000, range(4))  # 4 / 7 = 57 %
    fill(client, f, 900, range(4, 7))
    assert "protein_goal_met" not in hint_codes(get(client, d(0), d(6)))


def test_in_range_positive_hint_and_threshold(client):
    goal(client, 2000)
    f = base_food(client, kcal=100, fiber=100)
    fill(client, f, 2000, range(5))
    fill(client, f, 1000, range(5, 7))  # 5 of 7 in range = 71 %
    h = next(h for h in get(client, d(0), d(6))["hints"] if h["code"] == "in_range")
    assert h["params"] == {"days": 5, "of": 7, "pct": 71}
    g = base_food(client, "Other", kcal=100, fiber=100)
    fill(client, g, 2000, range(7, 11))  # 4 of 7 = 57 %
    fill(client, g, 1000, range(11, 14))
    assert "in_range" not in hint_codes(get(client, d(7), d(13)))


def test_at_most_four_hints_most_important_first(client):
    goal(client, 2000, 100)
    f = make_food(client, "Junk", kcal=100, protein=1, fiber=0, sugars=20, salt=2)
    for i in WEEK:
        log(client, f, 500, d(i), "breakfast")
        log(client, f, 500, d(i), "dinner")
        log(client, f, 3000, d(i), "dinner")
    codes = hint_codes(get(client, d(0), d(6)))
    assert len(codes) == 4
    assert codes[:4] == ["low_protein", "low_fiber", "high_sugar", "high_salt"]


# validation, boundaries, users -------------------------------------------------------------------------------


def test_range_boundaries_are_inclusive_and_outside_entries_ignored(client):
    f = make_food(client, kcal=100)
    log(client, f, 100, d(-1))
    log(client, f, 200, d(0))
    log(client, f, 300, d(2))
    log(client, f, 400, d(3))
    data = get(client, d(0), d(2))
    assert [x["kcal"] for x in data["days"]] == [200, 0, 300]
    assert data["range"]["logged_days"] == 2


def test_single_day_range(client):
    f = make_food(client, kcal=100)
    log(client, f, 100, d(0))
    data = get(client, d(0), d(0))
    assert data["range"]["days"] == 1 and len(data["days"]) == 1


def test_validation(client):
    assert client.get(f"/api/v1/insights?from={d(5)}&to={d(0)}").status_code == 422
    assert client.get("/api/v1/insights?from=2025-13-01&to=2025-03-01").status_code == 422
    assert client.get("/api/v1/insights?from=nonsense").status_code == 422
    first = date(2024, 1, 1)
    ok = client.get(f"/api/v1/insights?from={first}&to={first + timedelta(days=3659)}")
    assert ok.status_code == 200 and ok.json()["range"]["days"] == 3660
    too_long = client.get(f"/api/v1/insights?from={first}&to={first + timedelta(days=3660)}")
    assert too_long.status_code == 422


def test_default_is_last_30_days_ending_today(client):
    data = client.get("/api/v1/insights").json()
    assert data["range"]["days"] == 30 and data["range"]["to"] == date.today().isoformat()
    assert data["range"]["from"] == (date.today() - timedelta(days=29)).isoformat()


def test_users_are_separated(make_client, monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    import httpx
    from fastapi.testclient import TestClient

    from mahlwerk.main import create_app

    app = create_app(str(tmp_path / "multi.db"), transport=httpx.MockTransport(lambda r: httpx.Response(404)))
    ann = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ann"})
    bob = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "bob"})
    f = make_food(ann, kcal=100)
    log(ann, f, 500, d(0))
    ann.put(f"/api/v1/weights/{d(0)}", json={"kg": 70})
    mine = get(ann, d(0), d(1))
    theirs = get(bob, d(0), d(1))
    assert mine["averages"]["kcal"] == 500 and mine["weight"] is not None
    assert theirs["range"]["logged_days"] == 0 and theirs["weight"] is None
    assert theirs["top_foods"]["kcal"] == []


def test_requires_authentication(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from mahlwerk.main import create_app

    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    stranger = TestClient(create_app(str(tmp_path / "a.db")), client=("203.0.113.9", 1))
    assert stranger.get("/api/v1/insights").status_code == 401

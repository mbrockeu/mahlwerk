"""Weekly review: one strength, at most one thing to improve."""

from datetime import date, timedelta

import pytest

MON = date(2025, 3, 3)  # Monday of 2025-W10


def d(offset: int) -> str:
    return (MON + timedelta(days=offset)).isoformat()


def make_food(client, name, **per_100):
    return client.post("/api/v1/foods", json={"name": name, "per_100": per_100}).json()


@pytest.fixture
def dense(client):
    """500 g = 1000 kcal, 100 g protein, 50 g fibre."""
    return make_food(client, "Dense", kcal=200, protein=20, fiber=10)


@pytest.fixture
def plain(client):
    """1000 g = 1000 kcal, 10 g protein, 5 g fibre."""
    return make_food(client, "Plain", kcal=100, protein=1, fiber=0.5)


@pytest.fixture(autouse=True)
def goal(client):
    client.put("/api/v1/me/goal", json={"kcal": 1000, "protein": 100, "carbs": 100, "fat": 30})


def log(client, food, offset, amount=500):
    r = client.post(f"/api/v1/diary/{d(offset)}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": amount})
    assert r.status_code == 201, r.text


def review(client, week="2025-W10"):
    r = client.get(f"/api/v1/review?week={week}")
    assert r.status_code == 200, r.text
    return r.json()


def codes(data):
    return (data["best"] and data["best"]["code"], data["improve"] and data["improve"]["code"])


def test_shape_and_week_range(client, dense):
    log(client, dense, 0)
    log(client, dense, 2, 450)
    data = review(client)
    assert (data["week"], data["from"], data["to"]) == ("2025-W10", d(0), d(6))
    assert data["logged_days"] == 2 and data["kcal_avg"] == 950
    assert data["goal"]["kcal"] == 1000
    assert [x["state"] for x in data["days"]] == ["in", None, "in", None, None, None, None]
    assert [x["logged"] for x in data["days"]] == [True, False, True, False, False, False, False]
    assert data["days"][0]["day"] == d(0) and data["days"][6]["day"] == d(6)


def test_default_is_the_last_completed_week(client, dense, monkeypatch):
    log(client, dense, 0)
    log(client, dense, 1)
    for today in (d(7), d(9), d(13)):  # Monday to Sunday of the following week
        monkeypatch.setattr("mahlwerk.routes.insights.today", lambda today=today: date.fromisoformat(today))
        data = client.get("/api/v1/review").json()
        assert data["week"] == "2025-W10" and data["logged_days"] == 2


def test_week_boundaries_are_monday_to_sunday(client, dense):
    log(client, dense, -1)  # Sunday before
    log(client, dense, 0)  # Monday
    log(client, dense, 6)  # Sunday
    log(client, dense, 7)  # Monday after
    assert review(client)["logged_days"] == 2
    assert review(client, "2025-W11")["logged_days"] == 1


def test_iso_week_across_the_year_boundary(client, dense):
    for day in ("2025-12-28", "2025-12-29", "2025-12-31", "2026-01-01", "2026-01-04", "2026-01-05"):
        r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": dense["id"], "meal": "lunch", "amount": 500})
        assert r.status_code == 201
    data = review(client, "2026-W01")
    assert (data["from"], data["to"], data["logged_days"]) == ("2025-12-29", "2026-01-04", 4)
    assert review(client, "2025-W52")["logged_days"] == 1
    assert review(client, "2026-W02")["logged_days"] == 1
    assert review(client, "2020-W53")["from"] == "2020-12-28"  # a 53-week year


@pytest.mark.parametrize("week", ["2025-10", "2025-W5", "2025-W00", "2025-W54", "2025-W53", "abc", "2025-w10", "2025-W10x"])
def test_invalid_week_is_422(client, week):
    assert client.get(f"/api/v1/review?week={week}").status_code == 422


def test_quiet_week(client, dense):
    data = review(client)
    assert data["logged_days"] == 0 and data["best"] is None and data["improve"] is None
    assert "quiet_week" in data["badges"]
    log(client, dense, 0)
    data = review(client)
    assert data["logged_days"] == 1 and data["best"] is None and data["improve"] is None and "quiet_week" in data["badges"]
    log(client, dense, 1)
    data = review(client)
    assert "quiet_week" not in data["badges"] and data["improve"]["code"] == "few_days"


def test_best_all_seven_days(client, plain):
    for i in range(7):
        log(client, plain, i, 1000)
    assert review(client)["best"] == {"code": "all_days", "params": {"days": 7}}


def test_best_in_range_days(client, plain):
    for i in range(5):
        log(client, plain, i, 1000)
    data = review(client)
    assert data["best"] == {"code": "in_range_days", "params": {"days": 5, "of": 5}}
    assert data["improve"]["code"] == "low_protein"


def test_best_in_range_days_just_short(client, plain):
    for i in range(4):
        log(client, plain, i, 1000)
    log(client, plain, 4, 1111)  # 111 %
    assert codes(review(client))[0] is None


def test_best_protein_days(client):
    lean = make_food(client, "Lean", kcal=100, protein=20)
    for i in range(5):
        log(client, lean, i, 500)  # 500 kcal (under), 100 g protein
    data = review(client)
    assert data["best"] == {"code": "protein_days", "params": {"days": 5, "of": 5}}
    assert data["improve"]["code"] == "low_fiber"


def test_best_fiber_average(client):
    bran = make_food(client, "Bran", kcal=50, protein=1, fiber=10)
    for i in range(4):
        log(client, bran, i, 400)  # 200 kcal, 40 g fibre
    data = review(client)
    assert data["best"] == {"code": "fiber_avg", "params": {"avg": 40}}
    assert data["improve"]["code"] == "low_protein"


def test_best_more_days_than_the_week_before(client, plain):
    for i in (-7, -6):
        log(client, plain, i, 500)
    for i in range(3):
        log(client, plain, i, 500)
    assert review(client)["best"] == {"code": "more_days", "params": {"days": 3, "before": 2}}
    assert review(client, "2025-W09")["best"] is None  # 2 days, nothing before


def test_no_best_when_nothing_stands_out(client, plain):
    for i in (-7, -6, -5):
        log(client, plain, i, 500)
    for i in range(3):
        log(client, plain, i, 500)
    data = review(client)
    assert data["best"] is None and data["improve"]["code"] == "few_days"


def test_first_match_wins_in_the_documented_order(client, dense):
    for i in range(7):
        log(client, dense, i)  # all days, in range, protein days and fibre all apply
    assert review(client)["best"]["code"] == "all_days"
    data = review(client)
    assert data["improve"] is None  # nothing to improve


def test_improve_few_days(client, dense):
    for i in range(3):
        log(client, dense, i)
    assert review(client)["improve"] == {"code": "few_days", "params": {"days": 3}}


def test_improve_low_protein(client, plain):
    for i in range(4):
        log(client, plain, i, 1000)  # 10 g protein of 100
    data = review(client)
    assert data["improve"] == {"code": "low_protein", "params": {"avg": 10, "goal": 100, "pct": 10}}


def test_improve_low_protein_boundary(client):
    food = make_food(client, "Edge", kcal=100, protein=10, fiber=10)
    for i in range(4):
        log(client, food, i, 800)  # exactly 80 g: not below 80 %
    assert review(client)["improve"] is None


def test_improve_low_fiber(client):
    lean = make_food(client, "Lean", kcal=100, protein=20)
    for i in range(4):
        log(client, lean, i, 500)
    assert review(client)["improve"] == {"code": "low_fiber", "params": {"avg": 0}}


def test_improve_weekend_higher(client, dense):
    for i in (0, 1, 2):
        log(client, dense, i, 500)  # 1000 kcal
    for i in (5, 6):
        log(client, dense, i, 650)  # 1300 kcal
    assert review(client)["improve"] == {"code": "weekend_higher", "params": {"weekend": 1300, "weekday": 1000, "pct": 30}}


def test_weekend_exactly_20_percent_is_fine(client, dense):
    for i in (0, 1, 2):
        log(client, dense, i, 500)
    for i in (5, 6):
        log(client, dense, i, 600)
    assert review(client)["improve"] is None


def test_review_without_goal(duo):
    ann, _ = duo
    food = ann.post("/api/v1/foods", json={"name": "X", "per_100": {"kcal": 100, "protein": 1, "fiber": 20}}).json()
    for i in range(7):
        ann.post(f"/api/v1/diary/{d(i)}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    data = ann.get("/api/v1/review?week=2025-W10").json()
    assert data["goal"] is None and data["best"]["code"] == "all_days"
    assert all(x["state"] is None for x in data["days"])


def test_at_most_one_best_and_one_improve(client, plain):
    for i in range(5):
        log(client, plain, i, 1000)
    data = review(client)
    assert isinstance(data["best"], dict) and isinstance(data["improve"], dict)


def test_badges_reached_in_the_week_are_listed(client, dense):
    today = date.today()
    client.post(f"/api/v1/diary/{today.isoformat()}/entries", json={"food_id": dense["id"], "meal": "lunch", "amount": 500})
    client.get("/api/v1/badges")  # brings the badges up to date
    monday = today - timedelta(days=today.weekday())
    iso = monday.isocalendar()
    assert "first_entry" in client.get(f"/api/v1/review?week={iso.year}-W{iso.week:02d}").json()["badges"]
    client.patch("/api/v1/me/settings", json={"playful": False})
    assert "first_entry" not in client.get(f"/api/v1/review?week={iso.year}-W{iso.week:02d}").json()["badges"]


def test_users_are_separate(duo):
    ann, ben = duo
    food = ann.post("/api/v1/foods", json={"name": "X", "per_100": {"kcal": 100}}).json()
    ann.post(f"/api/v1/diary/{d(0)}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    assert ann.get("/api/v1/review?week=2025-W10").json()["logged_days"] == 1
    assert ben.get("/api/v1/review?week=2025-W10").json()["logged_days"] == 0

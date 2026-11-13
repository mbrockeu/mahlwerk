from datetime import date, timedelta

DAY = "2025-03-10"


def water(client, day=DAY):
    return client.get(f"/api/v1/diary/{day}").json()["water"]


def test_day_has_no_water_by_default_and_the_default_goal(client):
    assert water(client) == {"ml": 0, "goal_ml": 2000}


def test_add_sums_up_and_can_take_back(client):
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).json() == {"ml": 250, "goal_ml": 2000}
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 500}).json()["ml"] == 750
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": -250}).json()["ml"] == 500
    assert water(client)["ml"] == 500


def test_total_stays_between_0_and_10000(client):
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": -250}).json()["ml"] == 0  # nothing to take back
    for _ in range(5):
        client.post(f"/api/v1/water/{DAY}", json={"add_ml": 2000})
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 2000}).json()["ml"] == 10000
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 1}).json()["ml"] == 10000
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": -2000}).json()["ml"] == 8000


def test_add_amount_is_limited_to_2000(client):
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 2001}).status_code == 422
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": -2001}).status_code == 422
    assert client.post(f"/api/v1/water/{DAY}", json={}).status_code == 422
    assert client.post("/api/v1/water/yesterday", json={"add_ml": 250}).status_code == 422


def test_put_sets_the_value_directly(client):
    client.post(f"/api/v1/water/{DAY}", json={"add_ml": 250})
    assert client.put(f"/api/v1/water/{DAY}", json={"ml": 1750}).json() == {"ml": 1750, "goal_ml": 2000}
    assert client.put(f"/api/v1/water/{DAY}", json={"ml": 0}).json()["ml"] == 0
    assert client.put(f"/api/v1/water/{DAY}", json={"ml": 10001}).status_code == 422
    assert client.put(f"/api/v1/water/{DAY}", json={"ml": -1}).status_code == 422
    assert water(client)["ml"] == 0


def test_goal_defaults_to_2000_accepts_500_to_6000_and_keeps_the_value(client):
    base = {"kcal": 2000, "protein": 100, "carbs": 250, "fat": 70}
    assert client.put("/api/v1/me/goal", json=base).json()["water_ml"] == 2000
    assert client.put("/api/v1/me/goal", json={**base, "water_ml": 2500}).json()["water_ml"] == 2500
    assert water(client)["goal_ml"] == 2500
    assert client.get("/api/v1/me").json()["goal"]["water_ml"] == 2500
    assert client.put("/api/v1/me/goal", json=base).json()["water_ml"] == 2500  # older clients leave it alone
    assert client.put("/api/v1/me/goal", json={**base, "water_ml": 499}).status_code == 422
    assert client.put("/api/v1/me/goal", json={**base, "water_ml": 6001}).status_code == 422
    assert client.put("/api/v1/me/goal", json={**base, "water_ml": 6000}).status_code == 200
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).json()["goal_ml"] == 6000


def test_users_do_not_see_each_others_water(duo):
    ann, ben = duo
    ann.post(f"/api/v1/water/{DAY}", json={"add_ml": 750})
    assert water(ann)["ml"] == 750
    assert water(ben)["ml"] == 0
    ben.post(f"/api/v1/water/{DAY}", json={"add_ml": 250})
    assert water(ann)["ml"] == 750 and water(ben)["ml"] == 250


def test_insights_have_water_per_day_and_the_mean_over_days_with_water(client):
    today = date.today()
    d = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
    client.put(f"/api/v1/water/{d(1)}", json={"ml": 1500})
    client.put(f"/api/v1/water/{d(2)}", json={"ml": 2500})
    client.put(f"/api/v1/water/{d(3)}", json={"ml": 0})
    body = client.get(f"/api/v1/insights?from={d(6)}&to={d(0)}").json()
    by_day = {x["day"]: x["water_ml"] for x in body["days"]}
    assert by_day[d(1)] == 1500 and by_day[d(2)] == 2500 and by_day[d(3)] == 0
    assert by_day[d(0)] is None and by_day[d(4)] is None  # no value is not the same as 0 ml
    assert body["averages"]["water_ml"] == 1333  # (1500 + 2500 + 0) / 3
    empty = client.get("/api/v1/insights?from=2020-01-01&to=2020-01-07").json()
    assert empty["averages"]["water_ml"] == 0

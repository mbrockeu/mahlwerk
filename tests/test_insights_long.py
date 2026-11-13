"""Long ranges: sections, comparison, nutrient curve, foods, expenditure estimate, calendar, speed."""

import time
from datetime import date, timedelta

import pytest

from mahlwerk import analysis

MON = date(2025, 3, 3)  # a Monday


def d(offset: int, base: date = MON) -> str:
    return (base + timedelta(days=offset)).isoformat()


@pytest.fixture
def store(client):
    client.get("/api/v1/me")
    return client.app.state.store


@pytest.fixture
def uid(store):
    return store.find_user("me")["id"]


def item(kcal=100, meal="lunch", name="Food", food_id=None, extra=None, brand=None, unit="g", **per):
    """An entry of 100 g of a food with `kcal` per 100 g, so the entry's kcal equal `kcal`."""
    return {"meal": meal, "food_id": food_id, "amount": 100, "unit": unit, "name": name, "brand": brand,
            "per_100": {"kcal": kcal, **per}, "extra": extra or {}}


def seed(store, uid, day, *items):
    store.add_entries(uid, day, list(items))


def get(client, query):
    r = client.get(f"/api/v1/insights?{query}")
    assert r.status_code == 200, r.text
    return r.json()


def goal(client, kcal=2000):
    client.put("/api/v1/me/goal", json={"kcal": kcal, "protein": 100, "carbs": 250, "fat": 70})


# --- sections ---------------------------------------------------------------------------------------------------


def test_buckets_weeks_are_iso_weeks_clipped_to_the_range():
    out = analysis.buckets(date(2025, 3, 5), date(2025, 3, 17), "week")  # Wednesday .. Monday two weeks later
    assert [(a.isoformat(), b.isoformat(), k) for a, b, k in out] == [
        ("2025-03-05", "2025-03-09", "2025-W10"), ("2025-03-10", "2025-03-16", "2025-W11"),
        ("2025-03-17", "2025-03-17", "2025-W12")]


def test_buckets_use_the_iso_year_around_new_year():
    out = analysis.buckets(date(2024, 12, 30), date(2025, 1, 5), "week")
    assert len(out) == 1 and out[0][2] == "2025-W01"  # Monday 30 Dec 2024 belongs to ISO week 1 of 2025
    assert analysis.buckets(date(2021, 1, 1), date(2021, 1, 3), "week")[0][2] == "2020-W53"


def test_buckets_months_know_month_ends_and_leap_years():
    out = analysis.buckets(date(2024, 1, 15), date(2024, 3, 2), "month")
    assert [(a.isoformat(), b.isoformat(), k) for a, b, k in out] == [
        ("2024-01-15", "2024-01-31", "2024-01"), ("2024-02-01", "2024-02-29", "2024-02"),
        ("2024-03-01", "2024-03-02", "2024-03")]
    assert analysis.buckets(date(2025, 2, 1), date(2025, 2, 28), "month")[0][1] == date(2025, 2, 28)
    assert analysis.buckets(date(2024, 12, 20), date(2025, 1, 10), "month")[1][2] == "2025-01"


def test_buckets_cover_every_day_exactly_once():
    for gran in ("day", "week", "month"):
        out = analysis.buckets(date(2023, 11, 20), date(2024, 3, 5), gran)
        assert out[0][0] == date(2023, 11, 20) and out[-1][1] == date(2024, 3, 5)
        assert all(b[0] == a[1] + timedelta(days=1) for a, b in zip(out, out[1:]))


def test_auto_granularity_thresholds():
    assert [analysis.resolve_granularity("auto", n) for n in (1, 45, 46, 370, 371, 3660)] == [
        "day", "day", "week", "week", "month", "month"]
    assert analysis.resolve_granularity("month", 5) == "month"


def test_series_means_per_logged_day_and_weights(client, store, uid):
    seed(store, uid, d(0), item(1000))
    seed(store, uid, d(2), item(2000), item(500, "dinner"))  # Wednesday 2500
    seed(store, uid, d(8), item(1800))  # next week
    store.put_weight(uid, d(1), 80.0)
    store.put_weight(uid, d(3), 79.0)
    store.put_water(uid, d(0), 2000)
    goal(client, 2000)
    data = get(client, f"from={d(0)}&to={d(13)}&granularity=week")
    assert data["granularity"] == "week" and len(data["series"]) == 2
    w1, w2 = data["series"]
    assert (w1["start"], w1["end"], w1["label_key"], w1["days"], w1["logged_days"]) == (d(0), d(6), "2025-W10", 7, 2)
    assert w1["kcal"] == 1750  # (1000 + 2500) / 2, empty days do not count
    assert w1["weight"] == 79.5 and w1["water_ml"] == 2000
    assert (w1["under_days"], w1["over_days"], w1["in_range_days"]) == (1, 1, 0)
    assert w2["kcal"] == 1800 and w2["weight"] is None and w2["water_ml"] is None and w2["in_range_days"] == 1
    auto = get(client, f"from={d(0)}&to={d(13)}")
    assert auto["granularity"] == "day" and len(auto["series"]) == 14  # 14 days: single days
    month = get(client, f"from={d(0)}&to={d(13)}&granularity=month")
    assert len(month["series"]) == 1 and month["series"][0]["label_key"] == "2025-03"


def test_days_and_calendar_only_up_to_370_days(client, store, uid):
    seed(store, uid, d(0), item(1000))
    short = get(client, f"from={d(0)}&to={d(369)}")
    assert len(short["days"]) == 370 and len(short["calendar"]) == 370
    long = get(client, f"from={d(0)}&to={d(370)}")
    assert long["days"] == [] and long["calendar"] == [] and long["range"]["days"] == 371
    assert long["granularity"] == "month" and long["weight"] is None
    assert long["averages"]["kcal"] == 1000


def test_weight_carries_the_raw_values(client, store, uid):
    seed(store, uid, d(0), item())
    store.put_weight(uid, d(0), 80.0)
    store.put_weight(uid, d(10), 79.0)
    w = get(client, f"from={d(0)}&to={d(20)}")["weight"]
    assert w["raw"] == [{"day": d(0), "kg": 80.0}, {"day": d(10), "kg": 79.0}]
    assert [p["day"] for p in w["trend"]] == [d(0), d(10)]


# --- calendar -----------------------------------------------------------------------------------------------------


def test_calendar_states(client, store, uid):
    seed(store, uid, d(0), item(1000))   # under
    seed(store, uid, d(1), item(2000))   # in range
    seed(store, uid, d(2), item(3000))   # over
    seed(store, uid, d(4), item(2000))   # no goal yet below
    states = lambda: [c["state"] for c in get(client, f"from={d(0)}&to={d(4)}")["calendar"]]  # noqa: E731
    assert states() == ["no_goal", "no_goal", "no_goal", "none", "no_goal"]
    goal(client, 2000)
    assert states() == ["under", "in_range", "over", "none", "in_range"]


# --- ranges ------------------------------------------------------------------------------------------------------


def test_range_all_runs_from_first_to_last_entry(client, store, uid):
    empty = get(client, "range=all")
    assert empty["first_day"] is None and empty["last_day"] is None and empty["range"]["logged_days"] == 0
    assert empty["series"] and empty["expenditure"] is None
    seed(store, uid, d(0), item(1000))
    seed(store, uid, d(100), item(2000))
    data = get(client, "range=all")
    assert (data["first_day"], data["last_day"]) == (d(0), d(100))
    assert (data["range"]["from"], data["range"]["to"], data["range"]["days"]) == (d(0), d(100), 101)
    assert data["granularity"] == "week"
    # first_day / last_day describe the user, not the requested period
    narrow = get(client, f"from={d(50)}&to={d(60)}")
    assert (narrow["first_day"], narrow["last_day"]) == (d(0), d(100))


def test_range_number_and_bad_values(client):
    assert get(client, "range=7")["range"]["days"] == 7
    assert client.get("/api/v1/insights?range=abc").status_code == 422
    assert client.get("/api/v1/insights?range=0").status_code == 422
    assert client.get("/api/v1/insights?granularity=year").status_code == 422
    assert client.get("/api/v1/insights?compare=next").status_code == 422


def test_ten_years_are_the_limit(client):
    first = date(2015, 1, 1)
    assert client.get(f"/api/v1/insights?from={first}&to={first + timedelta(days=3659)}").status_code == 200
    assert client.get(f"/api/v1/insights?from={first}&to={first + timedelta(days=3660)}").status_code == 422
    assert client.get(f"/api/v1/insights?from={d(3)}&to={d(0)}").status_code == 422


# --- comparison --------------------------------------------------------------------------------------------------


def test_compare_previous_and_deltas(client, store, uid):
    goal(client, 2000)
    for i in range(0, 7):
        seed(store, uid, d(i), item(2000, protein=100))          # previous week: all in range
        seed(store, uid, d(7 + i), item(2200 if i < 4 else 1000, protein=110))  # this week: 4 in range, 3 under
    store.put_weight(uid, d(0), 81.0)
    store.put_weight(uid, d(6), 80.5)
    store.put_weight(uid, d(7), 80.5)
    store.put_weight(uid, d(13), 79.5)
    data = get(client, f"from={d(7)}&to={d(13)}&compare=previous")
    prev = data["previous"]
    assert prev["range"] == {"from": d(0), "to": d(6), "days": 7, "logged_days": 7}
    assert prev["averages"]["kcal"] == 2000 and prev["logged_days"] == 7
    assert prev["adherence"]["in_range_days"] == 7 and prev["weight"]["change"] == -0.5
    assert len(prev["series"]) == 7
    dl = data["deltas"]
    assert dl["kcal"] == {"abs": round(data["averages"]["kcal"] - 2000, 2), "pct": round((data["averages"]["kcal"] / 2000 - 1) * 100, 1)}
    assert dl["protein"] == {"abs": 10.0, "pct": 10.0}
    assert dl["weight_change"] == {"abs": -0.5, "pct": 100.0}  # -1.0 now against -0.5 before
    assert dl["in_range_share"]["abs"] == round(4 / 7 * 100 - 100, 1) and dl["in_range_share"]["pct"] is None
    assert dl["water_ml"] == {"abs": 0.0, "pct": None}


def test_compare_with_an_empty_period_before(client, store, uid):
    seed(store, uid, d(7), item(2000))
    data = get(client, f"from={d(7)}&to={d(13)}&compare=previous")
    assert data["previous"]["logged_days"] == 0 and data["previous"]["weight"] is None
    assert data["previous"]["averages"]["kcal"] == 0 and data["deltas"] is None
    assert get(client, f"from={d(7)}&to={d(13)}")["previous"] is None


def test_compare_when_the_current_period_is_empty(client, store, uid):
    seed(store, uid, d(0), item(2000))
    data = get(client, f"from={d(7)}&to={d(13)}&compare=previous")
    assert data["previous"]["logged_days"] == 1 and data["deltas"] is None


# --- nutrient curve ----------------------------------------------------------------------------------------------


def nutrient(client, query):
    r = client.get(f"/api/v1/insights/nutrient?{query}")
    assert r.status_code == 200, r.text
    return r.json()


def test_nutrient_curve_mean_per_logged_day_and_coverage(client, store, uid):
    seed(store, uid, d(0), item(300, extra={"calcium": 100}), item(100, "dinner"))  # known for 300 of 400 kcal
    seed(store, uid, d(1), item(500, extra={"calcium": 300}))
    seed(store, uid, d(8), item(200))  # calcium unknown
    data = nutrient(client, f"key=calcium&from={d(0)}&to={d(13)}&granularity=week")
    assert data["unit"] == "mg" and data["nrv"] == 800 and data["group"] == "mineral" and data["goal"] is None
    w1, w2 = data["series"]
    assert w1["average"] == 200 and w1["coverage"] == round(800 / 900, 3)  # (100 + 300) / 2 days
    assert w2["average"] == 0 and w2["coverage"] == 0
    assert data["has_data"] is True and data["granularity"] == "week"


def test_nutrient_curve_of_core_values_and_goal(client, store, uid):
    goal(client, 2000)
    seed(store, uid, d(0), item(400, protein=20), item(100, "dinner"))  # protein unknown on the second entry
    data = nutrient(client, f"key=protein&from={d(0)}&to={d(2)}")
    assert data["unit"] == "g" and data["goal"] == 100 and data["nrv"] is None
    assert data["series"][0]["average"] == 20 and data["series"][0]["coverage"] == 0.8  # 400 of 500 kcal
    assert data["series"][1]["average"] is None and data["series"][1]["coverage"] == 0
    kcal = nutrient(client, f"key=kcal&from={d(0)}&to={d(0)}")
    assert kcal["series"][0]["average"] == 500 and kcal["series"][0]["coverage"] == 1 and kcal["goal"] == 2000


def test_nutrient_curve_without_data_and_bad_key(client, store, uid):
    data = nutrient(client, f"key=vitamin_c&from={d(0)}&to={d(6)}")
    assert data["has_data"] is False and all(s["average"] is None for s in data["series"])
    assert client.get(f"/api/v1/insights/nutrient?key=bogus&from={d(0)}&to={d(6)}").status_code == 422
    assert client.get(f"/api/v1/insights/nutrient?key=calcium&from={d(6)}&to={d(0)}").status_code == 422


# --- foods -------------------------------------------------------------------------------------------------------


def foods(client, query=""):
    r = client.get(f"/api/v1/insights/foods?from={d(0)}&to={d(100)}&{query}")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def eaten(client, store, uid):
    oat = client.post("/api/v1/foods", json={"name": "Oats", "brand": "Acme", "per_100": {"kcal": 200}}).json()
    # Oats: 3 times on 2 days; Rice (deleted food, grouped by name+brand): once; Quick: twice
    seed(store, uid, d(0), item(200, "breakfast", "Oats", oat["id"], brand="Acme"), item(200, "snack", "Oats", oat["id"], brand="Acme"))
    seed(store, uid, d(3), item(200, "breakfast", "Oats", oat["id"], brand="Acme"), item(130, "lunch", "Rice", None, brand="Ben"))
    seed(store, uid, d(10), item(50, "dinner", "Quick", None), item(50, "dinner", "Quick", None))
    return oat


def test_foods_are_grouped_and_sorted(client, eaten):
    data = foods(client)
    assert data["total"] == 3 and data["offset"] == 0 and data["kcal_total"] == 830
    first = data["items"][0]
    assert (first["name"], first["brand"], first["food_id"], first["times"], first["days"]) == ("Oats", "Acme", eaten["id"], 3, 2)
    assert first["kcal_total"] == 600 and first["share"] == round(600 / 830, 4) and first["amount_total"] == 300
    assert first["avg_amount"] == 100 and first["unit"] == "g"
    assert (first["first_day"], first["last_day"]) == (d(0), d(3)) and first["key"] == f"id:{eaten['id']}"
    assert [i["name"] for i in data["items"]] == ["Oats", "Rice", "Quick"]
    assert [i["name"] for i in foods(client, "sort=times")["items"]] == ["Oats", "Quick", "Rice"]
    assert [i["name"] for i in foods(client, "sort=last")["items"]] == ["Quick", "Oats", "Rice"]
    assert [i["name"] for i in foods(client, "sort=name")["items"]] == ["Oats", "Quick", "Rice"]
    assert [i["name"] for i in foods(client, "sort=amount")["items"]][0] == "Oats"
    assert client.get(f"/api/v1/insights/foods?from={d(0)}&to={d(5)}&sort=taste").status_code == 422


def test_foods_without_id_group_by_name_and_brand(client, store, uid):
    seed(store, uid, d(0), item(100, name="Rice", brand="A"), item(100, name="Rice", brand="B"), item(100, name="Rice", brand="A"))
    data = foods(client)
    assert data["total"] == 2 and {(i["brand"], i["times"]) for i in data["items"]} == {("A", 2), ("B", 1)}
    assert all(i["key"].startswith("n:") and i["food_id"] is None for i in data["items"])


def test_foods_search_and_paging(client, eaten):
    assert [i["name"] for i in foods(client, "q=ACME")["items"]] == ["Oats"]  # brand, case-insensitive
    assert [i["name"] for i in foods(client, "q=ric")["items"]] == ["Rice"]
    assert foods(client, "q=zzz") == {**foods(client, "q=zzz"), "total": 0, "items": []}
    page1, page2 = foods(client, "limit=2"), foods(client, "limit=2&offset=2")
    assert page1["total"] == page2["total"] == 3 and len(page1["items"]) == 2 and [i["name"] for i in page2["items"]] == ["Quick"]
    assert foods(client, "limit=2&offset=9")["items"] == []
    assert client.get(f"/api/v1/insights/foods?from={d(0)}&to={d(5)}&limit=0").status_code == 422
    # the share stays a part of the whole period, also when a search narrows the list
    assert foods(client, "q=rice")["items"][0]["share"] == round(130 / 830, 4)


def test_foods_respect_the_period(client, eaten):
    r = client.get(f"/api/v1/insights/foods?from={d(4)}&to={d(100)}").json()
    assert [i["name"] for i in r["items"]] == ["Quick"]


def test_food_detail(client, store, uid, eaten):
    seed(store, uid, d(40), item(200, "dinner", "Oats", eaten["id"], brand="Acme"))
    seed(store, uid, d(41), item(200, "dinner", "Oats", eaten["id"], brand="Acme"))
    r = client.get(f"/api/v1/insights/foods/detail?key=id:{eaten['id']}&from={d(0)}&to={d(100)}")
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "Oats" and data["times"] == 5 and data["days"] == 4 and data["kcal_total"] == 1000
    assert [m["month"] for m in data["monthly"]] == ["2025-03", "2025-04", "2025-05", "2025-06"]  # empty months too
    assert data["monthly"][0] == {"month": "2025-03", "times": 3, "amount": 300, "kcal": 600}
    assert data["monthly"][3]["times"] == 0
    meals = {m["meal"]: m["times"] for m in data["by_meal"]}
    assert meals == {"breakfast": 2, "lunch": 0, "dinner": 2, "snack": 1}
    assert sum(w["times"] for w in data["by_weekday"]) == 5 and len(data["by_weekday"]) == 7
    assert data["usual_amounts"] == [{"amount": 100.0, "times": 5}]
    assert client.get(f"/api/v1/insights/foods/detail?key=id:99999&from={d(0)}&to={d(100)}").status_code == 404
    assert client.get(f"/api/v1/insights/foods/detail?key=id:{eaten['id']}&from={d(80)}&to={d(100)}").status_code == 404


def test_usual_amounts_are_the_three_most_common(client, store, uid):
    for day, amount in enumerate([30, 30, 30, 50, 50, 80, 80, 120]):
        seed(store, uid, d(day), {**item(100, name="Nuts"), "amount": amount})
    key = foods(client)["items"][0]["key"]
    detail = client.get(f"/api/v1/insights/foods/detail?key={key}&from={d(0)}&to={d(100)}").json()
    assert [(u["amount"], u["times"]) for u in detail["usual_amounts"]] == [(30.0, 3), (50.0, 2), (80.0, 2)]


# --- expenditure -------------------------------------------------------------------------------------------------


def line(n, start, per_day):
    return [(i, start + per_day * i) for i in range(n)]


def test_constant_weight_means_expenditure_equals_intake():
    result, missing = analysis.estimate_expenditure(28, 28, 2000, line(28, 80, 0.0), 1800)
    assert missing == [] and result["kcal"] == 2000 and result["kg_per_week"] == 0 and result["weight_change_kg"] == 0
    assert result["goal_gap"] == -200 and (result["low"], result["high"]) == (1800, 2200)  # 10 % floor
    assert result["weigh_ins"] == 28


def test_losing_half_a_kilo_a_week_at_2000_kcal_is_about_2550():
    result, _ = analysis.estimate_expenditure(28, 28, 2000, line(28, 80, -0.5 / 7), 2100)
    assert result["kcal"] == 2550 and result["kg_per_week"] == -0.5 and result["weight_change_kg"] == -2.0
    assert result["goal_gap"] == -450


def test_gaining_weight_means_expenditure_below_intake():
    result, _ = analysis.estimate_expenditure(28, 28, 2500, line(28, 80, 0.25 / 7))
    assert result["kcal"] == 2225 and result["goal_gap"] is None


def test_regression_not_first_against_last_value():
    # noisy values, last one an outlier: first/last would give a huge change, the line is nearly flat
    weights = [(0, 80.0), (3, 80.3), (6, 79.8), (9, 80.2), (12, 79.9), (15, 80.1), (18, 80.0), (21, 80.2), (24, 79.9), (27, 82.0)]
    result, _ = analysis.estimate_expenditure(28, 28, 2000, weights)
    assert abs(result["kg_per_week"]) < 0.3 and abs(result["kcal"] - 2000) < 330
    assert result["high"] - result["low"] >= 2 * 0.1 * result["kcal"] - 2  # never narrower than +-10 %


def test_a_noisy_curve_widens_the_range_beyond_ten_percent():
    noisy = [(i, 80 + (2.0 if i % 2 else -2.0)) for i in range(28)]
    result, _ = analysis.estimate_expenditure(28, 28, 2000, noisy)
    assert result["high"] - result["low"] > 2 * 0.1 * result["kcal"]


@pytest.mark.parametrize(("args", "reasons"), [
    ((20, 20, 2000, line(20, 80, 0)), ["short_period"]),
    ((28, 19, 2000, line(28, 80, 0)), ["few_logged_days"]),
    ((28, 28, 2000, line(5, 80, 0)), ["few_weights", "weights_not_spread"]),
    ((28, 28, 2000, [(i, 80) for i in range(10)]), ["weights_not_spread"]),
    ((10, 3, 2000, []), ["short_period", "few_logged_days", "few_weights", "weights_not_spread"]),
])
def test_each_missing_prerequisite_is_named(args, reasons):
    result, missing = analysis.estimate_expenditure(*args)
    assert result is None and missing == reasons


def test_exact_thresholds_are_enough():
    weights = [(0, 80.0), (3, 80.0), (6, 80.0), (9, 80.0), (12, 80.0), (14, 80.0)]
    result, missing = analysis.estimate_expenditure(21, 15, 2000, weights)  # 15 / 21 = 71 %
    assert missing == [] and result["kcal"] == 2000
    assert analysis.estimate_expenditure(21, 14, 2000, weights)[1] == ["few_logged_days"]  # 66.7 %


def test_expenditure_in_the_response(client, store, uid):
    goal(client, 1800)
    for i in range(28):
        seed(store, uid, d(i), item(2000))
        if i % 3 == 0:
            store.put_weight(uid, d(i), round(80 - 0.5 / 7 * i, 3))
    data = get(client, f"from={d(0)}&to={d(27)}")
    assert data["expenditure_missing"] == []
    e = data["expenditure"]
    assert abs(e["kcal"] - 2550) <= 5 and e["intake"] == 2000 and e["goal_gap"] == 1800 - e["kcal"] and e["weigh_ins"] == 10
    short = get(client, f"from={d(0)}&to={d(9)}")
    assert short["expenditure"] is None and "short_period" in short["expenditure_missing"]


# --- separation, speed ---------------------------------------------------------------------------------------------


def test_users_are_separated(duo):
    ann, ben = duo
    ann.get("/api/v1/me")
    ben.get("/api/v1/me")
    food = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200}}).json()
    ann.post(f"/api/v1/diary/{d(0)}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    assert get(ann, f"from={d(0)}&to={d(5)}")["first_day"] == d(0)
    other = get(ben, f"from={d(0)}&to={d(5)}&compare=previous")
    assert other["first_day"] is None and other["range"]["logged_days"] == 0
    assert get(ben, "range=all")["range"]["logged_days"] == 0
    assert ben.get(f"/api/v1/insights/foods?from={d(0)}&to={d(5)}").json()["total"] == 0
    assert ann.get(f"/api/v1/insights/foods?from={d(0)}&to={d(5)}").json()["total"] == 1
    key = f"id:{food['id']}"
    assert ben.get(f"/api/v1/insights/foods/detail?key={key}&from={d(0)}&to={d(5)}").status_code == 404
    curve = ben.get(f"/api/v1/insights/nutrient?key=kcal&from={d(0)}&to={d(5)}").json()
    assert curve["has_data"] is False


def test_ten_years_with_30000_entries_answer_fast(client, store, uid):
    start = date(2016, 1, 1)
    batch = []
    for i in range(3650):
        day = (start + timedelta(days=i)).isoformat()
        batch.append((day, [item(60 + (i + n) % 40, ("breakfast", "lunch", "dinner", "snack")[n % 4], f"Food {(i * 7 + n) % 300}",
                                 food_id=None, extra={"calcium": 50 + n, "vitamin_c": 3}, protein=5, fat=3, carbs=10)
                            for n in range(8)]))
        if i % 3 == 0:
            store.put_weight(uid, day, 80 + (i % 11) / 10)
    for day, items in batch:
        seed(store, uid, day, *items)
    goal(client, 2000)
    t0 = time.perf_counter()
    r = client.get("/api/v1/insights?range=all&compare=previous")
    took = time.perf_counter() - t0
    assert r.status_code == 200 and took < 2.5, took
    data = r.json()
    assert data["range"]["days"] == 3650 and data["range"]["logged_days"] == 3650 and data["granularity"] == "month"
    assert len(data["series"]) == 120 and data["days"] == []
    t0 = time.perf_counter()
    assert client.get(f"/api/v1/insights/foods?from={d(0, start)}&to=2026-01-01&limit=50").status_code == 200
    assert client.get("/api/v1/insights/nutrient?key=calcium&from=2016-01-01&to=2026-01-01").status_code == 200
    assert time.perf_counter() - t0 < 3

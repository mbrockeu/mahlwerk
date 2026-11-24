"""Training motivation: the weekly goal and its week block, the training badges (with the demo split) and the training block
of the evaluation. A training day is a day whose workouts add up to at least 10 minutes; a week runs Monday to Sunday."""

from datetime import date, timedelta

from mahlwerk import activity, insights

MON = date(2025, 3, 3)  # a Monday


def d(offset: int) -> str:
    return (MON + timedelta(days=offset)).isoformat()


def train(client, day, minutes=30, **body):
    r = client.post("/api/v1/workouts", json={"day": day, "kind": "running", "minutes": minutes, **body})
    assert r.status_code == 201, r.text


def goal_week(client, n):
    r = client.patch("/api/v1/me/settings", json={"activity": {"workouts_week": n}})
    assert r.status_code == 200, r.text
    return r.json()


def week_of(client, day):
    r = client.get(f"/api/v1/diary/{day}")
    assert r.status_code == 200, r.text
    return r.json()["activity"]["week"]


# --- the rules -------------------------------------------------------------------------------------------------


def test_training_day_needs_ten_minutes_in_total():
    rows = [{"day": "a", "minutes": 9.9}, {"day": "b", "minutes": 10}, {"day": "c", "minutes": 6}, {"day": "c", "minutes": 4}]
    assert activity.training_days(rows) == {"b", "c"}  # several workouts on a day count as one training day


def test_weeks_run_monday_to_sunday():
    assert activity.week_start("2025-03-09") == date(2025, 3, 3)  # Sunday
    assert activity.week_start("2025-03-10") == date(2025, 3, 10)  # Monday
    assert activity.week_number("2025-03-09") + 1 == activity.week_number("2025-03-10")


# --- settings --------------------------------------------------------------------------------------------------


def test_setting_defaults_to_off_is_validated_and_patches_keep_the_rest(client):
    assert client.get("/api/v1/me").json()["settings"]["activity"] == {"add_to_goal": False, "workouts_week": 0}
    assert goal_week(client, 3)["activity"] == {"add_to_goal": False, "workouts_week": 3}
    r = client.patch("/api/v1/me/settings", json={"activity": {"add_to_goal": True}})
    assert r.json()["activity"] == {"add_to_goal": True, "workouts_week": 3}  # the goal stays
    assert goal_week(client, 0)["activity"] == {"add_to_goal": True, "workouts_week": 0}
    for bad in (8, -1, "x"):
        assert client.patch("/api/v1/me/settings", json={"activity": {"workouts_week": bad}}).status_code == 422


# --- the week block --------------------------------------------------------------------------------------------


def test_no_week_block_while_the_goal_is_off(client):
    train(client, d(1))
    assert week_of(client, d(1)) is None


def test_week_block_days_done_and_goal(client):
    goal_week(client, 3)
    train(client, d(0))
    train(client, d(2), minutes=6)
    train(client, d(2), minutes=6)  # 12 minutes in two workouts: one training day
    train(client, d(3), minutes=9)  # too short
    train(client, d(8))  # next week
    block = week_of(client, d(4))  # a Friday
    assert block == {"goal": 3, "days": [True, False, True, False, False, False, False], "done": 2, "streak": 0}
    assert week_of(client, d(0))["days"] == block["days"] and week_of(client, d(6))["days"] == block["days"]  # any day of the week
    assert week_of(client, d(7))["days"] == [False, True] + [False] * 5  # Monday after: its own week


def test_streak_counts_weeks_in_a_row_ending_with_this_week_when_reached(client):
    goal_week(client, 2)
    for w in (0, 1, 2):  # three full weeks
        train(client, d(7 * w))
        train(client, d(7 * w + 2))
    assert week_of(client, d(14))["streak"] == 3  # the third week is reached: it counts
    assert week_of(client, d(7))["streak"] == 2
    assert week_of(client, d(0))["streak"] == 1


def test_streak_ends_with_the_week_before_while_this_one_is_open(client):
    goal_week(client, 2)
    for w in (0, 1):
        train(client, d(7 * w))
        train(client, d(7 * w + 1))
    train(client, d(14))  # the third week has one of two training days so far
    block = week_of(client, d(15))
    assert block["done"] == 1 and block["streak"] == 2  # not scolded: the two earlier weeks still count
    train(client, d(16))
    assert week_of(client, d(15))["streak"] == 3


def test_a_missed_week_breaks_the_streak(client):
    goal_week(client, 1)
    train(client, d(0))
    train(client, d(7))
    train(client, d(21))  # week 2 is empty
    assert week_of(client, d(21))["streak"] == 1
    assert week_of(client, d(7))["streak"] == 2
    assert week_of(client, d(14))["streak"] == 2  # an empty week shown: the weeks before still count


def test_streak_across_the_year_boundary(client):
    goal_week(client, 1)
    train(client, "2024-12-30")  # Monday of the week with 2025-01-01
    train(client, "2025-01-06")
    assert week_of(client, "2025-01-08")["streak"] == 2


def test_week_block_with_goal_seven_and_demo_rows_counting(duo):
    ann, ben = duo
    goal_week(ann, 7)
    for i in range(7):
        train(ann, d(i), minutes=10)
    assert week_of(ann, d(3)) == {"goal": 7, "days": [True] * 7, "done": 7, "streak": 1}
    assert week_of(ben, d(3)) is None  # settings and workouts are per user


def test_the_activity_list_carries_the_week_block_too(client):
    goal_week(client, 1)
    today = date.today()
    train(client, today.isoformat())
    rows = client.get("/api/v1/activity", params={"days": 3}).json()
    assert all(r["week"]["goal"] == 1 for r in rows) and rows[-1]["week"]["done"] >= 1


# --- badges ----------------------------------------------------------------------------------------------------


def badge_progress(client, code):
    data = client.get("/api/v1/badges").json()
    for b in data["earned"]:
        if b["code"] == code:
            return "earned"
    return next(b["progress"] for b in data["open"] if b["code"] == code)


def earned(client):
    return {b["code"] for b in client.get("/api/v1/badges").json()["earned"]}


def test_training_badges_are_listed_after_the_old_ones(client):
    data = client.get("/api/v1/badges").json()
    codes = [b["code"] for b in data["open"]]
    assert codes[-4:] == ["first_workout", "active_week", "active_month", "workouts_25"]
    assert badge_progress(client, "first_workout") == {"current": 0, "target": 1}


def test_first_workout_needs_a_training_day(client):
    train(client, d(0), minutes=9)
    assert "first_workout" not in earned(client)
    train(client, d(0), minutes=1)  # 10 minutes on the day in total
    assert "first_workout" in earned(client)


def test_active_week_needs_three_training_days_in_one_calendar_week(client):
    for i in (5, 6, 7):  # Saturday, Sunday, Monday: three days in a row but two weeks
        train(client, d(i))
    assert badge_progress(client, "active_week") == {"current": 2, "target": 3}
    train(client, d(4))
    assert "active_week" in earned(client)


def test_active_month_needs_two_days_in_each_of_four_consecutive_weeks(client):
    for w in (0, 1, 2):
        train(client, d(7 * w))
        train(client, d(7 * w + 3))
    assert badge_progress(client, "active_month") == {"current": 3, "target": 4}
    train(client, d(21))  # a fourth week with one day only
    assert badge_progress(client, "active_month") == {"current": 3, "target": 4}
    train(client, d(23))
    assert "active_month" in earned(client)


def test_active_month_needs_consecutive_weeks(client):
    for w in (0, 1, 3, 4):  # week 2 is missing
        train(client, d(7 * w))
        train(client, d(7 * w + 1))
    assert badge_progress(client, "active_month") == {"current": 2, "target": 4}


def test_workouts_25_counts_days_not_workouts(client):
    for i in range(24):
        train(client, d(i))
        train(client, d(i), minutes=40)  # two workouts a day are one training day
    assert badge_progress(client, "workouts_25") == {"current": 24, "target": 25}
    train(client, d(24))
    assert "workouts_25" in earned(client)


def test_demo_workouts_earn_a_badge_only_as_long_as_the_demo_data_is_there(duo):
    ann, _ = duo
    assert ann.post("/api/v1/me/demo-data", json={"days": 60}).status_code == 200
    assert {"first_workout", "active_week"} <= earned(ann)
    ann.delete("/api/v1/me/demo-data")
    assert earned(ann) == set()


def test_a_real_workout_keeps_the_badge_when_the_demo_data_goes(duo):
    ann, _ = duo
    ann.post("/api/v1/me/demo-data", json={"days": 60})
    train(ann, d(0))
    assert "first_workout" in earned(ann)
    ann.delete("/api/v1/me/demo-data")
    assert earned(ann) == {"first_workout"}


# --- the training block of the evaluation ----------------------------------------------------------------------


def day_totals(kcal_by_day):
    return {d: {"kcal": k, "protein": k / 20} for d, k in kcal_by_day.items()}


def test_summary_compares_logged_training_days_with_the_others_from_five_days_each():
    days = [d(i) for i in range(14)]
    workouts = [{"day": days[i], "minutes": 30} for i in range(0, 14, 2)]  # 7 training days
    totals = day_totals({day: (2200 if i % 2 == 0 else 1800) for i, day in enumerate(days)})
    s = insights.training_summary(date.fromisoformat(days[0]), date.fromisoformat(days[-1]), workouts, 3, days, totals, None, {}, None)
    assert s["training_days"] == 7 and s["workout_minutes"] == 210
    assert s["goal"] == 3 and s["min_days"] == 5
    assert s["trained"] == {"days": 7, "kcal": 2200.0, "protein": 110.0, "kcal_vs_goal": None}
    assert s["rest"]["days"] == 7 and s["rest"]["kcal"] == 1800.0


def test_summary_stays_empty_below_five_days_on_either_side_and_leaves_today_out():
    days = [d(i) for i in range(10)]
    totals = day_totals(dict.fromkeys(days, 2000))
    first, last = date.fromisoformat(days[0]), date.fromisoformat(days[-1])
    four = [{"day": days[i], "minutes": 30} for i in range(4)]  # 4 training days, 6 others
    s = insights.training_summary(first, last, four, 0, days, totals, None, {}, None)
    assert s["trained"] == {"days": 4, "kcal": None, "protein": None, "kcal_vs_goal": None}
    assert s["rest"] == {"days": 6, "kcal": None, "protein": None, "kcal_vs_goal": None}  # one side short: both stay empty
    five = four + [{"day": days[4], "minutes": 30}]  # 5 and 5
    assert insights.training_summary(first, last, five, 0, days, totals, None, {}, None)["rest"]["kcal"] == 2000.0
    # today is not over: left out of both sides, so the rest side drops to 4
    s = insights.training_summary(first, last, five, 0, days, totals, None, {}, last)
    assert s["rest"]["days"] == 4 and s["rest"]["kcal"] is None and s["goal"] is None


def test_summary_distance_to_each_days_own_goal():
    from mahlwerk import goals
    tl = goals.timeline({"kcal": 2000, "protein": 100, "carbs": 200, "fat": 60, "water_ml": 2000, "steps": 8000})
    days = [d(i) for i in range(12)]
    workouts = [{"day": days[i], "minutes": 20} for i in range(6)]
    totals = day_totals({day: (2300 if i < 6 else 1900) for i, day in enumerate(days)})
    s = insights.training_summary(date.fromisoformat(days[0]), date.fromisoformat(days[-1]), workouts, 0, days, totals, tl, {}, None)
    assert s["trained"]["kcal_vs_goal"] == 300.0 and s["rest"]["kcal_vs_goal"] == -100.0


def test_weeks_cover_the_whole_calendar_weeks_touching_the_period():
    # the period is Wednesday to Tuesday; the workouts reach to the whole weeks around it
    first, last = date(2025, 3, 5), date(2025, 3, 11)
    workouts = [{"day": day, "minutes": 30} for day in ("2025-03-03", "2025-03-04", "2025-03-06", "2025-03-12")]
    s = insights.training_summary(first, last, workouts, 0, [], {}, None, {}, None)
    assert s["weeks"] == [{"week_start": "2025-03-03", "training_days": 3}, {"week_start": "2025-03-10", "training_days": 1}]
    assert s["training_days"] == 1 and s["workout_minutes"] == 30  # only 2025-03-06 lies inside


def test_training_block_in_the_api(client):
    food = client.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10}}).json()
    today = date.today()
    for i in range(1, 13):
        day = (today - timedelta(days=i)).isoformat()
        assert client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 500 if i % 2 else 400}).status_code == 201
        if i % 2:
            train(client, day)
    client.patch("/api/v1/me/settings", json={"activity": {"workouts_week": 2}})
    block = client.get("/api/v1/insights", params={"range": "14"}).json()["training"]
    assert block["training_days"] == 6 and block["workout_minutes"] == 180 and block["goal"] == 2
    assert block["trained"]["days"] == 6 and block["rest"]["days"] == 6
    assert block["trained"]["kcal"] == 1000.0 and block["rest"]["kcal"] == 800.0
    assert 2 <= len(block["weeks"]) <= 3 and block["weeks"][0]["week_start"] <= (today - timedelta(days=13)).isoformat()
    assert all(date.fromisoformat(w["week_start"]).weekday() == 0 for w in block["weeks"])


def test_no_workout_in_the_period_means_no_training_block(client):
    assert client.get("/api/v1/insights").json()["training"] is None
    train(client, "2020-01-01")  # long before the period
    assert client.get("/api/v1/insights").json()["training"] is None

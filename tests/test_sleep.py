"""Sleep: the Apple Health sync (minutes asleep in the night that ends on a day) and the sleep-vs-eating card of the evaluation."""

import io
import json
import sqlite3
import zipfile
from datetime import date, timedelta

from conftest import DROP_V20

from mahlwerk import insights
from mahlwerk.db import Store

TODAY = date(2026, 4, 20)


def iso(offset: int) -> str:
    return (TODAY - timedelta(days=offset)).isoformat()


def sync(client, days, **extra):
    r = client.post("/api/v1/health/sync", json={"days": days, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def counts(result: dict) -> tuple[int, int, int, int]:
    s = result["sleep"]
    return s["new"], s["updated"], s["unchanged"], s["skipped"]


def exported(client) -> list[dict]:
    r = client.get("/api/v1/me/export")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        return json.loads(z.read("mahlwerk-export.json"))["sleep"]


def test_new_updated_unchanged_and_overwrite_on_resend(client):
    first = sync(client, [{"day": iso(1), "sleep_minutes": 420}, {"day": iso(2), "sleep_minutes": 380}])
    assert counts(first) == (2, 0, 0, 0)
    assert counts(sync(client, [{"day": iso(1), "sleep_minutes": 420}])) == (0, 0, 1, 0)
    assert counts(sync(client, [{"day": iso(1), "sleep_minutes": 450}])) == (0, 1, 0, 0)  # re-sending overwrites
    assert exported(client) == [{"day": iso(2), "minutes": 380, "source": "health"}, {"day": iso(1), "minutes": 450, "source": "health"}]


def test_under_an_hour_is_skipped_and_missing_is_ignored(client):
    result = sync(client, [{"day": iso(1), "sleep_minutes": 59}, {"day": iso(2), "sleep_minutes": 0},
                           {"day": iso(3), "sleep_minutes": None}, {"day": iso(4)}, {"day": iso(5), "sleep_minutes": 60}])
    assert counts(result) == (1, 0, 0, 2)
    # a night stored earlier stays when a later sync reports "watch not worn"
    assert counts(sync(client, [{"day": iso(5), "sleep_minutes": 20}])) == (0, 0, 0, 1)
    assert client.get("/api/v1/insights", params={"from": iso(5), "to": iso(0)}).json()["sleep"]["nights"] == 1


def test_range_and_unknown_fields(client):
    for bad in (-1, 1441):
        r = client.post("/api/v1/health/sync", json={"days": [{"day": iso(1), "sleep_minutes": bad}]})
        assert r.status_code == 422
    result = sync(client, [{"day": iso(1), "sleep_minutes": 400, "rem_minutes": 90, "whatever": True}])
    assert counts(result) == (1, 0, 0, 0)


def test_sleep_fires_no_activity_row(client):
    sync(client, [{"day": iso(1), "sleep_minutes": 400}])
    with zipfile.ZipFile(io.BytesIO(client.get("/api/v1/me/export").content)) as z:
        assert json.loads(z.read("mahlwerk-export.json"))["activity"] == []


def test_export_contains_sleep(client):
    sync(client, [{"day": iso(1), "sleep_minutes": 400}])
    assert exported(client) == [{"day": iso(1), "minutes": 400, "source": "health"}]


def test_version_19_database_gets_the_sleep_table(tmp_path):
    path = str(tmp_path / "v19.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V20 + """
        INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'a', 'A', 1);
        PRAGMA user_version = 19;
    """)
    con.commit()
    con.close()
    store = Store(path)
    assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone()[0] == 20
    result = store.health_sync(1, [{"day": "2026-01-02", "sleep_minutes": 400}])
    assert result["counts"]["sleep"]["new"] == 1
    Store(path)  # a second start changes nothing
    assert store.sleep_between(1, "2026-01-01", "2026-01-31") == {"2026-01-02": 400}


# --- the comparison --------------------------------------------------------------------------------------------


def day_totals(kcal_by_day: dict[str, float]) -> dict[str, dict]:
    return {d: {"kcal": k, "protein": k / 20} for d, k in kcal_by_day.items()}


def test_summary_groups_and_goal_deviation():
    # the goal rose from 1500 to 2000 in the middle: raw kcal alone would mislead, the deviation does not
    from mahlwerk import goals
    tl = goals.timeline({"kcal": 2000, "protein": 100, "carbs": 200, "fat": 60, "water_ml": 2000, "steps": 8000})
    days = [f"2026-03-{n:02d}" for n in range(1, 21)]
    sleep = {d: (300 if i < 6 else 480) for i, d in enumerate(days)}
    sleep[days[10]] = 390  # 6.5 h: the middle
    totals = day_totals({d: (2300 if i < 6 else 2000) for i, d in enumerate(days)})
    s = insights.sleep_summary(sleep, days, totals, tl, {}, None)
    assert s["nights"] == 20 and s["middle_days"] == 1 and s["compared_days"] == 20
    assert s["short"] == {"days": 6, "kcal": 2300.0, "protein": 115.0, "kcal_vs_goal": 300.0}
    assert s["long"]["days"] == 13 and s["long"]["kcal_vs_goal"] == 0.0
    assert s["avg_minutes"] == round((6 * 300 + 13 * 480 + 390) / 20)


def test_summary_needs_five_days_per_group_and_leaves_today_out():
    days = [f"2026-03-{n:02d}" for n in range(1, 9)]
    sleep = dict.fromkeys(days, 300)
    totals = day_totals(dict.fromkeys(days, 2000))
    s = insights.sleep_summary(sleep, days, totals, None, {}, date(2026, 3, 8))
    assert s["short"]["days"] == 7 and s["short"]["kcal"] == 2000.0 and s["short"]["kcal_vs_goal"] is None  # no goal
    s = insights.sleep_summary(sleep, days, totals, None, {}, date(2026, 3, 5))
    assert s["compared_days"] == 7
    s = insights.sleep_summary(dict.fromkeys(days[:4], 300), days, totals, None, {}, None)
    assert s["short"] == {"days": 4, "kcal": None, "protein": None, "kcal_vs_goal": None} and s["long"]["days"] == 0
    assert insights.sleep_summary({}, days, totals, None, {}, None) is None


def test_unlogged_days_are_not_compared(client):
    sync(client, [{"day": iso(i), "sleep_minutes": 300} for i in range(1, 4)])
    block = client.get("/api/v1/insights", params={"from": iso(5), "to": iso(0)}).json()["sleep"]
    assert block["nights"] == 3 and block["compared_days"] == 0 and block["short"]["days"] == 0 and block["min_days"] == 5


def test_no_sleep_means_null(client):
    assert client.get("/api/v1/insights").json()["sleep"] is None


def test_demo_data_has_sleep_that_goes_with_it(duo):
    ann, _ = duo
    r = ann.post("/api/v1/me/demo-data", json={"days": 30})
    assert r.status_code == 200, r.text
    assert r.json()["sleep"] == 30
    block = ann.get("/api/v1/insights", params={"range": "30"}).json()["sleep"]
    assert block["nights"] == 30 and 330 <= block["avg_minutes"] <= 510
    assert ann.delete("/api/v1/me/demo-data").status_code == 200
    assert ann.get("/api/v1/insights", params={"range": "30"}).json()["sleep"] is None

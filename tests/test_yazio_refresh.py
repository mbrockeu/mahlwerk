"""Refresh of the last days from Yazio (direct sign-in, `days`): Yazio wins for rows that came from Yazio.

Only the HTTP interface is used (no app internals), so the same tests run against the TS server. The stand-in service is the one of
test_yazio_app; its days are laid out relative to today because the refresh period is "the last N days ending today".
"""

import time
from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from mahlwerk.main import create_app
from test_yazio import PRODUCTS, entry, training
from test_yazio_app import CLIENT_ID, CLIENT_SECRET, EMAIL, PASSWORD, URL, FakeYazio, put, wait_done

TODAY = date.today()


def d(n: int) -> str:
    """The day n days ago."""
    return (TODAY - timedelta(days=n)).isoformat()


def content(products=(), quick=(), trainings=(), water=None):
    """One day as the service answers it; an empty day is a real answer with empty lists."""
    summary = {} if water is None else {"water_intake": water}
    return {"consumed": {"products": list(products), "recipe_portions": [], "simple_products": list(quick)},
            "exercises": {"training": list(trainings), "custom_training": []}, "daily_summary": summary}


def oats(eid, amount=80, meal="breakfast"):
    return entry("product", eid, meal, product_id="p-oats", amount=amount)


def run_of(day_entries, weights=None):
    """The service with `day_entries` ({n days ago: content}) and the weights ({n days ago: kg})."""
    fake = FakeYazio(days={d(n): c for n, c in day_entries.items()}, products=PRODUCTS,
                     weights={d(n): kg for n, kg in (weights or {}).items()})
    return fake


@pytest.fixture
def live(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_SECRET", CLIENT_SECRET)
    fake = run_of({})
    c = TestClient(create_app(str(tmp_path / "r.db"), clock=clock, yazio_transport=httpx.MockTransport(fake)))
    assert c.patch("/api/v1/admin/connectors/yazio_login", json={"enabled": True}).status_code == 200
    c.fake, c.clock = fake, clock
    return c


def fill(c, days=31):
    """Days the test did not set are real, empty answers."""
    for n in range(days):
        c.fake.days.setdefault(d(n), content())


def fetch(c, fill_days=True, **body):
    """Sign in, wait for the run; returns the run."""
    if fill_days and "days" in body:
        fill(c, body["days"])
    c.clock.now += 31  # the gap between two attempts
    r = c.post(f"{URL}/login", json={"email": EMAIL, "password": PASSWORD, **body})
    assert r.status_code == 202, r.text
    return wait_done(c)


def full(c):
    assert fetch(c, months=3)["state"] == "done"
    pre = c.post(f"{URL}/preview", json={}).json()
    return c.post(f"{URL}/confirm", json={"token": pre["token"]}).json()


COUNTS = ("entries_total", "entries_updated", "entries_removed", "workouts", "workouts_updated", "workouts_removed", "weights",
          "weights_updated", "water", "water_updated", "activity_days", "activity_updated", "already_imported", "workouts_already")


def expect(pre):
    return {"entries": pre["entries_removed"], "workouts": pre["workouts_removed"]}


def refresh(c, days=7):
    """A refresh run, its preview and its confirmation; the counts of both must be the same."""
    run = fetch(c, days=days)
    assert run["state"] == "done", run
    pre = c.post(f"{URL}/preview", json={}).json()
    done = c.post(f"{URL}/confirm", json={"token": pre["token"], "expect_removed": expect(pre)}).json()
    assert {k: pre[k] for k in COUNTS} == {k: done[k] for k in COUNTS}  # the dry run counts exactly
    return pre, done


def diary(c, n):
    """(name, amount, meal) of the entries of the day n days ago."""
    meals = c.get(f"/api/v1/diary/{d(n)}").json()["meals"]
    return sorted((e["name"], e["amount"], meal) for meal, m in meals.items() for e in m["entries"])


def workouts(c, n):
    days = {a["day"]: a for a in c.get("/api/v1/activity", params={"days": 40}).json()}
    return sorted((w["name"] or w["kind"], w["minutes"], w["source"]) for w in days[d(n)]["workouts"])


def weights(c):
    return {w["day"]: w["kg"] for w in c.get("/api/v1/weights", params={"days": 40}).json()}


def water(c, n):
    return c.get(f"/api/v1/diary/{d(n)}").json()["water"]["ml"]


def batches(c):
    return c.get("/api/v1/me/imports").json()


def seed(live):
    """Yazio days: one entry and one training in the period (days 1, 2), one entry outside it (day 20)."""
    live.fake.days.update({
        d(20): content([oats("old-1", 50)]),
        d(2): content([oats("e-1", 80), oats("e-2", 30, "dinner")], trainings=[training("t-1", "running", 30, 300)]),
        d(1): content([oats("e-3", 40, "lunch")]),
    })
    full(live)
    assert diary(live, 2) == [("Oats", 30, "dinner"), ("Oats", 80, "breakfast")] and diary(live, 20) == [("Oats", 50, "breakfast")]


def test_an_unchanged_refresh_changes_nothing(live):
    seed(live)
    before = (diary(live, 2), diary(live, 1), workouts(live, 2), batches(live))
    pre, done = refresh(live, 7)
    assert pre["refresh"] == {"first_day": d(6), "last_day": d(0), "entries_seen": 3, "workouts_seen": 1}
    assert (pre["entries_updated"], pre["entries_removed"], pre["workouts_updated"], pre["workouts_removed"]) == (0, 0, 0, 0)
    assert (pre["entries_total"], pre["already_imported"], pre["workouts_already"]) == (0, 3, 1)
    assert pre["batch_id"] is None and done["batch_id"] is None  # nothing was written, so no batch is left
    assert (diary(live, 2), diary(live, 1), workouts(live, 2), batches(live)) == before


def test_a_changed_entry_is_updated_in_place_and_keeps_its_batch(live):
    seed(live)
    first_batch = batches(live)[0]["id"]
    live.fake.days[d(2)] = content([oats("e-1", 120, "lunch"), oats("e-2", 30, "dinner")], trainings=[training("t-1", "running", 45, 300)])
    live.fake.days[d(1)] = content([oats("e-3", 40, "lunch")])
    pre, done = refresh(live, 7)
    assert (pre["entries_updated"], pre["entries_removed"], pre["workouts_updated"], pre["already_imported"]) == (1, 0, 1, 2)
    assert diary(live, 2) == [("Oats", 30, "dinner"), ("Oats", 120, "lunch")]
    assert workouts(live, 2) == [("running", 45, "yazio")]
    assert [b["id"] for b in batches(live)] == [first_batch]  # updates are not a batch of their own
    # the updated row still belongs to its first batch: taking that back removes it
    assert live.delete(f"/api/v1/me/imports/{first_batch}").status_code == 200
    assert diary(live, 2) == []


def test_what_is_gone_in_yazio_is_removed_and_a_new_item_comes_in(live):
    seed(live)
    live.fake.days[d(2)] = content([oats("e-2", 30, "dinner"), oats("e-new", 10, "snack")])  # e-1 and the training are gone
    live.fake.days[d(1)] = content()  # e-3 is gone
    pre, done = refresh(live, 7)
    assert (pre["entries_updated"], pre["entries_removed"], pre["workouts_removed"], pre["entries_total"]) == (0, 2, 1, 1)
    assert diary(live, 2) == [("Oats", 10, "snack"), ("Oats", 30, "dinner")] and diary(live, 1) == []
    assert workouts(live, 2) == []
    assert done["batch_id"] and len(batches(live)) == 2
    # taking the refresh back removes only what it inserted; what was removed does not come back
    assert live.delete(f"/api/v1/me/imports/{done['batch_id']}").status_code == 200
    assert diary(live, 2) == [("Oats", 30, "dinner")] and diary(live, 1) == []


def test_an_emptied_period_is_valid_and_shown_in_the_counts(live):
    seed(live)
    live.fake.days.update({d(n): content() for n in range(7)})  # Yazio answers: nothing logged at all
    pre, _ = refresh(live, 7)
    assert pre["refresh"]["entries_seen"] == 0 and pre["entries_removed"] == 3 and pre["workouts_removed"] == 1
    assert diary(live, 2) == [] and diary(live, 20) == [("Oats", 50, "breakfast")]  # the day outside the period stays


def test_an_item_that_is_listed_but_cannot_be_imported_is_not_deleted(live):
    seed(live)
    live.fake.days[d(2)] = content(
        [oats("e-1", 0), entry("product", "e-2", "dinner", product_id="p-gone", amount=30)],  # no valid amount; unknown product
        trainings=[training("t-1", "running", 0)])  # no usable duration
    live.fake.days[d(1)] = content([oats("e-3", 40, "lunch")])
    pre, _ = refresh(live, 7)
    assert pre["entries_removed"] == 0 and pre["workouts_removed"] == 0 and pre["entries_updated"] == 0
    assert pre["refresh"]["entries_seen"] == 3 and pre["refresh"]["workouts_seen"] == 1
    assert len(diary(live, 2)) == 2 and workouts(live, 2) == [("running", 30, "yazio")]  # untouched, as they were


def test_a_failed_day_stops_the_whole_run_and_nothing_is_written(live):
    seed(live)
    before = (diary(live, 2), diary(live, 1), workouts(live, 2), batches(live))
    live.fake.days[d(2)] = content()  # would remove everything of that day ...
    live.fake.days[d(1)] = content()
    for fail in ("missing", "expired", "garbage"):
        if fail == "missing":
            fill(live, 7)
            del live.fake.days[d(1)]  # ... but one day answers 404: no answer, no refresh
        elif fail == "expired":
            live.fake.days[d(1)] = content()
            live.fake.fail_paths = {"/user/exercises": 403}
        else:
            live.fake.fail_paths = {}
            live.fake.days[d(1)] = {"consumed": {"products": "oops", "recipe_portions": [], "simple_products": []}}
        live.clock.now += 3600 if fail != "missing" else 0
        run = fetch(live, fill_days=False, days=7)
        assert run["state"] == "error" and run["error_kind"] in ("unexpected", "expired"), (fail, run)
        assert live.get(URL).json()["stage"] is None
        assert (diary(live, 2), diary(live, 1), workouts(live, 2), batches(live)) == before


def test_own_health_and_outside_rows_are_never_touched(live):
    seed(live)
    food = live.post("/api/v1/foods", json={"name": "Mine", "per_100": {"kcal": 100}}).json()
    manual = live.post(f"/api/v1/diary/{d(2)}/entries", json={"food_id": food["id"], "meal": "snack", "amount": 70}).json()
    assert live.post("/api/v1/workouts", json={"day": d(2), "kind": "cycling", "minutes": 20}).status_code == 201
    health = {"external_id": "hk-1", "kind": "walking", "name": "Walk", "started_at": int(time.time()) - 3 * 86400, "minutes": 25, "kcal": 90}
    assert live.post("/api/v1/health/sync", json={"days": [{"day": d(2), "workouts": [health]}]}).status_code == 200
    live.fake.days.update({d(n): content() for n in range(7)})  # Yazio has nothing in the period any more
    pre, _ = refresh(live, 7)
    assert (pre["entries_removed"], pre["workouts_removed"]) == (3, 1)  # only the Yazio rows
    assert diary(live, 2) == [("Mine", 70, "snack")] and diary(live, 20) == [("Oats", 50, "breakfast")]
    assert sorted(w[2] for w in [*workouts(live, 2)]) == ["health", "manual"]
    assert live.get(f"/api/v1/diary/{d(2)}").json()["meals"]["snack"]["entries"][0]["id"] == manual["id"]


def test_an_entry_the_person_changed_is_theirs(live):
    seed(live)
    first = live.get(f"/api/v1/diary/{d(2)}").json()["meals"]["breakfast"]["entries"][0]
    assert live.patch(f"/api/v1/diary/entries/{first['id']}", json={"amount": 99}).status_code == 200
    live.fake.days[d(2)] = content([oats("e-1", 80), oats("e-2", 30, "dinner")], trainings=[training("t-1", "running", 30, 300)])
    pre, _ = refresh(live, 7)
    assert pre["entries_updated"] == 0 and pre["entries_removed"] == 0 and pre["entries_total"] == 0
    assert ("Oats", 99, "breakfast") in diary(live, 2)  # still the person's value
    live.fake.days[d(2)] = content([oats("e-2", 30, "dinner")], trainings=[training("t-1", "running", 30, 300)])  # e-1 deleted in Yazio
    pre, _ = refresh(live, 7)
    assert pre["entries_removed"] == 0 and ("Oats", 99, "breakfast") in diary(live, 2)  # the change made it their own entry


def test_an_entry_moved_into_the_period_is_not_pulled_over_from_outside(live):
    seed(live)
    live.fake.days[d(20)] = content()
    live.fake.days[d(2)] = content([oats("e-1", 80), oats("e-2", 30, "dinner"), oats("old-1", 50)],
                                   trainings=[training("t-1", "running", 30, 300)])
    pre, _ = refresh(live, 7)
    assert pre["entries_updated"] == 0 and pre["entries_total"] == 0 and pre["already_imported"] == 4
    assert diary(live, 20) == [("Oats", 50, "breakfast")] and len(diary(live, 2)) == 2  # rows outside the period are never touched


def test_weight_and_water_of_yazio_origin_are_updated_but_not_the_persons_own(live):
    assert live.put(f"/api/v1/weights/{d(3)}", json={"kg": 70.0}).status_code == 200
    assert live.put(f"/api/v1/water/{d(1)}", json={"ml": 800}).status_code == 200
    live.fake.days.update({d(20): content([oats("old-1")]), d(2): content([oats("e-1")], water=1500), d(1): content([oats("e-2")], water=2000)})
    live.fake.weights = {d(40): 80.0, d(3): 79.0, d(2): 81.0}
    full(live)
    assert weights(live) == {d(20): 80.0, d(3): 70.0, d(2): 81.0} and water(live, 2) == 1500 and water(live, 1) == 800
    live.fake.weights = {d(40): 80.0, d(3): 79.0, d(2): 82.0}  # Yazio: the weight of day 2 changed; day 3 differs from the manual value
    live.fake.days.update({d(2): content([oats("e-1")], water=1800), d(1): content([oats("e-2")], water=2500)})
    pre, _ = refresh(live, 7)
    assert (pre["weights_updated"], pre["water_updated"], pre["weights"], pre["water"]) == (1, 1, 0, 0)
    assert weights(live) == {d(20): 80.0, d(3): 70.0, d(2): 82.0}  # the old one (outside) and the manual one stay
    assert water(live, 2) == 1800 and water(live, 1) == 800


def test_what_is_asked_and_what_is_not(live):
    seed(live)
    live.fake.days.update({d(n): content() for n in range(7)})
    seen = len(live.fake.requests)
    fetch(live, days=3)
    new = live.fake.requests[seen:]
    assert not [r for r in new if r.url.path.endswith("/nutrients-daily")]  # no listing of the days with entries: every day directly
    assert sorted(r.url.params["date"] for r in new if r.url.path.endswith("/user/consumed-items")) == [d(2), d(1), d(0)]
    # the weight is asked for the day before the period, too, so that the first day does not carry an older value
    assert d(3) in {r.url.params["date"] for r in new if r.url.path.endswith("/bodyvalues/weight/last")}


def test_the_period_is_one_of_months_or_days(live):
    body = {"email": EMAIL, "password": PASSWORD}
    assert live.post(f"{URL}/login", json={**body, "months": 3, "days": 7}).status_code == 422
    for bad in (0, 32, 7.5, -1):
        r = live.post(f"{URL}/login", json={**body, "days": bad})
        assert r.status_code == 422, bad
        assert PASSWORD not in r.text
    assert not live.fake.requests
    assert live.post(f"{URL}/login", json={**body, "days": 31}).status_code == 202
    wait_done(live)


def test_an_upload_after_a_refresh_is_an_ordinary_import(live):
    seed(live)
    live.fake.days.update({d(n): content() for n in range(7)})
    assert fetch(live, days=7)["state"] == "done"
    assert live.get(URL).json()["stage"]["source"] == "login"
    for name, data in (("days.json", {d(2): content([oats("u-1", 10)])}), ("products.json", PRODUCTS), ("weight.json", {})):
        assert put(live, name, data).status_code == 200
    pre = live.post(f"{URL}/preview", json={}).json()
    assert pre["refresh"] is None and pre["entries_removed"] == 0 and pre["entries_total"] == 1


def snapshot(c):
    return (diary(c, 2), diary(c, 1), diary(c, 20), workouts(c, 2), batches(c))


def test_exercises_without_both_lists_abort_and_nothing_is_written(live):
    seed(live)
    before = snapshot(live)
    fill(live, 7)
    live.fake.days[d(2)] = content()
    for bad in ({}, {"training": []}, {"custom_training": []}, {"training": [], "custom_training": "x"}):
        live.fake.days[d(1)] = {**content(), "exercises": bad}
        run = fetch(live, fill_days=False, days=7)
        live.clock.now += 3600
        assert run["state"] == "error" and run["error_kind"] == "unexpected", bad
        assert live.get(URL).json()["stage"] is None
        assert snapshot(live) == before


def test_confirm_of_a_refresh_needs_the_removals_that_were_shown(live):
    seed(live)
    live.fake.days[d(2)] = content([oats("e-2", 30, "dinner")])  # e-1 and the training are gone
    live.fake.days[d(1)] = content([oats("e-3", 40, "lunch")])
    assert fetch(live, days=7)["state"] == "done"
    pre = live.post(f"{URL}/preview", json={}).json()
    assert (pre["entries_removed"], pre["workouts_removed"]) == (1, 1)
    before = snapshot(live)
    missing = live.post(f"{URL}/confirm", json={"token": pre["token"]})
    assert missing.status_code == 422 and "expect_removed" in missing.json()["detail"]
    wrong = live.post(f"{URL}/confirm", json={"token": pre["token"], "expect_removed": {"entries": 0, "workouts": 1}})
    assert wrong.status_code == 409 and "changed since the preview" in wrong.json()["detail"]
    wrong = live.post(f"{URL}/confirm", json={"token": pre["token"], "expect_removed": {"entries": 1, "workouts": 0}})
    assert wrong.status_code == 409
    assert snapshot(live) == before and live.get(URL).json()["stage"] is not None  # nothing written, still waiting
    ok = live.post(f"{URL}/confirm", json={"token": pre["token"], "expect_removed": {"entries": 1, "workouts": 1}})
    assert ok.status_code == 200 and diary(live, 2) == [("Oats", 30, "dinner")] and workouts(live, 2) == []


def test_an_ordinary_confirm_does_not_need_expect_removed(live):
    seed(live)
    assert put(live, "days.json", {d(2): content([oats("u-1", 10)])}).status_code == 200
    put(live, "products.json", PRODUCTS)
    put(live, "weight.json", {})
    pre = live.post(f"{URL}/preview", json={}).json()
    assert live.post(f"{URL}/confirm", json={"token": pre["token"]}).status_code == 200

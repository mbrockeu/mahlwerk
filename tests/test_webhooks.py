"""Outgoing webhooks. Receivers are small HTTP servers on 127.0.0.1 in a thread; nothing leaves the machine."""

import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from mahlwerk.main import create_app
from mahlwerk.routes.diary import today

HOOKS = "/api/v1/me/webhooks"


class Receiver:
    """Records every request. `statuses` is consumed one per request (the last one repeats); `delay` slows the answer."""

    def __init__(self):
        self.hits: list[dict] = []
        self.statuses = [200]
        self.delay = 0.0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.hits.append({"path": self.path, "headers": dict(self.headers), "body": body})
                if outer.delay:
                    time.sleep(outer.delay)
                status = outer.statuses.pop(0) if len(outer.statuses) > 1 else outer.statuses[0]
                self.send_response(status)
                if status in (301, 302):
                    self.send_header("Location", "/followed")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/hook"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def events(self) -> list[str]:
        return [h["headers"]["X-Mahlwerk-Event"] for h in self.hits]


@pytest.fixture
def receiver():
    r = Receiver()
    yield r
    r.stop()


@pytest.fixture
def app(tmp_path):
    app = create_app(str(tmp_path / "w.db"))
    app.state.webhooks.backoff = (0.01, 0.01)
    # the receivers run on loopback: that is only allowed because the admin names the host (see test_ssrf below)
    app.state.store.set_global("webhooks.hosts", ["127.0.0.1"])
    return app


@pytest.fixture
def wc(app):
    return TestClient(app)


def settle(app):
    assert app.state.webhooks.wait_idle(15)


def add_hook(client, url, events=("entry.created",), **extra) -> dict:
    r = client.post(HOOKS, json={"name": "test", "url": url, "events": list(events), **extra})
    assert r.status_code == 201, r.text
    return r.json()


def entry(client, food, amount=100):
    return client.post(f"/api/v1/diary/{today().isoformat()}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": amount})


@pytest.fixture
def oats(wc):
    body = {"name": "Oats", "brand": "Acme", "serving_size": "40 g", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}
    return wc.post("/api/v1/foods", json=body).json()


def test_the_secret_is_shown_once(wc):
    created = add_hook(wc, "http://127.0.0.1:9/x")
    assert created["secret"].startswith("whsec_") and created["enabled"] is True
    listed = wc.get(HOOKS).json()
    assert [h["id"] for h in listed] == [created["id"]]
    assert "secret" not in listed[0] and created["secret"] not in wc.get(HOOKS).text


def test_an_entry_is_delivered_with_a_valid_signature(app, wc, oats, receiver):
    hook = add_hook(wc, receiver.url)
    e = entry(wc, oats, 150).json()
    settle(app)
    (hit,) = receiver.hits
    body = hit["body"]
    expected = "sha256=" + hmac.new(hook["secret"].encode(), body, hashlib.sha256).hexdigest()
    assert hit["headers"]["X-Mahlwerk-Signature"] == expected
    assert hit["headers"]["X-Mahlwerk-Event"] == "entry.created"
    assert hit["headers"]["Content-Type"] == "application/json" and hit["path"] == "/hook"
    payload = json.loads(body)
    assert payload["event"] == "entry.created" and payload["user"] == {"username": "me"}
    assert payload["occurred_at"].endswith("Z")
    assert payload["data"]["entry"] == {"id": e["id"], "name": "Oats", "brand": "Acme", "amount": 150, "unit": "g",
                                         "kcal": 300, "meal": "lunch", "day": today().isoformat()}
    assert payload["data"]["day_kcal"] == 300
    (delivery,) = wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()
    assert hit["headers"]["X-Mahlwerk-Delivery"] == str(delivery["id"])
    assert delivery["status_code"] == 200 and delivery["attempts"] == 1 and delivery["error"] is None
    assert delivery["event"] == "entry.created" and delivery["finished_at"] is not None


def test_every_event_fires(app, wc, oats, receiver):
    add_hook(wc, receiver.url, events=[
        "entry.created", "entry.updated", "entry.deleted", "weight.recorded", "water.changed",
        "fasting.started", "fasting.ended", "goal.changed", "badge.earned"])
    day = today().isoformat()
    e = entry(wc, oats).json()
    wc.patch(f"/api/v1/diary/entries/{e['id']}", json={"amount": 50})
    wc.delete(f"/api/v1/diary/entries/{e['id']}")
    wc.put(f"/api/v1/weights/{day}", json={"kg": 80})
    wc.post(f"/api/v1/water/{day}", json={"add_ml": 250})
    wc.put(f"/api/v1/water/{day}", json={"ml": 1000})
    wc.post("/api/v1/fasting/start", json={})
    wc.post("/api/v1/fasting/stop", json={})
    wc.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 60})
    entry(wc, oats)
    wc.get("/api/v1/badges")  # badges are evaluated when asked for; the first entry earns one
    settle(app)
    seen = receiver.events()
    for name in ("entry.created", "entry.updated", "entry.deleted", "weight.recorded", "water.changed",
                 "fasting.started", "fasting.ended", "goal.changed", "badge.earned"):
        assert name in seen, name
    assert seen.count("water.changed") == 2
    by_event = {h["headers"]["X-Mahlwerk-Event"]: json.loads(h["body"])["data"] for h in receiver.hits}
    assert by_event["weight.recorded"] == {"day": day, "kg": 80}
    assert by_event["water.changed"]["goal_ml"] == 2000
    assert by_event["goal.changed"]["kcal"] == 2000
    assert by_event["fasting.ended"]["target_reached"] is False and by_event["badge.earned"]["code"]
    assert by_event["entry.deleted"]["entry"]["amount"] == 50


def test_activity_and_workout_events(app, wc, receiver):
    add_hook(wc, receiver.url, events=["activity.recorded", "workout.created"])
    day = today().isoformat()
    wc.put(f"/api/v1/activity/{day}", json={"steps": 4200, "active_kcal": 180})
    w = wc.post("/api/v1/workouts", json={"day": day, "kind": "yoga", "minutes": 30}).json()
    wc.patch(f"/api/v1/workouts/{w['id']}", json={"minutes": 40})  # changes are not announced
    wc.post("/api/v1/health/sync", json={"days": [
        {"day": day, "steps": 5000, "workouts": [{"external_id": "h1", "kind": "running", "minutes": 20}]},
        {"day": "2025-03-03", "active_kcal": 300}]})
    wc.post("/api/v1/health/sync", json={"days": [{"day": day, "steps": 5000}]})  # nothing changed: silent
    settle(app)
    assert sorted(receiver.events()) == ["activity.recorded"] * 2 + ["workout.created"] * 2  # today's row is manual: the sync leaves it
    bodies = [json.loads(h["body"]) for h in receiver.hits]
    first = next(b for b in bodies if b["event"] == "activity.recorded")
    assert first["data"] == {"day": day, "steps": 4200, "active_kcal": 180, "distance_m": None, "source": "manual"}
    created = [b["data"] for b in bodies if b["event"] == "workout.created"]
    assert {c["kind"] for c in created} == {"yoga", "running"} and all(c["kcal_estimated"] for c in created)
    assert {"day": "2025-03-03", "steps": None, "active_kcal": 300, "distance_m": None, "source": "health"} in [
        b["data"] for b in bodies if b["event"] == "activity.recorded"]


def test_copying_and_templates_announce_every_entry(app, wc, oats, receiver):
    day = today().isoformat()
    entry(wc, oats)
    entry(wc, oats)
    add_hook(wc, receiver.url)
    wc.post(f"/api/v1/diary/{day}/copy", json={"from_day": day, "meal": "lunch", "to_meal": "dinner"})
    settle(app)
    assert receiver.events() == ["entry.created", "entry.created"]


def test_only_the_chosen_events_are_sent(app, wc, oats, receiver):
    add_hook(wc, receiver.url, events=["weight.recorded"])
    entry(wc, oats)
    wc.put(f"/api/v1/weights/{today().isoformat()}", json={"kg": 79})
    settle(app)
    assert receiver.events() == ["weight.recorded"]


def test_a_disabled_hook_is_silent_and_can_be_enabled(app, wc, oats, receiver):
    hook = add_hook(wc, receiver.url, enabled=False)
    assert hook["enabled"] is False
    entry(wc, oats)
    settle(app)
    assert receiver.hits == []
    assert wc.patch(f"{HOOKS}/{hook['id']}", json={"enabled": True}).json()["enabled"] is True
    entry(wc, oats)
    settle(app)
    assert len(receiver.hits) == 1


def test_patch_and_delete(wc, receiver):
    hook = add_hook(wc, receiver.url)
    r = wc.patch(f"{HOOKS}/{hook['id']}", json={"name": "renamed", "events": ["goal.changed", "goal.changed"]})
    assert r.json()["name"] == "renamed" and r.json()["events"] == ["goal.changed"]
    assert wc.patch(f"{HOOKS}/{hook['id']}", json={"url": "ftp://x.example/"}).status_code == 422
    assert wc.delete(f"{HOOKS}/{hook['id']}").status_code == 204
    assert wc.get(HOOKS).json() == [] and wc.delete(f"{HOOKS}/{hook['id']}").status_code == 404
    assert wc.get(f"{HOOKS}/{hook['id']}/deliveries").status_code == 404


def test_the_test_button_sends_a_ping(app, wc, receiver):
    hook = add_hook(wc, receiver.url, events=["goal.changed"])  # a ping goes out whatever the hook listens to
    assert wc.post(f"{HOOKS}/{hook['id']}/test").status_code == 202
    settle(app)
    assert receiver.events() == ["ping"]
    assert json.loads(receiver.hits[0]["body"])["data"]["hook"] == "test"
    assert wc.post(f"{HOOKS}/999/test").status_code == 404


def test_only_http_targets(wc):
    for url in ("ftp://hooks.example/x", "file:///etc/passwd", "javascript:alert(1)", "hooks.example", "http://",
                "http://user:pw@hooks.example/x", "http://" + "a" * 600 + ".example/"):
        assert wc.post(HOOKS, json={"name": "x", "url": url, "events": ["entry.created"]}).status_code == 422, url
    assert wc.post(HOOKS, json={"name": "x", "url": "https://hooks.example/x", "events": []}).status_code == 422
    assert wc.post(HOOKS, json={"name": "x", "url": "https://hooks.example/x", "events": ["nope"]}).status_code == 422


def test_a_failing_receiver_is_retried_then_succeeds(app, wc, oats, receiver):
    receiver.statuses = [500, 503, 200]
    hook = add_hook(wc, receiver.url)
    entry(wc, oats)
    settle(app)
    assert len(receiver.hits) == 3
    (d,) = wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()
    assert d["attempts"] == 3 and d["status_code"] == 200 and d["error"] is None


def test_it_gives_up_after_three_tries(app, wc, oats, receiver):
    receiver.statuses = [500]
    hook = add_hook(wc, receiver.url)
    r = entry(wc, oats)
    assert r.status_code == 201  # the request is not affected
    settle(app)
    assert len(receiver.hits) == 3
    (d,) = wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()
    assert d["attempts"] == 3 and d["status_code"] == 500 and d["error"] == "HTTP 500"


def test_a_clear_no_is_not_retried(app, wc, oats, receiver):
    receiver.statuses = [404]
    hook = add_hook(wc, receiver.url)
    entry(wc, oats)
    settle(app)
    assert len(receiver.hits) == 1
    assert wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()[0]["error"] == "HTTP 404"


def test_an_unreachable_receiver_does_not_hurt(app, wc, oats):
    hook = add_hook(wc, "http://127.0.0.1:1/nothing")
    assert entry(wc, oats).status_code == 201
    settle(app)
    (d,) = wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()
    assert d["attempts"] == 3 and d["error"] == "delivery failed" and d["status_code"] is None


def test_a_slow_receiver_does_not_block_the_request(app, wc, oats, receiver):
    receiver.delay = 1.5
    app.state.webhooks.timeout = 0.3
    hook = add_hook(wc, receiver.url)
    started = time.monotonic()
    assert entry(wc, oats).status_code == 201
    assert time.monotonic() - started < 0.5
    settle(app)
    (d,) = wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()
    assert d["error"] == "delivery failed" and d["attempts"] == 3


def test_redirects_are_not_followed(app, wc, oats, receiver):
    receiver.statuses = [302]
    hook = add_hook(wc, receiver.url)
    entry(wc, oats)
    settle(app)
    assert [h["path"] for h in receiver.hits] == ["/hook"]
    assert wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()[0]["error"] == "HTTP 302"


def test_only_the_last_twenty_deliveries_are_kept(app, wc, oats, receiver):
    hook = add_hook(wc, receiver.url)
    for _ in range(23):
        entry(wc, oats)
    settle(app)
    deliveries = wc.get(f"{HOOKS}/{hook['id']}/deliveries").json()
    assert len(deliveries) == 20 and len(receiver.hits) == 23
    assert deliveries == sorted(deliveries, key=lambda d: -d["id"])


def test_host_restriction(app, wc, oats, receiver):
    early = add_hook(wc, receiver.url)  # registered before the restriction
    assert wc.patch("/api/v1/admin/connectors/webhooks", json={"config": {"hosts": ["Hooks.Example"]}}).json()["config"] == {"hosts": ["hooks.example"]}
    assert wc.post(HOOKS, json={"name": "x", "url": receiver.url, "events": ["entry.created"]}).status_code == 422
    allowed = wc.post(HOOKS, json={"name": "x", "url": "https://hooks.example/in", "events": ["entry.created"]})
    assert allowed.status_code == 201
    # switched off again: the test is about what may be registered, and a delivery to that name would need a network
    assert wc.patch(f"{HOOKS}/{allowed.json()['id']}", json={"enabled": False}).status_code == 200
    assert wc.patch(f"{HOOKS}/{early['id']}", json={"url": "http://elsewhere.example/"}).status_code == 422
    entry(wc, oats)
    settle(app)
    assert receiver.hits == []  # the old hook is blocked as well
    assert wc.get(f"{HOOKS}/{early['id']}/deliveries").json()[0]["error"] == "target not allowed"
    wc.patch("/api/v1/admin/connectors/webhooks", json={"config": {"hosts": ["127.0.0.1"]}})
    entry(wc, oats)
    settle(app)
    assert len(receiver.hits) == 1


def test_switched_off_in_the_admin_area(app, wc, oats, receiver):
    add_hook(wc, receiver.url)
    wc.patch("/api/v1/admin/connectors/webhooks", json={"enabled": False})
    assert wc.get(HOOKS).status_code == 404 and wc.get("/api/v1/me").json()["features"]["webhooks"] is False
    entry(wc, oats)
    settle(app)
    assert receiver.hits == []
    wc.patch("/api/v1/admin/connectors/webhooks", json={"enabled": True})
    entry(wc, oats)
    settle(app)
    assert len(receiver.hits) == 1


def test_switched_off_by_the_environment(monkeypatch, app, wc, oats, receiver):
    add_hook(wc, receiver.url)
    monkeypatch.setenv("MAHLWERK_WEBHOOKS", "off")
    entry(wc, oats)
    settle(app)
    assert receiver.hits == [] and wc.get(HOOKS).status_code == 404
    connector = next(c for c in wc.get("/api/v1/admin/connectors").json() if c["key"] == "webhooks")
    assert connector["enabled"] is False and "enabled" in connector["locked"]
    assert wc.patch("/api/v1/admin/connectors/webhooks", json={"enabled": True}).status_code == 409


def test_users_are_kept_apart(duo, receiver):
    ann, ben = duo
    app = ann.app
    app.state.webhooks.backoff = (0.01, 0.01)
    app.state.store.set_global("webhooks.hosts", ["127.0.0.1"])
    hook = add_hook(ann, receiver.url, events=["weight.recorded"])
    ben.put(f"/api/v1/weights/{today().isoformat()}", json={"kg": 90})
    settle(app)
    assert receiver.hits == []  # ben's event is not ann's business
    ann.put(f"/api/v1/weights/{today().isoformat()}", json={"kg": 70})
    settle(app)
    assert json.loads(receiver.hits[0]["body"])["user"] == {"username": "ann"}
    assert ben.get(HOOKS).json() == []
    assert ben.patch(f"{HOOKS}/{hook['id']}", json={"name": "mine"}).status_code == 404
    assert ben.delete(f"{HOOKS}/{hook['id']}").status_code == 404
    assert ben.post(f"{HOOKS}/{hook['id']}/test").status_code == 404
    assert ben.get(f"{HOOKS}/{hook['id']}/deliveries").status_code == 404


def test_the_sender_can_be_replaced(app, wc, oats):
    calls = []
    app.state.webhooks.sender = lambda url, body, headers, timeout: calls.append((url, headers["X-Mahlwerk-Event"], timeout)) or 204
    add_hook(wc, "http://127.0.0.1:9/in")
    entry(wc, oats)
    settle(app)
    assert calls == [("http://127.0.0.1:9/in", "entry.created", 5.0)]


def test_the_worker_stops_cleanly(tmp_path, receiver):
    app = create_app(str(tmp_path / "s.db"))
    app.state.store.set_global("webhooks.hosts", ["127.0.0.1"])
    with TestClient(app) as client:
        add_hook(client, receiver.url, events=["goal.changed"])
        client.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 60})
        settle(app)
        thread = app.state.webhooks._thread
        assert thread.is_alive()
    thread.join(5)
    assert not thread.is_alive()
    app.state.webhooks.publish(1, "me", "goal.changed", {})  # after stopping: ignored, no error

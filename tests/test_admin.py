"""The admin area: who is an admin, the overview, users (counts only), connectors and the catalogue refresh."""

import sqlite3

import pytest
from conftest import UNKNOWN
from fastapi.testclient import TestClient
from test_catalog import ean, gz, line, per

from mahlwerk import __version__
from mahlwerk.main import create_app

ADMIN_ROUTES = (
    ("GET", "/api/v1/admin/overview"),
    ("GET", "/api/v1/admin/users"),
    ("GET", "/api/v1/admin/connectors"),
    ("PATCH", "/api/v1/admin/connectors/webhooks"),
    ("GET", "/api/v1/admin/catalog/refresh"),
    ("POST", "/api/v1/admin/catalog/refresh"),
)


def proxy_app(monkeypatch, tmp_path, **env):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return create_app(str(tmp_path / "a.db"))


def as_user(app, name, groups=None, **extra):
    headers = {"Remote-User": name, **({"Remote-Groups": groups} if groups is not None else {}), **extra}
    return TestClient(app, client=("10.0.0.5", 1), headers=headers)


def test_admin_comes_from_the_group_header(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    assert as_user(app, "ann", "family,admin").get("/api/v1/me").json()["is_admin"] is True
    assert as_user(app, "ann", "family, admin ").get("/api/v1/me").json()["is_admin"] is True
    assert as_user(app, "ann", "family").get("/api/v1/me").json()["is_admin"] is False
    assert as_user(app, "ann", "administrators,adminx").get("/api/v1/me").json()["is_admin"] is False
    assert as_user(app, "ann").get("/api/v1/me").json()["is_admin"] is False


def test_group_header_and_group_name_are_configurable(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path, MAHLWERK_PROXY_GROUPS_HEADER="X-Groups", MAHLWERK_ADMIN_GROUP="root")
    assert as_user(app, "ann", "admin", **{"X-Groups": "root"}).get("/api/v1/me").json()["is_admin"] is True
    assert as_user(app, "ann", "root").get("/api/v1/me").json()["is_admin"] is False  # the default header is not read


def test_admin_is_decided_per_request_not_stored(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    assert as_user(app, "ann", "admin").get("/api/v1/me").json()["is_admin"] is True
    assert as_user(app, "ann", "family").get("/api/v1/me").json()["is_admin"] is False  # demoted at the next request
    assert as_user(app, "ann", "family").get("/api/v1/admin/overview").status_code == 403


def test_a_stranger_cannot_claim_admin(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    stranger = TestClient(app, client=("203.0.113.9", 1), headers={"Remote-User": "ann", "Remote-Groups": "admin"})
    assert stranger.get("/api/v1/admin/overview").status_code == 401


def test_the_single_user_is_admin(client):
    assert client.get("/api/v1/me").json()["is_admin"] is True
    assert client.get("/api/v1/admin/overview").status_code == 200


def test_non_admins_get_403_everywhere(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    member = as_user(app, "ben", "family")
    for method, path in ADMIN_ROUTES:
        assert member.request(method, path, json={}).status_code == 403, path
    assert member.get("/api/v1/admin/nothing").status_code in (403, 404)


def test_a_token_never_opens_the_admin_area(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    admin = as_user(app, "ann", "admin")
    token = admin.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}).json()["token"]
    bare = TestClient(app, client=("203.0.113.9", 1), headers={"Authorization": f"Bearer {token}"})
    for method, path in ADMIN_ROUTES:
        assert bare.request(method, path, json={}).status_code == 403, path


def test_overview(client, food, tmp_path):
    client.post("/api/v1/diary/2026-01-10/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    body = client.get("/api/v1/admin/overview").json()
    assert body["version"] == __version__ and body["auth_mode"] == "single" and body["schema_version"] == 14
    assert body["db_size_bytes"] > 0 and body["users"] == 1 and body["entries"] == 1 and body["foods"] == 1
    assert body["catalog"] == {"products": 0, "updated_at": None, "bls": {"products": 0, "updated_at": None}}


def test_users_list_has_counts_and_no_personal_data(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    ann, ben = as_user(app, "ann", "admin", **{"Remote-Name": "Ann A."}), as_user(app, "ben", "family")
    food = ann.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200}}).json()
    for day in ("2026-01-10", "2026-01-12"):
        ann.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    ann.put("/api/v1/weights/2026-01-10", json={"kg": 81.37})
    ann.put("/api/v1/me/goal", json={"kcal": 2100, "protein": 100, "carbs": 250, "fat": 60})
    ann.post("/api/v1/me/tokens", json={"name": "a", "scope": "read"})
    revoked = ann.post("/api/v1/me/tokens", json={"name": "b", "scope": "read"}).json()
    ann.delete(f"/api/v1/me/tokens/{revoked['id']}")
    ann.post("/api/v1/me/webhooks", json={"name": "w", "url": "http://hooks.example/x", "events": ["goal.changed"]})
    ben.get("/api/v1/me")
    users = ann.get("/api/v1/admin/users").json()
    assert [u["username"] for u in users] == ["ann", "ben"]
    first, second = users
    assert first["display_name"] == "Ann A." and first["entries"] == 2
    assert (first["first_day"], first["last_day"], first["tokens"], first["webhooks"]) == ("2026-01-10", "2026-01-12", 1, 1)
    assert (second["entries"], second["first_day"], second["tokens"], second["webhooks"]) == (0, None, 0, 0)
    assert set(first) == {"username", "display_name", "created_at", "entries", "first_day", "last_day", "tokens", "webhooks",
                        "disabled", "admin", "has_password", "demo"}
    text = ann.get("/api/v1/admin/users").text
    assert "81.37" not in text and "2100" not in text and "Oats" not in text


def connectors(client) -> dict:
    return {c["key"]: c for c in client.get("/api/v1/admin/connectors").json()}


def test_connector_list(client):
    c = connectors(client)
    assert list(c) == ["openfoodfacts_lookup", "openfoodfacts_catalog", "bls", "cookidoo", "web_recipes", "yazio_import", "yazio_login",
                       "label_reader",
                       "demo_data", "demo_account", "access_tokens", "webhooks"]
    kinds = {k: v["kind"] for k, v in c.items()}
    assert kinds["openfoodfacts_lookup"] == kinds["bls"] == "source" and kinds["yazio_import"] == "import"
    assert kinds["access_tokens"] == kinds["webhooks"] == "interface"
    assert {k for k, v in c.items() if v["configurable"]} == {"openfoodfacts_lookup", "openfoodfacts_catalog", "cookidoo", "web_recipes", "yazio_login", "demo_account", "access_tokens", "webhooks"}
    assert c["openfoodfacts_lookup"]["enabled"] is True and c["openfoodfacts_catalog"]["status"] == "empty"
    assert c["openfoodfacts_catalog"]["config"] == {"countries": ["en:germany"]}
    assert c["webhooks"]["config"] == {"hosts": []} and c["access_tokens"]["info"] == {"active": 0}
    assert c["demo_data"]["enabled"] is False and c["bls"]["info"]["cli"] is True and c["yazio_import"]["info"]["batches"] == 0
    assert all(v["locked"] == [] for v in c.values())
    assert isinstance(c["label_reader"]["enabled"], bool)


def test_switching_the_live_lookup_off_stops_upstream_calls(client, upstream):
    assert client.get(f"/api/v1/foods/barcode/{UNKNOWN}").status_code == 404
    assert upstream.calls == 1
    r = client.patch("/api/v1/admin/connectors/openfoodfacts_lookup", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["status"] == "off"
    calls = upstream.calls
    other = "3017620422003"
    assert client.get(f"/api/v1/foods/barcode/{other}").status_code == 404  # not known locally, and nobody is asked
    assert client.get(f"/api/v1/foods/barcode/{UNKNOWN}").status_code == 404
    assert upstream.calls == calls
    client.patch("/api/v1/admin/connectors/openfoodfacts_lookup", json={"enabled": True})
    assert client.get(f"/api/v1/foods/barcode/{other}").status_code == 200
    assert upstream.calls == calls + 1


def test_the_local_catalogue_still_answers_when_the_lookup_is_off(client, upstream, tmp_path):
    from mahlwerk.catalog import import_off
    client.patch("/api/v1/admin/connectors/openfoodfacts_lookup", json={"enabled": False})
    code = ean("400000000001")
    import_off(str(tmp_path / "catalog.db"), ["en:germany"], gz(tmp_path / "o.csv.gz", [line(code, "Apfel", "47", **per())]))
    assert client.get(f"/api/v1/foods/barcode/{code}").status_code == 200
    assert upstream.calls == 0


def test_environment_wins_and_is_shown_as_fixed(monkeypatch, client):
    monkeypatch.setenv("MAHLWERK_OFF_LOOKUP", "off")
    c = connectors(client)["openfoodfacts_lookup"]
    assert c["enabled"] is False and c["locked"] == ["enabled"]
    assert client.patch("/api/v1/admin/connectors/openfoodfacts_lookup", json={"enabled": True}).status_code == 409
    monkeypatch.setenv("MAHLWERK_OFF_COUNTRIES", "en:austria, en:switzerland")
    c = connectors(client)["openfoodfacts_catalog"]
    assert c["config"]["countries"] == ["en:austria", "en:switzerland"] and c["locked"] == ["config.countries"]
    assert client.patch("/api/v1/admin/connectors/openfoodfacts_catalog", json={"config": {"countries": ["en:france"]}}).status_code == 409


def test_connector_settings_are_validated(client):
    patch = lambda key, body: client.patch(f"/api/v1/admin/connectors/{key}", json=body)
    assert patch("nothing", {"enabled": True}).status_code == 404
    assert patch("bls", {"enabled": False}).status_code == 422
    assert patch("demo_data", {"enabled": True}).status_code == 422
    assert patch("openfoodfacts_catalog", {"enabled": False}).status_code == 422
    assert patch("openfoodfacts_lookup", {"config": {"x": 1}}).status_code == 422
    assert patch("openfoodfacts_catalog", {"config": {"countries": []}}).status_code == 422
    assert patch("openfoodfacts_catalog", {"config": {"countries": ["nonsense!"]}}).status_code == 422
    assert patch("openfoodfacts_catalog", {"config": {"other": ["en:austria"]}}).status_code == 422
    assert patch("webhooks", {"config": {"hosts": ["not a host"]}}).status_code == 422
    assert patch("webhooks", {"config": {"hosts": "hooks.example"}}).status_code == 422
    ok = patch("openfoodfacts_catalog", {"config": {"countries": ["Austria", "en:germany", "austria"]}})
    assert ok.status_code == 200 and ok.json()["config"] == {"countries": ["en:austria", "en:germany"]}
    assert connectors(client)["openfoodfacts_catalog"]["config"] == {"countries": ["en:austria", "en:germany"]}


def test_catalogue_refresh_is_idle_at_first(client):
    assert client.get("/api/v1/admin/catalog/refresh").json() == {
        "state": "idle", "started_at": None, "finished_at": None, "progress": None, "countries": [], "result": None, "error": None}


@pytest.fixture
def refreshing(client, tmp_path):
    """A catalogue refresh from a small local file; the file can be made to wait until released."""
    import threading
    from mahlwerk import jobs
    path = gz(tmp_path / "src.csv.gz", [line(ean("400000000001"), "Apfel", "47", **per()),
                                          line(ean("400000000002"), "Birne", "50", **per())])
    gate = threading.Event()
    real = jobs.import_off

    def slow(*args, **kwargs):
        gate.wait(10)
        return real(*args, **kwargs)

    jobs.import_off = slow
    client.app.state.refresh.source = path
    yield client, gate
    jobs.import_off = real
    gate.set()


def test_refresh_start_progress_and_result(refreshing):
    client, gate = refreshing
    r = client.post("/api/v1/admin/catalog/refresh")
    assert r.status_code == 202 and r.json()["state"] == "running" and r.json()["countries"] == ["en:germany"]
    assert client.get("/api/v1/admin/catalog/refresh").json()["state"] == "running"
    assert connectors(client)["openfoodfacts_catalog"]["status"] == "running"
    assert client.post("/api/v1/admin/catalog/refresh").status_code == 409  # only one at a time
    gate.set()
    client.app.state.refresh.wait()
    state = client.get("/api/v1/admin/catalog/refresh").json()
    assert state["state"] == "done" and state["error"] is None and state["finished_at"] >= state["started_at"]
    assert state["result"]["products"] == 2 and state["result"]["rows_read"] == 2
    assert client.get("/api/v1/me").json()["catalog"]["products"] == 2
    assert [i["name"] for i in client.get("/api/v1/catalog?q=apf").json()] == ["Apfel"]
    assert connectors(client)["openfoodfacts_catalog"]["status"] == "ok"
    assert client.post("/api/v1/admin/catalog/refresh").status_code == 202  # a new one may start after the first


def test_refresh_uses_the_configured_countries(refreshing, tmp_path):
    client, gate = refreshing
    gate.set()
    client.app.state.refresh.source = gz(tmp_path / "fr.csv.gz", [
        line(ean("400000000001"), "Apfel", "47", **per()), line("3000000000011", "Pomme", "52", country="en:france", **per())])
    client.patch("/api/v1/admin/connectors/openfoodfacts_catalog", json={"config": {"countries": ["en:france"]}})
    client.post("/api/v1/admin/catalog/refresh")
    client.app.state.refresh.wait()
    assert [i["name"] for i in client.get("/api/v1/catalog?q=pomme").json()] == ["Pomme"]
    assert client.get("/api/v1/catalog?q=apfel").json() == []


def test_a_failed_refresh_is_reported_and_keeps_the_old_catalogue(refreshing, tmp_path):
    client, gate = refreshing
    gate.set()
    client.post("/api/v1/admin/catalog/refresh")
    client.app.state.refresh.wait()
    client.app.state.refresh.source = str(tmp_path / "missing.csv.gz")
    assert client.post("/api/v1/admin/catalog/refresh").status_code == 202
    client.app.state.refresh.wait()
    state = client.get("/api/v1/admin/catalog/refresh").json()
    assert state["state"] == "error" and state["error"] and state["result"] is None
    assert client.get("/api/v1/me").json()["catalog"]["products"] == 2  # swapped only on success
    assert client.get("/healthz").status_code == 200
    assert client.post("/api/v1/admin/catalog/refresh").status_code == 202  # and a new try is possible
    client.app.state.refresh.wait()


def test_migration_from_version_7_keeps_the_data(tmp_path):
    from conftest import DROP_V9
    from mahlwerk.db import Store
    path = str(tmp_path / "v7.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V9)
    con.executescript("""
        DROP TABLE webhook_delivery; DROP TABLE webhook; DROP TABLE access_token; DROP TABLE setting;
        INSERT INTO user VALUES (1, 'me', 'Me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml) VALUES (1, 2000, 100, 200, 60, 2500);
        INSERT INTO weight (user_id, day, kg, demo) VALUES (1, '2026-01-02', 80.5, 0);
        INSERT INTO diary_entry (user_id, day, meal, amount, unit, name, per_100, created_at)
            VALUES (1, '2026-01-02', 'lunch', 150, 'g', 'Rice', '{"kcal": 130}', 5);
        PRAGMA user_version = 7;
    """)
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")} >= {
        "access_token", "webhook", "webhook_delivery", "setting"}
    assert con.execute("SELECT kg FROM weight").fetchone()[0] == 80.5
    assert con.execute("SELECT name, amount FROM diary_entry").fetchone() == ("Rice", 150)
    assert store.get_goal(1)["water_ml"] == 2500
    store.set_global("webhooks.hosts", ["a.example"])
    assert store.get_global("webhooks.hosts") == ["a.example"]
    Store(path)  # opening again changes nothing

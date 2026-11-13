import pytest
from fastapi.testclient import TestClient

from mahlwerk.main import create_app

NO_DEMO_ACCOUNT = {"can_switch": False, "viewing": False, "real_username": None, "real_display_name": None}
NO_DEMO = {"available": False, "entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0}
DEFAULT_SETTINGS = {"playful": True, "fasting": {"enabled": False, "target_hours": 16}, "activity": {"add_to_goal": False}, "tour_seen": False, "suggestions": True}
NO_CATALOG = {"products": 0, "updated_at": None, "bls": {"products": 0, "updated_at": None}}
FEATURES = {"access_tokens": True, "webhooks": True, "cookidoo": False, "web_recipes": False}


def proxy_app(monkeypatch, tmp_path, trusted="10.0.0.5"):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", trusted)
    return create_app(str(tmp_path / "p.db"))


def test_single_mode_needs_no_login(client):
    me = client.get("/api/v1/me").json()
    assert me == {"username": "me", "display_name": "me", "display_name_custom": False, "provider_name": None, "is_admin": True, "features": FEATURES, "goal": None, "settings": DEFAULT_SETTINGS, "demo": NO_DEMO, "demo_account": NO_DEMO_ACCOUNT, "catalog": NO_CATALOG}


def test_single_mode_user_name_is_configurable(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_SINGLE_USER", "alex")
    me = TestClient(create_app(str(tmp_path / "s.db"))).get("/api/v1/me").json()
    assert me["username"] == "alex"


def test_health_needs_no_auth_even_in_proxy_mode(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    assert TestClient(app, client=("203.0.113.9", 1)).get("/healthz").status_code == 200


def test_proxy_mode_trusts_header_only_from_trusted_peer(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    trusted = TestClient(app, client=("10.0.0.5", 1))
    r = trusted.get("/api/v1/me", headers={"Remote-User": "anna", "Remote-Name": "Anna B."})
    assert r.status_code == 200
    assert r.json() == {"username": "anna", "display_name": "Anna B.", "display_name_custom": False, "provider_name": None, "is_admin": False, "features": FEATURES, "goal": None, "settings": DEFAULT_SETTINGS, "demo": NO_DEMO, "demo_account": NO_DEMO_ACCOUNT, "catalog": NO_CATALOG}

    stranger = TestClient(app, client=("203.0.113.9", 1))
    assert stranger.get("/api/v1/me", headers={"Remote-User": "anna"}).status_code == 401


def test_forwarded_for_header_cannot_make_a_stranger_trusted(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    stranger = TestClient(app, client=("203.0.113.9", 1))
    headers = {"Remote-User": "anna", "X-Forwarded-For": "10.0.0.5", "X-Real-IP": "10.0.0.5"}
    assert stranger.get("/api/v1/me", headers=headers).status_code == 401


def test_proxy_mode_without_trusted_proxies_rejects_everyone(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path, trusted="")
    assert TestClient(app, client=("10.0.0.5", 1)).get("/api/v1/me", headers={"Remote-User": "a"}).status_code == 401


def test_proxy_mode_needs_the_user_header(monkeypatch, tmp_path):
    app = proxy_app(monkeypatch, tmp_path)
    trusted = TestClient(app, client=("10.0.0.5", 1))
    assert trusted.get("/api/v1/me").status_code == 401
    assert trusted.get("/api/v1/me", headers={"Remote-User": "  "}).status_code == 401


def test_proxy_headers_are_configurable_and_name_defaults_to_username(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_PROXY_USER_HEADER", "X-Auth-User")
    app = proxy_app(monkeypatch, tmp_path)
    trusted = TestClient(app, client=("10.0.0.5", 1))
    assert trusted.get("/api/v1/me", headers={"Remote-User": "anna"}).status_code == 401
    assert trusted.get("/api/v1/me", headers={"X-Auth-User": "anna"}).json()["display_name"] == "anna"


def test_every_api_route_is_protected_in_proxy_mode(monkeypatch, tmp_path):
    stranger = TestClient(proxy_app(monkeypatch, tmp_path), client=("203.0.113.9", 1))
    for method, path in (
        ("GET", "/api/v1/foods"),
        ("GET", "/api/v1/foods/recent"),
        ("GET", "/api/v1/foods/1"),
        ("GET", "/api/v1/foods/barcode/3017620422003"),
        ("POST", "/api/v1/label-scans"),
        ("GET", "/api/v1/diary/2025-01-01"),
        ("GET", "/api/v1/history"),
        ("GET", "/api/v1/weights"),
        ("PUT", "/api/v1/me/goal"),
    ):
        assert stranger.request(method, path, json={}).status_code == 401, path


def test_invalid_auth_mode_fails_at_startup(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "none")
    with pytest.raises(ValueError):
        create_app(str(tmp_path / "x.db"))

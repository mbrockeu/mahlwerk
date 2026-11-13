"""Personal access tokens: create, sign in with them, scopes, expiry, revocation, never admin, switch off."""

import hashlib
import logging
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from mahlwerk.main import create_app

DAY = "2026-01-10"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def make_token(client, scope="write", name="home", **extra) -> dict:
    r = client.post("/api/v1/me/tokens", json={"name": name, "scope": scope, **extra})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def proxy(monkeypatch, tmp_path):
    """Proxy mode: (app, ann) where ann is a trusted-proxy user in group `family`; `stranger` has no proxy headers."""
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "t.db"))
    ann = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ann", "Remote-Groups": "family"})
    stranger = TestClient(app, client=("203.0.113.9", 1))
    return app, ann, stranger


def test_token_shape_and_listing_hides_secrets(client):
    created = make_token(client)
    token = created["token"]
    assert token.startswith("mw_") and len(token) == 3 + 43
    assert created["prefix"] == token[:8] and created["scope"] == "write" and created["revoked_at"] is None
    (listed,) = client.get("/api/v1/me/tokens").json()
    assert listed["prefix"] == token[:8]
    assert "token" not in listed and "hash" not in listed and token not in client.get("/api/v1/me/tokens").text


def test_only_the_hash_is_stored(client, tmp_path):
    token = make_token(client)["token"]
    con = sqlite3.connect(tmp_path / "test.db")
    row = con.execute("SELECT hash, prefix FROM access_token").fetchone()
    assert row == (hashlib.sha256(token.encode()).hexdigest(), token[:8])
    dump = "\n".join(con.iterdump())
    assert token not in dump


def test_tokens_are_unique(client):
    assert make_token(client)["token"] != make_token(client)["token"]


def test_a_token_signs_in_whatever_the_peer_in_proxy_mode(proxy):
    _, ann, stranger = proxy
    token = make_token(ann)["token"]
    assert stranger.get("/api/v1/me").status_code == 401
    me = stranger.get("/api/v1/me", headers=bearer(token))
    assert me.status_code == 200 and me.json()["username"] == "ann"


def test_the_token_wins_over_proxy_headers(proxy):
    app, ann, _ = proxy
    token = make_token(ann)["token"]
    ben = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ben"})
    assert ben.get("/api/v1/me", headers=bearer(token)).json()["username"] == "ann"


def test_a_token_works_in_single_mode(client, make_client):
    token = make_token(client)["token"]
    bare = make_client()
    assert bare.get("/api/v1/me", headers=bearer(token)).json()["username"] == "me"


def test_invalid_tokens_are_401_and_the_text_is_not_echoed(client):
    bad = "mw_" + "x" * 43
    r = client.get("/api/v1/me", headers=bearer(bad))
    assert r.status_code == 401 and bad not in r.text
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 200  # not a Mahlwerk token: ignored


def test_the_token_is_never_read_from_the_url(proxy):
    _, ann, stranger = proxy
    token = make_token(ann)["token"]
    for name in ("token", "access_token", "key", "api_key"):
        assert stranger.get(f"/api/v1/me?{name}={token}").status_code == 401


def test_read_scope_only_reads(client, make_client):
    token = make_token(client, scope="read")["token"]
    bare = make_client()
    h = bearer(token)
    assert bare.get("/api/v1/weights", headers=h).status_code == 200
    assert bare.head("/api/v1/me", headers=h).status_code in (200, 405)
    for method, path in (("PUT", f"/api/v1/weights/{DAY}"), ("POST", f"/api/v1/water/{DAY}"),
                         ("DELETE", f"/api/v1/weights/{DAY}"), ("PUT", "/api/v1/me/goal")):
        assert bare.request(method, path, json={"kg": 80, "add_ml": 100}, headers=h).status_code == 403, path


def test_write_scope_writes(client, make_client):
    token = make_token(client, scope="write")["token"]
    bare = make_client()
    assert bare.put(f"/api/v1/weights/{DAY}", json={"kg": 80.5}, headers=bearer(token)).status_code == 200
    assert client.get("/api/v1/weights?days=3660").json()[0]["kg"] == 80.5


def test_a_token_is_never_admin_and_cannot_manage_tokens_or_webhooks(client, make_client):
    token = make_token(client, scope="write")["token"]
    bare, h = make_client(), bearer(token)
    assert client.get("/api/v1/me").json()["is_admin"] is True  # single mode, normal sign-in
    assert bare.get("/api/v1/me", headers=h).json()["is_admin"] is False
    assert bare.get("/api/v1/admin/overview", headers=h).status_code == 403
    assert bare.get("/api/v1/admin/users", headers=h).status_code == 403
    assert bare.get("/api/v1/me/tokens", headers=h).status_code == 403
    assert bare.post("/api/v1/me/tokens", json={"name": "x", "scope": "read"}, headers=h).status_code == 403
    assert bare.delete("/api/v1/me/tokens/1", headers=h).status_code == 403
    assert bare.get("/api/v1/me/webhooks", headers=h).status_code == 403
    assert bare.post("/api/v1/me/webhooks", json={"name": "x", "url": "http://a.example/", "events": ["entry.created"]},
                     headers=h).status_code == 403


def test_expiry(client, make_client, tmp_path):
    created = make_token(client, expires_in_days=7)
    assert abs(created["expires_at"] - (time.time() + 7 * 86400)) < 5
    bare, h = make_client(), bearer(created["token"])
    assert bare.get("/api/v1/me", headers=h).status_code == 200
    con = sqlite3.connect(tmp_path / "test.db")
    con.execute("UPDATE access_token SET expires_at = ?", (int(time.time()) - 1,))
    con.commit()
    assert bare.get("/api/v1/me", headers=h).status_code == 401


def test_revoking(client, make_client):
    created = make_token(client)
    bare, h = make_client(), bearer(created["token"])
    assert bare.get("/api/v1/me", headers=h).status_code == 200
    assert client.delete(f"/api/v1/me/tokens/{created['id']}").status_code == 204
    assert bare.get("/api/v1/me", headers=h).status_code == 401
    (listed,) = client.get("/api/v1/me/tokens").json()
    assert listed["revoked_at"] is not None
    assert client.delete(f"/api/v1/me/tokens/{created['id']}").status_code == 204  # again is fine
    assert client.delete("/api/v1/me/tokens/999").status_code == 404


def test_tokens_of_others_are_invisible(duo):
    ann, ben = duo
    created = make_token(ann)
    assert ben.get("/api/v1/me/tokens").json() == []
    assert ben.delete(f"/api/v1/me/tokens/{created['id']}").status_code == 404
    assert ann.get("/api/v1/me/tokens").json()[0]["revoked_at"] is None


def test_last_used_is_written_at_most_once_a_minute(client, make_client, tmp_path):
    created = make_token(client)
    bare, h = make_client(), bearer(created["token"])
    assert client.get("/api/v1/me/tokens").json()[0]["last_used_at"] is None
    bare.get("/api/v1/me", headers=h)
    first = client.get("/api/v1/me/tokens").json()[0]["last_used_at"]
    assert first is not None
    con = sqlite3.connect(tmp_path / "test.db")
    con.execute("UPDATE access_token SET last_used_at = ?", (first - 30,))  # used 30 s ago: too fresh to write again
    con.commit()
    bare.get("/api/v1/me", headers=h)
    assert client.get("/api/v1/me/tokens").json()[0]["last_used_at"] == first - 30
    con.execute("UPDATE access_token SET last_used_at = ?", (first - 120,))
    con.commit()
    bare.get("/api/v1/me", headers=h)
    assert client.get("/api/v1/me/tokens").json()[0]["last_used_at"] >= first


def test_switched_off_by_the_environment(monkeypatch, tmp_path):
    app = create_app(str(tmp_path / "a.db"))
    client = TestClient(app)
    token = make_token(client)["token"]
    monkeypatch.setenv("MAHLWERK_TOKENS", "off")
    assert client.get("/api/v1/me", headers=bearer(token)).status_code == 401
    assert client.get("/api/v1/me/tokens").status_code == 404
    assert client.post("/api/v1/me/tokens", json={"name": "x", "scope": "read"}).status_code == 404
    assert client.get("/api/v1/me").json()["features"]["access_tokens"] is False
    monkeypatch.setenv("MAHLWERK_TOKENS", "on")
    assert client.get("/api/v1/me", headers=bearer(token)).status_code == 200  # nothing was lost


def test_switched_off_in_the_admin_area_takes_effect_at_once(client, make_client):
    token = make_token(client)["token"]
    bare = make_client()
    assert client.patch("/api/v1/admin/connectors/access_tokens", json={"enabled": False}).json()["enabled"] is False
    assert bare.get("/api/v1/me", headers=bearer(token)).status_code == 401
    assert client.get("/api/v1/me").json()["features"]["access_tokens"] is False
    client.patch("/api/v1/admin/connectors/access_tokens", json={"enabled": True})
    assert bare.get("/api/v1/me", headers=bearer(token)).status_code == 200


def test_validation(client):
    assert client.post("/api/v1/me/tokens", json={"name": " ", "scope": "read"}).status_code == 422
    assert client.post("/api/v1/me/tokens", json={"name": "x", "scope": "admin"}).status_code == 422
    assert client.post("/api/v1/me/tokens", json={"name": "x", "scope": "read", "expires_in_days": 0}).status_code == 422


def test_no_token_in_logs_or_error_texts(client, make_client, caplog):
    caplog.set_level(logging.DEBUG)
    created = make_token(client)
    token = created["token"]
    bare = make_client()
    responses = [
        bare.get("/api/v1/me", headers=bearer(token)),
        bare.get("/api/v1/me", headers=bearer(token[:-1] + "!")),
        bare.get("/api/v1/me/tokens", headers=bearer(token)),
        bare.get("/api/v1/nope", headers=bearer(token)),
    ]
    client.delete(f"/api/v1/me/tokens/{created['id']}")
    responses.append(bare.get("/api/v1/me", headers=bearer(token)))
    assert token not in caplog.text and token[3:] not in caplog.text
    assert all(token not in r.text for r in responses[1:])


def test_summary_today_for_a_read_token(client, make_client, food):
    token = make_token(client, scope="read")["token"]
    from mahlwerk.routes.diary import today
    day = today().isoformat()
    client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    client.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 60})
    client.put(f"/api/v1/weights/{day}", json={"kg": 81.2})
    client.post(f"/api/v1/water/{day}", json={"add_ml": 500})
    r = make_client().get("/api/v1/summary/today", headers=bearer(token))
    assert r.status_code == 200
    body = r.json()
    assert body["day"] == day and body["kcal_eaten"] == 200 and body["kcal_goal"] == 2000 and body["kcal_left"] == 1800
    assert body["protein"] == 10 and body["carbs"] == 30 and body["fat"] == 4
    assert body["water_ml"] == 500 and body["water_goal_ml"] == 2000
    assert body["weight_kg"] == 81.2 and body["weight_day"] == day
    assert body["fasting"] is None and body["logged_today"] is True and body["last_entry_at"] > 0


def test_summary_today_on_an_empty_account(client):
    body = client.get("/api/v1/summary/today").json()
    assert body["kcal_eaten"] == 0 and body["kcal_goal"] is None and body["kcal_left"] is None
    assert body["weight_kg"] is None and body["weight_day"] is None
    assert body["logged_today"] is False and body["last_entry_at"] is None and body["water_ml"] == 0


def test_summary_today_fasting(client):
    client.patch("/api/v1/me/settings", json={"fasting": {"enabled": True, "target_hours": 14}})
    assert client.get("/api/v1/summary/today").json()["fasting"] == {"active": False, "elapsed_seconds": 0, "target_hours": 14}
    client.post("/api/v1/fasting/start", json={"started_at": int(time.time()) - 3600})
    fasting = client.get("/api/v1/summary/today").json()["fasting"]
    assert fasting["active"] is True and 3590 <= fasting["elapsed_seconds"] <= 3700 and fasting["target_hours"] == 14

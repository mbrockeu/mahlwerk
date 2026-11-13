"""The display name a user chooses: it wins over the provider's name in every sign-in mode and survives later sign-ins."""

import pytest
from conftest import PW
from fastapi.testclient import TestClient
from test_oidc import app, idp, make_app, web  # noqa: F401  (fixtures)
from test_oidc import browser as oidc_browser
from test_oidc import ok, sign_in
from test_tokens import bearer, make_token

from mahlwerk.main import create_app


def proxy_user(app, name="ann", shown=None):
    headers = {"Remote-User": name, **({"Remote-Name": shown} if shown else {})}
    return TestClient(app, client=("10.0.0.5", 1), headers=headers)


@pytest.fixture
def proxy_app(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    return create_app(str(tmp_path / "n.db"))


def test_set_and_reset(client):
    me = client.get("/api/v1/me").json()
    assert me["display_name"] == "me" and me["display_name_custom"] is False and me["provider_name"] is None
    r = client.patch("/api/v1/me", json={"display_name": "  Jürgen   der  Große 🍳 "})
    assert r.status_code == 200
    assert r.json()["display_name"] == "Jürgen der Große 🍳" and r.json()["display_name_custom"] is True
    assert r.json()["username"] == "me" and r.json()["provider_name"] == "me"
    assert client.get("/api/v1/me").json()["display_name"] == "Jürgen der Große 🍳"
    assert "display_name" not in client.get("/api/v1/me").json()["settings"]
    for empty in ("", "   ", None):
        client.patch("/api/v1/me", json={"display_name": "X"})
        r = client.patch("/api/v1/me", json={"display_name": empty})
        assert r.json()["display_name"] == "me" and r.json()["display_name_custom"] is False
    assert client.get("/api/v1/me").json()["display_name"] == "me"


@pytest.mark.parametrize("bad", ["a" * 61, "line\nbreak", "tab\there", "nul\x00", "bell\x07", "x y", "rlo‮text"])
def test_validation(client, bad):
    assert client.patch("/api/v1/me", json={"display_name": bad}).status_code == 422
    assert client.get("/api/v1/me").json()["display_name_custom"] is False


def test_limit_counts_characters_not_bytes(client):
    assert client.patch("/api/v1/me", json={"display_name": "ä" * 60}).status_code == 200
    assert client.patch("/api/v1/me", json={"display_name": "a  " * 20}).status_code == 200  # blanks collapse first


def test_the_user_name_cannot_be_changed(client):
    client.patch("/api/v1/me", json={"display_name": "Chef", "username": "root"})
    assert client.get("/api/v1/me").json()["username"] == "me"


def test_proxy_header_does_not_overwrite_the_chosen_name(proxy_app):
    ann = proxy_user(proxy_app, shown="Anna B.")
    me = ann.get("/api/v1/me").json()
    assert me["display_name"] == "Anna B." and me["provider_name"] is None
    me = ann.patch("/api/v1/me", json={"display_name": "Anni"}).json()
    assert me["display_name"] == "Anni" and me["provider_name"] == "Anna B."
    renamed = proxy_user(proxy_app, shown="Anna Brock")
    me = renamed.get("/api/v1/me").json()
    assert me["display_name"] == "Anni" and me["display_name_custom"] is True and me["provider_name"] == "Anna Brock"
    me = renamed.patch("/api/v1/me", json={"display_name": None}).json()
    assert me["display_name"] == "Anna Brock" and me["provider_name"] is None


def test_without_a_provider_name_the_user_name_is_the_default(proxy_app):
    ann = proxy_user(proxy_app)
    ann.patch("/api/v1/me", json={"display_name": "Anni"})
    me = ann.get("/api/v1/me").json()
    assert me["provider_name"] == "ann"
    assert ann.patch("/api/v1/me", json={"display_name": ""}).json()["display_name"] == "ann"


def test_users_do_not_share_names(proxy_app):
    ann, ben = proxy_user(proxy_app, "ann", "Anna"), proxy_user(proxy_app, "ben", "Ben")
    ann.patch("/api/v1/me", json={"display_name": "Chef"})
    assert ben.get("/api/v1/me").json()["display_name"] == "Ben"
    assert ann.get("/api/v1/me").json()["display_name"] == "Chef"


def test_the_admin_list_shows_the_chosen_name_and_the_user_name(proxy_app):
    ann = proxy_user(proxy_app, "ann", "Anna")
    ann.patch("/api/v1/me", json={"display_name": "Anni"})
    proxy_user(proxy_app, "ben", "Ben").get("/api/v1/me")
    boss = TestClient(proxy_app, client=("10.0.0.5", 1), headers={"Remote-User": "boss", "Remote-Groups": "admin"})
    rows = {r["username"]: r["display_name"] for r in boss.get("/api/v1/admin/users").json()}
    assert rows["ann"] == "Anni" and rows["ben"] == "Ben"
    assert "own_name" not in boss.get("/api/v1/admin/users").json()[0]


def test_auth_status_shows_the_chosen_name(proxy_app):
    ann = proxy_user(proxy_app, shown="Anna")
    ann.patch("/api/v1/me", json={"display_name": "Anni"})
    assert ann.get("/api/v1/auth/status").json()["display_name"] == "Anni"


def test_tokens_follow_the_settings_rule(proxy_app):
    ann = proxy_user(proxy_app, "ann", "Anna")
    bare = TestClient(proxy_app, client=("203.0.113.9", 1))
    read = make_token(ann, scope="read")["token"]
    write = make_token(ann, scope="write")["token"]
    assert bare.patch("/api/v1/me/settings", json={"playful": False}, headers=bearer(read)).status_code == 403
    assert bare.patch("/api/v1/me", json={"display_name": "Hack"}, headers=bearer(read)).status_code == 403
    assert ann.get("/api/v1/me").json()["display_name"] == "Anna"
    assert bare.patch("/api/v1/me", json={"display_name": "Anni"}, headers=bearer(write)).status_code == 200
    assert bare.get("/api/v1/me", headers=bearer(read)).json()["display_name"] == "Anni"


def test_local_mode(admin, browser):
    assert admin.patch("/api/v1/me", json={"display_name": "Alex der Koch"}).json()["display_name"] == "Alex der Koch"
    other = browser()
    assert other.post("/api/v1/auth/login", json={"username": "alex", "password": PW}).json()["display_name"] == "Alex der Koch"
    assert other.get("/api/v1/auth/status").json()["display_name"] == "Alex der Koch"
    users = admin.get("/api/v1/admin/users").json()
    assert users[0]["username"] == "alex" and users[0]["display_name"] == "Alex der Koch"
    admin.patch("/api/v1/me", json={"display_name": ""})
    assert admin.get("/api/v1/me").json()["display_name"] == "alex"


def test_oidc_name_survives_the_next_sign_in(app, web, idp):
    ok(sign_in(web, idp))
    me = web.get("/api/v1/me").json()
    assert me["display_name"] == "Alex Example"
    web.patch("/api/v1/me", json={"display_name": "Lex"})
    idp.claims = {"preferred_username": "alex", "name": "Alexander Example"}
    again = oidc_browser(app)
    ok(sign_in(again, idp))
    me = again.get("/api/v1/me").json()
    assert me["display_name"] == "Lex" and me["display_name_custom"] is True and me["provider_name"] == "Alexander Example"
    assert again.patch("/api/v1/me", json={"display_name": None}).json()["display_name"] == "Alexander Example"

"""The built-in demo account: switching on and off, the reserved user name in every sign-in mode, the switch itself (who may
use it and when it stops working), what a demo request may and may not do, and that the real account stays as it was."""

import re
import sqlite3
from datetime import date

import pytest
from fastapi import Depends
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from mahlwerk import demo_account
from mahlwerk.auth import current_user, hash_token, new_token
from mahlwerk.db import SignInRefused, Store
from mahlwerk.main import create_app
from mahlwerk.routes.diary import today

from conftest import COST, CSRF, PW
from test_local_auth import add_user, login, nocsrf  # noqa: F401

CARD = "/api/v1/admin/connectors/demo_account"
ENTER = "/api/v1/me/demo-view/enter"
LEAVE = "/api/v1/me/demo-view/leave"
COOKIE = demo_account.COOKIE
DAY = today().isoformat()


def rows(app, sql, *args):
    con = sqlite3.connect(app.state.store.path)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, args)]
    finally:
        con.close()


def count(app, table, user_id=None):
    where = "" if user_id is None else f" WHERE user_id = {int(user_id)}"
    return rows(app, f"SELECT count(*) AS n FROM {table}{where}")[0]["n"]


def user_id(app, name):
    return rows(app, "SELECT id FROM user WHERE username = ?", name)[0]["id"]


def switch_on(client):
    r = client.patch(CARD, json={"enabled": True})
    assert r.status_code == 200, r.text
    return r.json()


def enter(client):
    """Switch and, like the interface, say from now on that the demo account is what is shown."""
    r = client.post(ENTER)
    assert r.status_code == 200, r.text
    assert r.headers["X-Mahlwerk-View"] == "demo"
    client.headers["X-Mahlwerk-View"] = "demo"
    return r.json()


def leave(client):
    r = client.post(LEAVE)
    assert r.status_code == 204 and r.headers["X-Mahlwerk-View"] == "own"
    client.headers.pop("X-Mahlwerk-View", None)
    return r


# household and own data that a demo request must never change, per real user
SHARED = ("food", "recipe", "recipe_item", "recipe_group", "recipe_group_item", "recipe_group_dismissed", "access_token", "webhook",
          "import_batch", "secret", "template", "template_item")
OWN = ("diary_entry", "goal", "weight", "water", "fast", "activity_day", "workout", "user_setting", "badge_earned")


def snapshot(app, real_id):
    return {**{t: count(app, t) for t in SHARED if t not in ("template", "template_item", "access_token", "webhook", "import_batch", "secret")},
            **{f"own:{t}": count(app, t, real_id) for t in OWN},
            "users": count(app, "user")}


@pytest.fixture
def real(admin):
    """The local-mode admin `alex` with the demo account switched on."""
    switch_on(admin)
    return admin


@pytest.fixture
def demo(real):
    """The same admin, switched to the demo account."""
    enter(real)
    return real


# --- switching the account on, off, over, away ----------------------------------------------------------------------


def test_off_by_default_and_nothing_to_switch_to(admin):
    card = next(c for c in admin.get("/api/v1/admin/connectors").json() if c["key"] == "demo_account")
    assert card["enabled"] is False and card["status"] == "off" and card["configurable"] is True and card["info"]["exists"] is False
    assert admin.get("/api/v1/me").json()["demo_account"] == {"can_switch": False, "viewing": False, "real_username": None, "real_display_name": None}
    assert admin.post(ENTER).status_code == 404


def test_switching_on_makes_the_user_and_fills_it(local_app, admin):
    card = switch_on(admin)
    assert card["status"] == "ok" and card["enabled"] is True and card["info"]["exists"] is True and card["info"]["entries"] > 300
    assert card["info"]["last_day"] == DAY
    demo_id = user_id(local_app, "~demo")
    row = rows(local_app, "SELECT password_hash, local_admin, disabled FROM user WHERE id = ?", demo_id)[0]
    assert row == {"password_hash": None, "local_admin": 0, "disabled": 0}
    assert count(local_app, "weight", demo_id) > 50 and count(local_app, "water", demo_id) > 50 and count(local_app, "workout", demo_id) > 5
    assert rows(local_app, "SELECT value FROM user_setting WHERE user_id = ? AND key = 'tour_seen'", demo_id)[0]["value"] == "true"
    assert admin.get("/api/v1/me").json()["demo_account"]["can_switch"] is True


def test_the_demo_user_is_marked_in_the_user_list_and_not_counted(local_app, admin):
    before = admin.get("/api/v1/admin/overview").json()
    switch_on(admin)
    after = admin.get("/api/v1/admin/overview").json()
    assert (after["users"], after["entries"], after["foods"]) == (before["users"], before["entries"], before["foods"])
    users = {u["username"]: u for u in admin.get("/api/v1/admin/users").json()}
    assert users["~demo"]["demo"] is True and users["alex"]["demo"] is False and users["~demo"]["entries"] > 300


def test_switching_off_ends_a_running_switch_and_keeps_the_data(local_app, demo):
    assert demo.get("/api/v1/me").json()["demo_account"]["viewing"] is True
    # an admin cannot switch off while looking at the demo account (no admin area there): do it from a second browser
    other = TestClient(local_app, client=("198.51.100.8", 1), headers=CSRF)
    assert login(other, "alex").status_code == 200
    assert other.patch(CARD, json={"enabled": False}).status_code == 200
    me = demo.get("/api/v1/me").json()
    assert me["username"] == "alex" and me["demo_account"] == {"can_switch": False, "viewing": False, "real_username": None, "real_display_name": None}
    assert count(local_app, "diary_entry", user_id(local_app, "~demo")) > 300  # kept until it is deleted
    assert demo.post(ENTER).status_code == 404
    assert other.patch(CARD, json={"enabled": True}).status_code == 200  # on again: the same account
    assert enter(demo)["viewing"] is True


def test_reset_starts_over_and_deletes_what_the_demo_session_added(local_app, demo):
    demo_id = user_id(local_app, "~demo")
    assert demo.put(f"/api/v1/weights/{DAY}", json={"kg": 61.5}).status_code == 200
    assert demo.put("/api/v1/me/goal", json={"kcal": 1234, "protein": 1, "carbs": 1, "fat": 1}).status_code == 200
    assert leave(demo).status_code == 204
    r = demo.post("/api/v1/admin/demo-account/reset")
    assert r.status_code == 200 and r.json()["info"]["entries"] > 300
    assert rows(local_app, "SELECT kg FROM weight WHERE user_id = ? AND day = ?", demo_id, DAY)[0]["kg"] != 61.5
    assert rows(local_app, "SELECT kcal FROM goal WHERE user_id = ?", demo_id)[0]["kcal"] == 2100
    assert user_id(local_app, "~demo") == demo_id


def test_reset_leaves_the_real_account_and_the_household_alone(local_app, real):
    alex = user_id(local_app, "alex")
    food = real.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}).json()
    real.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    real.post("/api/v1/recipes", json={"name": "Porridge", "portions": 1, "items": [{"food_id": food["id"], "amount": 50}]})
    before = snapshot(local_app, alex)
    real.post("/api/v1/admin/demo-account/reset")
    assert snapshot(local_app, alex) == before


def test_delete_empties_the_account_keeps_its_row_and_switches_off(local_app, real):
    demo_id = user_id(local_app, "~demo")
    assert real.delete("/api/v1/admin/demo-account").status_code == 200
    assert user_id(local_app, "~demo") == demo_id  # the row stays: its id is never given to somebody else
    for table in Store.USER_TABLES:
        assert count(local_app, table, demo_id) == 0, table
    assert count(local_app, "food") == 0  # ALL sample foods went with it
    card = next(c for c in real.get("/api/v1/admin/connectors").json() if c["key"] == "demo_account")
    assert card["enabled"] is False and card["info"]["exists"] is False
    assert "~demo" not in {u["username"] for u in real.get("/api/v1/admin/users").json()}
    assert real.delete("/api/v1/admin/demo-account").status_code == 404
    assert real.post("/api/v1/admin/demo-account/reset").status_code == 409
    assert real.post(ENTER).status_code == 404
    # a new user does not inherit the id (no AUTOINCREMENT: it would, if the row were gone)
    add_user(real, "sam")
    assert user_id(local_app, "sam") != demo_id
    assert switch_on(real)["info"]["exists"] is True  # and on again uses the same row, filled anew
    assert user_id(local_app, "~demo") == demo_id and count(local_app, "diary_entry", demo_id) > 300


def test_a_write_that_was_still_running_during_the_delete_is_cleaned_at_the_next_switch_on(local_app, real):
    demo_id = user_id(local_app, "~demo")
    real.delete("/api/v1/admin/demo-account")
    con = sqlite3.connect(local_app.state.store.path)  # what a request that started before the delete would still write
    con.execute("INSERT INTO water (user_id, day, ml) VALUES (?, '1999-01-01', 250)", (demo_id,))
    con.commit()
    con.close()
    switch_on(real)
    assert rows(local_app, "SELECT 1 FROM water WHERE user_id = ? AND day = '1999-01-01'", demo_id) == []


def test_after_a_delete_a_running_switch_ends_and_cannot_write(local_app, demo):
    other = TestClient(local_app, client=("198.51.100.8", 1), headers=CSRF)
    assert login(other, "alex").status_code == 200
    assert other.delete("/api/v1/admin/demo-account").status_code == 200
    r = demo.put(f"/api/v1/weights/{DAY}", json={"kg": 77}, headers={"X-Mahlwerk-View": "demo"})
    assert r.status_code == 409 and r.json()["detail"] == "view changed" and r.headers["X-Mahlwerk-View"] == "own"
    assert rows(local_app, "SELECT 1 FROM weight WHERE day = ? AND kg = 77", DAY) == []


def test_every_table_with_a_user_is_erased(local_app):
    con = sqlite3.connect(local_app.state.store.path)
    try:
        tables = [t for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
                  if "user_id" in {c[1] for c in con.execute(f"PRAGMA table_info({t})")}]
    finally:
        con.close()
    assert set(tables) == set(Store.USER_TABLES)


def test_a_real_user_named_demo_is_an_ordinary_user_and_the_account_still_works(local_app, admin, browser):
    add_user(admin, "demo", password=PW)
    real_demo = user_id(local_app, "demo")
    sam = browser()
    assert login(sam, "demo").status_code == 200  # signs in as before
    assert sam.put(f"/api/v1/weights/{DAY}", json={"kg": 55.5}).status_code == 200
    assert switch_on(admin)["status"] == "ok"  # and the demo account can still be switched on
    demo_id = user_id(local_app, "~demo")
    assert demo_id != real_demo
    assert sam.get("/api/v1/me").json()["username"] == "demo"
    assert sam.get(f"/api/v1/weights?days=3").json()[0]["kg"] == 55.5  # their data is theirs
    assert count(local_app, "weight", real_demo) == 1 and rows(local_app, "SELECT kg FROM weight WHERE user_id = ? AND day = ?", demo_id, DAY)[0]["kg"] != 55.5
    users = {u["username"]: u for u in admin.get("/api/v1/admin/users").json()}
    assert users["demo"]["demo"] is False and users["~demo"]["demo"] is True
    assert admin.get("/api/v1/admin/overview").json()["users"] == 2  # alex and the real demo; the account is not counted
    enter(admin)
    assert admin.get("/api/v1/me").json()["username"] == "~demo"
    leave(admin)
    assert admin.post("/api/v1/admin/demo-account/reset").status_code == 200
    assert count(local_app, "weight", real_demo) == 1  # a reset touches only the demo account


def test_a_real_user_named_demo_in_proxy_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "p.db"))
    boss = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "boss", "Remote-Groups": "admin"})
    demo = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "demo"})
    assert demo.put(f"/api/v1/weights/{DAY}", json={"kg": 61}).status_code == 200
    assert boss.patch(CARD, json={"enabled": True}).status_code == 200
    enter(boss)
    assert boss.get("/api/v1/me").json()["username"] == "~demo"
    assert demo.get("/api/v1/me").json()["username"] == "demo" and demo.get(f"/api/v1/weights?days=2").json()[0]["kg"] == 61


def test_the_environment_can_fix_the_switch(monkeypatch, local_app, admin):
    monkeypatch.setenv("MAHLWERK_DEMO_ACCOUNT", "1")
    card = next(c for c in admin.get("/api/v1/admin/connectors").json() if c["key"] == "demo_account")
    assert card["enabled"] is True and card["locked"] == ["enabled"] and card["status"] == "empty"
    assert admin.patch(CARD, json={"enabled": False}).status_code == 409
    assert enter(admin)["viewing"] is True  # made on the first switch
    leave(admin)
    assert admin.delete("/api/v1/admin/demo-account").status_code == 200
    assert enter(admin)["viewing"] is True  # still on by the environment: a new one is made


# --- the reserved name in every sign-in mode --------------------------------------------------------------------------


def test_local_mode_nobody_can_be_or_become_demo(local_app, real, browser):
    fresh = browser()
    assert fresh.post("/api/v1/auth/login", json={"username": "~demo", "password": "x" * 12}).status_code == 401
    for name in ("~demo", "~Demo", " ~DEMO "):
        assert real.post("/api/v1/admin/users", json={"username": name, "password": PW}).status_code == 422
    # even with a password written into the database and a session made by hand the demo account gets nowhere
    demo_id = user_id(local_app, "~demo")
    local_app.state.store.set_password(demo_id, local_app.state.hasher.hash(PW))
    assert login(browser(), "~demo").status_code == 401
    local_app.state.store.create_session(demo_id, "ab" * 32, int(local_app.state.clock()), 1000)
    c = browser()
    c.cookies.set("mahlwerk_session", "unknown")
    assert c.get("/api/v1/me").status_code == 401


def test_local_mode_setup_cannot_take_the_name(browser):
    c = browser()
    assert c.post("/api/v1/auth/setup", json={"username": "~demo", "password": PW}).status_code == 422
    assert c.post("/api/v1/auth/setup", json={"username": "alex", "password": PW}).status_code == 201


def test_the_demo_account_is_not_managed_as_a_user(local_app, real):
    for call in (lambda: real.patch("/api/v1/admin/users/~demo", json={"is_admin": True}),
                 lambda: real.patch("/api/v1/admin/users/~demo", json={"disabled": True}),
                 lambda: real.post("/api/v1/admin/users/~demo/password", json={"password": PW})):
        assert call().status_code == 409
    row = rows(local_app, "SELECT password_hash, local_admin, disabled FROM user WHERE username = '~demo'")[0]
    assert row == {"password_hash": None, "local_admin": 0, "disabled": 0}


def test_the_store_itself_refuses_the_name(tmp_path):
    store = Store(str(tmp_path / "s.db"))
    from mahlwerk.db import ReservedName
    for call in (lambda: store.get_or_create_user("~demo", "x"), lambda: store.get_or_create_user("~DEMO", "x"),
                 lambda: store.create_local_user("~Demo", "x", "h", False), lambda: store.setup_first_admin("~demo", "x", "h")):
        with pytest.raises(ReservedName):
            call()
    with pytest.raises(SignInRefused) as refused:
        store.oidc_sign_in("https://idp", "sub1", "~demo", "Demo", True, link_existing=True)
    assert refused.value.code == "name"
    assert store.usernames() == []


def test_a_token_of_the_demo_account_is_worthless(local_app, real):
    demo_id = user_id(local_app, "~demo")
    store = local_app.state.store
    token = new_token()
    store.create_token(demo_id, "x", token[:8], hash_token(token), "write", None)
    r = TestClient(local_app).get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_single_mode_refuses_the_name(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_SINGLE_USER", "~Demo")
    with pytest.raises(ValueError, match="reserved"):
        create_app(str(tmp_path / "s.db"))


def test_proxy_mode_refuses_the_name(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "p.db"))
    for name in ("~demo", "~Demo"):
        c = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": name, "Remote-Groups": "admin"})
        assert c.get("/api/v1/me").status_code == 403
    assert count(app, "user") == 0


# --- the switch -------------------------------------------------------------------------------------------------------


def test_only_admins_may_switch(local_app, real, browser):
    add_user(real, "sam")
    sam = browser()
    assert login(sam, "sam").status_code == 200
    assert sam.get("/api/v1/me").json()["demo_account"]["can_switch"] is False
    assert sam.post(ENTER).status_code == 403
    assert COOKIE not in sam.cookies
    assert leave(sam).status_code == 204  # leaving is harmless for everybody


def test_the_switch_needs_the_csrf_header_and_no_token(local_app, real):
    plain = nocsrf(local_app)
    plain.cookies.update(real.cookies)
    assert plain.post(ENTER).status_code == 403
    assert COOKIE not in plain.cookies
    token = real.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}).json()["token"]
    via_token = TestClient(local_app)
    assert via_token.post(ENTER, headers={"Authorization": f"Bearer {token}"}).status_code == 403
    assert via_token.post(LEAVE, headers={"Authorization": f"Bearer {token}"}).status_code == 403


def test_what_a_switched_request_is(local_app, real):
    enter(real)
    me = real.get("/api/v1/me").json()
    assert me["username"] == "~demo" and me["display_name"] == "Demo" and me["is_admin"] is False
    assert me["demo_account"] == {"can_switch": False, "viewing": True, "real_username": "alex", "real_display_name": "alex"}
    assert me["features"] == {"access_tokens": False, "webhooks": False, "cookidoo": False, "web_recipes": False}
    assert me["demo"]["available"] is False and me["settings"]["tour_seen"] is True and me["goal"]["kcal"] == 2100
    assert real.get("/api/v1/admin/overview").status_code == 403
    assert real.get("/api/v1/admin/users").status_code == 403
    assert real.get("/api/v1/auth/status").json()["username"] == "~demo"
    assert leave(real).status_code == 204
    me = real.get("/api/v1/me").json()
    assert me["username"] == "alex" and me["is_admin"] is True and me["demo_account"]["can_switch"] is True
    assert real.get("/api/v1/admin/overview").status_code == 200


def test_the_cookie_is_http_only_and_host_prefixed_when_secure(local_app, real):
    r = real.post(ENTER)
    header = r.headers["set-cookie"]
    assert header.startswith(COOKIE + "=") and "HttpOnly" in header and "SameSite=lax" in header and "Secure" not in header
    leave(real)
    secure = TestClient(local_app, base_url="https://testserver", client=("198.51.100.9", 1), headers=CSRF)
    assert login(secure, "alex").status_code == 200
    r = secure.post(ENTER)
    assert r.status_code == 200
    header = r.headers["set-cookie"]
    assert header.startswith("__Host-" + COOKIE + "=") and "Secure" in header and "Path=/" in header and "Domain" not in header
    assert secure.get("/api/v1/me").json()["username"] == "~demo"
    # over HTTPS only the prefixed name is read: a planted plain cookie does nothing
    secure.cookies.clear()
    assert login(secure, "alex").status_code == 200
    secure.cookies.set(COOKIE, real.cookies.get(COOKIE) or "x", domain="testserver.local")
    assert secure.get("/api/v1/me").json()["username"] == "alex"


def _key(app):
    return app.state.store.secret_key(demo_account.KEY_NAME)


def test_forged_or_foreign_or_expired_cookies_do_nothing(local_app, real, clock, browser):
    alex = user_id(local_app, "alex")
    key = _key(local_app)
    other = browser()
    assert other.get("/api/v1/me").status_code == 401  # anonymous
    other.cookies.set(COOKIE, demo_account.seal(key, alex, None, clock()))
    assert other.get("/api/v1/me").status_code == 401  # a cookie signs nobody in

    def me(cookie):
        c = TestClient(local_app, client=("198.51.100.20", 1), headers=CSRF)
        assert login(c, "alex").status_code == 200
        c.cookies.set(COOKIE, cookie)
        r = c.get("/api/v1/me")
        assert r.status_code == 200
        return r.json()["username"], c

    def session_of(c):
        return hash_token(c.cookies.get("mahlwerk_session"))

    probe = TestClient(local_app, client=("198.51.100.21", 1), headers=CSRF)
    assert login(probe, "alex").status_code == 200
    good = demo_account.seal(key, alex, session_of(probe), clock())
    probe.cookies.set(COOKIE, good)
    assert probe.get("/api/v1/me").json()["username"] == "~demo"  # the same cookie, properly made, does work

    assert me("not-a-cookie")[0] == "alex"
    assert me(good + "x")[0] == "alex"  # signature broken
    assert me(good.split(".")[0] + "." + "A" * 43)[0] == "alex"
    assert me(demo_account.seal(b"k" * 32, alex, session_of(probe), clock()))[0] == "alex"  # signed with another key
    assert me(demo_account.seal(key, alex, session_of(probe), clock()))[0] == "alex"  # bound to another session than the new login's
    name, c = me("x")
    assert demo_account.seal(key, alex, session_of(c), clock() - demo_account.TTL - 5) != ""
    c.cookies.set(COOKIE, demo_account.seal(key, alex, session_of(c), clock() - demo_account.TTL - 5))
    assert c.get("/api/v1/me").json()["username"] == "alex"  # expired
    c.cookies.set(COOKIE, demo_account.seal(key, alex + 1, session_of(c), clock()))
    assert c.get("/api/v1/me").json()["username"] == "alex"  # made for another user id
    c.cookies.set(COOKIE, demo_account.seal(key, alex, session_of(c), clock()))
    assert c.get("/api/v1/me").json()["username"] == "~demo"
    clock.now += demo_account.TTL + 1  # real time passes: the sign-in session (30 days) lives on, the switch has ended
    r = c.get("/api/v1/me")
    assert r.json()["username"] == "alex"
    assert COOKIE + '=""' in r.headers["set-cookie"] and "Max-Age=0" in r.headers["set-cookie"]  # and the dead cookie is removed


def test_a_cookie_for_another_user_is_worthless(local_app, real, browser):
    add_user(real, "sam")
    sam = browser()
    assert login(sam, "sam").status_code == 200
    stolen = TestClient(local_app, client=("198.51.100.30", 1), headers=CSRF)
    enter(real)
    sam.cookies.set(COOKIE, real.cookies.get(COOKIE))
    assert sam.get("/api/v1/me").json()["username"] == "sam"
    assert sam.get("/api/v1/me").json()["is_admin"] is False
    assert sam.get(f"/api/v1/diary/{DAY}").json()["totals"]["kcal"] == 0
    assert stolen.get("/api/v1/me").status_code == 401


def test_the_cookie_dies_with_the_admin_right_and_with_the_session(local_app, real, browser):
    add_user(real, "boss", is_admin=True)
    boss = browser()
    assert login(boss, "boss").status_code == 200
    enter(boss)
    assert boss.get("/api/v1/me").json()["username"] == "~demo"
    assert real.patch("/api/v1/admin/users/boss", json={"is_admin": False}).status_code == 200
    me = boss.get("/api/v1/me").json()
    assert me["username"] == "boss" and me["is_admin"] is False  # the right is gone: so is the switch
    assert real.patch("/api/v1/admin/users/boss", json={"is_admin": True}).status_code == 200
    assert boss.get("/api/v1/me").json()["username"] == "boss"  # and it does not come back by itself (the cookie was removed)
    # signing out and in again: the old cookie is bound to the old session
    enter(boss)
    cookie = boss.cookies.get(COOKIE)
    assert boss.post("/api/v1/auth/logout").status_code == 204
    assert login(boss, "boss").status_code == 200
    boss.cookies.set(COOKIE, cookie)
    assert boss.get("/api/v1/me").json()["username"] == "boss"


def test_signing_out_ends_the_switch(local_app, demo):
    assert demo.post("/api/v1/auth/logout").status_code == 204
    assert demo.get("/api/v1/me").status_code == 401
    assert demo.cookies.get(COOKIE) in (None, "")


def test_an_access_key_never_looks_at_the_cookie(local_app, real):
    token = real.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}).json()["token"]
    enter(real)
    c = TestClient(local_app, headers={"Authorization": f"Bearer {token}"})
    c.cookies.set(COOKIE, real.cookies.get(COOKIE))
    me = c.get("/api/v1/me").json()
    assert me["username"] == "alex" and me["demo_account"]["viewing"] is False


def test_single_mode_switches_too(monkeypatch, tmp_path):
    app = create_app(str(tmp_path / "single.db"))
    c = TestClient(app)
    assert c.patch(CARD, json={"enabled": True}).status_code == 200
    assert enter(c)["viewing"] is True
    me = c.get("/api/v1/me").json()
    assert me["username"] == "~demo" and me["is_admin"] is False
    assert c.get("/api/v1/admin/overview").status_code == 403
    assert leave(c).status_code == 204
    assert c.get("/api/v1/me").json()["username"] == "me" and c.get("/api/v1/admin/overview").status_code == 200


def test_proxy_mode_switches_only_while_the_proxy_says_admin(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "proxy.db"))
    boss = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "boss", "Remote-Groups": "admin"})
    plain = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "pat"})
    assert boss.patch(CARD, json={"enabled": True}).status_code == 200
    assert plain.post(ENTER).status_code == 403
    enter(boss)
    assert boss.get("/api/v1/me").json()["username"] == "~demo"
    boss.headers["Remote-Groups"] = "family"  # the proxy no longer calls this user an admin
    assert boss.get("/api/v1/me").json()["username"] == "boss"
    boss.headers["Remote-Groups"] = "admin"
    assert boss.get("/api/v1/me").json()["username"] == "boss"  # the cookie was dropped when it did not count
    # another user behind the proxy with the cookie of the first one
    pat = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "pat", "Remote-Groups": "admin"})
    enter(boss)
    pat.cookies.set(COOKIE, boss.cookies.get(COOKIE))
    assert pat.get("/api/v1/me").json()["username"] == "pat"


# --- what a demo request does ------------------------------------------------------------------------------------------


def test_own_data_is_written_to_the_demo_account_only(local_app, real):
    alex = user_id(local_app, "alex")
    demo_id = user_id(local_app, "~demo")
    real.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}})
    before = snapshot(local_app, alex)
    demo_before = {t: count(local_app, t, demo_id) for t in OWN}
    enter(real)
    sample = real.get("/api/v1/foods?limit=5").json()
    assert sample and all(f["source"] == "own" for f in sample)
    r = real.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": sample[0]["id"], "meal": "snack", "amount": 33})
    assert r.status_code == 201
    assert real.put(f"/api/v1/weights/{DAY}", json={"kg": 70.1}).status_code == 200
    assert real.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).status_code == 200
    assert real.post("/api/v1/fasting/start", json={}).status_code in (200, 201)
    assert real.post("/api/v1/workouts", json={"day": DAY, "kind": "running", "minutes": 20}).status_code == 201
    assert real.put("/api/v1/me/goal", json={"kcal": 1999, "protein": 100, "carbs": 200, "fat": 60}).status_code == 200
    assert real.patch("/api/v1/me/settings", json={"playful": False}).status_code == 200
    assert real.post("/api/v1/templates", json={"name": "t", "from": {"day": DAY, "meal": "snack"}}).status_code in (200, 201)
    assert leave(real).status_code == 204
    assert snapshot(local_app, alex) == before  # the real account is exactly as it was
    assert real.get("/api/v1/me").json()["settings"]["playful"] is True
    assert real.get("/api/v1/me").json()["goal"] is None  # alex never set one
    demo_after = {t: count(local_app, t, demo_id) for t in OWN}
    assert demo_after["diary_entry"] == demo_before["diary_entry"] + 1 and demo_after["fast"] == demo_before["fast"] + 1
    assert rows(local_app, "SELECT kg FROM weight WHERE user_id = ? AND day = ?", demo_id, DAY)[0]["kg"] == 70.1


def test_the_sample_foods_stay_out_of_the_household_product_list(local_app, real):
    mine = real.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}).json()
    assert [f["name"] for f in real.get("/api/v1/foods").json()] == ["Oats"]
    enter(real)
    names = {f["name"] for f in real.get("/api/v1/foods?limit=1000").json()}
    assert "Haferflocken" in names and "Oats" in names  # the demo account sees the household's products and its own sample foods
    leave(real)
    assert [f["name"] for f in real.get("/api/v1/foods?limit=1000").json()] == ["Oats"]
    assert real.get(f"/api/v1/foods/{mine['id']}").status_code == 200


def test_nothing_is_sent_out_for_the_demo_account(tmp_path):
    from test_webhooks import Receiver
    receiver = Receiver()
    try:
        app = create_app(str(tmp_path / "hook.db"))
        app.state.store.set_global("webhooks.hosts", ["127.0.0.1"])
        app.state.webhooks.backoff = (0.01, 0.01)
        c = TestClient(app)
        assert c.patch(CARD, json={"enabled": True}).status_code == 200
        hook = c.post("/api/v1/me/webhooks", json={"name": "h", "url": receiver.url, "events": ["water.changed", "weight.recorded"]})
        assert hook.status_code == 201
        enter(c)
        assert c.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).status_code == 200
        assert c.put(f"/api/v1/weights/{DAY}", json={"kg": 70}).status_code == 200
        assert app.state.webhooks.wait_idle(15)
        assert receiver.hits == []
        leave(c)
        assert c.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).status_code == 200
        assert app.state.webhooks.wait_idle(15)
        assert receiver.events() == ["water.changed"]  # the same call for the real account does go out
    finally:
        receiver.stop()


# every write route of the app is classified in demo_account.POLICY; this test is what makes a new route show up as red


def app_routes(app) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()

    def add(route):
        if isinstance(route, APIRoute) and route.path.startswith("/api/"):
            found.update((m, route.path) for m in route.methods if m not in ("HEAD", "OPTIONS"))

    def walk(routes):
        for route in routes:
            if hasattr(route, "effective_route_contexts"):  # newer FastAPI keeps included routers as branches
                for context in route.effective_route_contexts():
                    add(context.original_route)
            else:
                add(route)

    walk(app.routes)
    return found


def test_every_route_is_classified(local_app):
    routes = app_routes(local_app)
    assert len(routes) > 100
    unclassified = sorted(routes - set(demo_account.POLICY))
    assert not unclassified, f"decide for the demo account (demo_account.POLICY): {unclassified}"
    assert not sorted(set(demo_account.POLICY) - routes), "classified but no such route any more"
    assert set(demo_account.POLICY.values()) == {"public", "read", "own", "blocked"}


def fill_path(path: str) -> str:
    values = {"day": "2025-01-31", "code": "4006381333931", "name": "days.json", "username": "alex", "key": "demo_account", "digest": "0" * 64, "size": "64"}
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), "1"), path)


def test_the_demo_account_is_held_to_the_table(local_app, demo):
    alex = user_id(local_app, "alex")
    before = snapshot(local_app, alex)
    household = {t: count(local_app, t) for t in SHARED}
    verdicts = {"read": 0, "own": 0, "blocked": 0}
    for (method, path), kind in sorted(demo_account.POLICY.items()):
        if kind == "public":
            continue
        r = demo.request(method, fill_path(path), json={} if method not in ("GET", "DELETE") else None)
        verdicts[kind] += 1
        if kind == "blocked":
            assert r.status_code == 403, (method, path, r.status_code, r.text[:200])
            assert r.json()["detail"] in (demo_account.BLOCKED_MESSAGE, "admin only", "not available with an access token") or "managed" in r.json()["detail"], (method, path)
        else:
            assert r.status_code != 403, (method, path, kind, r.text[:200])
    assert all(verdicts.values())
    assert {t: count(local_app, t) for t in SHARED} == household
    assert snapshot(local_app, alex) == before


def test_a_route_that_is_not_in_the_table_is_closed(local_app, demo):
    @local_app.get("/api/v1/zz-new-read", include_in_schema=False)
    def new_read(user: dict = Depends(current_user)):
        return {"ok": True}

    @local_app.post("/api/v1/zz-new-write", include_in_schema=False)
    def new_write(user: dict = Depends(current_user)):
        return {"ok": True}

    assert demo.get("/api/v1/zz-new-read").status_code == 403
    assert demo.post("/api/v1/zz-new-write", json={}).status_code == 403
    leave(demo)
    assert demo.get("/api/v1/zz-new-read").status_code == 200 and demo.post("/api/v1/zz-new-write", json={}).status_code == 200


def test_shared_things_are_read_only_with_a_clear_message(local_app, real):
    food = real.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}).json()
    recipe = real.post("/api/v1/recipes", json={"name": "Porridge", "portions": 1, "items": [{"food_id": food["id"], "amount": 50}]}).json()
    enter(real)
    assert real.get("/api/v1/recipes").json()[0]["food"]["name"] == "Porridge"  # reading and logging are fine
    assert real.get(f"/api/v1/recipes/{recipe['id']}").status_code == 200
    r = real.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 80})
    assert r.status_code == 201
    for call in (
        lambda: real.put(f"/api/v1/foods/{food['id']}", json={"name": "Hacked", "per_100": {"kcal": 1, "protein": 1, "carbs": 1, "fat": 1}}),
        lambda: real.delete(f"/api/v1/foods/{food['id']}"),
        lambda: real.delete(f"/api/v1/recipes/{recipe['id']}"),
        lambda: real.post("/api/v1/recipe-groups", json={"name": "g"}),
        lambda: real.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}),
        lambda: real.post("/api/v1/me/webhooks", json={"name": "t", "url": "https://example.org/x", "events": []}),
        lambda: real.patch("/api/v1/me", json={"display_name": "Renamed"}),
        lambda: real.post("/api/v1/auth/password", json={"current_password": PW, "new_password": PW + "2"}),
    ):
        r = call()
        assert r.status_code == 403 and r.json()["detail"] == demo_account.BLOCKED_MESSAGE
    leave(real)
    assert real.get(f"/api/v1/foods/{food['id']}").json()["name"] == "Oats"
    assert real.get(f"/api/v1/recipes/{recipe['id']}").status_code == 200
    assert real.get("/api/v1/me").json()["display_name"] == "alex"
    assert today() == date.today()


def test_the_yazio_import_never_goes_to_the_demo_account(tmp_path, capsys):
    from mahlwerk import yazio
    store = Store(str(tmp_path / "y.db"))
    store.create_demo_user()
    with pytest.raises(yazio.YazioError, match="reserved"):
        yazio._find_user(store, "~demo", False)
    with pytest.raises(yazio.YazioError, match="reserved"):
        yazio._find_user(store, "~Demo", True)


def test_the_demo_foods_are_marked_and_shared_recipes_are_not_made(local_app, real):
    """The sample data adds only foods carrying the demo-account marker (hidden from the product list of others); no recipe,
    recipe group or picture of the household is made, and the foods of the test-data mode are not reused."""
    rows_ = rows(local_app, "SELECT source, json_extract(data, '$.demo_account') AS marked, json_extract(data, '$.demo') AS legacy FROM food")
    assert rows_ and all(r["marked"] == 1 and r["legacy"] is None and r["source"] == "own" for r in rows_)
    assert count(local_app, "recipe") == 0 and count(local_app, "recipe_group") == 0
    real.delete("/api/v1/admin/demo-account")
    assert count(local_app, "food") == 0


def test_the_demo_account_tops_up_to_today(local_app, real, clock):
    demo_id = user_id(local_app, "~demo")
    con = sqlite3.connect(local_app.state.store.path)
    con.execute("DELETE FROM diary_entry WHERE user_id = ? AND day >= date('now', '-3 day')", (demo_id,))
    con.commit()
    con.close()
    before = count(local_app, "diary_entry", demo_id)
    enter(real)
    assert count(local_app, "diary_entry", demo_id) > before  # the last days are made again at the switch


# --- review follow-up: views that change behind a tab's back, sample foods for others, label photos, cookie lifetime ---------


def test_every_answer_names_the_real_view_and_a_write_for_another_one_is_refused(local_app, real):
    assert real.get("/api/v1/me").headers["X-Mahlwerk-View"] == "own"
    water = lambda: count(local_app, "water", user_id(local_app, "alex"))
    # a tab that believes it is in the demo account while the server says own (the switch ended): refused, nothing booked
    r = real.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}, headers={"X-Mahlwerk-View": "demo"})
    assert r.status_code == 409 and r.json()["detail"] == "view changed" and r.headers["X-Mahlwerk-View"] == "own"
    assert water() == 0
    assert real.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}, headers={"X-Mahlwerk-View": "own"}).status_code == 200
    assert real.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).status_code == 200  # no header: as before (scripts with a cookie)
    assert real.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}, headers={"X-Mahlwerk-View": "nonsense"}).status_code == 409
    assert real.get("/api/v1/me", headers={"X-Mahlwerk-View": "demo"}).status_code == 200  # reads are never refused
    assert water() == 1


def test_another_tab_switches_and_this_one_cannot_book_into_the_demo_account(local_app, real):
    tab_a = real
    tab_b = TestClient(local_app, client=("198.51.100.5", 1), headers=CSRF)
    tab_b.cookies.update(real.cookies)  # the same browser: cookies are shared
    assert tab_b.get("/api/v1/me").headers["X-Mahlwerk-View"] == "own"
    enter(tab_a)
    tab_b.cookies.update(tab_a.cookies)
    alex = user_id(local_app, "alex")
    before = snapshot(local_app, alex)
    demo_before = count(local_app, "water", user_id(local_app, "~demo"))
    # tab B still believes `own`: the cookie makes the request a demo one, so the write is refused, not booked into either account
    r = tab_b.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}, headers={"X-Mahlwerk-View": "own"})
    assert r.status_code == 409 and r.headers["X-Mahlwerk-View"] == "demo"
    assert tab_b.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).status_code == 409  # a demo write without the header is refused too
    assert snapshot(local_app, alex) == before and count(local_app, "water", user_id(local_app, "~demo")) == demo_before
    assert tab_b.get("/api/v1/me").json()["demo_account"]["viewing"] is True  # the tab can learn it and rebuild itself


def test_switch_off_and_lost_admin_right_also_refuse_writes_of_a_stale_band(local_app, demo, browser):
    alex = user_id(local_app, "alex")
    other = TestClient(local_app, client=("198.51.100.9", 1), headers=CSRF)
    assert login(other, "alex").status_code == 200
    assert other.patch(CARD, json={"enabled": False}).status_code == 200
    before = snapshot(local_app, alex)
    r = demo.post(f"/api/v1/water/{DAY}", json={"add_ml": 250})  # the band is still up here (header: demo)
    assert r.status_code == 409 and r.headers["X-Mahlwerk-View"] == "own"
    assert snapshot(local_app, alex) == before


def test_the_stale_band_does_not_fire_webhooks_of_the_real_account(tmp_path):
    from test_webhooks import Receiver
    receiver = Receiver()
    try:
        app = create_app(str(tmp_path / "v.db"))
        app.state.store.set_global("webhooks.hosts", ["127.0.0.1"])
        c = TestClient(app)
        c.patch(CARD, json={"enabled": True})
        c.post("/api/v1/me/webhooks", json={"name": "h", "url": receiver.url, "events": ["water.changed"]})
        r = c.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}, headers={"X-Mahlwerk-View": "demo"})  # the interface thinks: demo; truth: own
        assert r.status_code == 409
        assert app.state.webhooks.wait_idle(15) and receiver.hits == []
    finally:
        receiver.stop()


def test_the_switch_cookie_is_shorter_where_it_is_not_tied_to_a_session(tmp_path):
    app = create_app(str(tmp_path / "single.db"))
    c = TestClient(app)
    c.patch(CARD, json={"enabled": True})
    assert "Max-Age=7200" in c.post(ENTER).headers["set-cookie"]
    key = app.state.store.secret_key(demo_account.KEY_NAME)
    uid = user_id(app, "me")
    assert demo_account.open_cookie(key, demo_account.seal(key, uid, None, 1000), uid, None, 1000 + 7000)
    assert not demo_account.open_cookie(key, demo_account.seal(key, uid, None, 1000), uid, None, 1000 + 7300)


def test_the_switch_cookie_of_a_session_lives_twelve_hours(real):
    assert "Max-Age=43200" in real.post(ENTER).headers["set-cookie"]


def test_the_sample_foods_do_not_exist_for_anybody_else(local_app, real, browser):
    add_user(real, "sam")
    sam = browser()
    login(sam, "sam")
    enter(real)
    sample = real.get("/api/v1/foods?q=Haferflocken").json()[0]["id"]
    assert real.get(f"/api/v1/foods/{sample}").status_code == 200  # the demo view sees its own sample foods
    leave(real)
    for client in (real, sam):  # even the admin, outside the demo view, and everybody else
        assert client.get(f"/api/v1/foods/{sample}").status_code == 404
        assert client.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": sample, "meal": "lunch", "amount": 50}).status_code == 404
        assert client.put(f"/api/v1/foods/{sample}", json={"name": "Mine", "per_100": {"kcal": 1, "protein": 1, "carbs": 1, "fat": 1}}).status_code == 404
        assert client.delete(f"/api/v1/foods/{sample}").status_code == 404
        assert client.post("/api/v1/recipes", json={"name": "R", "portions": 1, "items": [{"food_id": sample, "amount": 10}]}).status_code == 422
    assert rows(local_app, "SELECT json_extract(data, '$.demo_account') AS m FROM food WHERE id = ?", sample)[0]["m"] == 1  # untouched
    assert count(local_app, "recipe") == 0 and count(local_app, "template_item") == 0


def test_delete_cuts_loose_even_a_leftover_reference_to_a_sample_food(local_app, real):
    sample = rows(local_app, "SELECT id FROM food LIMIT 1")[0]["id"]
    con = sqlite3.connect(local_app.state.store.path)  # an old database: a household recipe that uses a sample food
    con.execute("INSERT INTO food (code, source, found, data, fetched_at) VALUES (NULL, 'recipe', 1, '{}', 1)")
    rid = con.execute("INSERT INTO recipe (food_id, portions, updated_at) VALUES (last_insert_rowid(), 1, 1)").lastrowid
    con.execute("INSERT INTO recipe_item (recipe_id, position, food_id, amount, unit, name, per_100) VALUES (?, 1, ?, 10, 'g', 'x', '{}')", (rid, sample))
    con.commit()
    con.close()
    assert real.delete("/api/v1/admin/demo-account").status_code == 200
    assert rows(local_app, "SELECT count(*) n FROM food WHERE json_extract(data, '$.demo_account') = 1")[0]["n"] == 0
    assert rows(local_app, "SELECT food_id FROM recipe_item WHERE recipe_id = ?", rid)[0]["food_id"] is None


def test_no_debug_copy_of_a_demo_label_photo(local_app, real, tmp_path, monkeypatch):
    from mahlwerk import label
    from mahlwerk.routes import foods as foods_routes
    monkeypatch.setattr(label, "available", lambda: True)
    monkeypatch.setattr(label, "read", lambda image: {"text": "t", "per_100": {}, "basis": "100g", "warnings": [], "values": {}})
    monkeypatch.setattr(foods_routes.imagesize, "dimensions", lambda image: (10, 10))
    local_app.state.label_debug_dir = str(tmp_path / "dbg")
    seen = []
    monkeypatch.setattr(foods_routes, "keep_for_debugging", lambda *a: seen.append(a))
    own = real.post("/api/v1/label-scans", content=b"x", headers={"Content-Type": "image/png"})
    enter(real)
    demo_r = real.post("/api/v1/label-scans", content=b"x", headers={"Content-Type": "image/png"})
    assert own.status_code == demo_r.status_code and demo_r.status_code != 403
    assert len(seen) == (1 if own.status_code == 200 else 0)

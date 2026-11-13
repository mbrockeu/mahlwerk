"""MAHLWERK_AUTH=local: own accounts, password sign-in, session cookie, brake, CSRF header, security headers."""

import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from conftest import DROP_V10
from mahlwerk import passwords
from mahlwerk.db import NameTaken, SetupDone, Store
from mahlwerk.main import create_app

from conftest import COST, CSRF, PW, PW2, Clock  # noqa: E402


def nocsrf(app, **kwargs) -> TestClient:
    """A client that does NOT send the CSRF header (the test clients add it by default)."""
    client = TestClient(app, **kwargs)
    del client.headers["X-Mahlwerk-Request"]
    return client


def add_user(admin, name="sam", password=PW, is_admin=False):
    r = admin.post("/api/v1/admin/users", json={"username": name, "password": password, "is_admin": is_admin})
    assert r.status_code == 201, r.text
    return r.json()


def login(client, name, password=PW):
    return client.post("/api/v1/auth/login", json={"username": name, "password": password})


# --- setup ------------------------------------------------------------------------------------------------------


def test_status_before_and_after_setup(browser):
    c = browser()
    assert c.get("/api/v1/auth/status").json() == {
        "mode": "local", "setup_required": True, "setup_code_required": False, "authenticated": False, "username": None, "display_name": None, "is_admin": None}
    assert c.get("/api/v1/me").status_code == 401
    r = c.post("/api/v1/auth/setup", json={"username": " Alex ", "display_name": "Alex A.", "password": PW})
    assert r.status_code == 201 and r.json() == {"username": "alex", "display_name": "Alex A.", "is_admin": True, "disabled": False}
    status = c.get("/api/v1/auth/status").json()
    assert status["setup_required"] is False and status["authenticated"] is True and status["is_admin"] is True
    me = c.get("/api/v1/me").json()
    assert me["username"] == "alex" and me["is_admin"] is True


def test_setup_works_only_once(browser, admin):
    again = browser().post("/api/v1/auth/setup", json={"username": "eve", "password": PW})
    assert again.status_code == 409
    assert browser().get("/api/v1/auth/status").json()["setup_required"] is False


def test_setup_race_lets_only_one_request_win(tmp_path):
    store = Store(str(tmp_path / "race.db"))
    hasher = passwords.PasswordHasher(COST)
    results = []

    def attempt(name):
        try:
            store.setup_first_admin(name, name, hasher.hash(PW))
            results.append("won")
        except SetupDone:
            results.append("lost")

    threads = [threading.Thread(target=attempt, args=(f"u{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["lost"] * 7 + ["won"]
    with sqlite3.connect(store.path) as con:
        assert con.execute("SELECT count(*) FROM user WHERE password_hash IS NOT NULL").fetchone()[0] == 1


def test_setup_takes_over_an_existing_user_without_password(tmp_path, monkeypatch, clock):
    path = str(tmp_path / "old.db")
    monkeypatch.setenv("MAHLWERK_AUTH", "single")
    old = TestClient(create_app(path))
    old.put("/api/v1/me/goal", json={"kcal": 2100, "protein": 100, "carbs": 250, "fat": 60})
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    monkeypatch.setenv("MAHLWERK_SETUP_TOKEN", "code-from-the-environment")
    c = TestClient(create_app(path, password_cost=COST, clock=clock), headers=CSRF)
    assert c.get("/api/v1/auth/status").json()["setup_code_required"] is True
    assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW}).status_code == 403
    assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": "wrong"}).status_code == 403
    assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": "code-from-the-environment"}).status_code == 201
    assert c.get("/api/v1/me").json()["goal"]["kcal"] == 2100


def test_setup_validates_input(browser):
    c = browser()
    assert c.post("/api/v1/auth/setup", json={"username": "alex", "password": "short"}).status_code == 422
    assert c.post("/api/v1/auth/setup", json={"username": "alex", "password": "x" * 257}).status_code == 422
    assert c.post("/api/v1/auth/setup", json={"username": "a b", "password": PW}).status_code == 422
    assert c.post("/api/v1/auth/setup", json={"username": "../x", "password": PW}).status_code == 422
    assert c.post("/api/v1/auth/setup", json={"username": "alex", "password": "x" * 256}).status_code == 201


# --- login, logout, cookie ---------------------------------------------------------------------------------------


def test_login_right_and_wrong(browser, admin):
    c = browser()
    assert c.get("/api/v1/me").status_code == 401
    wrong = login(c, "alex", "not the password")
    unknown = login(c, "nobody", "not the password")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "invalid user name or password"}
    assert c.get("/api/v1/me").status_code == 401
    ok = login(c, "ALEX")  # the name is not case sensitive
    assert ok.status_code == 200 and ok.json()["username"] == "alex"
    assert c.get("/api/v1/me").json()["username"] == "alex"


def test_unknown_user_costs_one_scrypt_run_like_a_wrong_password(browser, admin, monkeypatch):
    calls = []
    real = passwords._scrypt
    monkeypatch.setattr(passwords, "_scrypt", lambda *a, **k: calls.append(1) or real(*a, **k))
    c = browser()
    login(c, "alex", "wrong wrong wrong")
    after_wrong = len(calls)
    login(c, "nobody", "wrong wrong wrong")
    assert len(calls) - after_wrong == after_wrong == 1


def test_session_cookie_attributes(browser, admin):
    header = login(browser(), "alex").headers["set-cookie"].lower()
    assert header.startswith("mahlwerk_session=")
    assert "httponly" in header and "samesite=lax" in header and "path=/" in header and "max-age=2592000" in header
    assert "secure" not in header  # plain HTTP and no switch: no Secure flag


def test_cookie_is_secure_over_https_or_by_switch_or_from_a_trusted_proxy(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    app = create_app(str(tmp_path / "s.db"), password_cost=COST, clock=clock)
    TestClient(app, headers=CSRF).post("/api/v1/auth/setup", json={"username": "alex", "password": PW})
    https = TestClient(app, base_url="https://testserver", headers=CSRF)
    assert "secure" in login(https, "alex").headers["set-cookie"].lower()
    # a client of its own cannot claim HTTPS through a header
    plain = TestClient(app, client=("198.51.100.7", 1), headers={**CSRF, "X-Forwarded-Proto": "https"})
    assert "secure" not in login(plain, "alex").headers["set-cookie"].lower()

    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app2 = create_app(str(tmp_path / "s.db"), password_cost=COST, clock=clock)
    proxied = TestClient(app2, client=("10.0.0.5", 1), headers={**CSRF, "X-Forwarded-Proto": "https"})
    assert "secure" in login(proxied, "alex").headers["set-cookie"].lower()
    stranger = TestClient(app2, client=("198.51.100.7", 1), headers={**CSRF, "X-Forwarded-Proto": "https"})
    assert "secure" not in login(stranger, "alex").headers["set-cookie"].lower()

    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "")
    monkeypatch.setenv("MAHLWERK_COOKIE_SECURE", "1")
    app3 = create_app(str(tmp_path / "s.db"), password_cost=COST, clock=clock)
    assert "secure" in login(TestClient(app3, headers=CSRF), "alex").headers["set-cookie"].lower()


def test_the_session_token_is_stored_only_as_hash(browser, admin, local_app):
    token = admin.cookies.get("mahlwerk_session")
    assert token and len(token) >= 43
    with sqlite3.connect(local_app.state.store.path) as con:
        hashes = [r[0] for r in con.execute("SELECT hash FROM auth_session")]
    assert hashes and token not in hashes and all(len(h) == 64 for h in hashes)


def test_logout_ends_the_session(browser, admin):
    token = admin.cookies.get("mahlwerk_session")
    r = admin.post("/api/v1/auth/logout")
    assert r.status_code == 204 and "max-age=0" in r.headers["set-cookie"].lower()
    replay = browser()
    replay.cookies.set("mahlwerk_session", token)
    assert replay.get("/api/v1/me").status_code == 401  # the cookie is dead on the server, not only deleted in the browser


def test_session_expires_after_30_days_and_slides_with_use(browser, admin, clock):
    day = 86400
    clock.now += 20 * day
    assert admin.get("/api/v1/me").status_code == 200  # used on day 20: the expiry moves to day 50
    clock.now += 20 * day
    assert admin.get("/api/v1/me").status_code == 200  # day 40
    clock.now += 31 * day
    assert admin.get("/api/v1/me").status_code == 401  # unused for 31 days


def test_last_seen_is_written_at_most_once_a_minute(admin, local_app, clock):
    def last_seen():
        with sqlite3.connect(local_app.state.store.path) as con:
            return con.execute("SELECT last_seen FROM auth_session").fetchone()[0]
    first = last_seen()
    clock.now += 30
    admin.get("/api/v1/me")
    assert last_seen() == first
    clock.now += 31
    admin.get("/api/v1/me")
    assert last_seen() == int(clock.now)


def test_expired_sessions_are_cleaned_up_at_sign_in(browser, admin, local_app, clock):
    clock.now += 40 * 86400
    login(browser(), "alex")
    with sqlite3.connect(local_app.state.store.path) as con:
        assert con.execute("SELECT count(*) FROM auth_session").fetchone()[0] == 1


def test_password_is_rehashed_when_the_cost_goes_up(browser, admin, local_app):
    store = local_app.state.store
    before = store.local_user("alex")["password_hash"]
    assert before.startswith("scrypt$16$8$1$")
    local_app.state.hasher = passwords.PasswordHasher((32, 8, 1))
    assert login(browser(), "alex").status_code == 200
    after = store.local_user("alex")["password_hash"]
    assert after.startswith("scrypt$32$8$1$") and after != before
    assert login(browser(), "alex").status_code == 200


# --- brake ---------------------------------------------------------------------------------------------------------


def test_five_failures_start_a_growing_wait(browser, admin, clock):
    c = browser()
    for _ in range(5):
        assert login(c, "alex", "wrong wrong wrong").status_code == 401
    blocked = login(c, "alex", PW)  # even the right password is refused while the wait runs
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "2"
    clock.now += 2
    assert login(c, "alex", "wrong wrong wrong").status_code == 401  # 6th failure: 4 seconds
    assert login(c, "alex", PW).headers["retry-after"] == "4"
    clock.now += 4
    assert login(c, "alex", "wrong wrong wrong").status_code == 401  # 7th: 8 seconds
    assert login(c, "alex", PW).headers["retry-after"] == "8"
    clock.now += 8
    assert login(c, "alex", PW).status_code == 200  # right password after the wait: in, and the count starts over
    # the count of the user name started over; the address keeps its own count (a login must not wipe a guessing run)
    fresh = browser("203.0.113.77")
    for _ in range(5):
        login(fresh, "alex", "wrong wrong wrong")
    assert login(fresh, "alex", PW).headers["retry-after"] == "2"


def test_wait_is_capped_at_15_minutes(browser, admin, clock):
    c = browser()
    for _ in range(30):
        login(c, "alex", "wrong wrong wrong")
        clock.now += 1000
    for _ in range(5):
        login(c, "alex", "wrong wrong wrong")
    assert int(login(c, "alex", PW).headers["retry-after"]) <= 900


def test_one_address_guessing_many_names_is_held_back_too(browser, admin, clock):
    c = browser("203.0.113.50")
    for i in range(5):
        assert login(c, f"user{i}", "wrong wrong wrong").status_code == 401
    assert login(c, "alex", PW).status_code == 429  # a new name, same address
    assert login(browser("203.0.113.51"), "alex", PW).status_code == 200  # another address is not affected


def test_unknown_names_are_braked_like_known_ones(browser, admin):
    c = browser()
    for _ in range(5):
        login(c, "ghost", "wrong wrong wrong")
    assert login(c, "ghost", "wrong wrong wrong").status_code == 429  # the same address, the same name


def test_brake_uses_the_forwarded_address_only_from_a_trusted_proxy(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "f.db"), password_cost=COST, clock=clock)
    TestClient(app, headers=CSRF).post("/api/v1/auth/setup", json={"username": "alex", "password": PW})
    proxy = TestClient(app, client=("10.0.0.5", 1), headers={**CSRF, "X-Forwarded-For": "1.1.1.1"})
    for i in range(5):
        login(proxy, f"n{i}", "wrong wrong wrong")
    assert login(proxy, "alex", PW).status_code == 429
    other = TestClient(app, client=("10.0.0.5", 1), headers={**CSRF, "X-Forwarded-For": "9.9.9.9"})
    assert login(other, "alex", PW).status_code == 200  # a different person behind the same proxy
    # a stranger's forged header changes nothing: the real peer is counted
    liar = TestClient(app, client=("203.0.113.8", 1), headers={**CSRF, "X-Forwarded-For": "9.9.9.9"})
    for i in range(5):
        login(liar, f"m{i}", "wrong wrong wrong")
    liar.headers["X-Forwarded-For"] = "8.8.8.8"
    assert login(liar, "alex", PW).status_code == 429


# --- CSRF header -----------------------------------------------------------------------------------------------------


def test_writes_without_the_header_are_refused_in_local_mode(local_app):
    bare = nocsrf(local_app)
    for path, body in (("setup", {"username": "alex", "password": PW}), ("login", {"username": "alex", "password": PW}), ("logout", None)):
        r = bare.post(f"/api/v1/auth/{path}", json=body)
        assert r.status_code == 403 and "X-Mahlwerk-Request" in r.json()["detail"], path
    assert bare.post("/api/v1/auth/setup", json={"username": "alex", "password": PW}, headers={"X-Mahlwerk-Request": "0"}).status_code == 403


def test_every_writing_method_needs_the_header_but_reads_do_not(browser, admin):
    cookie = {"mahlwerk_session": admin.cookies.get("mahlwerk_session")}
    bare = nocsrf(admin.app, cookies=cookie)
    assert bare.get("/api/v1/me").status_code == 200
    assert bare.get("/healthz").status_code == 200
    assert bare.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 60}).status_code == 403
    assert bare.patch("/api/v1/me/settings", json={"playful": False}).status_code == 403
    assert bare.post("/api/v1/me/tokens", json={"name": "k", "scope": "read"}).status_code == 403
    assert bare.delete("/api/v1/weights/2026-01-01").status_code == 403
    assert bare.put("/api/v1/me/goal", json={"kcal": 2000, "protein": 100, "carbs": 250, "fat": 60}, headers=CSRF).status_code == 200


def test_access_token_needs_no_csrf_header_and_works_in_local_mode(browser, admin):
    token = admin.post("/api/v1/me/tokens", json={"name": "k", "scope": "write"}).json()["token"]
    bare = nocsrf(admin.app)
    auth = {"Authorization": f"Bearer {token}"}
    assert bare.put("/api/v1/me/goal", json={"kcal": 1900, "protein": 90, "carbs": 220, "fat": 60}, headers=auth).status_code == 200
    assert bare.get("/api/v1/me", headers=auth).json()["goal"]["kcal"] == 1900
    # a made-up bearer value is no exemption
    assert bare.put("/api/v1/me/goal", json={"kcal": 1, "protein": 1, "carbs": 1, "fat": 1}, headers={"Authorization": "Bearer nonsense"}).status_code == 403
    # a token cannot manage accounts or tokens, as before
    assert bare.post("/api/v1/admin/users", json={"username": "x1", "password": PW}, headers=auth).status_code == 403


def test_app_sends_no_cors_headers(admin):
    r = admin.get("/api/v1/me", headers={"Origin": "https://evil.example"})
    assert not any(k.lower().startswith("access-control-") for k in r.headers)
    pre = admin.options("/api/v1/me/goal", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT",
                                                    "Access-Control-Request-Headers": "x-mahlwerk-request"})
    assert pre.status_code in (404, 405) and not any(k.lower().startswith("access-control-") for k in pre.headers)


# --- blocking, admin rights, passwords -------------------------------------------------------------------------------


def test_blocking_kills_sessions_and_keys_at_once(browser, admin):
    add_user(admin, "sam")
    sam = browser()
    login(sam, "sam")
    token = sam.post("/api/v1/me/tokens", json={"name": "k", "scope": "read"}).json()["token"]
    bearer = TestClient(admin.app, headers={"Authorization": f"Bearer {token}"})
    assert sam.get("/api/v1/me").status_code == 200 and bearer.get("/api/v1/me").status_code == 200

    r = admin.patch("/api/v1/admin/users/sam", json={"disabled": True})
    assert r.status_code == 200 and r.json()["disabled"] is True
    assert sam.get("/api/v1/me").status_code == 401
    assert bearer.get("/api/v1/me").status_code == 401
    blocked = login(browser(), "sam")
    assert blocked.status_code == 401 and blocked.json() == {"detail": "invalid user name or password"}  # like a wrong password
    assert admin.get("/api/v1/admin/users").json()[1]["disabled"] is True

    admin.patch("/api/v1/admin/users/sam", json={"disabled": False})
    assert sam.get("/api/v1/me").status_code == 401  # the old session does not come back
    assert bearer.get("/api/v1/me").status_code == 200  # the key does: it was only paused
    assert login(sam, "sam").status_code == 200


def test_session_of_a_blocked_user_is_dead_even_if_the_flag_is_set_directly(browser, admin, local_app):
    add_user(admin, "sam")
    sam = browser()
    login(sam, "sam")
    with sqlite3.connect(local_app.state.store.path) as con:
        con.execute("UPDATE user SET disabled = 1 WHERE username = 'sam'")
    assert sam.get("/api/v1/me").status_code == 401


def test_the_last_active_admin_cannot_be_blocked_or_demoted(browser, admin):
    assert admin.patch("/api/v1/admin/users/alex", json={"disabled": True}).status_code == 409
    assert admin.patch("/api/v1/admin/users/alex", json={"is_admin": False}).status_code == 409
    assert admin.get("/api/v1/me").json()["is_admin"] is True
    add_user(admin, "sam")  # a plain user is no second admin
    assert admin.patch("/api/v1/admin/users/alex", json={"is_admin": False}).status_code == 409
    assert admin.patch("/api/v1/admin/users/sam", json={"is_admin": True}).status_code == 200
    sam = browser()
    login(sam, "sam")
    assert sam.get("/api/v1/me").json()["is_admin"] is True
    assert admin.patch("/api/v1/admin/users/alex", json={"is_admin": False}).status_code == 200
    assert admin.get("/api/v1/admin/overview").status_code == 403  # demoted: immediately a plain user
    # sam is now the last one
    assert sam.patch("/api/v1/admin/users/sam", json={"disabled": True}).status_code == 409
    assert sam.patch("/api/v1/admin/users/sam", json={"is_admin": False}).status_code == 409
    # a blocked admin does not count as active
    assert sam.patch("/api/v1/admin/users/alex", json={"is_admin": True, "disabled": True}).status_code == 200
    assert sam.patch("/api/v1/admin/users/sam", json={"is_admin": False}).status_code == 409


def test_account_management_is_for_admins_only(browser, admin):
    add_user(admin, "sam")
    sam = browser()
    login(sam, "sam")
    assert sam.get("/api/v1/me").json()["is_admin"] is False
    assert sam.post("/api/v1/admin/users", json={"username": "x1", "password": PW}).status_code == 403
    assert sam.patch("/api/v1/admin/users/alex", json={"disabled": True}).status_code == 403
    assert sam.post("/api/v1/admin/users/alex/password", json={"password": PW2}).status_code == 403
    assert browser().post("/api/v1/admin/users", json={"username": "x1", "password": PW}).status_code == 401


def test_admin_overview_in_local_mode(admin):
    body = admin.get("/api/v1/admin/overview").json()
    assert body["auth_mode"] == "local" and body["users"] == 1 and body["schema_version"] == 14


def test_create_user_checks(browser, admin):
    assert add_user(admin, "Sam", PW)["username"] == "sam"
    assert admin.post("/api/v1/admin/users", json={"username": "SAM", "password": PW}).status_code == 409
    assert admin.post("/api/v1/admin/users", json={"username": "kim", "password": "short"}).status_code == 422
    assert admin.patch("/api/v1/admin/users/ghost", json={"disabled": True}).status_code == 404
    users = admin.get("/api/v1/admin/users").json()
    assert [(u["username"], u["admin"], u["has_password"]) for u in users] == [("alex", True, True), ("sam", False, True)]
    assert login(browser(), "sam").status_code == 200


def test_users_have_separate_diaries(browser, admin):
    add_user(admin, "sam")
    sam = browser()
    login(sam, "sam")
    admin.put("/api/v1/me/goal", json={"kcal": 1800, "protein": 90, "carbs": 200, "fat": 60})
    assert sam.get("/api/v1/me").json()["goal"] is None


def test_changing_the_own_password_ends_the_other_sessions(browser, admin):
    other = browser()
    login(other, "alex")
    assert other.get("/api/v1/me").status_code == 200
    bad = admin.post("/api/v1/auth/password", json={"current_password": "not the password", "new_password": PW2})
    assert bad.status_code == 403
    assert admin.post("/api/v1/auth/password", json={"current_password": PW, "new_password": "short"}).status_code == 422
    assert admin.post("/api/v1/auth/password", json={"current_password": PW, "new_password": PW2}).status_code == 204
    assert admin.get("/api/v1/me").status_code == 200  # this session stays
    assert other.get("/api/v1/me").status_code == 401  # the other one ends
    assert login(browser(), "alex", PW).status_code == 401
    assert login(browser(), "alex", PW2).status_code == 200


def test_password_change_is_braked_too(browser, admin):
    for _ in range(5):
        admin.post("/api/v1/auth/password", json={"current_password": "not the password", "new_password": PW2})
    r = admin.post("/api/v1/auth/password", json={"current_password": PW, "new_password": PW2})
    assert r.status_code == 429


def test_admin_reset_sets_a_new_password_and_ends_that_users_sessions(browser, admin):
    add_user(admin, "sam")
    sam = browser()
    login(sam, "sam")
    assert admin.post("/api/v1/admin/users/sam/password", json={"password": "short"}).status_code == 422
    assert admin.post("/api/v1/admin/users/sam/password", json={"password": PW2}).status_code == 204
    assert sam.get("/api/v1/me").status_code == 401
    assert login(browser(), "sam", PW).status_code == 401
    assert login(browser(), "sam", PW2).status_code == 200
    assert admin.get("/api/v1/me").status_code == 200  # the admin's own session is untouched
    assert admin.post("/api/v1/admin/users/alex/password", json={"password": PW2}).status_code == 409  # own password: other endpoint
    assert admin.post("/api/v1/admin/users/ghost/password", json={"password": PW2}).status_code == 404


# --- identity only from the session ------------------------------------------------------------------------------------


def test_local_mode_ignores_remote_user_headers(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")  # even a trusted peer with the proxy headers gets nothing
    app = create_app(str(tmp_path / "r.db"), password_cost=COST, clock=clock)
    proxy = TestClient(app, client=("10.0.0.5", 1), headers={**CSRF, "Remote-User": "mallory", "Remote-Groups": "admin", "Remote-Name": "M"})
    assert proxy.get("/api/v1/me").status_code == 401
    assert proxy.get("/api/v1/admin/users").status_code == 401
    proxy.post("/api/v1/auth/setup", json={"username": "alex", "password": PW})
    me = proxy.get("/api/v1/me", headers={"Remote-User": "mallory"}).json()
    assert me["username"] == "alex"
    add = proxy.post("/api/v1/admin/users", json={"username": "sam", "password": PW})
    assert add.status_code == 201
    sam = TestClient(app, client=("10.0.0.5", 1), headers={**CSRF, "Remote-Groups": "admin"})
    login(sam, "sam")
    assert sam.get("/api/v1/me").json()["is_admin"] is False  # the groups header does not make an admin
    with sqlite3.connect(app.state.store.path) as con:
        assert con.execute("SELECT count(*) FROM user WHERE username = 'mallory'").fetchone()[0] == 0


def test_without_a_session_nothing_is_created_by_calling_the_api(browser, local_app):
    c = browser()
    for path in ("/api/v1/me", "/api/v1/diary/2026-01-01", "/api/v1/admin/overview"):
        assert c.get(path).status_code == 401
    with sqlite3.connect(local_app.state.store.path) as con:
        assert con.execute("SELECT count(*) FROM user").fetchone()[0] == 0


# --- the other modes ---------------------------------------------------------------------------------------------------


def test_auth_endpoints_answer_404_in_single_mode_except_status(client):
    assert client.get("/api/v1/auth/status").json() == {
        "mode": "single", "setup_required": False, "setup_code_required": False, "authenticated": True, "username": "me", "display_name": "me", "is_admin": True}
    assert client.post("/api/v1/auth/setup", json={"username": "alex", "password": PW}).status_code == 404
    assert client.post("/api/v1/auth/login", json={"username": "alex", "password": PW}).status_code == 404
    assert client.post("/api/v1/auth/logout").status_code == 404
    assert client.post("/api/v1/auth/password", json={"current_password": PW, "new_password": PW2}).status_code == 404
    assert client.post("/api/v1/admin/users", json={"username": "x1", "password": PW}).status_code == 404
    assert client.patch("/api/v1/admin/users/me", json={"disabled": True}).status_code == 404
    assert client.post("/api/v1/admin/users/me/password", json={"password": PW}).status_code == 404


def test_proxy_mode_status_and_404s(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "p.db"))
    stranger = TestClient(app, client=("203.0.113.9", 1))
    assert stranger.get("/api/v1/auth/status").json()["authenticated"] is False
    trusted = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ann", "Remote-Groups": "admin"})
    status = trusted.get("/api/v1/auth/status").json()
    assert status["mode"] == "proxy" and status["authenticated"] is True and status["is_admin"] is True and status["setup_required"] is False
    assert trusted.post("/api/v1/auth/login", json={"username": "ann", "password": PW}).status_code == 404
    assert trusted.post("/api/v1/admin/users", json={"username": "x1", "password": PW}).status_code == 404


def test_unknown_mode_is_refused(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "password")
    with pytest.raises(ValueError):
        create_app(str(tmp_path / "x.db"))


# --- password hashing --------------------------------------------------------------------------------------------------


def test_hash_format_and_verification():
    h = passwords.PasswordHasher(COST)
    stored = h.hash(PW)
    name, n, r, p, salt, key = stored.split("$")
    assert (name, n, r, p) == ("scrypt", "16", "8", "1") and len(passwords._unb64(salt)) == 16 and len(passwords._unb64(key)) == 32
    assert h.verify(PW, stored) and not h.verify(PW + "x", stored)
    assert h.hash(PW) != stored  # a new salt every time
    assert not h.verify(PW, None) and not h.verify(PW, "") and not h.verify(PW, "scrypt$bad") and not h.verify(PW, "md5$1$2$3$a$b")
    assert not h.verify(PW, f"scrypt${2**30}$8$1$AAAA$AAAA")  # absurd parameters are not run
    assert h.needs_rehash(stored) is False and passwords.PasswordHasher((32, 8, 1)).needs_rehash(stored) is True


def test_production_cost_is_the_specified_one_and_runs():
    h = passwords.PasswordHasher()
    assert (h.n, h.r, h.p) == (2**15, 8, 1)
    stored = h.hash(PW)
    assert stored.startswith("scrypt$32768$8$1$") and h.verify(PW, stored)


def test_no_environment_variable_changes_the_password_cost(monkeypatch):
    monkeypatch.setenv("MAHLWERK_SCRYPT_N", "2")
    monkeypatch.setenv("MAHLWERK_PASSWORD_COST", "2")
    assert passwords.PasswordHasher().n == 2**15


# --- headers -----------------------------------------------------------------------------------------------------------


def test_security_headers_on_every_answer_in_every_mode(client, browser, admin):
    for c in (client, admin):
        for path in ("/healthz", "/api/v1/me", "/api/v1/nope", "/nothing-here"):
            h = c.get(path).headers
            assert h["x-content-type-options"] == "nosniff", path
            assert h["referrer-policy"] == "same-origin" and h["x-frame-options"] == "DENY", path
    assert "no-store" in admin.get("/api/v1/auth/status").headers["cache-control"]
    assert browser().post("/api/v1/me/tokens", json={}).headers["x-content-type-options"] == "nosniff"  # also a 401 or a 403


def test_csp_for_the_interface_hashes_the_inline_script(monkeypatch, tmp_path, clock):
    import base64
    import hashlib
    web = tmp_path / "web"
    web.mkdir()
    script = "\n    document.title = 'x';\n  "
    (web / "index.html").write_text(f'<!doctype html><script>{script}</script><script type="module" src="/a.js"></script><div id=app></div>')
    monkeypatch.setenv("MAHLWERK_WEB_DIR", str(web))
    app = create_app(str(tmp_path / "w.db"))
    r = TestClient(app).get("/")
    csp = r.headers["content-security-policy"]
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    assert f"'sha256-{digest}'" in csp
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp and "'unsafe-eval'" not in csp.replace("'wasm-unsafe-eval'", "")
    assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp and "default-src 'self'" in csp
    assert "content-security-policy" not in TestClient(app).get("/api/v1/me").headers  # API answers are JSON: no CSP needed


# --- migration -----------------------------------------------------------------------------------------------------------


def test_version_9_database_gets_accounts_without_losing_data(tmp_path):
    path = str(tmp_path / "v9.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V10)
    con.executescript(
        """
        INSERT INTO user VALUES (1, 'me', 'Me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        INSERT INTO weight (user_id, day, kg, demo) VALUES (1, '2026-01-02', 80.5, 0);
        PRAGMA user_version = 9;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert "auth_session" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert con.execute("SELECT username, password_hash, disabled, local_admin FROM user").fetchone() == ("me", None, 0, 0)
    con.close()
    assert store.get_goal(1)["kcal"] == 2000
    assert store.weights_between(1, "2026-01-01", "2026-01-31") == [{"day": "2026-01-02", "kg": 80.5}]
    assert store.needs_setup() is True  # nobody has a password: the first-start page is open
    Store(path)  # opening again changes nothing
    store.create_local_user("sam", "Sam", "scrypt$16$8$1$AAAA$AAAA", False)
    with pytest.raises(NameTaken):
        store.create_local_user("SAM", "Sam", "x", False)

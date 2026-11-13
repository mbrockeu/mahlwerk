"""Findings of the security review: outgoing requests (SSRF), brake details, body limits, CSRF header and host check in
every mode, setup code, label photo size, key and session handling."""

import logging
import struct
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from mahlwerk import imagesize, label, netguard, webhooks
from mahlwerk.main import create_app
from mahlwerk.routes import foods
from conftest import COST, CSRF, PW, PW2
from test_local_auth import add_user, login, nocsrf

HOOKS = "/api/v1/me/webhooks"


def hook_body(url, **extra):
    return {"name": "t", "url": url, "events": ["entry.created"], **extra}


# --- H1: outgoing requests only to public addresses -------------------------------------------------------------------


@pytest.mark.parametrize("address", [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::1", "not an address",
])
def test_internal_and_special_addresses_are_not_public(address):
    assert netguard.is_public(address) is False


@pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1::1", "::ffff:8.8.8.8"])
def test_global_addresses_are_public(address):
    assert netguard.is_public(address) is True


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://127.0.0.1:8123/api", "http://0x7f000001/", "http://2130706433/", "http://127.1/", "http://0177.0.0.1/",
    "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3/", "http://192.168.1.5:8123/",
    "http://internal.example/", "http://dual.example/", "http://[::ffff:7f00:1]/", "http://nothing.invalid/", "http://100.64.0.9/",
])
def test_a_webhook_cannot_target_the_inside_or_unknown_names(client, url):
    r = client.post(HOOKS, json=hook_body(url))
    assert r.status_code == 422 and r.json()["detail"].startswith("target not allowed")  # one text for every reason


def test_public_targets_are_accepted_and_changes_are_checked_too(client):
    made = client.post(HOOKS, json=hook_body("https://example.org/in"))
    assert made.status_code == 201
    hook = made.json()
    assert client.patch(f"{HOOKS}/{hook['id']}", json={"url": "http://127.0.0.1:9/"}).status_code == 422
    assert client.patch(f"{HOOKS}/{hook['id']}", json={"url": "https://v6.example/"}).status_code == 200


def test_an_admin_can_allow_an_internal_host_on_purpose(client):
    assert client.post(HOOKS, json=hook_body("http://internal.example:8123/api/webhook/x")).status_code == 422
    client.patch("/api/v1/admin/connectors/webhooks", json={"config": {"hosts": ["internal.example"]}})
    assert client.post(HOOKS, json=hook_body("http://internal.example:8123/api/webhook/x")).status_code == 201
    assert client.post(HOOKS, json=hook_body("http://10.0.0.99/")).status_code == 422  # only the listed host, not the LAN


def test_delivery_checks_again_and_an_old_internal_hook_is_refused_not_crashing(app_with_hooks):
    app, client, calls = app_with_hooks
    legacy = app.state.store.create_webhook(1, "old", "http://10.0.0.7:8123/hook", "whsec_x", ["entry.created"])  # made before the check
    ok = client.post(HOOKS, json=hook_body("https://example.org/in")).json()
    client.post("/api/v1/me/goal" if False else f"{HOOKS}/{legacy['id']}/test")
    client.post(f"{HOOKS}/{ok['id']}/test")
    assert app.state.webhooks.wait_idle(10)
    (d,) = client.get(f"{HOOKS}/{legacy['id']}/deliveries").json()
    assert d["error"] == "target not allowed" and d["attempts"] == 0 and d["status_code"] is None
    assert [c[0] for c in calls] == ["https://example.org/in"]  # nothing was sent to the inside


def test_dns_rebinding_between_creation_and_delivery_is_caught(app_with_hooks, monkeypatch):
    app, client, calls = app_with_hooks
    hook = client.post(HOOKS, json=hook_body("https://rebind.example/in")).json()  # resolves public now
    real = netguard.resolver
    monkeypatch.setattr(netguard, "resolver", lambda host, port: ["10.0.0.7"] if host == "rebind.example" else real(host, port))
    client.post(f"{HOOKS}/{hook['id']}/test")
    assert app.state.webhooks.wait_idle(10)
    assert client.get(f"{HOOKS}/{hook['id']}/deliveries").json()[0]["error"] == "target not allowed"
    assert calls == []


def test_the_real_sender_connects_to_the_checked_address_and_keeps_host_and_sni():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers["host"], request.extensions.get("sni_hostname")))
        return httpx.Response(204)

    send = webhooks.make_sender(httpx.MockTransport(handler))
    assert send("https://hooks.example/in?a=1", b"{}", {"X": "1"}, 5.0, "93.184.216.34") == 204
    assert send("http://hooks.example:8123/p", b"{}", {}, 5.0, "2606:2800:220:1::1") == 204
    assert seen[0] == ("https://93.184.216.34/in?a=1", "hooks.example", "hooks.example")
    assert seen[1] == ("http://[2606:2800:220:1::1]:8123/p", "hooks.example:8123", "hooks.example")


def test_the_dispatcher_hands_the_checked_address_to_a_pinned_sender(app_with_hooks):
    app, client, _ = app_with_hooks
    got = []

    def pinned(url, body, headers, timeout, address=None):
        got.append((url, address))
        return 200

    pinned.pinned = True
    app.state.webhooks.sender = pinned
    hook = client.post(HOOKS, json=hook_body("https://example.org/in")).json()
    client.post(f"{HOOKS}/{hook['id']}/test")
    assert app.state.webhooks.wait_idle(10)
    assert got == [("https://example.org/in", "93.184.216.34")]


@pytest.mark.parametrize("exc", [httpx.ConnectError("refused"), httpx.ConnectTimeout("slow"), httpx.ReadTimeout("slow"), OSError("x")])
def test_network_errors_all_look_the_same_in_the_log(app_with_hooks, exc):
    app, client, _ = app_with_hooks

    def failing(url, body, headers, timeout):
        raise exc

    app.state.webhooks.sender = failing
    hook = client.post(HOOKS, json=hook_body("https://example.org/in")).json()
    client.post(f"{HOOKS}/{hook['id']}/test")
    assert app.state.webhooks.wait_idle(10)
    assert client.get(f"{HOOKS}/{hook['id']}/deliveries").json()[0]["error"] == "delivery failed"


@pytest.fixture
def app_with_hooks(tmp_path):
    calls = []

    def sender(url, body, headers, timeout):
        calls.append((url, headers["X-Mahlwerk-Event"]))
        return 200

    app = create_app(str(tmp_path / "h.db"))
    app.state.webhooks.sender = sender
    app.state.webhooks.backoff = (0.01, 0.01)
    client = TestClient(app)
    client.get("/api/v1/me")
    return app, client, calls


# --- H2, M2: the brake --------------------------------------------------------------------------------------------------


def fails(client, name, n=5):
    for _ in range(n):
        login(client, name, "wrong wrong wrong")


def test_the_name_is_normalised_like_the_account_lookup(browser, admin):
    c = browser()
    for name in ("alex", " Alex", "ALEX ", "alex", "Alex"):
        assert login(c, name, "wrong wrong wrong").status_code == 401
    assert login(c, "alex", PW).status_code == 429  # five spellings, one name


def test_an_ipv6_address_counts_as_its_slash_64(browser, admin):
    a, b = browser("2001:db8:1:2::1"), browser("2001:db8:1:2:ffff::9")
    fails(a, "alex")
    assert login(b, "alex", PW).status_code == 429  # same /64
    assert login(browser("2001:db8:1:3::1"), "alex", PW).status_code == 200  # another /64
    other_name = browser("2001:db8:1:2::77")
    assert login(other_name, "sam", "x" * 12).status_code == 429  # the address block is held back for every name


def test_a_distributed_guessing_run_does_not_lock_the_owner_out(browser, admin, local_app):
    delays = []
    local_app.state.throttle.sleep = delays.append
    for i in range(30):  # thirty different addresses guess at one name
        assert login(browser(f"203.0.113.{i}"), "alex", "wrong wrong wrong").status_code == 401
    assert local_app.state.throttle.under_pressure("alex")
    assert delays and set(delays) == {1.0}  # failed checks under pressure take a second each: about one guess per second
    owner = browser("198.51.100.99")  # an address that never failed
    r = login(owner, "alex", PW)
    assert r.status_code == 200 and owner.get("/api/v1/me").json()["username"] == "alex"
    assert len(delays) == 25  # delays only for failures once the pressure began (attempts 6 to 30); the right password adds none


def test_the_pair_name_and_address_still_blocks_hard(browser, admin):
    fails(browser("203.0.113.5"), "alex")
    assert login(browser("203.0.113.5"), "alex", PW).status_code == 429
    assert login(browser("203.0.113.6"), "alex", PW).status_code == 200


def test_a_warning_is_logged_once_for_a_private_peer_with_forwarding_headers(monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    app = create_app(str(tmp_path / "w.db"), password_cost=COST)
    c = TestClient(app, client=("172.18.0.2", 1), headers=CSRF)
    with caplog.at_level(logging.WARNING, logger="mahlwerk.security"):
        c.get("/api/v1/auth/status")
        assert not caplog.records
        c.get("/api/v1/auth/status", headers={"X-Forwarded-For": "198.51.100.4"})
        c.get("/api/v1/auth/status", headers={"X-Forwarded-For": "198.51.100.5"})
    assert [r.getMessage() for r in caplog.records if "MAHLWERK_TRUSTED_PROXIES" in r.getMessage()].__len__() == 1
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "172.18.0.2")
    caplog.clear()
    trusted = TestClient(create_app(str(tmp_path / "w2.db"), password_cost=COST), client=("172.18.0.2", 1))
    with caplog.at_level(logging.WARNING, logger="mahlwerk.security"):
        trusted.get("/api/v1/auth/status", headers={"X-Forwarded-For": "198.51.100.4"})
    assert not caplog.records


# --- M1: sizes -------------------------------------------------------------------------------------------------------------


def test_a_large_body_is_refused_with_413_before_the_handler_runs(admin):
    big = "x" * (2 * 1024 * 1024)
    r = admin.post("/api/v1/me/tokens", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and "too large" in r.json()["detail"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert admin.post("/api/v1/me/tokens", json={"name": "k", "scope": "read"}).status_code == 201  # normal ones pass


def test_a_streamed_body_without_content_length_is_counted_too(admin):
    def chunks():
        for _ in range(40):
            yield b"x" * 65536  # 2.5 MB in pieces, no Content-Length

    r = admin.post("/api/v1/me/tokens", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_the_photo_and_health_uploads_get_the_bigger_limit(admin, monkeypatch):
    monkeypatch.setattr(label, "available", lambda: True)
    assert admin.post("/api/v1/label-scans", content=b"x" * (9 * 1024 * 1024)).status_code == 413
    assert admin.post("/api/v1/label-scans", content=b"x" * (3 * 1024 * 1024)).status_code == 422  # past the limit, then "not an image"
    body = '{"days": [], "pad": "' + "x" * (2 * 1024 * 1024) + '"}'
    assert admin.post("/api/v1/health/sync", content=body, headers={"Content-Type": "application/json"}).status_code == 200
    assert admin.post("/api/v1/health/sync", content=" " * (9 * 1024 * 1024), headers={"Content-Type": "application/json"}).status_code == 413


def test_a_bad_content_length_is_a_clean_400(admin):
    r = admin.post("/api/v1/me/tokens", content=b"{}", headers={"Content-Length": "abc"})
    assert r.status_code in (400, 422)


# --- M4a: the CSRF header in every mode ----------------------------------------------------------------------------------------


def proxy_app(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    return create_app(str(tmp_path / "p.db"))


GOAL = {"kcal": 2000, "protein": 100, "carbs": 250, "fat": 60}


def test_single_mode_requires_the_header_for_writes(client):
    bare = nocsrf(client.app)
    assert bare.get("/api/v1/me").status_code == 200
    for r in (bare.put("/api/v1/me/goal", json=GOAL), bare.post("/api/v1/me/tokens", json={"name": "k", "scope": "read"}),
              bare.delete("/api/v1/weights/2026-01-01"), bare.patch("/api/v1/me/settings", json={"playful": False})):
        assert r.status_code == 403 and "X-Mahlwerk-Request" in r.json()["detail"]
    assert bare.put("/api/v1/me/goal", json=GOAL, headers=CSRF).status_code == 200


def test_proxy_mode_requires_the_header_for_writes(monkeypatch, tmp_path):
    bare = nocsrf(proxy_app(monkeypatch, tmp_path), client=("10.0.0.5", 1), headers={"Remote-User": "ann"})
    assert bare.put("/api/v1/me/goal", json=GOAL).status_code == 403
    assert bare.put("/api/v1/me/goal", json=GOAL, headers=CSRF).status_code == 200


def test_a_bearer_token_needs_no_header_in_any_mode(client, monkeypatch, tmp_path):
    token = client.post("/api/v1/me/tokens", json={"name": "k", "scope": "write"}).json()["token"]
    bare = nocsrf(client.app)
    assert bare.put("/api/v1/me/goal", json=GOAL, headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert bare.put("/api/v1/me/goal", json=GOAL, headers={"Authorization": "Bearer junk"}).status_code == 403


# --- M4b: host check ----------------------------------------------------------------------------------------------------------


def test_single_mode_answers_only_to_loopback_names_by_default(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_ALLOWED_HOSTS", "")  # unset: the default of the mode
    c = TestClient(create_app(str(tmp_path / "h.db")))
    for host in ("localhost", "localhost:8110", "127.0.0.1", "127.0.0.1:8110", "[::1]:8110", "LOCALHOST"):
        assert c.get("/api/v1/me", headers={"Host": host}).status_code == 200, host
    for host in ("attacker.example", "attacker.example:8110", "192.168.1.5:8110", ""):
        r = c.get("/api/v1/me", headers={"Host": host})
        assert r.status_code == 421 and "MAHLWERK_ALLOWED_HOSTS" in r.json()["detail"], host
    assert c.get("/", headers={"Host": "attacker.example"}).status_code == 421  # the interface too
    assert c.get("/healthz", headers={"Host": "attacker.example"}).status_code == 200  # container health checks


def test_the_list_can_be_set_and_star_allows_everything(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_ALLOWED_HOSTS", "mahlwerk.lan, Diary.Example")
    c = TestClient(create_app(str(tmp_path / "h.db")))
    assert c.get("/api/v1/me", headers={"Host": "mahlwerk.lan:8110"}).status_code == 200
    assert c.get("/api/v1/me", headers={"Host": "diary.example"}).status_code == 200
    assert c.get("/api/v1/me", headers={"Host": "localhost"}).status_code == 421  # not implied once a list is given
    monkeypatch.setenv("MAHLWERK_ALLOWED_HOSTS", "*")
    assert TestClient(create_app(str(tmp_path / "h2.db"))).get("/api/v1/me", headers={"Host": "anything.example"}).status_code == 200


@pytest.mark.parametrize("mode", ["proxy", "local"])
def test_proxy_and_local_mode_do_not_check_the_host_unless_asked(monkeypatch, tmp_path, mode):
    monkeypatch.setenv("MAHLWERK_ALLOWED_HOSTS", "")
    monkeypatch.setenv("MAHLWERK_AUTH", mode)
    c = TestClient(create_app(str(tmp_path / "h.db")))
    assert c.get("/api/v1/auth/status", headers={"Host": "anything.example"}).status_code == 200
    monkeypatch.setenv("MAHLWERK_ALLOWED_HOSTS", "mahlwerk.lan")
    c = TestClient(create_app(str(tmp_path / "h2.db")))
    assert c.get("/api/v1/auth/status", headers={"Host": "anything.example"}).status_code == 421


# --- M5: setup code -----------------------------------------------------------------------------------------------------------


def old_database(monkeypatch, tmp_path):
    path = str(tmp_path / "old.db")
    monkeypatch.setenv("MAHLWERK_AUTH", "single")
    TestClient(create_app(path)).get("/api/v1/me")  # creates the user "me"
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    return path


def test_a_random_setup_code_is_logged_once_for_a_database_with_users(monkeypatch, tmp_path, caplog):
    path = old_database(monkeypatch, tmp_path)
    with caplog.at_level(logging.WARNING, logger="mahlwerk.auth"):
        app = create_app(path, password_cost=COST)
    codes = [r.getMessage().rsplit(": ", 1)[1] for r in caplog.records if "setup code" in r.getMessage()]
    assert len(codes) == 1 and len(codes[0]) >= 20
    c = TestClient(app)
    assert c.get("/api/v1/auth/status").json()["setup_code_required"] is True
    assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW}).status_code == 403
    assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": codes[0][:-1] + "x"}).status_code == 403
    assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": codes[0]}).status_code == 201
    assert [r for r in caplog.records if "setup code" in r.getMessage()].__len__() == 1  # not logged again


def test_a_given_setup_token_is_not_logged(monkeypatch, tmp_path, caplog):
    path = old_database(monkeypatch, tmp_path)
    monkeypatch.setenv("MAHLWERK_SETUP_TOKEN", "my-own-secret-code")
    with caplog.at_level(logging.DEBUG):
        app = create_app(path, password_cost=COST)
    assert "my-own-secret-code" not in caplog.text
    assert TestClient(app).post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": "my-own-secret-code"}).status_code == 201


def test_wrong_setup_codes_are_braked(monkeypatch, tmp_path):
    path = old_database(monkeypatch, tmp_path)
    monkeypatch.setenv("MAHLWERK_SETUP_TOKEN", "right-code-right-code")
    c = TestClient(create_app(path, password_cost=COST))
    for _ in range(5):
        assert c.post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": "guess"}).status_code == 403
    r = c.post("/api/v1/auth/setup", json={"username": "me", "password": PW, "setup_code": "right-code-right-code"})
    assert r.status_code == 429


def test_an_empty_database_needs_no_code_and_logs_none(monkeypatch, tmp_path, caplog, local_app):
    c = TestClient(local_app)
    assert c.get("/api/v1/auth/status").json()["setup_code_required"] is False
    assert c.post("/api/v1/auth/setup", json={"username": "alex", "password": PW}).status_code == 201


# --- M6: label photo ----------------------------------------------------------------------------------------------------------


def png(w, h):
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", w, h) + b"\x08\x02\x00\x00\x00" + b"\0" * 8


def jpeg(w, h):
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"\xff\xc0\x00\x11\x08" + struct.pack(">HH", h, w) + b"\x03" + b"\0" * 9


def webp_vp8x(w, h):
    return b"RIFF\x00\x00\x00\x00WEBPVP8X" + struct.pack("<I", 10) + b"\0\0\0\0" + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")


def webp_vp8l(w, h):
    return b"RIFF\x00\x00\x00\x00WEBPVP8L" + struct.pack("<I", 5) + b"\x2f" + struct.pack("<I", (w - 1) | ((h - 1) << 14))


def webp_vp8(w, h):
    return b"RIFF\x00\x00\x00\x00WEBPVP8 " + struct.pack("<I", 10) + b"\0\0\0\x9d\x01\x2a" + struct.pack("<HH", w, h)


def test_image_size_is_read_from_the_header():
    assert imagesize.dimensions(png(4000, 3000)) == (4000, 3000)
    assert imagesize.dimensions(jpeg(4000, 3000)) == (4000, 3000)
    assert imagesize.dimensions(webp_vp8x(4000, 3000)) == (4000, 3000)
    assert imagesize.dimensions(webp_vp8l(4000, 3000)) == (4000, 3000)
    assert imagesize.dimensions(webp_vp8(4000, 3000)) == (4000, 3000)
    assert imagesize.dimensions(b"GIF89a") is None and imagesize.dimensions(b"") is None and imagesize.dimensions(b"\xff\xd8\xff") is None
    # a JPEG with a thumbnail segment in front still gives the frame size
    assert imagesize.dimensions(b"\xff\xd8" + b"\xff\xe1\x00\x06abcd" + jpeg(123, 456)[2:]) == (123, 456)


@pytest.fixture
def label_ready(monkeypatch):
    monkeypatch.setattr(label, "available", lambda: True)
    monkeypatch.setattr(label, "read", lambda image: {"per_100": {}, "basis": None, "warnings": [], "text": ""})


def test_a_huge_picture_in_a_small_file_is_refused_before_decoding(client, label_ready):
    r = client.post("/api/v1/label-scans", content=png(20000, 20000))
    assert r.status_code == 413 and "megapixels" in r.json()["detail"]
    assert client.post("/api/v1/label-scans", content=jpeg(8000, 4000)).status_code == 413  # 32 MP
    assert client.post("/api/v1/label-scans", content=jpeg(5000, 5000)).status_code == 200  # exactly 25 MP
    assert client.post("/api/v1/label-scans", content=b"GIF89a....").status_code == 422


def test_only_one_label_is_read_at_a_time(client, label_ready):
    assert foods.OCR_SLOT.acquire(blocking=False)
    try:
        r = client.post("/api/v1/label-scans", content=jpeg(1000, 1000))
        assert r.status_code == 503 and r.headers["retry-after"] == "5"
    finally:
        foods.OCR_SLOT.release()
    assert client.post("/api/v1/label-scans", content=jpeg(1000, 1000)).status_code == 200
    assert foods.OCR_SLOT.acquire(blocking=False)  # released again after a read
    foods.OCR_SLOT.release()


# --- N1, N2, N3, N5, headers --------------------------------------------------------------------------------------------------


def test_an_admin_reset_revokes_the_keys_a_own_change_keeps_them(browser, admin):
    add_user(admin, "sam")
    sam = browser()
    login(sam, "sam")
    token = sam.post("/api/v1/me/tokens", json={"name": "k", "scope": "read"}).json()["token"]
    bearer = TestClient(admin.app, headers={"Authorization": f"Bearer {token}"})
    assert sam.post("/api/v1/auth/password", json={"current_password": PW, "new_password": PW2}).status_code == 204
    assert bearer.get("/api/v1/me").status_code == 200  # own change: the key stays
    assert admin.post("/api/v1/admin/users/sam/password", json={"password": PW}).status_code == 204
    assert bearer.get("/api/v1/me").status_code == 401  # reset: revoked
    assert login(sam, "sam").status_code == 200
    assert sam.get("/api/v1/me/tokens").json()[0]["revoked_at"] is not None


def test_keys_of_a_user_without_a_password_are_invalid_in_local_mode(monkeypatch, tmp_path, clock):
    path = str(tmp_path / "k.db")
    monkeypatch.setenv("MAHLWERK_AUTH", "single")
    single = TestClient(create_app(path))
    token = single.post("/api/v1/me/tokens", json={"name": "k", "scope": "read"}).json()["token"]
    assert TestClient(single.app, headers={"Authorization": f"Bearer {token}"}).get("/api/v1/me").status_code == 200
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    local = TestClient(create_app(path, password_cost=COST, clock=clock), headers={"Authorization": f"Bearer {token}"})
    assert local.get("/api/v1/me").status_code == 401


def test_a_session_ends_180_days_after_sign_in_however_often_it_is_used(admin, clock):
    day = 86400
    for _ in range(8):  # day 160, used every 20 days
        clock.now += 20 * day
        assert admin.get("/api/v1/me").status_code == 200
    clock.now += 19 * day  # day 179
    assert admin.get("/api/v1/me").status_code == 200
    clock.now += 2 * day  # day 181
    assert admin.get("/api/v1/me").status_code == 401


def test_signing_in_again_ends_the_earlier_session_of_this_browser(browser, admin):
    old = admin.cookies.get("mahlwerk_session")
    assert login(admin, "alex").status_code == 200
    assert admin.cookies.get("mahlwerk_session") != old
    replay = browser()
    replay.cookies.set("mahlwerk_session", old)
    assert replay.get("/api/v1/me").status_code == 401
    assert admin.get("/api/v1/me").status_code == 200


def test_the_api_docs_are_off_in_local_mode_unless_asked(monkeypatch, tmp_path, local_app):
    c = TestClient(local_app)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path).status_code == 404, path
    monkeypatch.setenv("MAHLWERK_DOCS", "1")
    on = TestClient(create_app(str(tmp_path / "d.db")))
    assert all(on.get(p).status_code == 200 for p in ("/docs", "/redoc", "/openapi.json"))


def test_the_api_docs_stay_on_in_the_other_modes(client):
    assert client.get("/openapi.json").status_code == 200 and client.get("/docs").status_code == 200


def test_every_api_answer_is_not_cached(client, admin):
    for c in (client, admin):
        for path in ("/api/v1/me", "/api/v1/nope", "/api/v1/auth/status"):
            assert "no-store" in c.get(path).headers["cache-control"], path
    assert "cache-control" not in client.get("/healthz").headers or "no-store" not in client.get("/healthz").headers["cache-control"]

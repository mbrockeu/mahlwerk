"""Yazio import in the app: upload (files, gzip, ZIP), preview, confirm; and the direct one-time sign-in against a stand-in.

Nothing here reaches Yazio: the "service" is an httpx.MockTransport that answers like the public clients describe it.
"""

import gzip
import io
import json
import sqlite3
import threading
import time
import uuid
import zipfile
from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from mahlwerk import security, yazio, yazio_live, yazio_stage
from mahlwerk.main import create_app
from test_yazio import DAYS, PRODUCTS, WEIGHTS

URL = "/api/v1/me/yazio"
PASSWORD = "yazio-password-not-real-77"
EMAIL = "someone.private@example.invalid"
CLIENT_ID, CLIENT_SECRET = "app-id-for-tests", "app-secret-for-tests"


def put(client, name, data, **kw):
    return client.put(f"{URL}/files/{name}", content=data if isinstance(data, bytes) else json.dumps(data).encode(), **kw)


def upload_all(client, days=DAYS, products=PRODUCTS, weights=WEIGHTS):
    for name, data in (("days.json", days), ("products.json", products), ("weight.json", weights)):
        assert put(client, name, data).status_code == 200


def counts(client):
    con = sqlite3.connect(client.app.state.store.path)
    return {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("diary_entry", "food", "weight", "water", "import_batch", "workout")}


def make_zip(entries: dict[str, bytes | str], **kw) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data if isinstance(data, (bytes, str)) else json.dumps(data))
    return out.getvalue()


# ---- upload, preview, confirm ----


def test_upload_preview_confirm_end_to_end(client):
    before = counts(client)
    upload_all(client)
    state = client.get(URL).json()
    assert sorted(state["stage"]["files"]) == ["days.json", "products.json", "weight.json"] and state["login"]["enabled"] is False
    r = client.post(f"{URL}/preview", json={})
    assert r.status_code == 200
    pre = r.json()
    assert pre["dry_run"] is True and pre["days"] == 2 and pre["entries_total"] == 5
    assert pre["entries"] == {"product": 3, "recipe": 1, "quick": 1} and pre["weights"] == 2 and pre["batch_id"] is None
    assert pre["foods_created"] == 4 and pre["goal_set"] is True and pre["workouts"] == 3
    assert counts(client) == before  # a preview writes nothing
    done = client.post(f"{URL}/confirm", json={"token": pre["token"]}).json()
    assert done["dry_run"] is False and done["batch_id"] and done["entries_total"] == 5
    assert counts(client)["diary_entry"] == 5 and counts(client)["import_batch"] == 1
    assert client.get(URL).json()["stage"] is None  # nothing is left waiting
    batches = client.get("/api/v1/me/imports").json()
    assert len(batches) == 1 and batches[0]["id"] == done["batch_id"]
    # the same files again: idempotent, no second batch
    upload_all(client)
    again = client.post(f"{URL}/preview", json={}).json()
    assert again["entries_total"] == 0 and again["already_imported"] == 5
    client.post(f"{URL}/confirm", json={"token": again["token"]})
    assert counts(client)["import_batch"] == 1 and counts(client)["diary_entry"] == 5
    # and the batch can be taken back as always
    assert client.delete(f"/api/v1/me/imports/{done['batch_id']}").json()["entries"] == 5
    assert counts(client)["diary_entry"] == 0


def test_the_result_matches_the_command_line_core(client, tmp_path):
    from test_yazio import write_export
    client.get("/api/v1/me")
    folder = write_export(tmp_path / "x")
    store = client.app.state.store
    direct = yazio.run_import(store, store.find_user("me")["id"], folder, dry_run=True)
    upload_all(client)
    pre = client.post(f"{URL}/preview", json={}).json()
    assert (pre["days"], pre["entries_total"], pre["foods_created"], pre["weights"], pre["water"], pre["workouts"]) == (
        direct.days, direct.total_entries, direct.foods_created, direct.weights, direct.water, direct.workouts)


def test_gzip_packed_files_are_accepted_and_the_same(client):
    for name, data in (("days.json", DAYS), ("products.json", PRODUCTS), ("weight.json", WEIGHTS)):
        assert put(client, name, gzip.compress(json.dumps(data).encode())).status_code == 200
    assert client.post(f"{URL}/preview", json={}).json()["entries_total"] == 5


def test_a_zip_of_the_export_folder_works_and_other_entries_are_ignored(client):
    data = make_zip({"export/days.json": DAYS, "export/products.json": PRODUCTS, "export/weight.json": WEIGHTS,
                     "export/nutrients.json": "{}", "export/analysis.md": "# not read", "readme.txt": "x"})
    r = put(client, "export.zip", data)
    assert r.status_code == 200 and sorted(r.json()["files"]) == ["days.json", "products.json", "weight.json"]
    assert client.post(f"{URL}/preview", json={}).json()["entries_total"] == 5


def test_a_zip_inside_gzip_works(client):
    data = gzip.compress(make_zip({"days.json": DAYS, "products.json": PRODUCTS}))
    assert put(client, "export.zip", data).status_code == 200


@pytest.mark.parametrize("path", ["../days.json", "/etc/days.json", "a/../../days.json", "..\\days.json", "C:/days.json",
                                  "a/b/c/d/e/days.json"])
def test_a_zip_with_an_unsafe_path_is_refused_as_a_whole(client, path):
    data = make_zip({"products.json": PRODUCTS, path: DAYS})
    r = put(client, "export.zip", data)
    assert r.status_code == 422 and "unsafe path" in r.json()["detail"]
    assert client.get(URL).json()["stage"] is None


def test_zip_edge_cases(client, monkeypatch):
    assert put(client, "export.zip", make_zip({"days.json": DAYS, "sub/days.json": DAYS})).status_code == 422  # twice
    assert put(client, "export.zip", make_zip({"notes.txt": "hello"})).status_code == 422  # none of the expected
    assert put(client, "export.zip", b"PK\x03\x04 not really a zip").status_code == 422
    assert put(client, "export.zip", make_zip({"days.json": "not json"})).status_code == 422
    assert put(client, "days.json", make_zip({"days.json": DAYS})).status_code == 422  # a ZIP under a file name
    monkeypatch.setattr(yazio_stage, "MAX_ZIP_ENTRIES", 3)
    assert put(client, "export.zip", make_zip({f"f{i}.txt": "x" for i in range(5)})).status_code == 422


def test_a_zip_bomb_stops_at_the_limit(client, monkeypatch):
    monkeypatch.setattr(yazio_stage, "MAX_FILE", 50_000)
    bomb = make_zip({"days.json": b"{" + b'"a":0,' * 1 + b'"b":"' + b"0" * 5_000_000 + b'"}'})
    assert len(bomb) < 20_000  # tiny on the wire, big unpacked
    r = put(client, "export.zip", bomb)
    assert r.status_code == 413 and "larger than allowed" in r.json()["detail"]
    gz = gzip.compress(b'{"b":"' + b"0" * 5_000_000 + b'"}')
    assert put(client, "days.json", gz).status_code == 413
    assert client.get(URL).json()["stage"] is None


def test_a_lying_zip_header_does_not_help_either(client, monkeypatch):
    """The reading is bounded whatever the entry declares: patch the declared size down after the fact."""
    monkeypatch.setattr(yazio_stage, "MAX_FILE", 50_000)
    original = zipfile.ZipInfo

    data = bytearray(make_zip({"days.json": b'{"b":"' + b"0" * 5_000_000 + b'"}'}))
    # the central directory holds the uncompressed size at offset 24 of its record; set it to 10
    pos = data.rfind(b"PK\x01\x02")
    data[pos + 24:pos + 28] = (10).to_bytes(4, "little")
    r = put(client, "export.zip", bytes(data))
    assert r.status_code in (413, 422) and client.get(URL).json()["stage"] is None
    assert original is zipfile.ZipInfo


def test_file_names_content_and_shapes(client):
    assert put(client, "evil.json", DAYS).status_code == 422
    assert put(client, "..%2Fdays.json", DAYS).status_code in (404, 422)
    assert put(client, "days.json", b"").status_code == 422
    assert put(client, "days.json", b"[1, 2]").status_code == 422
    assert put(client, "days.json", b"{not json").status_code == 422
    assert put(client, "days.json", b"\xff\xfe\x00").status_code == 422
    assert put(client, "days.json", b"[" * 100000).status_code == 422  # nesting
    assert put(client, "days.json", b"\x1f\x8b\x08\x00broken").status_code == 422
    r = client.put(f"{URL}/files/days.json", files={"file": ("days.json", b"{}")})
    assert r.status_code == 415
    assert client.get(URL).json()["stage"] is None


def test_errors_never_echo_the_content(client):
    r = put(client, "days.json", b'{"secret-looking-thing": ')
    assert "secret-looking-thing" not in r.text


def test_an_upload_over_the_route_limit_is_refused_before_it_is_read(client, monkeypatch):
    monkeypatch.setitem(security.LIMIT_PREFIXES, "/api/v1/me/yazio/files/", 1000)
    assert put(client, "days.json", b"{" + b" " * 5000 + b"}").status_code == 413
    assert put(client, "days.json", b"{}").status_code == 200
    # everything else keeps its small limit
    assert client.post("/api/v1/foods", content=b"x" * (2 * 1024 * 1024)).status_code == 413


def test_the_real_limit_is_24_mb_for_this_route_only():
    assert security.limit_for("/api/v1/me/yazio/files/days.json") == 24 * 1024 * 1024
    assert security.limit_for("/api/v1/me/yazio/preview") == security.LIMIT_DEFAULT
    assert security.limit_for("/api/v1/foods") == security.LIMIT_DEFAULT


def test_per_person_and_server_wide_caps(client, monkeypatch):
    monkeypatch.setattr(yazio_stage, "MAX_PERSON", 400)
    big = {"x": "y" * 150}
    assert put(client, "days.json", big).status_code == 200
    assert put(client, "products.json", big).status_code == 200
    assert put(client, "weight.json", big).status_code == 413
    monkeypatch.setattr(yazio_stage, "MAX_PERSON", 10_000)
    monkeypatch.setattr(yazio_stage, "MAX_TOTAL", 300)
    assert client.delete(URL).status_code == 204
    assert put(client, "days.json", big).status_code == 200
    stage = client.app.state.yazio_stage
    other = stage.add(999, {"days.json": b"{" + b" " * 98 + b"}"})  # somebody else's upload fills the server
    assert other
    assert put(client, "products.json", big).status_code == 503


def test_confirm_needs_the_token_of_the_preview_and_something_waiting(client):
    assert client.post(f"{URL}/preview", json={}).status_code == 410
    assert client.post(f"{URL}/confirm", json={"token": "x"}).status_code == 410
    upload_all(client)
    pre = client.post(f"{URL}/preview", json={}).json()
    put(client, "weight.json", {"2026-01-10": 79.0})  # the contents changed after the preview
    r = client.post(f"{URL}/confirm", json={"token": pre["token"]})
    assert r.status_code == 409 and counts(client)["diary_entry"] == 0
    assert client.post(f"{URL}/confirm", json={"token": "wrong"}).status_code == 409
    assert client.post(f"{URL}/confirm", json={}).status_code == 422


def test_staged_files_expire(monkeypatch, tmp_path, clock):
    app = create_app(str(tmp_path / "e.db"), clock=clock)
    c = TestClient(app)
    upload_all(c)
    clock.now += 19 * 60
    assert c.get(URL).json()["stage"] is not None
    clock.now += 2 * 60
    assert c.get(URL).json()["stage"] is None
    assert c.post(f"{URL}/preview", json={}).status_code == 410


def test_discard_empties_the_area(client):
    upload_all(client)
    assert client.delete(URL).status_code == 204
    assert client.get(URL).json()["stage"] is None


def test_a_second_preview_at_the_same_time_is_refused(client):
    upload_all(client)
    uid = client.get("/api/v1/me/yazio").status_code and client.app.state.store.find_user("me")["id"]
    assert client.app.state.yazio_stage.begin(uid)
    assert client.post(f"{URL}/preview", json={}).status_code == 409
    client.app.state.yazio_stage.end(uid)
    assert client.post(f"{URL}/preview", json={}).status_code == 200


def test_broken_contents_are_a_422_not_a_crash(client):
    put(client, "days.json", {"2026-01-10": 5})
    put(client, "products.json", {"products": 7})
    r = client.post(f"{URL}/preview", json={})
    assert r.status_code == 200 and r.json()["entries_total"] == 0 and r.json()["skipped"]


def test_uploads_belong_to_the_person_who_made_them(duo):
    ann, ben = duo
    upload_all(ann)
    assert ben.get(URL).json()["stage"] is None
    assert ben.post(f"{URL}/preview", json={}).status_code == 410
    token = ann.post(f"{URL}/preview", json={}).json()["token"]
    assert ben.post(f"{URL}/confirm", json={"token": token}).status_code == 410
    ann.post(f"{URL}/confirm", json={"token": token})
    assert ann.get("/api/v1/me/imports").json() and ben.get("/api/v1/me/imports").json() == []
    assert "Oats" not in ben.get("/api/v1/diary/2026-01-10").text and "Oats" in ann.get("/api/v1/diary/2026-01-10").text


def test_an_access_key_cannot_use_the_import(duo):
    ann, _ = duo
    token = ann.post("/api/v1/me/tokens", json={"name": "k", "scope": "write"}).json()["token"]
    key = TestClient(ann.app, client=("10.0.0.5", 1), headers={"Authorization": f"Bearer {token}", "Remote-User": "ann"})
    for method, path, kw in (("get", "", {}), ("put", "/files/days.json", {"content": b"{}"}), ("post", "/preview", {"json": {}}),
                             ("post", "/confirm", {"json": {"token": "x"}}), ("delete", "", {}),
                             ("post", "/login", {"json": {"email": EMAIL, "password": PASSWORD}})):
        assert getattr(key, method)(URL + path, **kw).status_code == 403, path


def test_writes_need_the_request_header(client):
    del client.headers["X-Mahlwerk-Request"]
    assert put(client, "days.json", {}).status_code == 403
    assert client.post(f"{URL}/preview", json={}).status_code == 403
    assert client.delete(URL).status_code == 403


def test_a_big_export_is_fast_and_does_not_block_the_server(client, tmp_path):
    import random
    rng = random.Random(3)
    products = {f"p{i}": {"name": f"Product {i}", "base_unit": "g", "eans": [], "servings": [],
                          "nutrients": {"energy.energy": rng.uniform(0.5, 5), "nutrient.carb": 0.3, "nutrient.fat": 0.1, "nutrient.protein": 0.1}}
                for i in range(2000)}
    days, first = {}, date(2022, 1, 1)
    for d in range(1200):
        items = [{"id": str(uuid.UUID(int=d * 100 + n)), "type": "product", "date": "2022-01-01T08:00:00", "daytime": "lunch",
                  "product_id": f"p{rng.randrange(2000)}", "amount": rng.randint(20, 400)} for n in range(10)]
        days[(first + timedelta(days=d)).isoformat()] = {"consumed": {"products": items, "recipe_portions": [], "simple_products": []},
                                                         "daily_summary": {"water_intake": 2000}}
    raw = json.dumps(days).encode()
    started = time.monotonic()
    assert put(client, "days.json", gzip.compress(raw)).status_code == 200
    assert put(client, "products.json", {"products": products, "recipes": {}}).status_code == 200
    pre = client.post(f"{URL}/preview", json={}).json()
    assert pre["entries_total"] == 12000
    latencies = []
    done = threading.Event()

    def poll():
        while not done.is_set():
            t = time.monotonic()
            TestClient(client.app).get("/healthz")
            latencies.append(time.monotonic() - t)
            time.sleep(0.01)

    thread = threading.Thread(target=poll)
    thread.start()
    result = client.post(f"{URL}/confirm", json={"token": pre["token"]}).json()
    done.set()
    thread.join()
    elapsed = time.monotonic() - started
    assert result["entries_total"] == 12000 and elapsed < 30
    assert max(latencies, default=0) < 2  # the server kept answering while it imported
    print(f"\n[load test via the API] 12000 entries: upload, preview and confirm in {elapsed:.2f} s; slowest health check {max(latencies, default=0):.3f} s")


# ---- the direct one-time sign-in ----


class FakeYazio:
    """A stand-in for the Yazio service built from the invented export: remembers every request."""

    def __init__(self, days=DAYS, products=PRODUCTS, weights=WEIGHTS):
        self.days, self.products, self.weights = days, products, weights
        self.requests: list[httpx.Request] = []
        self.login_status = 200
        self.login_body = {"access_token": "tok-" + "x" * 20, "refresh_token": "ref-" + "y" * 20, "expires_in": 3600, "token_type": "Bearer"}
        self.fail_paths: dict[str, int] = {}
        self.garbage = False
        self.redirect = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        assert request.url.scheme == "https" and request.url.host == "yzapi.yazio.com" and path.startswith("/v15/")
        path = path[len("/v15"):]
        if self.redirect:
            return httpx.Response(302, headers={"Location": "https://elsewhere.example.invalid/steal"})
        if path == "/oauth/token":
            assert request.method == "POST"
            return httpx.Response(self.login_status, json=self.login_body if self.login_status == 200 else {"error": "invalid_grant"})
        assert request.headers.get("authorization") == f"Bearer {self.login_body['access_token']}", path
        for prefix, status in self.fail_paths.items():
            if path.startswith(prefix):
                return httpx.Response(status, json={})
        if self.garbage:
            return httpx.Response(200, content=b"<html>not json")
        q = dict(request.url.params)
        if path == "/user/consumed-items/nutrients-daily":
            return httpx.Response(200, json=[{"date": d, "energy": 1} for d in sorted(self.days) if q["start"] <= d <= q["end"]])
        if path in ("/user/consumed-items", "/user/exercises", "/user/widgets/daily-summary"):
            day = self.days.get(q["date"])
            if day is None:
                return httpx.Response(404, json={})
            key = {"/user/consumed-items": "consumed", "/user/exercises": "exercises", "/user/widgets/daily-summary": "daily_summary"}[path]
            return httpx.Response(200, json=day.get(key, {}))
        if path.startswith("/products/") or path.startswith("/recipes/"):
            kind, _, ident = path[1:].partition("/")
            found = self.products[kind].get(ident)
            return httpx.Response(200 if found else 404, json=found or {})
        if path == "/user/bodyvalues/weight/last":
            known = [d for d in self.weights if d <= q["date"]]
            return httpx.Response(200, json={"value": self.weights[max(known)]} if known else {})
        return httpx.Response(404, json={})

    def paths(self):
        return [r.url.path for r in self.requests]


@pytest.fixture
def live(monkeypatch, tmp_path, clock):
    """An app (single mode) with the direct sign-in on, the app identifiers set and the stand-in service."""
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_SECRET", CLIENT_SECRET)
    fake = FakeYazio()
    app = create_app(str(tmp_path / "l.db"), clock=clock, yazio_transport=httpx.MockTransport(fake))
    app.state.store.set_global("yazio_login.enabled", True)

    async def no_sleep(seconds):
        return None

    app.state.yazio_runs.sleep = no_sleep
    app.state.yazio_runs.today = lambda: date(2026, 2, 1)
    c = TestClient(app)
    c.fake = fake
    c.clock = clock
    return c


def start(c, **extra):
    return c.post(f"{URL}/login", json={"email": EMAIL, "password": PASSWORD, "months": 3, **extra})


def wait_done(c, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        run = c.get(URL).json()["login"]["run"]
        if run and run["state"] != "running":
            return run
        time.sleep(0.02)
    raise AssertionError("the run did not finish")


def test_direct_sign_in_fetches_previews_and_imports(live):
    r = start(live)
    assert r.status_code == 202 and r.json()["state"] == "running"
    run = wait_done(live)
    assert run["state"] == "done" and run["error"] is None and run["requests"] > 10
    state = live.get(URL).json()
    assert state["stage"]["source"] == "login" and sorted(state["stage"]["files"]) == ["days.json", "products.json", "weight.json"]
    pre = live.post(f"{URL}/preview", json={}).json()
    assert (pre["days"], pre["entries_total"], pre["weights"], pre["workouts"]) == (2, 5, 2, 3)
    assert pre["entries"] == {"product": 3, "recipe": 1, "quick": 1} and pre["goal_set"] is True
    done = live.post(f"{URL}/confirm", json={"token": pre["token"]}).json()
    assert done["batch_id"] and counts(live)["diary_entry"] == 5
    assert live.get("/api/v1/me/imports").json()[0]["id"] == done["batch_id"]


def test_the_same_result_as_the_files_of_the_exporter(live, tmp_path):
    from test_yazio import write_export
    start(live)
    assert wait_done(live)["state"] == "done"
    response = live.post(f"{URL}/preview", json={})
    assert response.status_code == 200, response.text
    via_login = response.json()
    store = live.app.state.store
    live.get("/api/v1/me")
    direct = yazio.run_import(store, store.find_user("me")["id"], write_export(tmp_path / "x"), dry_run=True)
    assert (via_login["entries_total"], via_login["foods_created"], via_login["weights"], via_login["water"], via_login["workouts"],
            via_login["activity_days"]) == (direct.total_entries, direct.foods_created, direct.weights, direct.water, direct.workouts,
                                            direct.activity_days)


def test_requests_go_only_to_the_fixed_host_with_the_token_and_the_password_only_once(live):
    start(live)
    wait_done(live)
    fake = live.fake
    assert all(r.url.host == "yzapi.yazio.com" and r.url.scheme == "https" for r in fake.requests)
    login = [r for r in fake.requests if r.url.path.endswith("/oauth/token")]
    assert len(login) == 1
    body = json.loads(login[0].content)
    assert body == {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "username": EMAIL, "password": PASSWORD, "grant_type": "password"}
    for r in fake.requests:
        if r is not login[0]:
            assert PASSWORD.encode() not in r.content and PASSWORD not in str(r.url) and EMAIL not in str(r.url)
            assert PASSWORD not in json.dumps(dict(r.headers)) and "refresh" not in str(r.url)
    paths = set(fake.paths())
    assert {"/v15/user/consumed-items/nutrients-daily", "/v15/user/consumed-items", "/v15/user/exercises",
            "/v15/user/widgets/daily-summary", "/v15/user/bodyvalues/weight/last"} <= paths
    assert any(p.startswith("/v15/products/") for p in paths) and any(p.startswith("/v15/recipes/") for p in paths)
    assert len(fake.requests) <= yazio_live.MAX_REQUESTS


def test_nothing_of_the_credentials_or_token_stays_anywhere(live, caplog):
    import logging
    with caplog.at_level(logging.DEBUG):
        start(live)
        run = wait_done(live)
        live.post(f"{URL}/preview", json={})
    texts = [json.dumps(live.get(URL).json()), json.dumps(run), caplog.text]
    stage = live.app.state.yazio_stage.get(live.app.state.store.find_user("me")["id"])
    texts += [b.decode() for b in stage.files.values()]
    for text in texts:
        for secret in (PASSWORD, EMAIL, CLIENT_SECRET, "tok-xxx", "ref-yyy"):
            assert secret not in text
    with open(live.app.state.store.path, "rb") as handle:
        raw = handle.read()
    assert PASSWORD.encode() not in raw and EMAIL.encode() not in raw
    # the run object holds no credentials
    run_obj = live.app.state.yazio_runs.get(live.app.state.store.find_user("me")["id"])
    assert PASSWORD not in repr(vars(run_obj)) and EMAIL not in repr(vars(run_obj))


@pytest.mark.parametrize("status,kind", [(401, "auth"), (400, "auth"), (403, "auth"), (429, "busy"), (500, "unavailable"), (418, "unexpected")])
def test_failed_sign_in_gives_a_neutral_message(live, status, kind):
    live.fake.login_status = status
    start(live)
    run = wait_done(live)
    assert run["state"] == "error" and run["error_kind"] == kind and run["error"] == yazio_live.MESSAGES[kind]
    assert PASSWORD not in json.dumps(run) and live.get(URL).json()["stage"] is None
    assert counts(live)["diary_entry"] == 0


def test_a_sign_in_answer_without_a_token_is_unexpected(live):
    live.fake.login_body = {"hello": "world"}
    start(live)
    assert wait_done(live)["error_kind"] == "unexpected"


@pytest.mark.parametrize("path,status,kind", [("/user/consumed-items/nutrients-daily", 401, "expired"),
                                              ("/user/consumed-items", 429, "busy"),
                                              ("/user/exercises", 503, "unavailable"),
                                              ("/user/widgets/daily-summary", 418, "unexpected")])
def test_failures_during_the_run(live, path, status, kind):
    live.fake.fail_paths[path] = status
    start(live)
    run = wait_done(live)
    assert run["state"] == "error" and run["error_kind"] == kind
    assert live.get(URL).json()["stage"] is None


def test_server_errors_are_retried_a_little_then_given_up(live):
    live.fake.fail_paths["/user/exercises"] = 500
    start(live)
    wait_done(live)
    assert sum(1 for p in live.fake.paths() if p == "/v15/user/exercises") <= 3 * 2 + 3  # a few tries, not a storm


def test_unreadable_answers_are_unexpected(live):
    live.fake.garbage = True
    start(live)
    assert wait_done(live)["error_kind"] == "unexpected"


def test_redirects_are_never_followed(live):
    live.fake.redirect = True
    start(live)
    run = wait_done(live)
    assert run["state"] == "error" and run["error_kind"] == "unexpected"
    assert all(r.url.host == "yzapi.yazio.com" for r in live.fake.requests)


def test_oversized_answers_are_refused(live, monkeypatch):
    monkeypatch.setattr(yazio_live, "MAX_ANSWER", 200)
    start(live)
    assert wait_done(live)["error_kind"] == "too_large"


def test_no_data_in_the_period(live):
    live.fake.days = {}
    start(live)
    assert wait_done(live)["error_kind"] == "no_data"


def test_the_request_budget_stops_the_run(live, monkeypatch):
    monkeypatch.setattr(yazio_live, "MAX_REQUESTS", 6)
    start(live)
    run = wait_done(live)
    assert run["error_kind"] == "limit" and len(live.fake.requests) <= 7


def test_products_that_are_gone_become_skipped_entries_not_a_failure(live):
    live.fake.products = {"products": {"p-oats": PRODUCTS["products"]["p-oats"]}, "recipes": {}}
    start(live)
    assert wait_done(live)["state"] == "done"
    pre = live.post(f"{URL}/preview", json={}).json()
    assert pre["entries_total"] == 2 and pre["skipped"]


def test_ids_from_the_service_cannot_change_the_path(live):
    days = json.loads(json.dumps(DAYS))
    days["2026-01-10"]["consumed"]["products"][0]["product_id"] = "../../oauth/token?x=1"
    days["2026-01-10"]["consumed"]["recipe_portions"][0]["recipe_id"] = "a/b"
    live.fake.days = days
    start(live)
    wait_done(live)
    assert not any(".." in p or "/a/b" in p for p in live.fake.paths())


def test_the_period_is_bounded_and_dates_after_today_are_ignored(live):
    live.fake.days = {**DAYS, "2027-05-05": DAYS["2026-01-10"]}
    start(live, months=1)
    wait_done(live)
    starts = {r.url.params["start"] for r in live.fake.requests if r.url.path.endswith("nutrients-daily")}
    assert starts == {"2026-02-01"}
    for months in (0, 25, -1):
        assert start(live, months=months).status_code == 422


def test_weights_are_not_repeated_on_every_day():
    days = ["2026-01-10", "2026-01-11", "2026-01-12", "2026-01-13"]
    answers = [{"value": 80.0}, {"value": 80.0}, {"value": 79.5}, {"value": 79.5}]
    assert yazio_live._weights(days, answers) == {"2026-01-10": 80.0, "2026-01-12": 79.5}
    dated = [{"value": 80.0, "date": "2026-01-09T07:00:00"}, {"value": 80.0, "date": "2026-01-09"}, {"value": 79.5, "date": "2026-01-12"}, {}]
    assert yazio_live._weights(days, dated) == {"2026-01-09": 80.0, "2026-01-12": 79.5}
    assert yazio_live._weights(days[:2], [None, {"value": "heavy"}]) == {}


def test_switched_off_unconfigured_and_validated(monkeypatch, tmp_path, clock):
    fake = FakeYazio()
    app = create_app(str(tmp_path / "o.db"), clock=clock, yazio_transport=httpx.MockTransport(fake))
    c = TestClient(app)
    r = start(c)
    assert r.status_code == 404 and "switched off" in r.json()["detail"]
    assert c.get(URL).json()["login"] == {"enabled": False, "available": False, "run": None, "max_months": 24, "default_months": 12}
    app.state.store.set_global("yazio_login.enabled", True)
    r = start(c)
    assert r.status_code == 409 and "MAHLWERK_YAZIO_CLIENT_ID" in r.json()["detail"] and not fake.requests
    cards = {x["key"]: x for x in c.get("/api/v1/admin/connectors").json()}
    assert cards["yazio_login"]["status"] == "not_configured" and cards["yazio_login"]["enabled"] is True
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_SECRET", CLIENT_SECRET)
    for payload in ({"email": "", "password": PASSWORD}, {"email": EMAIL, "password": ""}, {"email": EMAIL, "password": "x" * 501},
                    {"email": EMAIL, "password": 5}, {"email": EMAIL, "password": PASSWORD, "months": "many"}):
        r = c.post(f"{URL}/login", json=payload)
        assert r.status_code == 422 and PASSWORD not in r.text and EMAIL not in r.text, payload
    assert not fake.requests


def test_the_connector_card_and_its_switch(live):
    cards = {x["key"]: x for x in live.get("/api/v1/admin/connectors").json()}
    assert cards["yazio_login"]["status"] == "ready" and cards["yazio_login"]["configurable"] is True
    assert cards["yazio_login"]["info"]["unofficial"] is True
    assert CLIENT_SECRET not in json.dumps(cards)
    off = live.patch("/api/v1/admin/connectors/yazio_login", json={"enabled": False}).json()
    assert off["status"] == "off"
    assert start(live).status_code == 404


def test_the_switch_can_be_fixed_by_the_environment(live, monkeypatch):
    monkeypatch.setenv("MAHLWERK_YAZIO_LOGIN", "0")
    card = next(x for x in live.get("/api/v1/admin/connectors").json() if x["key"] == "yazio_login")
    assert card["locked"] == ["enabled"] and card["enabled"] is False
    assert live.patch("/api/v1/admin/connectors/yazio_login", json={"enabled": True}).status_code == 409


def test_brakes_one_run_at_a_time_gap_and_hourly_limit(live):
    assert start(live).status_code == 202
    assert start(live).status_code in (409, 429)  # still running, or the gap
    wait_done(live)
    r = start(live)
    assert r.status_code == 429 and "wait" in r.json()["detail"]  # 30 seconds between attempts
    live.clock.now += 31
    live.fake.login_status = 401
    assert start(live).status_code == 202
    wait_done(live)
    live.clock.now += 31
    assert start(live).status_code == 202
    wait_done(live)
    live.clock.now += 31
    r = start(live)
    assert r.status_code == 429 and "too many" in r.json()["detail"]  # the 4th within the hour
    live.clock.now += 3600
    assert start(live).status_code == 202


def test_a_wrong_password_is_not_repeated_by_the_server(live):
    live.fake.login_status = 401
    start(live)
    wait_done(live)
    logins = lambda: sum(1 for r in live.fake.requests if r.url.path.endswith("/oauth/token"))  # noqa: E731
    assert logins() == 1  # one attempt, no retry of its own
    for _ in range(5):
        start(live)
    assert logins() == 1  # the gap holds them back


def test_only_two_runs_at_once_on_the_server(live, monkeypatch):
    gate = threading.Event()
    original = live.fake.__call__

    def slow(request):
        gate.wait(5)
        return original(request)

    live.app.state.yazio_runs.transport = httpx.MockTransport(slow)
    runs = live.app.state.yazio_runs
    for uid in (101, 102):
        runs.start(uid, yazio_live.Credentials("a@example.invalid", "pw-pw-pw-1"), 1)
    with pytest.raises(yazio_live.Refused) as exc:
        runs.start(103, yazio_live.Credentials("a@example.invalid", "pw-pw-pw-1"), 1)
    assert exc.value.kind == "busy"
    gate.set()
    for uid in (101, 102):
        runs.get(uid).thread.join(10)


def test_a_run_can_be_cancelled(live):
    gate = threading.Event()
    original = live.fake.__call__

    def slow(request):
        if request.url.path.endswith("consumed-items"):
            gate.wait(5)
        return original(request)

    live.app.state.yazio_runs.transport = httpx.MockTransport(slow)
    start(live)
    time.sleep(0.2)
    assert live.delete(URL).status_code == 204
    gate.set()
    run = wait_done(live)
    assert run["state"] == "cancelled" and live.get(URL).json()["stage"] is None


def test_a_new_run_replaces_what_waited(live):
    upload_all(live)
    start(live)
    wait_done(live)
    assert live.get(URL).json()["stage"]["source"] == "login"


def test_runs_belong_to_their_person(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_SECRET", CLIENT_SECRET)
    fake = FakeYazio()
    app = create_app(str(tmp_path / "d.db"), clock=clock, yazio_transport=httpx.MockTransport(fake))
    app.state.store.set_global("yazio_login.enabled", True)
    app.state.yazio_runs.today = lambda: date(2026, 2, 1)
    ann, ben = (TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": n}) for n in ("ann", "ben"))
    ann.post(f"{URL}/login", json={"email": EMAIL, "password": PASSWORD, "months": 2})
    wait_done(ann)
    assert ann.get(URL).json()["stage"]["source"] == "login"
    assert ben.get(URL).json()["stage"] is None and ben.get(URL).json()["login"]["run"] is None


def test_confirm_does_not_throw_away_a_newer_upload(client):
    upload_all(client)
    pre = client.post(f"{URL}/preview", json={}).json()
    uid = client.app.state.store.find_user("me")["id"]
    stage = client.app.state.yazio_stage
    original = stage.begin

    def begin_then_upload(user_id):
        ok = original(user_id)
        stage.add(user_id, {"weight.json": b"{}"})  # a new upload slips in while the import is about to run
        return ok

    stage.begin = begin_then_upload
    assert client.post(f"{URL}/confirm", json={"token": pre["token"]}).status_code == 200
    stage.begin = original
    assert stage.get(uid) is not None and stage.get(uid).token != pre["token"]


# ---- hardening: memory, structure, ZIP directory, one heavy job at a time ----


def peak_mb(action) -> float:
    """The highest amount of Python memory (MB) in use while `action` runs, from tracemalloc."""
    import tracemalloc
    tracemalloc.start()
    try:
        action()
        return tracemalloc.get_traced_memory()[1] / 1e6
    finally:
        tracemalloc.stop()


def test_the_dense_gzip_attack_is_stopped_early_and_cheaply(client):
    """65 KB of gzip that unpack to 64 MB of `{"a":[{},{},...]}` used to cost 1.8 GB in one request."""
    raw = b'{"a":[' + b"{}," * (64 * 1024 * 1024 // 3) + b"{}]}"
    attack = gzip.compress(raw, 9)
    del raw
    assert len(attack) < 200_000
    result = {}
    peak = peak_mb(lambda: result.update(r=put(client, "days.json", attack)))
    assert result["r"].status_code == 413
    assert peak < 100, peak
    assert client.get(URL).json()["stage"] is None


def test_a_structure_heavy_file_is_refused_before_it_is_parsed(client):
    """Small enough and not dense enough for the other limits: only the count of containers stops it."""
    body = b'{"a":[' + b"{}," * 1_500_000 + b"{}]}"  # 4.5 MB plain, 1.5 million objects when parsed
    result = {}
    peak = peak_mb(lambda: result.update(r=put(client, "days.json", body)))
    assert result["r"].status_code == 413 and "more entries" in result["r"].json()["detail"]
    assert peak < 60, peak
    tokens = b'{"a":[' + b"1," * 2_500_000 + b"1]}"  # no containers to speak of, but too many elements
    assert put(client, "days.json", tokens).status_code == 413


def test_the_structure_limit_counts_over_all_files_of_a_person(client, monkeypatch):
    monkeypatch.setattr(yazio_stage, "MAX_CONTAINERS", 1000)
    part = b'{"a":[' + b"{}," * 399 + b"{}]}"
    assert put(client, "days.json", part).status_code == 200
    assert put(client, "products.json", part).status_code == 200
    assert put(client, "weight.json", part).status_code == 413  # the third pushes the sum over


def test_a_real_sized_export_passes_all_limits_with_room_to_spare(client):
    from test_yazio import DAYS
    # 1100 days with 12 entries each, like a few years of diary: far below every limit
    import copy
    import random
    rng = random.Random(5)
    days = {}
    for i in range(1100):  # every day different, as real ones are (ids and amounts do not repeat)
        day = copy.deepcopy(DAYS["2026-01-10"])
        for item in day["consumed"]["products"] * 4:
            day["consumed"]["products"].append({**item, "id": str(uuid.UUID(int=rng.getrandbits(128))), "amount": rng.randint(5, 500)})
        day["daily_summary"]["steps"] = rng.randint(1000, 20000)
        days[(date(2023, 1, 1) + timedelta(days=i)).isoformat()] = day
    raw = json.dumps(days, indent=2).encode()
    containers, tokens = yazio_stage.structure(raw)
    assert len(raw) < yazio_stage.MAX_FILE and containers < yazio_stage.MAX_CONTAINERS / 2 and tokens < yazio_stage.MAX_TOKENS / 2
    assert put(client, "days.json", gzip.compress(raw)).status_code == 200
    ratio = len(raw) / len(gzip.compress(raw))
    assert ratio < yazio_stage.MAX_RATIO / 2  # pretty-printed JSON packs far less densely than the limit allows


def test_the_name_is_checked_before_the_body_is_read(client, monkeypatch):
    from starlette.requests import Request

    async def never(self):
        raise AssertionError("the body must not be read for a bad name")

    monkeypatch.setattr(Request, "body", never)
    r = client.put(f"{URL}/files/evil.json", content=b"x" * 1000)
    assert r.status_code == 422


def test_zip_directory_is_judged_before_zipfile_builds_its_entries(client):
    many = make_zip({f"f{i}.txt": "x" for i in range(5000)})
    result = {}
    peak = peak_mb(lambda: result.update(r=put(client, "export.zip", many)))
    assert result["r"].status_code == 422 and "too many entries" in result["r"].json()["detail"]
    assert peak < 30, peak
    # a directory that claims a huge size or ZIP64, whatever the entry count says
    good = bytearray(make_zip({"days.json": DAYS}))
    eocd = good.rfind(b"PK\x05\x06")
    for offset, value, width in ((10, 0xFFFF, 2), (12, 0xFFFFFFFF, 4), (12, 300_000, 4)):
        bad = bytearray(good)
        bad[eocd + offset:eocd + offset + width] = value.to_bytes(width, "little")
        r = put(client, "export.zip", bytes(bad))
        assert r.status_code == 422, (offset, value)
    zip64 = bytes(good[:eocd]) + b"PK\x06\x07" + bytes(16) + bytes(good[eocd:])
    assert put(client, "export.zip", zip64).status_code == 422
    assert put(client, "export.zip", b"PK\x03\x04" + b"\x00" * 30).status_code == 422  # no directory at all
    assert put(client, "export.zip", bytes(good)).status_code == 200  # the untouched one is fine


def test_a_zip_member_that_packs_absurdly_densely_is_refused(client):
    dense = make_zip({"days.json": b'{"a":"' + b"0" * 6_000_000 + b'"}'})  # 6 MB from a few KB
    r = put(client, "export.zip", dense)
    assert r.status_code == 413 and "densely" in r.json()["detail"]


def test_only_one_heavy_job_runs_at_a_time_the_others_get_429_at_once(client):
    upload_all(client)
    stage = client.app.state.yazio_stage
    assert stage.try_heavy()  # somebody else's unpacking, preview or import
    try:
        for r in (put(client, "days.json", DAYS), client.post(f"{URL}/preview", json={}),
                  client.post(f"{URL}/confirm", json={"token": stage.get(client.app.state.store.find_user("me")["id"]).token})):
            assert r.status_code == 429 and r.headers["Retry-After"], r.text
    finally:
        stage.release_heavy()
    assert put(client, "days.json", DAYS).status_code == 200
    assert client.post(f"{URL}/preview", json={}).status_code == 200


def test_an_upload_counts_as_busy_for_the_person_and_frees_the_place_afterwards(client):
    uid = client.get(URL) and client.app.state.store.find_user("me")["id"]
    stage = client.app.state.yazio_stage
    assert stage.begin(uid)
    assert put(client, "days.json", DAYS).status_code == 409
    stage.end(uid)
    assert put(client, "days.json", b"not json").status_code == 422  # a failed upload...
    assert stage.try_heavy() and not stage.release_heavy()  # ...still released the place and the person


def test_a_run_that_collects_too_much_stops_cleanly(live, monkeypatch):
    monkeypatch.setattr(yazio_live, "MAX_RUN_BYTES", 3000)
    start(live)
    run = wait_done(live)
    assert run["error_kind"] == "too_large" and live.get(URL).json()["stage"] is None


def test_the_server_wide_sign_in_cap(live):
    runs = live.app.state.yazio_runs
    gate = threading.Event()
    original = live.fake.__call__
    runs.transport = httpx.MockTransport(lambda request: (gate.wait(5), original(request))[1])
    started = []
    for uid in range(1, 11):
        runs.clock = lambda: 1_800_000_000.0 + uid * 100  # distinct hours-of-minutes, all within one hour
        gate.set()
        started.append(runs.start(uid, yazio_live.Credentials("a@example.invalid", "pw-pw-pw-1"), 1))
        started[-1].thread.join(10)
    runs.clock = lambda: 1_800_000_000.0 + 2000
    with pytest.raises(yazio_live.Refused) as exc:
        runs.start(99, yazio_live.Credentials("a@example.invalid", "pw-pw-pw-1"), 1)
    assert exc.value.kind == "global"
    runs.clock = lambda: 1_800_000_000.0 + 4000  # an hour after the first one
    runs.start(99, yazio_live.Credentials("a@example.invalid", "pw-pw-pw-1"), 1).thread.join(10)


def test_switching_the_connector_off_ends_runs_and_drops_what_they_fetched(live):
    start(live)
    wait_done(live)
    assert live.get(URL).json()["stage"]["source"] == "login"
    assert live.patch("/api/v1/admin/connectors/yazio_login", json={"enabled": False}).status_code == 200
    for r in (live.post(f"{URL}/preview", json={}), live.post(f"{URL}/confirm", json={"token": "x"})):
        assert r.status_code in (404, 410)
    assert live.get(URL).json()["stage"] is None
    assert counts(live)["diary_entry"] == 0


def test_a_run_under_way_ends_when_the_connector_is_switched_off(live):
    gate = threading.Event()
    original = live.fake.__call__

    def slow(request):
        if request.url.path.endswith("consumed-items"):
            gate.wait(5)
        return original(request)

    live.app.state.yazio_runs.transport = httpx.MockTransport(slow)
    start(live)
    time.sleep(0.2)
    live.patch("/api/v1/admin/connectors/yazio_login", json={"enabled": False})
    gate.set()
    live.app.state.store.set_global("yazio_login.enabled", False)
    run = live.app.state.yazio_runs.get(live.app.state.store.find_user("me")["id"])
    run.thread.join(10)
    assert run.state == "cancelled"
    assert live.get(URL).json()["stage"] is None


def test_ids_and_days_must_match_completely_not_just_in_front_of_a_newline():
    assert yazio_live._day("2026-01-10\n") is None and yazio_live._day("2026-01-10") == "2026-01-10"
    assert yazio_live._ID.fullmatch("abc\n") is None and yazio_live._ID.fullmatch("abc-1_2")


def _local_live(local_app, monkeypatch):
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MAHLWERK_YAZIO_CLIENT_SECRET", CLIENT_SECRET)
    local_app.state.store.set_global("yazio_login.enabled", True)
    gate = threading.Event()
    fake = FakeYazio()

    def slow(request):
        if request.url.path.endswith("consumed-items"):
            gate.wait(5)
        return fake(request)

    runs = local_app.state.yazio_runs
    runs.transport = httpx.MockTransport(slow)
    runs.today = lambda: date(2026, 2, 1)

    async def no_sleep(seconds):
        return None

    runs.sleep = no_sleep
    return gate


def test_signing_out_ends_a_running_fetch_and_drops_what_waits(local_app, browser, admin, monkeypatch):
    from conftest import PW
    gate = _local_live(local_app, monkeypatch)
    assert admin.post("/api/v1/admin/users", json={"username": "sam", "password": PW, "is_admin": False}).status_code == 201
    sam = browser()
    assert sam.post("/api/v1/auth/login", json={"username": "sam", "password": PW}).status_code == 200
    upload_all(sam)
    assert sam.post(f"{URL}/login", json={"email": EMAIL, "password": PASSWORD, "months": 2}).status_code == 202
    uid = local_app.state.store.find_user("sam")["id"]
    run = local_app.state.yazio_runs.get(uid)
    assert sam.post("/api/v1/auth/logout").status_code == 204
    gate.set()
    run.thread.join(10)
    assert run.state == "cancelled"
    assert local_app.state.yazio_stage.get(uid) is None


def test_blocking_a_person_ends_their_fetch_too(local_app, browser, admin, monkeypatch):
    from conftest import PW
    gate = _local_live(local_app, monkeypatch)
    admin.post("/api/v1/admin/users", json={"username": "sam", "password": PW, "is_admin": False})
    sam = browser()
    sam.post("/api/v1/auth/login", json={"username": "sam", "password": PW})
    sam.post(f"{URL}/login", json={"email": EMAIL, "password": PASSWORD, "months": 2})
    uid = local_app.state.store.find_user("sam")["id"]
    run = local_app.state.yazio_runs.get(uid)
    assert admin.patch("/api/v1/admin/users/sam", json={"disabled": True}).status_code == 200
    gate.set()
    run.thread.join(10)
    assert run.state == "cancelled" and local_app.state.yazio_stage.get(uid) is None


def test_a_fast_run_is_not_wiped_by_the_start_of_the_run(live, monkeypatch):
    """The route used to clear the person's area AFTER starting the run: a run that finished at once lost its result."""
    uid_holder = {}
    original_start = live.app.state.yazio_runs.start

    def start_and_finish(user_id, credentials, months):
        run = original_start(user_id, credentials, months)
        run.thread.join(10)  # the run is completely done before the route goes on
        uid_holder["run"] = run
        return run

    monkeypatch.setattr(live.app.state.yazio_runs, "start", start_and_finish)
    assert start(live).status_code == 202
    assert uid_holder["run"].state == "done"
    assert live.get(URL).json()["stage"]["source"] == "login"
    assert live.post(f"{URL}/preview", json={}).status_code == 200

"""Photo recognition: reading the (untrusted) answer of the model, the call itself, the routes, the brakes and the rules of access."""

import base64
import io
import json
import logging
import subprocess
import sys
import threading
import time

import httpx
import pytest
from conftest import COST, CSRF, PW
from fastapi.testclient import TestClient
from PIL import Image

import mahlwerk
from mahlwerk import demo_account, imageproc, vision
from mahlwerk.main import create_app

BASE = "http://model.internal.example:11434/v1"
KEY = "sk-test-secret-key-123"
MEAL = "/api/v1/vision/meal"
RECIPE = "/api/v1/vision/recipe"

GOOD_MEAL = {"items": [{"name": "Boiled potatoes", "grams": 250, "kcal": 190, "protein_g": 5, "fat_g": 0.3, "carbs_g": 40, "confidence": 0.8},
                       {"name": "Green beans", "grams": 120, "kcal": 40, "protein_g": 2.1, "fat_g": 0.2, "carbs_g": 6, "confidence": 0.6}],
             "note": "portion sizes are a guess"}
GOOD_RECIPE = {"name": "Pea soup", "portions": 4, "ingredients": ["500 g peas", "1 onion", "1 l stock"],
               "nutrition_per_portion": {"kcal": 210, "protein_g": 11, "fat_g": 4, "carbs_g": 30}, "note": None}


def jpeg(size=(800, 600), exif=False, orientation=1) -> bytes:
    image = Image.new("RGB", size, (200, 120, 40))
    buffer = io.BytesIO()
    if exif:
        data = Image.Exif()
        data[0x0112] = orientation
        data[0x010E] = "SECRET-DESCRIPTION"
        data[0x8825] = {1: "N", 2: (52.0, 31.0, 12.0), 3: "E", 4: (13.0, 24.0, 5.0)}  # a GPS position
        image.save(buffer, "JPEG", exif=data.tobytes())
    else:
        image.save(buffer, "JPEG")
    return buffer.getvalue()


def png(size=(300, 200)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 200, 10)).save(buffer, "PNG")
    return buffer.getvalue()


class Model:
    """Stands in for the image model: records every request and answers with `reply`."""

    def __init__(self, reply=None):
        self.requests: list[httpx.Request] = []
        self.reply = reply if reply is not None else GOOD_MEAL
        self.status = 200
        self.raw: bytes | None = None
        self.error: Exception | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error:
            raise self.error
        if self.raw is not None:
            return httpx.Response(self.status, content=self.raw)
        content = self.reply if isinstance(self.reply, str) else json.dumps(self.reply)
        return httpx.Response(self.status, json={"choices": [{"message": {"role": "assistant", "content": content}}]})

    def body(self, index=-1) -> dict:
        return json.loads(self.requests[index].content)

    def sent_image(self, index=-1) -> bytes:
        url = self.body(index)["messages"][0]["content"][1]["image_url"]["url"]
        assert url.startswith("data:image/jpeg;base64,")
        return base64.b64decode(url.split(",", 1)[1])


@pytest.fixture
def model():
    return Model()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("MAHLWERK_VISION", "1")
    monkeypatch.setenv("MAHLWERK_VISION_URL", BASE)
    monkeypatch.setenv("MAHLWERK_VISION_MODEL", "test-model")
    monkeypatch.setenv("MAHLWERK_VISION_KEY", KEY)


@pytest.fixture
def app(monkeypatch, tmp_path, model, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    return create_app(str(tmp_path / "v.db"), clock=clock, vision_transport=httpx.MockTransport(model))


def ours(caplog) -> str:
    """What the code of Mahlwerk logged (the libraries have loggers of their own: httpx names the address of every request at INFO)."""
    return "\n".join(r.getMessage() for r in caplog.records if r.name.startswith("mahlwerk"))


def person(app, name="ann", groups="family") -> TestClient:
    return TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": name, "Remote-Groups": groups})


@pytest.fixture
def ann(app, configured):
    return person(app)


def upload(client, path=MEAL, data=None, **kw):
    return client.post(path, content=jpeg() if data is None else data, headers={"Content-Type": "image/jpeg"}, **kw)


# ---- reading the answer of the model ----


def test_meal_is_read_from_plain_json_and_from_a_fenced_block():
    plain = vision.parse_meal(json.dumps(GOOD_MEAL))
    fenced = vision.parse_meal("Here you go:\n```json\n" + json.dumps(GOOD_MEAL) + "\n```\nHope that helps")
    prose = vision.parse_meal("Sure! " + json.dumps(GOOD_MEAL) + " Anything else?")
    assert plain == fenced == prose
    assert plain["items"][0] == {"name": "Boiled potatoes", "grams": 250, "kcal": 190, "protein_g": 5, "fat_g": 0.3, "carbs_g": 40, "confidence": 0.8}
    assert plain["note"] == "portion sizes are a guess"


@pytest.mark.parametrize("text", [
    "I see potatoes and beans, about 400 g in total.", "", "{", "{'items': []}", "null", "42", '"items"', "{\"items\": 5}", '{"foods": []}',
    '{"items": [1, "x", null, [], {}]}', '{"items": [{"name": "  "}, {"name": 5}]}',
    '{"items": [{"name": "a", "kcal": NaN}]}', '{"items": [{"name": "a", "kcal": Infinity}]}', '{"items": [{"name": "a", "kcal": -Infinity}]}',
    "[" * 5000 + "]" * 5000, '{"items": ' + "[" * 5000,
])
def test_a_meal_answer_that_is_not_usable_is_an_error_with_a_neutral_text(text):
    with pytest.raises(vision.VisionError) as caught:
        vision.parse_meal(text)
    assert caught.value.kind == "unusable"
    assert str(caught.value) == vision.MESSAGES["unusable"]
    assert text[:20] not in str(caught.value) or text == ""


def test_an_empty_list_is_a_valid_answer():
    assert vision.parse_meal('{"items": [], "note": "no food visible"}') == {"items": [], "note": "no food visible"}
    assert vision.parse_meal("[]")["items"] == []


def test_meal_numbers_are_clamped_and_bad_ones_dropped():
    out = vision.parse_meal(json.dumps({"items": [
        {"name": "x", "grams": 99999, "kcal": -5, "protein_g": "12.5", "fat_g": "lots", "carbs_g": True, "confidence": 7},
        {"name": "y", "grams": [1], "kcal": {"a": 1}, "protein_g": None, "confidence": -1}]}))
    first, second = out["items"]
    assert first == {"name": "x", "grams": 5000, "kcal": 0, "protein_g": 12.5, "fat_g": None, "carbs_g": None, "confidence": 1}
    assert second == {"name": "y", "grams": None, "kcal": None, "protein_g": None, "fat_g": None, "carbs_g": None, "confidence": 0}


def test_meal_lists_names_and_notes_are_cut_and_cleaned():
    items = [{"name": f"item {i}", "kcal": 1} for i in range(500)]
    out = vision.parse_meal(json.dumps({"items": items, "note": "n" * 5000}))
    assert len(out["items"]) == vision.MAX_ITEMS and len(out["note"]) == vision.MAX_NOTE
    out = vision.parse_meal(json.dumps({"items": [
        {"name": "<script>alert(1)</script>Soup <b>hot</b>\u0000‮\x1b[31m  with\n\ttabs", "extra": "ignored", "__proto__": {"x": 1}},
        {"name": "z" * 1000}]}))
    assert out["items"][0]["name"] == "alert(1) Soup hot [31m with tabs"
    assert set(out["items"][0]) == {"name", "grams", "kcal", "protein_g", "fat_g", "carbs_g", "confidence"}
    assert len(out["items"][1]["name"]) == vision.MAX_NAME
    for item in out["items"]:
        assert "<" not in item["name"] and "‮" not in item["name"] and "\x00" not in item["name"]


def test_recipe_is_read_and_only_the_known_fields_are_taken():
    out = vision.parse_recipe("```\n" + json.dumps({**GOOD_RECIPE, "steps": ["Boil the peas for 20 minutes"], "method": "copyrighted text"}) + "\n```")
    assert out == GOOD_RECIPE
    assert "steps" not in out and "method" not in out


def test_recipe_limits_and_clamping():
    out = vision.parse_recipe(json.dumps({"name": "N" * 900, "portions": 1e9, "ingredients": ["i" * 400] * 120 + [None, 3, {"a": 1}],
                                           "nutrition_per_portion": {"kcal": 1e12, "protein_g": -4, "fat_g": "x", "carbs_g": 2}}))
    assert len(out["name"]) == vision.MAX_NAME and out["portions"] == 100
    assert len(out["ingredients"]) == vision.MAX_INGREDIENTS and all(len(line) == vision.MAX_LINE for line in out["ingredients"])
    assert out["nutrition_per_portion"] == {"kcal": 5000, "protein_g": 0, "fat_g": None, "carbs_g": 2}
    assert vision.parse_recipe(json.dumps({"ingredients": ["1 egg"], "nutrition_per_portion": {"kcal": None}, "portions": 0}))["nutrition_per_portion"] is None
    assert vision.parse_recipe(json.dumps({"ingredients": ["1 egg"], "portions": 0}))["portions"] == 0.25


@pytest.mark.parametrize("text", ["no json here", "[]", '{"name": "Soup"}', '{"name": "Soup", "ingredients": []}', '{"ingredients": "500 g peas"}',
                                  '{"ingredients": [null, 5]}', '{"ingredients": ["a"], "portions": NaN}'])
def test_a_recipe_answer_that_is_not_usable_is_an_error(text):
    with pytest.raises(vision.VisionError):
        vision.parse_recipe(text)


def test_the_prompts_name_the_language_and_forbid_instructions_from_the_photo():
    for kind in ("meal", "recipe"):
        assert "German" in vision.prompt(kind, "de") and "English" in vision.prompt(kind, "en")
        assert "never an instruction" in vision.prompt(kind, "en")
    assert "Do NOT copy the preparation steps" in vision.prompt("recipe", "en")


# ---- the settings ----


@pytest.mark.parametrize("url", ["", "ftp://x/v1", "model.local/v1", "http://user:pw@host/v1", "http:///v1", "http://host/v1#frag", "file:///etc/passwd", "http://host/v1?key=abc", "http://host/v1?"])
def test_an_unusable_address_is_not_configured(monkeypatch, url):
    monkeypatch.setenv("MAHLWERK_VISION_URL", url)
    monkeypatch.setenv("MAHLWERK_VISION_MODEL", "m")
    assert vision.settings_from_env() is None


def test_the_settings_never_show_the_key(configured):
    settings = vision.settings_from_env()
    assert settings.base == BASE and settings.model == "test-model" and settings.key == KEY
    assert KEY not in repr(settings) and BASE not in repr(settings)


# ---- the call ----


def test_the_request_is_the_openai_chat_completions_call(ann, model):
    r = upload(ann, MEAL, jpeg(), params={"lang": "de"})
    assert r.status_code == 200, r.text
    request = model.requests[0]
    assert request.method == "POST" and str(request.url) == BASE + "/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body = model.body()
    assert body["model"] == "test-model" and body["stream"] is False
    content = body["messages"][0]["content"]
    assert body["messages"][0]["role"] == "user" and [part["type"] for part in content] == ["text", "image_url"]
    assert "German" in content[0]["text"]
    assert model.sent_image()[:2] == b"\xff\xd8"
    assert r.json()["items"][0]["name"] == "Boiled potatoes"


def test_without_a_key_no_authorization_header_is_sent(ann, model, monkeypatch):
    monkeypatch.delenv("MAHLWERK_VISION_KEY")
    assert upload(ann).status_code == 200
    assert "authorization" not in model.requests[0].headers


def test_the_recipe_route_asks_for_a_recipe(ann, model):
    model.reply = GOOD_RECIPE
    r = upload(ann, RECIPE)
    assert r.status_code == 200 and r.json() == GOOD_RECIPE
    assert "recipe" in model.body()["messages"][0]["content"][0]["text"]


def test_the_default_language_is_english_and_other_values_are_refused(ann, model):
    upload(ann)
    assert "English" in model.body()["messages"][0]["content"][0]["text"]
    assert upload(ann, params={"lang": "fr"}).status_code == 422


@pytest.mark.parametrize("status", [400, 401, 404, 500, 502])
def test_an_error_of_the_model_is_a_502_with_a_neutral_text(ann, model, caplog, status):
    model.status = status
    model.raw = ("secret detail from the model " + KEY + " " + BASE).encode()
    with caplog.at_level(logging.DEBUG):
        r = upload(ann)
    assert r.status_code == 502 and r.json()["detail"] == vision.MESSAGES["unavailable"]
    assert KEY not in r.text and "secret detail" not in r.text and "model.internal" not in r.text
    assert KEY not in caplog.text and "secret detail" not in ours(caplog) and "model.internal" not in ours(caplog)
    assert f"HTTP {status}" in ours(caplog)


def test_a_redirect_is_not_followed(ann, model):
    model.status = 307
    model.raw = b""
    assert upload(ann).status_code == 502
    assert len(model.requests) == 1


def test_a_timeout_is_a_504(ann, model):
    model.error = httpx.ReadTimeout("slow " + KEY)
    r = upload(ann)
    assert r.status_code == 504 and r.json()["detail"] == vision.MESSAGES["timeout"] and KEY not in r.text


@pytest.mark.parametrize("error", [httpx.ConnectError(f"refused {BASE} {KEY}"), httpx.RemoteProtocolError("bad"), OSError("down")])
def test_an_unreachable_model_is_a_502_without_the_address(ann, model, error, caplog):
    model.error = error
    with caplog.at_level(logging.DEBUG):
        r = upload(ann)
    assert r.status_code == 502 and "model.internal" not in r.text and KEY not in r.text
    assert "model.internal" not in ours(caplog) and KEY not in caplog.text


def test_the_time_limits_are_fixed():
    client = vision.Client()
    assert client._http.timeout.connect == vision.CONNECT_TIMEOUT <= 10 and client._http.timeout.read == vision.TOTAL_TIMEOUT == 90
    assert client._http.follow_redirects is False


class Stuck(httpx.SyncByteStream):
    """An answer whose body never arrives: the read blocks until the connection is closed (like a socket with a model that went quiet)."""

    def __init__(self):
        self.release = threading.Event()

    def __iter__(self):
        yield b'{"choices": [{"message": {"content": "'
        self.release.wait(30)  # a real read would wait on the socket
        raise httpx.ReadError("closed")

    def close(self):
        self.release.set()


def test_the_total_limit_is_hard_even_when_a_read_blocks(app, configured, monkeypatch):
    monkeypatch.setattr(vision, "TOTAL_TIMEOUT", 1.0)
    stuck = Stuck()
    app.state.vision.client = vision.Client(httpx.MockTransport(lambda request: httpx.Response(200, stream=stuck)))
    started = time.monotonic()
    r = upload(person(app))
    assert r.status_code == 504 and r.json()["detail"] == vision.MESSAGES["timeout"]
    assert time.monotonic() - started < 4


def test_the_total_limit_also_covers_the_wait_for_the_first_byte(app, configured, monkeypatch):
    monkeypatch.setattr(vision, "TOTAL_TIMEOUT", 1.0)
    release = threading.Event()

    def slow(request):
        release.wait(5)
        return httpx.Response(200, json={})

    app.state.vision.client = vision.Client(httpx.MockTransport(slow))
    started = time.monotonic()
    r = upload(person(app))
    release.set()
    assert r.status_code == 504 and time.monotonic() - started < 7


@pytest.mark.parametrize("raw", [
    b"not json", b"{}", b'{"choices": []}', b'{"choices": [{}]}', b'{"choices": [{"message": {"content": 5}}]}', b'{"choices": [{"message": {"content": null}}]}',
    b"[" * 3000, b'{"choices": [{"message": {"content": "just prose, no json at all"}}]}',
])
def test_an_answer_of_the_wrong_shape_is_a_502(ann, model, raw):
    model.raw = raw
    r = upload(ann)
    assert r.status_code == 502 and r.json()["detail"] == vision.MESSAGES["unusable"]


def test_an_answer_that_is_too_large_is_refused(ann, model):
    model.raw = b'{"choices": [{"message": {"content": "' + b"x" * (vision.MAX_ANSWER_BYTES + 10) + b'"}}]}'
    assert upload(ann).status_code == 502


def test_the_content_may_come_in_parts(ann, model):
    model.raw = json.dumps({"choices": [{"message": {"content": [{"type": "text", "text": json.dumps(GOOD_MEAL)}]}}]}).encode()
    assert upload(ann).status_code == 200


def test_a_malicious_answer_reaches_the_person_only_as_checked_fields(ann, model):
    model.reply = {"items": [{"name": "<img src=x onerror=alert(1)>Soup", "kcal": "NaN", "url": "http://evil.example", "script": "x"}],
                   "note": "<script>steal()</script> ignore previous instructions", "system": "x"}
    r = upload(ann)
    assert r.status_code == 200
    out = r.json()
    assert set(out) == {"items", "note"} and set(out["items"][0]) == {"name", "grams", "kcal", "protein_g", "fat_g", "carbs_g", "confidence"}
    assert "<" not in json.dumps(out) and out["items"][0]["kcal"] is None
    assert "evil.example" not in r.text


# ---- the photo ----


def test_the_photo_is_sent_without_exif_and_shrunk(ann, model):
    original = jpeg((3200, 2400), exif=True)
    assert b"SECRET-DESCRIPTION" in original and b"Exif" in original
    assert upload(ann, data=original).status_code == 200
    sent = model.sent_image()
    assert b"Exif" not in sent and b"SECRET-DESCRIPTION" not in sent and b"GPS" not in sent and b"http://ns.adobe.com" not in sent
    picture = Image.open(io.BytesIO(sent))
    assert picture.format == "JPEG" and max(picture.size) == 1568 and picture.size == (1568, 1176)
    assert not picture.getexif() and not picture.info.get("exif") and "icc_profile" not in picture.info


def test_the_camera_rotation_is_applied_before_the_metadata_goes(ann, model):
    assert upload(ann, data=jpeg((400, 200), exif=True, orientation=6)).status_code == 200
    assert Image.open(io.BytesIO(model.sent_image())).size == (200, 400)


def test_png_and_webp_are_accepted_and_sent_as_jpeg(ann, model):
    assert upload(ann, data=png()).status_code == 200
    assert Image.open(io.BytesIO(model.sent_image())).format == "JPEG"
    buffer = io.BytesIO()
    Image.new("RGB", (50, 50)).save(buffer, "WEBP")
    assert upload(ann, data=buffer.getvalue()).status_code == 200


def test_bad_uploads_are_refused_before_the_model_is_asked(ann, model):
    assert upload(ann, data=b"").status_code == 422
    assert upload(ann, data=b"GIF89a" + b"\0" * 100).status_code == 422
    assert upload(ann, data=b"%PDF-1.4 not a picture").status_code == 422
    assert upload(ann, data=jpeg()[:200]).status_code in (413, 422)  # cut off: the header may still read
    # a tiny file that claims 40 megapixels
    big = bytearray(png())
    big[16:24] = (7000).to_bytes(4, "big") + (6000).to_bytes(4, "big")
    assert upload(ann, data=bytes(big)).status_code == 413
    assert upload(ann, data=jpeg() + b"\0" * (9 * 1024 * 1024)).status_code == 413
    assert upload(ann, data=jpeg() + b"\0" * (7 * 1024 * 1024)).status_code != 413  # below the limit: a decoder decides


def test_nothing_of_the_photo_or_the_answer_is_logged_or_stored(ann, model, caplog, tmp_path, app):
    data = jpeg(exif=True)
    with caplog.at_level(logging.DEBUG):
        assert upload(ann, data=data).status_code == 200
    assert base64.b64encode(model.sent_image())[:60].decode() not in caplog.text
    assert "Boiled potatoes" not in caplog.text and KEY not in caplog.text and BASE not in ours(caplog)
    import sqlite3
    con = sqlite3.connect(app.state.store.path)
    dump = "\n".join(con.iterdump())
    con.close()
    assert "Boiled potatoes" not in dump and "potatoes" not in dump


# ---- who may use it, and when ----


def test_switched_off_is_a_404(app, configured, monkeypatch):
    monkeypatch.delenv("MAHLWERK_VISION")
    ann = person(app)
    assert upload(ann).status_code == 404 and upload(ann, RECIPE).status_code == 404
    assert ann.get("/api/v1/vision/status").json() == {"enabled": False, "configured": True, "ready": False, "per_hour": 30}


@pytest.mark.parametrize("missing", ["MAHLWERK_VISION_URL", "MAHLWERK_VISION_MODEL"])
def test_not_configured_is_a_409(ann, model, monkeypatch, missing):
    monkeypatch.delenv(missing)
    r = upload(ann)
    assert r.status_code == 409 and "MAHLWERK_VISION" in r.json()["detail"]
    assert not model.requests
    assert ann.get("/api/v1/vision/status").json()["ready"] is False


def test_status_says_ready_and_holds_no_address_or_key(ann):
    r = ann.get("/api/v1/vision/status")
    assert r.json() == {"enabled": True, "configured": True, "ready": True, "per_hour": 30}
    assert KEY not in r.text and "model.internal" not in r.text


def test_an_access_key_is_refused_everywhere(app, ann, model):
    token = ann.post("/api/v1/me/tokens", json={"name": "script", "scope": "write"}).json()["token"]
    script = TestClient(app, client=("10.0.0.5", 1), headers={"Authorization": f"Bearer {token}", "X-Mahlwerk-Request": "1"})
    for method, path in (("GET", "/api/v1/vision/status"), ("POST", MEAL), ("POST", RECIPE)):
        r = script.request(method, path, content=jpeg() if method == "POST" else None)
        assert r.status_code == 403, path
    assert not model.requests


def test_without_a_sign_in_it_is_a_401(app, configured, model):
    stranger = TestClient(app, client=("203.0.113.9", 1), headers=CSRF)
    for method, path in (("GET", "/api/v1/vision/status"), ("POST", MEAL), ("POST", RECIPE)):
        assert stranger.request(method, path, content=b"x").status_code == 401, path
    assert not model.requests


def test_the_routes_are_closed_to_the_demo_account(monkeypatch, tmp_path, model, configured):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    app = create_app(str(tmp_path / "d.db"), password_cost=COST, vision_transport=httpx.MockTransport(model))
    admin = TestClient(app, client=("198.51.100.7", 50000), headers=CSRF)
    assert admin.post("/api/v1/auth/setup", json={"username": "alex", "password": PW}).status_code == 201
    assert upload(admin).status_code == 200  # the real account may
    assert admin.patch("/api/v1/admin/connectors/demo_account", json={"enabled": True}).status_code == 200
    assert admin.post("/api/v1/me/demo-view/enter").status_code == 200
    admin.headers["X-Mahlwerk-View"] = "demo"
    calls = len(model.requests)
    for method, path in (("GET", "/api/v1/vision/status"), ("POST", MEAL), ("POST", RECIPE)):
        assert admin.request(method, path, content=jpeg() if method == "POST" else None).status_code == 403, path
    assert len(model.requests) == calls
    for route in (("GET", "/api/v1/vision/status"), ("POST", MEAL), ("POST", RECIPE)):
        assert demo_account.POLICY[route] == "blocked"


# ---- the brakes ----


def test_the_brake_counts_per_person_and_per_hour(app, configured, model, clock, monkeypatch):
    monkeypatch.setenv("MAHLWERK_VISION_PER_HOUR", "3")
    ann, ben = person(app), person(app, "ben")
    for _ in range(3):
        assert upload(ann).status_code == 200
    r = upload(ann)
    assert r.status_code == 429 and 1 <= int(r.headers["Retry-After"]) <= 3601
    assert len(model.requests) == 3
    assert upload(ben).status_code == 200  # somebody else is not affected
    clock.now += 3601
    assert upload(ann).status_code == 200  # the hour is over


def test_refused_photos_do_not_use_up_the_allowance(ann, monkeypatch):
    monkeypatch.setenv("MAHLWERK_VISION_PER_HOUR", "2")
    for _ in range(5):
        assert upload(ann, data=b"not a picture").status_code == 422
    assert upload(ann).status_code == 200


def test_a_wrong_setting_of_the_allowance_falls_back_to_the_default(monkeypatch):
    for raw, want in (("", 30), ("many", 30), ("0", 1), ("-4", 1), ("100000", 10000), ("12", 12)):
        monkeypatch.setenv("MAHLWERK_VISION_PER_HOUR", raw)
        assert vision.per_hour_from_env() == want


def test_at_most_two_runs_at_the_same_time(app, ann, model):
    brake = app.state.vision.brake
    assert brake.slot() and brake.slot() and not brake.slot()  # two runs are under way
    r = upload(ann)
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
    assert not model.requests
    brake.release()
    assert upload(ann).status_code == 200  # a place is free again
    brake.release()


def test_the_places_are_given_back_after_every_outcome(app, ann, model):
    model.status = 500
    for _ in range(6):
        assert upload(ann).status_code == 502
    model.status = 200
    model.error = httpx.ReadTimeout("x")
    for _ in range(3):
        assert upload(ann).status_code == 504
    model.error = None
    assert upload(ann).status_code == 200


def test_a_busy_picture_worker_is_a_429(ann, monkeypatch):
    def busy(data):
        raise imageproc.ImageRejected("busy")

    monkeypatch.setattr(imageproc, "for_model", busy)
    r = upload(ann)
    assert r.status_code == 429 and r.headers["Retry-After"] == "5"


# ---- the admin card ----


def card(client) -> dict:
    return {c["key"]: c for c in client.get("/api/v1/admin/connectors").json()}["vision"]


def test_the_card_shows_the_state_the_model_and_no_secret(app, configured, monkeypatch):
    admin = person(app, "root", "admin")
    c = card(admin)
    assert c["kind"] == "source" and c["configurable"] is True
    assert c["enabled"] is True and c["status"] == "ready" and c["locked"] == ["enabled"]  # the environment fixes the switch
    assert c["info"]["model"] == "test-model" and "MAHLWERK_VISION_URL" in c["info"]["env"] and c["info"]["per_hour"] == 30
    text = json.dumps(admin.get("/api/v1/admin/connectors").json())
    assert KEY not in text and "model.internal" not in text and "11434" not in text
    monkeypatch.delenv("MAHLWERK_VISION_URL")
    assert card(admin)["status"] == "not_configured"
    monkeypatch.delenv("MAHLWERK_VISION_MODEL")
    assert card(admin)["info"]["model"] is None


def test_the_admin_switches_it_and_the_routes_follow(app, configured, monkeypatch, model):
    monkeypatch.delenv("MAHLWERK_VISION")
    admin, ann = person(app, "root", "admin"), person(app)
    assert card(admin)["enabled"] is False and card(admin)["status"] == "off" and card(admin)["locked"] == []
    assert upload(ann).status_code == 404
    assert admin.patch("/api/v1/admin/connectors/vision", json={"enabled": True}).json()["status"] == "ready"
    assert upload(ann).status_code == 200
    assert admin.patch("/api/v1/admin/connectors/vision", json={"enabled": False}).status_code == 200
    assert upload(ann).status_code == 404
    assert ann.patch("/api/v1/admin/connectors/vision", json={"enabled": True}).status_code == 403
    monkeypatch.setenv("MAHLWERK_VISION", "0")
    assert admin.patch("/api/v1/admin/connectors/vision", json={"enabled": True}).status_code == 409  # fixed by the environment


def test_the_default_is_off(app, configured, monkeypatch):
    monkeypatch.delenv("MAHLWERK_VISION")
    assert card(person(app, "root", "admin"))["enabled"] is False


def test_the_upload_limit_is_registered():
    from mahlwerk import security
    assert security.limit_for(MEAL) == security.limit_for(RECIPE) == 8 * 1024 * 1024


# ---- more of the call ----


def test_no_compression_is_asked_for_and_a_compressed_answer_is_refused(ann, model):
    upload(ann)
    assert model.requests[0].headers["accept-encoding"] == "identity"
    import gzip
    model.raw = gzip.compress(json.dumps({"choices": [{"message": {"content": json.dumps(GOOD_MEAL)}}]}).encode())
    original = model.__call__

    def zipped(request):
        original(request)
        return httpx.Response(200, headers={"content-encoding": "gzip"}, content=model.raw)

    ann.app.state.vision.client = vision.Client(httpx.MockTransport(zipped))
    assert upload(ann).status_code == 502


def test_a_model_that_is_busy_is_a_429_with_its_retry_after_and_costs_no_allowance(app, configured, model, monkeypatch):
    monkeypatch.setenv("MAHLWERK_VISION_PER_HOUR", "2")
    ann = person(app)
    original = model.__call__

    def busy(request):
        model.requests.append(request)
        return httpx.Response(429, headers={"Retry-After": "17"}, text="queue full " + KEY)

    app.state.vision.client = vision.Client(httpx.MockTransport(busy))
    for _ in range(5):  # more often than the allowance: none of them counts
        r = upload(ann)
        assert r.status_code == 429 and r.headers["Retry-After"] == "17" and KEY not in r.text and "queue full" not in r.text
    app.state.vision.client = vision.Client(httpx.MockTransport(original))
    assert upload(ann).status_code == 200 and upload(ann).status_code == 200
    assert upload(ann).status_code == 429  # now the allowance is used up


def test_a_model_503_is_busy_too_and_a_wild_retry_after_is_bounded(app, configured):
    def busy(request):
        return httpx.Response(503, headers={"Retry-After": "99999"})

    app.state.vision.client = vision.Client(httpx.MockTransport(busy))
    r = upload(person(app))
    assert r.status_code == 429 and r.headers["Retry-After"] == "300"
    app.state.vision.client = vision.Client(httpx.MockTransport(lambda request: httpx.Response(503, headers={"Retry-After": "soon"})))
    assert upload(person(app)).headers["Retry-After"] == "10"


def test_the_number_of_parallel_runs_is_set_by_the_environment(monkeypatch, tmp_path):
    for raw, want in (("", 2), ("x", 2), ("0", 1), ("99", 8), ("1", 1), ("4", 4)):
        monkeypatch.setenv("MAHLWERK_VISION_PARALLEL", raw)
        assert vision.parallel_from_env() == want
    monkeypatch.setenv("MAHLWERK_VISION_PARALLEL", "1")
    app = create_app(str(tmp_path / "p.db"))
    brake = app.state.vision.brake
    assert brake.slot() and not brake.slot()


@pytest.mark.parametrize("filler", [" ", "a", "`", "``", "\n", "{", "[", "-", "<"])
def test_an_unclosed_fence_and_other_hostile_texts_cost_no_time(filler):
    for text in ("```" + filler * 250_000, "```json" + filler * 250_000, "```" * 80_000, ("```" + filler) * 60_000, "<" * 250_000):
        for parse in (vision.parse_meal, vision.parse_recipe):
            started = time.monotonic()
            with pytest.raises(vision.VisionError):
                parse(text)
            assert time.monotonic() - started < 0.5, (filler, text[:10])


def test_the_text_is_cut_before_reading_and_numbers_as_text_are_bounded():
    assert vision.clean_number(" " * 250_000 + "x", 0, 10) is None
    late = " " * vision.MAX_CONTENT + json.dumps(GOOD_MEAL)  # the answer starts after the part that is looked at
    with pytest.raises(vision.VisionError):
        vision.parse_meal(late)


# ---- the picture child: the same code as this process, and clean output in both modes ----


def _meta_jpeg():
    image = Image.new("RGB", (400, 300), (200, 120, 40))
    exif = Image.Exif()
    exif[0x010E] = "SECRETEXIF"
    exif[0x8825] = {1: "N", 2: (52.0, 31.0, 12.0), 3: "E", 4: (13.0, 24.0, 5.0)}
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", exif=exif.tobytes(), icc_profile=b"ICCSECRET" * 40, comment=b"SECRETCOMMENT",
               xmp=b"<x:xmpmeta SECRETXMP></x:xmpmeta>")
    return buffer.getvalue()


def _meta_png():
    from PIL.PngImagePlugin import PngInfo

    info = PngInfo()
    info.add_text("Comment", "SECRETTEXT")
    info.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta SECRETXMP></x:xmpmeta>")
    exif = Image.Exif()
    exif[0x010E] = "SECRETEXIF"
    buffer = io.BytesIO()
    Image.new("RGB", (400, 300), (10, 200, 10)).save(buffer, "PNG", pnginfo=info, icc_profile=b"ICCSECRET" * 40, exif=exif.tobytes())
    return buffer.getvalue()


def _meta_webp():
    exif = Image.Exif()
    exif[0x010E] = "SECRETEXIF"
    buffer = io.BytesIO()
    Image.new("RGB", (400, 300), (10, 10, 200)).save(buffer, "WEBP", exif=exif.tobytes(), icc_profile=b"ICCSECRET" * 40,
                                                      xmp=b"<x:xmpmeta SECRETXMP></x:xmpmeta>")
    return buffer.getvalue()


MARKERS = (b"SECRETEXIF", b"SECRETCOMMENT", b"SECRETTEXT", b"SECRETXMP", b"ICCSECRET", b"Exif", b"xmpmeta", b"ICC_PROFILE", b"GPS")


@pytest.mark.parametrize("make", [_meta_jpeg, _meta_png, _meta_webp])
def test_the_real_child_strips_all_metadata_in_both_modes(make):
    data = make()
    assert any(marker in data for marker in MARKERS[:5])  # the test picture really carries them
    clean = imageproc.for_model(data)
    assert not [m for m in MARKERS if m in clean]
    picture = Image.open(io.BytesIO(clean))
    assert picture.format == "JPEG" and not (set(picture.info) & {"exif", "icc_profile", "comment", "xmp", "XML:com.adobe.xmp"})
    made = imageproc.process(data)
    for key, blob in made.files.items():
        assert not [m for m in MARKERS if m in blob], key
        assert not (set(Image.open(io.BytesIO(blob)).info) & {"exif", "icc_profile", "xmp"})


def test_the_real_child_limits_pixels_and_formats_in_both_modes():
    big = bytearray(png())
    big[16:24] = (7000).to_bytes(4, "big") + (6000).to_bytes(4, "big")
    for run in (imageproc.for_model, imageproc.process):
        with pytest.raises(imageproc.ImageRejected) as caught:
            run(bytes(big))
        assert caught.value.kind == "too_many_pixels"
        with pytest.raises(imageproc.ImageRejected) as caught:
            run(b"GIF89a" + b"\0" * 50)
        assert caught.value.kind == "format"
        with pytest.raises(imageproc.ImageRejected):
            run(jpeg()[:300])  # cut off in the middle of the data


def test_the_child_runs_the_code_of_this_copy_of_the_package():
    assert imageproc.PACKAGE_ROOT == str(__import__("pathlib").Path(imageproc.__file__).resolve().parent.parent)
    found = subprocess.run([sys.executable, "-I", "-c", imageproc.CHILD_CODE.replace("from mahlwerk.imageproc import _main; sys.exit(_main())", "import mahlwerk; print(mahlwerk.__file__)"),
                            imageproc.PACKAGE_ROOT], capture_output=True, text=True, check=True).stdout.strip()
    assert found == mahlwerk.__file__

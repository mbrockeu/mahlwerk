"""Recipes from web pages: reading schema.org data, the plausibility checks and every guard of the fetch.

No test needs a network: the web is `httpx.MockTransport`, names resolve through the fake resolver of conftest
(`internal.example` is a LAN address, `dual.example` has a public and an internal one, `localhost` is loopback).
"""

import gzip
import json
import zlib

import httpx
import pytest
from fastapi.testclient import TestClient

from mahlwerk import netguard, webrecipes
from mahlwerk.main import create_app

PAGE = "https://recipes.example.org/lentil-salad"
GOOD = {
    "@context": "https://schema.org", "@type": "Recipe", "name": "Red lentil salad", "recipeYield": "4 servings",
    "recipeIngredient": ["200 g red lentils", "1 tbsp olive oil &amp; lemon"],
    "recipeInstructions": "SECRET STEPS", "description": "SECRET DESCRIPTION", "image": "https://recipes.example.org/x.jpg",
    "nutrition": {"@type": "NutritionInformation", "calories": "497 kcal", "proteinContent": "37 g", "carbohydrateContent": "73 g",
                  "fatContent": "8 g", "saturatedFatContent": "5 g", "sugarContent": "6,5 g", "fiberContent": "12.2 g",
                  "sodiumContent": "1.168 mg", "servingSize": "1 serving"},
}


def html(*blocks, extra="") -> str:
    scripts = "".join(f'<script type="application/ld+json">{b if isinstance(b, str) else json.dumps(b).replace("</", "<\\/")}</script>' for b in blocks)
    return f"<!doctype html><html><head><title>x</title>{scripts}</head><body>{extra}<h1>Page</h1></body></html>"


class Chunks(httpx.SyncByteStream):
    """A body that arrives in pieces, like on the wire (a ByteStream would be read at once)."""

    def __init__(self, data: bytes, size: int = 65536):
        self.data, self.size = data, size

    def __iter__(self):
        for i in range(0, len(self.data), self.size):
            yield self.data[i:i + self.size]


class Web:
    """The stand-in for the web: serves pages by URL, records what was asked."""

    def __init__(self):
        self.pages: dict[str, httpx.Response | callable] = {}
        self.seen: list[httpx.Request] = []
        self.cache = None  # the app's cache of fetched pages: a page that changes in a test must not come from it

    def page(self, url, body, status=200, headers=None, content_type="text/html; charset=utf-8", **kw):
        h = {"content-type": content_type, **(headers or {})}
        if self.cache is not None:
            self.cache._items.clear()
        data = body if isinstance(body, bytes) else body.encode()
        self.pages[url] = lambda: httpx.Response(status, headers=h, stream=Chunks(data), **kw)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        host = request.headers["host"]
        url = f"{request.url.scheme}://{host}{request.url.raw_path.decode()}"
        hit = self.pages.get(url)
        if hit is None:
            return httpx.Response(404, text="nope")
        return hit()


@pytest.fixture
def web():
    return Web()


@pytest.fixture
def app(tmp_path, monkeypatch, web):
    monkeypatch.setenv("MAHLWERK_WEB_RECIPES", "1")
    app = create_app(str(tmp_path / "w.db"), web_transport=httpx.MockTransport(web))
    web.cache = app.state.web_cache
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def preview(client, url=PAGE, **kw):
    return client.post("/api/v1/web-recipes/preview", json={"url": url, **kw})


def serve(web, *blocks, url=PAGE):
    web.page(url, html(*blocks))


# ---- reading ----


def test_preview_reads_name_portions_nutrition_and_shows_ingredients(client, web):
    serve(web, GOOD)
    r = preview(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Red lentil salad" and body["portions"] == 4 and body["host"] == "recipes.example.org"
    assert body["per_portion"]["kcal"] == 497 and body["per_portion"]["protein"] == 37 and body["per_portion"]["sugars"] == 6.5
    assert body["per_portion"]["fiber"] == 12.2 and body["extra"]["sodium"] == 1168 and body["per_portion"]["salt"] == pytest.approx(2.92, abs=0.01)
    assert body["complete"] and body["blocked"] is None and body["warnings"] == []
    assert body["ingredients"] == ["200 g red lentils", "1 tbsp olive oil & lemon"]
    assert "SECRET" not in r.text and "x.jpg" not in r.text  # steps, description and picture never leave the parser


def test_take_over_stores_values_and_link_but_no_text(client, web):
    serve(web, GOOD)
    r = client.post("/api/v1/web-recipes", json={"url": PAGE})
    assert r.status_code == 200, r.text
    food = r.json()
    assert food["source"] == "web" and food["portions"] == 4 and food["url"] == PAGE
    assert food["brand"] == "Web · recipes.example.org" and food["external_id"] == "web:recipes.example.org/lentil-salad"
    assert food["per_100"]["kcal"] == 497 and food["serving_quantity"] == 100
    stored = json.dumps(client.app.state.store.get_food(food["id"])["data"])
    assert "lentils" not in stored and "SECRET" not in stored and "x.jpg" not in stored  # nothing but values, name, portions, address


@pytest.mark.parametrize("node", [
    {"@graph": [{"@type": "WebSite", "name": "x"}, GOOD]},
    [{"@type": "BreadcrumbList"}, GOOD],
    {**GOOD, "@type": ["Recipe", "NewsArticle"]},
    {**GOOD, "@type": "https://schema.org/Recipe"},
    {"@type": "WebPage", "mainEntity": GOOD},
    {"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "item": GOOD}]},
])
def test_json_ld_shapes(client, web, node):
    serve(web, node)
    assert preview(client).json()["name"] == "Red lentil salad"


def test_several_blocks_broken_json_and_comments(client, web):
    web.page(PAGE, "<html><head>"
             '<script type="application/ld+json">{ this is not json </script>'
             '<!-- <script type="application/ld+json">{"@type":"Recipe","name":"Commented out","nutrition":{"calories":"1"}}</script> -->'
             '<script type="application/ld+json">{"@type":"Organization","name":"Site"}</script>'
             '<script type="application/ld+json">' + "<!--\n" + json.dumps(GOOD) + "\n-->" + "</script>"
             "</head></html>")
    assert preview(client).json()["name"] == "Red lentil salad"


def test_entities_and_markup_in_text_become_plain_text(client, web):
    serve(web, {**GOOD, "name": "Mac &amp; Cheese <b>deluxe</b>‮\x07"})
    assert preview(client).json()["name"] == "Mac & Cheese deluxe"


def test_prefers_the_recipe_that_has_nutrition(client, web):
    serve(web, {"@type": "Recipe", "name": "No numbers"}, GOOD)
    assert preview(client).json()["name"] == "Red lentil salad"


@pytest.mark.parametrize("given,expected", [
    (4, 4), ("4", 4), ("4 Portionen", 4), ("Serves 6", 6), (["8", "8 servings"], 8), ({"@type": "QuantitativeValue", "value": 2}, 2),
    ("12 cookies", 12), (3.5, 3.5),
])
def test_yield_forms(given, expected):
    assert webrecipes.parse_yield(given)[0] == expected


def test_yield_range_and_nonsense():
    assert webrecipes.parse_yield("4-6 servings") == (4, True)
    assert webrecipes.parse_yield("a few")[0] is None
    assert webrecipes.parse_yield(0)[0] is None and webrecipes.parse_yield(100000)[0] is None and webrecipes.parse_yield(None)[0] is None


@pytest.mark.parametrize("text,expected", [
    ("523 kcal", 523), ("523", 523), (523, 523), ("523 Kcal", 523), ("1.250 kcal", 1250), ("1,250 kcal", 1250),
    ("2190 kJ", 2190 / 4.184), ("523 kcal / 2190 kJ", 523), ("2.190 kJ", 2190 / 4.184), ("523,5 kcal", 523.5), ("523 calories", 523),
    ("n/a", None), ("-5 kcal", None),
])
def test_energy(text, expected):
    got = webrecipes.parse_energy(text)
    assert (got is None) if expected is None else got == pytest.approx(expected)


@pytest.mark.parametrize("text,default,expected", [
    ("12,5 g", "g", 12.5), ("12.5 g", "g", 12.5), ("12 g", "g", 12), ("12", "g", 12), ("1.200 mg", "g", 1.2), ("1,200 mg", "g", 1.2),
    ("500 mg", "g", 0.5), ("1.2 g", "mg", 1.2), ("1168", "mg", 1.168), ("1.168", "mg", 1.168), ("1.5", "g", 1.5), ("0.250 g", "g", 0.25),
    ("1.234,5 g", "g", 1234.5), ("1,234.5 g", "g", 1234.5), ("2 mcg", "g", 2e-6), ("x", "g", None),
])
def test_grams(text, default, expected):
    got = webrecipes.parse_grams(text, default)
    assert (got is None) if expected is None else got == pytest.approx(expected)


def test_kilojoules_only_and_german_formats(client, web):
    node = {**GOOD, "nutrition": {"calories": "2.082 kJ", "proteinContent": "37,0 g", "carbohydrateContent": "73,0 g", "fatContent": "8,0 g"}}
    serve(web, node)
    body = preview(client).json()
    assert body["per_portion"]["kcal"] == pytest.approx(497.6, abs=0.1) and body["per_portion"]["protein"] == 37


def test_missing_nutrition_is_said_not_stored_as_zero(client, web):
    serve(web, {"@type": "Recipe", "name": "Plain", "recipeYield": "2", "recipeIngredient": ["1 egg"]})
    body = preview(client).json()
    assert body["blocked"] == "no_energy" and body["per_portion"]["kcal"] is None and body["ingredients"] == ["1 egg"] and body["name"] == "Plain"
    r = client.post("/api/v1/web-recipes", json={"url": PAGE})
    assert r.status_code == 422 and "0 kcal" in r.json()["detail"]
    assert client.get("/api/v1/foods", params={"source": "web"}).json() == []


def test_whole_recipe_switch_divides_by_the_portions(client, web):
    node = {**GOOD, "recipeYield": "4", "nutrition": {"calories": "2000 kcal", "proteinContent": "148 g", "carbohydrateContent": "292 g", "fatContent": "32 g", "sodiumContent": "4000 mg"}}
    serve(web, node)
    first = preview(client).json()
    assert "maybe_whole" in first["warnings"] or first["per_portion"]["carbs"] > 150
    body = preview(client, whole=True).json()
    assert body["per_portion"]["kcal"] == 500 and body["per_portion"]["protein"] == 37 and body["extra"]["sodium"] == 1000 and body["whole"]
    assert "maybe_whole" not in body["warnings"]
    food = client.post("/api/v1/web-recipes", json={"url": PAGE, "whole": True}).json()
    assert food["per_100"]["kcal"] == 500


def test_whole_recipe_needs_portions_and_portions_can_be_corrected(client, web):
    node = {**GOOD, "nutrition": {"calories": "2000 kcal"}}
    del node["recipeYield"]
    serve(web, node)
    body = preview(client, whole=True).json()
    assert body["blocked"] == "whole_needs_portions" and "no_portions" in body["warnings"]
    body = preview(client, whole=True, portions=5).json()
    assert body["blocked"] is None and body["per_portion"]["kcal"] == 400 and body["portions"] == 5 and body["page_portions"] is None


def test_name_can_be_corrected_and_is_required(client, web):
    serve(web, {**GOOD, "name": ""})
    assert preview(client).json()["blocked"] == "no_name"
    food = client.post("/api/v1/web-recipes", json={"url": PAGE, "name": "  My salad "}).json()
    assert food["name"] == "My salad"


def test_warnings_energy_mismatch_and_implausible_values(client, web):
    serve(web, {**GOOD, "nutrition": {"calories": "100 kcal", "proteinContent": "37 g", "carbohydrateContent": "73 g", "fatContent": "8 g"}})
    assert "energy_mismatch" in preview(client).json()["warnings"]
    serve(web, {**GOOD, "recipeYield": "4", "nutrition": {"calories": "9000 kcal"}})
    body = preview(client).json()
    assert body["blocked"] == "too_high"
    assert client.post("/api/v1/web-recipes", json={"url": PAGE}).status_code == 422
    assert preview(client, whole=True).json()["blocked"] is None  # 9000 / 4 = 2250 per portion


def test_value_above_what_a_portion_can_hold_is_unknown_not_a_wrong_number(client, web):
    serve(web, {**GOOD, "nutrition": {"calories": "800 kcal", "proteinContent": "900 g", "carbohydrateContent": "10 g", "fatContent": "10 g"}})
    body = preview(client).json()
    assert body["per_portion"]["protein"] is None and "rounded_off" in body["warnings"] and not body["complete"]


def test_no_recipe_on_the_page(client, web):
    serve(web, {"@type": "Article", "name": "News"})
    r = preview(client)
    assert r.status_code == 422 and "no recipe data" in r.json()["detail"]
    web.page(PAGE + "2", "<html><body>plain</body></html>")
    assert preview(client, PAGE + "2").status_code == 422


def test_deep_json_does_not_crash(client, web):
    web.page(PAGE, '<script type="application/ld+json">' + "[" * 200000 + "</script>" + html(GOOD))
    assert preview(client).status_code in (200, 422)
    serve(web, {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": GOOD}}}}}}}})  # deeper than the search goes
    assert preview(client).status_code == 422


# ---- addresses and idempotency ----


def test_address_is_the_identity(client, web):
    serve(web, GOOD)
    a = client.post("/api/v1/web-recipes", json={"url": PAGE}).json()
    b = client.post("/api/v1/web-recipes", json={"url": PAGE + "?utm_source=x&utm_medium=y&fbclid=1#comments"}).json()
    c = client.post("/api/v1/web-recipes", json={"url": "HTTPS://Recipes.Example.org:443/lentil-salad"}).json()
    assert a["id"] == b["id"] == c["id"]
    assert len(client.get("/api/v1/foods", params={"source": "web"}).json()) == 1
    d = preview(client, PAGE + "?utm_source=z").json()
    assert d["food_id"] == a["id"] and d["url"] == PAGE


@pytest.mark.parametrize("url", [
    "ftp://recipes.example.org/x", "javascript:alert(1)", "file:///etc/passwd", "//recipes.example.org/x", "recipes.example.org/x",
    "https://user:pw@recipes.example.org/x", "https://user@recipes.example.org/x", "https://recipes.example.org:8443/x",
    "http://recipes.example.org:22/x", "https://127.0.0.1/x", "https://[::1]/x", "https://2130706433/x", "https://0x7f000001/x",
    "https://127.1/x", "https://localhost/x", "https://nodot/x", "https://exa mple.org/x", "https://recipes.example.org/\x00", "",
    "https://" + "a" * 300 + ".org/", "https://recipes.example.org/" + "x" * 900,
])
def test_bad_addresses_are_refused_before_any_connection(client, web, url):
    r = preview(client, url) if url else client.post("/api/v1/web-recipes/preview", json={"url": " "})
    assert r.status_code == 422 and web.seen == []


def test_normal_form():
    n = lambda u: webrecipes.check_address(u)[0]  # noqa: E731
    assert n("http://Example.ORG:80/a?b=2&a=1&utm_x=3#f") == "http://example.org/a?a=1&b=2"
    assert n("https://example.org") == "https://example.org/"
    assert n(n("https://example.org/r?x=%C3%A4+b&y=")) == n("https://example.org/r?x=%C3%A4+b&y=")
    assert webrecipes.external_id(n("http://example.org/a")) == webrecipes.external_id(n("https://example.org/a")) == "web:example.org/a"
    assert webrecipes.host_label("https://www.example.org/a") == "example.org"
    assert webrecipes.safe_link("javascript:alert(1)") is None and webrecipes.safe_link("https://example.org/a#x") == "https://example.org/a"


# ---- the guards of the fetch ----


def test_request_is_pinned_plain_and_identifies_the_project(client, web):
    serve(web, GOOD)
    preview(client)
    req = web.seen[0]
    assert req.url.host == "93.184.216.34"  # the checked address, not the name
    assert req.headers["host"] == "recipes.example.org"
    assert req.headers["user-agent"].startswith("Mahlwerk/") and "referer" not in req.headers and "cookie" not in req.headers
    assert req.extensions["sni_hostname"] == "recipes.example.org"
    assert req.headers["accept-encoding"] == "gzip, deflate"


@pytest.mark.parametrize("host", ["internal.example", "dual.example", "nothere.invalid"])
def test_internal_or_unresolvable_targets_get_the_same_answer_and_no_connection(client, web, host):
    r = preview(client, f"https://{host}/r")
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL and web.seen == []


def test_dns_answer_that_changes_after_the_check_gains_nothing(client, web, monkeypatch):
    serve(web, GOOD, url="https://rebind.example/r")
    calls = []

    def resolver(host, port):
        calls.append(host)
        return ["93.184.216.34"] if len(calls) == 1 else ["10.0.0.7"]

    monkeypatch.setattr(netguard, "resolver", resolver)
    assert preview(client, "https://rebind.example/r").status_code == 200
    assert len(calls) == 1 and web.seen[0].url.host == "93.184.216.34"  # resolved once, connected to that address


def test_redirects_are_followed_by_hand_and_every_station_is_checked(client, web):
    web.page("https://short.example.org/a", "", status=301, headers={"location": "https://recipes.example.org/lentil-salad?utm_source=s"})
    serve(web, GOOD)
    body = preview(client, "https://short.example.org/a").json()
    assert body["name"] == "Red lentil salad" and body["host"] == "recipes.example.org" and body["url"] == "https://short.example.org/a"
    assert [r.headers["host"] for r in web.seen] == ["short.example.org", "recipes.example.org"]


def test_relative_redirect(client, web):
    web.page("https://recipes.example.org/old", "", status=302, headers={"location": "/lentil-salad"})
    serve(web, GOOD)
    assert preview(client, "https://recipes.example.org/old").status_code == 200


@pytest.mark.parametrize("target", [
    "http://internal.example/x", "https://internal.example/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x",
    "https://169.254.169.254/latest/meta-data", "ftp://recipes.example.org/x", "file:///etc/passwd", "https://user:pw@recipes.example.org/x",
    "https://recipes.example.org:8443/x", "javascript:alert(1)",
])
def test_redirect_to_internal_or_odd_targets_is_refused_the_same_way(client, web, target):
    web.page("https://recipes.example.org/r", "", status=302, headers={"location": target})
    r = preview(client, "https://recipes.example.org/r")
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL
    assert [q.headers["host"] for q in web.seen] == ["recipes.example.org"]  # nothing else was contacted


def test_https_to_http_redirect_is_refused_and_http_to_https_is_fine(client, web):
    web.page("https://recipes.example.org/a", "", status=301, headers={"location": "http://recipes.example.org/b"})
    serve(web, GOOD, url="http://recipes.example.org/b")
    assert preview(client, "https://recipes.example.org/a").status_code == 502
    web.page("http://recipes.example.org/c", "", status=301, headers={"location": "https://recipes.example.org/lentil-salad"})
    serve(web, GOOD)
    assert preview(client, "http://recipes.example.org/c").status_code == 200


def test_at_most_three_redirects(client, web):
    for i in range(5):
        web.page(f"https://recipes.example.org/{i}", "", status=302, headers={"location": f"https://recipes.example.org/{i + 1}"})
    serve(web, GOOD, url="https://recipes.example.org/5")
    assert preview(client, "https://recipes.example.org/0").status_code == 502
    assert len(web.seen) == 4  # the first request and three redirects
    web.seen.clear()
    serve(web, GOOD, url="https://recipes.example.org/3")
    assert preview(client, "https://recipes.example.org/1").status_code == 200  # 1 -> 2 -> 3 is two redirects


def test_redirect_loop_and_missing_location(client, web):
    web.page("https://recipes.example.org/loop", "", status=302, headers={"location": "/loop"})
    assert preview(client, "https://recipes.example.org/loop").status_code == 502
    web.page("https://recipes.example.org/nolocation", "", status=302)
    assert preview(client, "https://recipes.example.org/nolocation").status_code == 502


@pytest.mark.parametrize("status", [403, 404, 410, 429, 500, 503])
def test_http_errors_are_neutral(client, web, status):
    web.page(PAGE, "x", status=status)
    r = preview(client)
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL


def test_network_errors_are_neutral(app, client, web):
    def boom(request):
        raise httpx.ConnectTimeout("slow")

    app.state.web_fetcher.transport = httpx.MockTransport(boom)
    r = preview(client)
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL


@pytest.mark.parametrize("content_type", ["application/json", "application/pdf", "image/png", "text/plain", "application/octet-stream", ""])
def test_only_html_is_read(client, web, content_type):
    web.page(PAGE, html(GOOD), content_type=content_type)
    r = preview(client)
    assert r.status_code == 422 and "not a web page" in r.json()["detail"]


def test_xhtml_is_read(client, web):
    web.page(PAGE, html(GOOD), content_type="application/xhtml+xml; charset=utf-8")
    assert preview(client).status_code == 200


def test_large_page_is_refused_by_header_and_while_streaming(client, web):
    web.page(PAGE, b"x", headers={"content-length": str(webrecipes.MAX_BYTES + 1)})
    assert preview(client).status_code == 422
    web.page(PAGE, b"<p>" + b"a" * (webrecipes.MAX_BYTES + 10))
    r = preview(client)
    assert r.status_code == 422 and "too large" in r.json()["detail"]


def test_compression_bomb_stops_at_the_limit(client, web):
    bomb = gzip.compress(b"a" * (200 * 1024 * 1024), 9)  # a few hundred KB that inflate to 200 MB
    assert len(bomb) < webrecipes.MAX_BYTES
    web.page(PAGE, bomb, headers={"content-encoding": "gzip"})
    r = preview(client)
    assert r.status_code == 422 and "too large" in r.json()["detail"]
    web.page(PAGE, zlib.compress(b"a" * (200 * 1024 * 1024), 9), headers={"content-encoding": "deflate"})
    assert preview(client).status_code == 422


def test_gzip_and_deflate_pages_are_read(client, web):
    page = html(GOOD).encode()
    web.page(PAGE, gzip.compress(page), headers={"content-encoding": "gzip"})
    assert preview(client).status_code == 200
    web.page(PAGE + "2", zlib.compress(page), headers={"content-encoding": "deflate"})
    assert preview(client, PAGE + "2").status_code == 200
    raw = zlib.compressobj(wbits=-15)
    web.page(PAGE + "3", raw.compress(page) + raw.flush(), headers={"content-encoding": "deflate"})
    assert preview(client, PAGE + "3").status_code == 200


def test_broken_or_unknown_encoding(client, web):
    web.page(PAGE, b"not gzip at all", headers={"content-encoding": "gzip"})
    assert preview(client).status_code == 502
    web.page(PAGE + "2", b"x", headers={"content-encoding": "br"})
    assert preview(client, PAGE + "2").status_code == 502


def test_charset_is_honoured(client, web):
    page = html({**GOOD, "name": "Käsespätzle"}).replace("<head>", '<head><meta charset="iso-8859-1">').encode("latin-1")
    web.page(PAGE, page, content_type="text/html")
    assert preview(client).json()["name"] == "Käsespätzle"


def test_time_limit_for_the_whole_fetch(app, client, web):
    now = [0.0]

    def clock():
        now[0] += 4.0  # every look at the clock costs four seconds: the third station is over the ten
        return now[0]

    app.state.web_fetcher.clock = clock
    web.page("https://recipes.example.org/a", "", status=302, headers={"location": "/b"})
    web.page("https://recipes.example.org/b", "", status=302, headers={"location": "/c"})
    serve(web, GOOD, url="https://recipes.example.org/c")
    r = preview(client, "https://recipes.example.org/a")
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL


# ---- access, switch, brake ----


def test_switched_off_by_default_and_by_the_admin(tmp_path, monkeypatch, web):
    monkeypatch.delenv("MAHLWERK_WEB_RECIPES", raising=False)
    client = TestClient(create_app(str(tmp_path / "off.db"), web_transport=httpx.MockTransport(web)))
    serve(web, GOOD)
    assert preview(client).status_code == 404 and client.post("/api/v1/web-recipes", json={"url": PAGE}).status_code == 404
    assert client.get("/api/v1/me").json()["features"]["web_recipes"] is False
    assert client.patch("/api/v1/admin/connectors/web_recipes", json={"enabled": True}).status_code == 200
    assert client.get("/api/v1/me").json()["features"]["web_recipes"] is True and preview(client).status_code == 200
    client.patch("/api/v1/admin/connectors/web_recipes", json={"enabled": False})
    assert preview(client).status_code == 404 and web.seen == web.seen[:1]


def test_environment_fixes_the_switch(client, monkeypatch):
    c = {x["key"]: x for x in client.get("/api/v1/admin/connectors").json()}["web_recipes"]
    assert c["enabled"] and c["locked"] == ["enabled"]
    assert client.patch("/api/v1/admin/connectors/web_recipes", json={"enabled": False}).status_code == 409


def test_an_access_token_is_refused(client, web):
    serve(web, GOOD)
    token = client.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}).json()["token"]
    other = TestClient(client.app, headers={"Authorization": f"Bearer {token}"})
    assert other.post("/api/v1/web-recipes/preview", json={"url": PAGE}).status_code == 403
    assert other.post("/api/v1/web-recipes", json={"url": PAGE}).status_code == 403


def test_writing_needs_the_csrf_header(client, web):
    serve(web, GOOD)
    del client.headers["X-Mahlwerk-Request"]
    assert preview(client).status_code == 403


def test_brake_per_person_and_cache_costs_nothing(app, client, web):
    serve(web, GOOD)
    for i in range(21):
        web.page(f"https://recipes.example.org/p{i}", html(GOOD))
    for i in range(20):
        assert preview(client, f"https://recipes.example.org/p{i}").status_code == 200
    r = preview(client, "https://recipes.example.org/p20")
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    assert preview(client, "https://recipes.example.org/p3").status_code == 200  # answered from the cache: no fetch, no count
    assert len(web.seen) == 20


def test_brake_window_and_global_limit():
    now = [0.0]
    brake = webrecipes.Brake(lambda: now[0], per_user=2, total=3, window=100, parallel=1)
    assert brake.allow(1) == 0 and brake.allow(1) == 0 and brake.allow(1) > 0
    assert brake.allow(2) == 0 and brake.allow(2) > 0  # the third of the server
    now[0] = 101
    assert brake.allow(1) == 0
    assert brake.slot() and not brake.slot()
    brake.release()
    assert brake.slot()


def test_brake_is_per_user_and_global_across_users(duo, web):
    ann, ben = duo
    for c in duo:
        c.app.state.features.store.set_global("web_recipes.enabled", True)
    ann.app.state.web_fetcher.transport = httpx.MockTransport(web)
    ann.app.state.web_brake = webrecipes.Brake(per_user=1, total=2)
    for i in range(3):
        web.page(f"https://recipes.example.org/q{i}", html(GOOD))
    assert preview(ann, "https://recipes.example.org/q0").status_code == 200
    assert preview(ann, "https://recipes.example.org/q1").status_code == 429
    assert preview(ben, "https://recipes.example.org/q1").status_code == 200
    assert preview(ben, "https://recipes.example.org/q2").status_code == 429  # one each, and the server's two are used


def test_parallel_fetches_are_limited(app, client, web):
    serve(web, GOOD)
    brake = app.state.web_brake
    held = [brake.slot() for _ in range(3)]
    assert all(held)
    r = preview(client)
    assert r.status_code == 429 and web.seen == []


def test_nothing_raw_in_answers(client, web):
    evil = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    serve(web, {**GOOD, "name": f"A{evil}B", "recipeIngredient": [f"x {evil}", "\x00bad\x1b[31m"]})
    text = preview(client).text
    assert "<script" not in text and "<img" not in text  # tags are stripped from the text
    body = json.loads(text)
    assert "<" not in body["name"] and all("<" not in line and "\x00" not in line and "\x1b" not in line for line in body["ingredients"])


def test_errors_never_echo_the_address(client, web):
    secret = "https://recipes.example.org/path-with-secret-token-123"
    r = preview(client, secret)
    assert "secret-token" not in r.text
    r = preview(client, "https://user:pw@recipes.example.org/x")
    assert "pw@" not in r.text


# ---- the food behind it ----


def test_taken_over_recipe_is_a_portion_food_in_groups_and_not_a_product(client, web):
    serve(web, GOOD)
    group = client.post("/api/v1/recipe-groups", json={"name": "Salads"}).json()
    food = client.post("/api/v1/web-recipes", json={"url": PAGE, "group_id": group["id"]}).json()
    assert client.get("/api/v1/recipe-groups").json()[0]["food_ids"] == [food["id"]]
    listed = client.get("/api/v1/foods", params={"exclude_source": ["recipe", "cookidoo", "web"]}).json()
    assert all(f["id"] != food["id"] for f in listed)
    entry = client.post("/api/v1/diary/2026-01-10/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 150})
    assert entry.status_code == 201 and entry.json()["kcal"] == pytest.approx(745.5) and entry.json()["brand"] == "Web · recipes.example.org"
    assert client.post("/api/v1/web-recipes", json={"url": PAGE, "group_id": 999}).status_code == 404


def test_reload_keeps_the_persons_corrections(client, web, app):
    serve(web, GOOD)
    food = client.post("/api/v1/web-recipes", json={"url": PAGE, "name": "My salad", "portions": 2}).json()
    serve(web, {**GOOD, "nutrition": {**GOOD["nutrition"], "calories": "400 kcal"}})
    r = client.post(f"/api/v1/web-recipes/{food['id']}/reload")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == food["id"] and body["per_100"]["kcal"] == 400 and body["name"] == "My salad" and body["portions"] == 2
    assert client.post("/api/v1/web-recipes/99999/reload").status_code == 404
    own = client.post("/api/v1/foods", json={"name": "Own", "per_100": {"kcal": 1}}).json()
    assert client.post(f"/api/v1/web-recipes/{own['id']}/reload").status_code == 404


def test_stored_link_is_only_ever_http_or_https(client, web, app):
    serve(web, GOOD)
    food = client.post("/api/v1/web-recipes", json={"url": PAGE}).json()
    row = app.state.store.get_food(food["id"])
    app.state.store.update_food(food["id"], "web", {**row["data"], "url": "javascript:alert(1)"})
    assert client.get(f"/api/v1/foods/{food['id']}").json()["url"] is None
    app.state.store.update_food(food["id"], "web", {**row["data"], "url": "https://user:pw@recipes.example.org/x"})
    assert client.get(f"/api/v1/foods/{food['id']}").json()["url"] is None


def test_remove_deletes_the_food_and_a_new_take_over_starts_fresh(client, web):
    serve(web, GOOD)
    food = client.post("/api/v1/web-recipes", json={"url": PAGE}).json()
    assert client.delete(f"/api/v1/foods/{food['id']}").status_code == 204
    assert client.get("/api/v1/foods", params={"source": "web"}).json() == []
    again = client.post("/api/v1/web-recipes", json={"url": PAGE}).json()
    assert [f["id"] for f in client.get("/api/v1/foods", params={"source": "web"}).json()] == [again["id"]]


def test_user_agent_contact_comes_from_the_environment(tmp_path, monkeypatch, web):
    monkeypatch.setenv("MAHLWERK_WEB_RECIPES", "1")
    monkeypatch.setenv("MAHLWERK_CONTACT", "admin@example.org")
    c = TestClient(create_app(str(tmp_path / "ua.db"), web_transport=httpx.MockTransport(web)))
    serve(web, GOOD)
    preview(c)
    assert web.seen[0].headers["user-agent"].endswith("(admin@example.org)")


# ---- second round: findings of the security review ----

import threading
import time


@pytest.mark.parametrize("name", ["punycode", "idna", "utf-7", "rot13", "hex", "zlib", "bz2", "uu", "base64", "utf-16", "x" * 40, "nonsense"])
def test_h1_charset_names_are_never_looked_up_as_codecs(client, web, name):
    big = b"<p>" + b"a" * 400_000 + b"</p>"
    start = time.perf_counter()
    assert webrecipes.decode(big, f"text/html; charset={name}")
    assert webrecipes.decode(b'<meta charset="' + name.encode() + b'">' + big, "text/html")
    assert time.perf_counter() - start < 1.0
    web.page(PAGE, html(GOOD), content_type=f"text/html; charset={name}")
    r = preview(client)
    assert r.status_code == 200 and r.json()["name"] == "Red lentil salad"


def test_h1_allowed_charsets_still_work():
    assert webrecipes.decode("Käse".encode("latin-1"), "text/html; charset=ISO-8859-1") == "Käse"
    assert webrecipes.decode("€".encode("cp1252"), "text/html; charset=windows-1252") == "€"
    assert webrecipes.decode("﻿Käse".encode("utf-16"), "text/html") == "﻿Käse" or "Käse" in webrecipes.decode("Käse".encode("utf-16"), "text/html")
    assert webrecipes.decode("Käse".encode("utf-16-le"), "text/html; charset=utf-16") != "Käse"  # no byte order mark: not read as utf-16


def _hang_transport(release: threading.Event):
    def handler(request):
        release.wait(10)  # a server that never finishes its headers
        raise httpx.ReadTimeout("late")
    return httpx.MockTransport(handler)


def _stuck_ok(app, client, *, started_at):
    elapsed = time.perf_counter() - started_at
    assert elapsed < 3.0
    brake = app.state.web_brake
    held = [brake.slot() for _ in range(3)]
    assert all(held), "a slot stayed taken"
    for _ in held:
        brake.release()


def test_h2_headers_that_never_finish_end_at_the_time_limit(app, client, web):
    release = threading.Event()
    app.state.web_fetcher.transport = _hang_transport(release)
    app.state.web_fetcher.total_timeout = 0.3
    start = time.perf_counter()
    r = preview(client)
    release.set()
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL
    _stuck_ok(app, client, started_at=start)


def test_h2_a_hanging_name_resolution_ends_at_the_time_limit(app, client, web, monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(netguard, "resolver", lambda host, port: (release.wait(10), ["93.184.216.34"])[1])
    app.state.web_fetcher.total_timeout = 0.3
    start = time.perf_counter()
    r = preview(client)
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL
    _stuck_ok(app, client, started_at=start)
    release.set()


def test_h2_dripping_body_and_redirect_chain_are_cut_by_the_wall_clock(app, client, web):
    release = threading.Event()

    class Drip(httpx.SyncByteStream):
        def __iter__(self):
            while not release.is_set():
                yield b" "
                time.sleep(0.05)

    app.state.web_fetcher.transport = httpx.MockTransport(lambda req: httpx.Response(200, headers={"content-type": "text/html"}, stream=Drip()))
    app.state.web_fetcher.total_timeout = 0.4
    start = time.perf_counter()
    r = preview(client)
    release.set()
    assert r.status_code == 502 and time.perf_counter() - start < 3


def test_h2_hung_threads_are_capped_and_the_next_fetch_fails_at_once(app, client, web):
    release = threading.Event()
    fetcher = app.state.web_fetcher
    fetcher.transport = _hang_transport(release)
    fetcher.total_timeout = 0.2
    fetcher._workers = threading.BoundedSemaphore(1)
    assert preview(client).status_code == 502  # leaves one hung thread behind
    start = time.perf_counter()
    r = preview(client, PAGE + "2")
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL and time.perf_counter() - start < 0.15
    release.set()
    time.sleep(0.3)  # the hung thread ends, the cap is free again
    serve(web, GOOD)
    fetcher.transport = httpx.MockTransport(web)
    assert preview(client).status_code == 200


def test_h2_the_slot_is_released_when_the_fetch_fails(app, client, web):
    web.page(PAGE, "x", status=500)
    for _ in range(4):
        assert preview(client).status_code == 502
    assert all([app.state.web_brake.slot() for _ in range(3)])


def test_brake_counts_only_when_a_slot_was_free(app, client, web):
    serve(web, GOOD)
    brake = app.state.web_brake
    held = [brake.slot() for _ in range(3)]
    for i in range(5):
        assert preview(client, f"https://recipes.example.org/p{i}").status_code == 429
    for _ in held:
        brake.release()
    assert brake.allow(1) == 0 or True
    # five refused tries left nothing on the person's account: all 20 of the window are still there
    app.state.web_brake = webrecipes.Brake(per_user=20)
    for i in range(20):
        web.page(f"https://recipes.example.org/q{i}", html(GOOD))
        assert preview(client, f"https://recipes.example.org/q{i}").status_code == 200


def test_m1_nan_and_infinity_are_no_numbers(client, web):
    raw = '{"@type":"Recipe","name":"Bad","recipeYield":"4","nutrition":{"calories":NaN,"proteinContent":Infinity}}'
    web.page(PAGE, f'<script type="application/ld+json">{raw}</script>')
    assert preview(client).status_code == 422  # the block is no valid JSON for us: no recipe data
    serve(web, {**GOOD, "nutrition": {"calories": "NaN kcal", "proteinContent": "Infinity g", "fatContent": "-inf"}})
    body = preview(client).json()
    assert body["blocked"] == "no_energy" and body["per_portion"]["protein"] is None


@pytest.mark.parametrize("huge", [10 ** 4000, "9" * 4000 + " kcal", 1e308, "9" * 400])
def test_m1_huge_numbers_are_refused_cleanly(client, web, huge):
    serve(web, {**GOOD, "recipeYield": huge, "nutrition": {"calories": huge, "proteinContent": huge}})
    r = preview(client)
    assert r.status_code == 200 and r.json()["blocked"] in ("no_energy", "too_high")
    assert client.post("/api/v1/web-recipes", json={"url": PAGE}).status_code == 422
    assert client.get("/api/v1/foods", params={"source": "web"}).json() == []


def test_m1_the_sink_refuses_non_finite_values(client, app):
    r = client.post("/api/v1/foods", content='{"name":"x","per_100":{"kcal":NaN,"protein":1,"carbs":1,"fat":1}}', headers={"content-type": "application/json"})
    assert r.status_code == 422
    r = client.post("/api/v1/foods", content='{"name":"x","per_100":{"kcal":Infinity}}', headers={"content-type": "application/json"})
    assert r.status_code == 422
    store = app.state.store
    for bad in (float("nan"), float("inf")):
        with pytest.raises(ValueError):
            store.put_external_food("web:x.example.org/a", "web", {"name": "x", "per_100": {"kcal": bad}})
        with pytest.raises(ValueError):
            store.put_food(None, "own", {"name": "x", "per_100": {"kcal": bad}})
    assert client.get("/api/v1/foods").json() == []


def test_n1_too_many_query_parameters_and_odd_input_are_422_not_500(client, web):
    many = "https://recipes.example.org/r?" + "&".join(f"a{i}=1" for i in range(80))
    assert preview(client, many).status_code == 422
    assert preview(client, "https://recipes.example.org/r?%ZZ=%E0%A4%A").status_code in (200, 422, 502)
    # a redirect to such an address is just a failed fetch
    web.page("https://recipes.example.org/r", "", status=302, headers={"location": many})
    assert preview(client, "https://recipes.example.org/r").status_code == 502


def test_n2_the_cache_does_not_mix_http_and_https(client, web):
    web.page("http://recipes.example.org/a", html({**GOOD, "name": "Over http"}))
    web.page("https://recipes.example.org/a", html({**GOOD, "name": "Over https"}))
    assert preview(client, "http://recipes.example.org/a").json()["name"] == "Over http"
    assert preview(client, "https://recipes.example.org/a").json()["name"] == "Over https"


def test_n2_http_cannot_replace_a_recipe_taken_over_through_https(client, web):
    web.page("http://recipes.example.org/a", html({**GOOD, "name": "Over http"}))
    web.page("https://recipes.example.org/a", html({**GOOD, "name": "Over https"}))
    first = client.post("/api/v1/web-recipes", json={"url": "https://recipes.example.org/a"}).json()
    r = client.post("/api/v1/web-recipes", json={"url": "http://recipes.example.org/a"})
    assert r.status_code == 422 and "https" in r.json()["detail"]
    assert client.get(f"/api/v1/foods/{first['id']}").json()["name"] == "Over https"
    # the other way round is an upgrade: the https address replaces the http one
    other = client.post("/api/v1/web-recipes", json={"url": "http://recipes.example.org/b"})
    assert other.status_code == 502  # nothing served there
    web.page("http://recipes.example.org/c", html({**GOOD, "name": "C http"}))
    web.page("https://recipes.example.org/c", html({**GOOD, "name": "C https"}))
    a = client.post("/api/v1/web-recipes", json={"url": "http://recipes.example.org/c"}).json()
    b = client.post("/api/v1/web-recipes", json={"url": "https://recipes.example.org/c"}).json()
    assert a["id"] == b["id"] and b["url"] == "https://recipes.example.org/c" and b["name"] == "C https"


def test_n3_the_host_label_is_always_ascii():
    address = webrecipes.check_address("https://www.käse-rezepte.example.org/a")[0]
    label = webrecipes.host_label(address)
    assert label.isascii() and label.startswith("xn--") and "www." not in label
    assert webrecipes.host_label("https://www.recipes.example.org/a") == "recipes.example.org"


@pytest.mark.parametrize("env,value,url", [
    ("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "mine.example.org", "https://mine.example.org/x"),
    ("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "mine.example.org", "https://deep.sub.mine.example.org/x"),
    ("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "other.example.net, *.mine.example.org", "https://a.mine.example.org/x"),
    ("MAHLWERK_PUBLIC_URL", "https://mahlwerk.mine.example.org:8443/app", "https://mahlwerk.mine.example.org/x"),
    ("MAHLWERK_ALLOWED_HOSTS", "home.mine.example.org,localhost", "https://home.mine.example.org/x"),
])
def test_n5_own_names_are_blocked_like_internal_targets(client, web, monkeypatch, env, value, url):
    monkeypatch.setenv(env, value)
    serve(web, GOOD, url=url)
    r = preview(client, url)
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL and web.seen == []
    assert client.post("/api/v1/web-recipes", json={"url": url}).status_code == 502


def test_n5_unrelated_names_and_look_alikes_are_not_blocked(client, web, monkeypatch):
    monkeypatch.setenv("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "mine.example.org")
    serve(web, GOOD, url="https://notmine.example.org/x")
    assert preview(client, "https://notmine.example.org/x").status_code == 200
    assert webrecipes.blocked_hosts() == ["mine.example.org"]  # `*` in ALLOWED_HOSTS blocks nothing


def test_n5_a_redirect_to_an_own_name_is_refused_and_not_contacted(client, web, monkeypatch):
    monkeypatch.setenv("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "mine.example.org")
    web.page("https://recipes.example.org/r", "", status=302, headers={"location": "https://www.mine.example.org/x"})
    serve(web, GOOD, url="https://www.mine.example.org/x")
    r = preview(client, "https://recipes.example.org/r")
    assert r.status_code == 502 and r.json()["detail"] == webrecipes.NEUTRAL
    assert [q.headers["host"] for q in web.seen] == ["recipes.example.org"]


def test_n5_the_cache_does_not_serve_a_name_that_was_blocked_later(client, web, monkeypatch):
    serve(web, GOOD)
    assert preview(client).status_code == 200
    monkeypatch.setenv("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "recipes.example.org")
    assert preview(client).status_code == 502

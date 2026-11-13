"""The Cookidoo connector: link pattern, unit conversion, switch states, taking a recipe over, limits and failures.

No test reaches Cookidoo or needs the `cookidoo-api` package: the client is a stand-in (see FakeClient).
"""

import logging

import pytest
from fastapi.testclient import TestClient

from mahlwerk import cookidoo
from mahlwerk.cookidoo import (
    Collection, CookidooError, NutritionEntry, PlanDay, PlannedRecipe, RecipeDetails, RecipeRejected, Settings,
)
from mahlwerk.main import create_app

SECRET_MAIL = "someone@example.invalid"
SECRET_PASSWORD = "hunter2-not-real"
DAY = "2026-01-10"

LENTILS = RecipeDetails(
    id="r100001", name="Red lentil salad", portions=4.0,
    nutrition=[NutritionEntry(1, "Portion", {
        "sodium": (1168, "mg"), "protein": (37, "g"), "kJ": (2081, "kJ"), "fat": (8, "g"), "kcal": (497, "kcal"),
        "dietaryFibre": (12.2, "g"), "saturatedFat": (5, "g"), "carb2": (73, "g"),
    })],
)


class FakeClient:
    """Stands in for LibraryClient: answers from dictionaries, counts calls, can fail."""

    def __init__(self):
        self.calls: list[str] = []
        self.fail: str | None = None
        self.recipes = {"r100001": LENTILS}
        self.closed = False

    def _check(self, name):
        self.calls.append(name)
        if self.fail:
            raise CookidooError(self.fail)

    async def week(self, day):
        self._check("week")
        return [PlanDay(day="2026-01-12", title="Monday", recipes=[PlannedRecipe("r100001", "Red lentil salad")]),
                PlanDay(day="2026-01-13", title="Tuesday", recipes=[])]

    async def collections(self):
        self._check("collections")
        return [Collection("c1", "Favourites", False, [PlannedRecipe("r100001", "Red lentil salad")]),
                Collection("c2", "Quick dinners", True, [])]

    async def recipe(self, recipe_id):
        self._check("recipe")
        if recipe_id not in self.recipes:
            raise CookidooError("unexpected")
        return self.recipes[recipe_id]

    async def ping(self):
        self._check("ping")

    async def close(self):
        self.closed = True


@pytest.fixture
def fake():
    return FakeClient()


@pytest.fixture
def on(monkeypatch, tmp_path, fake):
    """An app with the connector switched on, installed and configured, talking to the stand-in."""
    monkeypatch.setenv("MAHLWERK_COOKIDOO", "1")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", SECRET_MAIL)
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", SECRET_PASSWORD)
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    app = create_app(str(tmp_path / "c.db"))
    app.state.cookidoo.factory = lambda settings: fake
    return TestClient(app)


def connector(client) -> dict:
    return next(c for c in client.get("/api/v1/admin/connectors").json() if c["key"] == "cookidoo")


# ---- link pattern ----


@pytest.mark.parametrize("text,expected", [
    ("r59322", "r59322"),
    ("  r100001 ", "r100001"),
    ("https://cookidoo.de/recipes/recipe/de-DE/r59322", "r59322"),
    ("https://cookidoo.de/recipes/recipe/de-DE/r59322/", "r59322"),
    ("https://cookidoo.de/recipes/recipe/de-DE/r59322?utm_source=share", "r59322"),
    ("https://www.cookidoo.co.uk/recipes/recipe/en-GB/r123456#x", "r123456"),
    ("https://cookidoo.thermomix.com/recipes/recipe/en/r123456", "r123456"),
    ("https://cookidoo.ch/recipes/recipe/r123456", "r123456"),
])
def test_recipe_id_from_id_or_link(text, expected):
    assert cookidoo.recipe_id(text) == expected


@pytest.mark.parametrize("text", [
    "", "59322", "R59322", "r12", "r12345678901", "r5932x", "../r59322", "r59322/../x",
    "http://cookidoo.de/recipes/recipe/de-DE/r59322",  # not https
    "https://evil.example/recipes/recipe/de-DE/r59322",
    "https://cookidoo.de.evil.example/recipes/recipe/de-DE/r59322",
    "https://evil.example/?u=https://cookidoo.de/recipes/recipe/de-DE/r59322",
    "https://user@cookidoo.de/recipes/recipe/de-DE/r59322",
    "https://cookidoo.de:8443/recipes/recipe/de-DE/r59322",
    "https://cookidoo.de/recipes/recipe/de-DE/r59322\nhttps://evil.example",
    "http://169.254.169.254/latest/meta-data", "file:///etc/passwd",
])
def test_recipe_id_refuses_everything_else(text):
    assert cookidoo.recipe_id(text) is None


# ---- conversion ----


def entry(values, quantity=1):
    return [NutritionEntry(quantity, "Portion", values)]


def test_conversion_of_a_full_recipe():
    per_100, extra = cookidoo.nutrition_from(LENTILS.nutrition)
    assert per_100 == {"kcal": 497.0, "fat": 8.0, "saturated_fat": 5.0, "carbs": 73.0, "sugars": None, "fiber": 12.2,
                       "protein": 37.0, "salt": 2.92}  # sodium 1168 mg x 2.5 = 2.92 g salt
    assert extra == {"sodium": 1168.0}


def test_energy_falls_back_to_kilojoules():
    per_100, _ = cookidoo.nutrition_from(entry({"kJ": (2092, "kJ")}))
    assert per_100["kcal"] == 500.0 and per_100["fat"] is None  # unknown stays unknown, not zero


def test_units_are_converted_and_odd_ones_ignored():
    per_100, extra = cookidoo.nutrition_from(entry({"kcal": (100, "kcal"), "protein": (5000, "mg"), "fat": (3, "furlong"), "sodium": (1, "g")}))
    assert per_100["protein"] == 5.0 and per_100["fat"] is None
    assert extra == {"sodium": 1000.0}


def test_implausible_values_are_dropped_or_refuse():
    per_100, _ = cookidoo.nutrition_from(entry({"kcal": (100, "kcal"), "fat": (9000, "g")}))
    assert per_100["fat"] is None
    with pytest.raises(RecipeRejected):
        cookidoo.nutrition_from(entry({"kcal": (99999, "kcal")}))


def test_no_energy_or_no_portion_block_is_refused():
    with pytest.raises(RecipeRejected, match="energy"):
        cookidoo.nutrition_from(entry({"protein": (5, "g")}))
    with pytest.raises(RecipeRejected, match="per portion"):
        cookidoo.nutrition_from([NutritionEntry(100, "g", {"kcal": (100, "kcal")})])
    with pytest.raises(RecipeRejected):
        cookidoo.nutrition_from([])


def test_food_data_is_booked_as_one_portion_of_100_g():
    data = cookidoo.food_data(LENTILS)
    assert data["name"] == "Red lentil salad" and data["unit"] == "g" and data["serving_quantity"] == 100.0
    assert data["serving_size"] == "1 portion" and data["portions"] == 4.0 and data["complete"] is True
    assert cookidoo.food_data(RecipeDetails("r1", "X", None, entry({"kcal": (10, "kcal")})))["complete"] is False


def test_settings_validation_and_no_secret_in_repr(monkeypatch):
    assert Settings.from_env() is None
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", SECRET_MAIL)
    assert Settings.from_env() is None  # the password is missing
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", SECRET_PASSWORD)
    s = Settings.from_env()
    assert (s.country, s.language) == ("de", "de-DE")
    assert SECRET_MAIL not in repr(s) and SECRET_PASSWORD not in repr(s)
    monkeypatch.setenv("MAHLWERK_COOKIDOO_COUNTRY", "Germany")
    assert Settings.from_env() is None
    monkeypatch.setenv("MAHLWERK_COOKIDOO_COUNTRY", "ch")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_LANGUAGE", "de-CH")
    assert Settings.from_env().country == "ch"
    monkeypatch.setenv("MAHLWERK_COOKIDOO_LANGUAGE", "de_CH")
    assert Settings.from_env() is None


# ---- switch, installation, configuration ----


def test_off_by_default_and_every_route_says_404(client):
    c = connector(client)
    assert c["enabled"] is False and c["configurable"] is True and c["locked"] == []
    assert client.get("/api/v1/me").json()["features"]["cookidoo"] is False
    for url in ("/week", "/collections", "/recipe?ref=r100001"):
        r = client.get("/api/v1/cookidoo" + url)
        assert r.status_code == 404 and "switched off" in r.json()["detail"]
    assert client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).status_code == 404


def test_switch_on_without_package_says_not_installed(client, monkeypatch):
    monkeypatch.setattr(cookidoo, "installed", lambda: False)
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", SECRET_MAIL)
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", SECRET_PASSWORD)
    assert client.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": True}).json()["status"] == "not_installed"
    r = client.get("/api/v1/cookidoo/week")
    assert r.status_code == 409 and "not installed" in r.json()["detail"]


def test_switch_on_without_credentials_says_not_configured(client, monkeypatch):
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    r = client.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": True})
    assert r.json()["enabled"] is True and r.json()["status"] == "not_configured"
    assert client.get("/api/v1/me").json()["features"]["cookidoo"] is True
    r = client.get("/api/v1/cookidoo/week")
    assert r.status_code == 409 and "not configured" in r.json()["detail"]
    assert client.get("/api/v1/cookidoo/status").json()["state"] == "not_configured"


def test_app_starts_without_the_package(client):
    # the real check: this test environment may or may not have cookidoo-api; either way nothing imported it at startup
    assert client.get("/healthz").status_code == 200
    assert connector(client)["status"] in ("not_installed", "not_configured")


def test_environment_can_fix_the_switch(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_COOKIDOO", "0")
    client = TestClient(create_app(str(tmp_path / "e.db")))
    assert connector(client)["locked"] == ["enabled"]
    assert client.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": True}).status_code == 409


def test_admin_card_never_shows_the_credentials(on):
    c = connector(on)
    assert c["enabled"] is True and c["status"] == "ready" and c["info"]["shared_account"] is True
    text = on.get("/api/v1/admin/connectors").text + on.get("/api/v1/cookidoo/status").text
    assert SECRET_MAIL not in text and SECRET_PASSWORD not in text


def test_an_access_token_is_refused(on):
    token = on.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}).json()["token"]
    r = on.get("/api/v1/cookidoo/week", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


# ---- lists ----


def test_week_and_collections(on, fake):
    days = on.get("/api/v1/cookidoo/week").json()
    assert days[0]["recipes"] == [{"id": "r100001", "name": "Red lentil salad"}] and days[1]["recipes"] == []
    cols = on.get("/api/v1/cookidoo/collections").json()
    assert [(c["name"], c["managed"], len(c["recipes"])) for c in cols] == [("Favourites", False, 1), ("Quick dinners", True, 0)]


def test_lists_are_loaded_at_most_once_a_minute(on, fake):
    clock = [1_000_000.0]
    hub = on.app.state.cookidoo
    hub.clock = lambda: clock[0]
    for _ in range(3):
        assert on.get("/api/v1/cookidoo/week").status_code == 200
    assert fake.calls.count("week") == 1
    clock[0] += 61
    on.get("/api/v1/cookidoo/week")
    assert fake.calls.count("week") == 2


# ---- recipe, taking it over ----


def test_preview_by_id_and_by_link_saves_nothing(on):
    for ref in ("r100001", "https://cookidoo.de/recipes/recipe/de-DE/r100001"):
        r = on.get("/api/v1/cookidoo/recipe", params={"ref": ref})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["name"] == "Red lentil salad" and body["portions"] == 4.0 and body["per_portion"]["kcal"] == 497.0
        assert body["extra"] == {"sodium": 1168.0} and body["complete"] is True and body["food_id"] is None
    assert on.get("/api/v1/foods", params={"source": "cookidoo"}).json() == []


def test_adopt_creates_a_food_booked_as_one_portion(on):
    r = on.post("/api/v1/cookidoo/adopt", json={"recipe": "https://cookidoo.de/recipes/recipe/de-DE/r100001"})
    assert r.status_code == 200, r.text
    food = r.json()
    assert food["source"] == "cookidoo" and food["name"] == "Red lentil salad" and food["brand"] == "Cookidoo"
    assert food["serving_quantity"] == 100.0 and food["unit"] == "g" and food["per_100"]["kcal"] == 497.0
    assert food["extra"] == {"sodium": 1168.0} and food["code"] is None
    entry = on.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100}).json()
    assert entry["kcal"] == 497.0 and entry["protein"] == 37.0  # 100 g = 1 portion
    half = on.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "dinner", "amount": 50}).json()
    assert half["kcal"] == 248.5
    assert on.get("/api/v1/cookidoo/recipe", params={"ref": "r100001"}).json()["food_id"] == food["id"]


def test_adopting_again_updates_the_same_food(on, fake):
    first = on.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    fake.recipes["r100001"] = RecipeDetails("r100001", "Red lentil salad v2", 2.0, entry({"kcal": (400, "kcal"), "fat": (10, "g")}))
    for account in on.app.state.cookidoo._accounts.values():
        account.recipes.clear()  # the recipe cache would serve the old answer for ten minutes
    second = on.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    assert second["id"] == first["id"] and second["name"] == "Red lentil salad v2" and second["per_100"]["kcal"] == 400.0
    assert second["per_100"]["protein"] is None
    assert len(on.get("/api/v1/foods", params={"source": "cookidoo"}).json()) == 1
    # the diary entry logged earlier keeps its copy
    on.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": second["id"], "meal": "lunch", "amount": 100})


def test_diary_entries_stay_with_their_user_while_the_food_is_shared(monkeypatch, tmp_path, fake):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    monkeypatch.setenv("MAHLWERK_COOKIDOO", "1")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", SECRET_MAIL)
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", SECRET_PASSWORD)
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    app = create_app(str(tmp_path / "m.db"))
    app.state.cookidoo.factory = lambda settings: fake
    ann = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ann"})
    ben = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "ben"})
    food = ann.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    assert ben.get(f"/api/v1/foods/{food['id']}").json()["name"] == "Red lentil salad"
    ann.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100})
    assert len(ann.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"]) == 1
    assert ben.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"] == []
    # the account is shared: both see the same plan
    assert ben.get("/api/v1/cookidoo/week").json() == ann.get("/api/v1/cookidoo/week").json()
    # nobody without a user gets in
    assert TestClient(app, client=("10.0.0.5", 1)).get("/api/v1/cookidoo/week").status_code == 401


def test_bad_reference_is_422_and_nothing_is_asked(on, fake):
    for ref in ("hello", "https://evil.example/recipes/recipe/de-DE/r100001", "http://169.254.169.254/"):
        assert on.get("/api/v1/cookidoo/recipe", params={"ref": ref}).status_code == 422
        assert on.post("/api/v1/cookidoo/adopt", json={"recipe": ref}).status_code == 422
    assert fake.calls == []


def test_recipe_without_energy_is_refused_with_a_reason(on, fake):
    fake.recipes["r100002"] = RecipeDetails("r100002", "Mystery", 2.0, entry({"protein": (5, "g")}))
    r = on.post("/api/v1/cookidoo/adopt", json={"recipe": "r100002"})
    assert r.status_code == 422 and "energy" in r.json()["detail"]
    assert on.get("/api/v1/foods", params={"source": "cookidoo"}).json() == []


# ---- failures and limits ----


def test_failure_is_502_with_a_neutral_message_and_shows_in_the_card(on, fake):
    fake.fail = "unavailable"
    r = on.get("/api/v1/cookidoo/week")
    assert r.status_code == 502 and r.json()["detail"] == cookidoo.MESSAGES["unavailable"]
    c = connector(on)
    assert c["status"] == "error" and c["info"]["error"] == cookidoo.MESSAGES["unavailable"]
    assert on.get("/api/v1/cookidoo/status").json() == {
        "state": "error", "error": cookidoo.MESSAGES["unavailable"], "account": "shared", "personal_allowed": True}
    fake.fail = None
    assert on.get("/api/v1/cookidoo/week").status_code == 200
    assert connector(on)["status"] == "ready"


def test_unexpected_exception_from_the_client_is_neutral_and_not_logged_with_details(on, fake, caplog):
    async def boom(day):
        raise RuntimeError(f"secret {SECRET_PASSWORD}")

    fake.week = boom
    with caplog.at_level(logging.DEBUG):
        r = on.get("/api/v1/cookidoo/week")
    assert r.status_code == 502 and SECRET_PASSWORD not in r.text and SECRET_MAIL not in r.text
    assert SECRET_PASSWORD not in caplog.text


def test_failed_sign_in_is_not_retried_for_five_minutes(on, fake):
    clock = [1_000_000.0]
    on.app.state.cookidoo.clock = lambda: clock[0]
    fake.fail = "auth"
    assert on.get("/api/v1/cookidoo/week").status_code == 502
    assert fake.calls == ["week"] and fake.closed is True
    fake.fail = None
    clock[0] += 120
    r = on.get("/api/v1/cookidoo/collections")
    assert r.status_code == 502 and fake.calls == ["week"]  # blocked: Cookidoo was not asked again
    clock[0] += 400
    assert on.get("/api/v1/cookidoo/collections").status_code == 200


def test_calls_to_cookidoo_are_limited(on, fake):
    clock = [1_000_000.0]
    on.app.state.cookidoo.clock = lambda: clock[0]
    codes = []
    for i in range(35):
        fake.recipes[f"r{200000 + i}"] = LENTILS
        codes.append(on.get("/api/v1/cookidoo/recipe", params={"ref": f"r{200000 + i}"}).status_code)
    assert codes[:30] == [200] * 30 and set(codes[30:]) == {429}
    clock[0] += 301
    assert on.get("/api/v1/cookidoo/recipe", params={"ref": "r200000"}).status_code == 200


def test_recipe_answers_are_cached(on, fake):
    for _ in range(3):
        on.get("/api/v1/cookidoo/recipe", params={"ref": "r100001"})
    assert fake.calls.count("recipe") == 1


def test_connector_can_be_switched_off_again(on):
    assert on.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": False}).status_code == 409  # fixed by MAHLWERK_COOKIDOO=1


def test_importing_the_app_never_needs_the_package():
    """Run in a fresh interpreter where `import cookidoo_api` fails: the app builds and the connector says not installed."""
    import subprocess
    import sys

    code = (
        "import sys; sys.modules['cookidoo_api'] = None; sys.modules['aiohttp'] = None\n"
        "import tempfile, os\n"
        "from mahlwerk import cookidoo\n"
        "from mahlwerk.main import create_app\n"
        "assert cookidoo.installed() is False\n"
        "app = create_app(os.path.join(tempfile.mkdtemp(), 'x.db'))\n"
        "assert app.state.cookidoo.status(True) == 'not_installed'\n"
        "print('ok')\n"
    )
    result = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, timeout=60)
    assert result.stdout.strip() == "ok", result.stderr[-500:]


def test_recipe_url_is_built_from_the_region_and_never_guessed(monkeypatch):
    de = Settings("a@b.invalid", "x", "de", "de-DE")
    assert cookidoo.recipe_url("cookidoo:r100001", de) == "https://cookidoo.de/recipes/recipe/de-DE/r100001"
    assert cookidoo.recipe_url("cookidoo:r100001", Settings("a@b.invalid", "x", "gb", "en-GB")) == "https://cookidoo.co.uk/recipes/recipe/en-GB/r100001"
    assert cookidoo.recipe_url("cookidoo:r100001", Settings("a@b.invalid", "x", "xx", "xx-XX")) is None  # unknown country
    assert cookidoo.recipe_url("bls:B100000", de) is None and cookidoo.recipe_url("cookidoo:evil/../x", de) is None
    assert cookidoo.recipe_url(None, de) is None
    for name in ("MAHLWERK_COOKIDOO_EMAIL", "MAHLWERK_COOKIDOO_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    assert cookidoo.recipe_url("cookidoo:r100001") is None  # not configured: no region known


def test_a_taken_over_recipe_tells_portions_id_and_link(on):
    adopted = on.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    assert adopted["external_id"] == "cookidoo:r100001" and adopted["portions"] == 4.0
    assert adopted["url"] == "https://cookidoo.de/recipes/recipe/de-DE/r100001"
    listed = on.get("/api/v1/foods", params={"source": "cookidoo"}).json()
    assert listed[0]["url"] == adopted["url"] and listed[0]["external_id"] == "cookidoo:r100001" and listed[0]["portions"] == 4.0
    own = on.post("/api/v1/foods", json={"name": "Plain", "per_100": {"kcal": 1}}).json()
    assert own["external_id"] is None and own["portions"] is None and own["url"] is None


def test_the_food_list_can_leave_sources_out(on):
    on.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"})
    on.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 372}})
    names = lambda params: sorted(f["name"] for f in on.get("/api/v1/foods", params=params).json())  # noqa: E731
    assert names({}) == ["Oats", "Red lentil salad"]
    assert names({"exclude_source": "cookidoo"}) == ["Oats"]
    assert names({"exclude_source": ["cookidoo", "recipe"]}) == ["Oats"]
    assert names({"exclude_source": ["own"]}) == ["Red lentil salad"]
    assert names({"source": "cookidoo", "exclude_source": "cookidoo"}) == []
    assert on.get("/api/v1/foods", params={"exclude_source": "nope"}).status_code == 422


def test_removing_a_taken_over_recipe_keeps_the_diary_copy(on):
    food = on.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    entry = on.post(f"/api/v1/diary/{DAY}/entries", json={"food_id": food["id"], "meal": "lunch", "amount": 100}).json()
    assert on.delete(f"/api/v1/foods/{food['id']}").status_code == 204
    assert on.get("/api/v1/foods", params={"source": "cookidoo"}).json() == []
    kept = on.get(f"/api/v1/diary/{DAY}").json()["meals"]["lunch"]["entries"][0]
    assert kept["id"] == entry["id"] and kept["kcal"] == 497.0 and kept["brand"] == "Cookidoo"

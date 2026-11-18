"""Drinks of the diary count towards the day's fluid total, computed on read: the rule, the per-food override, the setting."""

import sqlite3

import pytest

from conftest import DROP_V17
from mahlwerk import hydration
from mahlwerk.db import Store

DAY = "2026-11-10"
URL = f"/api/v1/diary/{DAY}"


def make(client, name, per_100, extra=None, unit="ml"):
    body = {"name": name, "unit": unit, "per_100": per_100, "extra": extra or {}}
    return client.post("/api/v1/foods", json=body).json()


def log(client, food, amount, day=DAY):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": "breakfast", "amount": amount})
    assert r.status_code == 201, r.text


def water(client, day=DAY):
    return client.get(f"/api/v1/diary/{day}").json()["water"]


COFFEE = ({"kcal": 2, "protein": 0.1, "carbs": 0, "fat": 0}, {"water": 99.4})
OIL = ({"kcal": 884, "protein": 0, "carbs": 0, "fat": 100}, {})
SOUP = ({"kcal": 30, "protein": 1, "carbs": 4, "fat": 1}, {"water": 92})
BEER = ({"kcal": 40, "protein": 0.4, "carbs": 3, "fat": 0}, {"water": 92, "alcohol": 3.5})
RADLER = ({"kcal": 36, "protein": 0.2, "carbs": 7, "fat": 0}, {"water": 90, "alcohol": 1.7})
SOY = ({"kcal": 60, "protein": 8, "carbs": 5, "fat": 0, "salt": 15}, {})
MILK = ({"kcal": 65, "protein": 3.4, "carbs": 4.8, "fat": 3.5, "salt": 0.1}, {})  # no water content known
SKYR = ({"kcal": 63, "protein": 11, "carbs": 4, "fat": 0.2}, {"water": 79})


def test_coffee_counts_with_its_water_share(client):
    log(client, make(client, "Schwarzer Kaffee", *COFFEE), 200)
    assert water(client) == {"ml": 0, "goal_ml": 2000, "drinks_ml": 199}  # 200 ml x 99.4 %


@pytest.mark.parametrize("name,spec", [("Olivenöl", OIL), ("Kürbissuppe", SOUP), ("Zucchinicremesuppe", SOUP), ("Chicken Soup", SOUP),
                                       ("Gemüsebrühe", SOUP), ("Linseneintopf", SOUP), ("Pils", BEER), ("Radler 2,2 Vol.%", RADLER),
                                       ("Sojasauce", SOY), ("Skyr", SKYR)])
def test_what_is_no_drink_does_not_count(client, name, spec):
    log(client, make(client, name, *spec), 200)
    assert water(client)["drinks_ml"] == 0


def test_water_content_of_the_food_is_used_when_the_entry_has_none():
    entry = {"day": DAY, "amount": 300, "name": "Tee", "per_100": {"kcal": 1}, "extra": {}, "food_extra": {"water": 98}, "drink": None}
    assert hydration.drink_ml(entry) == pytest.approx(294)
    assert hydration.drink_ml({**entry, "extra": {"water": 50}}) == 0  # the entry's own value wins
    assert hydration.drink_ml({**entry, "food_extra": {"alcohol": 5}}) == 0


def test_unknown_water_content_falls_back_to_a_plain_drink(client):
    log(client, make(client, "Vollmilch", *MILK), 200)  # 65 kcal, salt 0.1: the whole amount
    log(client, make(client, "Sojasauce", *SOY), 20)  # 60 kcal but salty: no
    log(client, make(client, "Proteinpulver", {"kcal": 380, "protein": 80, "carbs": 5, "fat": 3}), 30)
    log(client, make(client, "Skyr in ml", {"kcal": 63, "protein": 11, "carbs": 4, "fat": 0.2}), 150)  # protein too high: no
    log(client, make(client, "Unbekannt", {"kcal": None, "protein": None, "carbs": None, "fat": None}), 100)
    assert water(client)["drinks_ml"] == 200


def test_grams_entries_are_not_drinks(client):
    log(client, make(client, "Mineralwasser fest", {"kcal": 0, "protein": 0, "carbs": 0, "fat": 0}, {"water": 100}, unit="g"), 500)
    assert water(client)["drinks_ml"] == 0


def test_drinks_are_added_on_top_of_the_glasses_and_not_written_to_the_water_table(client):
    log(client, make(client, "Cola", {"kcal": 42, "protein": 0, "carbs": 10.6, "fat": 0}, {"water": 88}), 500)
    assert client.post(f"/api/v1/water/{DAY}", json={"add_ml": 250}).json() == {"ml": 250, "goal_ml": 2000, "drinks_ml": 440}
    assert water(client) == {"ml": 250, "goal_ml": 2000, "drinks_ml": 440}
    other = client.get("/api/v1/diary/2026-11-11").json()["water"]
    assert other["drinks_ml"] == 0


def test_override_yes_and_no(client):
    soup = make(client, "Brühe", *SOUP)
    oil = make(client, "Öl", *OIL)
    coffee = make(client, "Kaffee", *COFFEE)
    for f, amount in ((soup, 200), (oil, 10), (coffee, 200)):
        log(client, f, amount)
    assert water(client)["drinks_ml"] == 199
    r = client.put(f"/api/v1/foods/{soup['id']}/drink", json={"drink": True})
    assert r.status_code == 200 and r.json()["drink"] is True
    assert client.get(f"/api/v1/foods/{soup['id']}").json()["drink"] is True
    assert water(client)["drinks_ml"] == 199 + 184  # 200 ml x 92 %
    client.put(f"/api/v1/foods/{oil['id']}/drink", json={"drink": True})  # water unknown: the whole amount
    assert water(client)["drinks_ml"] == 199 + 184 + 10
    client.put(f"/api/v1/foods/{coffee['id']}/drink", json={"drink": False})
    assert water(client)["drinks_ml"] == 184 + 10
    assert client.put(f"/api/v1/foods/{coffee['id']}/drink", json={"drink": None}).json()["drink"] is None  # back to automatic
    assert water(client)["drinks_ml"] == 199 + 184 + 10


def test_override_validation_and_kept_by_replace(client):
    f = make(client, "Kaffee", *COFFEE)
    assert client.put("/api/v1/foods/9999/drink", json={"drink": True}).status_code == 404
    assert client.put(f"/api/v1/foods/{f['id']}/drink", json={}).status_code == 422
    assert client.put(f"/api/v1/foods/{f['id']}/drink", json={"drink": "maybe"}).status_code == 422
    client.put(f"/api/v1/foods/{f['id']}/drink", json={"drink": False})
    body = {"name": "Kaffee neu", "unit": "ml", "per_100": COFFEE[0], "extra": COFFEE[1]}
    assert client.put(f"/api/v1/foods/{f['id']}", json=body).json()["drink"] is False
    assert next(x for x in client.get("/api/v1/foods").json() if x["id"] == f["id"])["drink"] is False


def test_entry_without_food_uses_the_automatic_rule_only(client):
    coffee = make(client, "Kaffee", *COFFEE)
    log(client, coffee, 200)
    client.put(f"/api/v1/foods/{coffee['id']}/drink", json={"drink": False})
    assert water(client)["drinks_ml"] == 0
    assert client.delete(f"/api/v1/foods/{coffee['id']}").status_code == 204  # the entry keeps its copy, loses the link
    assert water(client)["drinks_ml"] == 199


def test_setting_switches_it_off(client):
    log(client, make(client, "Kaffee", *COFFEE), 200)
    assert client.get("/api/v1/me").json()["settings"]["water_drinks"] is True
    assert client.patch("/api/v1/me/settings", json={"water_drinks": False}).json()["water_drinks"] is False
    assert water(client)["drinks_ml"] == 0
    assert client.get("/api/v1/summary/today").json()["water_drinks_ml"] == 0
    assert client.patch("/api/v1/me/settings", json={"water_drinks": True}).json()["water_drinks"] is True
    assert water(client)["drinks_ml"] == 199


def test_summary_today_has_the_drinks(client):
    from mahlwerk.routes.diary import today
    log(client, make(client, "Kaffee", *COFFEE), 200, day=today().isoformat())
    s = client.get("/api/v1/summary/today").json()
    assert s["water_ml"] == 0 and s["water_drinks_ml"] == 199


def test_export_has_the_setting(client):
    import io, json, zipfile
    client.patch("/api/v1/me/settings", json={"water_drinks": False})
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/v1/me/export").content))
    assert json.loads(z.read("mahlwerk-export.json"))["settings"]["water_drinks"] is False


@pytest.mark.parametrize("name,soup", [("Kürbissuppe", True), ("ZUCCHINICREMESUPPE", True), ("Tomaten Soup", True), ("Hühnerbrühe", True),
                                       ("Bouillon", True), ("Consommé", True), ("Gulaschtopf Eintopf", True), ("Kaffee", False),
                                       ("Hafermilch", False), (None, False)])
def test_soup_detection(name, soup):
    assert hydration.is_soup(name) is soup


def test_version_16_database_gets_the_drink_column(tmp_path):
    path = str(tmp_path / "v16.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V17)
    con.executescript(
        """
        INSERT INTO food (id, source, found, data, fetched_at) VALUES (7, 'own', 1, '{"name": "Kaffee", "per_100": {"kcal": 2}}', 1);
        PRAGMA user_version = 16;
        """
    )
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 18
    assert "drink" in {r[1] for r in con.execute("PRAGMA table_info(food)")}
    con.close()
    assert store.get_food(7)["drink"] is None and store.get_food(7)["data"]["name"] == "Kaffee"
    assert store.set_food_drink(7, True) is True and store.get_food(7)["drink"] is True
    assert store.set_food_drink(7, False) and store.get_food(7)["drink"] is False
    assert store.set_food_drink(7, None) and store.get_food(7)["drink"] is None
    assert store.set_food_drink(99, True) is False

"""Additional nutrients: directory, imports (units!), validation, diary copies, day totals, insights, demo data."""

import json
import sqlite3
from datetime import date, timedelta

import pytest
from conftest import NUTELLA, PRODUCT
from fastapi.testclient import TestClient
from test_catalog import HEADER, ean, gz, line, per

from mahlwerk import catalog as catalog_module
from mahlwerk import demo, nutrients
from mahlwerk.catalog import Catalog, import_off
from mahlwerk.db import Store
from mahlwerk.main import create_app

NRV_SAMPLES = {
    "vitamin_c": 80, "calcium": 800, "iron": 14, "magnesium": 375, "zinc": 10, "vitamin_d": 5, "vitamin_b12": 2.5,
    "vitamin_b9": 200, "potassium": 2000, "iodine": 150, "vitamin_a": 800, "vitamin_e": 12, "vitamin_k": 75,
    "vitamin_b1": 1.1, "vitamin_b2": 1.4, "vitamin_b3": 16, "vitamin_b6": 1.4, "vitamin_b7": 50, "vitamin_b5": 6,
    "phosphorus": 700, "selenium": 55, "copper": 1, "manganese": 2, "chromium": 40, "molybdenum": 50,
    "fluoride": 3.5, "chloride": 800,
}
UNITS = {
    "monounsaturated_fat": "g", "polyunsaturated_fat": "g", "trans_fat": "g", "cholesterol": "mg", "omega_3": "g",
    "added_sugars": "g", "starch": "g", "alcohol": "g", "water": "g", "sodium": "mg", "caffeine": "mg",
    "iodine": "µg", "selenium": "µg", "chromium": "µg", "molybdenum": "µg", "vitamin_a": "µg", "vitamin_b7": "µg",
    "vitamin_b9": "µg", "vitamin_b12": "µg", "vitamin_d": "µg", "vitamin_k": "µg", "vitamin_c": "mg", "calcium": "mg",
    "iron": "mg", "vitamin_b1": "mg", "vitamin_e": "mg",
}
YAZIO = (
    "nutrient.monounsaturated nutrient.polyunsaturated nutrient.transfat nutrient.cholesterol nutrient.addedsugar "
    "nutrient.alcohol nutrient.water nutrient.sodium mineral.calcium mineral.iron mineral.potassium mineral.magnesium "
    "mineral.zinc mineral.phosphorus mineral.iodine mineral.copper mineral.manganese mineral.selenium mineral.chlorine "
    "mineral.fluoride mineral.fluorine mineral.chrome mineral.molybdenum vitamin.a vitamin.b1 vitamin.b2 vitamin.b3 "
    "vitamin.b5 vitamin.b6 vitamin.b7 vitamin.b11 vitamin.b12 vitamin.c vitamin.d vitamin.e vitamin.k"
).split()
DAY = date.today().isoformat()


def log(client, food, amount, day=DAY, meal="lunch"):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text
    return r.json()


def make_food(client, name="Food", extra=None, **per_100):
    body = {"name": name, "per_100": per_100, "extra": extra or {}}
    r = client.post("/api/v1/foods", json=body)
    assert r.status_code == 201, r.text
    return r.json()


# directory


def test_directory_is_consistent():
    keys = [n.key for n in nutrients.NUTRIENTS]
    assert len(keys) == len(set(keys))
    for n in nutrients.NUTRIENTS:
        assert n.group in nutrients.GROUPS and n.unit in ("g", "mg", "µg")
        assert n.max > 0 and (n.nrv is None or n.nrv < n.max)
    assert {n.group for n in nutrients.NUTRIENTS} == set(nutrients.GROUPS)
    # the eight core values stay in per_100 and never appear here
    assert not set(keys) & {"kcal", "fat", "saturated_fat", "carbs", "sugars", "fiber", "protein", "salt"}


def test_nrv_samples_and_units():
    for key, nrv in NRV_SAMPLES.items():
        assert nutrients.BY_KEY[key].nrv == nrv, key
    for key, unit in UNITS.items():
        assert nutrients.BY_KEY[key].unit == unit, key
    assert nutrients.BY_KEY["sodium"].nrv is None
    assert sum(1 for n in nutrients.NUTRIENTS if n.nrv) == len(NRV_SAMPLES)


def test_off_columns_exist_in_the_real_export_header():
    for n in nutrients.NUTRIENTS:
        assert n.off in HEADER, n.key
    assert len(set(nutrients.OFF_COLUMNS.values())) == len(nutrients.OFF_COLUMNS)


def test_yazio_mapping_is_complete():
    assert set(YAZIO) <= set(nutrients.YAZIO_KEYS)
    assert nutrients.YAZIO_KEYS["mineral.fluorine"] == nutrients.YAZIO_KEYS["mineral.fluoride"] == "fluoride"
    assert nutrients.YAZIO_KEYS["vitamin.b11"] == "vitamin_b9"
    assert set(nutrients.YAZIO_KEYS.values()) <= set(nutrients.KEYS)


def test_route_serves_the_directory(client):
    body = client.get("/api/v1/nutrients").json()
    assert [row["key"] for row in body] == list(nutrients.KEYS)
    assert {"key": "vitamin_c", "group": "vitamin", "unit": "mg", "nrv": 80} in body
    assert {"key": "sodium", "group": "other", "unit": "mg", "nrv": None} in body


# unit conversion

def test_off_grams_become_the_target_unit():
    assert nutrients.from_off("vitamin_c", 0.04) == 40  # g -> mg
    assert nutrients.from_off("vitamin_b12", 0.0000024) == 2.4  # g -> µg
    assert nutrients.from_off("vitamin_d", 0.000005) == 5
    assert nutrients.from_off("sodium", 0.4) == 400
    assert nutrients.from_off("omega_3", 1.5) == 1.5  # grams stay grams
    assert nutrients.from_off("vitamin_c", None) is None and nutrients.from_off("vitamin_c", -1) is None


def test_implausible_values_are_dropped():
    assert nutrients.from_off("vitamin_c", 40) is None  # 40 g/100 g would be 40000 mg
    assert nutrients.from_off("iron", 5) is None
    assert nutrients.from_off("vitamin_b12", 1) is None  # 1 g = 1,000,000 µg
    assert nutrients.from_off("calcium", 0.12) == 120


def test_parts_larger_than_their_parent_are_dropped():
    values = {"monounsaturated-fat_100g": 20.0, "starch_100g": 30.0, "vitamin-c_100g": 0.01}
    got = nutrients.extra_from_off(values.get, fat=5, carbs=60)
    assert got == {"starch": 30.0, "vitamin_c": 10}  # the 20 g monounsaturated cannot be part of 5 g fat


def test_off_live_lookup_converts_units(client, monkeypatch):
    nutriments = dict(PRODUCT["product"]["nutriments"])
    nutriments.update({"vitamin-c_100g": 0.04, "vitamin-b12_100g": "0.0000024", "calcium_100g": 0.12, "iron_100g": 12,
                       "sodium_100g": 0.1, "omega-3-fat_100g": 0.5, "vitamin-d_100g": "n/a"})
    monkeypatch.setitem(PRODUCT["product"], "nutriments", nutriments)
    body = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert body["extra"] == {"calcium": 120, "sodium": 100, "omega_3": 0.5, "vitamin_b12": 2.4, "vitamin_c": 40}
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()["extra"] == body["extra"]  # from the cache


def test_off_live_without_extras_gives_an_empty_object(client):
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()["extra"] == {}


# validation of FoodIn.extra

@pytest.mark.parametrize("extra", [
    {"unobtainium": 1}, {"vitamin_c": -1}, {"vitamin_c": 10001}, {"vitamin_c": None}, {"vitamin_c": "lots"},
    {"kcal": 5},  # a core value belongs into per_100
])
def test_bad_extra_is_rejected(client, extra):
    body = {"name": "X", "per_100": {"kcal": 1}, "extra": extra}
    assert client.post("/api/v1/foods", json=body).status_code == 422
    assert client.put(f"/api/v1/foods/barcode/{NUTELLA}", json=body).status_code == 422


def test_extra_roundtrip_and_replace(client):
    food = make_food(client, extra={"vitamin_c": 40, "iron": 1.5, "vitamin_d": 0}, kcal=43)
    assert food["extra"] == {"vitamin_c": 40, "iron": 1.5, "vitamin_d": 0}
    assert client.get(f"/api/v1/foods/{food['id']}").json()["extra"] == food["extra"]
    assert client.get("/api/v1/foods").json()[0]["extra"] == food["extra"]
    body = {"name": "Food", "per_100": {"kcal": 43}, "extra": {"zinc": 2}}
    assert client.put(f"/api/v1/foods/{food['id']}", json=body).json()["extra"] == {"zinc": 2}
    assert client.put(f"/api/v1/foods/{food['id']}", json={"name": "Food", "per_100": {}}).json()["extra"] == {}


def test_food_without_extra_in_the_database_is_served_with_an_empty_object(tmp_path):
    store = Store(str(tmp_path / "legacy.db"))
    store.put_food(None, "own", {"name": "Old", "brand": None, "unit": "g", "per_100": {"kcal": 10}, "complete": False})
    client = TestClient(create_app(str(tmp_path / "legacy.db")))
    assert client.get("/api/v1/foods").json()[0]["extra"] == {}


# schema migration

def test_version_2_database_gets_extra_on_entries_without_losing_data(tmp_path):
    path = str(tmp_path / "v2.db")
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE food (id INTEGER PRIMARY KEY, code TEXT UNIQUE, source TEXT NOT NULL, found INTEGER NOT NULL, data TEXT, fetched_at INTEGER NOT NULL);
        CREATE TABLE diary_entry (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES user(id), day TEXT NOT NULL,
            meal TEXT NOT NULL, food_id INTEGER, amount REAL NOT NULL, unit TEXT NOT NULL, name TEXT NOT NULL, brand TEXT,
            per_100 TEXT NOT NULL, created_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE goal (user_id INTEGER PRIMARY KEY REFERENCES user(id), kcal INTEGER NOT NULL, protein REAL NOT NULL,
            carbs REAL NOT NULL, fat REAL NOT NULL);
        CREATE TABLE weight (user_id INTEGER NOT NULL REFERENCES user(id), day TEXT NOT NULL, kg REAL NOT NULL,
            demo INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
        INSERT INTO user VALUES (1, 'me', 'me', 1);
        INSERT INTO diary_entry (user_id, day, meal, amount, unit, name, per_100, created_at, demo)
            VALUES (1, '2026-01-02', 'lunch', 150, 'g', 'Rice', '{"kcal": 130}', 5, 1);
        PRAGMA user_version = 2;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert con.execute("SELECT name, amount, demo, extra FROM diary_entry").fetchall() == [("Rice", 150, 1, "{}")]
    con.close()
    assert store.entries_between(1, "2026-01-01", "2026-01-31")[0]["extra"] == {}
    Store(path)  # a second start changes nothing


# diary: copies and day totals

def test_entries_copy_extra_and_ignore_later_changes_of_the_food(client):
    food = make_food(client, extra={"vitamin_c": 40}, kcal=100)
    log(client, food, 200)
    body = {"name": "Food", "per_100": {"kcal": 100}, "extra": {"vitamin_c": 400, "iron": 5}}
    assert client.put(f"/api/v1/foods/{food['id']}", json=body).status_code == 200
    day = client.get(f"/api/v1/diary/{DAY}").json()
    assert day["extra_totals"] == {"vitamin_c": {"amount": 80, "coverage": 1}}  # 200 g of 40 mg/100 g
    log(client, food, 100, meal="dinner")
    assert client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"]["vitamin_c"]["amount"] == 80 + 400
    client.delete(f"/api/v1/foods/{food['id']}")
    assert client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"]["vitamin_c"]["amount"] == 480


def test_day_without_extras_has_no_extra_totals(client):
    log(client, make_food(client, kcal=100), 100)
    assert client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"] == {}
    assert client.get("/api/v1/diary/2020-01-01").json()["extra_totals"] == {}


def test_coverage_is_the_energy_share_of_entries_that_state_the_nutrient(client):
    with_c = make_food(client, "Juice", extra={"vitamin_c": 50, "iron": 1}, kcal=100)
    other = make_food(client, "Bread", extra={"iron": 3}, kcal=300)
    log(client, with_c, 100)  # 100 kcal, 50 mg vitamin C
    log(client, other, 100, meal="dinner")  # 300 kcal, no vitamin C
    totals = client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"]
    assert totals["vitamin_c"] == {"amount": 50, "coverage": 0.25}  # 100 of 400 kcal
    assert totals["iron"] == {"amount": 4, "coverage": 1}
    # a stated zero is still a statement
    zero = make_food(client, "Water+", extra={"vitamin_c": 0}, kcal=100)
    log(client, zero, 100, meal="snack")
    assert client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"]["vitamin_c"] == {"amount": 50, "coverage": 0.4}


def test_coverage_falls_back_to_entry_share_without_energy(client):
    tea = make_food(client, "Tea", extra={"caffeine": 20}, kcal=0)
    plain = make_food(client, "Water", kcal=0)
    log(client, tea, 100)
    log(client, plain, 100, meal="dinner")
    assert client.get(f"/api/v1/diary/{DAY}").json()["extra_totals"]["caffeine"] == {"amount": 20, "coverage": 0.5}


# insights

def d(offset):
    return (date(2025, 3, 3) + timedelta(days=offset)).isoformat()


def test_insights_micros(client):
    juice = make_food(client, "Juice", extra={"vitamin_c": 40, "iron": 1.2}, kcal=100)
    bread = make_food(client, "Bread", extra={"iron": 2.4}, kcal=300)
    for i in range(3):
        log(client, juice, 200, d(i))  # 200 kcal, 80 mg vitamin C per day
    log(client, bread, 100, d(0), "dinner")  # 300 kcal
    log(client, bread, 100, d(1), "dinner")
    data = client.get(f"/api/v1/insights?from={d(0)}&to={d(4)}").json()  # d(3), d(4) empty
    micros = {m["key"]: m for m in data["micros"]}
    assert [m["key"] for m in data["micros"]] == ["iron", "vitamin_c"]  # most covered first
    assert micros["vitamin_c"] == {
        "key": "vitamin_c", "group": "vitamin", "unit": "mg", "nrv": 80,
        "average": 80, "coverage": round(600 / 1200, 3), "percent_nrv": 100,
    }
    # iron: (2.4 + 2.4 + 2.4) mg of juice... 200 g * 1.2/100 = 2.4 mg ; bread 100 g * 2.4/100 = 2.4 mg
    assert micros["iron"]["average"] == round((3 * 2.4 + 2 * 2.4) / 3, 3)
    assert micros["iron"]["coverage"] == 1
    assert micros["iron"]["percent_nrv"] == round(micros["iron"]["average"] / 14 * 100, 1)
    assert data["hints"] and all("vitamin" not in h["code"] for h in data["hints"])


def test_insights_micros_null_percent_without_nrv_and_empty_without_data(client):
    tea = make_food(client, "Coffee", extra={"caffeine": 40}, kcal=2)
    log(client, tea, 250, d(0))
    micros = client.get(f"/api/v1/insights?from={d(0)}&to={d(1)}").json()["micros"]
    assert micros == [{"key": "caffeine", "group": "other", "unit": "mg", "nrv": None, "average": 100,
                       "coverage": 1, "percent_nrv": None}]
    assert client.get(f"/api/v1/insights?from={d(10)}&to={d(12)}").json()["micros"] == []


# catalogue import and lookups

def test_catalog_import_converts_and_drops(tmp_path):
    rows = [
        line(ean("400000000001"), "Orangensaft", "43", **per("0.2", "9", "0.7"), **{
            "vitamin-c_100g": "0.04", "vitamin-b12_100g": "0.0000024", "calcium_100g": "0.012",
            "sodium_100g": "0.002", "omega-3-fat_100g": "", "vitamin-d_100g": "abc"}),
        line(ean("400000000002"), "Unit error", "43", **per("0.2", "9", "0.7"), **{
            "vitamin-c_100g": "40", "iron_100g": "0.0012", "monounsaturated-fat_100g": "9"}),
        line(ean("400000000003"), "Nothing", "43", **per("0.2", "9", "0.7")),
    ]
    dest = str(tmp_path / "c.db")
    import_off(dest, ["en:germany"], gz(tmp_path / "x.gz", rows))
    cat = Catalog(dest)
    assert cat.get("openfoodfacts", ean("400000000001"))["extra"] == {
        "calcium": 12, "sodium": 2, "vitamin_b12": 2.4, "vitamin_c": 40}
    assert cat.get("openfoodfacts", ean("400000000002"))["extra"] == {"iron": 1.2}  # 40 g vitamin C and 9 g mono > 0.2 g fat
    assert cat.get("openfoodfacts", ean("400000000003"))["extra"] == {}
    con = sqlite3.connect(dest)
    assert con.execute("SELECT extra FROM product WHERE name = 'Nothing'").fetchone() == (None,)
    assert json.loads(con.execute("SELECT extra FROM product WHERE name = 'Orangensaft'").fetchone()[0])["vitamin_c"] == 40
    assert " " not in con.execute("SELECT extra FROM product WHERE name = 'Orangensaft'").fetchone()[0]  # compact


@pytest.fixture
def juice_catalog(tmp_path):
    rows = [line(NUTELLA, "Orangensaft Direkt", "43", **per("0.2", "9", "0.7"), **{"vitamin-c_100g": "0.04"})]
    path = str(tmp_path / "catalog.db")  # next to the test database
    import_off(path, ["en:germany"], gz(tmp_path / "x.gz", rows))
    return path


def test_catalog_search_adopt_and_barcode_pass_extra_through(client, juice_catalog):
    hit = client.get("/api/v1/catalog", params={"q": "orangensaft"}).json()[0]
    assert hit["extra"] == {"vitamin_c": 40}
    adopted = client.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": NUTELLA})
    assert adopted.status_code == 201 and adopted.json()["extra"] == {"vitamin_c": 40}
    assert client.get(f"/api/v1/foods/{adopted.json()['id']}").json()["extra"] == {"vitamin_c": 40}


def test_barcode_route_takes_extra_from_the_catalogue(client, juice_catalog):
    body = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert body["name"] == "Orangensaft Direkt" and body["extra"] == {"vitamin_c": 40}


def test_old_catalogue_without_the_extra_column_stays_readable(client, tmp_path):
    path = str(tmp_path / "catalog.db")
    old_schema = catalog_module.SCHEMA.replace("    extra             TEXT,\n", "")
    assert old_schema != catalog_module.SCHEMA
    con = sqlite3.connect(path)
    con.executescript(old_schema)
    con.execute(
        "INSERT INTO product (source, code, name, unit, kcal, fat, popularity, name_key) "
        "VALUES ('openfoodfacts', ?, 'Alter Apfel', 'g', 52, 0.2, 0, 'alter apfel')", (NUTELLA,))
    con.execute("INSERT INTO product_fts (product_fts) VALUES ('rebuild')")
    con.execute("INSERT INTO meta VALUES ('products', '1'), ('updated_at', '1700000000')")
    con.commit()
    con.close()
    hit = client.get("/api/v1/catalog", params={"q": "apfel"}).json()[0]
    assert hit["name"] == "Alter Apfel" and hit["extra"] == {}
    adopted = client.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": NUTELLA})
    assert adopted.status_code == 201 and adopted.json()["extra"] == {}


def test_a_new_import_writes_the_new_schema_over_an_old_file(tmp_path):
    path = str(tmp_path / "c.db")
    sqlite3.connect(path).executescript(catalog_module.SCHEMA.replace("    extra             TEXT,\n", ""))
    rows = [line(ean("400000000001"), "Apfel", "47", **per("0.3", "11", "0.4"), **{"vitamin-c_100g": "0.005"})]
    import_off(path, ["en:germany"], gz(tmp_path / "x.gz", rows))
    assert Catalog(path).get("openfoodfacts", ean("400000000001"))["extra"] == {"vitamin_c": 5}


def test_import_works_when_the_source_has_none_of_the_nutrient_columns(tmp_path):
    keep = [c for c in HEADER if c not in nutrients.OFF_COLUMNS.values()]
    rows = ["\t".join(("4000000000013" if c == "code" else "Apfel" if c == "product_name" else "en:germany"
                       if c == "countries_tags" else "47" if c == "energy-kcal_100g" else "") for c in keep)]
    dest = str(tmp_path / "c.db")
    import_off(dest, ["en:germany"], gz(tmp_path / "x.gz", rows, header=keep))
    assert Catalog(dest).get("openfoodfacts", "4000000000013")["extra"] == {}


# demo data

def test_demo_foods_carry_micronutrients_for_about_a_third():
    with_extra = [f for f in demo.FOODS.values() if f["extra"]]
    assert 0.25 <= len(with_extra) / len(demo.FOODS) <= 0.45
    for food in with_extra:
        assert all(nutrients.plausible(k, v) for k, v in food["extra"].items())


def test_demo_data_shows_micros_with_partial_coverage(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_DEMO_DATA", "1")
    client = TestClient(create_app(str(tmp_path / "demo.db")))
    assert client.post("/api/v1/me/demo-data", json={"days": 30}).status_code == 200
    data = client.get("/api/v1/insights").json()
    assert data["micros"]
    assert 0 < min(m["coverage"] for m in data["micros"]) and max(m["coverage"] for m in data["micros"]) < 1
    food = next(f for f in client.get("/api/v1/foods?q=Orangensaft").json())
    assert food["extra"]["vitamin_c"] == 40

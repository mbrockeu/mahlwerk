import json
import sqlite3

from conftest import DROP_V9
from mahlwerk.db import Store

LEGACY = """
CREATE TABLE food (code TEXT PRIMARY KEY, source TEXT NOT NULL, found INTEGER NOT NULL, data TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE scan_test (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, code TEXT NOT NULL);
"""


def test_prototype_database_is_migrated_without_losing_foods(tmp_path):
    path = str(tmp_path / "old.db")
    con = sqlite3.connect(path)
    con.executescript(LEGACY)
    own = json.dumps({"name": "Apfelschorle", "brand": None, "serving_size": "250 ml", "per_100": {"kcal": 24}})
    con.execute("INSERT INTO food VALUES ('4068706059940', 'own', 1, ?, 200)", (own,))
    con.execute("INSERT INTO food VALUES ('3017620422003', 'openfoodfacts', 1, ?, 100)", (json.dumps({"name": "Nutella", "per_100": {}}),))
    con.execute("INSERT INTO food VALUES ('4006381333931', 'openfoodfacts', 0, NULL, 300)")
    con.execute("INSERT INTO scan_test (created_at, code) VALUES (1, '3017620422003')")
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert con.execute("SELECT code, source, found, fetched_at FROM food ORDER BY id").fetchall() == [
        ("3017620422003", "openfoodfacts", 1, 100),
        ("4068706059940", "own", 1, 200),
        ("4006381333931", "openfoodfacts", 0, 300),
    ]
    assert con.execute("SELECT count(*) FROM scan_test").fetchone()[0] == 1  # left alone
    assert con.execute("SELECT name FROM sqlite_master WHERE name = 'food_legacy'").fetchone() is None
    assert {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")} >= {
        "user", "food", "diary_entry", "goal", "weight", "scan_test"}
    con.close()

    migrated = store.get_food_by_code("4068706059940")
    assert migrated["id"] and migrated["data"]["name"] == "Apfelschorle"
    assert store.get_food_by_code("4006381333931")["found"] is False

    Store(path)  # a second start changes nothing
    assert len(sqlite3.connect(path).execute("SELECT * FROM food").fetchall()) == 3


def test_migrated_own_food_is_served_with_derived_unit_and_serving(tmp_path):
    import httpx
    from fastapi.testclient import TestClient

    from mahlwerk.main import create_app

    path = str(tmp_path / "old.db")
    con = sqlite3.connect(path)
    con.executescript(LEGACY)
    data = {"name": "Apfelschorle", "brand": None, "quantity": None, "serving_size": "250 ml",
            "serving_quantity": None, "per_100": {"kcal": 24}, "complete": False}
    con.execute("INSERT INTO food VALUES ('4068706059940', 'own', 1, ?, 200)", (json.dumps(data),))
    con.commit()
    con.close()

    client = TestClient(create_app(path, transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    body = client.get("/api/v1/foods/barcode/4068706059940").json()
    assert (body["unit"], body["serving_quantity"], body["source"]) == ("ml", 250, "own")


def test_fresh_database_gets_the_current_schema(tmp_path):
    path = str(tmp_path / "new.db")
    Store(path)
    assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone()[0] == 14


V1_SCHEMA = """
CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE food (id INTEGER PRIMARY KEY, code TEXT UNIQUE, source TEXT NOT NULL, found INTEGER NOT NULL, data TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE diary_entry (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES user(id), day TEXT NOT NULL,
    meal TEXT NOT NULL, food_id INTEGER, amount REAL NOT NULL, unit TEXT NOT NULL, name TEXT NOT NULL, brand TEXT,
    per_100 TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE goal (user_id INTEGER PRIMARY KEY REFERENCES user(id), kcal INTEGER NOT NULL, protein REAL NOT NULL,
    carbs REAL NOT NULL, fat REAL NOT NULL);
CREATE TABLE weight (user_id INTEGER NOT NULL REFERENCES user(id), day TEXT NOT NULL, kg REAL NOT NULL, PRIMARY KEY (user_id, day));
PRAGMA user_version = 1;
"""


def test_version_1_database_gets_demo_columns_and_keeps_its_data(tmp_path):
    path = str(tmp_path / "v1.db")
    con = sqlite3.connect(path)
    con.executescript(V1_SCHEMA)
    con.execute("INSERT INTO user VALUES (1, 'me', 'me', 1)")
    con.execute("INSERT INTO diary_entry (user_id, day, meal, amount, unit, name, per_100, created_at) "
                "VALUES (1, '2026-01-02', 'lunch', 150, 'g', 'Rice', '{\"kcal\": 130}', 5)")
    con.execute("INSERT INTO weight VALUES (1, '2026-01-02', 80.5)")
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert con.execute("SELECT name, amount, demo FROM diary_entry").fetchall() == [("Rice", 150, 0)]
    assert con.execute("SELECT kg, demo FROM weight").fetchall() == [(80.5, 0)]
    con.close()
    assert store.demo_counts(1) == {"entries": 0, "weights": 0, "water": 0, "activity": 0, "workouts": 0}
    Store(path)  # a second start changes nothing


def test_version_3_database_gets_templates_and_recipes_without_losing_data(tmp_path):
    path = str(tmp_path / "v3.db")
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE food (id INTEGER PRIMARY KEY, code TEXT UNIQUE, source TEXT NOT NULL, found INTEGER NOT NULL, data TEXT, fetched_at INTEGER NOT NULL);
        CREATE TABLE diary_entry (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES user(id), day TEXT NOT NULL,
            meal TEXT NOT NULL, food_id INTEGER, amount REAL NOT NULL, unit TEXT NOT NULL, name TEXT NOT NULL, brand TEXT,
            per_100 TEXT NOT NULL, created_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE goal (user_id INTEGER PRIMARY KEY REFERENCES user(id), kcal INTEGER NOT NULL, protein REAL NOT NULL,
            carbs REAL NOT NULL, fat REAL NOT NULL);
        CREATE TABLE weight (user_id INTEGER NOT NULL REFERENCES user(id), day TEXT NOT NULL, kg REAL NOT NULL,
            demo INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
        INSERT INTO user VALUES (1, 'me', 'me', 1);
        INSERT INTO food VALUES (1, NULL, 'own', 1, '{"name": "Rice", "per_100": {"kcal": 130}}', 7);
        INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, per_100, created_at, extra)
            VALUES (1, '2026-01-02', 'lunch', 1, 150, 'g', 'Rice', '{"kcal": 130}', 5, '{"iron": 1}');
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        INSERT INTO weight VALUES (1, '2026-01-02', 80.5, 0);
        PRAGMA user_version = 3;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")} >= {
        "template", "template_item", "recipe", "recipe_item"}
    assert con.execute("SELECT name, amount, extra FROM diary_entry").fetchall() == [("Rice", 150, '{"iron": 1}')]
    con.close()
    assert store.get_goal(1)["kcal"] == 2000 and store.get_food(1)["recipe_id"] is None
    assert store.weights_between(1, "2026-01-01", "2026-01-31") == [{"day": "2026-01-02", "kg": 80.5}]
    assert store.create_template(1, "T", [{"meal": "lunch", "food_id": 1, "amount": 1, "unit": "g", "name": "Rice",
                                           "brand": None, "per_100": {}, "extra": {}}])
    Store(path)  # a second start changes nothing


DROP_V8 = """
DROP TABLE webhook_delivery; DROP TABLE webhook; DROP TABLE access_token; DROP TABLE setting;
"""
DROP_V7 = """
DROP INDEX diary_entry_external; DROP INDEX diary_entry_import; DROP INDEX food_external; DROP TABLE import_batch;
ALTER TABLE diary_entry DROP COLUMN external_id; ALTER TABLE diary_entry DROP COLUMN import_id;
ALTER TABLE weight DROP COLUMN import_id; ALTER TABLE goal DROP COLUMN import_id;
ALTER TABLE food DROP COLUMN external_id; ALTER TABLE food DROP COLUMN import_id;
"""


def test_version_4_database_gets_settings_and_badges_without_losing_data(tmp_path):
    path = str(tmp_path / "v4.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V9)
    con.executescript(
        """
        DROP TABLE user_setting; DROP TABLE badge_earned; DROP TABLE water; DROP TABLE fast;
        ALTER TABLE goal DROP COLUMN water_ml;
        """
    )
    con.executescript(DROP_V7)
    con.executescript(DROP_V8)
    con.executescript(
        """
        INSERT INTO user VALUES (1, 'me', 'me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        INSERT INTO weight (user_id, day, kg, demo) VALUES (1, '2026-01-02', 80.5, 0);
        PRAGMA user_version = 4;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")} >= {
        "user_setting", "badge_earned", "template", "recipe"}
    con.close()
    assert store.get_goal(1)["kcal"] == 2000
    assert store.weights_between(1, "2026-01-01", "2026-01-31") == [{"day": "2026-01-02", "kg": 80.5}]
    assert store.get_settings(1) == {}  # no setting stored: the app default (playful) applies
    store.set_setting(1, "playful", False)
    assert Store(path).get_settings(1) == {"playful": False}  # a second start changes nothing


def test_version_5_database_gets_water_and_fasting_without_losing_data(tmp_path):
    path = str(tmp_path / "v5.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V9)
    con.executescript(
        """
        DROP TABLE water; DROP TABLE fast;
        ALTER TABLE goal DROP COLUMN water_ml;
        """
    )
    con.executescript(DROP_V7)
    con.executescript(DROP_V8)
    con.executescript(
        """
        INSERT INTO user VALUES (1, 'me', 'me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        INSERT INTO weight (user_id, day, kg, demo) VALUES (1, '2026-01-02', 80.5, 0);
        INSERT INTO user_setting VALUES (1, 'playful', 'false');
        PRAGMA user_version = 5;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")} >= {"water", "fast"}
    con.close()
    assert store.get_goal(1) == {"kcal": 2000, "protein": 100, "carbs": 200, "fat": 60, "water_ml": 2000, "steps": 8000}
    assert store.weights_between(1, "2026-01-01", "2026-01-31") == [{"day": "2026-01-02", "kg": 80.5}]
    assert store.get_settings(1) == {"playful": False}
    assert store.add_water(1, "2026-01-02", 250) == 250
    assert store.start_fast(1, 1000, 16) and store.start_fast(1, 2000, 16) is None  # one open fast per user
    Store(path)  # a second start changes nothing
    assert store.get_water(1, "2026-01-02") == 250

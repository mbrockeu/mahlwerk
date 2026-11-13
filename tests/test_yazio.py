"""Import of a Yazio export: small invented export folders, exact numbers, safety of the data."""

import json
import sqlite3
import time
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from conftest import DROP_V9
from mahlwerk import yazio
from mahlwerk.db import Store

NUTELLA = "3017620422003"

OATS = {
    "name": "Oats", "producer": "Acme", "base_unit": "g", "category": "x", "eans": [], "has_ean": False,
    "servings": [{"serving": "piece", "amount": 10}, {"serving": "portion", "amount": 40}],
    "nutrients": {
        "energy.energy": 3.73, "nutrient.carb": 0.5954, "nutrient.fat": 0.07, "nutrient.protein": 0.135,
        "nutrient.sugar": 0.01, "nutrient.saturated": 0.012, "nutrient.dietaryfiber": 0.1, "nutrient.salt": 0.0002,
        "mineral.calcium": 0.00016, "vitamin.b11": 1e-6, "mineral.fluorine": 2e-6, "mineral.sulfur": 0.001,
    },
}
MILK = {
    "name": "Milk", "producer": None, "base_unit": "ml", "eans": [], "servings": [{"serving": "glass", "amount": 200}],
    "nutrients": {"energy.energy": 0.64, "nutrient.carb": 0.048, "nutrient.fat": 0.036, "nutrient.protein": 0.033},
}
SPREAD = {
    "name": "Spread (Yazio)", "producer": "Nusspli", "base_unit": "g", "eans": [NUTELLA], "servings": [],
    "nutrients": {"energy.energy": 5.5, "nutrient.carb": 0.55, "nutrient.fat": 0.31, "nutrient.protein": 0.06},
}
UNUSED = {
    "name": "Never eaten", "base_unit": "g", "eans": [], "servings": [],
    "nutrients": {"energy.energy": 2.0, "nutrient.carb": 0.4, "nutrient.fat": 0.01, "nutrient.protein": 0.05},
}
SOUP = {  # 4 portions, 300 g + 500 g of ingredients = 200 g per portion; nutrients per portion
    "id": "r-soup", "name": "Soup", "portion_count": 4,
    "nutrients": {"energy.energy": 250, "nutrient.carb": 30, "nutrient.fat": 10, "nutrient.protein": 8, "mineral.calcium": 0.04},
    "servings": [{"product_id": "p-oats", "amount": 300, "base_unit": "g"}, {"product_id": "p-milk", "amount": 500, "base_unit": "ml"}],
}

PRODUCTS = {
    "products": {"p-oats": OATS, "p-milk": MILK, "p-spread": SPREAD, "p-unused": UNUSED},
    "recipes": {"r-soup": SOUP},
}


def training(tid, name, minutes, energy=None, distance=0, steps=0, date_="2026-01-10T07:00:00+01:00", note=None, gateway="apple_health"):
    """One item of `exercises.training` / `custom_training` as the exporter writes it."""
    return {"id": tid, "external_id": f"ext-{tid}", "date": date_, "name": name, "duration": minutes, "distance": distance,
            "energy": energy, "steps": steps, "source": "Apple Watch", "gateway": gateway, "note": note}


def entry(kind, eid, daytime, **fields):
    return {"id": eid, "type": kind, "date": "2026-01-10T08:00:00+01:00", "daytime": daytime, **fields}


DAYS = {
    "2026-01-10": {
        "consumed": {
            "products": [entry("product", "e1", "breakfast", product_id="p-oats", amount=80, serving="portion", serving_quantity=2)],
            "recipe_portions": [entry("recipe_portion", "e2", "lunch", recipe_id="r-soup", portion_count=1.5)],
            "simple_products": [
                entry("simple_product", "e3", "snack", name="Cake", is_ai_generated=False,
                      nutrients={"energy.energy": 320.5, "nutrient.carb": 40, "nutrient.fat": 12.5, "nutrient.protein": 4,
                                 "mineral.calcium": 0.05}),
            ],
        },
        "exercises": {
            "activity": {"steps": 8200, "energy": 230.0, "distance": 6100, "duration": 75, "source": "Apple Watch", "gateway": "apple_health"},
            "training": [
                training("t1", "running", 30, 310.5, 5000, 5400, note="felt good"),
                training("t2", "strengthtraining", 45, 180.0, date_="2026-01-10T18:00:00+01:00"),
            ],
            "custom_training": [training("t3", "tabletennis", 60, 250.0, date_="2026-01-10T20:00:00+01:00", gateway=None)],
        },
        "daily_summary": {"steps": 8000, "activity_energy": 200.0, "water_intake": 1500,
                          "goals": {"energy.energy": 2200, "nutrient.carb": 250.0, "nutrient.fat": 70.0,
                                    "nutrient.protein": 110.0, "water": 2500, "activity.step": 8000, "bodyvalue.weight": None}},
    },
    "2026-01-11": {
        "consumed": {
            "products": [
                entry("product", "e4", "dinner", product_id="p-milk", amount=250),
                entry("product", "e5", "snack", product_id="p-spread", amount=30),
            ],
            "recipe_portions": [], "simple_products": [],
        },
        "exercises": {"activity": None, "training": [], "custom_training": []},
        "daily_summary": {"steps": 0, "activity_energy": 0, "water_intake": 0,
                          "goals": {"energy.energy": 2000, "nutrient.carb": 230.0, "nutrient.fat": 65.0,
                                    "nutrient.protein": 100.0, "water": 2000}},
    },
}
WEIGHTS = {"2026-01-10": 80.4, "2026-01-11": 80.1}


def write_export(folder, products=PRODUCTS, days=DAYS, weights=WEIGHTS):
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in (("products.json", products), ("days.json", days), ("weight.json", weights)):
        if data is not None:
            (folder / name).write_text(json.dumps(data))
    (folder / "nutrients.json").write_text("{}")  # other files are ignored
    return folder


@pytest.fixture
def export(tmp_path):
    return write_export(tmp_path / "export")


@pytest.fixture
def store(client):
    client.get("/api/v1/me")  # creates the user `me`
    return client.app.state.store


@pytest.fixture
def uid(store):
    return store.find_user("me")["id"]


def count(store, table):
    with sqlite3.connect(store.path) as con:
        return con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


def tables(store):
    return {t: count(store, t) for t in ("diary_entry", "food", "weight", "water", "goal", "import_batch", "activity_day", "workout")}


def day(client, d):
    return client.get(f"/api/v1/diary/{d}").json()


# --- values ---------------------------------------------------------------------------------------------------


def test_all_three_kinds_are_imported_with_exact_nutrients(client, store, uid, export):
    summary = yazio.run_import(store, uid, export)
    assert summary.days == 2 and summary.entries == {"product": 3, "recipe": 1, "quick": 1}
    assert summary.foods_created == 4 and summary.foods_reused == 0  # oats, soup, milk, spread
    assert (summary.weights, summary.water, summary.goal_set) == (2, 1, True)
    assert not summary.skipped
    assert summary.unknown_keys == {"mineral.sulfur": 1}

    first = day(client, "2026-01-10")
    meals = {m: v["entries"] for m, v in first["meals"].items()}
    oats = meals["breakfast"][0]
    assert (oats["name"], oats["brand"], oats["amount"], oats["unit"]) == ("Oats", "Acme", 80, "g")
    assert oats["kcal"] == pytest.approx(298.4, abs=0.05)  # 3.73 kcal/g x 80 g
    assert oats["carbs"] == pytest.approx(47.6, abs=0.05) and oats["protein"] == pytest.approx(10.8, abs=0.05)
    soup = meals["lunch"][0]
    assert (soup["name"], soup["unit"], soup["amount"]) == ("Soup", "g", 300)  # 1.5 portions x 200 g
    assert soup["kcal"] == pytest.approx(375, abs=0.05) and soup["carbs"] == pytest.approx(45, abs=0.05)
    assert soup["protein"] == pytest.approx(12, abs=0.05) and soup["fat"] == pytest.approx(15, abs=0.05)
    cake = meals["snack"][0]
    assert cake["food_id"] is None and (cake["amount"], cake["unit"]) == (100, "g")
    assert (cake["kcal"], cake["carbs"], cake["fat"], cake["protein"]) == (320.5, 40, 12.5, 4)
    assert first["totals"]["kcal"] == pytest.approx(298.4 + 375 + 320.5, abs=0.1)
    assert first["water"]["ml"] == 1500

    second = day(client, "2026-01-11")
    milk = second["meals"]["dinner"]["entries"][0]
    assert (milk["unit"], milk["kcal"]) == ("ml", pytest.approx(160, abs=0.05))
    assert second["meals"]["snack"]["entries"][0]["kcal"] == pytest.approx(165, abs=0.05)  # Yazio values, 30 g


def test_micronutrients_are_converted_to_the_directory_units(client, store, export, uid):
    yazio.run_import(store, uid, export)
    rows = {r["name"]: r for r in store.entries_between(uid, "2026-01-10", "2026-01-11")}
    extra = rows["Oats"]["extra"]
    assert extra["calcium"] == pytest.approx(16)  # 0.00016 g/g = 16 mg per 100 g
    assert extra["vitamin_b9"] == pytest.approx(100)  # vitamin.b11 1e-6 g/g = 100 µg per 100 g
    assert extra["fluoride"] == pytest.approx(0.2)  # mineral.fluorine is an alias of fluoride
    assert "sulfur" not in extra and len(extra) == 3
    assert rows["Oats"]["per_100"] == {
        "kcal": 373, "fat": 7, "saturated_fat": 1.2, "carbs": 59.54, "sugars": 1, "fiber": 10, "protein": 13.5, "salt": 0.02}
    assert rows["Soup"]["extra"]["calcium"] == pytest.approx(20)  # 0.04 g per portion = 40 mg / 200 g -> 20 mg/100 g
    assert rows["Cake"]["extra"]["calcium"] == pytest.approx(50)  # 0.05 g in the entry = 50 mg per (100 g) entry
    assert client.get("/api/v1/diary/2026-01-10").json()["extra_totals"]["calcium"]["amount"] == pytest.approx(16 * .8 + 40 * 1.5 + 50)


def test_foods_carry_the_yazio_source_and_the_first_portion(client, store, export, uid):
    yazio.run_import(store, uid, export)
    foods = {f["name"]: f for f in client.get("/api/v1/foods?source=yazio&limit=50").json()}
    assert set(foods) == {"Oats", "Soup", "Milk", "Spread (Yazio)"}
    oats = foods["Oats"]
    assert oats["source"] == "yazio" and oats["code"] is None and oats["brand"] == "Acme"
    assert (oats["serving_quantity"], oats["serving_size"], oats["unit"]) == (40, "40 g", "g")  # `portion` before `piece`
    assert foods["Milk"]["unit"] == "ml" and foods["Milk"]["serving_quantity"] == 200
    assert foods["Soup"]["serving_quantity"] == 200 and foods["Soup"]["per_100"]["kcal"] == pytest.approx(125)
    assert foods["Spread (Yazio)"]["code"] == NUTELLA  # no local food had this barcode
    assert client.get(f"/api/v1/foods/{oats['id']}").json()["extra"]["calcium"] == pytest.approx(16)


def test_all_products_also_imports_what_was_never_eaten(client, store, export, uid):
    assert "Never eaten" not in [f["name"] for f in client.get("/api/v1/foods?source=yazio").json()]
    assert yazio.run_import(store, uid, export, dry_run=True).foods_created == 4
    summary = yazio.run_import(store, uid, export, all_products=True)
    assert summary.foods_created == 5
    assert "Never eaten" in [f["name"] for f in client.get("/api/v1/foods?source=yazio").json()]


def test_implausible_values_are_left_out_and_counted(client, store, uid, tmp_path):
    products = {"products": {"p": {**OATS, "nutrients": {
        "energy.energy": 20, "nutrient.carb": 0.5, "nutrient.fat": 0.1, "nutrient.protein": 0.1, "mineral.calcium": 5}}},
        "recipes": {}}
    days = {"2026-01-10": {"consumed": {"products": [entry("product", "x", "lunch", product_id="p", amount=100)]}}}
    summary = yazio.run_import(store, uid, write_export(tmp_path / "e", products, days, None))
    assert summary.dropped_values == 2 and summary.entries["product"] == 1  # kcal 2000/100 g and calcium 50 g/100 g
    row = store.entries_between(uid, "2026-01-10", "2026-01-10")[0]
    assert row["per_100"]["kcal"] is None and row["per_100"]["carbs"] == 50 and row["extra"] == {}


def test_bad_entries_are_skipped_with_reasons_and_the_rest_goes_on(client, store, uid, tmp_path):
    days = {
        "2026-01-10": {"consumed": {"products": [
            entry("product", "a", "lunch", product_id="nope", amount=10),
            entry("product", "b", "lunch", product_id="p-milk", amount=0),
            entry("product", "c", "weird", product_id="p-milk", amount=100),
            {"type": "product", "product_id": "p-milk", "amount": 5},
        ], "recipe_portions": [entry("recipe_portion", "d", "lunch", recipe_id="nope", portion_count=1)],
            "simple_products": [entry("simple_product", "f", "snack", name="x", nutrients={"nutrient.fat": 1})]}},
        "not-a-day": {}, "2026-02-30": {},
    }
    summary = yazio.run_import(store, uid, write_export(tmp_path / "e", days=days, weights={"2026-01-10": 3, "x": 80}))
    assert summary.entries["product"] == 1
    assert dict(summary.skipped) == {
        "product not in products.json": 1, "entry with an invalid amount": 1, "entry without id": 1,
        "recipe not in products.json": 1, "quick entry without energy value": 1,
        "day with an invalid date or shape": 2, "weight with an invalid date or value": 2}
    assert dict(summary.notes) == {"entry with an unknown meal put into snack": 1}
    assert store.entries_between(uid, "2026-01-10", "2026-01-10")[0]["meal"] == "snack"


# --- existing barcode ------------------------------------------------------------------------------------------


def test_existing_barcode_food_is_used_and_not_overwritten(client, store, uid, export):
    own = {"name": "Nutella", "brand": "Ferrero", "quantity": None, "serving_size": "15 g", "serving_quantity": 15,
           "unit": "g", "per_100": {"kcal": 539, "fat": 30.9, "carbs": 57.5, "protein": 6.3}, "extra": {}, "complete": True}
    food_id, fetched = store.put_food(NUTELLA, "own", own)
    summary = yazio.run_import(store, uid, export)
    assert summary.foods_created == 3 and summary.foods_reused == 1
    kept = store.get_food(food_id)
    assert kept["source"] == "own" and kept["data"] == own and kept["fetched_at"] == fetched
    spread = day(client, "2026-01-11")["meals"]["snack"]["entries"][0]
    assert spread["food_id"] == food_id and spread["name"] == "Spread (Yazio)"  # the entry keeps the Yazio snapshot
    assert spread["kcal"] == pytest.approx(165, abs=0.05)
    assert store.get_food_by_code(NUTELLA)["id"] == food_id


def test_remembered_miss_for_a_barcode_becomes_the_yazio_food(client, store, uid, export):
    miss_id, _ = store.put_food(NUTELLA, "openfoodfacts", None)
    summary = yazio.run_import(store, uid, export)
    assert summary.foods_created == 4
    food = store.get_food(miss_id)
    assert food["found"] and food["source"] == "yazio" and food["data"]["name"] == "Spread (Yazio)"


# --- idempotence, dry run, undo ----------------------------------------------------------------------------------


def test_second_run_adds_nothing(client, store, uid, export):
    yazio.run_import(store, uid, export)
    before = tables(store)
    again = yazio.run_import(store, uid, export, all_products=False)
    assert again.total_entries == 0 and again.already_imported == 5 and again.batch_id is None
    assert (again.foods_created, again.weights, again.water, again.goal_set) == (0, 0, 0, False)
    assert tables(store) == before
    assert any("Nothing new" in line for line in again.lines())


def test_dry_run_reports_exactly_but_changes_nothing(client, store, uid, export):
    store.put_food(NUTELLA, "own", {"name": "N", "per_100": {"kcal": 1}})
    before = tables(store)
    dry = yazio.run_import(store, uid, export, dry_run=True)
    assert tables(store) == before and dry.batch_id is None
    real = yazio.run_import(store, uid, export)
    for name in ("days", "entries", "foods_created", "foods_reused", "weights", "water", "goal_set"):
        assert getattr(dry, name) == getattr(real, name), name
    assert real.batch_id == store.list_imports(uid)[0]["id"]


def test_remove_takes_back_exactly_the_batch(client, store, uid, export):
    store.put_food(NUTELLA, "own", {"name": "Nutella", "per_100": {"kcal": 539}})
    manual = client.post("/api/v1/foods", json={"name": "Manual", "per_100": {"kcal": 10}}).json()
    client.post("/api/v1/diary/2026-02-01/entries", json={"food_id": manual["id"], "meal": "lunch", "amount": 50})
    client.put("/api/v1/weights/2026-02-01", json={"kg": 81})
    before = tables(store)
    batch = yazio.run_import(store, uid, export).batch_id
    assert tables(store)["diary_entry"] == before["diary_entry"] + 5
    removed = store.remove_import(batch)
    assert removed == {"entries": 5, "weights": 2, "water": 1, "activity": 1, "workouts": 3, "foods": 3, "goal": True}
    assert tables(store) == before
    assert store.remove_import(batch) is None
    # after the undo the same export can be imported again
    assert yazio.run_import(store, uid, export).total_entries == 5


def test_foods_still_used_elsewhere_survive_the_removal(client, store, uid, export):
    batch = yazio.run_import(store, uid, export).batch_id
    oats = next(f for f in client.get("/api/v1/foods?source=yazio").json() if f["name"] == "Oats")
    client.post("/api/v1/diary/2026-02-01/entries", json={"food_id": oats["id"], "meal": "lunch", "amount": 50})
    removed = store.remove_import(batch)
    assert removed["foods"] == 3 and removed["entries"] == 5  # the manual entry is not part of the batch
    assert client.get(f"/api/v1/foods/{oats['id']}").status_code == 200
    assert [f["name"] for f in client.get("/api/v1/foods?source=yazio").json()] == ["Oats"]
    # a template or recipe item keeps a food as well
    yazio.run_import(store, uid, export)
    milk = next(f for f in client.get("/api/v1/foods?source=yazio").json() if f["name"] == "Milk")
    client.post("/api/v1/templates", json={"name": "T", "from": {"day": "2026-01-11", "meal": "dinner"}})
    store.remove_import(store.list_imports(uid)[0]["id"])
    assert client.get(f"/api/v1/foods/{milk['id']}").status_code == 200


def test_a_food_another_user_logged_survives(duo, tmp_path):
    ann, ben = duo
    ann.get("/api/v1/me"), ben.get("/api/v1/me")
    store = ann.app.state.store
    export = write_export(tmp_path / "e")
    batch = yazio.run_import(store, store.find_user("ann")["id"], export).batch_id
    oats = next(f for f in ben.get("/api/v1/foods?source=yazio").json() if f["name"] == "Oats")
    ben.post("/api/v1/diary/2026-02-01/entries", json={"food_id": oats["id"], "meal": "lunch", "amount": 50})
    assert store.remove_import(batch)["foods"] == 3
    assert ben.get(f"/api/v1/foods/{oats['id']}").status_code == 200


def test_changed_rows_keep_their_data_when_the_batch_is_removed(client, store, uid, export):
    batch = yazio.run_import(store, uid, export).batch_id
    client.put("/api/v1/weights/2026-01-10", json={"kg": 79.5})  # the user overwrites a weight
    client.put("/api/v1/water/2026-01-10", json={"ml": 1750})
    e1 = day(client, "2026-01-10")["meals"]["breakfast"]["entries"][0]
    client.patch(f"/api/v1/diary/entries/{e1['id']}", json={"amount": 100})
    client.put("/api/v1/me/goal", json={"kcal": 1900, "protein": 90, "carbs": 200, "fat": 60})
    removed = store.remove_import(batch)
    assert removed == {"entries": 4, "weights": 1, "water": 0, "activity": 1, "workouts": 3, "foods": 3, "goal": False}  # oats is still used
    assert store.weights_between(uid, "2026-01-01", "2026-01-31") == [{"day": "2026-01-10", "kg": 79.5}]
    assert client.get("/api/v1/me").json()["goal"]["kcal"] == 1900
    assert day(client, "2026-01-10")["meals"]["breakfast"]["entries"][0]["amount"] == 100
    assert yazio.run_import(store, uid, export).already_imported == 1  # the kept entry is not imported twice


# --- weight, water, goal ---------------------------------------------------------------------------------------


def test_weight_and_water_only_on_free_days_and_goal_only_without_one(client, store, uid, export):
    client.put("/api/v1/weights/2026-01-10", json={"kg": 80.0})
    client.put("/api/v1/water/2026-01-10", json={"ml": 900})
    client.put("/api/v1/me/goal", json={"kcal": 1800, "protein": 100, "carbs": 200, "fat": 60})
    summary = yazio.run_import(store, uid, export)
    assert (summary.weights, summary.weights_kept, summary.water, summary.water_kept) == (1, 1, 0, 1)
    assert summary.goal_set is False
    assert store.weights_between(uid, "2026-01-01", "2026-01-31") == [
        {"day": "2026-01-10", "kg": 80.0}, {"day": "2026-01-11", "kg": 80.1}]
    assert store.get_water(uid, "2026-01-10") == 900
    assert client.get("/api/v1/me").json()["goal"]["kcal"] == 1800
    store.remove_import(summary.batch_id)  # the existing values stay
    assert store.get_water(uid, "2026-01-10") == 900 and client.get("/api/v1/me").json()["goal"]["kcal"] == 1800
    assert store.weights_between(uid, "2026-01-01", "2026-01-31") == [{"day": "2026-01-10", "kg": 80.0}]


def test_goal_comes_from_the_most_recent_day(client, store, uid, export):
    assert yazio.run_import(store, uid, export).goal_set is True
    assert client.get("/api/v1/me").json()["goal"] == {
        "kcal": 2000, "protein": 100, "carbs": 230, "fat": 65, "water_ml": 2000, "steps": 8000}
    batch = store.list_imports(uid)[0]
    assert batch["counts"]["goal_set"] is True
    assert store.remove_import(batch["id"])["goal"] is True
    assert client.get("/api/v1/me").json()["goal"] is None


def test_water_above_the_limit_is_skipped(store, uid, tmp_path):
    days = {"2026-01-10": {"consumed": {}, "daily_summary": {"water_intake": 12000}},
            "2026-01-11": {"consumed": {}, "daily_summary": {"water_intake": 800}}}
    summary = yazio.run_import(store, uid, write_export(tmp_path / "e", None, days, None))
    assert summary.water == 1 and summary.skipped["water amount above 10 l"] == 1


# --- files and errors --------------------------------------------------------------------------------------------


def test_a_missing_file_skips_its_part_and_is_reported(client, store, uid, tmp_path):
    summary = yazio.run_import(store, uid, write_export(tmp_path / "e", weights=None))
    assert summary.missing_files == ["weight.json"] and summary.weights == 0 and summary.total_entries == 5
    store.remove_import(summary.batch_id)
    assert "File missing, part skipped: weight.json" in summary.lines()
    summary = yazio.run_import(store, uid, write_export(tmp_path / "f", products=None, weights=None))
    assert summary.missing_files == ["products.json", "weight.json"]
    assert summary.entries == {"product": 0, "recipe": 0, "quick": 1}  # only the quick entry needs no product
    assert summary.skipped["products.json missing"] == 4
    store.remove_import(summary.batch_id)
    summary = yazio.run_import(store, uid, write_export(tmp_path / "g", days=None))
    assert summary.missing_files == ["days.json"] and summary.foods_created == 0 and summary.weights == 2


def test_nothing_usable_in_the_folder_is_an_error(store, uid, tmp_path):
    (tmp_path / "empty").mkdir()
    with pytest.raises(yazio.YazioError, match="none of"):
        yazio.run_import(store, uid, tmp_path / "empty")
    with pytest.raises(yazio.YazioError, match="not a folder"):
        yazio.run_import(store, uid, tmp_path / "nope")


@pytest.mark.parametrize("text, message", [("{\"a\": ", "days.json: not valid JSON"), ("[1, 2]", "days.json: expected a JSON object")])
def test_broken_json_is_a_clear_error_and_changes_nothing(client, store, uid, export, text, message):
    (export / "days.json").write_text(text)
    before = tables(store)
    with pytest.raises(yazio.YazioError, match=message):
        yazio.run_import(store, uid, export)
    assert tables(store) == before


def test_a_failure_while_writing_rolls_everything_back(client, store, uid, export, monkeypatch):
    before = tables(store)

    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(Store, "_import_foods", staticmethod(boom))
    with pytest.raises(sqlite3.OperationalError):
        yazio.run_import(store, uid, export)
    assert tables(store) == before


# --- command line ------------------------------------------------------------------------------------------------


def test_cli_import_list_and_remove(client, store, export, capsys):
    db = ["--db", store.path]
    assert yazio.main(["import", "--user", "me", "--dir", str(export), "--dry-run", *db]) == 0
    out = capsys.readouterr().out
    assert "Dry run" in out and "Entries: 5 (products 3, recipe portions 1, quick entries 1)" in out
    assert "Unknown nutrient keys (ignored): mineral.sulfur (1)" in out and count(store, "diary_entry") == 0

    assert yazio.main(["import", "--user", "me", "--dir", str(export), *db]) == 0
    out = capsys.readouterr().out
    assert "Import batch 1 written." in out and "Foods: 4 created, 0 reused" in out and "Goal set: yes" in out
    assert "Took" in out and "Activity: 1 days (kept 0 existing), 3 workouts" in out

    assert yazio.main(["list", *db]) == 0
    assert "batch 1" in capsys.readouterr().out
    assert yazio.main(["list", "--user", "me", *db]) == 0
    assert "me  yazio" in capsys.readouterr().out
    assert yazio.main(["remove", "--batch", "1", *db]) == 0
    assert "5 entries, 2 weights, 1 water days, 1 activity days, 3 workouts, 4 foods" in capsys.readouterr().out
    assert yazio.main(["remove", "--batch", "1", *db]) == 1
    assert "unknown batch" in capsys.readouterr().err
    assert yazio.main(["list", *db]) == 0 and "No import batches." in capsys.readouterr().out


def test_cli_unknown_user_lists_the_known_ones(client, store, export, capsys):
    assert yazio.main(["import", "--user", "zed", "--dir", str(export), "--db", store.path]) == 1
    err = capsys.readouterr().err
    assert "unknown user 'zed'" in err and "existing users: me" in err and "--create-user" in err
    assert count(store, "diary_entry") == 0
    assert yazio.main(["import", "--user", "zed", "--dir", str(export), "--db", store.path, "--create-user"]) == 0
    assert store.find_user("zed") and count(store, "diary_entry") == 5


def test_cli_reports_a_broken_file_and_a_missing_database(client, store, export, tmp_path, capsys):
    (export / "products.json").write_text("not json")
    assert yazio.main(["import", "--user", "me", "--dir", str(export), "--db", store.path]) == 1
    assert "products.json: not valid JSON" in capsys.readouterr().err
    assert yazio.main(["list", "--db", str(tmp_path / "missing.db")]) == 1
    assert "database file not found" in capsys.readouterr().err
    assert not (tmp_path / "missing.db").exists()


def test_cli_takes_the_database_from_the_environment(client, store, export, monkeypatch, capsys):
    monkeypatch.setenv("MAHLWERK_DB", store.path)
    assert yazio.main(["import", "--user", "me", "--dir", str(export)]) == 0
    assert count(store, "diary_entry") == 5


# --- API ---------------------------------------------------------------------------------------------------------


def test_api_lists_and_removes_own_batches_only(duo, tmp_path):
    ann, ben = duo
    ann.get("/api/v1/me"), ben.get("/api/v1/me")
    store = ann.app.state.store
    ann_id, ben_id = (store.find_user(n)["id"] for n in ("ann", "ben"))
    export = write_export(tmp_path / "e")
    a = yazio.run_import(store, ann_id, export).batch_id
    b = yazio.run_import(store, ben_id, export).batch_id
    assert ann.get("/api/v1/me/imports").status_code == 200
    listed = ann.get("/api/v1/me/imports").json()
    assert [x["id"] for x in listed] == [a] and listed[0]["kind"] == "yazio"
    assert listed[0]["counts"] == {
        "days": 2, "entries": 5, "product_entries": 3, "recipe_entries": 1, "quick_entries": 1, "foods": 4,
        "weights": 2, "water": 1, "activity_days": 1, "workouts": 3, "goal_set": True}
    assert isinstance(listed[0]["created_at"], int)
    assert [x["id"] for x in ben.get("/api/v1/me/imports").json()] == [b]
    # the foods are shared: Ben's run reused Ann's foods and created none
    assert ben.get("/api/v1/me/imports").json()[0]["counts"]["foods"] == 0

    assert ben.delete(f"/api/v1/me/imports/{a}").status_code == 404  # not Ben's
    assert ann.delete("/api/v1/me/imports/999").status_code == 404
    assert len(ann.get("/api/v1/diary/2026-01-10").json()["meals"]["breakfast"]["entries"]) == 1
    r = ann.delete(f"/api/v1/me/imports/{a}")
    assert r.status_code == 200 and r.json() == {"entries": 5, "weights": 2, "water": 1, "activity": 1, "workouts": 3, "foods": 0, "goal": True}
    assert ann.get("/api/v1/me/imports").json() == []
    assert ann.get("/api/v1/diary/2026-01-10").json()["meals"]["breakfast"]["entries"] == []
    assert len(ben.get("/api/v1/diary/2026-01-10").json()["meals"]["breakfast"]["entries"]) == 1
    # Ann's batch created the foods and kept them for Ben; Ben's batch created none, so none is removed with it
    assert ben.delete(f"/api/v1/me/imports/{b}").json()["foods"] == 0
    assert len(ben.get("/api/v1/foods?source=yazio").json()) == 4


def test_api_lists_nothing_by_default_and_unknown_batch_is_404(client):
    assert client.get("/api/v1/me/imports").json() == []
    assert client.delete("/api/v1/me/imports/1").status_code == 404


# --- the rest of the app works with imported data ------------------------------------------------------------------


def test_totals_history_insights_badges_and_recent_work_with_imported_data(client, store, uid, export):
    today = date.today()
    shifted = {}
    for offset, (_, content) in enumerate(DAYS.items()):  # yesterday and today, so history/recent see them
        shifted[(today - timedelta(days=1 - offset)).isoformat()] = content
    yazio.run_import(store, uid, write_export(export.parent / "now", days=shifted, weights={}))
    first, second = list(shifted)

    history = {h["day"]: h for h in client.get("/api/v1/history?days=3").json()}
    assert history[first]["logged"] and history[first]["kcal"] == pytest.approx(298.4 + 375 + 320.5, abs=0.1)
    assert history[second]["kcal"] == pytest.approx(160 + 165, abs=0.1)

    data = client.get(f"/api/v1/insights?from={first}&to={second}").json()
    assert data["range"]["logged_days"] == 2
    assert data["averages"]["kcal"] == pytest.approx((993.9 + 325) / 2, abs=0.2)
    names = [f["name"] for f in data["top_foods"]["kcal"]]
    assert names[:2] == ["Soup", "Cake"]  # the quick entry has no food but groups by its name

    assert "first_entry" in {b["code"] for b in client.get("/api/v1/badges").json()["earned"]}

    recent = client.get("/api/v1/foods/recent").json()
    assert {r["food"]["name"] for r in recent} == {"Oats", "Soup", "Milk", "Spread (Yazio)"}
    assert all(r["food"]["source"] == "yazio" for r in recent)
    oats = next(r for r in recent if r["food"]["name"] == "Oats")
    assert (oats["last_amount"], oats["last_meal"]) == (80, "breakfast")
    assert [f["name"] for f in client.get("/api/v1/foods?q=oat").json()] == ["Oats"]  # the search finds it at once
    assert client.get(f"/api/v1/diary/{second}").json()["streak"] == 2


def test_an_imported_food_can_be_logged_again_and_edited(client, store, uid, export):
    yazio.run_import(store, uid, export)
    soup = next(f for f in client.get("/api/v1/foods?source=yazio").json() if f["name"] == "Soup")
    r = client.post("/api/v1/diary/2026-02-01/entries", json={"food_id": soup["id"], "meal": "dinner", "amount": 200})
    assert r.json()["kcal"] == pytest.approx(250, abs=0.05)  # one portion again
    put = client.put(f"/api/v1/foods/{soup['id']}", json={"name": "Soup v2", "per_100": {"kcal": 100}})
    assert put.json()["source"] == "own"  # editing makes it an ordinary own food


# --- schema ------------------------------------------------------------------------------------------------------


def test_version_6_database_is_migrated_without_losing_data(tmp_path):
    path = str(tmp_path / "v6.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V9)
    con.executescript(
        """
        DROP TABLE webhook_delivery; DROP TABLE webhook; DROP TABLE access_token; DROP TABLE setting;
        DROP INDEX diary_entry_external; DROP INDEX diary_entry_import; DROP INDEX food_external;
        DROP TABLE import_batch;
        ALTER TABLE diary_entry DROP COLUMN external_id; ALTER TABLE diary_entry DROP COLUMN import_id;
        ALTER TABLE weight DROP COLUMN import_id; ALTER TABLE water DROP COLUMN import_id;
        ALTER TABLE goal DROP COLUMN import_id;
        ALTER TABLE food DROP COLUMN external_id; ALTER TABLE food DROP COLUMN import_id;
        INSERT INTO user VALUES (1, 'me', 'me', 1);
        INSERT INTO food VALUES (1, NULL, 'own', 1, '{"name": "Rice", "per_100": {"kcal": 130}}', 7);
        INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, per_100, created_at, extra)
            VALUES (1, '2026-01-02', 'lunch', 1, 150, 'g', 'Rice', '{"kcal": 130}', 5, '{}');
        INSERT INTO goal VALUES (1, 2000, 100, 200, 60, 2500);
        INSERT INTO weight VALUES (1, '2026-01-02', 80.5, 0);
        INSERT INTO water VALUES (1, '2026-01-02', 1500, 0);
        PRAGMA user_version = 6;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert con.execute("SELECT name, amount, external_id, import_id FROM diary_entry").fetchall() == [("Rice", 150, None, None)]
    assert con.execute("SELECT kg, import_id FROM weight").fetchall() == [(80.5, None)]
    assert con.execute("SELECT name FROM sqlite_master WHERE name = 'import_batch'").fetchone()
    con.close()
    assert store.get_goal(1)["kcal"] == 2000 and store.get_water(1, "2026-01-02") == 1500
    assert store.list_imports(1) == []
    Store(path)  # a second start changes nothing
    assert store.get_food(1)["data"]["name"] == "Rice"


def test_the_external_id_is_unique_per_user(tmp_path):
    store = Store(str(tmp_path / "u.db"))
    a, b = store.get_or_create_user("a", "a")["id"], store.get_or_create_user("b", "b")["id"]
    insert = ("INSERT INTO diary_entry (user_id, day, meal, amount, unit, name, per_100, created_at, external_id) "
              "VALUES (?, '2026-01-01', 'lunch', 1, 'g', 'x', '{}', 1, 'same')")
    with sqlite3.connect(store.path) as con:
        con.execute(insert, (a,))
        con.execute(insert, (b,))  # another user may have the same id
        with pytest.raises(sqlite3.IntegrityError):
            con.execute(insert, (a,))


# --- load --------------------------------------------------------------------------------------------------------


def test_a_real_sized_export_imports_in_well_under_30_seconds(client, store, uid, tmp_path, capsys):
    """1,200 days, 12,000 entries, 2,000 products (plus recipes and quick entries), generated deterministically."""
    import random

    rng = random.Random(7)
    keys = ["mineral.calcium", "mineral.iron", "mineral.potassium", "mineral.magnesium", "vitamin.c", "vitamin.b12",
            "nutrient.sugar", "nutrient.saturated", "nutrient.dietaryfiber", "nutrient.salt", "mineral.sulfur"]
    products = {}
    for i in range(2000):
        nutrients = {"energy.energy": rng.uniform(0.2, 8), "nutrient.carb": rng.uniform(0, .6),
                     "nutrient.fat": rng.uniform(0, .3), "nutrient.protein": rng.uniform(0, .3)}
        nutrients.update({k: rng.uniform(0, 1e-3) for k in rng.sample(keys, 6)})
        products[f"p{i}"] = {
            "name": f"Product {i}", "producer": f"Brand {i % 50}", "base_unit": "ml" if i % 9 == 0 else "g",
            "eans": [f"{4000000000000 + i}"] if i % 4 == 0 else [], "servings": [{"serving": "portion", "amount": 30 + i % 200}],
            "nutrients": nutrients}
    recipes = {f"r{i}": {"id": f"r{i}", "name": f"Recipe {i}", "portion_count": 2 + i % 4,
                         "nutrients": {"energy.energy": 300 + i, "nutrient.carb": 40, "nutrient.fat": 10, "nutrient.protein": 20},
                         "servings": [{"product_id": "p1", "amount": 400 + i}]} for i in range(60)}
    days, first = {}, date(2022, 1, 1)
    for d in range(1200):
        listed = {"products": [], "recipe_portions": [], "simple_products": []}
        for n in range(10):
            meal = ("breakfast", "lunch", "dinner", "snack")[n % 4]
            base = {"id": str(uuid.UUID(int=d * 100 + n)), "date": f"2022-01-01T{8 + n:02d}:00:00", "daytime": meal}
            if n == 8:
                listed["recipe_portions"].append({**base, "type": "recipe_portion", "recipe_id": f"r{rng.randrange(60)}", "portion_count": 1})
            elif n == 9:
                listed["simple_products"].append({**base, "type": "simple_product", "name": "Quick",
                                                  "nutrients": {"energy.energy": 250, "nutrient.carb": 30, "nutrient.fat": 9, "nutrient.protein": 8}})
            else:
                listed["products"].append({**base, "type": "product", "product_id": f"p{rng.randrange(2000)}", "amount": rng.randint(20, 400)})
        days[(first + timedelta(days=d)).isoformat()] = {
            "consumed": listed, "daily_summary": {"steps": 5000, "water_intake": 2000,
                                                  "goals": {"energy.energy": 2100, "nutrient.carb": 250.0, "nutrient.fat": 70.0, "nutrient.protein": 100.0, "water": 2000}}}
    weights = {(first + timedelta(days=d)).isoformat(): 80 + d % 7 / 10 for d in range(0, 1200, 2)}
    folder = write_export(tmp_path / "big", {"products": products, "recipes": recipes}, days, weights)

    started = time.monotonic()
    summary = yazio.run_import(store, uid, folder, all_products=True)
    elapsed = time.monotonic() - started
    with capsys.disabled():
        print(f"\n[load test] {summary.total_entries} entries, {summary.days} days, {summary.foods_created} foods "
              f"imported in {elapsed:.2f} s")
    assert summary.days == 1200 and summary.total_entries == 12000
    assert summary.entries == {"product": 9600, "recipe": 1200, "quick": 1200}
    assert summary.foods_created == 2060 and summary.weights == 600 and summary.water == 1200
    assert elapsed < 30
    again = yazio.run_import(store, uid, folder, all_products=True)
    assert again.already_imported == 12000 and again.total_entries == 0
    assert store.remove_import(summary.batch_id)["entries"] == 12000


# --- activity and workouts -----------------------------------------------------------------------------------


def rows(store, table, order="rowid"):
    with sqlite3.connect(store.path) as con:
        con.row_factory = sqlite3.Row
        return [dict(r) for r in con.execute(f"SELECT * FROM {table} ORDER BY {order}")]


def test_activity_and_workouts_are_imported_with_exact_values(client, store, uid, export):
    summary = yazio.run_import(store, uid, export)
    assert (summary.activity_days, summary.activity_kept, summary.workouts, summary.workouts_already) == (1, 0, 3, 0)
    assert not summary.skipped
    assert "Activity: 1 days (kept 0 existing), 3 workouts" in summary.lines()

    (day_row,) = rows(store, "activity_day")
    assert (day_row["day"], day_row["steps"], day_row["active_kcal"], day_row["distance_m"], day_row["source"], day_row["demo"]) == (
        "2026-01-10", 8000, 200.0, 6100.0, "yazio", 0)  # the daily summary wins over exercises.activity
    assert day_row["import_id"] == summary.batch_id
    run, strength, other = rows(store, "workout")
    assert (run["kind"], run["name"], run["minutes"], run["kcal"], run["distance_m"], run["steps"], run["note"]) == (
        "running", "", 30.0, 310.5, 5000.0, 5400, "felt good")
    assert (run["external_id"], run["source"], run["import_id"], run["day"]) == ("yazio:t1", "yazio", summary.batch_id, "2026-01-10")
    assert run["started_at"] == int(datetime(2026, 1, 10, 6, 0, tzinfo=timezone.utc).timestamp())  # 07:00 at +01:00
    assert (strength["kind"], strength["minutes"], strength["kcal"], strength["distance_m"], strength["steps"]) == ("strength", 45.0, 180.0, None, None)
    assert (other["kind"], other["name"], other["external_id"]) == ("other", "tabletennis", "yazio:t3")  # custom_training too

    a = day(client, "2026-01-10")["activity"]
    assert (a["steps"], a["active_kcal"], a["distance_m"], a["source"], a["steps_goal"]) == (8000, 200, 6100, "yazio", 8000)
    assert [w["kind"] for w in a["workouts"]] == ["running", "strength", "other"] and a["workouts"][0]["source"] == "yazio"
    assert day(client, "2026-01-11")["activity"]["steps"] is None
    assert client.get("/api/v1/me").json()["goal"]["steps"] == 8000  # `activity.step` of the export


def test_the_yazio_names_map_to_kinds(store, uid, tmp_path):
    names = ("walking", "running", "cycling", "hiking", "strengthtraining", "yoga", "pilates", "crosstrainer",
             "stairclimbing", "circuittrainingcardio", "squash", "bowling", "Curling")
    days = {"2026-01-10": {"exercises": {"activity": None, "training": [training(f"n{i}", n, 20) for i, n in enumerate(names)],
                                         "custom_training": []}}}
    yazio.run_import(store, uid, write_export(tmp_path / "e", days=days, weights=None))
    got = [(w["kind"], w["name"]) for w in rows(store, "workout")]
    assert got == [("walking", ""), ("running", ""), ("cycling", ""), ("hiking", ""), ("strength", ""), ("yoga", ""),
                   ("pilates", ""), ("crosstrainer", ""), ("stairs", ""), ("circuit", ""), ("squash", ""), ("bowling", ""),
                   ("other", "Curling")]


def test_activity_falls_back_to_the_days_exercises_and_bad_values_are_skipped(store, uid, tmp_path):
    days = {
        "2026-01-10": {"daily_summary": {"steps": 0, "activity_energy": 0},
                       "exercises": {"activity": {"steps": 5000, "energy": 150.0, "distance": 3900, "duration": 50}, "training": [], "custom_training": []}},
        "2026-01-11": {"daily_summary": {"steps": 900000, "activity_energy": 99999}},
        "2026-01-12": {"daily_summary": {"steps": 0, "activity_energy": 0}},
        "2026-01-13": {"exercises": {"activity": None, "custom_training": [], "training": [
            training("a", "running", 0), training("b", "running", 5000), {"name": "yoga", "duration": 30},
            training("c", "running", 30, energy=-5, distance=-1, steps=-1), "junk"]}},
    }
    summary = yazio.run_import(store, uid, write_export(tmp_path / "e", days=days, weights=None))
    assert summary.activity_days == 1 and summary.workouts == 1
    assert dict(summary.skipped) == {
        "activity values out of range": 1, "training without a usable duration": 2, "training without id": 2}
    (a,) = rows(store, "activity_day")
    assert (a["day"], a["steps"], a["active_kcal"], a["distance_m"]) == ("2026-01-10", 5000, 150.0, 3900.0)
    (w,) = rows(store, "workout")
    assert (w["external_id"], w["kcal"], w["distance_m"], w["steps"]) == ("yazio:c", None, None, None)  # unusable values left out


def test_activity_only_on_days_without_a_value(client, store, uid, export):
    client.put("/api/v1/activity/2026-01-10", json={"steps": 777})
    summary = yazio.run_import(store, uid, export)
    assert (summary.activity_days, summary.activity_kept, summary.workouts) == (0, 1, 3)
    assert day(client, "2026-01-10")["activity"]["steps"] == 777 and day(client, "2026-01-10")["activity"]["source"] == "manual"


def test_a_second_run_adds_no_activity_and_no_workout_again(client, store, uid, export):
    yazio.run_import(store, uid, export)
    before = tables(store)
    again = yazio.run_import(store, uid, export)
    assert again.batch_id is None and (again.activity_days, again.workouts, again.workouts_already) == (0, 0, 3)
    assert again.activity_kept == 1 and again.already_imported == 5
    assert tables(store) == before


def test_an_export_imported_before_gets_its_activity_added_as_a_batch_of_its_own(client, store, uid, tmp_path):
    """The first run came from the time before activity was imported: the diary exists, the activity does not."""
    old_days = {k: {kk: vv for kk, vv in v.items() if kk != "exercises"} for k, v in DAYS.items()}
    for v in old_days.values():  # the daily summary carried steps before, too, but they were never stored
        v["daily_summary"] = {**v["daily_summary"], "steps": 0, "activity_energy": 0}
    export = write_export(tmp_path / "old", days=old_days)
    first = yazio.run_import(store, uid, export)
    assert first.activity_days == 0 and first.workouts == 0 and rows(store, "activity_day") == [] and rows(store, "workout") == []
    diary_before = {k: v for k, v in tables(store).items() if k not in ("activity_day", "workout", "import_batch")}
    weights_before = client.get("/api/v1/weights?days=3660").json()

    update = yazio.run_import(store, uid, write_export(tmp_path / "new"))
    assert update.batch_id and update.batch_id != first.batch_id
    assert (update.activity_days, update.workouts, update.total_entries, update.weights, update.water, update.foods_created) == (1, 3, 0, 0, 0, 0)
    assert update.already_imported == 5
    assert {k: v for k, v in tables(store).items() if k not in ("activity_day", "workout", "import_batch")} == diary_before
    assert client.get("/api/v1/weights?days=3660").json() == weights_before
    assert [b["id"] for b in client.get("/api/v1/me/imports").json()] == [update.batch_id, first.batch_id]
    assert client.get("/api/v1/me/imports").json()[0]["counts"]["activity_days"] == 1

    removed = store.remove_import(update.batch_id)
    assert removed == {"entries": 0, "weights": 0, "water": 0, "activity": 1, "workouts": 3, "foods": 0, "goal": False}
    assert rows(store, "activity_day") == [] and rows(store, "workout") == []
    assert tables(store)["diary_entry"] == diary_before["diary_entry"]  # the first batch is untouched
    assert yazio.run_import(store, uid, write_export(tmp_path / "new")).workouts == 3  # and can be added again


def test_dry_run_counts_activity_exactly_and_writes_nothing(client, store, uid, export):
    before = tables(store)
    dry = yazio.run_import(store, uid, export, dry_run=True)
    assert (dry.activity_days, dry.workouts) == (1, 3) and dry.batch_id is None
    assert tables(store) == before
    real = yazio.run_import(store, uid, export)
    assert (real.activity_days, real.workouts) == (dry.activity_days, dry.workouts)
    assert (yazio.run_import(store, uid, export, dry_run=True).workouts, yazio.run_import(store, uid, export, dry_run=True).workouts_already) == (0, 3)


def test_changed_activity_rows_keep_their_data_when_the_batch_is_removed(client, store, uid, export):
    batch = yazio.run_import(store, uid, export).batch_id
    client.put("/api/v1/activity/2026-01-10", json={"steps": 9100})  # the user corrects the day
    run = next(w for w in day(client, "2026-01-10")["activity"]["workouts"] if w["kind"] == "running")
    client.patch(f"/api/v1/workouts/{run['id']}", json={"minutes": 35})
    removed = store.remove_import(batch)
    assert (removed["activity"], removed["workouts"]) == (0, 2)
    a = day(client, "2026-01-10")["activity"]
    assert a["steps"] == 9100 and [w["kind"] for w in a["workouts"]] == ["running"] and a["workouts"][0]["minutes"] == 35
    assert a["workouts"][0]["source"] == "manual"
    # the Yazio id stays on the changed workout, so importing again does not bring the old one back
    again = yazio.run_import(store, uid, export)
    assert again.workouts == 2 and again.workouts_already == 1


def test_the_api_removes_an_activity_batch_of_the_user_only(duo, tmp_path):
    ann, ben = duo
    ann.get("/api/v1/me"), ben.get("/api/v1/me")
    store = ann.app.state.store
    ann_id, ben_id = (store.find_user(n)["id"] for n in ("ann", "ben"))
    export = write_export(tmp_path / "e")
    a = yazio.run_import(store, ann_id, export).batch_id
    yazio.run_import(store, ben_id, export)  # the same Yazio ids for another user are fine
    assert ben.get("/api/v1/diary/2026-01-10").json()["activity"]["steps"] == 8000
    assert ben.delete(f"/api/v1/me/imports/{a}").status_code == 404
    r = ann.delete(f"/api/v1/me/imports/{a}")
    assert r.json()["activity"] == 1 and r.json()["workouts"] == 3
    assert ann.get("/api/v1/diary/2026-01-10").json()["activity"]["steps"] is None
    assert len(ben.get("/api/v1/diary/2026-01-10").json()["activity"]["workouts"]) == 3


def test_a_failure_while_writing_activity_rolls_everything_back(client, store, uid, export, monkeypatch):
    before = tables(store)
    original = Store._import_foods

    def boom(*args, **kwargs):
        original(*args, **kwargs)
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(Store, "_import_foods", staticmethod(boom))
    with pytest.raises(sqlite3.OperationalError):
        yazio.run_import(store, uid, export)
    assert tables(store) == before

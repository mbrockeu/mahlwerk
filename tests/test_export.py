"""Personal data export: the ZIP, its range, the formats of the CSV files, and what must never be in it."""

import csv
import io
import json
import re
import sqlite3
import time
import zipfile
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from mahlwerk import export
from mahlwerk.main import create_app

EXPORT = "/api/v1/me/export"
DAY = "2026-03-10"
NAMES = ["diary.csv", "weight.csv", "activity.csv", "workouts.csv", "water.csv", "fasting.csv", "mahlwerk-export.json"]


def open_zip(response) -> dict[str, bytes]:
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def rows(content: bytes, delimiter=",") -> list[list[str]]:
    assert content.startswith(b"\xef\xbb\xbf")  # BOM, so that Excel reads UTF-8
    return list(csv.reader(io.StringIO(content.decode("utf-8-sig"), newline=""), delimiter=delimiter))


def log(client, food, day=DAY, amount=50, meal="lunch"):
    r = client.post(f"/api/v1/diary/{day}/entries", json={"food_id": food["id"], "meal": meal, "amount": amount})
    assert r.status_code == 201, r.text


def fill(client, food, day=DAY):
    """One of everything on `day`."""
    log(client, food, day)
    assert client.put(f"/api/v1/weights/{day}", json={"kg": 71.5, "body_fat_pct": 22.4, "lean_kg": 55.5}).status_code == 200
    assert client.put(f"/api/v1/water/{day}", json={"ml": 1750}).status_code == 200
    assert client.put(f"/api/v1/activity/{day}", json={"steps": 8123, "active_kcal": 310.5, "distance_m": 6400}).status_code == 200
    assert client.post("/api/v1/workouts", json={"day": day, "kind": "running", "name": "Morning run", "minutes": 30, "kcal": 280.5,
                                                 "started_at": 1773126000, "note": "easy"}).status_code == 201


@pytest.fixture
def full(client, food):
    """The single user with data of every kind."""
    fill(client, food)
    client.put("/api/v1/me/goal", json={"kcal": 2100, "protein": 110, "carbs": 240, "fat": 70})
    client.patch("/api/v1/me/settings", json={"playful": False})
    client.post("/api/v1/templates", json={"name": "Usual lunch", "from": {"day": DAY, "meal": "lunch"}})
    client.post("/api/v1/recipes", json={"name": "Porridge", "portions": 2, "items": [{"food_id": food["id"], "amount": 80}]})
    now = int(time.time())
    client.post("/api/v1/fasting/start", json={"started_at": now - 20 * 3600, "target_hours": 16})
    client.post("/api/v1/fasting/stop", json={"ended_at": now - 3600})
    return client


def test_the_archive_has_exactly_these_files_and_the_download_headers(full):
    r = full.get(EXPORT)
    assert list(open_zip(r)) == NAMES
    assert r.headers["content-type"] == "application/zip"
    assert re.fullmatch(r'attachment; filename="mahlwerk-export-me-\d{4}-\d{2}-\d{2}\.zip"', r.headers["content-disposition"])
    assert r.headers["cache-control"] == "no-store"


def test_the_csv_files_hold_the_data_with_the_nutrients_for_the_amount(full):
    files = open_zip(full.get(EXPORT, params={"lang": "en"}))
    diary = rows(files["diary.csv"])
    assert diary[0][:10] == ["Day", "Meal", "Name", "Brand", "Amount", "Unit", "Energy (kcal)", "Protein (g)", "Carbohydrates (g)", "Fat (g)"]
    assert diary[1][:10] == [DAY, "lunch", "Oats", "Acme", "50", "g", "100", "5", "15", "2"]  # 200 kcal per 100 g, 50 g eaten
    assert len(diary) == 2
    assert rows(files["weight.csv"]) == [
        ["Day", "Weight (kg)", "Body fat (%)", "Lean body mass (kg)"], [DAY, "71.5", "22.4", "55.5"]]
    assert rows(files["water.csv"]) == [["Day", "Water (ml)"], [DAY, "1750"]]
    assert rows(files["activity.csv"]) == [["Day", "Steps", "Active energy (kcal)", "Distance (m)", "Source"], [DAY, "8123", "310.5", "6400", "manual"]]
    workouts = rows(files["workouts.csv"])
    assert workouts[0] == ["Day", "Started", "Type", "Name", "Minutes", "Energy (kcal)", "Distance (m)", "Steps", "Note", "Source"]
    assert re.fullmatch(r"2026-03-10T\d\d:\d\d:\d\d[+-]\d\d:\d\d", workouts[1][1])
    assert workouts[1][2:6] == ["running", "Morning run", "30", "280.5"] and workouts[1][8] == "easy"
    fasting = rows(files["fasting.csv"])
    assert fasting[0] == ["Started", "Ended", "Target (hours)", "Actual (hours)"]
    assert fasting[1][2:] == ["16", "19"] and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d", fasting[1][0])


def test_the_json_file_holds_everything_else_too(full):
    data = json.loads(open_zip(full.get(EXPORT))["mahlwerk-export.json"])
    assert data["format_version"] == 2 and data["range"] == {"from": None, "to": None}
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d", data["exported_at"]) and data["app_version"]
    assert data["account"]["username"] == "me" and data["account"]["created_at"]
    assert data["goal"]["kcal"] == 2100 and data["settings"]["playful"] is False
    entry = data["diary"][0]
    assert entry["per_100"]["kcal"] == 200 and entry["nutrients"]["kcal"] == 100 and entry["nutrients"]["protein"] == 5
    assert data["weight"] == [{"day": DAY, "kg": 71.5, "body_fat_pct": 22.4, "lean_kg": 55.5, "health": False, "body_fat_health": False,
                               "lean_health": False}]
    assert data["water"] == [{"day": DAY, "ml": 1750, "health": False}]
    assert data["activity"][0]["steps"] == 8123 and data["workouts"][0]["name"] == "Morning run"
    assert data["fasting"][0]["hours"] == 19 and data["fasting"][0]["target_hours"] == 16
    assert [t["name"] for t in data["templates"]] == ["Usual lunch"] and data["templates"][0]["items"][0]["name"] == "Oats"
    recipe = data["recipes"][0]
    assert recipe["name"] == "Porridge" and recipe["portions"] == 2 and recipe["items"][0]["amount"] == 80
    assert isinstance(data["badges"], list) and data["webhooks"] == []


UID = re.compile(r"[0-9a-f]{32}")


def test_format_2_carries_stable_ids_food_links_the_used_products_and_the_groups(full, food):
    group = full.post("/api/v1/recipe-groups", json={"name": "Breakfast"}).json()
    recipe = full.get("/api/v1/recipes").json()[0]
    assert full.post(f"/api/v1/recipe-groups/{group['id']}/members", json={"food_ids": [recipe["food"]["id"]]}).status_code == 200
    data = json.loads(open_zip(full.get(EXPORT))["mahlwerk-export.json"])
    rows = data["diary"] + data["workouts"] + data["fasting"] + data["templates"] + data["recipes"] + data["recipe_groups"] + data["foods"]
    assert rows and all(UID.fullmatch(r["uid"]) for r in rows)
    assert len({r["uid"] for r in rows}) == len(rows)
    entry = data["diary"][0]
    oats = next(f for f in data["foods"] if f["data"]["name"] == "Oats")
    assert entry["food_uid"] == oats["uid"] and entry["food_code"] is None and entry["external_id"] is None
    assert oats == {"uid": oats["uid"], "code": None, "source": "own", "external_id": None, "data": oats["data"], "piece_label": None,
                    "piece_grams": None, "drink": None, "own": True}
    assert data["templates"][0]["items"][0]["food_uid"] == oats["uid"]
    porridge = data["recipes"][0]
    assert porridge["items"][0]["food_uid"] == oats["uid"] and UID.fullmatch(porridge["food_uid"]) and porridge["food_uid"] != porridge["uid"]
    assert all(f["source"] != "recipe" for f in data["foods"])  # a recipe comes as a recipe, not as its calculated food
    assert [(g["name"], g["members"], g["source"]) for g in data["recipe_groups"]] == [("Breakfast", [porridge["food_uid"]], None)]
    assert data["workouts"][0]["external_id"] is None


def test_the_products_of_other_people_come_only_when_used(duo):
    ann, ben = duo
    oats = {"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}
    ann_food = ann.post("/api/v1/foods", json=oats).json()
    ben_used = ben.post("/api/v1/foods", json={**oats, "name": "Bens Hafer"}).json()
    ben.post("/api/v1/foods", json={**oats, "name": "Bens Geheimnis"})
    log(ann, ann_food)
    log(ann, ben_used)
    foods = json.loads(open_zip(ann.get(EXPORT))["mahlwerk-export.json"])["foods"]
    assert sorted((f["data"]["name"], f["own"]) for f in foods) == [("Bens Hafer", False), ("Oats", True)]


def test_a_period_limits_the_day_based_data_only(client, food):
    for day in ("2026-03-01", "2026-03-10", "2026-03-20"):
        fill(client, food, day)
    client.put("/api/v1/me/goal", json={"kcal": 2100, "protein": 110, "carbs": 240, "fat": 70})
    files = open_zip(client.get(EXPORT, params={"from": "2026-03-05", "to": "2026-03-15"}))
    for name in ("diary.csv", "weight.csv", "activity.csv", "workouts.csv", "water.csv"):
        assert [r[0] for r in rows(files[name])[1:]] == ["2026-03-10"], name
    data = json.loads(files["mahlwerk-export.json"])
    assert data["range"] == {"from": "2026-03-05", "to": "2026-03-15"}
    assert [e["day"] for e in data["diary"]] == ["2026-03-10"] and data["goal"]["kcal"] == 2100  # the goal is not day-based
    only_to = open_zip(client.get(EXPORT, params={"to": "2026-03-10"}))
    assert [r[0] for r in rows(only_to["weight.csv"])[1:]] == ["2026-03-01", "2026-03-10"]  # both ends are inclusive
    from_only = open_zip(client.get(EXPORT, params={"from": "2026-03-10"}))
    assert [r[0] for r in rows(from_only["weight.csv"])[1:]] == ["2026-03-10", "2026-03-20"]


def test_a_fast_is_taken_by_the_day_it_started(client):
    day = date.today() - timedelta(days=1)
    start = int(time.mktime(day.timetuple())) + 20 * 3600
    client.post("/api/v1/fasting/start", json={"started_at": start, "target_hours": 16})
    client.post("/api/v1/fasting/stop", json={"ended_at": start + 17 * 3600 if start + 17 * 3600 < time.time() else int(time.time())})
    inside = open_zip(client.get(EXPORT, params={"from": day.isoformat(), "to": day.isoformat()}))
    assert len(rows(inside["fasting.csv"])) == 2
    outside = open_zip(client.get(EXPORT, params={"to": (day - timedelta(days=1)).isoformat()}))
    assert len(rows(outside["fasting.csv"])) == 1


@pytest.mark.parametrize("params", [
    {"from": "yesterday"}, {"to": "2026-13-01"}, {"from": "2026-02-30"}, {"from": "20260301"},
    {"from": "2026-03-10", "to": "2026-03-09"}, {"lang": "fr"},
])
def test_bad_parameters_are_422(client, params):
    assert client.get(EXPORT, params=params).status_code == 422


def test_one_day_is_a_valid_period(client, food):
    fill(client, food)
    assert client.get(EXPORT, params={"from": DAY, "to": DAY}).status_code == 200


def test_the_german_csv_has_semicolons_and_a_decimal_comma(full):
    files = open_zip(full.get(EXPORT, params={"lang": "de"}))
    diary = rows(files["diary.csv"], ";")
    assert diary[0][:7] == ["Tag", "Mahlzeit", "Name", "Marke", "Menge", "Einheit", "Energie (kcal)"]
    assert diary[1][6:10] == ["100", "5", "15", "2"]
    assert rows(files["weight.csv"], ";") == [
        ["Tag", "Gewicht (kg)", "Körperfett (%)", "Magermasse (kg)"], [DAY, "71,5", "22,4", "55,5"]]
    assert rows(files["activity.csv"], ";")[1][1:4] == ["8123", "310,5", "6400"]
    assert b";" in files["diary.csv"] and b"71,5" in files["weight.csv"] and b"71.5" not in files["weight.csv"]
    assert json.loads(files["mahlwerk-export.json"])["weight"][0]["kg"] == 71.5  # the JSON file has no locale


def test_the_english_csv_has_commas_and_a_decimal_point(full):
    files = open_zip(full.get(EXPORT, params={"lang": "en"}))
    assert rows(files["weight.csv"]) == [
        ["Day", "Weight (kg)", "Body fat (%)", "Lean body mass (kg)"], [DAY, "71.5", "22.4", "55.5"]]
    assert b"71,5" not in files["weight.csv"]


def test_without_lang_the_browser_language_decides(full):
    assert rows(open_zip(full.get(EXPORT, headers={"Accept-Language": "de-DE,de;q=0.9,en;q=0.8"}))["weight.csv"], ";")[0][:2] == ["Tag", "Gewicht (kg)"]
    assert rows(open_zip(full.get(EXPORT, headers={"Accept-Language": "en-US"}))["weight.csv"])[0][:2] == ["Day", "Weight (kg)"]
    assert rows(open_zip(full.get(EXPORT))["weight.csv"])[0][:2] == ["Day", "Weight (kg)"]


def test_other_stored_nutrients_get_their_own_columns(client):
    body = {"name": "Spinach", "per_100": {"kcal": 23, "protein": 2.9, "carbs": 3.6, "fat": 0.4, "fiber": 2.2}, "extra": {"iron": 2.7}}
    spinach = client.post("/api/v1/foods", json=body).json()
    log(client, spinach, amount=200)
    header, line = rows(open_zip(client.get(EXPORT, params={"lang": "en"}))["diary.csv"])
    assert header[header.index("Fiber (g)")] == "Fiber (g)" and line[header.index("Fiber (g)")] == "4.4"
    assert line[header.index("Iron (mg)")] == "5.4"


def test_a_text_a_spreadsheet_would_run_as_a_formula_is_defused_in_the_csv_only(client):
    evil = client.post("/api/v1/foods", json={"name": "=HYPERLINK(\"http://x\")", "per_100": {"kcal": 1, "protein": 0, "carbs": 0, "fat": 0}}).json()
    log(client, evil)
    files = open_zip(client.get(EXPORT))
    assert rows(files["diary.csv"])[1][2] == "'=HYPERLINK(\"http://x\")"
    assert json.loads(files["mahlwerk-export.json"])["diary"][0]["name"] == "=HYPERLINK(\"http://x\")"


def test_an_empty_account_still_gives_the_archive(client):
    files = open_zip(client.get(EXPORT))
    assert list(files) == NAMES
    assert all(len(rows(files[n])) == 1 for n in NAMES[:-1])  # header only
    assert json.loads(files["mahlwerk-export.json"])["diary"] == []


def test_a_read_access_key_may_export(full):
    token = full.post("/api/v1/me/tokens", json={"name": "backup", "scope": "read"}).json()["token"]
    anonymous = TestClient(full.app, client=("testclient", 1))
    r = anonymous.get(EXPORT, headers={"Authorization": f"Bearer {token}"})
    assert list(open_zip(r)) == NAMES


# --- other people ----------------------------------------------------------------------------------------------------------------


def test_the_export_holds_nothing_of_other_users(duo):
    ann, ben = duo
    oats = {"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}
    food = ann.post("/api/v1/foods", json=oats).json()
    log(ann, food, amount=100)
    secret_food = ben.post("/api/v1/foods", json={"name": "BensGeheimnis", "per_100": {"kcal": 5, "protein": 0, "carbs": 1, "fat": 0}}).json()
    log(ben, secret_food, day=DAY, amount=300)
    ben.put(f"/api/v1/weights/{DAY}", json={"kg": 99.9})
    ben.put(f"/api/v1/water/{DAY}", json={"ml": 4321})
    ben.post("/api/v1/workouts", json={"day": DAY, "kind": "running", "name": "BensLauf", "minutes": 11})
    ben.post("/api/v1/templates", json={"name": "BensVorlage", "from": {"day": DAY, "meal": "lunch"}})
    ben.post("/api/v1/recipes", json={"name": "BensRezept", "portions": 1, "items": [{"food_id": secret_food["id"], "amount": 10}]})
    ben.put("/api/v1/me/goal", json={"kcal": 3333, "protein": 100, "carbs": 100, "fat": 100})
    ben.patch("/api/v1/me", json={"display_name": "Bens Anzeigename"})
    files = open_zip(ann.get(EXPORT))
    everything = b"\n".join(files.values()).decode("utf-8-sig")
    for trace in ("BensGeheimnis", "BensLauf", "BensVorlage", "BensRezept", "99.9", "4321", "3333", "Bens Anzeigename", "ben"):
        assert trace not in everything, trace
    data = json.loads(files["mahlwerk-export.json"])
    assert data["account"]["username"] == "ann" and len(data["diary"]) == 1 and data["goal"] is None
    # and the other way round
    assert "ann" not in json.dumps(json.loads(open_zip(ben.get(EXPORT))["mahlwerk-export.json"])["account"])


# --- secrets ---------------------------------------------------------------------------------------------------------------------


def test_no_secret_is_anywhere_in_the_archive(local_app, admin):
    store = local_app.state.store
    uid = _user_id(local_app, "alex")
    token = admin.post("/api/v1/me/tokens", json={"name": "keyname", "scope": "write"}).json()
    hook_secret = "whsec_0123456789abcdef"
    store.create_webhook(uid, "My hook", "https://hooks.example.org/in/PATHSECRET123?key=QUERYSECRET456", hook_secret, ["entry.created"])
    oats = admin.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}).json()
    log(admin, oats)
    con = sqlite3.connect(store.path)
    con.execute("INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, 'cookidoo', ?, 0)", (uid, b"stored-credential-value"))
    con.commit()
    password_hash = con.execute("SELECT password_hash FROM user WHERE id = ?", (uid,)).fetchone()[0]
    token_hash = con.execute("SELECT hash FROM access_token WHERE user_id = ?", (uid,)).fetchone()[0]
    session_hash = con.execute("SELECT hash FROM auth_session WHERE user_id = ?", (uid,)).fetchone()[0]
    assert password_hash and token_hash and session_hash
    files = open_zip(admin.get(EXPORT))
    for name, content in files.items():
        text = content.decode("utf-8-sig")
        for secret in (password_hash, token_hash, session_hash, token["token"], token["token"][:12], hook_secret, "PATHSECRET123",
                       "QUERYSECRET456", "keyname", "stored-credential-value", "password", "scrypt", "secret", "sub"):
            assert secret not in text, (name, secret)
    hooks = json.loads(files["mahlwerk-export.json"])["webhooks"]
    assert [(h["name"], h["host"], h["events"]) for h in hooks] == [("My hook", "hooks.example.org", ["entry.created"])]


def _user_id(app, name):
    return sqlite3.connect(app.state.store.path).execute("SELECT id FROM user WHERE username = ?", (name,)).fetchone()[0]


# --- demo rows -------------------------------------------------------------------------------------------------------------------


def test_demo_rows_of_the_own_account_are_left_out(duo):
    ann, _ = duo
    assert ann.post("/api/v1/me/demo-data", json={"days": 10}).status_code == 200
    assert ann.get("/api/v1/me").json()["demo"]["entries"] > 0
    real = ann.post("/api/v1/foods", json={"name": "Real oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}).json()
    today = date.today().isoformat()
    log(ann, real, day=today)
    ann.put(f"/api/v1/weights/{today}", json={"kg": 80})
    files = open_zip(ann.get(EXPORT))
    assert [r[2] for r in rows(files["diary.csv"])[1:]] == ["Real oats"]
    assert rows(files["weight.csv"])[1:] == [[today, "80", "", ""]]
    data = json.loads(files["mahlwerk-export.json"])
    assert data["activity"] == [] and data["workouts"] == [] and data["water"] == []
    assert all(b["code"] for b in data["badges"])


def test_the_demo_account_exports_its_own_sample_data(duo):
    ann, _ = duo
    app = ann.app
    ann.post("/api/v1/me/demo-data", json={"days": 10})
    user = {"id": _user_id(app, "ann"), "username": "ann", "display_name": "ann", "is_demo": True}
    data = json.loads(zipfile.ZipFile(io.BytesIO(export.build_zip(app.state.store, user, None, None, "en"))).read("mahlwerk-export.json"))
    assert data["diary"] and data["weight"]


def test_the_file_name_is_safe_for_every_user_name():
    assert export.file_name("anna.b-1", "2026-11-15") == "mahlwerk-export-anna.b-1-2026-11-15.zip"
    assert export.file_name('~demo/../"x"', "2026-11-15") == "mahlwerk-export-_demo_..__x_-2026-11-15.zip"


def test_german_csv_names_the_meal_in_german():
    row = {"meal": "breakfast", "nutrients": {}}
    assert export._diary_rows([row], "de")[0]["meal"] == "Frühstück"
    assert export._diary_rows([row], "en")[0]["meal"] == "breakfast"

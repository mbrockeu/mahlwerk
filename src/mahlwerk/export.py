"""Personal data export: everything one user holds, as a ZIP of CSV files (for Excel and Numbers) and one complete JSON file.

There is deliberately no export of the whole database: every function here takes ONE user and reads only rows of that user
(Store.export_*, which name their columns). Passwords, sessions, access keys, webhook secrets, stored secrets and the identity
at a sign-in provider are not part of any table read here, and neither are pictures. Food records are shared by the household;
the diary, templates and recipes carry the copies of the values they were made with, and `foods` holds the products the user made
or uses (so that an import elsewhere can bring them and the links along). Since format 2 every row that has one carries its stable
id (`uid`) and links name their food by `food_uid` and `food_code`: the import (TS server and app) matches on them.

See docs/api-v1.md (GET /api/v1/me/export).
"""

import csv
import io
import json
import re
import zipfile
from datetime import datetime
from urllib.parse import urlsplit

from . import __version__, nutrients, ownership
from .db import Store
from .nutrition import PER_100_KEYS, scale

FORMAT_VERSION = 2
FIRST_DAY, LAST_DAY = "0000-01-01", "9999-12-31"  # an open end of the range

# CSV columns: (key, English header, German header)
DIARY_COLUMNS = (
    ("day", "Day", "Tag"), ("meal", "Meal", "Mahlzeit"), ("name", "Name", "Name"), ("brand", "Brand", "Marke"),
    ("amount", "Amount", "Menge"), ("unit", "Unit", "Einheit"),
    ("kcal", "Energy (kcal)", "Energie (kcal)"), ("protein", "Protein (g)", "Eiweiß (g)"),
    ("carbs", "Carbohydrates (g)", "Kohlenhydrate (g)"), ("fat", "Fat (g)", "Fett (g)"),
    ("saturated_fat", "Saturated fat (g)", "Gesättigte Fettsäuren (g)"), ("sugars", "Sugars (g)", "Zucker (g)"),
    ("fiber", "Fiber (g)", "Ballaststoffe (g)"), ("salt", "Salt (g)", "Salz (g)"),
)
WEIGHT_COLUMNS = (
    ("day", "Day", "Tag"), ("kg", "Weight (kg)", "Gewicht (kg)"), ("body_fat_pct", "Body fat (%)", "Körperfett (%)"),
    ("lean_kg", "Lean body mass (kg)", "Magermasse (kg)"),
)
ACTIVITY_COLUMNS = (
    ("day", "Day", "Tag"), ("steps", "Steps", "Schritte"), ("active_kcal", "Active energy (kcal)", "Aktive Energie (kcal)"),
    ("distance_m", "Distance (m)", "Strecke (m)"), ("source", "Source", "Quelle"),
)
WORKOUT_COLUMNS = (
    ("day", "Day", "Tag"), ("started_at", "Started", "Beginn"), ("kind", "Type", "Art"), ("name", "Name", "Name"),
    ("minutes", "Minutes", "Minuten"), ("kcal", "Energy (kcal)", "Energie (kcal)"), ("distance_m", "Distance (m)", "Strecke (m)"),
    ("steps", "Steps", "Schritte"), ("note", "Note", "Notiz"), ("source", "Source", "Quelle"),
)
WATER_COLUMNS = (("day", "Day", "Tag"), ("ml", "Water (ml)", "Wasser (ml)"))
FASTING_COLUMNS = (
    ("started_at", "Started", "Beginn"), ("ended_at", "Ended", "Ende"), ("target_hours", "Target (hours)", "Ziel (Stunden)"),
    ("hours", "Actual (hours)", "Tatsächlich (Stunden)"),
)


def iso_local(seconds: int | None) -> str | None:
    """Unix seconds as ISO 8601 in the server's local time zone, with the offset ("2026-11-14T20:15:00+01:00")."""
    return None if seconds is None else datetime.fromtimestamp(seconds).astimezone().isoformat(timespec="seconds")


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


# --- the sections: one function each, plain data for the JSON file (and the rows of the CSV files) -------------------------------


def account(store: Store, user: dict) -> dict:
    row = store.export_account(user["id"]) or {}
    return {"username": user["username"], "display_name": user["display_name"], "created_at": iso_local(row.get("created_at"))}


def goal(store: Store, user: dict) -> dict | None:
    return store.get_goal(user["id"])


def goal_history(store: Store, user: dict) -> list[dict]:
    """The goal changes, oldest first; `valid_from` 0001-01-01 = since the start."""
    return [{**g, "changed_at": iso_local(g["changed_at"])} for g in reversed(store.goal_history(user["id"]))]


def settings(store: Store, user: dict) -> dict:
    return store.get_settings(user["id"])


def diary(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    """One row per entry with the nutrients for its amount (`nutrients`, the core values and the other stored ones) next to the
    values per 100 g/ml it was logged with."""
    out = []
    for e in store.export_diary(user["id"], first, last, demo):
        values = scale(e["per_100"], e["amount"])
        out.append({
            "uid": e["uid"], "day": e["day"], "meal": e["meal"], "name": e["name"], "brand": e["brand"], "amount": e["amount"], "unit": e["unit"],
            "logged_at": iso_local(e["created_at"]), "per_100": e["per_100"], "extra_per_100": nutrients.clean(e["extra"]),
            "nutrients": {**{k: _round(v) for k, v in values.items()},
                          **{k: _round(v, 3) for k, v in nutrients.scale_extra(nutrients.clean(e["extra"]), e["amount"]).items()}},
            "external_id": e["external_id"], "food_uid": e["food_uid"], "food_code": e["food_code"],
        })
    return out


def weight(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    return store.export_weights(user["id"], first, last, demo)


def activity(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    return store.export_activity(user["id"], first, last, demo)


def sleep(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    return store.export_sleep(user["id"], first, last, demo)


def workouts(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    return [{**w, "started_at": iso_local(w["started_at"])} for w in store.export_workouts(user["id"], first, last, demo)]


def water(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    return store.export_water(user["id"], first, last, demo)


def fasting(store: Store, user: dict, first: str, last: str) -> list[dict]:
    return [{
        "uid": f["uid"], "started_at": iso_local(f["started_at"]), "ended_at": iso_local(f["ended_at"]), "target_hours": f["target_hours"],
        "hours": None if f["ended_at"] is None else round((f["ended_at"] - f["started_at"]) / 3600, 2),
    } for f in store.export_fasts(user["id"], first, last)]


def _with_dates(rows: list[dict], *keys: str) -> list[dict]:
    return [{**r, **{k: iso_local(r[k]) for k in keys if k in r}} for r in rows]


def templates(store: Store, user: dict) -> list[dict]:
    return _with_dates(store.export_templates(user["id"]), "created_at")


def recipes(store: Store, user: dict, demo: bool) -> list[dict]:
    return _with_dates(store.export_recipes(user["id"], demo), "updated_at")


def foods(store: Store, user: dict, first: str, last: str, demo: bool) -> list[dict]:
    household = ownership.is_household(user) and not demo  # the demo account: its own sample data only
    return _with_dates(store.export_foods(user["id"], first, last, demo, household), "fetched_at")


def recipe_groups(store: Store, user: dict) -> list[dict]:
    return _with_dates(store.export_recipe_groups(user["id"]), "created_at")


def badges(store: Store, user: dict, demo: bool) -> list[dict]:
    return _with_dates(store.export_badges(user["id"], demo), "earned_at")


def webhooks(store: Store, user: dict) -> list[dict]:
    """Name, events, switch and the host of the address; path and query of an address can carry a secret (a hook id), so
    they stay out like the signing secret does."""
    out = []
    for h in store.export_webhooks(user["id"]):
        parts = urlsplit(h["url"])
        out.append({"name": h["name"], "host": parts.hostname, "events": h["events"], "enabled": h["enabled"],
                    "created_at": iso_local(h["created_at"])})
    return out


# --- CSV ---------------------------------------------------------------------------------------------------------------------


class CsvStyle:
    """German spreadsheets want `;` and a decimal comma, English ones `,` and a point."""

    def __init__(self, lang: str):
        self.lang = lang
        self.delimiter = ";" if lang == "de" else ","

    def cell(self, value) -> str:
        if value is None:
            return ""
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, float):
            text = format(round(value, 6), "f").rstrip("0").rstrip(".")  # no exponent, no trailing zeros
            text = "0" if text in ("", "-0") else text
            return text.replace(".", ",") if self.lang == "de" else text
        text = str(value)
        # a text a spreadsheet would run as a formula gets a leading apostrophe (names come from products and imports)
        return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text

    def render(self, columns: tuple, rows: list[dict]) -> bytes:
        """UTF-8 with a BOM, so that Excel does not read it as Windows-1252; lines end with CRLF."""
        out = io.StringIO(newline="")
        writer = csv.writer(out, delimiter=self.delimiter, lineterminator="\r\n")
        writer.writerow([de if self.lang == "de" else en for _, en, de in columns])
        for row in rows:
            writer.writerow([self.cell(row.get(key)) for key, _, _ in columns])
        return out.getvalue().encode("utf-8-sig")


def _diary_columns(rows: list[dict]) -> tuple:
    """The fixed columns plus one for every other nutrient at least one entry has a value for (in the order of the directory)."""
    used = {k for r in rows for k in r["nutrients"]} - set(PER_100_KEYS)
    units = {n.key: n.unit for n in nutrients.NUTRIENTS}
    label = lambda key: f"{key.replace('_', ' ').capitalize()} ({units[key]})"  # noqa: E731
    return DIARY_COLUMNS + tuple((key, label(key), label(key)) for key in nutrients.KEYS if key in used)


MEAL_NAMES_DE = {"breakfast": "Frühstück", "lunch": "Mittagessen", "dinner": "Abendessen", "snack": "Snacks"}


def _diary_rows(rows: list[dict], lang: str) -> list[dict]:
    """The CSV names the meal in the reader's language; the JSON keeps the stored key."""
    names = MEAL_NAMES_DE if lang == "de" else {}
    return [{**r, **r["nutrients"], "meal": names.get(r["meal"], r["meal"])} for r in rows]


# --- the archive -------------------------------------------------------------------------------------------------------------


def build_zip(store: Store, user: dict, first: str | None, last: str | None, lang: str, now: datetime | None = None) -> bytes:
    """The whole archive in memory (a diary of years is a few hundred kilobytes). `first`/`last` limit the day-based data;
    the demo rows of an own account are left out, the demo account itself exports its sample data."""
    now = now or datetime.now().astimezone()
    demo = bool(user.get("is_demo"))
    a, b = first or FIRST_DAY, last or LAST_DAY
    style = CsvStyle(lang)
    data = {
        "format_version": FORMAT_VERSION,
        "exported_at": now.isoformat(timespec="seconds"),
        "app_version": __version__,
        "range": {"from": first, "to": last},
        "account": account(store, user),
        "goal": goal(store, user),
        "goal_history": goal_history(store, user),
        "settings": settings(store, user),
        "diary": diary(store, user, a, b, demo),
        "weight": weight(store, user, a, b, demo),
        "activity": activity(store, user, a, b, demo),
        "sleep": sleep(store, user, a, b, demo),
        "workouts": workouts(store, user, a, b, demo),
        "water": water(store, user, a, b, demo),
        "fasting": fasting(store, user, a, b),
        "templates": templates(store, user),
        "recipes": recipes(store, user, demo),
        "recipe_groups": recipe_groups(store, user),
        "foods": foods(store, user, a, b, demo),
        "badges": badges(store, user, demo),
        "webhooks": webhooks(store, user),
    }
    files = {
        "diary.csv": style.render(_diary_columns(data["diary"]), _diary_rows(data["diary"], lang)),
        "weight.csv": style.render(WEIGHT_COLUMNS, data["weight"]),
        "activity.csv": style.render(ACTIVITY_COLUMNS, data["activity"]),
        "workouts.csv": style.render(WORKOUT_COLUMNS, data["workouts"]),
        "water.csv": style.render(WATER_COLUMNS, data["water"]),
        "fasting.csv": style.render(FASTING_COLUMNS, data["fasting"]),
        "mahlwerk-export.json": json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8"),
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(zipfile.ZipInfo(name, date_time=now.timetuple()[:6]), content, zipfile.ZIP_DEFLATED)
    return buffer.getvalue()


def file_name(username: str, day: str) -> str:
    """`mahlwerk-export-<user>-<day>.zip`; characters that do not belong in a file name (the demo user is `~demo`) become `_`."""
    return f"mahlwerk-export-{re.sub(r'[^A-Za-z0-9._-]', '_', username) or 'user'}-{day}.zip"

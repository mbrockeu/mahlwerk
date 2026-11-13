"""SQLite storage: users, shared foods, per-user diary, goals and weights."""

import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


from . import activity


def _json(value) -> str:
    """json.dumps that refuses NaN and infinity: such a value in a food would turn every day sum that uses it into null."""
    return json.dumps(value, allow_nan=False)

SCHEMA_VERSION = 14

BASE_TABLES = """
CREATE TABLE user (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE TABLE food (
    id          INTEGER PRIMARY KEY,
    code        TEXT UNIQUE,
    source      TEXT NOT NULL,
    found       INTEGER NOT NULL,
    data        TEXT,
    fetched_at  INTEGER NOT NULL
);
CREATE TABLE diary_entry (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    day         TEXT NOT NULL,
    meal        TEXT NOT NULL,
    food_id     INTEGER,
    amount      REAL NOT NULL,
    unit        TEXT NOT NULL,
    name        TEXT NOT NULL,
    brand       TEXT,
    per_100     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    demo        INTEGER NOT NULL DEFAULT 0,
    extra       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX diary_entry_day ON diary_entry (user_id, day);
CREATE INDEX diary_entry_food ON diary_entry (user_id, food_id);
CREATE TABLE goal (
    user_id  INTEGER PRIMARY KEY REFERENCES user(id),
    kcal     INTEGER NOT NULL,
    protein  REAL NOT NULL,
    carbs    REAL NOT NULL,
    fat      REAL NOT NULL
);
CREATE TABLE weight (
    user_id  INTEGER NOT NULL REFERENCES user(id),
    day      TEXT NOT NULL,
    kg       REAL NOT NULL,
    demo     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
"""

# Version 4: meal templates and recipes. Items hold snapshots like diary entries; `food_id` is only a link and is
# set to NULL when the food goes away.
V4_TABLES = """
CREATE TABLE template (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX template_user ON template (user_id);
CREATE TABLE template_item (
    id           INTEGER PRIMARY KEY,
    template_id  INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
    food_id      INTEGER,
    amount       REAL NOT NULL,
    unit         TEXT NOT NULL,
    name         TEXT NOT NULL,
    brand        TEXT,
    per_100      TEXT NOT NULL,
    extra        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX template_item_template ON template_item (template_id);
CREATE TABLE recipe (
    id            INTEGER PRIMARY KEY,
    food_id       INTEGER NOT NULL UNIQUE REFERENCES food(id),
    portions      REAL NOT NULL CHECK (portions > 0),
    total_weight  REAL,
    created_by    INTEGER REFERENCES user(id),
    updated_at    INTEGER NOT NULL
);
CREATE TABLE recipe_item (
    id         INTEGER PRIMARY KEY,
    recipe_id  INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    food_id    INTEGER,
    amount     REAL NOT NULL,
    unit       TEXT NOT NULL,
    name       TEXT NOT NULL,
    brand      TEXT,
    per_100    TEXT NOT NULL,
    extra      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX recipe_item_recipe ON recipe_item (recipe_id, position);
"""

# Version 5: per-user settings and earned badges. `badge_earned.demo` is 1 while a badge is only reachable
# with demo entries, so removing the demo data can take it back.
V5_TABLES = """
CREATE TABLE user_setting (
    user_id  INTEGER NOT NULL REFERENCES user(id),
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
CREATE TABLE badge_earned (
    user_id    INTEGER NOT NULL REFERENCES user(id),
    code       TEXT NOT NULL,
    earned_at  INTEGER NOT NULL,
    seen       INTEGER NOT NULL DEFAULT 0,
    demo       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, code)
);
"""

# Version 6: a daily water goal (NULL = default 2000 ml), the water drunk per day and fasting intervals. `water.demo`
# is 1 for invented values; at most one fast per user is open (ended_at NULL).
V6_TABLES = """
ALTER TABLE goal ADD COLUMN water_ml INTEGER;
CREATE TABLE water (
    user_id  INTEGER NOT NULL REFERENCES user(id),
    day      TEXT NOT NULL,
    ml       INTEGER NOT NULL,
    demo     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
CREATE TABLE fast (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES user(id),
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    target_hours  REAL NOT NULL
);
CREATE INDEX fast_user ON fast (user_id, started_at);
CREATE UNIQUE INDEX fast_open ON fast (user_id) WHERE ended_at IS NULL;
"""

# Version 7: imports. `external_id` is the id the entry (or food) has in the system it came from (a Yazio export); an
# entry id is unique per user, so running an import twice adds nothing. Every run is a batch (`import_batch`); the
# rows it creates carry its id in `import_id` and lose it when the user changes them, so removing the batch takes
# back exactly what is still untouched.
V7_TABLES = """
ALTER TABLE diary_entry ADD COLUMN external_id TEXT;
ALTER TABLE diary_entry ADD COLUMN import_id INTEGER;
ALTER TABLE weight ADD COLUMN import_id INTEGER;
ALTER TABLE water ADD COLUMN import_id INTEGER;
ALTER TABLE goal ADD COLUMN import_id INTEGER;
ALTER TABLE food ADD COLUMN external_id TEXT;
ALTER TABLE food ADD COLUMN import_id INTEGER;
CREATE UNIQUE INDEX diary_entry_external ON diary_entry (user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX diary_entry_import ON diary_entry (import_id) WHERE import_id IS NOT NULL;
CREATE UNIQUE INDEX food_external ON food (external_id) WHERE external_id IS NOT NULL;
CREATE TABLE import_batch (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    counts      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX import_batch_user ON import_batch (user_id);
"""

# Version 8: integrations and the admin area. Personal access tokens are stored as a SHA-256 hash with a short display
# prefix. Outgoing webhooks and their delivery log (the last 20 per hook are kept). `setting` holds the global
# settings an admin changes (key -> JSON value).
V8_TABLES = """
CREATE TABLE access_token (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES user(id),
    name          TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    hash          TEXT NOT NULL UNIQUE,
    scope         TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER,
    last_used_at  INTEGER,
    revoked_at    INTEGER
);
CREATE INDEX access_token_user ON access_token (user_id);
CREATE TABLE webhook (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    events      TEXT NOT NULL DEFAULT '[]',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
);
CREATE INDEX webhook_user ON webhook (user_id);
CREATE TABLE webhook_delivery (
    id           INTEGER PRIMARY KEY,
    webhook_id   INTEGER NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
    event        TEXT NOT NULL,
    status_code  INTEGER,
    error        TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    finished_at  INTEGER
);
CREATE INDEX webhook_delivery_hook ON webhook_delivery (webhook_id, id);
CREATE TABLE setting (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"""

# Version 9: activity. Steps, active energy and distance per day (`activity_day`) and single workouts (`workout`).
# `source` says where a value came from (manual, health = the bulk interface for Apple Health, yazio, demo); `import_id`
# ties rows to a Yazio batch and goes away when the user changes the row. A workout's `external_id` (unique per user)
# is what makes re-sending or re-importing it harmless; kcal NULL means "estimated from MET, weight and minutes".
# Weight and water get a `health` flag: 1 = written by the bulk interface, so a later sync may update it, while a
# value typed by hand (flag 0, no demo) is never overwritten by it. The steps goal is NULL until set (default 8000).
V9_TABLES = """
CREATE TABLE activity_day (
    user_id      INTEGER NOT NULL REFERENCES user(id),
    day          TEXT NOT NULL,
    steps        INTEGER,
    active_kcal  REAL,
    distance_m   REAL,
    source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'health', 'yazio', 'demo')),
    import_id    INTEGER,
    demo         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
CREATE INDEX activity_day_import ON activity_day (import_id) WHERE import_id IS NOT NULL;
CREATE TABLE workout (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES user(id),
    day          TEXT NOT NULL,
    started_at   INTEGER,
    kind         TEXT NOT NULL DEFAULT 'other',
    name         TEXT NOT NULL DEFAULT '',
    minutes      REAL NOT NULL,
    kcal         REAL,
    distance_m   REAL,
    steps        INTEGER,
    note         TEXT,
    source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'health', 'yazio', 'demo')),
    external_id  TEXT,
    import_id    INTEGER,
    demo         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
);
CREATE INDEX workout_day ON workout (user_id, day);
CREATE UNIQUE INDEX workout_external ON workout (user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX workout_import ON workout (import_id) WHERE import_id IS NOT NULL;
ALTER TABLE goal ADD COLUMN steps INTEGER;
ALTER TABLE weight ADD COLUMN health INTEGER NOT NULL DEFAULT 0;
ALTER TABLE water ADD COLUMN health INTEGER NOT NULL DEFAULT 0;
"""

# Version 10: own accounts with passwords (MAHLWERK_AUTH=local). The columns are only used in that mode: a password hash
# (scrypt, parameters inside the string), a block flag and the admin flag of local mode (proxy mode still takes admin from
# the proxy's groups). Sign-in sessions keep only the SHA-256 of their token.
V10_TABLES = """
ALTER TABLE user ADD COLUMN password_hash TEXT;
ALTER TABLE user ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN local_admin INTEGER NOT NULL DEFAULT 0;
CREATE TABLE auth_session (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    hash        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);
CREATE INDEX auth_session_user ON auth_session (user_id);
"""

# Version 11: sign-in through an OpenID Connect provider (MAHLWERK_AUTH=oidc). One row ties the stable identity at the
# provider (issuer + `sub`, never the changeable user name) to one user of this server. A user has at most one identity
# per issuer, an identity belongs to one user.
V11_TABLES = """
CREATE TABLE oidc_identity (
    id          INTEGER PRIMARY KEY,
    issuer      TEXT NOT NULL,
    sub         TEXT NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    created_at  INTEGER NOT NULL,
    last_login  INTEGER NOT NULL,
    UNIQUE (issuer, sub),
    UNIQUE (issuer, user_id)
);
"""

# Version 12: stored secrets (connector credentials), encrypted by vault.py. `user_id` 0 = the household, otherwise the
# owner; `blob` is the encrypted value (version byte, nonce, ciphertext). No plain text and no readable hint is kept.
V12_TABLES = """
CREATE TABLE secret (
    user_id     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    blob        BLOB NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
);
"""
# Version 13: groups of recipes, shared by the household like the recipes. A member is a FOOD id, which covers both kinds of
# recipe at once: an own recipe is a food (source `recipe`) with a `recipe` row, a taken-over Cookidoo recipe is a food (source
# `cookidoo`). `source` links a group made automatically to what it came from (`cookidoo:<collection id>`), so renaming it does
# not break the link; `recipe_group_dismissed` remembers the links whose group the household deleted, so that a later run does not
# bring them back unasked. Triggers keep the members tidy whatever deletes a food or a group.
V13_TABLES = """
CREATE TABLE recipe_group (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL,
    source      TEXT,
    created_by  INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX recipe_group_source ON recipe_group (source) WHERE source IS NOT NULL;
CREATE TABLE recipe_group_item (
    group_id  INTEGER NOT NULL,
    food_id   INTEGER NOT NULL,
    PRIMARY KEY (group_id, food_id)
);
CREATE INDEX recipe_group_item_food ON recipe_group_item (food_id);
CREATE TABLE recipe_group_dismissed (source TEXT PRIMARY KEY);
CREATE TRIGGER recipe_group_item_food_gone AFTER DELETE ON food BEGIN
    DELETE FROM recipe_group_item WHERE food_id = OLD.id;
END;
CREATE TRIGGER recipe_group_item_group_gone AFTER DELETE ON recipe_group BEGIN
    DELETE FROM recipe_group_item WHERE group_id = OLD.id;
END;
"""
# Version 14: pictures of recipes. Only a reference lives here; the files are in the `images` folder next to the database, named
# by the content hash (see imagestore.py). `image_origin` says where the picture came from: `own` (a photo somebody set, wins over
# everything and is never replaced by a reload), `cookidoo` or `web` (fetched once from the provider, when the connector's picture
# switch is on). `image_url` is the address the provider gave (kept so that a later catch-up needs no second call to Cookidoo).
V14_TABLES = """
ALTER TABLE food ADD COLUMN image_hash TEXT;
ALTER TABLE food ADD COLUMN image_origin TEXT;
ALTER TABLE food ADD COLUMN image_at INTEGER;
ALTER TABLE food ADD COLUMN image_url TEXT;
CREATE INDEX food_image_hash ON food (image_hash) WHERE image_hash IS NOT NULL;
"""
TABLES = BASE_TABLES + V4_TABLES + V5_TABLES + V6_TABLES + V7_TABLES + V8_TABLES + V9_TABLES + V10_TABLES + V11_TABLES + V12_TABLES + V13_TABLES + V14_TABLES
DEFAULT_WATER_GOAL = 2000
MAX_WATER_ML = 10000

# Version 1 had no demo marker on entries and weights.
MIGRATE_1_TO_2 = """
ALTER TABLE diary_entry ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE weight ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
"""

# Version 2 had no additional nutrients on entries; existing entries get an empty object.
MIGRATE_2_TO_3 = """
ALTER TABLE diary_entry ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
"""

# Version 3 had neither templates nor recipes; the tables are new, nothing existing changes.
MIGRATE_3_TO_4 = V4_TABLES

# Version 4 had neither settings nor badges; the tables are new, nothing existing changes.
MIGRATE_4_TO_5 = V5_TABLES

# Version 5 had no water and no fasting; one column and two tables are new, nothing existing changes.
MIGRATE_5_TO_6 = V6_TABLES

# Version 6 had no imports; columns and one table are new, nothing existing changes.
MIGRATE_6_TO_7 = V7_TABLES

# Version 7 had no integrations; the tables are new, nothing existing changes.
MIGRATE_7_TO_8 = V8_TABLES

# Version 8 had no activity; the tables are new and three columns are added, nothing existing changes.
MIGRATE_8_TO_9 = V9_TABLES

# Version 9 had no accounts of its own; three columns and one table are new, nothing existing changes.
MIGRATE_9_TO_10 = V10_TABLES

# Version 10 had no provider identities; the table is new, nothing existing changes.
MIGRATE_10_TO_11 = V11_TABLES

# Version 11 had no stored secrets; the table is new, nothing existing changes.
MIGRATE_11_TO_12 = V12_TABLES

# Version 12 had no recipe groups; the tables and triggers are new, nothing existing changes.
MIGRATE_12_TO_13 = V13_TABLES

# Version 13 had no recipe pictures; four columns and an index are new, nothing existing changes.
MIGRATE_13_TO_14 = V14_TABLES

# Demo foods are ordinary `food` rows whose JSON `data` carries "demo": true (test-data mode of the own account) or
# "demo_account": true (the built-in demo account; these are left out of the product list of everybody else).
DEMO_FOOD = "json_extract(data, '$.demo') = 1"
DEMO_ACCOUNT_FOOD = "json_extract(data, '$.demo_account') = 1"
FOOD_MARKERS = {"demo": DEMO_FOOD, "demo_account": DEMO_ACCOUNT_FOOD}  # the only values `marker` may take (they go into SQL text)

# The built-in demo account (demo_account.py) is the user row with this name. No sign-in mode can produce it: the local
# user name pattern, the OpenID Connect user name check and the Yazio command refuse a `~`, and the proxy header and
# MAHLWERK_SINGLE_USER are refused explicitly (is_reserved_name). So the name works as a flag ("kind") without a schema change;
# a real user called "demo" is an ordinary user. The row counts as THE demo account only while the setting
# `demo_account.user_id` points to it. The row is never deleted once made (ids of SQLite tables without AUTOINCREMENT are
# reused, and a request that is still running must never write into a stranger's account): "delete" empties it and sets
# `demo_account.deleted`.
RESERVED_USERNAME = "~demo"
DEMO_ACCOUNT_SETTING = "demo_account.user_id"
DEMO_DELETED_SETTING = "demo_account.deleted"


def is_reserved_name(username: str) -> bool:
    """The name of the demo account (compared case-insensitively and after trimming, like every user name)."""
    return username.strip().lower() == RESERVED_USERNAME

# A food row together with the recipe it was calculated from (NULL for everything else).
FOOD_SELECT = "SELECT food.*, (SELECT recipe.id FROM recipe WHERE recipe.food_id = food.id) AS recipe_id FROM food"

# The prototype keyed `food` by barcode. Its rows move over; `scan_test` is left alone.
LEGACY_RENAME = "ALTER TABLE food RENAME TO food_legacy;"
LEGACY_COPY = """
INSERT INTO food (code, source, found, data, fetched_at)
    SELECT code, source, found, data, fetched_at FROM food_legacy ORDER BY fetched_at, rowid;
DROP TABLE food_legacy;
"""


class NameTaken(Exception):
    """A user with this name exists."""


class ReservedName(NameTaken):
    """The user name is reserved for the demo account."""


class SetupDone(Exception):
    """The first admin has been created already."""


class SignInRefused(Exception):
    """An OpenID Connect sign-in cannot be mapped to a user; `code` is one of blocked, conflict, exists, name."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class LastAdmin(Exception):
    """The change would leave the server without an active admin."""


class Store:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._migrate()

    @contextmanager
    def _connect(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        try:
            with con:
                yield con
        finally:
            con.close()

    def _migrate(self) -> None:
        with self._connect() as con:
            version = con.execute("PRAGMA user_version").fetchone()[0]
            if version >= SCHEMA_VERSION:
                return
            if version == 0:
                columns = {r["name"] for r in con.execute("PRAGMA table_info(food)")}
                legacy = bool(columns) and "id" not in columns
                script = "BEGIN;" + (LEGACY_RENAME if legacy else "") + TABLES
                script += (LEGACY_COPY if legacy else "")
            else:
                script = "BEGIN;" + (MIGRATE_1_TO_2 if version < 2 else "") + (MIGRATE_2_TO_3 if version < 3 else "")
                script += (MIGRATE_3_TO_4 if version < 4 else "") + (MIGRATE_4_TO_5 if version < 5 else "")
                script += (MIGRATE_5_TO_6 if version < 6 else "") + (MIGRATE_6_TO_7 if version < 7 else "")
                script += (MIGRATE_7_TO_8 if version < 8 else "") + (MIGRATE_8_TO_9 if version < 9 else "")
                script += (MIGRATE_9_TO_10 if version < 10 else "")
                script += (MIGRATE_10_TO_11 if version < 11 else "") + (MIGRATE_11_TO_12 if version < 12 else "")
                script += (MIGRATE_12_TO_13 if version < 13 else "") + MIGRATE_13_TO_14
            script += f"PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
            try:
                con.executescript(script)
            except Exception:
                con.rollback()
                raise

    # users and goals

    def get_or_create_user(self, username: str, display_name: str) -> dict:
        if is_reserved_name(username):
            raise ReservedName(username)
        with self._connect() as con:
            row = con.execute("SELECT * FROM user WHERE username = ?", (username,)).fetchone()
            if row is None:
                cur = con.execute(
                    "INSERT INTO user (username, display_name, created_at) VALUES (?, ?, ?)",
                    (username, display_name, int(time.time())),
                )
                return {"id": cur.lastrowid, "username": username, "display_name": display_name}
            if row["display_name"] != display_name:
                con.execute("UPDATE user SET display_name = ? WHERE id = ?", (display_name, row["id"]))
            return {"id": row["id"], "username": username, "display_name": display_name}

    def get_goal(self, user_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute(
                "SELECT kcal, protein, carbs, fat, water_ml, steps FROM goal WHERE user_id = ?", (user_id,)
            ).fetchone()
        if row is None:
            return None
        return {**dict(row), "water_ml": row["water_ml"] or DEFAULT_WATER_GOAL, "steps": row["steps"] or activity.DEFAULT_STEPS_GOAL}

    def set_goal(self, user_id: int, goal: dict) -> None:
        with self._connect() as con:
            con.execute(
                "INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps) "
                "VALUES (:user_id, :kcal, :protein, :carbs, :fat, :water_ml, :steps) "
                "ON CONFLICT(user_id) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, "
                "carbs = excluded.carbs, fat = excluded.fat, water_ml = excluded.water_ml, steps = excluded.steps, "
                "import_id = NULL",
                {"user_id": user_id, "water_ml": DEFAULT_WATER_GOAL, "steps": activity.DEFAULT_STEPS_GOAL, **goal},
            )

    # accounts and sign-in sessions of MAHLWERK_AUTH=local

    @staticmethod
    def _active_admins(con, besides: int | None = None) -> int:
        return con.execute(
            "SELECT count(*) FROM user WHERE local_admin = 1 AND disabled = 0 AND password_hash IS NOT NULL AND id IS NOT ?",
            (besides,),
        ).fetchone()[0]

    def needs_setup(self) -> bool:
        """True while nobody has a password yet: the first-start page may create the first admin."""
        with self._connect() as con:
            return con.execute("SELECT 1 FROM user WHERE password_hash IS NOT NULL").fetchone() is None

    def local_user(self, username: str) -> dict | None:
        """The account with this name (case-insensitive) including its password hash, or None."""
        with self._connect() as con:
            row = con.execute("SELECT * FROM user WHERE lower(username) = ?", (username.lower(),)).fetchone()
        return dict(row) if row else None

    def setup_first_admin(self, username: str, display_name: str, password_hash: str) -> dict:
        """Create the first admin, only while no user has a password. The check and the write happen under one write lock,
        so two requests at the same time cannot both succeed. A user of the same name without a password (an older
        single-user or proxy database) is taken over with its data."""
        if is_reserved_name(username):
            raise ReservedName(username)
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            if con.execute("SELECT 1 FROM user WHERE password_hash IS NOT NULL").fetchone() is not None:
                raise SetupDone
            row = con.execute("SELECT id FROM user WHERE lower(username) = ?", (username.lower(),)).fetchone()
            if row is None:
                cur = con.execute(
                    "INSERT INTO user (username, display_name, created_at, password_hash, local_admin) VALUES (?, ?, ?, ?, 1)",
                    (username, display_name, int(time.time()), password_hash),
                )
                user_id = cur.lastrowid
            else:
                user_id = row["id"]
                con.execute("UPDATE user SET password_hash = ?, local_admin = 1, disabled = 0, display_name = ? WHERE id = ?",
                            (password_hash, display_name, user_id))
        return {"id": user_id, "username": username, "display_name": display_name}

    def create_local_user(self, username: str, display_name: str, password_hash: str, admin: bool) -> dict:
        if is_reserved_name(username):
            raise ReservedName(username)
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            if con.execute("SELECT 1 FROM user WHERE lower(username) = ?", (username.lower(),)).fetchone() is not None:
                raise NameTaken
            cur = con.execute(
                "INSERT INTO user (username, display_name, created_at, password_hash, local_admin) VALUES (?, ?, ?, ?, ?)",
                (username, display_name, int(time.time()), password_hash, int(admin)),
            )
        return {"id": cur.lastrowid, "username": username, "display_name": display_name}

    def set_password(self, user_id: int, password_hash: str) -> None:
        with self._connect() as con:
            con.execute("UPDATE user SET password_hash = ? WHERE id = ?", (password_hash, user_id))

    def change_account(self, user_id: int, disabled: bool | None = None, admin: bool | None = None) -> None:
        """Block or unblock, give or take the admin right. The last active admin can be neither blocked nor demoted.
        Blocking also ends the user's sessions."""
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT disabled, local_admin, password_hash FROM user WHERE id = ?", (user_id,)).fetchone()
            now_active = bool(row["local_admin"]) and not row["disabled"] and row["password_hash"] is not None
            new_disabled = bool(row["disabled"]) if disabled is None else disabled
            new_admin = bool(row["local_admin"]) if admin is None else admin
            if now_active and (new_disabled or not new_admin) and self._active_admins(con, besides=user_id) == 0:
                raise LastAdmin
            con.execute("UPDATE user SET disabled = ?, local_admin = ? WHERE id = ?", (int(new_disabled), int(new_admin), user_id))
            if new_disabled:
                con.execute("DELETE FROM auth_session WHERE user_id = ?", (user_id,))

    def revoke_user_tokens(self, user_id: int) -> None:
        with self._connect() as con:
            con.execute("UPDATE access_token SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (int(time.time()), user_id))

    def has_users(self) -> bool:
        with self._connect() as con:
            return con.execute("SELECT 1 FROM user").fetchone() is not None

    def create_session(self, user_id: int, token_hash: str, now: int, ttl: int) -> None:
        with self._connect() as con:
            con.execute("DELETE FROM auth_session WHERE expires_at <= ?", (now,))  # clean up while signing in
            con.execute(
                "INSERT INTO auth_session (user_id, hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)",
                (user_id, token_hash, now, now + ttl, now),
            )

    def find_session(self, token_hash: str, now: int, ttl: int, max_age: int, every: int = 60, require_password: bool = True, oidc_issuer: str | None = None) -> dict | None:
        """The user of a live session of an unblocked account, or None. The session slides: `last_seen` and the expiry are
        written at most once per `every` seconds (`renewed` says that this happened), but never beyond `max_age` seconds
        after the session was created. Accounts of the local mode need a password (`require_password`); those of the oidc
        mode have none, their sign-in is the provider's: there (`oidc_issuer`) a session counts only for a user who has an identity
        at that issuer, so sessions left over from another mode or another provider are worth nothing."""
        with self._connect() as con:
            row = con.execute(
                "SELECT s.id AS session_id, s.last_seen, s.created_at, u.id, u.username, u.display_name, u.local_admin FROM auth_session s "
                "JOIN user u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ? AND s.created_at > ? AND u.disabled = 0 "
                "AND u.username <> '~demo' "  # the demo account never signs in (RESERVED_USERNAME)
                "AND (? = 0 OR u.password_hash IS NOT NULL) "
                "AND (? IS NULL OR EXISTS (SELECT 1 FROM oidc_identity i WHERE i.user_id = u.id AND i.issuer = ?))",
                (token_hash, now, now - max_age, int(require_password), oidc_issuer, oidc_issuer),
            ).fetchone()
            if row is None:
                return None
            renewed = row["last_seen"] <= now - every
            if renewed:
                con.execute("UPDATE auth_session SET last_seen = ?, expires_at = ? WHERE id = ?", (now, min(now + ttl, row["created_at"] + max_age), row["session_id"]))
        return {"id": row["id"], "username": row["username"], "display_name": row["display_name"],
                "local_admin": bool(row["local_admin"]), "renewed": renewed}

    def oidc_sign_in(self, issuer: str, sub: str, username: str, display_name: str, admin: bool, link_existing: bool) -> dict:
        """The user for a verified provider identity, created or linked on the first sign-in. Raises SignInRefused.

        Known (issuer, sub): the same user whatever the name is now; the display name and the admin right follow the
        provider's claims, the user name stays. New identity: a user of that name that already exists is taken over
        only when it has no identity at this issuer yet AND `link_existing` is on (code `exists` otherwise; `conflict`
        when the name belongs to another identity). Blocked users are refused and left untouched. One write lock."""
        if is_reserved_name(username):
            raise SignInRefused("name")
        now = int(time.time())
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute(
                "SELECT u.id, u.username, u.display_name, u.disabled FROM oidc_identity i JOIN user u ON u.id = i.user_id "
                "WHERE i.issuer = ? AND i.sub = ?", (issuer, sub),
            ).fetchone()
            if row is None:
                same_name = con.execute("SELECT id, username, display_name, disabled FROM user WHERE lower(username) = ?", (username.lower(),)).fetchone()
                if same_name is None:
                    cur = con.execute("INSERT INTO user (username, display_name, created_at) VALUES (?, ?, ?)", (username, display_name, now))
                    row = {"id": cur.lastrowid, "username": username, "display_name": display_name, "disabled": 0}
                else:
                    taken = con.execute("SELECT 1 FROM oidc_identity WHERE issuer = ? AND user_id = ?", (issuer, same_name["id"])).fetchone()
                    if taken is not None:
                        raise SignInRefused("conflict")
                    if not link_existing:
                        raise SignInRefused("exists")
                    row = same_name
                if row["disabled"]:
                    raise SignInRefused("blocked")
                con.execute("INSERT INTO oidc_identity (issuer, sub, user_id, created_at, last_login) VALUES (?, ?, ?, ?, ?)", (issuer, sub, row["id"], now, now))
                # sessions the user had before (another mode, another provider) must not come alive through the new link
                con.execute("DELETE FROM auth_session WHERE user_id = ?", (row["id"],))
            elif row["disabled"]:
                raise SignInRefused("blocked")
            else:
                con.execute("UPDATE oidc_identity SET last_login = ? WHERE issuer = ? AND sub = ?", (now, issuer, sub))
            con.execute("UPDATE user SET display_name = ?, local_admin = ? WHERE id = ?", (display_name, int(admin), row["id"]))
        return {"id": row["id"], "username": row["username"], "display_name": display_name, "is_admin": admin}

    def session_user_id(self, token_hash: str) -> int | None:
        with self._connect() as con:
            row = con.execute("SELECT user_id FROM auth_session WHERE hash = ?", (token_hash,)).fetchone()
        return row["user_id"] if row else None

    def delete_session(self, token_hash: str) -> None:
        with self._connect() as con:
            con.execute("DELETE FROM auth_session WHERE hash = ?", (token_hash,))

    def delete_user_sessions(self, user_id: int, keep_hash: str | None = None) -> None:
        with self._connect() as con:
            con.execute("DELETE FROM auth_session WHERE user_id = ? AND hash IS NOT ?", (user_id, keep_hash))

    # foods (shared by all users)

    @staticmethod
    def _food(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "code": row["code"],
            "source": row["source"],
            "found": bool(row["found"]),
            "data": json.loads(row["data"]) if row["data"] else None,
            "fetched_at": row["fetched_at"],
            "recipe_id": row["recipe_id"],
            "external_id": row["external_id"],
            "image_hash": row["image_hash"],
            "image_origin": row["image_origin"],
            "image_at": row["image_at"],
            "image_url": row["image_url"],
        }

    def get_food(self, food_id: int, demo_view: bool = False) -> dict | None:
        """One food, or None. The sample foods of the demo account do not exist for anybody else (`demo_view`: the caller is
        the demo account): they cannot be read, logged, put into a recipe, changed or deleted by id."""
        with self._connect() as con:
            row = con.execute(f"{FOOD_SELECT} WHERE food.id = ?", (food_id,)).fetchone()
        food = self._food(row) if row else None
        if food and not demo_view and (food["data"] or {}).get("demo_account"):
            return None
        return food

    def get_food_by_code(self, code: str) -> dict | None:
        with self._connect() as con:
            row = con.execute(f"{FOOD_SELECT} WHERE food.code = ?", (code,)).fetchone()
        return self._food(row) if row else None

    def list_foods(self, query: str = "", source: str | None = None, limit: int = 50, exclude: tuple[str, ...] = (),
                   demo_account: bool = False) -> list[dict]:
        """Known products, newest first. The search looks at name, brand and barcode; `exclude` leaves out sources.
        The foods of the demo account are listed only for the demo account itself (`demo_account`): the household's product list stays clean."""
        hide = "" if demo_account else f" AND NOT COALESCE({DEMO_ACCOUNT_FOOD}, 0)"
        with self._connect() as con:
            rows = con.execute(f"{FOOD_SELECT} WHERE food.found = 1{hide} ORDER BY food.fetched_at DESC, food.id DESC").fetchall()
        words = query.strip().lower().split()
        result = []
        for row in rows:
            food = self._food(row)
            data = food["data"]
            if source and food["source"] != source:
                continue
            if food["source"] in exclude:
                continue
            if data["name"] is None and all(v is None for v in data["per_100"].values()):
                continue  # empty shell: upstream knows the barcode but nothing else
            haystack = " ".join(filter(None, (food["code"], data.get("name"), data.get("brand")))).lower()
            if all(word in haystack for word in words):
                result.append(food)
            if len(result) >= limit:
                break
        return result

    def known_codes(self, codes: list[str]) -> set[str]:
        """Those of `codes` that exist as a known food (not merely as a remembered miss)."""
        if not codes:
            return set()
        marks = ", ".join("?" * len(codes))
        with self._connect() as con:
            rows = con.execute(f"SELECT code FROM food WHERE found = 1 AND code IN ({marks})", codes).fetchall()
        return {r["code"] for r in rows}

    def known_catalog(self, hits: list[dict]) -> set[tuple[str, str]]:
        """The (source, code) of those catalogue `hits` that exist as a food already: by barcode for packaged
        products, by `external_id` (`bls:<code>`) for basic foods."""
        packaged = self.known_codes([h["code"] for h in hits if h["source"] != "bls"])
        keys = [f"bls:{h['code']}" for h in hits if h["source"] == "bls"]
        marks = ", ".join("?" * len(keys))
        with self._connect() as con:
            rows = con.execute(f"SELECT external_id FROM food WHERE found = 1 AND external_id IN ({marks})", keys).fetchall() if keys else []
        return {("openfoodfacts", c) for c in packaged} | {("bls", r["external_id"][4:]) for r in rows}

    def get_food_by_external_id(self, external_id: str) -> dict | None:
        with self._connect() as con:
            row = con.execute(f"{FOOD_SELECT} WHERE food.external_id = ?", (external_id,)).fetchone()
        return self._food(row) if row else None

    def put_external_food(self, external_id: str, source: str, data: dict) -> tuple[int, int]:
        """Insert a food without barcode that is recognised by `external_id`. Returns (id, fetched_at)."""
        now = int(time.time())
        with self._connect() as con:
            food_id = con.execute(
                "INSERT INTO food (code, source, found, data, fetched_at, external_id) VALUES (NULL, ?, 1, ?, ?, ?)",
                (source, _json(data), now, external_id),
            ).lastrowid
        return food_id, now

    def put_food(self, code: str | None, source: str, data: dict | None) -> tuple[int, int]:
        """Insert or, for a known barcode, replace. Returns (id, fetched_at)."""
        now = int(time.time())
        args = (code, source, int(data is not None), _json(data) if data else None, now)
        with self._connect() as con:
            con.execute(
                "INSERT INTO food (code, source, found, data, fetched_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(code) DO UPDATE SET source = excluded.source, found = excluded.found, "
                "data = excluded.data, fetched_at = excluded.fetched_at, import_id = NULL",
                args,
            )
            row = con.execute("SELECT id FROM food WHERE code = ?", (code,)).fetchone() if code else None
            food_id = row["id"] if row else con.execute("SELECT last_insert_rowid()").fetchone()[0]
        return food_id, now

    def update_food(self, food_id: int, source: str, data: dict) -> int | None:
        now = int(time.time())
        with self._connect() as con:
            updated = con.execute(
                "UPDATE food SET source = ?, found = 1, data = ?, fetched_at = ?, import_id = NULL WHERE id = ?",
                (source, _json(data), now, food_id),
            ).rowcount
        return now if updated else None

    def delete_food(self, food_id: int) -> bool:
        """Diary entries, template and recipe items keep their copy and lose only the link."""
        with self._connect() as con:
            self._unlink_food(con, food_id)
            return con.execute("DELETE FROM food WHERE id = ?", (food_id,)).rowcount > 0

    @staticmethod
    def _unlink_food(con: sqlite3.Connection, food_id: int) -> None:
        for table in ("diary_entry", "template_item", "recipe_item"):
            con.execute(f"UPDATE {table} SET food_id = NULL WHERE food_id = ?", (food_id,))

    # pictures of recipes (the files are in imagestore.py; here is only the reference)

    def set_food_image(self, food_id: int, digest: str, origin: str, url: str | None) -> str | None | bool:
        """Link a picture to a food. Returns the hash it had before (None: none), or False for an unknown food."""
        with self._connect() as con:
            row = con.execute("SELECT image_hash FROM food WHERE id = ?", (food_id,)).fetchone()
            if row is None:
                return False
            con.execute("UPDATE food SET image_hash = ?, image_origin = ?, image_at = ?, image_url = ? WHERE id = ?",
                        (digest, origin, int(time.time()), url, food_id))
            return row["image_hash"]

    def clear_food_image(self, food_id: int, origin: str | None = None) -> str | None | bool:
        """Take the picture away. `origin` stays as the marker (`none` = taken away by a person: a reload does not bring it back).
        Returns the hash it had (None: none), or False for an unknown food."""
        with self._connect() as con:
            row = con.execute("SELECT image_hash FROM food WHERE id = ?", (food_id,)).fetchone()
            if row is None:
                return False
            con.execute("UPDATE food SET image_hash = NULL, image_origin = ?, image_at = ?, image_url = NULL WHERE id = ?",
                        (origin, int(time.time()) if origin else None, food_id))
            return row["image_hash"]

    def image_refs(self, digest: str) -> int:
        with self._connect() as con:
            return con.execute("SELECT count(*) FROM food WHERE image_hash = ?", (digest,)).fetchone()[0]

    def image_hashes(self) -> set[str]:
        with self._connect() as con:
            return {r[0] for r in con.execute("SELECT DISTINCT image_hash FROM food WHERE image_hash IS NOT NULL")}

    def foods_without_image(self, source: str, now: float | None = None, skip_failed_seconds: int = 7 * 86400) -> list[dict]:
        """Taken-over recipes of a source that have no picture yet and where nobody opted out (`none`) or set an own one; a recipe whose
        last try failed less than `skip_failed_seconds` ago is left out."""
        limit = int(now if now is not None else time.time()) - skip_failed_seconds
        with self._connect() as con:
            rows = con.execute(
                "SELECT id, external_id, image_url FROM food WHERE source = ? AND found = 1 AND image_hash IS NULL "
                "AND (image_origin IS NULL OR image_origin NOT IN ('own', 'none')) "
                "AND (image_origin IS NULL OR image_origin != 'failed' OR image_at <= ?) ORDER BY id", (source, limit)).fetchall()
        return [dict(r) for r in rows]

    # diary

    @staticmethod
    def _entry(row: sqlite3.Row) -> dict:
        return {**dict(row), "per_100": json.loads(row["per_100"]), "extra": json.loads(row["extra"] or "{}")}

    def add_entry(self, user_id: int, day: str, meal: str, food_id: int, amount: float, copy: dict) -> int:
        with self._connect() as con:
            cur = con.execute(
                "INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user_id, day, meal, food_id, amount, copy["unit"], copy["name"], copy["brand"],
                 _json(copy["per_100"]), _json(copy.get("extra") or {}), int(time.time())),
            )
            return cur.lastrowid

    def add_entries(self, user_id: int, day: str, items: list[dict]) -> list[int]:
        """Insert several entries in one transaction. Each item has meal, food_id, amount and the snapshot fields."""
        now = int(time.time())
        ids = []
        with self._connect() as con:
            for item in items:
                cur = con.execute(
                    "INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, "
                    "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (user_id, day, item["meal"], item["food_id"], item["amount"], item["unit"], item["name"],
                     item["brand"], _json(item["per_100"]), _json(item.get("extra") or {}), now),
                )
                ids.append(cur.lastrowid)
        return ids

    def entries_on(self, user_id: int, day: str, meal: str | None = None) -> list[dict]:
        with self._connect() as con:
            if meal is None:
                rows = con.execute(
                    "SELECT * FROM diary_entry WHERE user_id = ? AND day = ? ORDER BY id", (user_id, day)
                ).fetchall()
            else:
                rows = con.execute(
                    "SELECT * FROM diary_entry WHERE user_id = ? AND day = ? AND meal = ? ORDER BY id",
                    (user_id, day, meal),
                ).fetchall()
        return [self._entry(r) for r in rows]

    def get_entry(self, user_id: int, entry_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM diary_entry WHERE id = ? AND user_id = ?", (entry_id, user_id)).fetchone()
        return self._entry(row) if row else None

    def update_entry(self, user_id: int, entry_id: int, amount: float | None, meal: str | None) -> bool:
        with self._connect() as con:
            return con.execute(
                "UPDATE diary_entry SET amount = COALESCE(?, amount), meal = COALESCE(?, meal), import_id = NULL "
                "WHERE id = ? AND user_id = ?",
                (amount, meal, entry_id, user_id),
            ).rowcount > 0

    def delete_entry(self, user_id: int, entry_id: int) -> bool:
        with self._connect() as con:
            return con.execute("DELETE FROM diary_entry WHERE id = ? AND user_id = ?", (entry_id, user_id)).rowcount > 0

    def entries_between(self, user_id: int, first: str, last: str) -> list[dict]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT * FROM diary_entry WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id",
                (user_id, first, last),
            ).fetchall()
        return [self._entry(r) for r in rows]

    def logged_days_until(self, user_id: int, last: str) -> list[str]:
        """Days with at least one entry up to `last`, newest first."""
        with self._connect() as con:
            rows = con.execute(
                "SELECT DISTINCT day FROM diary_entry WHERE user_id = ? AND day <= ? ORDER BY day DESC", (user_id, last)
            ).fetchall()
        return [r["day"] for r in rows]

    def recent_foods(self, user_id: int, limit: int) -> list[dict]:
        """The latest entry of each food this user logged that still exists, newest first."""
        with self._connect() as con:
            rows = con.execute(
                "SELECT e.food_id, e.amount, e.meal FROM diary_entry e "
                "JOIN food f ON f.id = e.food_id AND f.found = 1 "
                "WHERE e.id IN (SELECT MAX(id) FROM diary_entry WHERE user_id = ? AND food_id IS NOT NULL GROUP BY food_id) "
                "ORDER BY e.id DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    # templates (per user)

    @staticmethod
    def _item(row: sqlite3.Row) -> dict:
        return {**dict(row), "per_100": json.loads(row["per_100"]), "extra": json.loads(row["extra"] or "{}")}

    def _template(self, con: sqlite3.Connection, row: sqlite3.Row) -> dict:
        items = con.execute("SELECT * FROM template_item WHERE template_id = ? ORDER BY id", (row["id"],)).fetchall()
        return {**dict(row), "items": [self._item(i) for i in items]}

    def create_template(self, user_id: int, name: str, items: list[dict]) -> int:
        with self._connect() as con:
            template_id = con.execute(
                "INSERT INTO template (user_id, name, created_at) VALUES (?, ?, ?)", (user_id, name, int(time.time()))
            ).lastrowid
            for item in items:
                con.execute(
                    "INSERT INTO template_item (template_id, food_id, amount, unit, name, brand, per_100, extra) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (template_id, item["food_id"], item["amount"], item["unit"], item["name"], item["brand"],
                     _json(item["per_100"]), _json(item.get("extra") or {})),
                )
        return template_id

    def get_template(self, user_id: int, template_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM template WHERE id = ? AND user_id = ?", (template_id, user_id)).fetchone()
            return self._template(con, row) if row else None

    def list_templates(self, user_id: int) -> list[dict]:
        """The user's templates, most recently created first."""
        with self._connect() as con:
            rows = con.execute("SELECT * FROM template WHERE user_id = ? ORDER BY id DESC", (user_id,)).fetchall()
            return [self._template(con, r) for r in rows]

    def rename_template(self, user_id: int, template_id: int, name: str) -> bool:
        with self._connect() as con:
            return con.execute(
                "UPDATE template SET name = ? WHERE id = ? AND user_id = ?", (name, template_id, user_id)
            ).rowcount > 0

    def delete_template(self, user_id: int, template_id: int) -> bool:
        with self._connect() as con:
            if con.execute("SELECT 1 FROM template WHERE id = ? AND user_id = ?", (template_id, user_id)).fetchone() is None:
                return False
            con.execute("DELETE FROM template_item WHERE template_id = ?", (template_id,))
            con.execute("DELETE FROM template WHERE id = ?", (template_id,))
            return True

    # recipes (shared by all users, like foods)

    def _recipe(self, con: sqlite3.Connection, row: sqlite3.Row) -> dict:
        items = con.execute("SELECT * FROM recipe_item WHERE recipe_id = ? ORDER BY position", (row["id"],)).fetchall()
        food = con.execute(f"{FOOD_SELECT} WHERE food.id = ?", (row["food_id"],)).fetchone()
        return {**dict(row), "food": self._food(food), "items": [self._item(i) for i in items]}

    def save_recipe(
        self, recipe_id: int | None, user_id: int, food_data: dict, portions: float, total_weight: float | None,
        items: list[dict],
    ) -> int | None:
        """Create a recipe with its calculated food, or (with `recipe_id`) replace both. None: unknown recipe."""
        now = int(time.time())
        with self._connect() as con:
            if recipe_id is None:
                food_id = con.execute(
                    "INSERT INTO food (code, source, found, data, fetched_at) VALUES (NULL, 'recipe', 1, ?, ?)",
                    (_json(food_data), now),
                ).lastrowid
                recipe_id = con.execute(
                    "INSERT INTO recipe (food_id, portions, total_weight, created_by, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (food_id, portions, total_weight, user_id, now),
                ).lastrowid
            else:
                row = con.execute("SELECT food_id FROM recipe WHERE id = ?", (recipe_id,)).fetchone()
                if row is None:
                    return None
                con.execute("UPDATE food SET data = ?, fetched_at = ? WHERE id = ?", (_json(food_data), now, row["food_id"]))
                con.execute(
                    "UPDATE recipe SET portions = ?, total_weight = ?, updated_at = ? WHERE id = ?",
                    (portions, total_weight, now, recipe_id),
                )
                con.execute("DELETE FROM recipe_item WHERE recipe_id = ?", (recipe_id,))
            for position, item in enumerate(items):
                con.execute(
                    "INSERT INTO recipe_item (recipe_id, position, food_id, amount, unit, name, brand, per_100, extra) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (recipe_id, position, item["food_id"], item["amount"], item["unit"], item["name"], item["brand"],
                     _json(item["per_100"]), _json(item.get("extra") or {})),
                )
        return recipe_id

    def get_recipe(self, recipe_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM recipe WHERE id = ?", (recipe_id,)).fetchone()
            return self._recipe(con, row) if row else None

    def list_recipes(self) -> list[dict]:
        """All recipes, most recently changed first."""
        with self._connect() as con:
            rows = con.execute("SELECT * FROM recipe ORDER BY updated_at DESC, id DESC").fetchall()
            return [self._recipe(con, r) for r in rows]

    def delete_recipe(self, recipe_id: int) -> bool:
        """Remove the recipe and its calculated food; diary entries and templates keep their copies."""
        with self._connect() as con:
            row = con.execute("SELECT food_id FROM recipe WHERE id = ?", (recipe_id,)).fetchone()
            if row is None:
                return False
            con.execute("DELETE FROM recipe_item WHERE recipe_id = ?", (recipe_id,))
            con.execute("DELETE FROM recipe WHERE id = ?", (recipe_id,))
            self._unlink_food(con, row["food_id"])
            con.execute("DELETE FROM food WHERE id = ?", (row["food_id"],))
            return True

    # groups of recipes (shared by all users; the members are food ids: own recipes and Cookidoo recipes alike)

    def list_groups(self) -> list[dict]:
        """All groups in their order, each with its member food ids."""
        with self._connect() as con:
            groups = [dict(r) for r in con.execute("SELECT * FROM recipe_group ORDER BY position, id")]
            members: dict[int, list[int]] = {}
            for row in con.execute("SELECT group_id, food_id FROM recipe_group_item ORDER BY food_id"):
                members.setdefault(row["group_id"], []).append(row["food_id"])
        for group in groups:
            group["food_ids"] = members.get(group["id"], [])
        return groups

    def get_group(self, group_id: int) -> dict | None:
        return next((g for g in self.list_groups() if g["id"] == group_id), None)

    def group_name_taken(self, name: str, except_id: int | None = None) -> bool:
        with self._connect() as con:
            row = con.execute(
                "SELECT 1 FROM recipe_group WHERE name = ? COLLATE NOCASE AND id IS NOT ?", (name, except_id)).fetchone()
        return row is not None

    @staticmethod
    def _new_group(con: sqlite3.Connection, name: str, user_id: int | None, source: str | None) -> int:
        position = con.execute("SELECT coalesce(max(position), 0) + 1 FROM recipe_group").fetchone()[0]
        return con.execute(
            "INSERT INTO recipe_group (name, position, source, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            (name, position, source, user_id, int(time.time())),
        ).lastrowid

    def create_group(self, name: str, user_id: int) -> dict:
        with self._connect() as con:
            group_id = self._new_group(con, name, user_id, None)
        return self.get_group(group_id)

    def rename_group(self, group_id: int, name: str) -> bool:
        with self._connect() as con:
            return con.execute("UPDATE recipe_group SET name = ? WHERE id = ?", (name, group_id)).rowcount > 0

    def delete_group(self, group_id: int) -> bool:
        """The group goes, its recipes stay. A group that was made from a Cookidoo collection is remembered as dismissed, so
        the next run does not bring it back unasked."""
        with self._connect() as con:
            row = con.execute("SELECT source FROM recipe_group WHERE id = ?", (group_id,)).fetchone()
            if row is None:
                return False
            if row["source"]:
                con.execute("INSERT OR IGNORE INTO recipe_group_dismissed (source) VALUES (?)", (row["source"],))
            con.execute("DELETE FROM recipe_group WHERE id = ?", (group_id,))
            return True

    def reorder_groups(self, ids: list[int]) -> bool:
        """Put the groups in this order; False unless `ids` lists every group exactly once."""
        with self._connect() as con:
            known = {r["id"] for r in con.execute("SELECT id FROM recipe_group")}
            if len(ids) != len(set(ids)) or set(ids) != known:
                return False
            for position, group_id in enumerate(ids, start=1):
                con.execute("UPDATE recipe_group SET position = ? WHERE id = ?", (position, group_id))
        return True

    def recipe_foods(self, group: str | None = None) -> list[dict]:
        """Every recipe (own, Cookidoo, web) as {id, source, data}, in ONE query; `group` is a group id as text, or `none` for the
        recipes that are in no group. For the suggestions: no N+1, no ingredient rows."""
        sql = "SELECT id, source, data FROM food WHERE found = 1 AND source IN ('recipe', 'cookidoo', 'web')"
        args: tuple = ()
        if group == "none":
            sql += " AND id NOT IN (SELECT food_id FROM recipe_group_item)"
        elif group is not None:
            sql += " AND id IN (SELECT food_id FROM recipe_group_item WHERE group_id = ?)"
            args = (int(group),)
        with self._connect() as con:
            rows = con.execute(sql + " ORDER BY id", args).fetchall()
        return [{"id": r["id"], "source": r["source"], "data": json.loads(r["data"]) if r["data"] else {}} for r in rows]

    def last_eaten(self, user_id: int, last: str) -> dict[int, str]:
        """food id -> the latest day up to `last` on which this user logged it (one grouped query)."""
        with self._connect() as con:
            rows = con.execute(
                "SELECT food_id, MAX(day) AS day FROM diary_entry WHERE user_id = ? AND food_id IS NOT NULL AND day <= ? GROUP BY food_id",
                (user_id, last),
            ).fetchall()
        return {r["food_id"]: r["day"] for r in rows}

    def recipe_food_ids(self, food_ids: list[int]) -> set[int]:
        """Those of `food_ids` that are recipes (own, from Cookidoo or from a web page), so they may be members of a group."""
        if not food_ids:
            return set()
        marks = ", ".join("?" * len(food_ids))
        with self._connect() as con:
            rows = con.execute(
                f"SELECT id FROM food WHERE found = 1 AND source IN ('recipe', 'cookidoo', 'web') AND id IN ({marks})", list(food_ids)).fetchall()
        return {r["id"] for r in rows}

    def add_to_group(self, group_id: int, food_ids: list[int]) -> int:
        """Add recipes (food ids) to a group; returns how many were new members. The caller checked the ids."""
        with self._connect() as con:
            before = con.total_changes
            con.executemany("INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)", [(group_id, f) for f in food_ids])
            return con.total_changes - before

    def remove_from_group(self, group_id: int, food_ids: list[int]) -> int:
        with self._connect() as con:
            before = con.total_changes
            con.executemany("DELETE FROM recipe_group_item WHERE group_id = ? AND food_id = ?", [(group_id, f) for f in food_ids])
            return con.total_changes - before

    def set_food_groups(self, food_id: int, group_ids: list[int]) -> None:
        """The groups this recipe belongs to, exactly these. The caller checked the ids."""
        with self._connect() as con:
            con.execute("DELETE FROM recipe_group_item WHERE food_id = ?", (food_id,))
            con.executemany("INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)", [(g, food_id) for g in group_ids])

    def source_group(self, source: str, name: str, user_id: int | None) -> tuple[int | None, bool]:
        """(group id, created) of the group that belongs to `source` (`cookidoo:<collection id>`): the existing one, a new one
        named like the collection (made distinct when the name is taken), or (None, False) when the household deleted it."""
        with self._connect() as con:
            row = con.execute("SELECT id FROM recipe_group WHERE source = ?", (source,)).fetchone()
            if row is not None:
                return row["id"], False
            if con.execute("SELECT 1 FROM recipe_group_dismissed WHERE source = ?", (source,)).fetchone():
                return None, False
            base = (name.strip() or "Cookidoo")[:60]
            taken = {r[0].lower() for r in con.execute("SELECT name FROM recipe_group")}
            candidate, n = base, 1
            while candidate.lower() in taken:
                n += 1
                candidate = f"{base} ({'Cookidoo' if n == 2 else n})"[:70]
            return self._new_group(con, candidate, user_id, source), True

    def source_dismissed(self, source: str) -> bool:
        with self._connect() as con:
            return con.execute("SELECT 1 FROM recipe_group_dismissed WHERE source = ?", (source,)).fetchone() is not None

    def undismiss_source(self, source: str) -> None:
        with self._connect() as con:
            con.execute("DELETE FROM recipe_group_dismissed WHERE source = ?", (source,))

    # weights

    def weights_between(self, user_id: int, first: str, last: str) -> list[dict]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT day, kg FROM weight WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day",
                (user_id, first, last),
            ).fetchall()
        return [dict(r) for r in rows]

    def put_weight(self, user_id: int, day: str, kg: float) -> None:
        with self._connect() as con:
            con.execute(
                "INSERT INTO weight (user_id, day, kg) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id, day) DO UPDATE SET kg = excluded.kg, demo = 0, health = 0, import_id = NULL",
                (user_id, day, kg),
            )

    def delete_weight(self, user_id: int, day: str) -> bool:
        with self._connect() as con:
            return con.execute("DELETE FROM weight WHERE user_id = ? AND day = ?", (user_id, day)).rowcount > 0

    # water (one total per user and day)

    def get_water(self, user_id: int, day: str) -> int:
        with self._connect() as con:
            row = con.execute("SELECT ml FROM water WHERE user_id = ? AND day = ?", (user_id, day)).fetchone()
        return row["ml"] if row else 0

    def water_between(self, user_id: int, first: str, last: str) -> dict[str, int]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT day, ml FROM water WHERE user_id = ? AND day BETWEEN ? AND ?", (user_id, first, last)
            ).fetchall()
        return {r["day"]: r["ml"] for r in rows}

    def add_water(self, user_id: int, day: str, delta: int) -> int:
        """Add (or subtract) ml; the total stays between 0 and MAX_WATER_ML. Returns the new total."""
        with self._connect() as con:
            con.execute(
                "INSERT INTO water (user_id, day, ml) VALUES (?1, ?2, MAX(0, MIN(?4, ?3))) "
                "ON CONFLICT(user_id, day) DO UPDATE SET ml = MAX(0, MIN(?4, ml + ?3)), demo = 0, health = 0, import_id = NULL",
                (user_id, day, delta, MAX_WATER_ML),
            )
            return con.execute("SELECT ml FROM water WHERE user_id = ? AND day = ?", (user_id, day)).fetchone()["ml"]

    def put_water(self, user_id: int, day: str, ml: int) -> int:
        with self._connect() as con:
            con.execute(
                "INSERT INTO water (user_id, day, ml) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id, day) DO UPDATE SET ml = excluded.ml, demo = 0, health = 0, import_id = NULL",
                (user_id, day, ml),
            )
        return ml

    # fasting (see routes/fasting.py)

    def current_fast(self, user_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM fast WHERE user_id = ? AND ended_at IS NULL", (user_id,)).fetchone()
        return dict(row) if row else None

    def get_fast(self, user_id: int, fast_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM fast WHERE id = ? AND user_id = ?", (fast_id, user_id)).fetchone()
        return dict(row) if row else None

    def recent_fasts(self, user_id: int, limit: int) -> list[dict]:
        """The latest finished fasts, newest first."""
        with self._connect() as con:
            rows = con.execute(
                "SELECT * FROM fast WHERE user_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def start_fast(self, user_id: int, started_at: int, target_hours: float) -> int | None:
        """Open a fast. None when one is already open for this user."""
        with self._connect() as con:
            try:
                return con.execute(
                    "INSERT INTO fast (user_id, started_at, target_hours) VALUES (?, ?, ?)",
                    (user_id, started_at, target_hours),
                ).lastrowid
            except sqlite3.IntegrityError:
                return None

    def update_fast(self, user_id: int, fast_id: int, changes: dict) -> bool:
        """Set the given columns (started_at, ended_at, target_hours) of one fast."""
        if not changes:
            return False
        columns = ", ".join(f"{key} = ?" for key in changes)
        with self._connect() as con:
            try:
                return con.execute(
                    f"UPDATE fast SET {columns} WHERE id = ? AND user_id = ?", (*changes.values(), fast_id, user_id)
                ).rowcount > 0
            except sqlite3.IntegrityError:
                return False

    def delete_fast(self, user_id: int, fast_id: int) -> bool:
        with self._connect() as con:
            return con.execute("DELETE FROM fast WHERE id = ? AND user_id = ?", (fast_id, user_id)).rowcount > 0

    # activity (see activity.py and routes/activity.py)

    @staticmethod
    def _workout(row: sqlite3.Row) -> dict:
        return dict(row)

    def activity_between(self, user_id: int, first: str, last: str) -> dict[str, dict]:
        """The activity rows of the range by day."""
        with self._connect() as con:
            rows = con.execute(
                "SELECT day, steps, active_kcal, distance_m, source FROM activity_day "
                "WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day", (user_id, first, last),
            ).fetchall()
        return {r["day"]: dict(r) for r in rows}

    def activity_bonus_rows(self, user_id: int) -> dict[str, dict]:
        """Every activity row of the user (for the badges, which look at all days)."""
        return self.activity_between(user_id, "0000-01-01", "9999-12-31")

    def put_activity(self, user_id: int, day: str, changes: dict) -> dict | None:
        """Set the given values of a day (None clears one), by hand: the row becomes `manual` and loses its import.
        A row that ends up without any value is deleted. Returns the row, or None when nothing is left."""
        with self._connect() as con:
            row = con.execute(
                "SELECT steps, active_kcal, distance_m FROM activity_day WHERE user_id = ? AND day = ?", (user_id, day)
            ).fetchone()
            merged = {**(dict(row) if row else dict.fromkeys(("steps", "active_kcal", "distance_m"))), **changes}
            if all(v is None for v in merged.values()):
                con.execute("DELETE FROM activity_day WHERE user_id = ? AND day = ?", (user_id, day))
                return None
            con.execute(
                "INSERT INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, import_id, demo) "
                "VALUES (:user_id, :day, :steps, :active_kcal, :distance_m, 'manual', NULL, 0) "
                "ON CONFLICT(user_id, day) DO UPDATE SET steps = excluded.steps, active_kcal = excluded.active_kcal, "
                "distance_m = excluded.distance_m, source = 'manual', import_id = NULL, demo = 0",
                {"user_id": user_id, "day": day, **merged},
            )
            return {**merged, "source": "manual"}

    def workouts_between(self, user_id: int, first: str, last: str) -> list[dict]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT * FROM workout WHERE user_id = ? AND day BETWEEN ? AND ? "
                "ORDER BY day, COALESCE(started_at, 0), id", (user_id, first, last),
            ).fetchall()
        return [self._workout(r) for r in rows]

    def get_workout(self, user_id: int, workout_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM workout WHERE id = ? AND user_id = ?", (workout_id, user_id)).fetchone()
        return self._workout(row) if row else None

    def add_workout(self, user_id: int, w: dict) -> int:
        """Insert a workout typed in by the user (`w`: day, kind, name, minutes, kcal, distance_m, steps, started_at, note)."""
        with self._connect() as con:
            return con.execute(
                "INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, note, "
                "source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)",
                (user_id, w["day"], w.get("started_at"), w["kind"], w.get("name") or "", w["minutes"], w.get("kcal"),
                 w.get("distance_m"), w.get("steps"), w.get("note"), int(time.time())),
            ).lastrowid

    def update_workout(self, user_id: int, workout_id: int, changes: dict) -> bool:
        """Change columns of one workout; a change by hand makes it `manual` and takes it out of its import batch
        (the external id stays, so a later sync or import does not add it again)."""
        if not changes:
            return self.get_workout(user_id, workout_id) is not None
        columns = ", ".join(f"{key} = ?" for key in changes)
        with self._connect() as con:
            return con.execute(
                f"UPDATE workout SET {columns}, source = 'manual', import_id = NULL, demo = 0 "
                "WHERE id = ? AND user_id = ?", (*changes.values(), workout_id, user_id),
            ).rowcount > 0

    def delete_workout(self, user_id: int, workout_id: int) -> bool:
        with self._connect() as con:
            return con.execute("DELETE FROM workout WHERE id = ? AND user_id = ?", (workout_id, user_id)).rowcount > 0

    def weight_for(self, user_id: int, day: str) -> float | None:
        """The body weight to estimate with: the latest value up to `day`, else the latest of all, else None."""
        with self._connect() as con:
            row = con.execute(
                "SELECT kg FROM weight WHERE user_id = ? AND day <= ? ORDER BY day DESC LIMIT 1", (user_id, day)
            ).fetchone() or con.execute(
                "SELECT kg FROM weight WHERE user_id = ? ORDER BY day DESC LIMIT 1", (user_id,)
            ).fetchone()
        return row["kg"] if row else None

    def health_sync(self, user_id: int, days: list[dict], overwrite_manual: bool = False) -> dict:
        """Apply the days of a `POST /health/sync` in ONE transaction. Idempotent: the same call twice changes nothing.

        Each day is {day, steps, active_kcal, distance_m, weight_kg, water_ml, workouts[]} (values may be None). Rules:
        daily activity values are written with source `health` and overwrite earlier health, Yazio and demo values, but
        not a `manual` row (unless `overwrite_manual`); weight and water only where there is none yet or the existing
        one came from here or is demo data; workouts are recognised by `external_id`, a manual one is left alone.
        Returns the counters per kind (new, updated, unchanged, skipped) and what changed, for the webhooks.
        """
        kinds = ("activity", "workouts", "weights", "water")
        counts = {k: {"new": 0, "updated": 0, "unchanged": 0, "skipped": 0} for k in kinds}
        changed = {"activity": [], "workouts": []}
        now = int(time.time())
        with self._connect() as con:
            for item in days:
                day = item["day"]
                given = {k: item[k] for k in ("steps", "active_kcal", "distance_m") if item.get(k) is not None}
                if given:
                    row = con.execute(
                        "SELECT steps, active_kcal, distance_m, source FROM activity_day WHERE user_id = ? AND day = ?",
                        (user_id, day)).fetchone()
                    if row is None:
                        con.execute(
                            "INSERT INTO activity_day (user_id, day, steps, active_kcal, distance_m, source) "
                            "VALUES (?, ?, ?, ?, ?, 'health')",
                            (user_id, day, given.get("steps"), given.get("active_kcal"), given.get("distance_m")))
                        counts["activity"]["new"] += 1
                        changed["activity"].append(day)
                    elif row["source"] == "manual" and not overwrite_manual:
                        counts["activity"]["skipped"] += 1
                    else:
                        merged = {**dict(row), **given}
                        if row["source"] == "health" and all(merged[k] == row[k] for k in given):
                            counts["activity"]["unchanged"] += 1
                        else:
                            con.execute(
                                "UPDATE activity_day SET steps = ?, active_kcal = ?, distance_m = ?, source = 'health', "
                                "import_id = NULL, demo = 0 WHERE user_id = ? AND day = ?",
                                (merged["steps"], merged["active_kcal"], merged["distance_m"], user_id, day))
                            counts["activity"]["updated"] += 1
                            changed["activity"].append(day)
                for table, column, key, kind in (("weight", "kg", "weight_kg", "weights"), ("water", "ml", "water_ml", "water")):
                    value = item.get(key)
                    if value is None:
                        continue
                    row = con.execute(
                        f"SELECT {column} AS v, health, demo FROM {table} WHERE user_id = ? AND day = ?", (user_id, day)
                    ).fetchone()
                    if row is None:
                        con.execute(f"INSERT INTO {table} (user_id, day, {column}, health) VALUES (?, ?, ?, 1)", (user_id, day, value))
                        counts[kind]["new"] += 1
                    elif not (row["health"] or row["demo"]):
                        counts[kind]["skipped"] += 1
                    elif row["health"] and row["v"] == value:
                        counts[kind]["unchanged"] += 1
                    else:
                        con.execute(
                            f"UPDATE {table} SET {column} = ?, health = 1, demo = 0 WHERE user_id = ? AND day = ?",
                            (value, user_id, day))
                        counts[kind]["updated"] += 1
                for w in item.get("workouts") or []:
                    row = con.execute(
                        "SELECT * FROM workout WHERE user_id = ? AND external_id = ?", (user_id, w["external_id"])).fetchone()
                    fields = {"day": day, "started_at": w.get("started_at"), "kind": w["kind"], "name": w.get("name") or "",
                              "minutes": w["minutes"], "kcal": w.get("kcal"), "distance_m": w.get("distance_m")}
                    if row is None:
                        cur = con.execute(
                            "INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, source, "
                            "external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'health', ?, ?)",
                            (user_id, day, fields["started_at"], fields["kind"], fields["name"], fields["minutes"],
                             fields["kcal"], fields["distance_m"], w["external_id"], now))
                        counts["workouts"]["new"] += 1
                        changed["workouts"].append(cur.lastrowid)
                    elif row["source"] == "manual" and not overwrite_manual:
                        counts["workouts"]["skipped"] += 1
                    elif row["source"] == "health" and all(row[k] == v for k, v in fields.items()):
                        counts["workouts"]["unchanged"] += 1
                    else:
                        con.execute(
                            "UPDATE workout SET day = ?, started_at = ?, kind = ?, name = ?, minutes = ?, kcal = ?, "
                            "distance_m = ?, source = 'health', import_id = NULL, demo = 0 WHERE id = ?",
                            (*fields.values(), row["id"]))
                        counts["workouts"]["updated"] += 1
        return {"counts": counts, "changed": changed}

    # demo data (see demo.py)

    def demo_counts(self, user_id: int) -> dict:
        with self._connect() as con:
            entries = con.execute("SELECT count(*) FROM diary_entry WHERE user_id = ? AND demo = 1", (user_id,)).fetchone()[0]
            weights = con.execute("SELECT count(*) FROM weight WHERE user_id = ? AND demo = 1", (user_id,)).fetchone()[0]
            water = con.execute("SELECT count(*) FROM water WHERE user_id = ? AND demo = 1", (user_id,)).fetchone()[0]
            activity = con.execute("SELECT count(*) FROM activity_day WHERE user_id = ? AND demo = 1", (user_id,)).fetchone()[0]
            workouts = con.execute("SELECT count(*) FROM workout WHERE user_id = ? AND demo = 1", (user_id,)).fetchone()[0]
        return {"entries": entries, "weights": weights, "water": water, "activity": activity, "workouts": workouts}

    def activity_days(self, user_id: int, first: str, last: str) -> tuple[set[str], set[str]]:
        """Days in the range that have an activity row, and days that have a workout."""
        with self._connect() as con:
            a = con.execute("SELECT day FROM activity_day WHERE user_id = ? AND day BETWEEN ? AND ?", (user_id, first, last))
            w = con.execute("SELECT DISTINCT day FROM workout WHERE user_id = ? AND day BETWEEN ? AND ?", (user_id, first, last))
            return {r["day"] for r in a}, {r["day"] for r in w}

    def diary_days(self, user_id: int, first: str, last: str) -> tuple[set[str], set[str]]:
        """Days in the range with real entries and days with demo entries."""
        with self._connect() as con:
            rows = con.execute(
                "SELECT DISTINCT day, demo FROM diary_entry WHERE user_id = ? AND day BETWEEN ? AND ?",
                (user_id, first, last),
            ).fetchall()
        return {r["day"] for r in rows if not r["demo"]}, {r["day"] for r in rows if r["demo"]}

    def weight_days(self, user_id: int, first: str, last: str) -> set[str]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT day FROM weight WHERE user_id = ? AND day BETWEEN ? AND ?", (user_id, first, last)
            ).fetchall()
        return {r["day"] for r in rows}

    def water_days(self, user_id: int, first: str, last: str) -> set[str]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT day FROM water WHERE user_id = ? AND day BETWEEN ? AND ?", (user_id, first, last)
            ).fetchall()
        return {r["day"] for r in rows}

    def add_demo(
        self, user_id: int, foods: dict[str, dict], entries: list[dict], weights: list[dict],
        water: list[dict] | None = None, activity: list[dict] | None = None, workouts: list[dict] | None = None,
        marker: str = "demo",
    ) -> dict:
        """Insert demo entries and weights in one transaction.

        `foods` maps a name to the food data; a demo food of that name is reused, otherwise created.
        Each entry is {day, meal, food, amount}. Returns the number of new rows. `marker` says which kind of demo food
        is meant: "demo" (test data in the own account) or "demo_account" (the built-in demo account).
        """
        where = FOOD_MARKERS[marker]
        now = int(time.time())
        ids: dict[str, int] = {}
        created = 0
        with self._connect() as con:
            known = {
                json.loads(r["data"])["name"]: r["id"]
                for r in con.execute(f"SELECT id, data FROM food WHERE {where}")
            }
            for name in {e["food"] for e in entries}:
                if name in known:
                    ids[name] = known[name]
                    continue
                cur = con.execute(
                    "INSERT INTO food (code, source, found, data, fetched_at) VALUES (NULL, 'own', 1, ?, ?)",
                    (_json({**foods[name], marker: True}), now),
                )
                ids[name] = cur.lastrowid
                created += 1
            for e in entries:
                data = foods[e["food"]]
                con.execute(
                    "INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, "
                    "created_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)",
                    (user_id, e["day"], e["meal"], ids[e["food"]], e["amount"], data["unit"], data["name"],
                     _json(data["per_100"]), _json(data.get("extra") or {}), now),
                )
            for w in weights:
                con.execute(
                    "INSERT OR IGNORE INTO weight (user_id, day, kg, demo) VALUES (?, ?, ?, 1)",
                    (user_id, w["day"], w["kg"]),
                )
            for w in water or []:
                con.execute(
                    "INSERT OR IGNORE INTO water (user_id, day, ml, demo) VALUES (?, ?, ?, 1)",
                    (user_id, w["day"], w["ml"]),
                )
            for a in activity or []:
                con.execute(
                    "INSERT OR IGNORE INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, demo) "
                    "VALUES (?, ?, ?, ?, ?, 'demo', 1)", (user_id, a["day"], a["steps"], a["active_kcal"], a["distance_m"]))
            for w in workouts or []:
                con.execute(
                    "INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, source, "
                    "demo, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'demo', 1, ?)",
                    (user_id, w["day"], w["started_at"], w["kind"], w["minutes"], w["kcal"], w["distance_m"], w["steps"], now))
        return {"entries": len(entries), "weights": len(weights), "foods": created, "water": len(water or []),
                "activity": len(activity or []), "workouts": len(workouts or [])}

    def remove_demo(self, user_id: int) -> dict:
        """Delete this user's demo rows, then demo foods no diary entry of anyone refers to any more."""
        with self._connect() as con:
            entries = con.execute("DELETE FROM diary_entry WHERE user_id = ? AND demo = 1", (user_id,)).rowcount
            weights = con.execute("DELETE FROM weight WHERE user_id = ? AND demo = 1", (user_id,)).rowcount
            water = con.execute("DELETE FROM water WHERE user_id = ? AND demo = 1", (user_id,)).rowcount
            activity = con.execute("DELETE FROM activity_day WHERE user_id = ? AND demo = 1", (user_id,)).rowcount
            workouts = con.execute("DELETE FROM workout WHERE user_id = ? AND demo = 1", (user_id,)).rowcount
            doomed = [
                r["id"]
                for r in con.execute(
                    f"SELECT id FROM food WHERE {DEMO_FOOD} AND id NOT IN (SELECT food_id FROM diary_entry WHERE food_id IS NOT NULL)"
                )
            ]
            for food_id in doomed:
                self._unlink_food(con, food_id)
                con.execute("DELETE FROM food WHERE id = ?", (food_id,))
            foods = len(doomed)
            con.execute("DELETE FROM badge_earned WHERE user_id = ? AND demo = 1", (user_id,))
        return {"entries": entries, "weights": weights, "foods": foods, "water": water, "activity": activity,
                "workouts": workouts}

    # the built-in demo account (see demo_account.py)

    # every table with a `user_id` column; a test compares this list with the schema so that a new table cannot be forgotten
    USER_TABLES = ("diary_entry", "goal", "weight", "template", "user_setting", "badge_earned", "water", "fast", "import_batch",
                   "access_token", "webhook", "activity_day", "workout", "auth_session", "oidc_identity", "secret")

    def demo_account_id(self) -> int | None:
        """The id of the demo account (the setting points at the user row with the reserved name), or None. Also while it is
        deleted: the row stays."""
        value = self.get_global(DEMO_ACCOUNT_SETTING)
        if not isinstance(value, int) or isinstance(value, bool):
            return None
        with self._connect() as con:
            row = con.execute("SELECT id FROM user WHERE id = ? AND username = ?", (value, RESERVED_USERNAME)).fetchone()
        return row["id"] if row else None

    def demo_account_ready(self) -> int | None:
        """The id of the demo account when it exists and is not deleted, else None (a request in the demo view needs this)."""
        user_id = self.demo_account_id()
        return None if user_id is None or self.get_global(DEMO_DELETED_SETTING, False) else user_id

    def create_demo_user(self) -> tuple[int, bool]:
        """The demo account's user id and whether it was made (or made again after a delete) now. Refuses (NameTaken) when a row
        of the reserved name exists that the marker does not point to (only a hand-made database). The check, the insert and
        the marker are one write. A deleted account is made again in the same row, emptied once more first (a request that was
        still running when it was deleted may have written into it since)."""
        revived = False
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT id FROM user WHERE username = ?", (RESERVED_USERNAME,)).fetchone()
            marker = con.execute("SELECT value FROM setting WHERE key = ?", (DEMO_ACCOUNT_SETTING,)).fetchone()
            deleted = con.execute("SELECT value FROM setting WHERE key = ?", (DEMO_DELETED_SETTING,)).fetchone()
            if row is not None:
                if marker is None or json.loads(marker["value"]) != row["id"]:
                    raise NameTaken(RESERVED_USERNAME)
                if deleted is None or not json.loads(deleted["value"]):
                    return row["id"], False
                revived = True
                user_id = row["id"]
            else:
                cur = con.execute("INSERT INTO user (username, display_name, created_at) VALUES (?, 'Demo', ?)", (RESERVED_USERNAME, int(time.time())))
                user_id = cur.lastrowid
                con.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            (DEMO_ACCOUNT_SETTING, _json(user_id)))
        if revived:
            self.erase_user_data(user_id)
            self.set_global(DEMO_DELETED_SETTING, False)
        return user_id, True

    def demo_name_taken(self) -> bool:
        """A row of the reserved name exists that is not the demo account (only a hand-made database): it is never taken over."""
        with self._connect() as con:
            row = con.execute("SELECT id FROM user WHERE username = ?", (RESERVED_USERNAME,)).fetchone()
        return row is not None and row["id"] != self.demo_account_id()

    def erase_user_data(self, user_id: int, deactivate: bool = False) -> None:
        """Everything of one user: diary, weights, water, goals, settings, templates, ... Only for the demo account.
        ALL sample foods of the demo account go too (nobody else can refer to them; a leftover reference is cut loose), shared
        recipes, products and groups of the household are never touched. With `deactivate` the account is marked deleted: the
        user row stays (see RESERVED_USERNAME) and the demo view ends for everybody. The flag is set FIRST so that no new demo
        request starts; one that is already running may still write a row afterwards, which the next switch-on removes."""
        if deactivate:
            self.set_global(DEMO_DELETED_SETTING, True)
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("DELETE FROM template_item WHERE template_id IN (SELECT id FROM template WHERE user_id = ?)", (user_id,))
            con.execute("DELETE FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE user_id = ?)", (user_id,))
            for table in self.USER_TABLES:
                con.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
            for table in ("recipe", "recipe_group"):  # nothing there can be the demo account's, but a dangling pointer is not left behind
                con.execute(f"UPDATE {table} SET created_by = NULL WHERE created_by = ?", (user_id,))
            for row in con.execute(f"SELECT id FROM food WHERE {DEMO_ACCOUNT_FOOD}").fetchall():
                self._unlink_food(con, row["id"])
                con.execute("DELETE FROM food WHERE id = ?", (row["id"],))

    def demo_account_summary(self, user_id: int) -> dict:
        """What the demo account holds now: diary entries and the first and last day with one."""
        with self._connect() as con:
            row = con.execute("SELECT count(*) AS n, min(day) AS first, max(day) AS last FROM diary_entry WHERE user_id = ?", (user_id,)).fetchone()
        return {"entries": row["n"], "first_day": row["first"], "last_day": row["last"]}

    # imports (see yazio.py)

    def find_user(self, username: str) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT id, username, display_name FROM user WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None

    def usernames(self) -> list[str]:
        with self._connect() as con:
            return [r["username"] for r in con.execute("SELECT username FROM user ORDER BY username")]

    @staticmethod
    def _batch(row: sqlite3.Row) -> dict:
        return {**dict(row), "counts": json.loads(row["counts"] or "{}")}

    def list_imports(self, user_id: int | None = None) -> list[dict]:
        """Import batches, newest first; of one user or (without `user_id`) of everyone, with the user name."""
        sql = "SELECT b.*, u.username FROM import_batch b JOIN user u ON u.id = b.user_id"
        with self._connect() as con:
            if user_id is None:
                rows = con.execute(f"{sql} ORDER BY b.id DESC").fetchall()
            else:
                rows = con.execute(f"{sql} WHERE b.user_id = ? ORDER BY b.id DESC", (user_id,)).fetchall()
        return [self._batch(r) for r in rows]

    def import_yazio(self, user_id: int, plan: dict, dry_run: bool = False) -> dict:
        """Write a prepared Yazio import in ONE transaction; any error leaves the database as it was.

        `plan` has `entries` (each: kind product|recipe|quick, external_id, day, meal, food_key|None, amount, unit,
        name, brand, per_100, extra), `foods` ({key: {code, data}}), `all_products`, `weights` [{day, kg}],
        `water` [{day, ml}], `activity` [{day, steps, active_kcal, distance_m}], `workouts` (each: external_id, day,
        started_at, kind, name, minutes, kcal, distance_m, steps, note) and `goal`. Entries and workouts whose external
        id the user already has are left out, so a second run only adds what is new (activity of an earlier export, for
        instance, as a batch of its own). A food is
        taken from an earlier import (same key) or from an existing food with the same barcode, and created
        otherwise; an existing food is never changed. Weight, water and goal are only set where the user has none.
        With `dry_run` everything is done and rolled back, so the counts are exact.
        """
        now = int(time.time())
        with self._connect() as con:
            taken = {
                r[0] for r in con.execute(
                    "SELECT external_id FROM diary_entry WHERE user_id = ? AND external_id IS NOT NULL", (user_id,))
            }
            entries, already = [], 0
            for entry in plan["entries"]:
                if entry["external_id"] in taken:
                    already += 1
                    continue
                taken.add(entry["external_id"])
                entries.append(entry)
            batch_id = con.execute(
                "INSERT INTO import_batch (user_id, kind, created_at) VALUES (?, 'yazio', ?)", (user_id, now)
            ).lastrowid

            needed = list(dict.fromkeys(
                [e["food_key"] for e in entries if e["food_key"]] + (list(plan["foods"]) if plan["all_products"] else [])
            ))
            ids, created, reused = self._import_foods(con, plan["foods"], needed, batch_id, now)
            con.executemany(
                "INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, "
                "created_at, external_id, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (user_id, e["day"], e["meal"], ids.get(e["food_key"]), e["amount"], e["unit"], e["name"],
                     e["brand"], _json(e["per_100"]), _json(e["extra"]), now, e["external_id"], batch_id)
                    for e in entries
                ],
            )
            weights = water = 0
            for w in plan["weights"]:
                weights += con.execute(
                    "INSERT OR IGNORE INTO weight (user_id, day, kg, demo, import_id) VALUES (?, ?, ?, 0, ?)",
                    (user_id, w["day"], w["kg"], batch_id),
                ).rowcount
            for w in plan["water"]:
                water += con.execute(
                    "INSERT OR IGNORE INTO water (user_id, day, ml, demo, import_id) VALUES (?, ?, ?, 0, ?)",
                    (user_id, w["day"], w["ml"], batch_id),
                ).rowcount
            goal = 0
            if plan["goal"]:
                goal = con.execute(
                    "INSERT OR IGNORE INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps, import_id) "
                    "VALUES (:user_id, :kcal, :protein, :carbs, :fat, :water_ml, :steps, :batch)",
                    {"steps": None, **plan["goal"], "user_id": user_id, "batch": batch_id},
                ).rowcount
            activity = 0
            for a in plan.get("activity", []):
                activity += con.execute(
                    "INSERT OR IGNORE INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, import_id) "
                    "VALUES (?, ?, ?, ?, ?, 'yazio', ?)",
                    (user_id, a["day"], a["steps"], a["active_kcal"], a["distance_m"], batch_id),
                ).rowcount
            known_workouts = {
                r[0] for r in con.execute("SELECT external_id FROM workout WHERE user_id = ? AND external_id IS NOT NULL", (user_id,))
            }
            workouts, workouts_already = [], 0
            for w in plan.get("workouts", []):
                if w["external_id"] in known_workouts:
                    workouts_already += 1
                    continue
                known_workouts.add(w["external_id"])
                workouts.append(w)
            con.executemany(
                "INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, note, source, "
                "external_id, import_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yazio', ?, ?, ?)",
                [(user_id, w["day"], w["started_at"], w["kind"], w["name"], w["minutes"], w["kcal"], w["distance_m"],
                  w["steps"], w["note"], w["external_id"], batch_id, now) for w in workouts],
            )
            kinds = [e["kind"] for e in entries]
            counts = {
                "days": len({e["day"] for e in entries}), "entries": len(entries),
                "product_entries": kinds.count("product"), "recipe_entries": kinds.count("recipe"),
                "quick_entries": kinds.count("quick"), "foods": created, "weights": weights, "water": water,
                "goal_set": bool(goal), "activity_days": activity, "workouts": len(workouts),
            }
            if not (entries or created or weights or water or goal or activity or workouts):
                con.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
                batch_id = None
            else:
                con.execute("UPDATE import_batch SET counts = ? WHERE id = ?", (_json(counts), batch_id))
            if dry_run:
                con.rollback()
                batch_id = None
        return {**counts, "foods_reused": reused, "already_imported": already, "batch_id": batch_id,
                "activity_kept": len(plan.get("activity", [])) - activity, "workouts_already": workouts_already}

    @staticmethod
    def _import_foods(con: sqlite3.Connection, specs: dict, needed: list[str], batch_id: int, now: int):
        """Food ids for the keys in `needed`: (ids, created, reused)."""
        known = {r["external_id"]: r["id"] for r in con.execute("SELECT id, external_id FROM food WHERE external_id IS NOT NULL")}
        codes = [specs[k]["code"] for k in needed if k not in known and specs[k]["code"]]
        by_code: dict[str, tuple[int, bool]] = {}
        for start in range(0, len(codes), 500):
            chunk = codes[start:start + 500]
            for r in con.execute(f"SELECT id, code, found FROM food WHERE code IN ({', '.join('?' * len(chunk))})", chunk):
                by_code[r["code"]] = (r["id"], bool(r["found"]))
        ids: dict[str, int] = {}
        created = reused = 0
        for key in needed:
            if key in known:
                ids[key] = known[key]
                reused += 1
                continue
            code = specs[key]["code"]
            hit = by_code.get(code) if code else None
            if hit and hit[1]:
                ids[key] = hit[0]  # an existing food stays as it is
                reused += 1
                continue
            data = _json(specs[key]["data"])
            if hit:  # the barcode is only a remembered miss: the row becomes this food
                con.execute(
                    "UPDATE food SET source = 'yazio', found = 1, data = ?, fetched_at = ?, external_id = ?, import_id = ? "
                    "WHERE id = ?", (data, now, key, batch_id, hit[0]))
                ids[key] = hit[0]
            else:
                ids[key] = con.execute(
                    "INSERT INTO food (code, source, found, data, fetched_at, external_id, import_id) "
                    "VALUES (?, 'yazio', 1, ?, ?, ?, ?)", (code, data, now, key, batch_id)).lastrowid
            if code:
                by_code[code] = (ids[key], True)
            created += 1
        return ids, created, reused

    def remove_import(self, batch_id: int, user_id: int | None = None) -> dict | None:
        """Take back one batch: its entries, weights, water, activity days, workouts and goal that are still untouched, and the foods it
        created that nothing refers to any more (no diary entry of any user, no template, no recipe). None when the
        batch does not exist (or, with `user_id`, belongs to someone else)."""
        with self._connect() as con:
            row = con.execute("SELECT * FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
            if row is None or (user_id is not None and row["user_id"] != user_id):
                return None
            entries = con.execute("DELETE FROM diary_entry WHERE import_id = ?", (batch_id,)).rowcount
            weights = con.execute("DELETE FROM weight WHERE import_id = ?", (batch_id,)).rowcount
            water = con.execute("DELETE FROM water WHERE import_id = ?", (batch_id,)).rowcount
            goal = con.execute("DELETE FROM goal WHERE import_id = ?", (batch_id,)).rowcount
            activity = con.execute("DELETE FROM activity_day WHERE import_id = ?", (batch_id,)).rowcount
            workouts = con.execute("DELETE FROM workout WHERE import_id = ?", (batch_id,)).rowcount
            doomed = [
                r["id"] for r in con.execute(
                    "SELECT id FROM food WHERE import_id = ? "
                    "AND id NOT IN (SELECT food_id FROM diary_entry WHERE food_id IS NOT NULL) "
                    "AND id NOT IN (SELECT food_id FROM template_item WHERE food_id IS NOT NULL) "
                    "AND id NOT IN (SELECT food_id FROM recipe_item WHERE food_id IS NOT NULL)", (batch_id,))
            ]
            con.executemany("DELETE FROM food WHERE id = ?", [(i,) for i in doomed])
            con.execute("UPDATE food SET import_id = NULL WHERE import_id = ?", (batch_id,))
            con.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
        return {"entries": entries, "weights": weights, "water": water, "foods": len(doomed), "goal": bool(goal),
                "activity": activity, "workouts": workouts}

    # settings and badges (see badges.py)

    def get_settings(self, user_id: int) -> dict:
        with self._connect() as con:
            rows = con.execute("SELECT key, value FROM user_setting WHERE user_id = ?", (user_id,)).fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    def set_setting(self, user_id: int, key: str, value) -> None:
        with self._connect() as con:
            con.execute(
                "INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                (user_id, key, _json(value)),
            )

    def own_name(self, user_id: int) -> str | None:
        """The display name the user chose themself (setting `display_name`), or None."""
        with self._connect() as con:
            row = con.execute("SELECT value FROM user_setting WHERE user_id = ? AND key = 'display_name'", (user_id,)).fetchone()
        return json.loads(row["value"]) if row else None

    def set_own_name(self, user_id: int, name: str | None) -> None:
        """Choose the display name; None goes back to the provider's name (or the user name)."""
        if name is None:
            with self._connect() as con:
                con.execute("DELETE FROM user_setting WHERE user_id = ? AND key = 'display_name'", (user_id,))
        else:
            self.set_setting(user_id, "display_name", name)

    def badge_inputs(self, user_id: int) -> tuple[list[dict], list[dict], int]:
        """Everything the badges look at: all entries and weights (with their demo flag) and the recipe count."""
        with self._connect() as con:
            entries = con.execute(
                "SELECT day, meal, food_id, name, brand, amount, per_100, demo FROM diary_entry WHERE user_id = ?",
                (user_id,),
            ).fetchall()
            weights = con.execute("SELECT day, demo FROM weight WHERE user_id = ?", (user_id,)).fetchall()
            recipes = con.execute("SELECT count(*) FROM recipe WHERE created_by = ?", (user_id,)).fetchone()[0]
        return (
            [{**dict(r), "per_100": json.loads(r["per_100"])} for r in entries],
            [dict(r) for r in weights],
            recipes,
        )

    def badges_earned(self, user_id: int) -> list[dict]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT code, earned_at, seen, demo FROM badge_earned WHERE user_id = ? ORDER BY earned_at, code",
                (user_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def record_badges(self, user_id: int, reached: set[str], by_real_data: set[str]) -> None:
        """Remember newly reached badges. A badge that real data alone does not reach is marked as demo-only;
        once real data reaches it too, the mark goes away."""
        now = int(time.time())
        with self._connect() as con:
            known = {r["code"]: r["demo"] for r in con.execute(
                "SELECT code, demo FROM badge_earned WHERE user_id = ?", (user_id,))}
            for code in sorted(reached):
                if code not in known:
                    con.execute(
                        "INSERT INTO badge_earned (user_id, code, earned_at, seen, demo) VALUES (?, ?, ?, 0, ?)",
                        (user_id, code, now, int(code not in by_real_data)),
                    )
                elif known[code] and code in by_real_data:
                    con.execute("UPDATE badge_earned SET demo = 0 WHERE user_id = ? AND code = ?", (user_id, code))

    def mark_badges_seen(self, user_id: int, codes: list[str]) -> None:
        if not codes:
            return
        marks = ", ".join("?" * len(codes))
        with self._connect() as con:
            con.execute(f"UPDATE badge_earned SET seen = 1 WHERE user_id = ? AND code IN ({marks})", (user_id, *codes))

    # access tokens (see auth.py)

    @staticmethod
    def _token(row: sqlite3.Row) -> dict:
        return {k: row[k] for k in ("id", "name", "prefix", "scope", "created_at", "expires_at", "last_used_at", "revoked_at")}

    def create_token(self, user_id: int, name: str, prefix: str, token_hash: str, scope: str, expires_at: int | None) -> dict:
        with self._connect() as con:
            cur = con.execute(
                "INSERT INTO access_token (user_id, name, prefix, hash, scope, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, name, prefix, token_hash, scope, int(time.time()), expires_at),
            )
            return self._token(con.execute("SELECT * FROM access_token WHERE id = ?", (cur.lastrowid,)).fetchone())

    def list_tokens(self, user_id: int) -> list[dict]:
        with self._connect() as con:
            rows = con.execute("SELECT * FROM access_token WHERE user_id = ? ORDER BY id DESC", (user_id,)).fetchall()
        return [self._token(r) for r in rows]

    def revoke_token(self, user_id: int, token_id: int) -> bool:
        """Revoke a token of this user. Revoking twice is fine; an unknown id is not."""
        with self._connect() as con:
            con.execute(
                "UPDATE access_token SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
                (int(time.time()), token_id, user_id),
            )
            return con.execute("SELECT 1 FROM access_token WHERE id = ? AND user_id = ?", (token_id, user_id)).fetchone() is not None

    def find_token(self, token_hash: str, require_password: bool = False) -> dict | None:
        """The usable token with this hash and its user, or None (unknown, revoked, expired, user blocked; in local mode
        also a user without a password)."""
        now = int(time.time())
        with self._connect() as con:
            row = con.execute(
                "SELECT t.id AS token_id, t.scope, u.id, u.username, u.display_name FROM access_token t "
                "JOIN user u ON u.id = t.user_id WHERE t.hash = ? AND t.revoked_at IS NULL AND u.disabled = 0 "
                "AND u.username <> '~demo' "  # the demo account has no keys (RESERVED_USERNAME)
                "AND (t.expires_at IS NULL OR t.expires_at > ?) AND (? = 0 OR u.password_hash IS NOT NULL)",
                (token_hash, now, int(require_password)),
            ).fetchone()
        return dict(row) if row else None

    def touch_token(self, token_id: int, every: int = 60) -> None:
        """Remember that the token was used, at most once per `every` seconds."""
        now = int(time.time())
        with self._connect() as con:
            con.execute(
                "UPDATE access_token SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)",
                (now, token_id, now - every),
            )

    def count_active_tokens(self) -> int:
        with self._connect() as con:
            return con.execute(
                "SELECT count(*) FROM access_token WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
                (int(time.time()),),
            ).fetchone()[0]

    # webhooks (see webhooks.py)

    @staticmethod
    def _hook(row: sqlite3.Row, secret: bool = False) -> dict:
        hook = {
            "id": row["id"], "name": row["name"], "url": row["url"], "events": json.loads(row["events"]),
            "enabled": bool(row["enabled"]), "created_at": row["created_at"],
        }
        if secret:
            hook["secret"] = row["secret"]
        return hook

    def create_webhook(self, user_id: int, name: str, url: str, secret: str, events: list[str]) -> dict:
        with self._connect() as con:
            cur = con.execute(
                "INSERT INTO webhook (user_id, name, url, secret, events, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
                (user_id, name, url, secret, _json(events), int(time.time())),
            )
            return self._hook(con.execute("SELECT * FROM webhook WHERE id = ?", (cur.lastrowid,)).fetchone())

    def list_webhooks(self, user_id: int) -> list[dict]:
        with self._connect() as con:
            rows = con.execute("SELECT * FROM webhook WHERE user_id = ? ORDER BY id", (user_id,)).fetchall()
        return [self._hook(r) for r in rows]

    def get_webhook(self, user_id: int, hook_id: int, secret: bool = False) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT * FROM webhook WHERE id = ? AND user_id = ?", (hook_id, user_id)).fetchone()
        return self._hook(row, secret) if row else None

    def webhook_by_id(self, hook_id: int) -> dict | None:
        """A hook with its secret, whoever owns it (for the sender only)."""
        with self._connect() as con:
            row = con.execute("SELECT * FROM webhook WHERE id = ?", (hook_id,)).fetchone()
        return self._hook(row, True) if row else None

    def hooks_for_event(self, user_id: int, event: str) -> list[dict]:
        """The user's enabled hooks that listen to `event`, with their secret (for the sender only)."""
        with self._connect() as con:
            rows = con.execute("SELECT * FROM webhook WHERE user_id = ? AND enabled = 1 ORDER BY id", (user_id,)).fetchall()
        return [h for h in (self._hook(r, True) for r in rows) if event in h["events"]]

    def update_webhook(self, user_id: int, hook_id: int, changes: dict) -> bool:
        columns = {"name": "name", "url": "url", "events": "events", "enabled": "enabled"}
        sets, values = [], []
        for key, value in changes.items():
            sets.append(f"{columns[key]} = ?")
            values.append(_json(value) if key == "events" else int(value) if key == "enabled" else value)
        if not sets:
            return self.get_webhook(user_id, hook_id) is not None
        with self._connect() as con:
            return con.execute(
                f"UPDATE webhook SET {', '.join(sets)} WHERE id = ? AND user_id = ?", (*values, hook_id, user_id)
            ).rowcount > 0

    def delete_webhook(self, user_id: int, hook_id: int) -> bool:
        with self._connect() as con:
            con.execute(
                "DELETE FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE id = ? AND user_id = ?)",
                (hook_id, user_id),
            )
            return con.execute("DELETE FROM webhook WHERE id = ? AND user_id = ?", (hook_id, user_id)).rowcount > 0

    def start_delivery(self, hook_id: int, event: str) -> int:
        with self._connect() as con:
            return con.execute(
                "INSERT INTO webhook_delivery (webhook_id, event, attempts, created_at) VALUES (?, ?, 0, ?)",
                (hook_id, event, int(time.time())),
            ).lastrowid

    def update_delivery(self, delivery_id: int, attempts: int, status_code: int | None, error: str | None, finished: bool) -> None:
        with self._connect() as con:
            con.execute(
                "UPDATE webhook_delivery SET attempts = ?, status_code = ?, error = ?, finished_at = ? WHERE id = ?",
                (attempts, status_code, error, int(time.time()) if finished else None, delivery_id),
            )

    def prune_deliveries(self, hook_id: int, keep: int = 20) -> None:
        with self._connect() as con:
            con.execute(
                "DELETE FROM webhook_delivery WHERE webhook_id = ? AND id NOT IN "
                "(SELECT id FROM webhook_delivery WHERE webhook_id = ? ORDER BY id DESC LIMIT ?)",
                (hook_id, hook_id, keep),
            )

    def list_deliveries(self, hook_id: int) -> list[dict]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT id, event, status_code, error, attempts, created_at, finished_at FROM webhook_delivery "
                "WHERE webhook_id = ? ORDER BY id DESC",
                (hook_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    # global settings (the admin area)

    def get_global(self, key: str, default=None):
        with self._connect() as con:
            row = con.execute("SELECT value FROM setting WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def secret_key(self, name: str) -> bytes:
        """A 32-byte random key kept in the database, made at the first call (two callers at once get the same one). Used to
        sign the pending-sign-in cookie of the oidc mode. Never shown anywhere; the table `setting` is not listed by any
        endpoint (only keys the admin area knows are read)."""
        key = "secret." + name
        with self._connect() as con:
            con.execute("INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)", (key, _json(secrets.token_hex(32))))
            row = con.execute("SELECT value FROM setting WHERE key = ?", (key,)).fetchone()
        return bytes.fromhex(json.loads(row["value"]))

    # stored secrets (see vault.py; the values are encrypted before they get here)

    def put_secret(self, user_id: int, name: str, blob: bytes) -> None:
        with self._connect() as con:
            con.execute(
                "INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
                (user_id, name, blob, int(time.time())),
            )

    def get_secret(self, user_id: int, name: str) -> bytes | None:
        with self._connect() as con:
            row = con.execute("SELECT blob FROM secret WHERE user_id = ? AND name = ?", (user_id, name)).fetchone()
        return bytes(row["blob"]) if row else None

    def has_secret(self, user_id: int, name: str) -> bool:
        with self._connect() as con:
            return con.execute("SELECT 1 FROM secret WHERE user_id = ? AND name = ?", (user_id, name)).fetchone() is not None

    def delete_secret(self, user_id: int, name: str) -> None:
        with self._connect() as con:
            con.execute("DELETE FROM secret WHERE user_id = ? AND name = ?", (user_id, name))

    def vault_salt(self) -> bytes:
        """The random salt (16 bytes) that stretches MAHLWERK_SECRET_KEY, made at first use and kept in the database."""
        with self._connect() as con:
            con.execute("INSERT OR IGNORE INTO setting (key, value) VALUES ('secret.vault_salt', ?)", (_json(secrets.token_hex(16)),))
            row = con.execute("SELECT value FROM setting WHERE key = 'secret.vault_salt'").fetchone()
        return bytes.fromhex(json.loads(row["value"]))

    def set_global(self, key: str, value) -> None:
        with self._connect() as con:
            con.execute(
                "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, _json(value)),
            )

    # reads for the compact summary and the admin overview

    def latest_weight(self, user_id: int) -> dict | None:
        with self._connect() as con:
            row = con.execute(
                "SELECT day, kg FROM weight WHERE user_id = ? ORDER BY day DESC LIMIT 1", (user_id,)
            ).fetchone()
        return dict(row) if row else None

    def last_entry_at(self, user_id: int) -> int | None:
        with self._connect() as con:
            return con.execute("SELECT max(created_at) FROM diary_entry WHERE user_id = ?", (user_id,)).fetchone()[0]

    def schema_version(self) -> int:
        with self._connect() as con:
            return con.execute("PRAGMA user_version").fetchone()[0]

    def admin_counts(self) -> dict:
        with self._connect() as con:
            return {
                # the demo account is no user of this server and its invented entries and foods are no data of it: left out
                "users": con.execute("SELECT count(*) FROM user WHERE username <> ?", (RESERVED_USERNAME,)).fetchone()[0],
                "entries": con.execute(
                    "SELECT count(*) FROM diary_entry WHERE user_id NOT IN (SELECT id FROM user WHERE username = ?)", (RESERVED_USERNAME,)).fetchone()[0],
                "foods": con.execute(f"SELECT count(*) FROM food WHERE found = 1 AND NOT COALESCE({DEMO_ACCOUNT_FOOD}, 0)").fetchone()[0],
                "webhooks": con.execute("SELECT count(*) FROM webhook").fetchone()[0],
                "import_batches": con.execute("SELECT count(*) FROM import_batch").fetchone()[0],
            }

    def admin_users(self) -> list[dict]:
        """One row per user with counts only: never diary content, weights or goals."""
        now = int(time.time())
        with self._connect() as con:
            rows = con.execute(
                "SELECT u.username, u.display_name, u.created_at, u.disabled, u.local_admin AS admin, "
                "(u.password_hash IS NOT NULL) AS has_password, "
                "(u.username = '~demo') AS demo, "
                "(SELECT json_extract(value, '$') FROM user_setting s WHERE s.user_id = u.id AND s.key = 'display_name') AS own_name, "
                "EXISTS (SELECT 1 FROM oidc_identity i WHERE i.user_id = u.id) AS sso, "
                "(SELECT count(*) FROM diary_entry e WHERE e.user_id = u.id) AS entries, "
                "(SELECT min(day) FROM diary_entry e WHERE e.user_id = u.id) AS first_day, "
                "(SELECT max(day) FROM diary_entry e WHERE e.user_id = u.id) AS last_day, "
                "(SELECT count(*) FROM access_token t WHERE t.user_id = u.id AND t.revoked_at IS NULL "
                "   AND (t.expires_at IS NULL OR t.expires_at > ?)) AS tokens, "
                "(SELECT count(*) FROM webhook w WHERE w.user_id = u.id) AS webhooks "
                "FROM user u ORDER BY u.username",
                (now,),
            ).fetchall()
        return [dict(r) for r in rows]

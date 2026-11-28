CREATE TABLE user (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
, password_hash TEXT, disabled INTEGER NOT NULL DEFAULT 0, local_admin INTEGER NOT NULL DEFAULT 0, household INTEGER NOT NULL DEFAULT 1);
CREATE TABLE food (
    id          INTEGER PRIMARY KEY,
    code        TEXT UNIQUE,
    source      TEXT NOT NULL,
    found       INTEGER NOT NULL,
    data        TEXT,
    fetched_at  INTEGER NOT NULL
, external_id TEXT, import_id INTEGER, image_hash TEXT, image_origin TEXT, image_at INTEGER, image_url TEXT, piece_label TEXT, piece_grams REAL, created_by INTEGER REFERENCES user(id), drink INTEGER, uid TEXT);
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
, external_id TEXT, import_id INTEGER, uid TEXT);
CREATE TABLE goal (
    user_id  INTEGER PRIMARY KEY REFERENCES user(id),
    kcal     INTEGER NOT NULL,
    protein  REAL NOT NULL,
    carbs    REAL NOT NULL,
    fat      REAL NOT NULL
, water_ml INTEGER, import_id INTEGER, steps INTEGER, alt_days INTEGER NOT NULL DEFAULT 0, alt_kcal REAL, alt_protein REAL, alt_carbs REAL, alt_fat REAL);
CREATE TABLE weight (
    user_id  INTEGER NOT NULL REFERENCES user(id),
    day      TEXT NOT NULL,
    kg       REAL NOT NULL,
    demo     INTEGER NOT NULL DEFAULT 0, import_id INTEGER, health INTEGER NOT NULL DEFAULT 0, body_fat_pct REAL, lean_kg REAL, body_fat_health INTEGER NOT NULL DEFAULT 0, lean_health INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
CREATE TABLE template (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
, uid TEXT);
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
CREATE TABLE recipe (
    id            INTEGER PRIMARY KEY,
    food_id       INTEGER NOT NULL UNIQUE REFERENCES food(id),
    portions      REAL NOT NULL CHECK (portions > 0),
    total_weight  REAL,
    created_by    INTEGER REFERENCES user(id),
    updated_at    INTEGER NOT NULL
, uid TEXT);
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
CREATE TABLE water (
    user_id  INTEGER NOT NULL REFERENCES user(id),
    day      TEXT NOT NULL,
    ml       INTEGER NOT NULL,
    demo     INTEGER NOT NULL DEFAULT 0, import_id INTEGER, health INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
CREATE TABLE fast (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES user(id),
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    target_hours  REAL NOT NULL
, uid TEXT);
CREATE TABLE import_batch (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    counts      TEXT NOT NULL DEFAULT '{}'
);
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
CREATE TABLE setting (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
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
, uid TEXT);
CREATE TABLE auth_session (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES user(id),
    hash        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);
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
CREATE TABLE secret (
    user_id     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    blob        BLOB NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
);
CREATE TABLE recipe_group (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL,
    source      TEXT,
    created_by  INTEGER,
    created_at  INTEGER NOT NULL
, uid TEXT);
CREATE TABLE recipe_group_item (
    group_id  INTEGER NOT NULL,
    food_id   INTEGER NOT NULL,
    PRIMARY KEY (group_id, food_id)
);
CREATE TABLE recipe_group_dismissed (source TEXT PRIMARY KEY);
CREATE TABLE goal_history (
    user_id     INTEGER NOT NULL REFERENCES user(id),
    valid_from  TEXT NOT NULL,
    kcal        INTEGER NOT NULL,
    protein     REAL NOT NULL,
    carbs       REAL NOT NULL,
    fat         REAL NOT NULL,
    water_ml    INTEGER,
    steps       INTEGER,
    changed_at  INTEGER, alt_days INTEGER NOT NULL DEFAULT 0, alt_kcal REAL, alt_protein REAL, alt_carbs REAL, alt_fat REAL,
    PRIMARY KEY (user_id, valid_from)
);
CREATE TABLE sleep_day (
    user_id  INTEGER NOT NULL REFERENCES user(id),
    day      TEXT NOT NULL,
    minutes  INTEGER NOT NULL,
    source   TEXT NOT NULL CHECK (source IN ('manual', 'health', 'demo')),
    demo     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
CREATE INDEX diary_entry_day ON diary_entry (user_id, day);
CREATE INDEX diary_entry_food ON diary_entry (user_id, food_id);
CREATE INDEX template_user ON template (user_id);
CREATE INDEX template_item_template ON template_item (template_id);
CREATE INDEX recipe_item_recipe ON recipe_item (recipe_id, position);
CREATE INDEX fast_user ON fast (user_id, started_at);
CREATE UNIQUE INDEX fast_open ON fast (user_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX diary_entry_external ON diary_entry (user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX diary_entry_import ON diary_entry (import_id) WHERE import_id IS NOT NULL;
CREATE UNIQUE INDEX food_external ON food (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX import_batch_user ON import_batch (user_id);
CREATE INDEX access_token_user ON access_token (user_id);
CREATE INDEX webhook_user ON webhook (user_id);
CREATE INDEX webhook_delivery_hook ON webhook_delivery (webhook_id, id);
CREATE INDEX activity_day_import ON activity_day (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX workout_day ON workout (user_id, day);
CREATE UNIQUE INDEX workout_external ON workout (user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX workout_import ON workout (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX auth_session_user ON auth_session (user_id);
CREATE UNIQUE INDEX recipe_group_source ON recipe_group (source) WHERE source IS NOT NULL;
CREATE INDEX recipe_group_item_food ON recipe_group_item (food_id);
CREATE INDEX food_image_hash ON food (image_hash) WHERE image_hash IS NOT NULL;
CREATE UNIQUE INDEX diary_entry_uid ON diary_entry (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX workout_uid ON workout (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX fast_uid ON fast (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX template_uid ON template (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX recipe_uid ON recipe (uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX recipe_group_uid ON recipe_group (uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX food_uid ON food (uid) WHERE uid IS NOT NULL;
CREATE TRIGGER recipe_group_item_food_gone AFTER DELETE ON food BEGIN
    DELETE FROM recipe_group_item WHERE food_id = OLD.id;
END;
CREATE TRIGGER recipe_group_item_group_gone AFTER DELETE ON recipe_group BEGIN
    DELETE FROM recipe_group_item WHERE group_id = OLD.id;
END;
CREATE TRIGGER diary_entry_uid_new AFTER INSERT ON diary_entry WHEN NEW.uid IS NULL BEGIN
    UPDATE diary_entry SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER workout_uid_new AFTER INSERT ON workout WHEN NEW.uid IS NULL BEGIN
    UPDATE workout SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER fast_uid_new AFTER INSERT ON fast WHEN NEW.uid IS NULL BEGIN
    UPDATE fast SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER template_uid_new AFTER INSERT ON template WHEN NEW.uid IS NULL BEGIN
    UPDATE template SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER recipe_uid_new AFTER INSERT ON recipe WHEN NEW.uid IS NULL BEGIN
    UPDATE recipe SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER recipe_group_uid_new AFTER INSERT ON recipe_group WHEN NEW.uid IS NULL BEGIN
    UPDATE recipe_group SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER food_uid_new AFTER INSERT ON food WHEN NEW.uid IS NULL BEGIN
    UPDATE food SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;

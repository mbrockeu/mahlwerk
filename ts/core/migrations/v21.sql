ALTER TABLE diary_entry ADD COLUMN uid TEXT;
ALTER TABLE workout ADD COLUMN uid TEXT;
ALTER TABLE fast ADD COLUMN uid TEXT;
ALTER TABLE template ADD COLUMN uid TEXT;
ALTER TABLE recipe ADD COLUMN uid TEXT;
ALTER TABLE recipe_group ADD COLUMN uid TEXT;
ALTER TABLE food ADD COLUMN uid TEXT;
UPDATE diary_entry SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE workout SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE fast SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE template SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE recipe SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE recipe_group SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE food SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
CREATE UNIQUE INDEX diary_entry_uid ON diary_entry (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX workout_uid ON workout (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX fast_uid ON fast (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX template_uid ON template (user_id, uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX recipe_uid ON recipe (uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX recipe_group_uid ON recipe_group (uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX food_uid ON food (uid) WHERE uid IS NOT NULL;
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

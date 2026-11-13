"""Stored secrets: encryption at rest, the key (environment or key file), a missing or wrong key, binding to the row."""

import os
import sqlite3
import stat

import pytest

from conftest import DROP_V12
from mahlwerk.db import Store
from mahlwerk.vault import HOUSEHOLD, Vault, VaultError, mask_email

SECRET = {"email": "someone@example.invalid", "password": "hunter2-not-real-0042"}


@pytest.fixture
def vault(tmp_path):
    return Vault(Store(str(tmp_path / "v.db")))


def raw_bytes(vault) -> bytes:
    """Every byte the database holds on disk (the file and its write-ahead log)."""
    out = b""
    for suffix in ("", "-wal"):
        try:
            with open(vault.store.path + suffix, "rb") as handle:
                out += handle.read()
        except FileNotFoundError:
            pass
    return out


def test_round_trip_and_nothing_readable_on_disk(vault):
    vault.put(HOUSEHOLD, "cookidoo", SECRET)
    assert vault.get(HOUSEHOLD, "cookidoo") == SECRET
    assert vault.state(HOUSEHOLD, "cookidoo") == "stored"
    disk = raw_bytes(vault)
    assert b"hunter2" not in disk and b"someone@example" not in disk
    blob = vault.store.get_secret(HOUSEHOLD, "cookidoo")
    assert blob[:1] == b"\x01" and b"hunter2" not in blob


def test_each_value_gets_its_own_nonce(vault):
    vault.put(1, "a", SECRET)
    first = vault.store.get_secret(1, "a")
    vault.put(1, "a", SECRET)
    assert vault.store.get_secret(1, "a") != first  # same content, new nonce


def test_key_file_is_made_on_first_use_with_mode_0600(vault):
    assert not vault.key_path.exists() and vault.key_status() == "none"
    assert vault.get(HOUSEHOLD, "cookidoo") is None and not vault.key_path.exists()  # reading makes no key
    vault.put(HOUSEHOLD, "cookidoo", SECRET)
    assert vault.key_path.name == "v.db.key" and vault.key_status() == "file"
    assert stat.S_IMODE(os.stat(vault.key_path).st_mode) == 0o600
    assert len(bytes.fromhex(vault.key_path.read_text().strip())) == 32
    key = vault.key_path.read_text()
    vault.put(1, "x", SECRET)
    assert vault.key_path.read_text() == key  # the same key keeps serving
    assert not [p for p in vault.key_path.parent.iterdir() if p.name.endswith(".tmp")]


def test_an_existing_key_file_is_never_replaced(vault):
    vault.key_path.write_text("not a key\n")
    assert vault.key_status() == "invalid"
    with pytest.raises(VaultError) as exc:
        vault.put(1, "x", SECRET)
    assert exc.value.code == "invalid_key" and vault.key_path.read_text() == "not a key\n"
    assert vault.get(1, "x") is None


def test_environment_key_wins_over_the_file_and_is_used_without_a_file(vault, monkeypatch):
    monkeypatch.setenv("MAHLWERK_SECRET_KEY", "a long enough secret from the environment, yes")
    assert vault.key_status() == "env"
    vault.put(1, "x", SECRET)
    assert not vault.key_path.exists()
    assert vault.get(1, "x") == SECRET
    monkeypatch.setenv("MAHLWERK_SECRET_KEY", "a different long enough secret from elsewhere!!")
    assert vault.get(1, "x") is None and vault.state(1, "x") == "unreadable"
    monkeypatch.setenv("MAHLWERK_SECRET_KEY", "a long enough secret from the environment, yes")
    assert vault.get(1, "x") == SECRET


def test_too_short_environment_key_is_refused_without_falling_back(vault, monkeypatch):
    monkeypatch.setenv("MAHLWERK_SECRET_KEY", "x" * 31)
    assert vault.key_status() == "invalid"
    with pytest.raises(VaultError) as exc:
        vault.put(1, "x", SECRET)
    assert exc.value.code == "invalid_key" and not vault.key_path.exists()


def test_database_restored_without_the_key_file_means_unreadable_not_a_crash(vault):
    vault.put(HOUSEHOLD, "cookidoo", SECRET)
    vault.key_path.unlink()
    assert vault.get(HOUSEHOLD, "cookidoo") is None
    assert vault.state(HOUSEHOLD, "cookidoo") == "unreadable"
    assert not vault.key_path.exists()  # looking does not invent a key
    vault.put(HOUSEHOLD, "cookidoo", {"email": "new@example.invalid", "password": "x" * 12})  # entered again
    assert vault.state(HOUSEHOLD, "cookidoo") == "stored" and vault.get(HOUSEHOLD, "cookidoo")["email"] == "new@example.invalid"


def test_a_wrong_key_file_means_unreadable(vault):
    vault.put(1, "x", SECRET)
    vault.key_path.write_text("ab" * 32 + "\n")
    assert vault.get(1, "x") is None and vault.state(1, "x") == "unreadable"


def test_a_value_moved_to_another_row_does_not_decrypt(vault):
    vault.put(1, "cookidoo", SECRET)
    blob = vault.store.get_secret(1, "cookidoo")
    vault.store.put_secret(2, "cookidoo", blob)  # another user
    vault.store.put_secret(1, "other", blob)  # another name
    assert vault.get(2, "cookidoo") is None and vault.get(1, "other") is None
    assert vault.get(1, "cookidoo") == SECRET


def test_tampered_or_truncated_blobs_are_unreadable(vault):
    vault.put(1, "x", SECRET)
    blob = bytearray(vault.store.get_secret(1, "x"))
    blob[-1] ^= 1
    vault.store.put_secret(1, "x", bytes(blob))
    assert vault.get(1, "x") is None
    vault.store.put_secret(1, "x", b"\x01short")
    assert vault.get(1, "x") is None
    vault.store.put_secret(1, "x", b"\x02" + bytes(40))
    assert vault.get(1, "x") is None


def test_delete(vault):
    vault.put(1, "x", SECRET)
    vault.delete(1, "x")
    assert vault.state(1, "x") == "none" and vault.get(1, "x") is None


def test_mask_email():
    assert mask_email("someone@example.org") == "s***@example.org"
    assert mask_email("nonsense") == "***"


def test_version_11_database_gets_the_secret_table_without_losing_data(tmp_path):
    path = str(tmp_path / "v11.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V12)
    con.executescript(
        """
        INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'me', 'Me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        PRAGMA user_version = 11;
        """
    )
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert "secret" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    con.close()
    assert store.get_goal(1)["kcal"] == 2000
    Vault(store).put(1, "x", SECRET)
    assert Vault(store).get(1, "x") == SECRET


def test_settings_tables_never_hold_secrets_and_are_not_read_back(tmp_path):
    """The key-value settings (setting, user_setting) are what the settings routes read; secrets live in their own table."""
    from fastapi.testclient import TestClient
    from mahlwerk.main import create_app
    app = create_app(str(tmp_path / "s.db"))
    app.state.vault.put(1, "cookidoo", SECRET)
    c = TestClient(app)
    for url in ("/api/v1/me", "/api/v1/me/imports", "/api/v1/admin/overview", "/api/v1/admin/connectors"):
        assert "hunter2" not in c.get(url).text
    con = sqlite3.connect(app.state.store.path)
    assert con.execute("SELECT count(*) FROM setting WHERE key LIKE '%cookidoo%' AND value LIKE '%hunter%'").fetchone()[0] == 0


def test_the_environment_key_is_stretched_with_a_random_salt_from_the_database(tmp_path, monkeypatch):
    monkeypatch.setenv("MAHLWERK_SECRET_KEY", "x" * 40)
    a, b = Vault(Store(str(tmp_path / "a.db"))), Vault(Store(str(tmp_path / "b.db")))
    assert a.store.vault_salt() == a.store.vault_salt() and a.store.vault_salt() != b.store.vault_salt()
    assert len(a.store.vault_salt()) == 16
    a.put(1, "x", SECRET)
    blob = a.store.get_secret(1, "x")
    b.store.put_secret(1, "x", blob)  # the same passphrase, another installation (other salt): does not decrypt
    assert b.get(1, "x") is None and a.get(1, "x") == SECRET
    assert a._env_key() == a._env_key()  # derived once, then served from memory


def test_no_hard_links_means_creating_the_target_itself_without_replacing(vault, monkeypatch):
    def refuse(*args, **kwargs):
        raise OSError("no hard links here")

    monkeypatch.setattr(os, "link", refuse)
    vault.put(1, "x", SECRET)
    assert vault.get(1, "x") == SECRET and stat.S_IMODE(os.stat(vault.key_path).st_mode) == 0o600
    assert not [p for p in vault.key_path.parent.iterdir() if p.name.endswith(".tmp")]
    key = vault.key_path.read_text()
    vault._create_key_file()  # an existing key file stays whatever happens
    assert vault.key_path.read_text() == key


def test_a_key_file_readable_by_others_is_warned_about_not_refused(vault, caplog):
    import logging
    vault.put(1, "x", SECRET)
    os.chmod(vault.key_path, 0o644)
    vault._warned_mode = False
    with caplog.at_level(logging.WARNING):
        assert vault.get(1, "x") == SECRET
    assert "readable by group or others" in caplog.text and vault.key_status() == "file"
    assert SECRET["password"] not in caplog.text

"""Cross-read check, Python half: `write <dir>` stores what the Python server writes (password hashes of two costs, a session,
an access token, vault secrets with the environment key and with a key file, settings with non-ASCII text and floats, the signed
cookies of the demo switch and of the OIDC sign-in); `read <dir>` verifies what the TS half stored in <dir>. Temp files only.
Run through run.sh (PYTHONPATH must point at the src of this worktree)."""

import json
import os
import shutil
import sqlite3
import sys
import secrets
from pathlib import Path

from mahlwerk import demo_account, oidc, passwords
from mahlwerk.auth import hash_token
from mahlwerk.db import Store
from mahlwerk.vault import Vault

T = 1_800_000_000.0
PASS = "correct horse battery ünï ✓"
PASS_LOW = "another long passphrase"
LOW = (16, 8, 1)
PASSPHRASE = "a passphrase of at least thirty-two characters!!"
SETTINGS = {"display_name": "Jürgen ✓ 日本", "fasting": {"enabled": True, "target_hours": 16.5}, "water_glasses": [250, 500],
            "tiny": 0.1 + 0.2, "big": 2 ** 53, "home": [{"id": "ring", "hidden": False, "wide": True}], "nothing": None}
SECRET = {"email": "ünï@example.org", "password": "p\"w'\\ ✓", "n": 1.5}


def vault_for(store, env: bool) -> Vault:
    if env:
        os.environ["MAHLWERK_SECRET_KEY"] = PASSPHRASE
    else:
        os.environ.pop("MAHLWERK_SECRET_KEY", None)
    return Vault(store)


def check(cond, what):
    if not cond:
        print("FAIL (python side):", what)
        sys.exit(1)
    print("ok   (python side):", what)


def write(d: Path) -> None:
    facts = {"t": T, "settings": SETTINGS, "secret": SECRET, "writer": "python"}
    for variant in ("env", "file"):
        path = d / f"{variant}.db"
        store = Store(str(path))
        default_hasher, low_hasher = passwords.PasswordHasher(), passwords.PasswordHasher(LOW)
        alice = store.create_local_user("alice", "Alice", default_hasher.hash(PASS), True, True)
        bob = store.create_local_user("bob", "Bob", low_hasher.hash(PASS_LOW), False, False)
        session = secrets.token_urlsafe(32)
        store.create_session(alice["id"], hash_token(session), int(T), 30 * 86400)
        token = "mw_" + secrets.token_urlsafe(32)
        store.create_token(alice["id"], "key", token[:8], hash_token(token), "read", None)
        for key, value in SETTINGS.items():
            store.set_setting(alice["id"], key, value)
        vault = vault_for(store, variant == "env")
        vault.put(alice["id"], "cookidoo", SECRET)
        vault.put(0, "household", {"x": 1})
        dkey, okey = store.secret_key(demo_account.KEY_NAME), store.secret_key("oidc_cookie")
        facts[variant] = {"alice": alice["id"], "bob": bob["id"], "session": session, "token": token,
                          "demo_cookie": demo_account.seal(dkey, alice["id"], hash_token(session), T),
                          "login_cookie": oidc.seal_login(okey, oidc.Pending("st", "no", "ve", "/x"), T)}
    (d / "facts.json").write_text(json.dumps(facts))


def read(d: Path) -> None:
    facts = json.loads((d / "facts.json").read_text())
    for variant in ("env", "file"):
        f, path = facts[variant], d / f"{variant}.db"
        store = Store(str(path))
        default_hasher, low_hasher = passwords.PasswordHasher(), passwords.PasswordHasher(LOW)
        alice, bob = store.local_user("alice"), store.local_user("bob")
        check(default_hasher.verify(PASS, alice["password_hash"]) and not default_hasher.verify("wrong", alice["password_hash"]), f"{variant}: default-cost hash of alice")
        check(low_hasher.verify(PASS_LOW, bob["password_hash"]) and not low_hasher.verify(PASS, bob["password_hash"]), f"{variant}: low-cost hash of bob")
        check(not default_hasher.needs_rehash(alice["password_hash"]) and default_hasher.needs_rehash(bob["password_hash"]), f"{variant}: needs_rehash follows the cost")
        row = store.find_session(hash_token(f["session"]), int(facts["t"]) + 10, 30 * 86400, 180 * 86400)
        check(row is not None and row["id"] == f["alice"] and row["local_admin"], f"{variant}: session is found")
        check(store.find_session(hash_token(f["session"]) + "0", int(facts["t"]), 86400, 86400) is None, f"{variant}: unknown session is not found")
        tok = store.find_token(hash_token(f["token"]))
        check(tok is not None and tok["scope"] == "read" and tok["id"] == f["alice"], f"{variant}: access token is found")
        check(store.find_token(hash_token(f["token"] + "x")) is None, f"{variant}: wrong token is not found")
        check(store.get_settings(f["alice"]) == facts["settings"], f"{variant}: settings (non-ASCII, floats, null, nested)")
        vault = vault_for(store, variant == "env")
        check(vault.get(f["alice"], "cookidoo") == facts["secret"], f"{variant}: vault secret")
        check(vault.get(0, "household") == {"x": 1}, f"{variant}: household secret")
        check(vault.get(f["bob"], "cookidoo") is None and vault.state(f["bob"], "cookidoo") == "none", f"{variant}: no secret for bob")
        check(demo_account.open_cookie(store.secret_key(demo_account.KEY_NAME), f["demo_cookie"], f["alice"], hash_token(f["session"]), facts["t"] + 10), f"{variant}: demo cookie opens")
        check(not demo_account.open_cookie(store.secret_key(demo_account.KEY_NAME), f["demo_cookie"], f["bob"], hash_token(f["session"]), facts["t"] + 10), f"{variant}: demo cookie of another user is refused")
        check(not demo_account.open_cookie(store.secret_key(demo_account.KEY_NAME), f["demo_cookie"], f["alice"], hash_token(f["session"]), facts["t"] + 10 ** 6), f"{variant}: demo cookie expires")
        pending = oidc.open_login(store.secret_key("oidc_cookie"), f["login_cookie"], facts["t"] + 10)
        check(pending is not None and (pending.state, pending.nonce, pending.verifier, pending.next) == ("st", "no", "ve", "/x"), f"{variant}: login cookie opens")
        check(oidc.open_login(store.secret_key("oidc_cookie"), f["login_cookie"], facts["t"] + 700) is None, f"{variant}: login cookie expires")
        check(oidc.open_login(store.secret_key("oidc_cookie"), f["login_cookie"][:-2] + "AA", facts["t"]) is None, f"{variant}: damaged login cookie is refused")
        # negatives on a copy: a damaged blob and a blob moved to another owner do not decrypt
        copy = d / f"{variant}-copy.db"
        shutil.copy(path, copy)
        if (d / f"{variant}.db.key").exists():
            shutil.copy(d / f"{variant}.db.key", str(copy) + ".key")
        con = sqlite3.connect(copy)
        blob = bytearray(con.execute("SELECT blob FROM secret WHERE user_id = ? AND name = 'cookidoo'", (f["alice"],)).fetchone()[0])
        con.execute("INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, 'cookidoo', ?, 1)", (f["bob"], bytes(blob)))
        blob[20] ^= 1
        con.execute("INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, 'broken', ?, 1)", (f["alice"], bytes(blob)))
        con.commit()
        con.close()
        vault = vault_for(Store(str(copy)), variant == "env")
        check(vault.get(f["bob"], "cookidoo") is None, f"{variant}: a blob copied to another owner does not decrypt")
        check(vault.get(f["alice"], "broken") is None, f"{variant}: a damaged blob does not decrypt")


if __name__ == "__main__":
    {"write": write, "read": read}[sys.argv[1]](Path(sys.argv[2]))

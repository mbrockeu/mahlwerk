"""Stored secrets: connector credentials kept encrypted in the database.

What this protects: a copy of the database file (a backup, a leaked dump) does not give away the credentials stored in
it. What it does not protect: whoever has the running server or the key can read them, because the server must be able
to use them. There is no way around that for a credential the server has to present to another service on its own.

How:
- The cipher is AES-256-GCM from the `cryptography` package (authenticated encryption; no home-made crypto). Each value
  gets a fresh random 96-bit nonce. The row's owner and name are bound in as associated data, so a value copied into
  another row (another user, another name) does not decrypt.
- The key is `MAHLWERK_SECRET_KEY` from the environment (any text of at least 32 characters, for example
  `openssl rand -base64 32`). The 256-bit key is derived from it with scrypt (N=2^15, r=8, p=1) and a random salt that is
  kept in the database (`setting` row `secret.vault_salt`). Why a random salt in the database instead of a fixed one in the
  code: every installation stretches differently, so one table of guesses does not serve all of them, and the salt is not a
  secret (whoever has the database has it, and still needs the passphrase). A text that is long and random needs no
  stretching, but nothing stops somebody from typing a short, guessable phrase, and scrypt makes every guess cost about
  0.1 s and 32 MB. Otherwise a key file next to the database (`<database>.key`, 32 random bytes as hex, mode
  0600, created without overwriting, only when the first secret is stored). Back the key file up with the database
  (a restore without it leaves the stored secrets unreadable); the environment variable takes precedence over the file.
- A missing or wrong key is not an error for the rest of the app: the stored secret then counts as "not there" (state
  `unreadable`) and has to be entered again. Nothing is ever returned, logged or put into an error message except the
  state names defined here.

Table `secret`: (user_id, name) -> `blob` = 0x01 | nonce | ciphertext+tag. `user_id` 0 is the household (shared) scope.
"""

import json
import logging
import os
import secrets
import threading
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

log = logging.getLogger("mahlwerk.vault")

HOUSEHOLD = 0
VERSION = b"\x01"
ENV_NAME = "MAHLWERK_SECRET_KEY"
MIN_ENV_LENGTH = 32
SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}


class VaultError(Exception):
    """Storing is impossible; `code` is `invalid_key` (the environment or key file holds an unusable key) or `no_key_file`
    (the key file could not be created). Carries no secret."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def mask_email(email: str) -> str:
    """`a***@example.org`: enough to recognise the account, not enough to use it."""
    local, _, domain = (email or "").partition("@")
    if not domain:
        return "***"
    return f"{local[:1]}***@{domain}"


class Vault:
    def __init__(self, store):
        self.store = store
        self.key_path = Path(str(store.path) + ".key")
        self._lock = threading.Lock()
        self._derived: tuple[str, bytes, bytes] | None = None  # (passphrase, salt, key): scrypt is slow, do it once
        self._warned_mode = False

    # ---- the key ----

    def _env_key(self) -> bytes | None | bool:
        """The key from the environment, None if the variable is not set, False if it is set but unusable."""
        raw = os.environ.get(ENV_NAME, "")
        if not raw.strip():
            return None
        if len(raw) < MIN_ENV_LENGTH:
            return False
        salt = self.store.vault_salt()
        cached = self._derived
        if cached is not None and cached[0] == raw and cached[1] == salt:
            return cached[2]
        key = Scrypt(salt=salt, length=32, **SCRYPT).derive(raw.encode())
        self._derived = (raw, salt, key)
        return key

    def _file_key(self) -> bytes | None | bool:
        """The key from the key file, None if there is none, False if it is not a valid key file."""
        try:
            text = self.key_path.read_text(encoding="ascii").strip()
            mode = os.stat(self.key_path).st_mode
        except FileNotFoundError:
            return None
        except (OSError, UnicodeDecodeError):
            return False
        try:
            key = bytes.fromhex(text)
        except ValueError:
            return False
        if mode & 0o077 and not self._warned_mode:  # readable by others: say so once, do not refuse
            self._warned_mode = True
            log.warning("the key file for stored secrets is readable by group or others (mode %o): chmod 600 it", mode & 0o777)
        return key if len(key) == 32 else False

    def key_status(self) -> str:
        """`env`, `file`, `none` (nothing yet: made when the first secret is stored) or `invalid`."""
        env = self._env_key()
        if env is not None:
            return "invalid" if env is False else "env"
        file = self._file_key()
        return "none" if file is None else "invalid" if file is False else "file"

    def _read_key(self) -> bytes | None:
        env = self._env_key()
        if env is not None:
            return env or None
        return self._file_key() or None

    def _create_key_file(self) -> None:
        """Make the key file without ever replacing an existing one: written next to it and hard-linked into place."""
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.key_path.with_name(self.key_path.name + "." + secrets.token_hex(4) + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as handle:
                handle.write(secrets.token_bytes(32).hex() + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(tmp, self.key_path)
            except FileExistsError:
                pass  # somebody else made it a moment ago: theirs stays
            except OSError:  # a file system without hard links: create the target itself, again without replacing anything
                try:
                    fd2 = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    pass
                else:
                    with os.fdopen(fd2, "w", encoding="ascii") as handle:
                        handle.write(Path(tmp).read_text(encoding="ascii"))
                        handle.flush()
                        os.fsync(handle.fileno())
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        try:
            os.chmod(self.key_path, 0o600)
        except OSError:
            pass

    def _key_for_writing(self) -> bytes:
        with self._lock:
            env = self._env_key()
            if env is False:
                raise VaultError("invalid_key")
            if env is not None:
                return env
            file = self._file_key()
            if file is False:
                raise VaultError("invalid_key")  # never overwrite a file we cannot read
            if file is None:
                try:
                    self._create_key_file()
                except OSError as exc:
                    raise VaultError("no_key_file") from exc
                file = self._file_key()
            if not file:
                raise VaultError("invalid_key")
            return file

    # ---- values ----

    @staticmethod
    def _aad(user_id: int, name: str) -> bytes:
        return f"mahlwerk:{user_id}:{name}".encode()

    def put(self, user_id: int, name: str, value: dict) -> None:
        key = self._key_for_writing()
        nonce = secrets.token_bytes(12)
        data = AESGCM(key).encrypt(nonce, json.dumps(value, separators=(",", ":")).encode(), self._aad(user_id, name))
        self.store.put_secret(user_id, name, VERSION + nonce + data)

    def get(self, user_id: int, name: str) -> dict | None:
        """The stored value, or None when there is none or it cannot be read with the current key."""
        blob = self.store.get_secret(user_id, name)
        if blob is None:
            return None
        key = self._read_key()
        if key is None or blob[:1] != VERSION or len(blob) < 1 + 12 + 16:
            return None
        try:
            value = json.loads(AESGCM(key).decrypt(blob[1:13], blob[13:], self._aad(user_id, name)))
        except (InvalidTag, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def state(self, user_id: int, name: str) -> str:
        """`none`, `stored` or `unreadable` (a value is there but the key is missing or does not fit)."""
        if not self.store.has_secret(user_id, name):
            return "none"
        return "stored" if self.get(user_id, name) is not None else "unreadable"

    def delete(self, user_id: int, name: str) -> None:
        self.store.delete_secret(user_id, name)

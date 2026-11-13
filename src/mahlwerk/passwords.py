"""Password hashing with scrypt from the standard library (no extra dependency).

A hash is the text `scrypt$N$r$p$salt$key` (salt and key in unpadded URL-safe base64). The cost parameters travel with
the hash, so they can be raised later: a hash made with weaker parameters than the current ones is replaced by a new
one at the next successful sign-in (`needs_rehash`).
"""

import base64
import binascii
import hmac
import os
import threading

import hashlib

MIN_LENGTH = 10
MAX_LENGTH = 256  # also keeps a huge body from being hashed

# Production cost: 2**15 needs about 32 MB of memory and 80 ms per hash. Nothing in the environment lowers it; only
# code (the `cost` argument, used by the tests) can.
DEFAULT_N, DEFAULT_R, DEFAULT_P = 2**15, 8, 1
SALT_BYTES, KEY_BYTES = 16, 32
# Hashes stored in the database are trusted, but their parameters are still bounded before they reach scrypt.
LIMIT_N, LIMIT_R, LIMIT_P = 2**20, 32, 16
# At most this many hashes run at once, so a flood of sign-in attempts cannot use up the memory (4 x 32 MB).
CONCURRENT = 4


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    # OpenSSL refuses to go over 32 MB by default, which N=2**15, r=8 touches exactly: give it room.
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=KEY_BYTES, maxmem=256 * n * r * p + 2**20)


class PasswordHasher:
    def __init__(self, cost: tuple[int, int, int] = (DEFAULT_N, DEFAULT_R, DEFAULT_P)):
        self.n, self.r, self.p = cost
        self._slots = threading.BoundedSemaphore(CONCURRENT)
        self._dummy: str | None = None

    def hash(self, password: str) -> str:
        salt = os.urandom(SALT_BYTES)
        with self._slots:
            key = _scrypt(password, salt, self.n, self.r, self.p)
        return f"scrypt${self.n}${self.r}${self.p}${_b64(salt)}${_b64(key)}"

    @staticmethod
    def _parse(stored: str) -> tuple[int, int, int, bytes, bytes] | None:
        try:
            name, n, r, p, salt, key = stored.split("$")
            n, r, p = int(n), int(r), int(p)
            if name != "scrypt" or not (2 <= n <= LIMIT_N and n & (n - 1) == 0 and 1 <= r <= LIMIT_R and 1 <= p <= LIMIT_P):
                return None
            return n, r, p, _unb64(salt), _unb64(key)
        except (ValueError, binascii.Error):
            return None

    def verify(self, password: str, stored: str | None) -> bool:
        """Compare in constant time. A missing or malformed hash costs the same work and gives False."""
        parsed = self._parse(stored) if stored else None
        if parsed is None:
            parsed = self._parse(self.dummy())
            assert parsed is not None
            expected_ok = False
        else:
            expected_ok = True
        n, r, p, salt, key = parsed
        with self._slots:
            candidate = _scrypt(password, salt, n, r, p)
        return hmac.compare_digest(candidate, key) and expected_ok

    def needs_rehash(self, stored: str) -> bool:
        parsed = self._parse(stored)
        return parsed is None or parsed[:3] != (self.n, self.r, self.p)

    def _make_dummy(self) -> str:
        salt = os.urandom(SALT_BYTES)
        key = _scrypt(_b64(os.urandom(18)), salt, self.n, self.r, self.p)
        return f"scrypt${self.n}${self.r}${self.p}${_b64(salt)}${_b64(key)}"

    def dummy(self) -> str:
        """A hash nobody knows the password of, with the current cost: used to spend the same time when the account
        does not exist."""
        if self._dummy is None:
            self._dummy = self._make_dummy()
        return self._dummy

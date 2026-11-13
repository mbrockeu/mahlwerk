"""Where recipe pictures live: files in the folder `<database file name>.images` next to the database (e.g. `mahlwerk.db.images`).

Names come from the content only: `<hash>-<size>.webp` with a 32-character lower-case hex hash and a size key from
imageproc.SIZES; nothing a person or a provider wrote ever becomes part of a path. Files are written to a temporary name and
moved into place (a half-written file is never visible), with mode 0600 in a 0700 folder. The folder is part of the backup
(README): a missing file only means a recipe without picture.

The folder is only ever touched when it is OURS: Mahlwerk makes it itself and puts a marker file (`.mahlwerk-images`) in it. A folder
that exists without the marker (and is not empty) is never changed, tidied or written to: the answer is a clear error instead.

Tidying: a file that no food refers to any more is deleted when the picture is replaced or removed (`release`) and by `sweep`,
which runs at start-up, after a mass deletion (demo data removed, an import taken back) and, at most once a day, on a write; it is
bounded (at most `SWEEP_LIMIT` deletions per pass) and only for files older than an hour, so that a file that was just written but not
yet linked in the database is never taken away. A set of files that could not be written completely is removed at once.

The total size is limited (MAHLWERK_IMAGES_MAX_MB, default 1024): a picture that would not fit is refused with a clear message.
"""

import os
import re
import tempfile
import threading
import time
from pathlib import Path

from .imageproc import SIZES, Processed

DEFAULT_MAX_MB = 1024
SWEEP_LIMIT = 2000
GRACE_SECONDS = 3600
HASH = re.compile(r"[0-9a-f]{32}")  # used with fullmatch: `$` would let a trailing newline through
NAME = re.compile(r"([0-9a-f]{32})-([lms])\.webp")
DAY = 86400


class StoreError(Exception):
    """The pictures cannot be stored; the text is for the person (it never names a path)."""


class StoreFull(StoreError):
    """The picture folder would grow past its limit."""

    def __init__(self):
        super().__init__("the picture folder is full (limit MAHLWERK_IMAGES_MAX_MB): remove pictures or raise the limit")


MARKER = ".mahlwerk-images"
TMP_PREFIX = ".mahlwerk-tmp-"


def valid_hash(text: str) -> bool:
    return isinstance(text, str) and bool(HASH.fullmatch(text))


def max_bytes_from_env() -> int:
    raw = os.environ.get("MAHLWERK_IMAGES_MAX_MB", "").strip()
    try:
        value = float(raw) if raw else float(DEFAULT_MAX_MB)
    except ValueError:
        value = float(DEFAULT_MAX_MB)
    return int(max(1.0, value) * 1024 * 1024)


class ImageStore:
    def __init__(self, directory: str | Path, max_bytes: int | None = None, clock=time.time):
        self.dir = Path(directory)
        self.max_bytes = max_bytes if max_bytes is not None else max_bytes_from_env()
        self.clock = clock
        # everything that links or unlinks a picture holds this lock (see recipeimages.py), so a file is never deleted between
        # the moment another recipe starts to use it and the moment that is saved
        self.lock = threading.RLock()
        self.last_sweep = clock()

    # ---- paths ----

    def path(self, digest: str, size: str) -> Path | None:
        """The file of a hash and size, or None for anything that is not exactly that form."""
        if not valid_hash(digest) or size not in SIZES:
            return None
        return self.dir / f"{digest}-{size}.webp"

    def ours(self) -> bool:
        return (self.dir / MARKER).is_file()

    def _ensure(self) -> None:
        """Make the folder (mode 0700, with the marker) if there is none; adopt an EMPTY existing one; refuse any other."""
        try:
            if not self.dir.exists():
                self.dir.mkdir(parents=True, mode=0o700)
            elif not self.ours():
                if any(self.dir.iterdir()):
                    raise StoreError("the picture folder exists but was not made by Mahlwerk (marker file missing): it is left alone")
            if not self.ours():
                os.chmod(self.dir, 0o700)
                (self.dir / MARKER).write_text("Mahlwerk recipe pictures: files named <hash>-<size>.webp. Back this folder up with the database.\n")
        except OSError:
            raise StoreError("the picture folder cannot be written (disk full or no permission)") from None

    # ---- reading ----

    def entries(self) -> list[tuple[Path, int, float]]:
        """(path, size, mtime) of every picture file (and leftover temporary files)."""
        found = []
        if not self.ours():
            return found
        try:
            with os.scandir(self.dir) as scan:
                for e in scan:
                    if e.is_file(follow_symlinks=False) and (NAME.fullmatch(e.name) or e.name.startswith(TMP_PREFIX)):
                        st = e.stat(follow_symlinks=False)
                        found.append((Path(e.path), st.st_size, st.st_mtime))
        except FileNotFoundError:
            pass
        return found

    def total_bytes(self) -> int:
        return sum(size for _, size, _ in self.entries())

    def has(self, digest: str) -> bool:
        paths = [self.path(digest, s) for s in SIZES]
        return all(p is not None and p.is_file() for p in paths)

    # ---- writing ----

    def put(self, processed: Processed) -> None:
        """Write the three files of a processed picture. A picture that is stored already (same hash) costs nothing. A write that fails
        (disk full) removes what this call had written and says so with StoreError."""
        with self.lock:
            if self.has(processed.hash):
                return
            added = sum(len(b) for b in processed.files.values())
            self._ensure()
            if self.total_bytes() + added > self.max_bytes:
                raise StoreFull
            made: list[Path] = []
            try:
                for key, data in processed.files.items():
                    target = self.path(processed.hash, key)
                    fd, tmp = tempfile.mkstemp(prefix=TMP_PREFIX, dir=self.dir)
                    try:
                        with os.fdopen(fd, "wb") as handle:
                            handle.write(data)
                            handle.flush()
                            os.fsync(handle.fileno())
                        os.chmod(tmp, 0o600)
                        os.replace(tmp, target)
                        made.append(target)
                    except BaseException:
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                        raise
            except OSError:
                for path in made:  # an incomplete set is never left behind
                    try:
                        path.unlink()
                    except OSError:
                        pass
                raise StoreError("the picture could not be written (disk full or no permission)") from None

    def delete(self, digest: str) -> None:
        for key in SIZES:
            p = self.path(digest, key)
            if p is not None:
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass

    def sweep(self, referenced: set[str], limit: int = SWEEP_LIMIT) -> int:
        """Delete files no food refers to (older than an hour) and old temporary files; at most `limit`. Returns how many. Only in a folder
        that is ours."""
        now, removed = self.clock(), 0
        self.last_sweep = now
        with self.lock:
            for path, _, mtime in sorted(self.entries(), key=lambda e: e[2]):
                if removed >= limit:
                    break
                if now - mtime < GRACE_SECONDS:
                    continue
                match = NAME.fullmatch(path.name)
                if match is None or match.group(1) not in referenced:
                    try:
                        path.unlink()
                        removed += 1
                    except OSError:
                        pass
        return removed

    def sweep_due(self) -> bool:
        return self.clock() - self.last_sweep >= DAY

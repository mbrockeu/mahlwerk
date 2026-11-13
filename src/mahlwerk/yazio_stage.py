"""The staging area of the Yazio import: what a person uploaded (or the direct sign-in fetched) waits here, in memory,
between "preview" and "confirm". Nothing is written to disk.

- One staging area per person, replaced by a new upload series, dropped after confirm, on "discard", and after 20
  minutes without use. The area has a token that changes whenever its contents change; the confirmation names the token
  it was shown, so what is imported is exactly what the preview counted.
- Limits (bytes of JSON after unpacking): 24 MB per file, 32 MB per person, 96 MB for the whole server. Measured against
  what an export is: 12,000 entries on 1,100 days with 2,000 products come to a few MB, so these leave a good margin and keep
  the memory of one parse small. Packed data must not be absurdly dense either: more than 100 times the packed size (once
  the result passes 1 MB) is refused while unpacking; JSON packs 10 to 30 times, so a real export never gets near it.
- Structure limits, checked on the raw bytes BEFORE anything is parsed (counting characters allocates nothing): at most
  200,000 `{`/`[` and 2,000,000 `,`/`:` over all files of a person. A file of a few small objects can otherwise turn into
  gigabytes of Python objects; with these limits the parse needs roughly 100 to 150 MB at the very most.
- One heavy job at a time on the whole server (unpacking, checking, preview, import): another request gets 429 at once.
- Uploads may be plain JSON, gzip-packed JSON (the browser packs large files to get past the size limit of a proxy in
  front) or a ZIP of the exporter's folder. A ZIP is read in memory only: entries are never written anywhere, so paths
  cannot escape; entries with an absolute, parent or odd path make the whole ZIP refused; only the expected file names are
  taken (anything else is ignored); an entry is read with a hard bound, whatever size it declares (zip bombs stop at the
  limit); encrypted entries are refused.
"""

import io
import json
import secrets
import struct
import threading
import time
import zipfile
import zlib
from dataclasses import dataclass, field

from .yazio import FILES

MAX_FILE = 24 * 1024 * 1024
MAX_PERSON = 32 * 1024 * 1024
MAX_TOTAL = 96 * 1024 * 1024
MAX_RATIO = 100  # unpacked / packed
RATIO_FREE = 1024 * 1024  # below this size the ratio is not judged
MAX_CONTAINERS = 200_000
MAX_TOKENS = 2_000_000
ZIP_CD_MAX = 256 * 1024  # bytes of the central directory (1000 entries with long names fit easily)
TTL = 1200  # seconds
MAX_ZIP_ENTRIES = 1000
MAX_ZIP_DEPTH = 4
UPLOAD_NAMES = (*FILES, "export.zip")


class StageError(Exception):
    """The upload or the staging area cannot take this; the text is safe to show (no content of the file in it)."""

    def __init__(self, code: str, text: str):
        super().__init__(text)
        self.code = code
        self.text = text


def _gunzip(data: bytes, limit: int) -> bytes:
    """Unpack gzip in steps of 1 MB so that an absurd ratio or size stops early, long before it fills memory."""
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = bytearray()
    pending = data
    try:
        while not decoder.eof:
            chunk = decoder.decompress(pending, 1 << 20)
            out += chunk
            pending = decoder.unconsumed_tail
            if len(out) > limit:
                raise StageError("too_large", "a file is larger than allowed after unpacking")
            used = len(data) - len(pending)
            if len(out) > RATIO_FREE and len(out) > MAX_RATIO * max(used, 1):
                raise StageError("too_large", "the data is packed implausibly densely")
            if not chunk and not pending:
                break
        if not decoder.eof:
            raise StageError("bad_gzip", "the gzip data is cut off")
        if decoder.unused_data.strip(b"\x00"):
            raise StageError("bad_gzip", "unexpected data after the gzip stream")
    except zlib.error:
        raise StageError("bad_gzip", "the gzip data is damaged") from None
    return bytes(out)


def structure(data: bytes) -> tuple[int, int]:
    """(containers, tokens): a cheap upper bound of what parsing would build, from counting characters. A `{` or `,` inside a
    string counts too, which only errs on the safe side."""
    return data.count(b"{") + data.count(b"["), data.count(b",") + data.count(b":")


def _check_structure(files: dict[str, bytes]) -> None:
    containers = tokens = 0
    for data in files.values():
        c, t = structure(data)
        containers += c
        tokens += t
    if containers > MAX_CONTAINERS or tokens > MAX_TOKENS:
        raise StageError("too_large", "the files hold more entries than an export can have")


def _check_json(name: str, data: bytes) -> None:
    """The file is JSON with an object at the top (what the importer reads). Nothing of the content goes into the error."""
    try:
        value = json.loads(data)
    except UnicodeDecodeError:
        raise StageError("bad_json", f"{name}: not text in UTF-8") from None
    except RecursionError:
        raise StageError("bad_json", f"{name}: nested too deeply") from None
    except ValueError:
        raise StageError("bad_json", f"{name}: not valid JSON") from None
    if not isinstance(value, dict):
        raise StageError("bad_json", f"{name}: expected a JSON object at the top level")


def _check_zip_directory(body: bytes) -> None:
    """Look at the end of the ZIP BEFORE zipfile reads it: zipfile builds an object for every entry of the central directory,
    so a directory with hundreds of thousands of entries would eat memory before any count could stop it."""
    tail = body[-(65535 + 22):]
    at = tail.rfind(b"PK\x05\x06")
    if at < 0 or len(tail) - at < 22:
        raise StageError("bad_zip", "the ZIP cannot be read")
    if tail.rfind(b"PK\x06\x07", 0, at) >= 0:
        raise StageError("bad_zip", "ZIP64 archives are not accepted")
    entries, directory_size = struct.unpack_from("<H", tail, at + 10)[0], struct.unpack_from("<I", tail, at + 12)[0]
    if entries == 0xFFFF or directory_size == 0xFFFFFFFF:
        raise StageError("bad_zip", "ZIP64 archives are not accepted")
    if entries > MAX_ZIP_ENTRIES or directory_size > ZIP_CD_MAX:
        raise StageError("bad_zip", "the ZIP has too many entries")


def _read_member(handle, packed: int) -> bytes:
    """One entry, read in steps of 1 MB with the size and ratio limits, whatever the entry declares."""
    out = bytearray()
    while True:
        chunk = handle.read(1 << 20)
        if not chunk:
            return bytes(out)
        out += chunk
        if len(out) > MAX_FILE:
            raise StageError("too_large", "a file is larger than allowed after unpacking")
        if len(out) > RATIO_FREE and len(out) > MAX_RATIO * max(packed, 1):
            raise StageError("too_large", "the data is packed implausibly densely")


def _unzip(body: bytes) -> dict[str, bytes]:
    _check_zip_directory(body)
    found: dict[str, bytes] = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise StageError("bad_zip", "the ZIP has too many entries")
            for info in infos:
                path = info.filename
                parts = path.split("/")
                if (path.startswith("/") or "\\" in path or "\x00" in path or ".." in parts or ":" in parts[0]
                        or len(parts) > MAX_ZIP_DEPTH):
                    raise StageError("bad_zip", "the ZIP contains an unsafe path")
                if info.is_dir():
                    continue
                base = parts[-1]
                if base not in FILES:
                    continue  # anything else is ignored, never read
                if info.flag_bits & 0x1:
                    raise StageError("bad_zip", "the ZIP is encrypted")
                if base in found:
                    raise StageError("bad_zip", f"the ZIP has {base} twice")
                if info.file_size > MAX_FILE:
                    raise StageError("too_large", "a file is larger than allowed after unpacking")
                with archive.open(info) as handle:
                    data = _read_member(handle, info.compress_size)
                total += len(data)
                if total > MAX_PERSON:
                    raise StageError("too_large", "the files are larger than allowed after unpacking")
                found[base] = data
    except StageError:
        raise
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, EOFError, zlib.error):
        raise StageError("bad_zip", "the ZIP cannot be read") from None
    return found


def decode_upload(name: str, body: bytes) -> dict[str, bytes]:
    """The files in one upload: `name` is a file of the export or `export.zip`. Raises StageError."""
    if name not in UPLOAD_NAMES:
        raise StageError("bad_name", "unexpected file name (days.json, products.json, weight.json or a ZIP)")
    if not body:
        raise StageError("empty", "the file is empty")
    if body[:2] == b"\x1f\x8b":
        body = _gunzip(body, MAX_PERSON if name == "export.zip" else MAX_FILE)  # a ZIP is as big as its three files
    if name == "export.zip" or body[:4] == b"PK\x03\x04":
        if name != "export.zip":
            raise StageError("bad_name", "a ZIP must be sent as export.zip")
        files = _unzip(body)
        if not files:
            raise StageError("bad_zip", f"the ZIP holds none of {', '.join(FILES)}")
    else:
        if len(body) > MAX_FILE:
            raise StageError("too_large", "a file is larger than allowed")
        files = {name: body}
    _check_structure(files)  # before any parsing
    for file_name, data in files.items():
        _check_json(file_name, data)
    return files


@dataclass
class Stage:
    files: dict[str, bytes] = field(default_factory=dict)
    token: str = ""
    source: str = "upload"  # upload or login
    expires: float = 0.0

    @property
    def size(self) -> int:
        return sum(len(v) for v in self.files.values())

    def view(self) -> dict:
        return {"token": self.token, "source": self.source, "files": {k: len(v) for k, v in sorted(self.files.items())}}


class Staging:
    def __init__(self, clock=time.time):
        self.clock = clock
        self._lock = threading.Lock()
        self._stages: dict[int, Stage] = {}
        self._busy: set[int] = set()
        self._heavy = threading.Lock()

    def try_heavy(self) -> bool:
        """Take the one place for heavy work (unpacking, checking, preview, import); False at once when it is taken."""
        return self._heavy.acquire(blocking=False)

    def release_heavy(self) -> None:
        self._heavy.release()

    def _expire(self) -> None:
        now = self.clock()
        for uid in [u for u, s in self._stages.items() if s.expires < now and u not in self._busy]:
            del self._stages[uid]

    def get(self, user_id: int) -> Stage | None:
        with self._lock:
            self._expire()
            return self._stages.get(user_id)

    def add(self, user_id: int, files: dict[str, bytes], source: str = "upload", replace: bool = False) -> Stage:
        """Put files into the person's area (a file of the same name replaces the old one; `replace` empties the area
        first). The token changes."""
        with self._lock:
            self._expire()
            old = self._stages.get(user_id)
            keep = {} if replace or old is None or old.source != source else dict(old.files)
            keep.update(files)
            stage = Stage(keep, secrets.token_urlsafe(12), source, self.clock() + TTL)
            others = sum(s.size for u, s in self._stages.items() if u != user_id)
            if stage.size > MAX_PERSON:
                raise StageError("too_large", "the files together are larger than allowed")
            _check_structure(stage.files)
            if others + stage.size > MAX_TOTAL:
                raise StageError("busy", "the server holds too many uploads at the moment; try again in a few minutes")
            self._stages[user_id] = stage
            return stage

    def clear(self, user_id: int, token: str | None = None) -> None:
        """Drop the person's area; with `token` only if it is still the one with that token (an upload that arrived
        while an import ran stays)."""
        with self._lock:
            stage = self._stages.get(user_id)
            if stage is not None and (token is None or stage.token == token):
                del self._stages[user_id]

    def begin(self, user_id: int) -> bool:
        """Mark a preview or import of this person as running (one at a time); False when one already runs."""
        with self._lock:
            if user_id in self._busy:
                return False
            self._busy.add(user_id)
            return True

    def end(self, user_id: int) -> None:
        with self._lock:
            self._busy.discard(user_id)
            stage = self._stages.get(user_id)
            if stage is not None:
                stage.expires = self.clock() + TTL

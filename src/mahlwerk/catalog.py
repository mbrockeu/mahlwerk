"""Local catalogue: read-only SQLite files with foods, searchable by name. Every source has its own file.

The catalogue is optional. Packaged products come from the Open Food Facts CSV export:

    python -m mahlwerk.catalog import-off [--country en:germany] [--source URL-or-file]

and basic foods (apple, bread, cooked potatoes, dishes) from the Bundeslebensmittelschlüssel (see bls.py), an
.xlsx or .csv table:

    python -m mahlwerk.catalog import-bls FILE.xlsx

The running server never writes them. An import builds a new file for ITS source only and swaps it in with an
atomic rename, so a running server keeps reading the old one meanwhile and the other source is untouched. Without
a file a source is simply empty. A catalogue file written before there were several sources (Open Food Facts only,
no English name) stays readable.
"""

import argparse
import codecs
import csv
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import zipfile
import zlib
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx

from . import __version__, bls, nutrients, tabular
from .nutrition import CORE, PER_100_KEYS, guess_unit, is_complete

OFF_URL = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
OFF = "openfoodfacts"
BLS = "bls"
BLS_FIRST = 8  # a search without `source` lists up to this many BLS hits before the packaged products
RAW_BONUS = 12  # a raw basic form ranks as if its name were this many characters shorter
COMPOUND_BELOW = 3  # fewer name-start hits than this for one word: also look for compound spellings
BLS_CANDIDATES = 1500  # BLS hits are ranked in Python; the file is small, this is more than any query matches
PROGRESS_EVERY = 200_000
BATCH = 5_000

SCHEMA = """
CREATE TABLE product (
    id                INTEGER PRIMARY KEY,
    source            TEXT NOT NULL,
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    brand             TEXT,
    quantity          TEXT,
    serving_size      TEXT,
    serving_quantity  REAL,
    unit              TEXT NOT NULL,
    kcal              REAL NOT NULL,
    fat               REAL,
    saturated_fat     REAL,
    carbs             REAL,
    sugars            REAL,
    fiber             REAL,
    protein           REAL,
    salt              REAL,
    extra             TEXT,
    popularity        INTEGER NOT NULL DEFAULT 0,
    name_key          TEXT NOT NULL,
    name_en           TEXT,
    name_key_en       TEXT,
    name_compact      TEXT,
    name_compact_en   TEXT,
    UNIQUE (source, code)
);
CREATE INDEX product_name_compact ON product (name_compact);
CREATE INDEX product_name_compact_en ON product (name_compact_en);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE product_fts USING fts5(
    name, brand, name_en, content='product', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);
"""

COLUMNS = (
    "source", "code", "name", "brand", "quantity", "serving_size", "serving_quantity", "unit",
    *PER_100_KEYS, "extra", "popularity", "name_key",
    "name_en", "name_key_en", "name_compact", "name_compact_en",
)
INSERT = f"INSERT OR REPLACE INTO product ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})"

# CSV columns the import reads
WANTED = (
    "code", "product_name", "brands", "quantity", "serving_size", "serving_quantity", "countries_tags",
    "energy-kcal_100g", "energy_100g", "fat_100g", "saturated-fat_100g", "carbohydrates_100g", "sugars_100g",
    "fiber_100g", "proteins_100g", "salt_100g", "unique_scans_n",
)
MACROS = {
    "fat": "fat_100g", "saturated_fat": "saturated-fat_100g", "carbs": "carbohydrates_100g",
    "sugars": "sugars_100g", "fiber": "fiber_100g", "protein": "proteins_100g", "salt": "salt_100g",
}


def default_path(main_db: str | None = None) -> str:
    """`MAHLWERK_CATALOG_DB`, else `catalog.db` next to the main database."""
    explicit = os.environ.get("MAHLWERK_CATALOG_DB")
    if explicit:
        return explicit
    main = main_db or os.environ.get("MAHLWERK_DB", "./data/mahlwerk.db")
    return str(Path(main).parent / "catalog.db")


def default_bls_path(off_path: str) -> str:
    """`MAHLWERK_CATALOG_BLS_DB`, else the file of the Open Food Facts catalogue with `-bls` before the suffix."""
    explicit = os.environ.get("MAHLWERK_CATALOG_BLS_DB")
    if explicit:
        return explicit
    path = Path(off_path)
    return str(path.with_name(f"{path.stem}-bls{path.suffix}"))


def fold(text: str) -> str:
    """Lower case without diacritics ('Äpfel' -> 'apfel'), like the FTS tokenizer sees words."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def words(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", fold(text))


def name_key(name: str) -> str:
    return " ".join(words(name))


def name_compact(name: str | None) -> str | None:
    """The name without spaces and hyphens ('Hafer Flocken' -> 'haferflocken'), so that a compound word finds it."""
    return "".join(words(name)) if name else None


def food_data(item: dict) -> dict:
    """A catalogue entry in the shape stored in `food.data`."""
    keys = ("name", "brand", "quantity", "serving_size", "serving_quantity", "unit", "per_100", "complete")
    return {**{k: item[k] for k in keys}, "extra": item.get("extra") or {}}


def external_id(source: str, code: str) -> str | None:
    """How a food adopted from the catalogue is recognised later when it has no barcode (BLS foods)."""
    return f"{source}:{code}" if source == BLS else None


class Catalog:
    """Read access to the catalogue files. Every call opens its own short-lived read-only connections."""

    def __init__(self, path: str, bls_path: str | None = None):
        self.path = path  # Open Food Facts
        self.bls_path = bls_path or default_bls_path(path)

    def _file(self, source: str) -> str:
        return self.bls_path if source == BLS else self.path

    @staticmethod
    def _open(path: str) -> sqlite3.Connection | None:
        if not os.path.isfile(path):
            return None
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        except sqlite3.OperationalError:
            return None
        con.row_factory = sqlite3.Row
        return con

    def _file_info(self, path: str) -> dict:
        empty = {"products": 0, "updated_at": None}
        con = self._open(path)
        if con is None:
            return empty
        try:
            meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
            return {"products": int(meta.get("products", 0)), "updated_at": int(meta["updated_at"]) if "updated_at" in meta else None}
        except (sqlite3.DatabaseError, ValueError):
            return empty
        finally:
            con.close()

    def info(self) -> dict:
        """Size and age of the catalogue: {products, updated_at} of Open Food Facts and `bls` with the same two."""
        return {**self._file_info(self.path), "bls": self._file_info(self.bls_path)}

    @staticmethod
    def _item(row: sqlite3.Row) -> dict:
        per_100 = {k: row[k] for k in PER_100_KEYS}
        # a catalogue file built before the additional nutrients or the English name existed has no such column
        keys = row.keys()
        extra = json.loads(row["extra"]) if "extra" in keys and row["extra"] else {}
        return {
            "source": row["source"],
            "code": row["code"],
            "name": row["name"],
            "name_en": row["name_en"] if "name_en" in keys else None,
            "brand": row["brand"],
            "quantity": row["quantity"],
            "serving_size": row["serving_size"],
            "serving_quantity": row["serving_quantity"],
            "unit": row["unit"],
            "per_100": per_100,
            "extra": nutrients.clean(extra),
            "complete": is_complete(per_100),
        }

    def get(self, source: str, code: str) -> dict | None:
        con = self._open(self._file(source))
        if con is None:
            return None
        try:
            row = con.execute("SELECT * FROM product WHERE source = ? AND code = ?", (source, code)).fetchone()
        except sqlite3.DatabaseError:
            return None
        finally:
            con.close()
        return self._item(row) if row else None

    def search(
        self,
        query: str,
        limit: int = 25,
        source: str | None = None,
        skip: Callable[[list[dict]], set[tuple[str, str]]] | None = None,
    ) -> list[dict]:
        """Foods whose name (or brand) contains every word of `query` (as a word start), best first.

        Without `source`: up to `BLS_FIRST` basic foods (BLS), then packaged products (Open Food Facts) up to `limit`
        in all. With `source`: only that one, up to `limit`. `skip` gets a list of hits and returns the
        (source, code) pairs to leave out (those already stored as a food); more is fetched so that `limit` is
        still reached.

        Open Food Facts ranking: the name starts with the first word (as a whole word before a mere prefix), then the
        shorter name, popular products getting a head start of up to 40 characters. BLS ranking: see `_search_bls`.
        """
        tokens = words(query)
        if not tokens or limit < 1:
            return []

        def take(src: str, n: int) -> list[dict]:
            if n < 1:
                return []
            hits = self._search_file(src, tokens, n * 2 + 20 if skip else n)
            if skip:
                dropped = skip(hits)
                hits = [h for h in hits if (h["source"], h["code"]) not in dropped]
            return hits[:n]

        if source is not None:
            return take(source, limit)
        basics = take(BLS, min(BLS_FIRST, limit))
        return basics + take(OFF, limit - len(basics))

    def _search_file(self, source: str, tokens: list[str], limit: int) -> list[dict]:
        if source == BLS:
            hits = self._search_bls(tokens, limit)
        elif source == OFF:
            hits = self._search_off(tokens, limit)
        else:
            return []
        return self._with_compounds(source, tokens, hits, limit) if len(tokens) == 1 else hits

    @staticmethod
    def _starts(item: dict, word: str) -> bool:
        return any(name and name_key(name).startswith(word) for name in (item["name"], item.get("name_en")))

    def _whole_name_first(self, source: str, word: str, hits: list[dict], limit: int) -> list[dict]:
        """A food whose whole name is the word, only written apart ("Hafer Flocken" for "haferflocken"), is what
        the user means, however many longer names start with the word. It goes to the top."""
        con = self._open(self._file(source))
        if con is None:
            return hits
        try:
            columns = {r["name"] for r in con.execute("PRAGMA table_info(product)")}
            if not {"name_compact", "name_compact_en"} <= columns:
                return hits
            rows = con.execute(
                "SELECT * FROM product WHERE source = :source AND (name_compact = :w OR name_compact_en = :w) "
                "ORDER BY id LIMIT 3",
                {"source": source, "w": word},
            ).fetchall()
        except sqlite3.DatabaseError:
            return hits
        finally:
            con.close()
        exact = [self._item(r) for r in rows]
        if not exact:
            return hits
        codes = {e["code"] for e in exact}
        return (exact + [h for h in hits if h["code"] not in codes])[:limit]

    def _with_compounds(self, source: str, tokens: list[str], hits: list[dict], limit: int) -> list[dict]:
        """A single word that finds fewer than `COMPOUND_BELOW` names starting with it also finds names that only
        spell it with a space ("haferflocken" -> "Hafer Flocken", as the BLS writes it). Those come after the names
        that start with the word and before the rest. A catalogue file without the compact name columns skips this."""
        word = tokens[0]
        hits = self._whole_name_first(source, word, hits, limit)
        starting = [h for h in hits if self._starts(h, word) or word in (name_compact(h["name"]), name_compact(h.get("name_en")))]
        if len(starting) >= COMPOUND_BELOW:
            return hits
        con = self._open(self._file(source))
        if con is None:
            return hits
        upper = word[:-1] + chr(ord(word[-1]) + 1)
        try:
            columns = {r["name"] for r in con.execute("PRAGMA table_info(product)")}
            if not {"name_compact", "name_compact_en"} <= columns:
                return hits
            rows = con.execute(
                "SELECT * FROM product WHERE source = :source AND (name_compact >= :w AND name_compact < :u "
                "OR name_compact_en >= :w AND name_compact_en < :u) ORDER BY length(name_key), id LIMIT :limit",
                {"source": source, "w": word, "u": upper, "limit": limit},
            ).fetchall()
        except sqlite3.DatabaseError:
            return hits
        finally:
            con.close()
        seen = {h["code"] for h in hits}
        extra = [self._item(r) for r in rows if r["code"] not in seen]
        if not extra:
            return hits
        rest = [h for h in hits if h not in starting]
        return (starting + extra + rest)[:limit]

    @staticmethod
    def _match(tokens: list[str]) -> str:
        return " ".join(f'"{t}"*' for t in tokens)  # tokens are letters and digits only, nothing to escape

    def _search_off(self, tokens: list[str], limit: int) -> list[dict]:
        first = tokens[0]
        con = self._open(self.path)
        if con is None:
            return []
        try:
            rows = con.execute(
                "SELECT p.* FROM product_fts JOIN product p ON p.id = product_fts.rowid WHERE product_fts MATCH :match "
                "ORDER BY CASE WHEN p.name_key = :first OR p.name_key LIKE :first || ' %' THEN 0 "
                "              WHEN p.name_key LIKE :first || '%' THEN 1 ELSE 2 END, "
                "         length(p.name_key) - min(p.popularity, 400) / 10.0, p.name_key, p.id LIMIT :limit",
                {"match": self._match(tokens), "first": first, "limit": limit},
            ).fetchall()
        except sqlite3.DatabaseError:
            return []
        finally:
            con.close()
        return [self._item(r) for r in rows]

    def _search_bls(self, tokens: list[str], limit: int) -> list[dict]:
        """Basic foods matching every word in the German or the English name, best first.

        Better means: the name (in whichever language matched best) starts with the first word, as a whole word before
        a mere prefix, before a name that only has it further in; then the shorter name. A raw, unprocessed basic form
        (the name carries the word "roh" / "raw") counts as `RAW_BONUS` characters shorter, so "Apfel roh" comes before
        "Apfel getrocknet" while a much shorter plain name still wins.
        """
        con = self._open(self.bls_path)
        if con is None:
            return []
        try:
            rows = con.execute(
                "SELECT p.* FROM product_fts JOIN product p ON p.id = product_fts.rowid WHERE product_fts MATCH ? "
                "ORDER BY length(p.name_key), p.id LIMIT ?",
                (self._match(tokens), BLS_CANDIDATES),
            ).fetchall()
        except sqlite3.DatabaseError:
            return []
        finally:
            con.close()
        first = tokens[0]

        def rank(row: sqlite3.Row) -> tuple:
            best = None
            for key, raw_word in ((row["name_key"], "roh"), (row["name_key_en"] or "", "raw")):
                if not key:
                    continue
                if key == first or key.startswith(first + " "):
                    klass = 0
                elif key.startswith(first):
                    klass = 1
                else:
                    klass = 2
                length = len(key) - (RAW_BONUS if raw_word in key.split() else 0)
                if best is None or (klass, length) < best:
                    best = (klass, length)
            return (*(best or (3, 0)), row["name_key"], row["id"])

        return [self._item(r) for r in sorted(rows, key=rank)[:limit]]


# import from Open Food Facts


class CatalogImportError(Exception):
    """The import cannot continue (unreadable source, missing columns, nothing usable)."""


def _number(value: str | None) -> float | None:
    try:
        number = float((value or "").strip())
    except ValueError:
        return None
    return round(number, 2) if number == number and abs(number) != float("inf") else None


def _chunks(source: str, http: httpx.Client | None) -> Iterator[bytes]:
    if source.startswith(("http://", "https://")):
        client = http or httpx.Client(
            timeout=httpx.Timeout(30, read=120), follow_redirects=True,
            headers={"User-Agent": f"Mahlwerk/{__version__} (catalogue import)"},
        )
        with client.stream("GET", source, follow_redirects=True) as response:
            if response.status_code != 200:
                raise CatalogImportError(f"{source}: HTTP {response.status_code}")
            yield from response.iter_raw(1 << 20)
    else:
        with open(source, "rb") as handle:
            while block := handle.read(1 << 20):
                yield block


class _Lines:
    """Decompressed text lines of a gzip stream; `truncated` tells whether the stream ended early."""

    def __init__(self, chunks: Iterator[bytes]):
        self.chunks = chunks
        self.truncated = False

    def __iter__(self) -> Iterator[str]:
        inflater = zlib.decompressobj(wbits=31)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""
        for block in self.chunks:
            try:
                data = inflater.decompress(block)
            except zlib.error as exc:
                raise CatalogImportError(f"not a readable gzip stream: {exc}") from exc
            pending += decoder.decode(data)
            if "\n" in pending:
                *lines, pending = pending.split("\n")
                for line in lines:
                    yield line + "\n"
            if inflater.eof:
                break
        self.truncated = not inflater.eof
        if pending and not self.truncated:
            yield pending  # an unterminated last line of a complete file; one of a cut file is probably incomplete


def _country_tags(countries: list[str]) -> set[str]:
    return {c.strip().lower() if ":" in c else f"en:{c.strip().lower()}" for c in countries if c.strip()}


class Stats:
    def __init__(self):
        self.read = 0
        self.kept = 0
        self.other_country = 0
        self.incomplete = 0  # no name or no energy value
        self.nonsense = 0
        self.broken = 0
        self.truncated = False
        self.started = time.monotonic()

    @property
    def seconds(self) -> float:
        return time.monotonic() - self.started


def _convert(row: list[str], at: dict[str, int], tags: set[str], stats: Stats) -> tuple | None:
    """One CSV row -> insert values, or None (and a counter) when the row is not wanted."""
    if not tags.intersection(row[at["countries_tags"]].lower().split(",")):
        stats.other_country += 1
        return None
    name = " ".join(row[at["product_name"]].split())[:200]
    code = row[at["code"]].strip()
    kcal = _number(row[at["energy-kcal_100g"]])
    if kcal is None and (kj := _number(row[at["energy_100g"]])) is not None:
        kcal = round(kj / 4.184, 1)
    if not name or not code or kcal is None:
        stats.incomplete += 1
        return None
    macros = {key: _number(row[at[column]]) for key, column in MACROS.items()}
    values = [v for v in macros.values() if v is not None]
    core_sum = sum(macros[k] or 0 for k in CORE if k != "kcal")
    if kcal < 0 or kcal > 950 or any(v < 0 or v > 100 for v in values) or core_sum > 105:
        stats.nonsense += 1
        return None
    extra = nutrients.extra_from_off(
        lambda column: nutrients.parse_number(row[at[column]]) if column in at and at[column] < len(row) else None,
        fat=macros["fat"], carbs=macros["carbs"],
    )
    quantity = row[at["quantity"]].strip() or None
    serving_size = row[at["serving_size"]].strip() or None
    serving = _number(row[at["serving_quantity"]])
    scans = _number(row[at["unique_scans_n"]])
    brand = row[at["brands"]].split(",")[0].strip() or None
    return (
        OFF, code, name, brand, quantity, serving_size, serving if serving and 0 < serving <= 5000 else None,
        guess_unit(None, quantity, serving_size), kcal, *(macros[k] for k in PER_100_KEYS if k != "kcal"),
        json.dumps(extra, separators=(",", ":")) if extra else None,
        int(scans) if scans and scans > 0 else 0, name_key(name), None, None, name_compact(name), None,
    )


def import_off(
    dest: str,
    countries: list[str],
    source: str = OFF_URL,
    http: httpx.Client | None = None,
    progress: Callable[[str], None] = lambda text: None,
) -> Stats:
    """Build a new catalogue from the Open Food Facts CSV export (gzip, tab separated) and swap it in at `dest`.

    Streams the source; nothing is held in memory or unpacked on disk. A cut-off gzip file is read up to its end and
    reported in `Stats.truncated`. Nothing is replaced when the import fails or keeps no product at all.
    """
    tags = _country_tags(countries)
    if not tags:
        raise CatalogImportError("no country given")
    csv.field_size_limit(1 << 30)
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    tmp = dest + ".new"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    stats = Stats()
    con = sqlite3.connect(tmp)
    try:
        con.execute("PRAGMA journal_mode = OFF")
        con.execute("PRAGMA synchronous = OFF")
        con.executescript(SCHEMA)
        lines = _Lines(_chunks(source, http))
        reader = csv.reader(lines, delimiter="\t", quoting=csv.QUOTE_NONE)
        try:
            header = next(reader)
        except StopIteration:
            raise CatalogImportError("the source is empty") from None
        at = {name: i for i, name in enumerate(header)}
        if missing := [c for c in WANTED if c not in at]:
            raise CatalogImportError(f"columns missing in the source: {', '.join(missing)}")
        width = max(at[c] for c in WANTED) + 1
        batch: list[tuple] = []
        while True:
            try:
                row = next(reader)
            except StopIteration:
                break
            except csv.Error:
                stats.read += 1
                stats.broken += 1
                continue
            stats.read += 1
            if stats.read % PROGRESS_EVERY == 0:
                progress(f"{stats.read:,} rows read, {stats.kept:,} kept, {stats.seconds:,.0f} s")
            if len(row) < width:
                stats.broken += 1
                continue
            values = _convert(row, at, tags, stats)
            if values is None:
                continue
            batch.append(values)
            stats.kept += 1
            if len(batch) >= BATCH:
                con.executemany(INSERT, batch)
                batch.clear()
        if batch:
            con.executemany(INSERT, batch)
        stats.truncated = lines.truncated
        if stats.kept == 0:
            raise CatalogImportError("no product matched the filter; the existing catalogue was left alone")
        con.execute("INSERT INTO product_fts (product_fts) VALUES ('rebuild')")
        count = con.execute("SELECT count(*) FROM product").fetchone()[0]
        stats.kept = count  # duplicates of one code collapse into one row
        meta = {"products": str(count), "updated_at": str(int(time.time())), "countries": ",".join(sorted(tags))}
        con.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", meta.items())
        con.commit()
        con.close()
        os.replace(tmp, dest)
    except BaseException:
        con.close()
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise
    return stats


class BlsStats:
    def __init__(self):
        self.read = 0
        self.kept = 0
        self.dropped: dict[str, int] = {}
        self.mapped: dict[str, tuple[str, str]] = {}  # key -> (BLS tag, unit in the table)
        self.missing: list[str] = []  # wanted tags the table has no column for
        self.coverage: dict[str, int] = {}  # key -> number of foods with a value
        self.started = time.monotonic()

    @property
    def seconds(self) -> float:
        return time.monotonic() - self.started


def import_bls(dest: str, source: str, progress: Callable[[str], None] = lambda text: None) -> BlsStats:
    """Build a new catalogue of basic foods from a BLS table (.xlsx or .csv) and swap it in at `dest`.

    Columns are found by their BLS tag; a tag the table lacks only leaves that nutrient unknown (`BlsStats.missing`).
    Nothing is replaced when the table is unreadable or keeps no food at all.
    """
    stats = BlsStats()
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    tmp = dest + ".new"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    con = sqlite3.connect(tmp)
    try:
        con.execute("PRAGMA journal_mode = OFF")
        con.execute("PRAGMA synchronous = OFF")
        con.executescript(SCHEMA)
        rows = iter(tabular.read_rows(source))
        try:
            columns = bls.find_columns(next(rows))
        except StopIteration:
            raise CatalogImportError("the table is empty") from None
        stats.mapped = bls.mapping(columns)
        stats.missing = columns.missing
        counted = enumerate(rows, 1)

        def data_rows() -> Iterator[list[str]]:
            for n, row in counted:
                stats.read = n
                yield row

        batch: list[tuple] = []
        for food in bls.foods(data_rows(), columns, stats.dropped):
            stats.kept += 1
            for key, value in {**food.per_100, **food.extra}.items():
                if value is not None:
                    stats.coverage[key] = stats.coverage.get(key, 0) + 1
            batch.append((
                BLS, food.code, food.name, None, None, None, None, "g", *(food.per_100[k] for k in PER_100_KEYS),
                json.dumps(food.extra, separators=(",", ":")) if food.extra else None, 0, name_key(food.name),
                food.name_en, name_key(food.name_en) if food.name_en else None, name_compact(food.name), name_compact(food.name_en),
            ))
        con.executemany(INSERT, batch)
        if stats.kept == 0:
            raise CatalogImportError("the table has no usable food; the existing catalogue was left alone")
        con.execute("INSERT INTO product_fts (product_fts) VALUES ('rebuild')")
        count = con.execute("SELECT count(*) FROM product").fetchone()[0]
        stats.kept = count  # a repeated code collapses into one row
        meta = {"products": str(count), "updated_at": str(int(time.time())), "source": "BLS 4.0"}
        con.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", meta.items())
        con.commit()
        con.close()
        os.replace(tmp, dest)
    except (BaseException):
        con.close()
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise
    return stats


def _progress(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def _run_off(args) -> int:
    dest = args.db or default_path()
    countries = args.country or ["en:germany"]
    _progress(f"importing {args.source} for {', '.join(countries)} into {dest}")
    try:
        stats = import_off(dest, countries, args.source, progress=_progress)
    except (CatalogImportError, httpx.HTTPError, OSError) as exc:
        print(f"import failed: {exc}", file=sys.stderr)
        return 1
    if stats.truncated:
        _progress("warning: the source ended early (cut-off gzip); everything before that was imported")
    _progress(
        f"done in {stats.seconds:,.0f} s: {stats.read:,} rows read, {stats.kept:,} products kept, "
        f"discarded {stats.other_country:,} other country, {stats.incomplete:,} without name or energy, "
        f"{stats.nonsense:,} implausible values, {stats.broken:,} broken rows"
    )
    return 0


REASONS = {"no_name": "without code or name", "no_energy": "without energy value", "implausible": "implausible values"}


def _run_bls(args) -> int:
    dest = args.db or default_bls_path(default_path())
    _progress(f"importing {args.source} into {dest}")
    try:
        stats = import_bls(dest, args.source, progress=_progress)
    except (CatalogImportError, bls.BlsError, tabular.TableError, OSError, zipfile.BadZipFile) as exc:
        print(f"import failed: {exc}", file=sys.stderr)
        return 1
    dropped = sum(stats.dropped.values())
    reasons = ", ".join(f"{n:,} {REASONS.get(r, r)}" for r, n in sorted(stats.dropped.items())) or "none"
    _progress(
        f"done in {stats.seconds:,.1f} s: {stats.read:,} rows read, {stats.kept:,} foods kept, "
        f"{dropped:,} discarded ({reasons}); {len(stats.mapped)} nutrients mapped"
        + (f", tags missing in the table: {', '.join(stats.missing)}" if stats.missing else ", no tag missing")
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mahlwerk.catalog", description="Manage the local food catalogue.")
    sub = parser.add_subparsers(dest="command", required=True)
    imp = sub.add_parser("import-off", help="build the product catalogue from the Open Food Facts CSV export")
    imp.add_argument("--country", action="append", help="countries_tags value, repeatable (default: en:germany)")
    imp.add_argument("--source", default=OFF_URL, help="URL or local .csv.gz file (default: the official export)")
    imp.add_argument("--db", default=None, help="catalogue file (default: MAHLWERK_CATALOG_DB or catalog.db next to the main database)")
    imp.set_defaults(run=_run_off)
    basic = sub.add_parser("import-bls", help="build the basic foods catalogue from a BLS 4.0 table (.xlsx or .csv)")
    basic.add_argument("source", help="the BLS data file, .xlsx or .csv")
    basic.add_argument("--db", default=None, help="catalogue file (default: MAHLWERK_CATALOG_BLS_DB or catalog-bls.db next to the other catalogue)")
    basic.set_defaults(run=_run_bls)
    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())

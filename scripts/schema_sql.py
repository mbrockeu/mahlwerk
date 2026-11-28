"""Write ts/core/schema.sql: the schema of a fresh Python database, as the TS side applies it (tables, then indexes, then triggers, each
in creation order). Run after a schema change: `PYTHONPATH=src python scripts/schema_sql.py`; tests/test_db.py checks that it is current."""

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = {"table": 0, "index": 1, "trigger": 2}


def dump(path: str) -> str:
    con = sqlite3.connect(path)
    try:
        rows = con.execute("SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").fetchall()
    finally:
        con.close()
    return "".join(sql + ";\n" for _, sql in sorted(rows, key=lambda r: ORDER[r[0]]))


def ts_steps() -> list[Path]:
    """The migrations only the TS side has (v22 on): the Python server stops at schema 21, the TS server goes on from there."""
    steps = [p for p in (ROOT / "ts" / "core" / "migrations").glob("v*.sql") if int(p.stem[1:]) > 21]
    return sorted(steps, key=lambda p: int(p.stem[1:]))


def fresh(with_ts_steps: bool = True) -> str:
    """The schema of a new database: the Python one, with the TS-only steps applied unless `with_ts_steps` is False."""
    from mahlwerk.db import Store
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d) / "fresh.db")
        Store(path)
        if with_ts_steps:
            con = sqlite3.connect(path)
            try:
                for step in ts_steps():
                    con.executescript(step.read_text())
                con.commit()
            finally:
                con.close()
        return dump(path)


if __name__ == "__main__":
    target = ROOT / "ts" / "core" / "schema.sql"
    target.write_text(fresh())
    print(f"wrote {target}", file=sys.stderr)

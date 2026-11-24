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


def fresh() -> str:
    from mahlwerk.db import Store
    with tempfile.TemporaryDirectory() as d:
        Store(str(Path(d) / "fresh.db"))
        return dump(str(Path(d) / "fresh.db"))


if __name__ == "__main__":
    target = ROOT / "ts" / "core" / "schema.sql"
    target.write_text(fresh())
    print(f"wrote {target}", file=sys.stderr)

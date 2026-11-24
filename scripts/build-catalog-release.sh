#!/usr/bin/env bash
# Build the Open Food Facts catalogue for the app (Germany) as a release file plus its manifest (.github/workflows/catalog.yml).
# Usage: scripts/build-catalog-release.sh OUTDIR [SOURCE] [MIN_PRODUCTS]
#   SOURCE: URL or local .csv.gz (default: the official export), MIN_PRODUCTS: refuse a smaller catalogue (default 100000).
# Writes OUTDIR/catalog-de-YYYY-MM-DD.db.gz and OUTDIR/catalog.json; the manifest names the file by its address below the release
# `catalog` (RELEASE_BASE). The app checks the sha256 of the .gz before it replaces its catalogue.
set -euo pipefail
out=${1:?output directory}
source=${2:-https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz}
min=${3:-100000}
base=${RELEASE_BASE:-https://github.com/mbrockeu/mahlwerk/releases/download/catalog}
day=$(date -u +%F)
mkdir -p "$out"
db="$out/catalog.db"
rm -f "$db" "$db-wal" "$db-shm"
python -m mahlwerk.catalog import-off --country en:germany --source "$source" --db "$db" 2>&1 | tee "$out/import.log"
if grep -q "source ended early" "$out/import.log"; then echo "the export was cut off: no release" >&2; exit 1; fi
python - "$db" "$min" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
if c.execute("PRAGMA quick_check").fetchone()[0] != "ok": sys.exit("quick_check failed")
n = c.execute("SELECT count(*) FROM product").fetchone()[0]
if n < int(sys.argv[2]): sys.exit(f"only {n} products: no release")
c.execute("PRAGMA journal_mode=DELETE"); c.execute("VACUUM"); c.close()
PY
name="catalog-de-$day.db.gz"
gzip -9 -n -c "$db" > "$out/$name"
python - "$db" "$out/$name" "$base/$name" "$day" > "$out/catalog.json" <<'PY'
import hashlib, json, os, sqlite3, sys
db, gz, url, day = sys.argv[1:]
meta = dict(sqlite3.connect(db).execute("SELECT key, value FROM meta").fetchall())
h = hashlib.sha256()
with open(gz, "rb") as f:
    for block in iter(lambda: f.read(1 << 20), b""): h.update(block)
print(json.dumps({
    "version": 1, "url": url, "sha256": h.hexdigest(), "bytes": os.path.getsize(gz), "db_bytes": os.path.getsize(db),
    "products": int(meta.get("products", 0)), "countries": meta.get("countries", ""), "built_at": day,
    "license": "Open Database License (ODbL) 1.0, contents: Database Contents License (DbCL) 1.0",
    "attribution": "Data from Open Food Facts (https://world.openfoodfacts.org), contributors of Open Food Facts",
}, indent=2))
PY
rm -f "$db"
ls -l "$out"

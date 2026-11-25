#!/bin/sh
# Runs the in-scope Python API tests (ts/api_tests.txt) against the TS server and prints the summary line.
# Only one run at a time on this machine (flock), several worktrees may call it.
# Usage: ts/api-tests.sh [filter, e.g. test_diary]   (MAHLWERK_TS_TB=short shows the failures; MAHLWERK_PY: the Python, default python3)
cd "$(dirname "$0")/.." || exit 1
PY=${MAHLWERK_PY:-python3}  # a Python with the test dependencies (pip install -e ".[test]"), e.g. MAHLWERK_PY=.venv/bin/python
ids=$(mktemp)
grep -- "${1:-.}" ts/api_tests.txt > "$ids"
[ -s "$ids" ] || { echo "no test in ts/api_tests.txt matches '$1'" >&2; rm -f "$ids"; exit 2; }   # an empty list would run every test
flock /tmp/mahlwerk-ts-tests.lock systemd-run --scope -q -p CPUQuota=600% -p MemoryMax=4G nice env MAHLWERK_TS=1 \
  "$PY" -m pytest -q -p no:cacheprovider --tb="${MAHLWERK_TS_TB:-no}" "@$ids" 2>&1 | grep -v "^FAILED" | tail -"${MAHLWERK_TS_LINES:-1}"
rm -f "$ids"

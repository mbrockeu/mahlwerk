#!/bin/sh
# Cross-read check: what the Python server writes, the TS server must read and verify, and the other way round. Temp files only.
# Usage: ts/crosscheck/run.sh   (exit status 0 = every check passed; MAHLWERK_PY: a Python with the dependencies, default python3)
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
PY=${MAHLWERK_PY:-python3}  # a Python with the test dependencies (pip install -e ".[test]"), e.g. MAHLWERK_PY=.venv/bin/python
NODE=${MAHLWERK_TS_NODE:-/opt/node22/bin/node}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export PYTHONPATH="$root/src"
unset MAHLWERK_SECRET_KEY
mkdir "$tmp/py" "$tmp/ts"
echo "--- Python writes, TS reads"
"$PY" "$here/python_side.py" write "$tmp/py"
(cd "$root/ts" && "$NODE" --experimental-strip-types --disable-warning=ExperimentalWarning crosscheck/ts_side.ts read "$tmp/py")
echo "--- TS writes, Python reads"
(cd "$root/ts" && "$NODE" --experimental-strip-types --disable-warning=ExperimentalWarning crosscheck/ts_side.ts write "$tmp/ts")
"$PY" "$here/python_side.py" read "$tmp/ts"
echo "cross-read check passed"

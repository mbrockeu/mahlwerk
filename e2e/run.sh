#!/usr/bin/env bash
# Usage: e2e/run.sh <python|ts> [test-file-glob...]
# One fresh server + temp DB per test file; files named *.local.test.mjs run with MAHLWERK_AUTH=local, the rest with =single.
set -u
target=${1:-}; shift || true
case "$target" in python|ts) ;; *) echo "usage: $0 <python|ts> [tests/x.test.mjs ...]" >&2; exit 2;; esac
here=$(cd "$(dirname "$0")" && pwd); root=$(dirname "$here")
export PATH=/opt/node22/bin:$PATH
if [ -z "${MW_WRAPPED:-}" ]; then   # shared machine: serialize, one browser at a time, capped
  MW_WRAPPED=1 exec flock /tmp/mahlwerk-ts-tests.lock systemd-run --scope -q -p CPUQuota=600% -p MemoryMax=4G \
    nice env MW_WRAPPED=1 "$0" "$target" "$@"
fi
[ -f "$root/web/dist/index.html" ] || { echo "build the frontend first: cd frontend && npm run build" >&2; exit 2; }
tmp=$(mktemp -d /tmp/mw-e2e.XXXXXX); export MW_SHOTS=$tmp/shots; mkdir -p "$MW_SHOTS"
srv=""; trap '[ -n "$srv" ] && kill "$srv" 2>/dev/null; wait 2>/dev/null' EXIT
cd "$here"
files=("$@"); [ ${#files[@]} -eq 0 ] && files=(tests/*.test.mjs)
fail=0; t0=$(date +%s)
for f in "${files[@]}"; do
  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  mode=single; case "$f" in *.local.test.mjs) mode=local;; esac
  d=$tmp/db-$$-$port; mkdir -p "$d"
  export MAHLWERK_DB=$d/m.db MAHLWERK_WEB_DIR=$root/web/dist MAHLWERK_AUTH=$mode \
    MAHLWERK_ALLOWED_HOSTS=127.0.0.1:$port,localhost:$port MAHLWERK_CATALOG_REFRESH=off
  if [ "$target" = python ]; then
    PYTHONPATH=$root/src /root/mahlwerk/.venv/bin/python -m uvicorn mahlwerk.main:app --factory --host 127.0.0.1 --port "$port" >"$tmp/server.log" 2>&1 &
  else
    MAHLWERK_PORT=$port MAHLWERK_HOST=127.0.0.1 node --experimental-strip-types --disable-warning=ExperimentalWarning "$root/ts/server/main.ts" >"$tmp/server.log" 2>&1 &
  fi
  srv=$!
  up=0; for _ in $(seq 60); do
    kill -0 "$srv" 2>/dev/null || break
    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Mahlwerk-Request: 1' "http://127.0.0.1:$port/api/v1/auth/status" 2>/dev/null)
    [ "$code" != 000 ] && { up=1; break; }   # any HTTP answer: the server is listening
    sleep 0.5; done
  if [ $up = 0 ]; then echo "SERVER DID NOT START ($target, $f); log tail:"; tail -n 8 "$tmp/server.log"; fail=1; kill "$srv" 2>/dev/null; srv=""; continue; fi
  echo "== $f  ($target, auth=$mode, port $port)"
  for u in "" api/v1/auth/status api/v1/me; do   # what the server under test offers at all (frontend, auth status, profile)
    echo "   GET /$u -> $(curl -s -o /dev/null -w '%{http_code}' -H 'X-Mahlwerk-Request: 1' "http://127.0.0.1:$port/$u")"; done
  MW_BASE=http://127.0.0.1:$port MW_AUTH=$mode node --test --test-concurrency=1 "$f" || fail=1
  kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null; srv=""
  [ $fail != 0 ] && cp "$tmp/server.log" "$tmp/server-$(basename "$f").log" 2>/dev/null
done
echo "total $(( $(date +%s) - t0 ))s, $([ $fail = 0 ] && echo PASSED || echo FAILED) ($target)"
if [ -n "$(ls -A "$MW_SHOTS" 2>/dev/null)" ]; then echo "failure screenshots and server log kept in $tmp"; else rm -rf "$tmp"; fi
exit $fail

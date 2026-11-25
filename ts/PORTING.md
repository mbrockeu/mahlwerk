# Porting the backend to TypeScript – rules for every package

Goal: the TS server answers `/api/v1` exactly like the Python server (src/mahlwerk) on the same SQLite file (schema v21).
The frontend and the iOS app must not notice the switch. Python stays the reference until the switch.

## Layout
- `core/` – no `node:*`, no `fs`, no `sharp`: it must later run inside an app. Handlers, store functions, domain logic.
  - `core/routes/<group>.ts` – one file per route group (like `src/mahlwerk/routes/<group>.py`), exports `routes`; register in `core/routes/index.ts`.
  - `core/store/<area>.ts` – the SQL of `db.py` for that area, as plain functions taking `ctx` (or `db`). No classes, no ORM.
  - `core/<module>.ts` – the pure logic of `src/mahlwerk/<module>.py`.
- `server/` – Node only: HTTP, node:sqlite adapter, later images (sharp), outgoing HTTP.
- `app/` – the app host (no `node:*` either): core for one device inside the iOS app's web view, see "App-Host" below.
- `core/schema.sql` is generated from a fresh Python database (`PYTHONPATH=src python scripts/schema_sql.py`; tests/test_db.py checks it).
  Never edit it by hand. The TS server never migrates: it refuses other versions. The one exception is the app (see App-Host): it runs
  `core/migrations/v21.sql` (the same text as db.py's `V21_TABLES`, a test checks that) on a v20 database on the phone.
- `uid` (v21): diary entries, workouts, fasts, templates, recipes, recipe groups and foods get a random id from an AFTER INSERT trigger
  whatever code inserts them; the export carries it, the import (`core/dataImport.ts`) matches on it. An edit must keep a row (UPDATE),
  never delete and insert it again.

## The ladder (Ponytail) – before writing any code, take the first option that fully works
1. Does it need to exist? (dead code, unused parameters, Python-only workarounds: leave them out, name them in the report)
2. Is it already in `core/` (or in `frontend/src/lib/` as pure logic)? Reuse, don't write a second one.
3. Standard library / platform (Node 22, `Intl`, WebCrypto, `fetch`)?
4. An installed dependency (zod)? Never add a dependency for a few lines; a new one needs a reason in the report.
5. One line a reader gets at a glance?
6. Otherwise the minimum code that works.

Never cut: validation at trust boundaries, error handling that prevents data loss, security checks, anything a test expects.
Security code (auth, sessions, tokens, OIDC, vault, netguard/SSRF, upload checks) is ported 1:1, not "improved".

## Parity – behaviour must be identical
- Python `round()` rounds half to even (`round(0.5) == 0`, `round(2.5) == 2`); `Math.round` does not. Use `roundHalfEven` from `core/num.ts`.
- JSON: `null` vs. missing key matters; pydantic drops nothing unless `exclude_none`. Check the Python response model.
- 422 bodies: `{"detail": [{type, loc, msg}]}` via `parse()` from `core/http.ts`. Tests usually check only the status and `loc`.
- HTTPException → `throw new HttpError(status, detail)`.
- Text: Python `casefold()`/`lower()`, `ß`, `strip()` (Unicode whitespace) – check what the Python code does.
- Dates are ISO strings `YYYY-MM-DD`; times are integer seconds (`int(time.time())`) – use `ctx.now()` where Python uses the app clock, `Date.now()` where it uses time.time().
- Stored JSON: write with `toJson()` (refuses NaN); read with `JSON.parse`.

## Tests
- The Python API tests are the contract: `ts/api-tests.sh <file filter>` runs the in-scope tests (ts/api_tests.txt) against the
  TS server. `MAHLWERK_TS_TB=short MAHLWERK_TS_LINES=60 ts/api-tests.sh test_diary` shows failures. `MAHLWERK_PY` names the Python
  with the test dependencies (default `python3`; e.g. `MAHLWERK_PY=.venv/bin/python`), the same for `ts/crosscheck/run.sh` and `e2e/run.sh python`.
- Run only your own files while working. The full list (`ts/api-tests.sh`) once at the end.
- Never change a Python test to make TS pass. If a test checks Python internals it is not in the list; that is fine.
- Typecheck: `cd ts && PATH=/opt/node22/bin:$PATH npx tsc --noEmit -p .` must stay clean.
- Heavy runs are throttled already by the script; never start a second suite or a browser in parallel.

## App-Host
The same interface and core run in the iOS app (WKWebView), the data in SQLite on the phone. `ts/app/localHost.ts` builds the ctx
like `server/main.ts` for one device and answers requests in-process through `core/dispatch.ts` (the router the server uses), without
host check, CSRF and security headers; the body limit stays. Fixed off (`APP_ENV`): tokens, webhooks, Cookidoo pictures, web recipes, Yazio
sign-in, demo account, photo recognition / label reader, demo data; the catalogue refresh loads the file the workflow
`.github/workflows/catalog.yml` publishes (`ts/app/catalogDownload.ts`: manifest over `http`, then `download`); the Yazio file import and the
import of an own export (`/me/import/*`, `core/dataImport.ts`) are on;
no picture service (501 like a server without one). Auth is `single`. Cookidoo is on (shared and own account; the
vault key comes from the keychain, see `secretKey`).
- Build: `cd frontend && npm run build:app` -> `web/dist-app/` (index.html + assets; entry `src/appMain.ts`, which sets
  `window.mahlwerkLocal`; `src/lib/local.ts` routes `request()`, pictures and the export through it). `npm run build` is unchanged.
- Schema: an empty database gets `core/schema.sql`; a v20 database (phones that had the app before v21) is migrated by
  `openLocal({..., migrations: {20: core/migrations/v21.sql}})` (`src/appMain.ts` passes it) in one transaction, rolled back on error;
  any other version is refused (SchemaMismatch). The server never passes `migrations`.
- Data import: the export (ZIP) of the server can be imported in the app and the other way round (`POST /me/import/preview`, then
  `/me/import/confirm` with the token; docs/api-v1.md "Importing an own export"). Unpacking uses DecompressionStream; the import is one
  transaction with batched inserts (`INSERT … SELECT … FROM json_each(?)`): 15,000 diary entries take about 400 bridge ops.
- Tests: `ts/tests/appHost.test.ts` (node:sqlite stand-in of the native side, `tests/appBridge.ts`); `e2e/run.sh app` runs the
  browser flows against `web/dist-app` with SQLite WASM in a SharedWorker as the native side (`e2e/app/`).
- Bridge (JS calls `await window.webkit.messageHandlers.mahlwerkNative.postMessage({op, ...})`, a handler with reply; a failure
  is a rejection whose message is the native error text). The native side handles the ops strictly one after another, in arrival order.
  - `{op:"sql", db:"main"|"bls"|"catalog", sql, args}` -> `{rows:[{col:value}], changes, lastId}`. One statement (also PRAGMA and
    `... RETURNING`, rows for all of them). `args`: a list (positional `?`) or an object whose keys have no prefix (`{w:1}` binds
    `:w`; a name may occur several times in the SQL). Values: null, number, string, `{b64}` for a BLOB, in both directions.
    Bind every number with sqlite3_bind_double: node:sqlite (the server) binds all JS numbers as REAL, so TEXT columns and
    `typeof()` see the same as on the server. Read INTEGER and REAL as JSON numbers.
    `changes`/`lastId`: sqlite3_changes / sqlite3_last_insert_rowid after the statement. Errors: the sqlite3_errmsg text
    (core matches e.g. `constraint`). `bls`/`catalog` read-only; a missing file: error `missing`.
  - `{op:"exec", db:"main", sql}` -> `{}`: sqlite3_exec, several statements in one call (the schema is sent as
    `BEGIN; …; PRAGMA user_version = 21; COMMIT;`, the v20 → v21 step as `BEGIN IMMEDIATE; …; COMMIT;`), BEGIN IMMEDIATE / COMMIT / ROLLBACK. The JS side holds the transaction lock.
  - `{op:"http", method, url, headers, bodyB64|null, timeoutMs, connectTimeoutMs, maxBytes}` -> `{status, headers, bodyB64}`:
    no redirects followed, no cookies stored or added (URLSession: `httpShouldSetCookies = false`, no cookie storage), the request
    headers sent as given (also `User-Agent` and `Cookie`). Errors start with `timeout`, `too_large` or `connect` (anything else counts
    as other). Used by the Open Food Facts lookup and Cookidoo (its client follows redirects by hand and keeps its own cookies);
    there is no DNS op, so every netguard-checked target is refused.
  - `{op:"secretKey"}` -> `{keyB64}`: 32 random bytes, made once and kept in this device's keychain (not in the database, not in
    the export): the key of the stored secrets (Cookidoo accounts). Anything but 32 bytes, or an error: storing is refused (503).
  - `{op:"download", target:"catalog", url, sha256, bytes, db_bytes}` -> `{}` at once (error `busy` while one runs): loads in the
    background (https redirects followed), checks the sha256 of the .gz, unpacks, `PRAGMA quick_check`, swaps the catalogue file
    atomically and reopens it read-only. `{op:"downloadStatus"}` -> `{state:"idle"|"running"|"done"|"failed", bytes, total, error}`.
  - The other way round (native -> core): `await window.mahlwerkHost.request({method, path, query, body})` -> `{status, body}`, set
    once the page has opened the database (`localHost.ts` `hostRequest`). `path` starts with `/api/`, `query` an object, `body` JSON
    text, an object or null; the answer's `body` is JSON text or null. For the Health sync, the history, summary/today and the
    widget's water button; runs in core like a request of the page.
  - When the web view loads a page (reload, crash), an open transaction must be rolled back; the JS side also sends a
    `ROLLBACK` (error ignored) before it opens the database.

## Report (end of every package)
1. Routes ported (list) and test result of your files (passed/total).
2. Left out / replaced by platform / reused – one line each.
3. New dependencies with reason (ideally none).
4. Open: failing tests with the reason, unchecked things, risks.

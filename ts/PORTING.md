# Porting the backend to TypeScript – rules for every package

Goal: the TS server answers `/api/v1` exactly like the Python server (src/mahlwerk) on the same SQLite file (schema v20).
The frontend and the iOS app must not notice the switch. Python stays the reference until the switch.

## Layout
- `core/` – no `node:*`, no `fs`, no `sharp`: it must later run inside an app. Handlers, store functions, domain logic.
  - `core/routes/<group>.ts` – one file per route group (like `src/mahlwerk/routes/<group>.py`), exports `routes`; register in `core/routes/index.ts`.
  - `core/store/<area>.ts` – the SQL of `db.py` for that area, as plain functions taking `ctx` (or `db`). No classes, no ORM.
  - `core/<module>.ts` – the pure logic of `src/mahlwerk/<module>.py`.
- `server/` – Node only: HTTP, node:sqlite adapter, later images (sharp), outgoing HTTP.
- `app/` – the app host (no `node:*` either): core for one device inside the iOS app's web view, see "App-Host" below.
- `core/schema.sql` is generated from a fresh Python database. Never edit it, never migrate: TS refuses other versions.

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
  TS server. `MAHLWERK_TS_TB=short MAHLWERK_TS_LINES=60 ts/api-tests.sh test_diary` shows failures.
- Run only your own files while working. The full list (`ts/api-tests.sh`) once at the end.
- Never change a Python test to make TS pass. If a test checks Python internals it is not in the list; that is fine.
- Typecheck: `cd ts && PATH=/opt/node22/bin:$PATH npx tsc --noEmit -p .` must stay clean.
- Heavy runs are throttled already by the script; never start a second suite or a browser in parallel.

## App-Host
The same interface and core run in the iOS app (WKWebView), the data in SQLite on the phone. `ts/app/localHost.ts` builds the ctx
like `server/main.ts` for one device and answers requests in-process through `core/dispatch.ts` (the router the server uses), without
host check, CSRF and security headers; the body limit stays. Fixed off (`APP_ENV`): tokens, webhooks, Cookidoo, web recipes, Yazio
sign-in, demo account, photo recognition / label reader, demo data, catalogue refresh; the Yazio file import routes are left out;
no picture service (501 like a server without one). Auth is `single`.
- Build: `cd frontend && npm run build:app` -> `web/dist-app/` (index.html + assets; entry `src/appMain.ts`, which sets
  `window.mahlwerkLocal`; `src/lib/local.ts` routes `request()`, pictures and the export through it). `npm run build` is unchanged.
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
    `BEGIN; …; PRAGMA user_version = 20; COMMIT;`), BEGIN IMMEDIATE / COMMIT / ROLLBACK. The JS side holds the transaction lock.
  - `{op:"http", method, url, headers, bodyB64|null, timeoutMs, connectTimeoutMs, maxBytes}` -> `{status, headers, bodyB64}`:
    no redirects followed, no cookies stored. Errors start with `timeout`, `too_large` or `connect` (anything else counts as other).
    Only the Open Food Facts lookup uses it; there is no DNS op, so every netguard-checked target is refused.
  - When the web view loads a page (reload, crash), an open transaction must be rolled back; the JS side also sends a
    `ROLLBACK` (error ignored) before it opens the database.

## Report (end of every package)
1. Routes ported (list) and test result of your files (passed/total).
2. Left out / replaced by platform / reused – one line each.
3. New dependencies with reason (ideally none).
4. Open: failing tests with the reason, unchecked things, risks.

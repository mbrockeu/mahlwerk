# Mahlwerk UI smoke tests (e2e)

Playwright (`playwright-core`, system Chromium, headless) drives the built frontend against a real server. The same suite is
meant to decide whether the TypeScript backend (`ts/`) can replace the Python one: it has to pass against Python first.

## Run

```sh
# once: the frontend build the server serves (web/dist) and the test dependency
(cd frontend && PATH=/opt/node22/bin:$PATH npm run build)
(cd e2e && PATH=/opt/node22/bin:$PATH npm install)

e2e/run.sh python            # Python server (the src/ of this checkout; MAHLWERK_PY=.venv/bin/python if it is not python3)
e2e/run.sh ts                # TypeScript server (ts/server/main.ts)
e2e/run.sh python tests/day.test.mjs     # only some files
```

`run.sh` takes `/tmp/mahlwerk-ts-tests.lock`, runs under `systemd-run` (6 CPUs, 4 GB) and `nice`, and starts a fresh server with a
temp DB and a free port for every test file (`MAHLWERK_AUTH=single`, or `local` for `*.local.test.mjs`; no outgoing network is
used). One browser at a time, no parallel workers. Exit code 0 = everything passed.

On failure a screenshot per test and the server log are kept in a `/tmp/mw-e2e.*` directory (named at the end of the run).

## Layout

- `lib.mjs`: launch, page with fail-on-`pageerror` / failed `/api/` response (>= 500), API client for test data (header `X-Mahlwerk-Request`).
- `expect.mjs`: a few polling assertions (playwright-core has no `expect`).
- `tests/*.test.mjs`: one file per area: day, food, recipe (+ templates), waterfast, weight, insights, badges (+ training card), settings, export, `auth.local`.

Test data is created through the UI where the flow is the subject, otherwise through the public HTTP API (never through the Python store).
The UI language is English (`locale: 'en-US'`); selectors are roles, labels and text.

## Current state

- `python`: all green (about 35 s).
- `ts`: expected to fail for now: the TS server serves no frontend (`GET /` is 404) and has no `auth/status`, `me`, `me/settings`
  or local sign-in yet; the run lists what each URL answers and every test file fails on its first call.

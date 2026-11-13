# Contributing

Thanks for your interest in Mahlwerk. It is a young, small project; issues and pull requests are welcome.
Please open an issue before starting larger changes.

## Repository layout

| Path | Content |
| --- | --- |
| `src/mahlwerk/` | FastAPI backend (SQLite storage, routes in `routes/`, catalogue and import tools) |
| `tests/` | Backend tests (pytest) |
| `frontend/` | Svelte 5 + TypeScript interface (Vite); builds into `web/dist` |
| `frontend/tests/` | Frontend unit tests (Node test runner) |
| `docs/` | API contract (`api-v1.md`), integrations, design direction (`design/`) |

## Backend

```sh
python3 -m venv .venv
.venv/bin/pip install -e ".[test]"     # add the label extra with ".[test,label]" to work on the label reader
.venv/bin/pytest
```

Python 3.11 or newer; CI uses 3.13. Tests use temporary databases and do not need network access.

## Frontend

```sh
cd frontend
npm ci
npm run check     # svelte-check / TypeScript
npm test          # unit tests
npm run build     # writes ../web/dist, which the backend serves
npm run dev       # Vite dev server on 127.0.0.1
```

Node 20 or newer; CI uses 22. To see the built interface from the backend, run the server as described in the
[README](README.md#quick-start); it serves `web/dist` by default.

## Website and demo

The project page lives in `site/` (plain HTML and CSS, German page in `site/de/`, screenshots in `site/img/`). The demo is the real
interface built with `VITE_MOCK=1 VITE_DEMO=1`: the in-memory mock replaces the API, a banner points back to the site, the camera
scan offers a sample product, and there is no web app manifest. A normal build ignores `VITE_DEMO`.

```sh
cd frontend && npm ci && cd ..
scripts/build-site.sh                                  # writes _site/ (ignored by git)
python3 -m http.server 8125 --bind 127.0.0.1 --directory _site
```

The GitHub Actions workflow `pages.yml` publishes `_site/` to GitHub Pages on pushes to `main`, only while the repository is public.

The look follows [docs/design](docs/design/README.md): read it before changing colours, shapes or motion.
Fonts and scripts are self-hosted; do not add requests to third-party hosts at runtime.

## Style

- English for code, comments, commit messages and documentation. The interface strings live in
  `frontend/src/lib/i18n.ts`.
- Follow the style of the surrounding code; keep changes small and focused, with a test where it makes sense.
- Commit messages say what changed and why.
- Never commit secrets, real diary data or `.env` files.
- A change to the API belongs in [docs/api-v1.md](docs/api-v1.md) too.

## Product data

Wrong or missing product data (names, nutrients, barcodes) comes from [Open Food Facts](https://world.openfoodfacts.org)
and should be corrected there, not here. Mahlwerk only reads it.

## Licence

By contributing you agree that your contribution is licensed under the [AGPL-3.0-or-later](LICENSE).

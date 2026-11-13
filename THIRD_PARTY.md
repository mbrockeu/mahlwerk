# Third-party components

Mahlwerk itself is licensed under the [AGPL-3.0-or-later](LICENSE). This file lists what it bundles, depends on or
loads data from. Licences were read from the installed package metadata; entries marked **unverified** could not be
confirmed from files in this repository or the installed packages.

## Bundled files

### Fonts (`frontend/src/assets/fonts/`)

All under the SIL Open Font License 1.1. The licence text with the copyright notice sits next to the files
(`LICENSE.bricolage-grotesque`, `LICENSE.schibsted-grotesk`, `LICENSE.ibm-plex-mono`).

| Font | Files |
| --- | --- |
| Bricolage Grotesque | 800 (latin) |
| Schibsted Grotesk | 400, 500, 600 (latin) |
| IBM Plex Mono | 500, 600 (latin) |

### Barcode scanning (`frontend/public/vendor/`)

| Component | Licence | Notes |
| --- | --- | --- |
| [barcode-detector](https://github.com/Sec-ant/barcode-detector) (ponyfill, `barcode-detector-ponyfill.js`) | MIT | Licence text in `LICENSE.barcode-detector`. Bundled version: unverified. |
| [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (`zxing_reader.wasm`) | MIT | Licence text in `LICENSE.zxing-wasm`. The WebAssembly build contains ZXing-C++, whose licence (Apache-2.0) is unverified here. Bundled version: unverified. |

## Python runtime dependencies

Direct dependencies (`pyproject.toml`); licences from the versions installed in the development environment.

| Package | Licence |
| --- | --- |
| fastapi | MIT |
| pydantic | MIT |
| uvicorn | BSD-3-Clause |
| httpx | BSD-3-Clause |
| cryptography | Apache-2.0 OR BSD-3-Clause (dual licence, as stated in its package metadata) |
| starlette (via fastapi) | BSD-3-Clause |
| Pillow (recipe pictures; the wheels bundle libjpeg-turbo, libpng, zlib, libwebp, Little CMS and others, see the licence files in the wheel) | MIT-CMU |

Their further transitive dependencies (anyio, click, h11, httpcore, idna, certifi, typing-extensions and others)
are not listed one by one; check them with `pip-licenses` if you need a complete list.

### Optional: label reader (`pip install ".[label]"`)

| Package | Licence |
| --- | --- |
| rapidocr-onnxruntime (includes the PaddleOCR PP-OCRv4 detection/recognition and mobile v2.0 classification models as `.onnx` files) | Apache-2.0 (package); licence of the bundled models is Apache-2.0 per the project, unverified here |
| onnxruntime | MIT |
| opencv-python | Apache-2.0 (the wheel also bundles third-party libraries, see its `LICENSE-3RD-PARTY.txt`) |
| numpy | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| Pillow | MIT-CMU |
| PyYAML | MIT |
| Shapely | BSD-3-Clause (wheel also bundles GEOS, see `LICENSE_GEOS`) |
| pyclipper | MIT |
| six | MIT |
| tqdm | MPL-2.0 AND MIT |
| protobuf | BSD-3-Clause |
| flatbuffers | Apache-2.0 |

### Optional: Cookidoo connector (`pip install ".[cookidoo]"`, Python 3.12 or newer)

| Package | Licence |
| --- | --- |
| cookidoo-api 0.19.0 (unofficial; Cyrill Raccaud and contributors) | MIT |
| aiohttp | Apache-2.0 AND MIT |
| firebase-messaging | MIT |
| aiofiles | Apache-2.0 |
| isodate | BSD-3-Clause |

The package talks to Cookidoo (Vorwerk) through an interface that Cookidoo does not document or support; Mahlwerk does
not redistribute any Cookidoo content. Transitive dependencies of these (yarl, multidict and others) are not listed one by one.

### Development and tests

pytest (MIT).

## Frontend build dependencies (npm)

These are used to build the interface and are not shipped as separate files; the build output contains the compiled
Svelte runtime.

| Package | Licence |
| --- | --- |
| svelte | MIT |
| vite | MIT |
| @sveltejs/vite-plugin-svelte | MIT |
| @tsconfig/svelte | MIT |
| svelte-check | MIT |
| typescript | Apache-2.0 |

Transitive npm packages are listed in `frontend/package-lock.json`; their licences were not checked individually
(unverified).

## Data sources

Mahlwerk ships **no** food data. Each installation fetches or imports its own.

- **Open Food Facts** (<https://world.openfoodfacts.org>): the database is available under the Open Database
  License (ODbL), its individual contents under the Database Contents License (DbCL), and product images under
  CC BY-SA. Attribution is required. Mahlwerk queries the API per barcode and can build a local catalogue from the
  official export.
- **Bundeslebensmittelschlüssel (BLS) 4.0**, Max Rubner-Institut (2025), Karlsruhe,
  DOI [10.25826/Data20251217-134202-0](https://doi.org/10.25826/Data20251217-134202-0). The institute provides it
  free of charge "without licence barriers" and names app and software development as a permitted use
  ([blsdb.de/faq](https://blsdb.de/faq), question 17); it states no named licence and says nothing about passing the
  data on. The data is therefore **not** included: every installation downloads the file itself and uses it under the
  institute's terms. Suggested citation (blsdb.de, question 16): Max Rubner-Institut (2025): Bundeslebensmittelschlüssel
  (BLS), Version 4.0 — Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0.

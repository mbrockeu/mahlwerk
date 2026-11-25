# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **The Docker image and the Compose file run the TypeScript server** (`node:22-slim`, port 8110, user 10001, data in `/data`, health
  check on `/healthz`, clean stop on SIGTERM). The Cookidoo connector is built in (off until switched on) and labels are read by the image
  model, so the build arguments `WITH_LABEL` and `WITH_COOKIDOO` are gone.
- **The Python image is `Dockerfile.python`**: the fallback server and the command-line tools. The Compose service `tools` (profile
  `tools`, same volume) runs them: `docker compose run --rm tools mahlwerk.catalog import-bls /data/BLS.xlsx`, `... mahlwerk.yazio ...`.
- **The TypeScript server migrates schema version 20 to 21 itself** at start (one transaction), so it can take over a Python-era
  database without a detour. Older versions are still refused, with a message that says to start the Python server (the `tools` service) once.

## [0.4.0] - 2026-11-25

### Added
- **TypeScript server.** `ts/` holds a second implementation of the whole `/api/v1` on Node 22.6 or newer, on the same SQLite file and
  with the same answers; the Python test suite is the contract (`ts/api-tests.sh`) and a Playwright suite (`e2e/`) runs the interface
  against either server. It is now the main server. The Python server stays as a fallback: same API, same database, same settings, and
  you can switch back and forth. Start it with `cd ts && npm ci && npm start` (`MAHLWERK_PORT`, default 8120, and `MAHLWERK_HOST`, default
  `127.0.0.1`; all other `MAHLWERK_*` variables as before). The TS server expects schema version 21 (since the next release it also migrates 20 itself, see Unreleased) and
  refuses older versions (start the Python server once on an older file). Not available on the Python server: the data import, see below.
- **The app without a server.** The interface also builds as an app (`cd frontend && npm run build:app`): the same interface and
  the same core run in the iOS app's web view, with the data in SQLite on the phone, a bridge to the native side for SQL, HTTP, the
  keychain and file downloads, and the Health sync, the history and the day summary answered in the app. Yazio file import, import of
  an own export, Cookidoo and the barcode lookup work there; photo recognition, webhooks, access keys and web recipes are off. A phone
  that had the app before is migrated to schema 21 in one transaction.
- **Data import.** Profile, "Import my data": take a Mahlwerk export (the ZIP or its `mahlwerk-export.json`) back in, to move between
  server and app, onto a new device or to bring a backup back. A preview shows per kind what is new, changed, unchanged and skipped (and
  why); then **merge** (deletes nothing; rows that exist are matched by their stable id, a shared product that is newer here keeps its
  version, the goal of the file counts from today) or **replace** (with a warning of what goes first). One transaction, the file's
  rows are checked like every write, nothing is echoed back on an error. Routes `GET /me/import`, `POST /me/import/preview` and
  `/me/import/confirm`; TS server and app only. The app reminds you to export now and then.
- **Schema version 21 with stable ids.** Diary entries, workouts, fasts, templates, recipes, recipe groups and foods get a random `uid` that
  never changes; the migration only adds the column and a trigger. **Export format 2** carries the ids, the links from entries and recipe
  items to their foods, the products and recipe groups the data uses, and the fields a Health sync needs after an import; format 1 files
  are still read.
- **Food catalogue as a monthly release.** A GitHub Actions workflow builds the Open Food Facts catalogue for Germany once a month and
  publishes it as one SQLite file below the release `catalog`, with a manifest (address, size, sha256). The app loads it with "refresh" in
  the admin area, checks the sha256, unpacks, verifies and swaps the file atomically. `scripts/build-catalog-release.sh` builds it by hand.
- Search: the best matches come first (a whole word before the end of a compound before the start of a longer word), and the stored
  products are listed 15 at a time.
- Search: `ß` and `ss` are the same ("heisse" finds "heiße"), and everyday names find basic foods whose official BLS name differs
  ("heiße Schokolade", "Kakaomilch", "Kaba" find the BLS cocoa milk drinks).
- Project site: a section on the iPhone app (coming soon to the App Store) with its two modes, and the page brought up to this version.
- Photo recognition on the TS server also reads nutrition labels with the image model (the Python server uses the local OCR, if installed).
- CI also checks the TS side (type check and tests).

### Changed
- Accessibility: the interface reflows at 200 % zoom and down to very narrow widths (navigation, Today, Insights, Profile, Badges, the add
  sheet, weight, recipes, calendar and page headings wrap instead of overflowing; a heading shrinks rather than breaking inside a word;
  action menus fit beside their trigger). Pinch zoom is allowed again, over the charts too.
- Insights on phones: the header is one line; period, detail, compare and help moved into a sheet.
- Search results show long names on up to two lines, and a catalogue product is only stored as a food when you log it (looking at it
  and going back leaves "Your products" as it was).
- `GET /summary/today`: `kcal_left` is whole kcal, the goal minus the eaten kcal rounded half up, as the day view counts.
- App texts no longer say "this server"; the import table scrolls; the sheet leaves room for the focus ring at its sides.
- A restore from a backup counts the introduction tour as seen, and a fresh state means nothing of the person's own yet.
- Admin technical notes no longer show Python-only command lines.

### Security
- Web recipe parsing and `strip()` on crafted text (also the Cookidoo login page) run in linear time (ReDoS).
- The server reads a request body only after the route and the caller are known, so an unauthenticated request cannot make it read or
  buffer a large body.
- Import: the products of a file are checked like the food routes; strict limits on size, packed-to-unpacked ratio and number of objects.
- Answers of Open Food Facts and of webhook targets have a size limit.
- Staged uploads are dropped when they expire, before every request.
- Dates at the edge of the calendar answer 422 instead of 500; the insights leave out a stored nutrient this version does not know.

### Performance
- Health sync reads the synced days up front and writes only the changes; users are looked up without a transaction per request.
- Product search filters in SQL and reads only the returned rows; badges, the history, the nutrient curve, recipes, templates, diary
  copy and template apply read only what they need and in fewer queries.
- Export: faster rounding and CRC, one query per section, no indentation in the JSON.

## [0.3.0] - 2026-11-24

### Added
- Training motivation: a weekly goal `settings.activity.workouts_week` (0-7 training days, 0 = off; a training day is a day with at least
  10 minutes of workouts in total, a week runs Monday to Sunday). With a goal the activity answer gets a `week` block
  (`{goal, days, done, streak}`) and the activity card a row "This week: 2 of 3 training days" with seven dots and the number of weeks
  in a row that reached the goal. Four new badges for regularity (`first_workout`, `active_week`, `active_month`, `workouts_25`), and
  `GET /insights` gets a `training` block (training days per calendar week, minutes, and logged training days against other days
  in kcal, protein and distance to the goal, from 5 days per side) shown as the card "Training and eating" on the Body tab. Nothing
  rewards pace or energy. `PATCH /me/settings` now changes only the given fields of `activity`. No schema change.
- Favourite combos in the add sheet: the tab "Recent" shows up to 3 sets of foods you often eat together in the chosen meal
  (at least 3 different days of the last 6 weeks), e.g. "Quark · Oats · Berries – 420 kcal". A tap opens a checklist with the amounts
  of the last time (changeable); "Add" books the checked ones into the day and meal of the sheet, with Undo. A combo can be saved as a
  template with one tap (`POST /templates` also takes `items: [{food_id, amount}]`); sets equal to a template are not offered.
  `GET /foods/combos?meal=` is new, `GET /foods/recent` takes an optional `meal` that puts the foods which fit that meal first
  (the single foods in "Recent" now follow the chosen meal). The demo data repeats two habit breakfasts, so the demo shows combos.
- Sleep: `POST /health/sync` takes `sleep_minutes` per day (the night that ends on that morning; under 60 minutes is ignored as
  "watch not worn") and answers a `sleep` count. The evaluation gets a card "Sleep and eating" (tab Body) and `GET /insights` a
  `sleep` block: the average sleep and, for logged days after nights under 6 h against nights of 7 h or more, the mean kcal and the
  distance to each day's own goal (at least 5 days per side; a connection in the data, not a cause). Also in the export and the demo
  data. Schema version 20 (`sleep_day`), the migration only adds the table.
- `GET /summary/today` also returns `meals` (kcal per meal today) and `meal_entries` (entries per meal), so a client can
  tell which meals are already logged, for example to skip a meal reminder.
- Tap a macro tile on the day view to see where that day's protein, carbs or fat came from: per meal with share and the
  foods that gave the most, with tabs to switch between the three.

- Goal history: a changed goal counts from today on, earlier days keep the goal they had. Calendar, adherence, calorie chart
  (the goal line steps where the goal changed), weekly review, badges and the day view of a past day judge each day against
  its own goal; period figures (mean protein against the goal, the macro tiles, the nutrient curve) use the mean of the logged
  days' goals. The goal page says so and lists the changes ("since the start" for the goal from before). New
  `GET /api/v1/me/goal/history`, `period_goal` in `GET /api/v1/insights`, `valid_from` in the `goal.changed` webhook and
  `goal_history` in the export. Schema version 19 (`goal_history`); the migration makes every existing goal the goal since the
  start, so no past verdict changes. A goal from a Yazio import counts since the start and goes with the import.
- Evaluation in five groups: tabs Overview (key figures, weekly review, notes, calendar), Eating (calories, macros,
  weekdays, meals), Body (weight and balance, estimated expenditure, activity), Nutrients and Foods, one at a time; the
  tab is in the address (`#/history?tab=body`) and the period holds for all of them. Replaces the jump buttons; the help
  is grouped the same way and "Show" opens the right tab.
- Nutrient over time: several nutrients are now drawn in their own units, the first unit on a left axis and a second one on
  a right axis (g and kcal, for example; a third unit gets a second chart). Each nutrient's reference (goal or EU reference
  amount) is a dotted line in its colour, and the rows name the axis and the reference. "Together in %" keeps the shared
  percent axis. The choice is remembered on the device.
- Calendar: an info button next to the title says what "within the range" means, with the numbers for your goal (90–110 %, only calories count).
- Help: "Help" in the menu (phone), in the rail (wide) and on the evaluation page opens one sheet. It starts the tour of
  the day view and has an overview of every evaluation card – what it shows, what it needs (e.g. the estimated
  expenditure: 21 days, 6 weights …) and the hidden controls (zoom by tapping a bar, opening a day from the calendar);
  "Show" jumps to the card. Cards not on the page in an empty period say so instead.
- Photo of a meal: foods eaten in the last 14 days come first when they fit a part of the photo, also under a longer name
  (`Vollkornbrot Dinkel, Bäckerei Bauer` for `Vollkornbrot`), and the row says when ("eaten yesterday", "last Fri").
  `POST /api/v1/recipes/ingredients/match` takes `recent`; the candidates carry `eaten_count` and `eaten_last`.
- Photo recognition: a fallback model (`MAHLWERK_VISION_FALLBACK_URL`, `_MODEL`, `_KEY`, `_TEMPERATURE`) is asked when the first model cannot be reached, refuses the request or is busy (not after a timeout or an unusable answer); the admin card names it. `MAHLWERK_VISION_TEMPERATURE=off` leaves out `temperature: 0`, which some hosted models refuse.
- `GET /api/v1/history` carries the water of each day: `water_ml` (the water counter) and `water_drinks_ml` (water from drinks in the diary), so a client such as the iOS app can write daily totals to Apple Health. No schema change.
- Direct links for shortcuts and the iOS app: `/?go=scan`, `/?go=add`, `/?go=recent`, `/?go=templates`, each with an optional `&meal=breakfast|lunch|snack|dinner` (without it the meal follows the time of day). Once signed in the add sheet opens on that tab for today and the parameters leave the address; a query parameter rather than the hash, so it survives the sign-in redirect. `/?go=photo` opens the sheet straight on "Photo of the meal" (the camera still needs a tap); where photo recognition is off or not set up it just opens today.
- Weight and body composition analysis: the weight card of the insights shows what the change is made of ("of which −1.6 kg fat, −0.5 kg lean mass", least-squares lines, at least 4 body-fat measurements over 14 days) and the weekly rate of loss (kg and % of body weight, at least 4 weights over 10 days); the weight chart draws a smoothed body fat line with the raw values as dots; the weight page has tiles for body fat, fat mass and lean mass (current value and change over 7/30/90 days). New hints `lean_loss` (lean mass down by 0.5 kg or more while protein is below the goal) and `fast_loss` (losing more than 1 % of body weight a week). The expenditure estimate counts fat at 9400 and lean mass at 1800 kcal/kg when the composition is known (`expenditure.method`: `composition` or `rule`, shown on the card). New in `GET /api/v1/insights`: `composition`, `composition_missing`, `rate`, `weight.body_fat_trend`, `expenditure.method`. No schema change.
- Swap the food of a diary entry: the amount dialog of an entry has "Other food"; search, scan, recent and Cookidoo open for it and the choice replaces the entry's food in place (same day and meal, the amount kept unless one side counts in portions). For example the nuts the meal photo saw become the product scanned later. New optional `food_id` in `PATCH /api/v1/diary/entries/{id}`. No schema change.
- Dividing a whole: the amount dialog has a "Divide" button. Type the weight of the whole (a cake of 1250 g), the number of parts (8) and how many were eaten (2); the share (312.5 g) goes into the amount field in g or ml. Only in the interface, nothing is stored. Not for foods booked in portions.
- Body fat and lean body mass: Apple Health delivers them with the existing shortcut (`body_fat_pct`, `lean_kg` per day in `POST /api/v1/health/sync`; Health's fraction such as `0.213` is read as 21.3 %; valid 2–75 % and 20–300 kg; new counters `body_fat` and `lean` in the answer) and they can be typed in next to the weight (`PUT /api/v1/weights/{day}`, new optional `body_fat_pct`, `lean_kg`; `GET /weights`, `summary/today`, the personal export and `insights.weight.body_fat` carry them). They live on the weight row, so a day without any weight stores neither (counted as skipped). Each value remembers its origin: a hand-typed value is never replaced by a sync. The weight tile shows both, the weight chart in the insights gets body fat as a second line with its own right-hand axis, the weight page has the two input fields. The shortcut generator sends both (the picker labels are not confirmed yet). Schema version 18 (`weight.body_fat_pct`, `lean_kg`, `body_fat_health`, `lean_health`).
- Guests and household members: with `MAHLWERK_HOUSEHOLD_GROUPS` (groups of the household, `proxy` and `oidc` mode; in `local` mode an admin sets it per user in the admin area) everybody else is a guest. Guests read all shared foods, recipes and groups and make their own, but change or delete only what they made themselves; the API refuses the rest with 403 (barcode entries of the household, pictures, pieces, groups, taking over from Cookidoo or a web page included). Entries fetched from outside (Open Food Facts, catalogue, web pages, Cookidoo) always belong to the household, whoever looks first. The household's Cookidoo account is not available to guests, only an own one. Unset: everybody is household, nothing changes. New `household` in `GET /me` and the admin user list, new `can_edit` in `Food`, `Recipe` and `RecipeGroup`; the interface hides or disables editing, deleting, piece and picture actions accordingly. Schema version 16 (`user.household`, `food.created_by`). See "Guests and the household" in `docs/api-v1.md`.
- Glass sizes for water: the water card has one "+" button per glass (default 250 and 500 ml; with three glasses the buttons show just the number) and the minus button takes back the glass added last (else the smallest). Each person sets one to three sizes (50–1000 ml) in the profile, under the water goal ("Your glasses"). New setting `water_glasses` (`PATCH /api/v1/me/settings`; `null` = default, invalid lists are refused with 422). No schema change.
- Drinks count as water: diary entries in ml add their water to the day's fluid total, shown on the water card next to the glasses ("Glasses 1.0 l + from drinks 0.6 l"; the strokes and the goal use the sum). Computed on read, nothing is written to the water table, the water export and Apple Health stay as they are. Automatic rule: water content (nutrient `water`, per 100 ml) at least 80 %, alcohol at most 0.5 g, no soup (by name: suppe, soup, eintopf, brühe, bouillon, consommé ...); unknown water content: counted in full for a plain drink (at most 70 kcal, 0.5 g salt, 5 g protein per 100). Per food "Counts as a drink: automatic / yes / no" in the amount dialog (new `drink` in `Food`, `PUT /api/v1/foods/{id}/drink`; schema version 17, column `food.drink`), switch in the profile under the glasses (setting `water_drinks`, default on). New `drinks_ml` in `Water` (day view) and `water_drinks_ml` in `summary/today`.
- Pieces: next to g or ml, the amount dialog can count in pieces. A person says once what a piece is ("slice" = 25 g, link "Set a piece"); from then on the dialog offers a switch between g and the piece, so "2" means two slices and the grams are calculated (shown below the field, and the other way round: "= 2 × Slice"). The diary still stores grams or millilitres, nothing in the export changes. The piece belongs to the food and is shared by all users; it is kept when the food is reloaded from Open Food Facts. Not for foods booked in portions (Cookidoo, web recipes). New `piece` in `Food`, new routes `PUT` and `DELETE /api/v1/foods/{id}/piece`; schema version 15 (two columns `piece_label`, `piece_grams` in `food`).
- Customisable day view: the cards of "Today" (calories, macros, fasting, water, activity, weight, meals, vitamins and minerals, what still fits) can be arranged right on the page (button "Customise this page"): drag by the handle or use the arrows, hide or show a card, and on wide screens make it half or full width. One order for phone and computer, saved per user as the new setting `home` (`PATCH /api/v1/me/settings`; `null` = default layout, unknown or doubled card ids are refused with 422). No schema change.
- Personal data export: every user can download all their own data (profile card "Export my data", `GET /api/v1/me/export`, also with a read access key). A ZIP with `diary.csv`, `weight.csv`, `activity.csv`, `workouts.csv`, `water.csv`, `fasting.csv` (UTF-8 with BOM; `;` and decimal comma for German, `,` and point otherwise) and a complete `mahlwerk-export.json` (also goal, settings, templates, own recipes, badges, account basics). Optional period (`from`/`to`; everything, last year or custom in the interface). There is no export of the whole database; passwords, sessions, access keys, webhook secrets, other users' data and demo rows are never part of it. No schema change.
- Pull to refresh in the home-screen app: pulling down at the top of a page loads its data again (not the whole page); only in the installed app, since Safari has its own in the browser. The weight view now also reloads after changes elsewhere.
- Ready-made Apple Shortcut for Apple Health (`scripts/apple-shortcut/`): a generator script (`build_shortcut.py`, standard library only, `--days N`) and the built, unsigned `Mahlwerk Health Sync.shortcut` that sends steps, active energy and weight of the last days to `POST /api/v1/health/sync`, with a README (signing on a Mac, import, automation). Address and access key are asked for on import.

### Fixed

- Biggest items: long food names no longer push the second column out of the card on wide screens (they are cut with …).
- Nutrient charts: thinner lines and points.
- A new version reached iPhones only hours later: `index.html` and the other files outside `assets/` were sent without `Cache-Control`, so Safari and home-screen web apps could reuse the old page. They now get `Cache-Control: no-cache` (checked with the server at each start, the ETag keeps it cheap); the hashed bundles under `assets/` get `public, max-age=31536000, immutable`.
- Number fields no longer save when they are only tapped and left: on the activity card this marked the day as typed in by hand (and an empty active energy as 0), so the Apple Health shortcut skipped it.
- Accessibility (WCAG 2.2): pinch zoom works again (viewport no longer blocks scaling); borders of buttons, chips, fields, checkboxes and switches reach 3:1 contrast, as do the weight and body-fat orange, the chart pink and the muted green in light mode; the focused control is no longer hidden behind the bottom navigation; the evaluation tabs follow the tabs pattern (arrow keys, Home/End, tab panel); evaluation card titles are level-2 headings (calendar months level 3); toasts live in a permanent live region, pause on hover/focus and the undo toast stays 10 s; sheets make the page behind them inert; each page sets its own document title.
- The list of recent foods (`GET /api/v1/foods/recent`) reads its foods in one query instead of one per food.

### Changed
- Weight page: the chart has a period choice (30 days, 90 days, year, all), remembered per browser; lowest, highest, the entry count and "since …" follow it, the change tiles keep looking back 7/30/90 days.

- The interactive API docs (`/docs`, `/redoc`, `/openapi.json`) are off in every sign-in mode unless `MAHLWERK_DOCS=1` (before: only in `local` and `oidc`).
- Blocking a user in the admin area works in every sign-in mode (before: `local` and `oidc` only); outside `local` only blocking is possible there, the admin right and the household still come from the proxy's or provider's groups. Nobody can block themself in any mode.

### Security

- Proxy mode: an admin can now block someone and revoke their access keys. Before, someone removed at the proxy kept working access keys (a `Bearer` key does not pass the proxy's sign-in) and nobody could take them back. A blocked user's keys stop working and their proxy headers are answered `403` ("this account is blocked"). New `POST /api/v1/admin/users/{username}/revoke-access` (every mode) revokes all access keys of a user and ends their sessions; the admin area has "Revoke keys and sessions" with a confirmation, and the user list with blocking now shows in proxy and single mode too.
- Label photos (`POST /api/v1/label-scans`) are no longer decoded in the server process: the picture child process (limits, reduced rights) turns them into a clean JPEG of at most 3072 px without metadata, and only that is read by the OCR (and kept as the debug copy). Label photos now count against the photo brake (20 per person in 10 minutes, together with own recipe pictures), and their limit is that of the child, 24 megapixels (before 25).
- Error answers no longer carry internal texts: a failed Open Food Facts lookup is `502 Open Food Facts unavailable` and a failed label reading `422 could not read the image`; the details (network, DNS, OCR engine) go to the server log only.

## [0.2.0] - 2026-11-14

### Added

- Recipes: "Paste ingredient list" in the recipe editor (and "Calculate from ingredients" for the ingredient lines of a recipe taken from a web page). One ingredient per line, German or English; amounts (decimal comma or point, fractions, ranges, brackets), units (g, kg, oz, lb, ml, l, EL/TL, tbsp/tsp, cup, Tasse, Prise, Dose, Bund, Zehe, Scheibe, Stück ...) and names are read, converted to grams with a small table of densities and typical piece weights (always marked as estimates) and matched to foods: own foods first, then basic foods (BLS) and packaged products of the local catalogue. A check step lets the person change the food, the amount or leave a line out; lines without a match do not block the rest. Deterministic, no AI model, no network. The match is ranked so that the plain basic food wins over a prepared or compound one (Butter before Butterzwieback, Speisesalz for Salz, Hühnerei roh before Eier-Frischteigwaren), helped by a small table of the usual meaning of common ingredients (search words, no catalogue codes); a doubtful first match is listed but not pre-selected. `scripts/check_ingredients.py` measures the hit rate against a real catalogue (about 107 + 96 lines; test `test_hit_rate_against_a_real_catalogue` with `MAHLWERK_TEST_CATALOG`). Preparation words of both languages say the same (cooked/boiled = gekocht, fried = gebraten, steamed, roasted, baked, grilled ...) and pick the prepared entry; a colour or a dish word can make a food of its own (grüne Bohnen, rote Linsen, Chicken soup) and is not thrown away; polished rice is the usual rice; Gouda is Gouda. A third list (`tests/ingredient_cases_meals.tsv`, components of meals as a photo model names them) is part of the hit-rate check. The catalogue search now finds words with `ß` (Weißzucker, Süßkartoffel). New route `POST /recipes/ingredients/match` (writes nothing; a read access key and the demo account may use it); no schema change.
- Photo recognition (optional connector, off by default; admin card "Photo recognition" or `MAHLWERK_VISION`): `POST /api/v1/vision/meal` turns a photo of a meal into recognised parts with estimated amounts and nutrition values, `POST /api/v1/vision/recipe` reads name, portions and ingredient lines (and the values per portion, if shown) from a photo of a recipe; `GET /api/v1/vision/status` for the interface. It talks to an image model the operator configures (`MAHLWERK_VISION_URL`, `MAHLWERK_VISION_MODEL`, optional `MAHLWERK_VISION_KEY`) over the OpenAI-compatible `chat/completions` protocol, so local models (Ollama, LM Studio, llama.cpp) and hosted providers both work. Photos are shrunk and re-encoded without EXIF or location first (`imageproc.for_model`, in the same limited child process), nothing is stored, the answer of the model is read strictly and clamped, 30 photos per person and hour (`MAHLWERK_VISION_PER_HOUR`), two runs at a time (`MAHLWERK_VISION_PARALLEL`), a model that answers 429/503 gives the person 429 with `Retry-After` without using up the allowance, a hard 90 s limit, no access keys, no demo account. No schema change.
- Photo recognition in the interface (only while the connector is on and configured, not in the demo-account view): "Photo of the meal" in the add sheet of the day view (photo, waiting state with cancel, check step with one row per recognised part matched to a food of the database, amounts and foods changeable, rows can be left out, or the model's estimate is taken as an own food per 100 g; sum of energy and protein; all rows are booked into the chosen meal, with undo) and "Photograph a recipe" on the Recipes page (opens the recipe editor with name, portions and the ingredient check step; values printed on the photo are shown next to the calculated energy per portion; "Add another photo" for several pages; the method is not taken over). Photos are shrunk in the browser (1600 px JPEG), a privacy notice shows once per device, failures (busy with the wait from `Retry-After`, 502/504, too large, offline, nothing recognised) get their own texts with "Try again". The check step of "Paste ingredient list" is now a shared component (`IngredientReview`). The mock and the demo answer with made-up results (`?vision=busy|error|big|empty`).

### Fixed

- Ingredient matching: a food whose name only mentions the word is no longer suggested. Own foods, imported Yazio foods and packaged products count as a confident match only when every noun of their name (before the first comma or bracket) is the word asked for, so "MILCH Brötchen", "Kokosmilch" or "Baumkuchen Vollmilch" no longer win over milk; a compound ending in a dish word (Baumkuchen, Nudelsalat) counts as a dish; a search shortened to part of the line ("Schoko" for "Schoko-Cerealien") lists candidates but never pre-selects one. Found with the meal photo of cereal with milk.

### Changed

- Behaviour-neutral clean-up: unused imports, dead helpers and 60 unused translation keys removed, module-internal exports narrowed.

## [0.1.0] - 2026-11-13

### Added

- Demo account for admins: an invented built-in user (the user row `~demo`, a name no sign-in mode can produce; no password, no admin right; a real user named `demo` is unaffected) with 90 days of sample data that an admin can switch to and back (more menu or profile; a band on every page says where you are), so the own account holds only real entries while the whole app can still be tried and shown. Switched on in the admin area (card in "Import and demo", `MAHLWERK_DEMO_ACCOUNT` fixes it), with "Create sample data anew" and "Delete demo account". The switch is an extra signed cookie bound to the real user and session, checked on every request; in the demo view one table in the server (`demo_account.py`, tested against the route list) allows only own data: shared products, recipes, groups, pictures, keys, webhooks, connectors, imports and the admin area are closed, and nothing is sent to webhooks. The sample foods are marked and hidden from the product list of everybody else. `GET /me` gains `demo_account`, `GET /admin/users` gains `demo`; new routes `POST /me/demo-view/enter|leave`, `POST /admin/demo-account/reset`, `DELETE /admin/demo-account`. No schema change. The test-data option in the own account is unchanged.
- Admin area, connectors tidied up: four groups of compact cards with one switch and one state label each, settings and technical notes (commands with a copy button, environment variables, installation hints) folded away and shown only where they apply, the catalogue countries chosen by name, calmer "Remove access" with a second question.
- Recipes page: "Take over" menu (Cookidoo, link) next to "New recipe" at the top, one "+" menu on a phone; the list shows 20 recipes at a time, search and filters run over all of them.
- Recipe detail in a wide panel: the picture is a card beside the values table, the source link below it; narrow panels keep the picture in the head block.
- Bottom sheets on a phone can be swiped down to close.
- Project website and an in-browser demo with made-up data (`site/`, `scripts/build-site.sh`, GitHub Pages workflow; published at https://mbrockeu.github.io/mahlwerk/ once the repository is public).
- Diary: day view with calories and macros against goals, four meals, streak, history and weight curve.
- Barcode scanning in the browser (built-in `BarcodeDetector` or a bundled WebAssembly detector); product lookup at
  Open Food Facts with a local cache.
- Own products and reading nutrition tables from photos with local OCR (RapidOCR, optional extra `label`).
- Local product catalogue built from the Open Food Facts export, with name search; basic foods from the BLS 4.0
  (imported by the user).
- Copy yesterday's meal, meal templates and recipes.
- Nutrients beyond the macros (vitamins, minerals and more).
- Activity: steps, active energy and workouts (by hand, Yazio import, Apple Health via a Shortcut), optionally added to the calorie goal.
- Insights: long periods, comparison, calendar (a month calendar with day numbers and kcal for short periods, week columns across the card for long ones, with a summary of the days by calorie goal), foods table and an energy expenditure estimate.
- Insights: follow up to four nutrients over time and compare them (chosen as chips, in the URL as `?nut=`); several share one axis in percent of their reference amount (personal goal or EU reference intake), with a 100 % line, lines told apart by dash pattern and marker, gaps as gaps, and the share of calories with a value shown per nutrient so that thin product data is not read as a deficiency. A nutrient without a reference amount can only be shown alone.
- Playful feedback: badges and a weekly review, switchable per person.
- Water tracking and an optional fasting timer.
- Import of a Yazio export (command line).
- Yazio import in the app (Profile): upload the files of the export (plain, gzip-packed by the browser, or a ZIP), see a preview, confirm; the result is a batch that can be taken back. Uploads wait in memory only; ZIPs are read with hard limits. A bigger body limit (24 MB) applies to that one route; strict limits on unpacked size, packing ratio and structure keep the memory of a parse small, and one heavy job runs at a time.
- Optional direct one-time Yazio sign-in (admin switch, off by default; unofficial interface, app identifiers from `MAHLWERK_YAZIO_CLIENT_ID`/`_SECRET`, nothing stored, braked). Tested only against a stand-in.
- Stored credentials: connector passwords kept encrypted in the database (AES-256-GCM via `cryptography`, key from `MAHLWERK_SECRET_KEY` or a key file next to the database; schema version 12). A missing or wrong key means "not set", never a crash.
- Cookidoo account in the app: the shared household account in the admin area (the environment still wins) and an optional own account per person (admin can forbid it); separate sign-ins, caches and brakes per account; a recipe taken over from an own account is shared with the household.
- Validation errors no longer echo the offending input.
- Demo data that users can add and remove again.
- Dark theme and a language setting; desktop layout.
- A short first-run tour of the day view (spotlight and speech bubbles on the real elements, phone and desktop); shown once per person (`settings.tour_seen`), per browser in the demo; the profile can show it again.
- Wide windows (from 1280 px): Products as list and detail pane, Weight with a large chart, key figures and the recent entries, Profile settings in two columns from 1800 px.
- Recipes have their own page (list with search, detail pane from 1280 px, add to diary); Products shows products only. On the phone the bottom bar is Today, Insights, Products, Recipes and scan; weight, badges, profile, admin and sign-out are in a small more menu behind the round avatar. The day view has a quiet weight tile.
- Profile: the page starts with your name (avatar, display name, user name, where you signed in). The display name can be changed (`PATCH /api/v1/me`, stored as the user setting `display_name`) and reset to the name from the proxy header or identity provider; a chosen name is kept at later sign-ins in every mode. The avatar initial follows it.
- Taken-over Cookidoo recipes live on the Recipes page, marked "Cookidoo", in one list with your own recipes (and searched with them): values per portion, a link to the recipe at Cookidoo (when the configured country is known), "Reload from Cookidoo" and "Remove". Products no longer lists them (`GET /foods` takes `exclude_source`; foods answer with `external_id`, `portions` and `url`); the Add sheet still finds and logs them. Amounts of such a recipe are typed and shown as portions, never as "100 g". "Take over from Cookidoo" is also on the Recipes page.
- Take over many Cookidoo recipes at once: a whole collection, the week's plan or everything (`POST /cookidoo/import`, `GET /cookidoo/import/preview`). A background run per Cookidoo account (two on the server, at most 500 recipes): one call every 3 seconds at most, a call budget apart from the interactive one, recipes taken over in the last 7 days skipped, progress and "Stop", stops at once on a refused sign-in or a brake, goes on after a single failing recipe and lists it. It does not survive a restart of the server. The question before the start says how many calls and how long.
- Recipes from web pages (admin switch, **off by default**): paste the address of a recipe, the server fetches that one page and reads the schema.org `Recipe` JSON-LD (also in `@graph` and lists; no microdata). A preview shows name, portions, nutrition per portion, the source host and the ingredient lines (to look at, never stored), with warnings (energy does not fit the macros, values look like the whole dish) and a switch "the values are for the whole recipe"; name and portions can be corrected. "Take over" makes a food with source `web` (values per portion, booked as portions, label with the host, "Open at <host>", "Reload", "Remove", groups); without an energy value nothing is taken over and an own recipe can be started from the name and portions instead. The fetch is built for an address a user typed: public addresses only (`netguard`), connection to the checked address, at most 3 redirects each checked again, http(s) on ports 80/443, 10 s, 3 MB after decompression, HTML only, no cookies, one neutral error text, a brake per person and for the server. No schema change.
- "What still fits today" (`GET /recipes/suggestions`): recipes that suit the rest of the day, ranked from the goal that counts today, the macro goals, what was eaten and when each recipe was last eaten, with a recommended amount (1/2, 1, 1 1/2 or 2 portions), what would be left and one or two reasons; focus balanced, high protein, light or not eaten lately; honest states for goal reached, no goal and nothing fits. A section on the Recipes page (with the group filter) and a foldable card on the day view that can be switched off in the profile (`settings.suggestions`). Computed on the server from data already there; nothing leaves it.
- Groups of recipes (schema version 13): named groups shared by the household, a recipe can be in several, for own and for Cookidoo recipes. Filter chips with counts on the Recipes page (also "No group", the choice in the address as `?group=`), manage (create, rename, delete, order), assign in the detail view and to several recipes at once, long lists load step by step. A run or a single take-over from a collection puts the recipes into a group of that collection's name, linked by the collection's id (renaming is respected, deleting is remembered).
- Recipe pictures (schema version 14, new dependency Pillow): a photo for any recipe (camera or file, shrunk in the browser, `PUT/DELETE /foods/{id}/image`), large in the detail, small in the list (with a quiet placeholder, only once any recipe has a picture), tiny among the suggestions on the Recipes page and the day view. Pictures of Cookidoo and web recipes are fetched and kept on the server (not again for an address already stored unless the recipe is reloaded; braked; no address kept while the switch is off) when an admin switches "Store recipe pictures" on for that connector (off by default; `MAHLWERK_COOKIDOO_IMAGES`, `MAHLWERK_WEB_RECIPES_IMAGES`), through the guarded fetch of web recipes; "Fetch missing pictures" catches up Cookidoo recipes taken over before (paced like taking over many). An own photo always wins over a provider's picture. Processing in a limited child process: header check (JPEG, PNG, WebP; 24 megapixels), first frame only, EXIF rotation applied and all metadata (GPS, colour profile) removed, three WebP sizes named by content hash in `<database>.images` next to the database (`MAHLWERK_IMAGES_MAX_MB`, default 1 GB); unused files are deleted and tidied (start-up, daily on a write, after mass deletions); own photos are limited to 20 per person in 10 minutes; a taken-away provider picture can be restored. Delivered by `GET /images/{hash}/{size}` to signed-in people only, cached privately for a year; the content security policy is unchanged.
- Admin area, personal access keys, signed webhooks and `GET /api/v1/summary/today`.
- Authentication modes `single` and `proxy`.
- Authentication mode `local`: own accounts with passwords (scrypt), first-start setup page, session cookie, brake against
  guessing, CSRF header, user management in the admin area (schema version 10).
- Authentication mode `oidc`: sign-in through an OpenID Connect provider (Authorization Code Flow with PKCE, `state` and
  `nonce`, discovery, userinfo fallback), users tied to issuer and `sub`, admin right from a group claim, optional takeover of
  existing users, `MAHLWERK_SESSION_DAYS` / `MAHLWERK_SESSION_MAX_DAYS` (schema version 11). The ID token's signature is not
  verified (OpenID Connect Core 3.1.3.7, see SECURITY.md).
- Security headers on every answer and a Content-Security-Policy for the interface.
- Dockerfile, Docker Compose file, CI workflow and issue templates.
- Cookidoo connector (optional extra `cookidoo`, Docker build argument `WITH_COOKIDOO`, off by default, one shared account
  from the environment): this week's meal plan, collections and recipe links become foods with the values per portion
  (source `cookidoo`, 100 g = 1 portion). Uses the unofficial `cookidoo-api` package. No schema change.

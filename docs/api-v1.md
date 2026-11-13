# API v1 – contract for the diary MVP

This is the agreed contract between backend and frontend. Swagger at `/docs` is generated from the code and
must match this file. All bodies are JSON. All routes below `/api/v1` need an authenticated user.

## Authentication

`MAHLWERK_AUTH` selects the mode:

- `single` (default): no login. Every request belongs to one local user (`MAHLWERK_SINGLE_USER`, default `me`).
  Meant for a private network or behind a proxy that does its own access control.
- `proxy`: a reverse proxy has authenticated the user and passes the name in a header
  (`MAHLWERK_PROXY_USER_HEADER`, default `Remote-User`; display name from `MAHLWERK_PROXY_NAME_HEADER`,
  default `Remote-Name`). The header is trusted **only** when the TCP peer address is listed in
  `MAHLWERK_TRUSTED_PROXIES` (comma separated IPs). Any other request gets `401`.
  A user row is created on first sight.
- `local`: accounts of this server with a password and a session cookie (see [Local accounts](#local-accounts)).
  Remote-User headers are never looked at in this mode.
- `oidc`: sign-in through an OpenID Connect provider and the same session cookie as `local` (see [OpenID Connect sign-in](#openid-connect-sign-in)).
  Remote-User headers are never looked at in this mode.

Users only ever see their own diary, goals and weights. Foods are shared by everyone on the server.

## Local accounts

Only with `MAHLWERK_AUTH=local` (schema version 10). In `single` and `proxy` mode every endpoint below except
`GET /auth/status` answers `404`.

**Session.** A successful `setup` or `login` sets the cookie `mahlwerk_session`: a random token (`secrets.token_urlsafe(32)`),
`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days (oidc mode: 7 days, 30 at most; `MAHLWERK_SESSION_DAYS`, `MAHLWERK_SESSION_MAX_DAYS`), named `__Host-mahlwerk_session` when `Secure` (then only that name is read), and `Secure` when the request came over HTTPS, when
`MAHLWERK_COOKIE_SECURE=1`, or when a peer listed in `MAHLWERK_TRUSTED_PROXIES` sends `X-Forwarded-Proto: https`
(the header is not trusted from anyone else). Only the SHA-256 of the token is stored. A session lasts 30 days from the
last use, but never longer than 180 days from sign-in; signing in again replaces this browser's earlier session (`last_seen` is written at most once a minute); expired sessions are removed at sign-in. A blocked account's
sessions and access keys stop working at once. An access token (`Authorization: Bearer mw_...`) still works and wins
over the cookie.

**CSRF.** In ALL modes every `POST`, `PUT`, `PATCH` and `DELETE` below `/api/` must carry the header
`X-Mahlwerk-Request: 1`, else `403` (also `setup`, `login`, `logout`); only requests with a bearer token are exempt. In
`local` mode it protects the cookie; in `single` and `proxy` it protects the missing or proxy-provided login. Reason: a page on another site can send a
request with the cookie, but it cannot add a custom header without a CORS pre-flight, and this server sends no CORS
headers, so the pre-flight fails; HTML forms cannot set custom headers at all. Requests with a bearer token are
exempt (the token is no cookie). The interface always sends the header.

**Host check.** A request whose `Host` header (port ignored) is not in `MAHLWERK_ALLOWED_HOSTS` gets `421` naming the
variable; `/healthz` is exempt. Default: `single` mode only `localhost`, `127.0.0.1`, `[::1]`; `proxy` and `local`: no
check. `*` allows everything.

**Size.** A request body over 1 MB (8 MB for `POST /label-scans` and `POST /health/sync`, 24 MB for `PUT /me/yazio/files/{name}`)
gets `413`, checked on `Content-Length` and on streamed bytes. **Validation errors (422) never echo the offending input**
(FastAPI's `input` and `ctx` members are left out), so a password sent in a wrong shape does not come back.

**Brake.** Failed sign-ins (and wrong "current password" in `POST /auth/password`, wrong setup codes) are counted per
client address (an IPv6 address as its /64 network) and per pair user name + address. User names are normalised
(trimmed, lower-case) like the account lookup. From the 5th failure a key is blocked for 2, 4, 8 ... seconds (at most
15 minutes): `429` with `Retry-After`, even for the right password. A name alone never blocks (that would let anyone
lock a stranger's account): while a name has 5 or more recent failures from anywhere, its checks run one at a time and a
failed check takes at least a second, so a distributed guesser gets about one try per second per name while the owner
with the right password still gets in. A success clears the pair's count, not the address's. The state is in
the memory of the process (a restart forgets it; several worker processes count separately). The address is the TCP
peer; behind a trusted proxy it is the last `X-Forwarded-For` entry. Unknown user and wrong password give the same
answer and cost the same time.

**Passwords.** 10 to 256 characters, no other rules. Stored as scrypt (N=2^15, r=8, p=1, 16-byte salt, 32-byte key); the
parameters are part of the stored text and a hash with weaker parameters is replaced at the next sign-in.
User names: 1 to 40 characters `a-z 0-9 . _ -`, starting with a letter or digit, stored lower-case.

| Method and path | Body | Answer |
|---|---|---|
| `GET /auth/status` | – | public: `{mode, setup_required, authenticated, username, display_name, is_admin}` |
| `POST /auth/setup` | `{username, display_name?, password, setup_code?}` | `201 {username, display_name, is_admin}` + cookie. Only while nobody has a password, else `409`. An existing user row of that name without a password (a database from `single`/`proxy`) is taken over with its data; then `setup_code` is required (`MAHLWERK_SETUP_TOKEN`, or the random code logged once at start), wrong: `403`, braked. `status` shows `setup_code_required`. |
| `POST /auth/login` | `{username, password}` | `200` like setup + cookie; `401` wrong password, unknown name or blocked account (one message, same timing); `429` brake |
| `POST /auth/logout` | – | `204`, session ended, cookie deleted |
| `POST /auth/password` | `{current_password, new_password}` | `204`; `403` wrong current password; all other sessions of the user end (access keys stay) |
| `POST /admin/users` | `{username, display_name?, password, is_admin?}` | `201 {username, display_name, is_admin}`; `409` name taken |
| `PATCH /admin/users/{username}` | `{disabled?, is_admin?}` | `200 {username, display_name, is_admin, disabled}`; blocking ends the sessions; `409` if it would leave no active admin |
| `POST /admin/users/{username}/password` | `{password}` | `204`, sets a new initial password, ends that user's sessions and revokes their access keys; `409` for the own account |

The `admin/users` routes need an admin session (no token). Admin in `local` mode is a stored flag per account; in `proxy`
mode it still comes only from the groups header. `GET /admin/users` additionally returns `disabled`, `admin`,
`has_password` per user (false in the other modes).

**Headers on every answer** (all modes): `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`X-Frame-Options: DENY`; the interface (everything outside `/api/`) also gets a `Content-Security-Policy`, see README.
Every answer below `/api/` carries `Cache-Control: no-store`. `/docs`, `/redoc` and `/openapi.json` are off in `local` and `oidc` mode unless `MAHLWERK_DOCS=1`.
Access keys of a user without a password are invalid in `local` mode.

## OpenID Connect sign-in

Only with `MAHLWERK_AUTH=oidc` (schema version 11); in the other modes these endpoints answer `404`. In this mode `setup`,
`login`, `password`, `POST /admin/users` and `POST /admin/users/{username}/password` answer `404` as well.

| Method and path | Answer |
|---|---|
| `GET /auth/status` | public: like `local`, plus `oidc_label` (the configured button name or `null`); `mode` is `oidc`, `setup_required` always false. In the other modes the key `oidc_label` is absent. |
| `GET /auth/oidc/login?next=` | `302` to the provider's authorization endpoint (code flow, PKCE S256, `state`, `nonce`, the configured redirect URI and scopes). Sets the cookie `mahlwerk_oidc` (`__Host-mahlwerk_oidc` when Secure; `HttpOnly`, `SameSite=Lax`, `Path=/`, 10 minutes) that holds state, nonce, PKCE verifier, target and expiry, signed with HMAC-SHA256 (nothing is kept on the server), and binds the pending sign-in to this browser. `429` with `Retry-After` beyond 30 requests per address and minute (login and callback each). `next` is an optional path on this site to open afterwards (anything else, an absolute URL, `//host` or a path below `/api`, is ignored). `302` back to the start page with `?auth_error=failed` when the provider cannot be reached or its discovery document is not acceptable. |
| `GET /auth/oidc/callback?code=&state=` | The provider sends the browser here. Checks the cookie and `state` (used once), swaps the code for the tokens (with the PKCE verifier), checks the ID token, maps the identity to a user, starts the session (cookie `mahlwerk_session`) and answers `303` to `next` or the start page. Every failure is a `303` to the start page with `?auth_error=<word>`, the cookie `mahlwerk_oidc` deleted and no session; the reason goes to the server log without tokens or claim values. |
| `POST /auth/logout` | `204`, the session ended, cookie deleted (as in `local`). Nothing is sent to the provider. |
| `PATCH /admin/users/{username}` | `{disabled}`: block or unblock (a block ends sessions). `is_admin` is refused with `409` (the right comes from the provider's groups at each sign-in); blocking yourself is refused with `409`. |

`auth_error` words: `denied` (the provider reported an error, e.g. the person declined), `failed` (anything wrong with the
provider's answers or the checks), `expired` (no pending sign-in for this browser: older than 10 minutes, used before, or the
cookie is missing), `blocked`, `conflict` (the user name already belongs to another identity), `exists` (a user of that name
exists without a provider link and `MAHLWERK_OIDC_LINK_EXISTING` is off), `name` (no usable user name in the claims).

`GET /admin/users` additionally has `sso` per user in this mode: true when the user has signed in through the provider
(false: a user from an earlier mode that nobody has claimed yet). The two GET endpoints change state but cannot carry the CSRF header
(the provider's redirect is a plain navigation); `state` bound to the cookie, `nonce` and PKCE protect them (see SECURITY.md). Access keys
work as in the other modes and are not tied to a password here.

## Types

```
Per100   { kcal, fat, saturated_fat, carbs, sugars, fiber, protein, salt }   all number|null, per 100 g or 100 ml
Extra    { <key>: number }   additional nutrients per 100 g or 100 ml, in the unit of GET /nutrients; only keys of the
           directory; a missing key means unknown (never null, never 0 for "unknown")
Nutrient { key, group:"fat"|"carb"|"mineral"|"vitamin"|"other", unit:"g"|"mg"|"µg", nrv:number|null }
Food     { id:int, code:string|null, source:"openfoodfacts"|"own"|"recipe"|"yazio"|"bls", recipe_id:int|null, name, brand, quantity, serving_size,
           serving_quantity:number|null, unit:"g"|"ml", per_100:Per100, extra:Extra, complete:bool, empty:bool,
           cached:bool, stale:bool, fetched_at:int, image:FoodImage|null }
FoodImage { hash:string (32 hex digits), origin:"own"|"cookidoo"|"web", credit:string|null }   the picture of a recipe, see Recipe pictures;
           `credit` is `Cookidoo` or the host of the page for a provider's picture, `null` for an own photo
CatalogItem { source:"openfoodfacts"|"bls", code:string, name, name_en:string|null (BLS only), brand, quantity, serving_size, serving_quantity:number|null,
           unit:"g"|"ml", per_100:Per100, extra:Extra, complete:bool }   a product of the local catalogue, no id yet
FoodIn   { name (required), brand, quantity, serving_size, serving_quantity, unit ("g" default), per_100,
           extra (optional, default {}) }
Goal     { kcal:int, protein:number, carbs:number, fat:number, water_ml:int, steps:int }   water_ml optional, 500-6000, default 2000
           (goals saved before it existed read 2000; a PUT without it keeps the saved value); steps optional, 1000-50000,
           default 8000, kept the same way
Water    { ml:int, goal_ml:int }                 the day's total and the goal, in ml
Fast     { id, started_at:int, ended_at:int|null, target_hours:number, elapsed_seconds:int, duration_seconds:int|null,
           target_reached:bool }                  Unix seconds (UTC); elapsed runs to now while the fast is open
Meal     "breakfast" | "lunch" | "dinner" | "snack"
Entry    { id, food_id:int|null, meal:Meal, name, brand, amount:number, unit:"g"|"ml",
           kcal, protein, carbs, fat }            nutrients already scaled to the amount, number|null
Workout  { id, day, started_at:int|null (Unix s), kind, name, minutes, kcal:number, kcal_estimated:bool, distance_m|null,
           steps|null, note|null, source:"manual"|"health"|"yazio"|"demo" }      see Activity
DayActivity { steps:int|null, steps_goal:int, active_kcal|null, distance_m|null, source|null, bonus_kcal:int, workouts:[Workout] }
Day      { day:"YYYY-MM-DD", goal:Goal|null, kcal_goal:int|null (the goal that counts, see Activity), activity:DayActivity,
           water:Water,
           totals:Per100-shaped object with the day's sums (null counts as 0),
           extra_totals:{ <key>: { amount:number, coverage:number } }   see Additional nutrients,
           meals:{ breakfast|lunch|dinner|snack: { kcal:number, entries:Entry[] } },
           streak:int,                              consecutive days with at least one entry, ending at `day`
           week:[{ day, logged:bool, kcal:number }] seven days ending at `day`, oldest first,
           yesterday:{ <meal>: { kcal:number, names:string[] } }   only the meals the previous day had entries in,
                                                    `names` in the order they were logged; `{}` without any }
ImportBatch { id:int, kind:"yazio", created_at:int (unix seconds),
           counts:{ days, entries, product_entries, recipe_entries, quick_entries, foods, weights, water, activity_days, workouts:int, goal_set:bool } }
Template { id, name, kcal:number, items:[{ name, brand, amount, unit, kcal:number|null }] }
Recipe   { id, food:Food, portions:number, total_weight:number|null,
           items:[{ food_id:int|null, name, brand, amount, unit, kcal:number|null }], kcal_per_portion:number|null }
```

`serving_quantity` is the serving in grams/millilitres when it could be derived (Open Food Facts gives it;
for own foods it is parsed from `serving_size` like "30 g" when possible).

A diary entry stores a **copy** of the food's name, brand, unit, per-100 values and `extra` at the time of logging.
Editing or deleting the food later does not change past days; deleting sets `food_id` to null.

## Routes

| Method | Path | Body | Returns | Notes |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | – | `{status, version}` | no auth |
| GET | `/api/v1/me` | – | `{username, display_name, display_name_custom:bool, provider_name:string\|null, goal:Goal\|null, settings:{playful:bool, fasting:{enabled:bool, target_hours:number}, activity:{add_to_goal:bool}, tour_seen:bool, suggestions:bool}, demo:{available:bool, entries:int, weights:int, water:int, activity:int, workouts:int}, demo_account:{can_switch:bool, viewing:bool, real_username:string\|null, real_display_name:string\|null}, catalog:{products:int, updated_at:int\|null, bls:{products:int, updated_at:int\|null}}}` | `demo.available` is true when the server runs with `MAHLWERK_DEMO_DATA`; the counts are this user's demo rows. `catalog` is the size and build time (unix seconds) of the Open Food Facts catalogue file (`products`, `updated_at`) and of the basic foods file (`bls`), `0` and `null` without a file |
| PATCH | `/api/v1/me` | `{display_name: string\|null}` | `Me` (same as GET) | Chooses the display name: trimmed, blanks collapsed, 1-60 characters, no control characters or line breaks (Unicode and emojis are fine), else `422`. Empty or `null` goes back to the provider's name (proxy header, OIDC claim, local account) or the user name. The chosen name wins in every sign-in mode and is **not** overwritten by proxy headers or later OIDC sign-ins; it shows in `/me`, `/auth/status`, the login answer and `/admin/users`. `username` never changes. Stored as the user setting `display_name` (no schema change). Needs a write token like `PATCH /me/settings` (`read` scope: `403`) |
| GET | `/api/v1/me/imports` | – | ImportBatch[] | this user's import batches, newest first, see Importing from Yazio |
| DELETE | `/api/v1/me/imports/{id}` | – | `{entries, weights, water, activity, workouts, foods:int, goal:bool}` | takes back one of the user's own batches (404 for an unknown or foreign one); the numbers are what was removed |
| PUT | `/api/v1/me/goal` | Goal | Goal | kcal 500–10000, macros 0–1000, water_ml 500–6000 |
| PATCH | `/api/v1/me/settings` | `{playful?:bool, fasting?:{enabled?:bool, target_hours?:number}, activity?:{add_to_goal?:bool}, tour_seen?:bool, suggestions?:bool}` | `{playful, fasting, activity, tour_seen, suggestions}` | per-user settings, `playful` defaults to true, `fasting` to `{enabled:false, target_hours:16}` (hours 8–72), `activity` to `{add_to_goal:false}`, `tour_seen` to false (set once the first-run tour of the day view was shown or skipped; the profile can reset it), `suggestions` to true (the day view shows the card "what still fits today"; `GET /recipes/suggestions` answers either way); fields left out stay as they are, also inside `fasting` and `activity` |
| GET | `/api/v1/badges` | – | Badges | see Playful feedback; empty lists while `playful` is false |
| POST | `/api/v1/badges/seen` | `{codes:[string]}` | Badges | marks those badges as seen; unknown codes are ignored |
| GET | `/api/v1/review?week=YYYY-Www` | – | Review | see Playful feedback; default the last completed week (Monday to Sunday); malformed or non-existent week → 422 |
| GET | `/api/v1/nutrients` | – | `Nutrient[]` | the directory of additional nutrients, see Additional nutrients |
| GET | `/api/v1/foods/barcode/{code}` | – | Food | a user's `own` food first, then a fresh local copy, then the local catalogue (stored as a food, no network), then Open Food Facts live; 404 unknown, 422 invalid, 502 upstream down |
| PUT | `/api/v1/foods/barcode/{code}` | FoodIn | Food | create or replace the food for this barcode as `own` |
| GET | `/api/v1/foods?q=&source=&limit=` | – | Food[] | search name, brand, barcode (`source`: `own`, `openfoodfacts`, `recipe`, `yazio`, `bls`, `cookidoo` or `web`; recipes are included without it); newest first; empty shells hidden; limit default 50, max 1000 (a run that takes over many Cookidoo recipes can leave several hundred) |
| GET | `/api/v1/catalog?q=&source=&limit=` | – | CatalogItem[] | see Product catalogue; `q` under 2 characters gives `[]`; `source` (`openfoodfacts`\|`bls`) limits it to one source, else both; limit default 25, max 50 |
| POST | `/api/v1/catalog/adopt` | `{source, code}` | Food (201, or 200 if the food existed) | stores a catalogue item as a regular food, without network access; 404 unknown item |
| GET | `/api/v1/foods/recent?limit=` | – | `[{food:Food, last_amount:number, last_meal:Meal}]` | distinct foods this user logged, most recent first, default 20 |
| POST | `/api/v1/foods` | FoodIn | Food (201) | own food without barcode |
| GET | `/api/v1/foods/{id}` | – | Food | |
| PUT | `/api/v1/foods/{id}` | FoodIn | Food | turns the food into `own`; a recipe food → 409 |
| DELETE | `/api/v1/foods/{id}` | – | 204 | diary copies stay; a recipe food → 409 (delete the recipe) |
| POST | `/api/v1/label-scans` | image bytes | `{per_100, basis, warnings, text}` | unchanged |
| GET | `/api/v1/diary/{day}` | – | Day | |
| POST | `/api/v1/diary/{day}/entries` | `{food_id, meal, amount}` | Entry (201) | amount > 0, ≤ 5000 |
| PATCH | `/api/v1/diary/entries/{id}` | `{amount?, meal?}` | Entry | only own entries, else 404 |
| DELETE | `/api/v1/diary/entries/{id}` | – | 204 | only own entries, else 404 |
| POST | `/api/v1/diary/{day}/copy` | `{from_day, meal?, to_meal?}` | `{entries:Entry[]}` (201) | see Copying and templates |
| GET | `/api/v1/templates` | – | Template[] | this user's templates, newest first |
| POST | `/api/v1/templates` | `{name, from:{day, meal}}` | Template (201) | from a logged meal of this user; 404 when it has no entries; name 1–80 characters |
| PATCH | `/api/v1/templates/{id}` | `{name}` | Template | other users' templates → 404 |
| DELETE | `/api/v1/templates/{id}` | – | 204 | |
| POST | `/api/v1/templates/{id}/apply` | `{day, meal}` | `{entries:Entry[]}` (201) | |
| GET | `/api/v1/recipes` | – | Recipe[] | all recipes of the household, most recently changed first |
| POST | `/api/v1/recipes` | `{name, portions, total_weight?, items:[{food_id, amount}]}` | Recipe (201) | see Recipes |
| GET | `/api/v1/recipes/{id}` | – | Recipe | |
| POST | `/api/v1/recipes/ingredients/match` | `{text}` | `{lines:[IngredientLine], ignored}` | reads a pasted ingredient list and looks up foods; writes nothing, see Calculating from an ingredient list |
| PUT | `/api/v1/recipes/{id}` | as POST | Recipe | recalculates the food; diary entries logged earlier stay unchanged |
| DELETE | `/api/v1/recipes/{id}` | – | 204 | removes recipe and food; diary copies and templates stay |
| GET | `/api/v1/history?days=` | – | `[{day, kcal, protein, carbs, fat, logged}]` | last N days (default 14, max 366) ending today, oldest first |
| GET | `/api/v1/insights?from=&to=&range=&granularity=&compare=` | – | Insights | see Insights; default the last 30 days ending today; up to 3660 days (ten years); `range=all` = first to last entry, `range=<n>` = last n days; invalid date, `from` after `to`, too long or an unknown `granularity`/`range`/`compare` value → 422 |
| GET | `/api/v1/insights/nutrient?key=&from=&to=&granularity=` | – | NutrientCurve | see Insights, nutrient curve |
| GET | `/api/v1/insights/foods?from=&to=&q=&sort=&limit=&offset=` | – | FoodList | see Insights, foods |
| GET | `/api/v1/insights/foods/detail?key=&from=&to=` | – | FoodDetail | see Insights, foods; 404 when the food has no entry in the period |
| GET | `/api/v1/weights?days=` | – | `[{day, kg}]` | last N days (default 90, max 3660), oldest first |
| PUT | `/api/v1/weights/{day}` | `{kg}` | `{day, kg}` | 20–400 kg, one value per day |
| DELETE | `/api/v1/weights/{day}` | – | 204 | |
| POST | `/api/v1/water/{day}` | `{add_ml}` | Water | add (or take back) −2000…2000 ml; the total is kept between 0 and 10000 |
| PUT | `/api/v1/water/{day}` | `{ml}` | Water | set the day's total directly, 0–10000 |
| GET | `/api/v1/fasting` | – | `{current:Fast\|null, last:Fast\|null, recent:Fast[]}` | `last` is the latest finished fast, `recent` up to 14 finished ones, newest first; works whether or not the timer is switched on in the settings |
| POST | `/api/v1/fasting/start` | `{started_at?, target_hours?}` | Fast (201) | start up to 48 h in the past, not in the future (422); one already running → 409; `target_hours` 8–72, default the setting |
| POST | `/api/v1/fasting/stop` | `{ended_at?}` | Fast | not before the start, not in the future (422); none running → 409 |
| PATCH | `/api/v1/fasting/{id}` | `{started_at?, ended_at?, target_hours?}` | Fast | correct a fast; `ended_at` on the open fast finishes it; other users' fasts → 404 |
| DELETE | `/api/v1/fasting/{id}` | – | 204 | other users' fasts → 404 |
| GET | `/api/v1/activity?days=` | – | `[{day, ...DayActivity}]` | last N days (default 14, 1–366) ending today, oldest first, every day listed (null values when empty) |
| PUT | `/api/v1/activity/{day}` | `{steps?, active_kcal?, distance_m?}` | `{day, ...DayActivity}` | partial: only the fields sent change, `null` clears one; steps 0–200000, active_kcal 0–20000, distance_m 0–500000; an empty body → 422. The row becomes source `manual` and leaves its import batch |
| POST | `/api/v1/workouts` | `{day, kind, name?, minutes, kcal?, distance_m?, steps?, started_at?, note?}` | Workout (201) | minutes 0–1440 (exclusive 0); an unknown `kind` becomes `other` with its text as `name`; without `kcal` it is estimated |
| PATCH | `/api/v1/workouts/{id}` | any of the POST fields | Workout | partial, `null` clears kcal (back to the estimate), distance, steps, start and note; the workout becomes `manual`; other users' → 404 |
| DELETE | `/api/v1/workouts/{id}` | – | 204 | only own workouts, else 404 |
| POST | `/api/v1/health/sync` | HealthSync | counts per kind | bulk interface for Apple Health, needs a write key, see Activity |
| POST | `/api/v1/me/demo-data` | `{days?:int}` | `{entries, weights, water, activity, workouts, foods, goal_set:bool}` | see Demo data; 404 when switched off |
| DELETE | `/api/v1/me/demo-data` | – | `{entries, weights, water, activity, workouts, foods}` | see Demo data; 404 when switched off |

## Additional nutrients

Beyond the eight core values of `Per100` (they stay as they are) the app knows the common fats, carbohydrates,
minerals, vitamins and a few others. The directory (`GET /api/v1/nutrients`, source `src/mahlwerk/nutrients.py`)
lists `key`, `group` (`fat`, `carb`, `mineral`, `vitamin`, `other`), `unit` per 100 g/ml (`g`, `mg` or `µg`, the
unit the substance is usually quoted in) and `nrv`, the EU reference intake for adults per day (Regulation (EU)
No 1169/2011, Annex XIII), `null` where there is none. Display names are the client's business.

| group | keys (unit) |
| --- | --- |
| fat | `monounsaturated_fat`, `polyunsaturated_fat`, `trans_fat`, `omega_3` (g), `cholesterol` (mg) |
| carb | `added_sugars`, `starch` (g) |
| other | `alcohol`, `water` (g), `sodium`, `caffeine` (mg) |
| mineral | `calcium` 800, `iron` 14, `potassium` 2000, `magnesium` 375, `zinc` 10, `phosphorus` 700, `copper` 1, `manganese` 2, `chloride` 800, `fluoride` 3.5 (mg); `iodine` 150, `selenium` 55, `chromium` 40, `molybdenum` 50 (µg); the number is the NRV |
| vitamin | `vitamin_b1` 1.1, `vitamin_b2` 1.4, `vitamin_b3` 16 (niacin), `vitamin_b5` 6, `vitamin_b6` 1.4, `vitamin_c` 80, `vitamin_e` 12 (mg); `vitamin_a` 800, `vitamin_b7` 50 (biotin), `vitamin_b9` 200 (folate), `vitamin_b12` 2.5, `vitamin_d` 5, `vitamin_k` 75 (µg) |

- `extra` on `Food`, `FoodIn`, `CatalogItem`: only directory keys, values in the directory's unit, per 100 g/ml. Input
  must be a number from 0 up to the key's plausible maximum (a unit-error guard, e.g. vitamin C 10000 mg); unknown
  keys, negative or too large values and `null` give `422`. Unknown means: leave the key out. Foods stored before
  the feature (and own foods saved without it) have `{}`.
- Diary entries copy `extra` like `per_100` (schema version 3; version 4 added templates and recipes); later edits of the food do not change old entries.
- Day: `extra_totals` holds only keys at least one entry of the day states. `amount` is the day's sum in the
  directory's unit (entries without a value add nothing). `coverage` (0..1) is the share of the day's kcal that comes
  from entries stating this nutrient; if the entries have no kcal at all, the share of entries. A missing value is
  not a zero, so low coverage means the amount is probably too low.
- Open Food Facts gives **all** nutrients in grams per 100 g. Both the live lookup and the catalogue import convert
  to the directory's unit (vitamin C `0.04` g becomes `40` mg, vitamin B12 `0.0000024` g becomes `2.4` µg) and
  discard values that are above the plausible maximum, or a fat/carbohydrate part larger than its parent
  (monounsaturated fat above total fat, starch above carbohydrates). No value is better than a wrong one.

## Copying and templates

Both exist to log recurring meals with one tap. Everything they create is an ordinary diary entry that carries the
**stored snapshot** (name, brand, unit, per-100 values, `extra`) and, where the food still exists, its `food_id`; the
current state of the food is never consulted.

`POST /api/v1/diary/{day}/copy` with `{from_day, meal?, to_meal?}` copies this user's entries of `from_day` to `day`.
With `meal` only that meal is copied, without it the whole day. With `to_meal` everything lands in that meal, without
it each entry keeps its own meal. The answer is `{entries}` (201), the new entries in their original order; undoing is
deleting them. Errors: `404` when there is nothing to copy, `422` for a bad day or meal and for `from_day == day`
without `to_meal` (that would duplicate the day onto itself). Entries of other users are never visible. Copies are
real entries, also when the source was demo data.

`Day.yesterday` offers the same for the UI: for each meal the previous day had entries in, its `kcal` and the `names`
of its entries.

A **template** is a named, per-user set of snapshots (`template`, `template_item`; schema version 4).
`POST /api/v1/templates` stores the entries of one logged meal (`from: {day, meal}`) under a name (1–80 characters
after trimming, else `422`); `apply` logs all items into a chosen day and meal. Later changes to the foods or the
diary do not touch a template. Templates of other users answer `404`, as does a meal without entries.

## Recipes

A **recipe** is a household-wide food that is calculated from ingredients and logged like any food. Creating one
creates a food with `source: "recipe"` and `recipe_id`; the food id stays the same when the recipe is changed.
Ingredients are stored as snapshots of the food at save time (`recipe_item`, in the order given).

- Body: `name` (1–200), `portions` (> 0), optional `total_weight` (g of the finished dish, > 0), `items` (1 to 60 of
  `{food_id, amount}`, amount > 0). An unknown `food_id` and a recipe food as ingredient give `422`.
- Calculation: sum of all ingredients; reference weight = `total_weight` if given, else the sum of the amounts
  (millilitres count like grams). `per_100` and `extra` = sum / reference weight × 100. A value is only set when at
  least one ingredient states it (an ingredient without it adds nothing; unknown is not zero), otherwise it is `null`
  or left out. `complete` is the usual check on the result. `serving_quantity` = reference weight / `portions`
  (g), `serving_size` = that number and `g` (e.g. `"175 g"`, language-neutral); `unit` is `g`.
- `kcal_per_portion` is the recipe's energy divided by `portions` (`null` when no ingredient has energy).
  `total_weight` only changes the density: with 700 g instead of 550 g the dish has the same energy per portion, but a
  smaller `per_100`.
- `PUT` recalculates the food. Diary entries logged before keep their copy. `DELETE` removes recipe and food; diary
  copies and templates stay (their `food_id` becomes `null`). Deleting an ingredient food keeps the recipe as it is.
- A recipe food cannot be changed with `PUT /foods/{id}` or `PUT /foods/barcode/{code}`, nor deleted with
  `DELETE /foods/{id}`: all answer `409`. It shows up in `GET /foods`, `GET /foods/recent`, and as `source: "recipe"`.
- Recipes belong to the household like foods do: every user can see, change and delete them. `created_by` is stored.

### Calculating from an ingredient list

`POST /recipes/ingredients/match` turns pasted text (one ingredient per line, German or English) into suggestions for a recipe:
the amount of each line in grams and the foods that may be meant. It is deterministic (no model) and offline, and it **writes
nothing**; the recipe itself is made with `POST /recipes` from what the person confirms, and a catalogue hit becomes a stored food
with `POST /catalog/adopt` first, like in the ordinary ingredient search.

- Body: `{text}`. At most 200 lines, 300 characters per line, 20 000 characters in all (more: `422`). Empty lines are skipped. A
  line that holds no ingredient (a heading such as `Für den Teig:`, only punctuation) is left out and counted in `ignored`.
- Answer `lines`, one per ingredient line, in order: `line` (number in the text, from 1), `text` (as sent), `quantity` (a range such as
  `2-3` counts as its mean; fractions `1/2`, `1 1/2`, `½` and decimal comma or point are read; `null` without an amount), `unit` (as
  written), `name` (without amount, unit and cutting words such as *gehackt* or *chopped*), `note` (what was taken out: brackets,
  text after a comma), `optional`, `grams`, `ml`, `estimated`, `basis`, `candidates` and `suggestion`.
- Units: g, kg, mg, oz, lb, Pfund; ml, cl, dl, l, EL/tbsp (15 ml), TL/tsp (5 ml), Tasse (250 ml, estimated), cup (240 ml), fl oz, pint, quart,
  gallon, Msp; counts such as Stück/piece, Dose/can (400 g, estimated), Bund/bunch, Zehe/clove, Scheibe/slice, Packung/pack, Prise/pinch, Stange,
  Zweig, Blatt, Würfel, Knolle/head, stick; size words (klein/mittel/groß, small/medium/large) scale piece weights.
- `grams` and `basis`: `explicit` a weight or volume in brackets (`1 Dose (400 g)`, `2 Eier (je 60 g)`) wins and counts per piece on a counted
  line; `mass` a given mass; `volume` a volume times the density of the food (a small built-in table: water, milk, oils, flour, sugar, honey ...), **1 g/ml
  is assumed otherwise** and `estimated` is `true`; `piece` a typical weight of one piece of common basics (egg, onion, garlic clove, carrot, potato,
  tomato, apple, banana, lemon, pepper ...); `unit` a typical weight of the unit for the food (a bunch of parsley, a slice of bread, a pinch of salt);
  `none`: `grams` is `null` and the person types the amount. `estimated` is `true` whenever the figure rests on an assumption (piece or unit weight,
  assumed density, a cup of uncertain size). `ml` is set where a volume was given or the density is known.
- `candidates` (at most 5, best first) and `suggestion` (the first candidate, but only when the match is confident, else `null` while the candidates are
  still listed: the words are no more than the start of a longer word, as with "Zimt" and "Zimtsterne"). Where the foods come from and how they rank:
  - Stored foods (own ones, and basic foods and products taken over earlier; recipes and recipes from Cookidoo or a web page never) and the basic foods
    (BLS) of the catalogue are ranked together; packaged products (Open Food Facts) only fill up where there is no confident basic food, and are all there is when
    nothing else matches. Catalogue items already stored as a food appear as stored foods, not twice. Without a catalogue only stored foods are found.
  - Rank (a score, smaller is better): the word as a whole word (Butter) before the end of a compound (Speisesalz for Salz) before the start of a longer word
    (Butterzwieback, Salzburger) before somewhere inside; a raw or plain food (name with *roh* / *raw*, or a BLS base entry whose code ends in `00`) before a prepared
    one (*gebraten, gekocht, Püree, Sauce, Suppe, Konserve, getrocknet, mit ...*) unless the line itself names the preparation (a can, "gekocht") which then
    wins; the food at the start of its name; fewer extra words. Foods the person made themselves (`own`, `yazio`) get a head start (but only when confident), so they come first.
  - A small built-in table (`ingredients._USUAL`, about 200 German and English names) gives the **usual meaning** of the most common ingredients as search words in the
    BLS style: Mehl / flour is "Weizen Mehl Type 405", Ei / egg "Hühnerei roh", Zucker / sugar white sugar, Salz "Speisesalz", Sahne / cream "Schlagsahne 30",
    Butter, Milch "Vollmilch", Zwiebel, Knoblauch, Karotte, Tomate (a can: the preserved one), Hähnchenbrust, Hackfleisch, the common vegetables, fruit, herbs,
    cheeses, nuts ... Names with a cut word (*Paprikaschote*, *Brokkoliröschen*, *Hähnchenbrustfilet*) are understood; a compound of another food (*Kartoffelmehl*,
    *Kartoffelsalat*) is not. The table holds search words, **never catalogue codes**: another catalogue, or none, simply finds something else, and the general search
    (all words of the name, then fewer, then single words without adjectives and plural endings) takes over where the table does not apply.
  - Each candidate: `source`, `food_id` (`null` for a catalogue item), `code`, `name`, `brand`, `unit`, `per_100`.
- Also read: `Saft` / `Schale` / `Abrieb von 1 Zitrone` (also Limette, Orange, Grapefruit; `juice of` / `zest of`; half fruits) as `Zitronensaft` etc. with a typical
  yield (45 g juice, 6 g zest of a lemon; estimated); `Becher Sahne` / `Schmand` 200 g, `Becher Joghurt` 150 g (estimated); a unit written together with the name (`200gMehl`);
  `Salz und Pfeffer` / `A oder B` read as the first food, the rest goes to `note`.
- Rules like a search: needs a sign-in; a **read** access key may call it (the one POST route that only reads); the demo account may call it
  (own data rule, nothing is written).

## Recipe pictures

Every recipe (own `recipe`, `cookidoo`, `web`) can have a picture; `Food.image` says which one (`null`: none). Schema version 14
added the columns `image_hash`, `image_origin`, `image_at` and `image_url` to `food`; the files are in the folder `<database file name>.images` next to
the database (with a marker file; a folder without it is never touched), `<hash>-<size>.webp`.

| Method and path | Returns | Notes |
| --- | --- | --- |
| `GET /images/{hash}/{size}` | `image/webp` | `size`: `l` (long edge at most 960 px, for the detail), `m` (240 × 240, list), `s` (96 × 96, suggestions); the square ones are centred crops. Any signed-in caller, also with a **read** access key (like reading recipes). `Cache-Control: private, max-age=31536000, immutable` (the hash is the content hash: the address never changes for a picture; this is the only API route without `no-store`), `ETag` `"<hash>-<size>"`, `If-None-Match` gives **304**, `X-Content-Type-Options: nosniff`. **404** for a size not in the list, a hash that is not exactly 32 lower-case hex digits, a picture that no recipe uses any more (also while its file still waits to be tidied), and a missing file. |
| `PUT /foods/{id}/image` | Food | An own photo: the picture file as the request body (any `Content-Type`; JPEG, PNG or WebP are accepted, recognised by their content, not by a name or header), at most 8 MB (the interface shrinks it first). Replaces any picture; `origin` becomes `own`, and a reload from the provider never replaces it. Always possible, whatever the picture switches say. **409** the food is no recipe, **404** unknown food, **422** empty, not a picture, an unsupported format (SVG, GIF, AVIF, HEIC …) or unreadable, **413** larger than 8 MB or more than 24 megapixels (or more than 300 MB of decoded pixels), **429** more than 20 photos in 10 minutes by this person, **503** (with `Retry-After`) too many pictures are being processed (one runs, two may wait), **507** the picture folder is full (`MAHLWERK_IMAGES_MAX_MB`) or cannot be written. A write: a read access key gets 403. |
| `POST /foods/{id}/image/restore` | Food | Lifts the "taken away" mark of a provider's picture (`Food.image_removed` is true): the next reload of the recipe fetches it again. Only while the picture switch of the recipe's connector is on, else **409**; **409** also when nothing was taken away. |
| `DELETE /foods/{id}/image` | Food | Takes the picture away; for a provider's picture this is remembered (`image_removed`, a reload does not bring it back), after an own photo a reload may fetch the provider's again. **409** / **404** as above. |

Processing (in a child process with memory, CPU and time limits, one at a time): the pixel size is read from the header first
(at most 24 megapixels), only the first frame of an animation, the camera's rotation applied, an embedded colour profile discarded (pixels count as sRGB), transparency on the
paper colour `#f7f8f5`, **every piece of metadata dropped** (EXIF with GPS, XMP, ICC profile, comments), encoded as WebP (the detail
below about 150 KB). Same pixels, same hash: two recipes with the same picture share the files. A picture no recipe uses any more is
deleted when it is replaced or removed, or when its recipe is deleted; leftovers (also from foods removed by an import undo or the demo
data) are tidied at start-up (only files older than an hour, at most 2000 per pass).

**Provider pictures** (`cookidoo` and `web`) are stored only when the admin switched "Store recipe pictures" on for that connector
(`PATCH /admin/connectors/cookidoo` or `web_recipes` with `{"config": {"images": true}}`; environment `MAHLWERK_COOKIDOO_IMAGES`,
`MAHLWERK_WEB_RECIPES_IMAGES`; **off by default**). Then taking a recipe over or reloading it fetches its picture (a picture stored for the same address is **not** fetched again unless the reload is explicit: `refresh_image: true` in the body of `POST /cookidoo/adopt`, `refresh: true` or the reload route for web recipes; every fetch counts against the brake, Cookidoo's own: 30 per person and 120 in all in 10 minutes). A fetch that fails is remembered (`image_origin` `failed`), the catch-up leaves that recipe alone for 7 days. (Cookidoo: the
`image` address of the recipe details; web: `image` of the schema.org `Recipe`, a text, a list or an `ImageObject` with `url` /
`contentUrl`, relative addresses resolved against the page) through the guarded fetcher of web recipes (public addresses only, pinned,
redirects checked, own hosts blocked, 10 s, 6 MB, `image/jpeg|png|webp` only). A failing picture never fails the take-over: the recipe
simply has none. The address is stored (`image_url`) only together with a fetched picture, never while the switch is off; an `http` picture of an `https` page is refused.

## Water and fasting

Water is one total per user and day (`water` table); the goal `Goal.water_ml` defaults to 2000 ml. Adding below 0 or
above 10000 ml clamps the total.

Fasting is optional and off by default (`settings.fasting.enabled`); the routes work either way, the switch only
decides whether the client shows the timer. A user has at most one open fast. Times are Unix seconds (UTC), clients
show local time and calculate the running time from `started_at`. `target_reached` is true once the duration is at
least `target_hours`. Fasting is never rewarded: there is no badge for it and no message for stopping early. The
setting's help text names who it is not for (children, teenagers, pregnant women, people with eating disorders).

## Insights

`GET /api/v1/insights?from=YYYY-MM-DD&to=YYYY-MM-DD` evaluates the user's own data for a date range (both days
included). Without `to` it is today, without `from` it is 29 days before `to`. Everything is computed from one
query for the range.

```
Insights {
  range:      { from, to, days, logged_days }          logged_days = days with at least one entry
  first_day, last_day: day | null                      first and last day with an entry of the user (whatever the range), null without any
  granularity: "day"|"week"|"month"                    the one used for `series` (`auto` resolved)
  goal:       Goal | null
  days:       [{ day, logged:bool, kcal, protein, carbs, fat, sugars, fiber, salt, saturated_fat, weight:number|null,
                 water_ml:int|null, steps:int|null, active_kcal:number|null, workout_minutes:number,
                 goal_kcal:number|null }]              null = no value that day; goal_kcal = the day's calorie goal
                                                       every day of the range, oldest first; null counts as 0;
                                                       EMPTY beyond 370 days
  goal_kcal:  number | null                           mean calorie goal of the logged days (= goal.kcal unless activity.add_to_goal is on)
  steps_goal: int
  averages:   { kcal, protein, carbs, fat, sugars, fiber, salt, saturated_fat, water_ml, steps, active_kcal, workout_minutes }
                                                       mean over days WITH entries, never over empty days;
                                                       water_ml, steps, active_kcal: mean over days with a value (0 without any);
                                                       workout_minutes: total minutes / days of the range
  by_weekday: [{ weekday:0..6 (Monday = 0), logged_days, kcal }]      always seven items; mean kcal of logged days
  by_meal:    [{ meal, kcal, share }]                  always four items (breakfast, lunch, dinner, snack);
                                                       kcal = mean per logged day, share = part of the four-meal sum (0..1)
  top_foods:  { kcal:[Item], sugars:[Item], salt:[Item], protein:[Item] }
  weight:     { first, last, change, trend:[{day, kg}], raw:[{day, kg}] } | null     null without any weight value in the range
  adherence:  { in_range_days, over_days, under_days } | null       null without a goal
  micros:     [{ key, group, unit, nrv, average, coverage, percent_nrv }]
  hints:      [{ code, params }]
  series:     [Section]                                one item per section of the range, oldest first (see below)
  calendar:   [{ day, state }]                         state: none | under | in_range | over | no_goal; up to 370 days, else empty
  expenditure: Expenditure | null                      estimated real expenditure (see below)
  expenditure_missing: [reason]                        why `expenditure` is null, empty otherwise
  previous:   Previous | null                          only with `compare=previous`
  deltas:     Deltas | null                            only with `compare=previous`, null when either period has no logged day
}
Item { name, brand, amount_total, value, share, times }
```

- `series` and `granularity`: `granularity=day|week|month|auto` (default `auto`: days up to 45 days, weeks up to 370 days,
  otherwise months). Sections: days, ISO weeks (Monday to Sunday) or calendar months, clipped to the range, so the first
  and last may be partial; `start`/`end` are the clipped limits and zooming in sets the range to exactly them.
  ```
  Section { start, end, label_key, logged_days, days, kcal, protein, carbs, fat, sugars, fiber, salt, saturated_fat,
            water_ml:int|null, weight:number|null, steps:int|null, active_kcal:int|null, workout_minutes:number,
            goal_kcal:number|null, in_range_days, over_days, under_days }
  ```
  `label_key` is the date (day), `2026-W07` (ISO year and week) or `2026-02` (month). The nutrients are means per
  day WITH entries in the section (0 when there is none), `water_ml` the mean over days with a water value, `weight`
  the mean of the measurements in the section (null without any); the three counts need a goal (else 0).
  `days`, `calendar` and the `raw` weights are the per-day detail: `days` and `calendar` are only delivered up to
  370 days (empty lists beyond), the weight `trend`/`raw` always.
- `range=all` runs from the first to the last entry (the last 30 days without any entry; at most the last 3660
  days). `first_day`/`last_day` tell clients where the data begins and ends.
- `compare=previous` adds the period of the same length directly before the range:
  ```
  Previous { range:{from,to,days,logged_days}, averages, adherence|null, weight|null, logged_days, series:[Section] }
  Deltas   { kcal, protein, carbs, fat, sugars, fiber, salt, water_ml, steps, active_kcal, workout_minutes, weight_change, in_range_share }  each {abs, pct}|null
  ```
  `abs` is this period minus the one before, `pct` the change in percent of the earlier value (null when that is 0).
  `steps`, `active_kcal` and `workout_minutes` compare the averages. `weight_change` compares the weight changes inside the two periods (null unless both have weights),
  `in_range_share` the share of logged days within the goal range, in percentage points (`pct` null).
  `previous.series` uses the granularity of the main period, clipped to the earlier range. An empty earlier period
  gives a `previous` with 0 logged days and `deltas: null`.
- `expenditure`: the estimated real daily energy expenditure, `kcal = mean intake - slope * 7700`, where `slope`
  (kg per day) is the least-squares line through the weight measurements of the range (not first against last).
  ```
  Expenditure { kcal, low, high, intake, weight_change_kg, kg_per_week, days, weigh_ins, goal_gap:int|null }
  ```
  `low`/`high`: half-width = the larger of two standard errors of the slope (in kcal) and 10 % of the estimate.
  `goal_gap` = calorie goal minus `kcal` (negative: the goal lies below the estimated expenditure). Only delivered
  with at least 21 days, 70 % of them with entries, and at least 6 weight values spread over at least 14 days;
  otherwise `null` and `expenditure_missing` lists `short_period`, `few_logged_days`, `few_weights`,
  `weights_not_spread`. A rough estimate: it moves with the water balance and with how completely the diary is kept.
- `top_foods`: up to 8 items per list, grouped by `food_id` (entries of a deleted food by name + brand), highest
  contribution in the range first. `value` is the summed nutrient, `share` its part of the range total (0..1),
  `amount_total` the summed amount in g/ml, `times` the number of entries. Foods contributing 0 are left out.
- `weight`: `first`, `last` and `change` use the raw values; `trend` has one point per weight day, the mean of
  all values within 3 days before and after (a centred 7-day window over the values that exist).
- `adherence`: only days with entries count. In range = day kcal from 90 % to 110 % of the day's goal (`activity.day_goal_kcal`, see Activity), both limits
  included; below is `under`, above is `over`.
- `micros`: one item per additional nutrient that at least one entry of the range states, most `coverage` first (ties
  in directory order). `average` is the mean per day WITH entries (the sum divided by all logged days, also those
  where the nutrient is unknown), in the directory's unit; `coverage` is the share of the range's kcal from entries
  stating the nutrient (0..1, above 0); `percent_nrv` is `average` as a percentage of the NRV, `null` without one.
  Because unknown is not counted as zero the averages are rather too low; clients must show `coverage` with them.
  There are deliberately no hints on these values, the data is too thin.
- `hints`: rule based, at most 4, most important first. With fewer than 7 days with entries the only hint is
  `few_days`. Codes and params (all numbers rounded for display):

| code | rule | params |
| --- | --- | --- |
| `low_protein` | mean protein < 80 % of the goal | `avg, goal, pct` |
| `low_fiber` | mean fibre < 25 g | `avg, top` (names of the two biggest fibre sources) |
| `high_sugar` | mean sugars > 50 g | `avg, top` (biggest sugar source or null) |
| `high_salt` | mean salt > 6 g | `avg` |
| `weekend_higher` | Sat/Sun mean kcal > 15 % above Mon-Fri (needs 2 weekend and 3 weekday days) | `weekend, weekday, pct` |
| `meal_dominant` | one meal > 45 % of the daily kcal | `meal, pct, kcal` |
| `in_range` | positive: at least 70 % of logged days within 90-110 % of the kcal goal | `days, of, pct` |
| `protein_goal_met` | positive: protein goal reached on at least 70 % of logged days | `days, of, pct` |
| `few_days` | fewer than 7 logged days; the only hint then | `logged_days, min` |

### Nutrient curve

`GET /api/v1/insights/nutrient?key=&from=&to=&granularity=` follows one nutrient over the range: a core value
(`kcal`, `protein`, `carbs`, `fat`, `sugars`, `fiber`, `salt`, `saturated_fat`) or any key of `GET /nutrients`
(422 for an unknown key).

```
NutrientCurve { key, group:"core"|fat|carb|mineral|vitamin|other, unit, nrv:number|null, goal:number|null,
                range:{from,to,days,logged_days}, granularity, has_data:bool,
                series:[{ start, end, average:number|null, coverage }] }
```

Sections as in `series`. `average` is the mean per day with entries in the section (null without any), unknown values
are not zeros, so `coverage` (0..1, share of the section's kcal from entries that state the nutrient) must be shown
with it; `goal` is the user's goal for kcal, protein, carbs and fat, `nrv` the EU reference intake.

### Foods

`GET /api/v1/insights/foods?from=&to=&q=&sort=&limit=&offset=` lists the foods eaten in the range, grouped like
`top_foods` (by `food_id`, entries of a deleted food by name + brand). `q` is a case-insensitive search in name and
brand, `sort` is `kcal` (default), `times`, `amount`, `last` (most recent first) or `name`; ties are ordered by name.
`limit` 1-200 (default 25), `offset` for paging.

```
FoodList { range:{from,to}, total, offset, limit, kcal_total, items:[{ key, food_id|null, name, brand, times, days,
           amount_total, unit, kcal_total, share, avg_amount, first_day, last_day }] }
```

`total` is the number of foods matching `q`, `share` the part of the whole range's kcal (also when `q` narrows the
list), `key` identifies the food in the detail call (`id:<food_id>` or `n:<hash>`).

`GET /api/v1/insights/foods/detail?key=&from=&to=`:

```
FoodDetail { range, key, food_id, name, brand, unit, times, days, amount_total, kcal_total, first_day, last_day,
             monthly:[{ month:"2026-02", times, amount, kcal }],          every month of the range, also empty ones
             by_meal:[{ meal, times, share }], by_weekday:[{ weekday, times, share }],
             usual_amounts:[{ amount, times }] }                          the three most common amounts
```

## Playful feedback

Meant to motivate without scolding: habits are rewarded (keeping at it, logging, eating in balance), never eating less
or losing weight. Nothing compares people, nothing warns, and nothing is taken away after a bad day. The user
setting `playful` (`PATCH /api/v1/me/settings`, default true) switches badges off: `/badges` then returns empty lists
and tracks nothing. The weekly review is factual and stays available.

### Badges

```
Badges { earned:[{code, earned_at:int, seen:bool}], open:[{code, progress:{current:int, target:int}}], new:[code] }
```

`new` are the earned badges that are not yet `seen`. `earned_at` (unix seconds) is when the server first saw the
condition met, which is when `GET /badges` first ran after it; it is remembered, so an earned badge stays earned
even when entries are deleted later. A badge reached **only** through demo entries is marked as demo-only and
disappears when the demo data is removed (`DELETE /me/demo-data`); once real data reaches it too, it stays.
The "x of 7 days" badges look at any seven consecutive calendar days, not at calendar weeks.

| Code | Condition |
| --- | --- |
| `first_entry` | the first diary entry |
| `streak_3`, `streak_7`, `streak_30`, `streak_100` | that many days in a row with at least one entry (the longest run ever) |
| `scans_10`, `scans_50` | that many different foods logged |
| `first_recipe` | a recipe saved by the user |
| `protein_week` | protein at least 90 % of the goal on 5 of 7 consecutive days (needs a goal) |
| `balanced_week` | calories within 90–110 % of the goal on 5 of 7 consecutive days (needs a goal) |
| `fiber_5` | at least 25 g fibre on 5 of 7 consecutive days |
| `weigh_in_4` | a weight entered in each of 4 consecutive calendar weeks (Monday to Sunday) |
| `full_day_10` | 10 days with breakfast, lunch and dinner all logged |

There is no badge for "own product": foods are shared and store no author, so it cannot be told per user.

### Review

```
Review { week:"2026-W07", from:day, to:day, logged_days:int, kcal_avg:number, goal:Goal|null,
         days:[{day, logged:bool, kcal:number, state:"in"|"over"|"under"|null}] (seven, Monday first),
         best:{code, params}|null, improve:{code, params}|null, badges:[code] }
```

Exactly one `best` and at most one `improve`, never more. With fewer than 2 logged days both are `null` and
`badges` starts with `quiet_week`. `badges` also lists the badges first reached during the week (only while
`playful`). Averages are over the logged days. Both lists are checked in order; the first match wins.

`best`: `all_days` (all 7 days logged; `days`), `in_range_days` (5 or more days in 90–110 % of the goal; `days`, `of`),
`protein_days` (protein at least 90 % of the goal on 5 or more days; `days`, `of`), `fiber_avg` (average at least 30 g;
`avg`), `more_days` (more days logged than the week before, which had at least one; `days`, `before`).

`improve`: `few_days` (fewer than 4 days logged; `days`), `low_protein` (average below 80 % of the protein goal;
`avg`, `goal`, `pct`), `low_fiber` (average below 20 g; `avg`), `weekend_higher` (Saturday/Sunday average more than
20 % above Monday–Friday, with at least two weekdays logged; `weekend`, `weekday`, `pct`).

## Product catalogue

Optional and read-only for the server: one SQLite file per source, each filled offline by its own import (see the
README) and replaced atomically by it, without touching the other:

| `source` | File | Content | Import |
|---|---|---|---|
| `openfoodfacts` | `MAHLWERK_CATALOG_DB`, default `catalog.db` next to the main database | packaged products | `python -m mahlwerk.catalog import-off` |
| `bls` | `MAHLWERK_CATALOG_BLS_DB`, default `catalog-bls.db` next to the other file | basic foods (apple, bread, cooked potatoes, dishes) from the Bundeslebensmittelschlüssel 4.0 | `python -m mahlwerk.catalog import-bls FILE.xlsx\|.csv` |

A missing file is an empty source, never an error. The key of an entry is `source` + `code`; `code` is free text (the
barcode for Open Food Facts, the BLS code such as `F110100` for the BLS).

- Search takes the words of `q` (letters and digits only; any other character just separates words). Every word has
  to start a word in the name or the brand; case and diacritics do not matter (`apfel` finds `Äpfel`). BLS items are
  searched in the German and the English name (`name_en`); `banana` finds `Banane roh`.
- Without `source`, up to 8 BLS items come first, then Open Food Facts items, `limit` in all. With `source`, only
  that source, up to `limit`. So `apfel` lists `Apfel roh` before branded products.
- Open Food Facts order: names that start with the first word (as a whole word before a mere prefix), then shorter
  names, with popular products (scan count) moving up. BLS order: names that start with the first word (whole word
  before a prefix), then shorter names, where a raw basic form (`roh` / `raw` in the name) counts as 12 characters
  shorter, so `Apfel roh` comes before `Apfel getrocknet`.
- Items that already exist as a food on the server are left out (Open Food Facts: same barcode; BLS: same
  `external_id`); the catalogue only offers what is new.
- Items carry `extra` (the additional nutrients, converted to the directory's units). The file stores them as compact
  JSON in the column `extra`. An Open Food Facts file built before `extra` or `name_en` existed stays readable
  (`extra` is `{}`, `name_en` null); the next import writes the new schema.
- BLS values: `-` or an empty cell is unknown (the key is left out); `TR` (trace) and `<LOD`/`<LOQ` (below the
  detection limit) are stored as 0. Columns are found by their BLS tag in the header row, units are converted to the
  directory's (BLS quotes copper, manganese, fluoride in µg, the directory in mg). The BLS has no values for
  selenium, trans fat, added sugars and caffeine; those stay unknown.
- `adopt` with `source: "openfoodfacts"` copies the values into a food with `source: "openfoodfacts"` and the barcode.
  If a food with that barcode already exists it is returned unchanged (200); a remembered "unknown barcode" is
  replaced. With `source: "bls"` it creates a food with `source: "bls"`, no barcode, unit `g`, no serving, and
  `external_id` `bls:<code>`; adopting the same code again returns that food (200). `PUT /foods/{id}` on such a food
  makes it `own`, as for Open Food Facts.

## Demo data

Optional, off by default: set `MAHLWERK_DEMO_DATA=1` (or `true`). While it is off, both demo routes answer `404`
and `demo.available` is false. A user can then fill their own profile with invented but plausible data to try the
app, and remove it again without a trace.

- `POST` generates entries for the last `days` days up to today (default 30, 1–365; 422 otherwise) and a weight
  value on about 5 of 7 days with a gently falling trend. The numbers are the counts of **newly created** rows.
  Days that already have real entries or demo entries are skipped, and so are days that already have a weight, so a
  repeated call creates nothing twice and a larger `days` only fills the gap. About every twelfth day stays empty,
  and today only gets breakfast and lunch. Daily totals scatter around the user's calorie goal (about ±15 %, more
  at weekends). A user without a goal gets 2100 kcal / 120 g protein / 230 g carbs / 70 g fat, reported as
  `goal_set: true`. The randomness is seeded per user and day, so results are reproducible.
- `DELETE` removes this user's demo entries and weights, and demo foods that no diary entry of any user refers to
  any more (a real entry that uses a demo food keeps it). A goal set by the demo stays.
- About a third of the demo foods carry a few realistic micronutrients (`extra`), so the evaluation has something to
  show and the coverage stays below 100 %.
- Demo foods are ordinary own foods (`source: "own"`, no barcode) from a built-in catalog of everyday foods. The
  marker is internal and never part of `Food`; editing such a food with `PUT` turns it into a regular own food.
- Water: about nine in ten days get a value between 1250 and 2750 ml in steps of 250 (today a few glasses). Days that
  already have a water value are skipped; `DELETE` removes the demo water, real values stay. Saving water for a day
  makes it a real value.
- Activity: every day gets steps (about 8–10 thousand, today only part of a day), active energy and distance; two to four
  days a week one workout of a mixed kind (not today). Days that already have an activity row (or workouts) are skipped,
  `DELETE` removes the demo rows, real ones stay. Source `demo`.
- Entries and weights carry an internal `demo` flag. Saving a weight for a day replaces a demo value with a real one.

## Demo account

An admin can switch to one built-in account with invented data, so the own account stays free of test data. Off by default
(admin area, card "Demo account", or `MAHLWERK_DEMO_ACCOUNT=on|off`, which fixes the switch).

- **The account.** User name `~demo` (a name no sign-in mode can produce, so it cannot be signed in as or mapped to; a real
  user called `demo` is an ordinary user; the row is never deleted, "delete" empties it and switches it off), display name "Demo", no password, no admin right,
  no keys. Switching on makes it and fills 90 days of entries, weights, water, activity, workouts and a goal (the generator of
  [Demo data](#demo-data)); `tour_seen` is set. Its sample foods are `own` foods carrying the internal marker `demo_account`: they
  do not exist for everybody but the demo view (404 by id, not listed, not usable in recipes) and are removed with the account. No recipe, group or picture is made.
  Switching to it tops the days up to today.
- **Switching** (normal sign-in only, never an access key: 403; the CSRF header is needed). `POST /me/demo-view/enter` (admins only,
  403 otherwise; 404 while the account is off; 409 when it cannot be made) sets the cookie `mahlwerk_demo` (`__Host-` prefix over
  HTTPS; `HttpOnly`, `SameSite=Lax`, 12 hours) and answers `{can_switch, viewing:true, real_username, real_display_name}`.
  `POST /me/demo-view/leave` (204) removes it. The cookie is signed with a key in the table `setting`, tied to the real user id
  and (in `local` and `oidc` mode) to the real session, and checked on every request: the real user must still be an admin, the
  account on and present; otherwise it is ignored and deleted. Signing out ends it. Requests with an access key ignore it. In `single` and `proxy` mode (no session) the cookie lives 2 hours.
  **View header:** requests may send `X-Mahlwerk-View: own|demo`; every answer of an authenticated route carries it with the real view. A
  write (POST/PUT/PATCH/DELETE, no access key) whose header differs from the real view is refused with **409 `view changed`** and not
  executed; without the header a write is accepted as before, except as the demo account (409).
- **What a request in the demo view is.** The routes see the demo user: `GET /me` answers `username: "~demo"`, `is_admin: false`,
  `features` all false, `demo.available: false` and `demo_account: {can_switch:false, viewing:true, real_username, real_display_name}`.
  Outside the demo view `demo_account.can_switch` says whether the caller may switch (admin, account on and present).
- **What it may do.** One table in the server (`src/mahlwerk/demo_account.py`) lists every route as `read`, `own` (writes only the
  demo user's own rows: diary, weights, water, goals, settings, fasting, activity, workouts, templates, badges seen), `blocked` or
  `public`. Everything else, and every route not in the table, answers **403 `not available in the demo account`**: changing foods,
  recipes, recipe groups and pictures, catalogue adoption and barcode lookup (both store a shared product), the name, the password,
  the test-data option, keys, webhooks, connectors (Cookidoo, web recipes, Yazio), imports and the whole admin area. Webhook events of
  the demo account are never sent. A test lists all routes and fails for one that is not classified.
- `POST /admin/demo-account/reset` starts the sample data over, `DELETE /admin/demo-account` removes the account (see Admin routes).

## Importing from Yazio

The import core reads the JSON files of an export made with the unofficial "yazio-exporter" (`products.json`, `days.json`,
`weight.json`; other files are ignored, a missing one skips its part). Everything goes into the account of ONE user in a
single transaction. It can be driven three ways, all with the same core, the same counts and the same batches: the command line
(`python -m mahlwerk.yazio`, see the README), the upload routes below, and the optional direct sign-in (below as well).

### Import in the app

All routes need a normal sign-in (an access token gets **403**), act only on the caller's own account and need the
`X-Mahlwerk-Request` header. Files wait in the server's memory, per person, for 20 minutes (the clock restarts at each change),
and are dropped by `DELETE /me/yazio`, after a confirmation and when they expire.

| Method and path | Body | Returns | Notes |
| --- | --- | --- | --- |
| `GET /me/yazio` | – | `{stage:{token, source:"upload"\|"login", files:{name:bytes}}\|null, login:{enabled, available, run:Run\|null, max_months, default_months}, max_file_bytes}` | What waits, and the state of the direct sign-in (`available`: switched on **and** app identifiers set). |
| `PUT /me/yazio/files/{name}` | the file itself (not a form), plain or gzip-packed | the stage (as above) | `name` is `days.json`, `products.json`, `weight.json` or `export.zip`. The name is checked before the body is read. At most 24 MB as sent (**413**); 24 MB per file and 32 MB per person after unpacking, a packed-to-unpacked ratio above 100 and more than 200,000 objects/lists or 2 million elements over a person's files are refused (**413**); **503** when the server holds too many uploads; **429** with `Retry-After` when another upload, preview or import is running on the server (only one heavy job runs at a time), **409** when one of the caller's own is still running. A ZIP's entry count and directory size are read before it is opened (ZIP64 refused). Files of one series are collected; a ZIP replaces the area. **422**: unexpected name, empty, not valid JSON with an object on top (nothing of the content is echoed), damaged gzip/ZIP, unsafe ZIP path, ZIP with none of the three files or one of them twice. **415** for a multipart form. |
| `POST /me/yazio/preview` | `{all_products?:bool}` | Preview | Counts exactly what an import would do (a dry run, rolled back). **410** nothing waits (or it expired), **409** a preview or import of yours is still running. |
| `POST /me/yazio/confirm` | `{token, all_products?:bool}` | Preview with `batch_id` | Imports what the preview showed. **409** when the files changed since (`token` is that of the preview), **410** when nothing waits. Empties the area. The batch appears in `GET /me/imports` and can be removed like any other. Running it twice for the same files imports nothing twice. |
| `DELETE /me/yazio` | – | 204 | Discards the files and cancels a running sign-in fetch. |

`Preview` is `{token, days, entries:{product, recipe, quick}, entries_total, foods_created, foods_reused, weights, weights_kept,
water, water_kept, activity_days, activity_kept, workouts, workouts_already, goal_set, already_imported,
skipped:[{reason, count}], notes:[{text, count}], unknown_keys, dropped_values, missing_files:[string], batch_id:int\|null,
dry_run:bool}`. The work runs in a worker thread, so the server keeps answering (12,000 entries take about a second).

### Direct sign-in at Yazio (optional, unofficial)

Off by default; an admin switches the connector `yazio_login` on **and** the environment must hold
`MAHLWERK_YAZIO_CLIENT_ID` / `MAHLWERK_YAZIO_CLIENT_SECRET` (see [integrations.md](integrations.md#yazio-direct-sign-in)).

| Method and path | Body | Returns | Notes |
| --- | --- | --- | --- |
| `POST /me/yazio/login` | `{email, password, months?}` | Run (202) | Starts a background fetch of the last `months` (1 to 24, default 12) months. The server signs in once, then forgets e-mail address, password and sign-in. **404** switched off, **409** not set up or a fetch of yours already runs, **429** brake (30 seconds between attempts, 3 per hour per person, 10 per hour on the whole server; 2 runs on the server at once), **422** missing values or period (the input is never echoed). |

`Run` is `{state:"running"\|"done"\|"error"\|"cancelled", phase:"login"\|"discover"\|"days"\|"products"\|"weights"\|"done", done, total,
requests, error:string\|null, error_kind:string\|null}`; poll `GET /me/yazio` (every second or two). When the state is `done` the
fetched data waits as a stage with `source:"login"` for preview and confirmation. `error_kind` is `auth` (Yazio refused the sign-in),
`busy` (Yazio asked to slow down), `unavailable`, `unexpected` (an answer did not look as expected: the unofficial interface may have
changed), `too_large`, `limit` (request or time budget used up: choose a shorter period), `expired`, `no_data` or `cancelled`; the
text is neutral and never carries content from Yazio.

- Product entries become diary entries with a snapshot (name, brand, unit, per 100 = the Yazio value per gram x 100,
  `extra` converted from grams to the unit of the nutrient directory; keys without a counterpart are counted and
  reported, not stored). Meal = Yazio `daytime`.
- Each Yazio product that was eaten becomes a food with `source: "yazio"` (`--all-products`: also the never eaten
  ones), `serving_quantity` from its `portion` serving (else the first one). A product with a barcode whose barcode
  already belongs to a food uses that food, which is never changed; the entry still carries the Yazio values.
- Recipe portions: one `yazio` food per recipe, `serving_quantity` = sum of the ingredient amounts / portion count (g),
  per 100 g calculated back from the nutrients per portion. The entry is in grams (portions x portion weight), so its
  kcal and macros are exactly nutrients per portion x portions. They do not become editable recipes.
- Quick entries: entries without a food (`food_id` null), 100 g with per 100 g = the absolute values, so the entry's
  kcal and macros are exactly the Yazio values.
- Weights and water (per day total) only on days where the user has no value; the goal of the most recent day only
  if the user has none (with its steps goal `activity.step`).
- Activity: `daily_summary.steps` and `activity_energy` (else `exercises.activity.steps` / `energy`) and the activity's
  `distance` become the day's row with source `yazio`, only on days without a row; the energy is taken as the day's total
  active energy. Each entry of `exercises.training` and `custom_training` becomes a workout with `external_id`
  `yazio:<id>` (duration in minutes, distance in metres, start time only when the export carries a time zone). Yazio names
  map to kinds (`walking`, `running`, `cycling`, `hiking`, `strengthtraining`→`strength`, `yoga`, `pilates`, `crosstrainer`,
  `stairclimbing`→`stairs`, `circuittrainingcardio`→`circuit`, `squash`, `bowling`); unknown names become `other` and keep
  the name. A second run over an export imported before adds the activity as a batch of its own and nothing else a second
  time. Values out of range and trainings without id or duration are skipped and counted.
- Implausible values (the limits of the catalogue import, extra nutrients against the directory's maximum) are left
  out and counted, never a reason to stop. Unusable entries are skipped with a reason.
- Idempotent: the Yazio entry id is kept (`diary_entry.external_id`, unique per user, schema version 7), a second run
  adds nothing. Every run that changes something is a batch (`import_batch`; rows carry `import_id`). Removing a
  batch deletes its entries, weights, water days, activity days, workouts and goal that the user has not changed since (editing a row drops
  its `import_id`; the Yazio id stays, so it is not imported again), and the foods the batch created that no diary
  entry of any user, template or recipe item refers to. Foods another batch or user reused stay.

Removed from the prototype: `/api/v1/scan-tests` and the barcode-keyed `DELETE`.

Errors use FastAPI's default shape `{ "detail": ... }`.

## Activity

Schema version 9 (`activity_day`, `workout`; the goal gets `steps`, weight and water a `health` flag). Migration from 8 only
adds tables and columns, nothing existing changes.

- **Daily values**: steps, active energy (kcal) and distance (m) per day with a source: `manual`, `health`, `yazio`, `demo`.
- **Workouts**: `kind` is one of `walking, running, cycling, hiking, swimming, strength, yoga, pilates, crosstrainer, stairs,
  circuit, squash, bowling, dancing, football, tennis, skiing, rowing, other` (source `src/mahlwerk/activity.py`, which also
  holds the MET values and icon names). Without `kcal` the value is estimated as MET x body weight x hours; the weight is the
  latest entry up to the workout's day, else the latest of all, else 75 kg. Such a workout reads `kcal_estimated: true`; the
  estimate follows later changes of minutes and kind. Workouts do not add to the day's active energy (that is the watch's total).
- **Goal with active energy**: with `settings.activity.add_to_goal` the calorie goal of a day is `goal.kcal` plus that day's
  rounded active energy, otherwise `goal.kcal`. The rule lives in ONE function (`activity.day_goal_kcal`, fed by
  `activity.goal_bonuses`) and is used for: `Day.kcal_goal` and the ring, `kcal_left` and `kcal_goal` of `summary/today`, the
  adherence of the insights (counts, bars, calendar, series, hints), the gap of the expenditure estimate (the estimate itself
  measures the total and does not change), the weekly review (day states, strength "days in range") and the badge
  `balanced_week`. A day without a value adds 0; without a goal there is no effective goal.
- **`POST /health/sync`**, body `{days:[{day, steps?, active_kcal?, distance_m?, weight_kg?, water_ml?, workouts?:[{external_id,
  kind|name, started_at?, minutes, kcal?, distance_m?}]}], overwrite_manual?:bool}`, at most 400 days (more → 422); any invalid
  value stops the whole call with 422 and stores nothing. Everything is written in one transaction with source `health` and is
  idempotent (the same call twice changes nothing). Rules: daily values overwrite earlier `health`, Yazio and demo values but not
  a `manual` row (unless `overwrite_manual`); a value left out keeps the stored one; weight and water are only written where
  there is none, or the existing one came from a sync or is demo data (never over a value typed in, also with `overwrite_manual`);
  workouts are recognised by `external_id`, one the user changed by hand stays as it is (unless `overwrite_manual`). The kind
  comes from `kind` or the name (Health names such as "Functional Strength Training" are understood), else `other`. Answer:
  `{days, activity, workouts, weights, water}`, each `{new, updated, unchanged, skipped}` (`skipped` = protected by a manual value).
  A read key answers 403.
- **Webhook events** `activity.recorded` (a day's values were set by hand or changed by a sync; data `{day, steps, active_kcal,
  distance_m, source}`) and `workout.created` (data: the Workout; for syncs only new workouts).
- `summary/today` also returns `steps, steps_goal, active_kcal, workouts` (number today) and `kcal_goal_bonus`; `kcal_goal` and
  `kcal_left` use the goal that counts.

## Admin, access tokens and webhooks

Schema version 8. Details and examples: [integrations.md](integrations.md).

### Admin role

`GET /api/v1/me` also returns `is_admin` and `features: {access_tokens, webhooks, cookidoo}`. In `proxy` mode the groups come from
the header `MAHLWERK_PROXY_GROUPS_HEADER` (default `Remote-Groups`, comma separated); a member of `MAHLWERK_ADMIN_GROUP`
(default `admin`) is an admin. In `single` mode the one user is an admin. It is decided for every request, never stored.
A caller who signed in with an access token is never an admin.

### Access tokens

`Authorization: Bearer mw_...` works in every mode, from any peer, and wins over proxy headers and the session cookie. Never as a query
parameter. Invalid, expired or revoked: 401. Scope `read` allows only GET and HEAD (else 403). A token cannot manage
tokens or webhooks and cannot open the admin area (403). Off with `MAHLWERK_TOKENS=off` (or in the admin area): bearer
tokens then give 401 and the token routes 404.

| Method and path | Purpose |
| --- | --- |
| `GET /me/tokens` | Own tokens: `id, name, prefix, scope, created_at, expires_at, last_used_at, revoked_at`. No hash, no secret. |
| `POST /me/tokens` | `{name, scope: "read"|"write", expires_in_days?}` returns 201 with the same fields and `token`, the clear text, shown only here. |
| `DELETE /me/tokens/{id}` | Revoke (204). |

A `read` token may only use GET and HEAD, with one exception: `POST /recipes/ingredients/match` (it only reads; the text is too long for a query string).

A token is `mw_` plus 43 URL-safe characters (32 random bytes). Only its SHA-256 is stored. `last_used_at` is written at
most once per minute.

### Summary for home automation

`GET /summary/today` (any token scope): `{day, kcal_eaten, kcal_goal, kcal_left, protein, carbs, fat, water_ml,
water_goal_ml, steps, steps_goal, active_kcal, workouts, kcal_goal_bonus, weight_kg, weight_day, fasting, logged_today, last_entry_at}`. `kcal_goal` and `kcal_left` are null
without a goal (`kcal_left` is negative above the goal). `weight_kg` is the latest value of any day. `fasting` is
`{active, elapsed_seconds, target_hours}`, or null when the timer is off and no fast runs. `last_entry_at` is unix
seconds of the latest entry ever made. "Today" is the server's date.

### Webhooks

Own hooks (normal sign-in only; 404 when switched off): `GET|POST /me/webhooks`, `PATCH|DELETE /me/webhooks/{id}`,
`POST /me/webhooks/{id}/test` (202, sends a `ping`), `GET /me/webhooks/{id}/deliveries` (last 20, newest first:
`id, event, status_code, error, attempts, created_at, finished_at`). `POST` takes `{name, url, events, enabled?}` and
returns `secret` once. Only `http` and `https` targets without credentials; redirects are not followed. The host must resolve to public addresses only (checked at creation and at every delivery, sent to the checked address); `422 target not allowed` otherwise, unless an admin lists the host. A refused delivery is logged as `target not allowed`, network errors as `delivery failed`.

Events: `entry.created`, `entry.updated`, `entry.deleted`, `weight.recorded`, `water.changed`, `fasting.started`,
`fasting.ended`, `goal.changed`, `badge.earned`. Body: `{event, occurred_at, user: {username}, data}`. Headers:
`X-Mahlwerk-Event`, `X-Mahlwerk-Delivery`, `X-Mahlwerk-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.
Delivery runs in a background thread (5 s timeout, up to 3 tries, 5xx and 429 are retried); it never slows or fails a
request. `badge.earned` fires when the badges are evaluated (`GET /badges`, which the app calls after changes).

### Admin routes

All need a normal sign-in as admin (403 otherwise, also for tokens).

| Method and path | Purpose |
| --- | --- |
| `GET /admin/overview` | `version, auth_mode, db_size_bytes, schema_version, users, entries, foods, catalog`. |
| `GET /admin/users` | Per user `username, display_name, created_at, entries, first_day, last_day, tokens, webhooks` (and `demo`: true for the built-in demo account, see [Demo account](#demo-account)). Counts only. |
| `GET /admin/connectors` | `[{key, kind: source|import|interface, enabled, status, configurable, locked, config, info}]` for `openfoodfacts_lookup`, `openfoodfacts_catalog`, `bls`, `cookidoo`, `yazio_import`, `yazio_login`, `label_reader`, `demo_data`, `demo_account`, `access_tokens`, `webhooks`. The `cookidoo` card has `config.personal` and `info.account` (the shared account as `GET /admin/cookidoo/account` describes it); `yazio_login` has status `off`, `ready` or `not_configured` (no app identifiers). |
| `PATCH /admin/connectors/{key}` | `{enabled?, config?}` for the configurable ones: switches of `openfoodfacts_lookup`, `access_tokens`, `webhooks`, `cookidoo`, `yazio_login`, `demo_account` (switching it on makes the account and fills it; 409 when a user named `demo` exists); `config.personal` (boolean, own Cookidoo accounts allowed) of `cookidoo`; `config.countries` of `openfoodfacts_catalog`; `config.hosts` of `webhooks` (empty = any host with a public address; a listed host may be internal and is then the only kind allowed). Takes effect at once. 409 when an environment variable fixes the setting (listed in `locked`), 422 for invalid values. |
| `GET /admin/catalog/refresh` | `{state: idle|running|done|error, started_at, finished_at, progress, countries, result, error}`. |
| `POST /admin/catalog/refresh` | Start the Open Food Facts import in the background (202); 409 while one runs. |
| `POST /admin/demo-account/reset` | Remove everything the demo account holds and make fresh sample data up to today; answers the `demo_account` card. 409 when the account is switched off or missing. |
| `DELETE /admin/demo-account` | Remove the demo account with all its data and switch it off (unless the environment fixes it); answers the card. 404 when there is none. |

With the live lookup off, an unknown barcode is answered from the local catalogue or the stored foods only (404 if
unknown) and Open Food Facts is never called.

## Cookidoo

Optional connector, see [integrations.md](integrations.md#cookidoo). No schema change: a taken-over recipe is a row of
`food` with `source: "cookidoo"`, no barcode and `external_id` `cookidoo:<recipe id>`.

All routes need a normal sign-in (an access token gets 403) and share these answers: **404** the connector is switched
off, **409** the package is not installed or no account is set up (the text says which), **422** a reference that
is neither a recipe id (`r` and 3 to 10 digits) nor a Cookidoo recipe link, **429** too many calls to Cookidoo (at most 30
in five minutes per account, 120 for all together; runs that take over many recipes count apart, see below) or a sign-in tried too soon, **502** Cookidoo is not reachable, refused the
sign-in or answered unexpectedly (a neutral text, never details; after a refused sign-in Cookidoo is not asked again for five
minutes).

**Whose account.** A person with an own account (below, and allowed by the admin) uses it for `week`, `collections`, `recipe` and
`adopt`; everybody else uses the shared household account (the environment's, else the one stored in the admin area). Accounts
never mix: each has its own sign-in, caches and brakes. Foods taken over stay shared by the whole installation.

| Method and path | Returns | Notes |
| --- | --- | --- |
| `GET /cookidoo/status` | `{state, error, account, personal_allowed}` | `state`: `off`, `not_installed`, `not_configured`, `error` or `ready`; `error` is the neutral text of the last failure of the account in use; `account`: `own`, `shared` or `null` (whose account this person's requests use); `personal_allowed`: own accounts are allowed. Never an error status. |
| `GET /cookidoo/week` | `[{day, title, recipes:[{id, name}]}]` | The meal plan of the current week of the shared account (catalogue recipes only). Cached for 60 seconds. |
| `GET /cookidoo/collections` | `[{id, name, managed, recipes:[{id, name}]}]` | Own lists (`managed: false`) and managed collections. Cached for 60 seconds. |
| `GET /cookidoo/recipe?ref=` | `{id, name, portions, per_portion:Per100, extra, complete, food_id}` | Looks one recipe up (id or link), saves nothing. `food_id` is set when it was taken over before. 422 also when the recipe has no energy value or no values per portion. Cached for 10 minutes. |
| `POST /cookidoo/adopt` | Food (200) | Body `{recipe, collection?}` (id or link; `collection` is the id of the collection the recipe was picked from). Creates the food or, when `cookidoo:<id>` exists, updates it (idempotent; diary copies stay). With `collection` the recipe also goes into the group of that collection (see Groups of recipes below); a failing lookup of the collection never fails the take-over. |
| `GET /cookidoo/import/preview?scope=&collection=` | `{total, fresh, to_fetch, eta_seconds, seconds_per_recipe, limit, groups:[{collection, name, exists, dismissed}]}` | What taking over a selection would do (`scope`: `all`, `collection` with `collection=<id>`, or `week`), counted from the lists of Cookidoo (cached for a minute) and from what is stored. Makes no detail call. `to_fetch` is the number of calls the run will make, `eta_seconds` an honest estimate (about 4 s each), `groups` the groups the run keeps up. **422** nothing in the selection, or more than `limit` (500) recipes (the text names the number), **404** unknown collection. |
| `POST /cookidoo/import` | BulkRun (202) | Body `{scope, collection?, regroup?:false}`. Starts the run in the background and returns at once. **409** a run for this Cookidoo account is already under way, **429** (with `Retry-After`) two runs are going on for other accounts; plus the answers above. |
| `GET /cookidoo/import` | BulkRun or `null` | The latest run of the Cookidoo account this person uses: running, or finished within the last hour (so a reopened dialog sees it). |
| `DELETE /cookidoo/import` | 204 | Cancels the running run; it stops before its next call, what was saved stays. Harmless when none runs. |
| `GET /cookidoo/images/preview` | `{enabled, total, to_fetch, eta_seconds, limit}` | The catch-up for pictures: how many taken-over Cookidoo recipes have no picture (and nobody set one or took it away), how many calls to Cookidoo it would make (those whose picture address is not known), an estimate. Counted from what is stored; no call. `enabled`: the picture switch for Cookidoo is on. |
| `POST /cookidoo/images` | BulkRun (202) | Starts the catch-up (at most once per 10 minutes per account, else **429**) as a run of the same kind (`mode: "pictures"`, `scope: "pictures"`): one detail call every 3 seconds at most and only where the address is unknown, then the picture (one fetch per recipe, at least 1 s apart). Polled and cancelled like the run above (`GET` / `DELETE /cookidoo/import`). **409** the picture switch is off or a run is under way, **422** no recipe lacks a picture. Switching the picture switch off ends it. |

## Recipes from web pages

Optional connector (admin switch `web_recipes`, environment `MAHLWERK_WEB_RECIPES`, **off by default**), see
[integrations.md](integrations.md#recipes-from-web-pages). No schema change: a taken-over recipe is a row of `food` with
`source: "web"`, no barcode, `external_id` `web:<host><path>?<query>` (the normalised address without scheme) and, in its data, the
`url` and `whole`. The food has `brand` `Web · <host>` (the host without `www.`; an entry keeps only name and brand, so this is how
a diary entry is recognised as "booked in portions"), `portions`, and `url` (only an `http`/`https` address that passes the same check
as the take-over, else `null`). The values per portion are stored as 100 g of the food, so **`amount: 100` is one portion** when
logging, exactly as for Cookidoo recipes. `GET /foods?exclude_source=web` leaves them out of the product list; groups of recipes accept them.

All routes need a normal sign-in (an access token gets **403**) and the `X-Mahlwerk-Request` header. Answers: **404** the connector is
switched off, **422** the address is no address this feature fetches (not `http`/`https`, a user name or password in it, a port
other than 80 or 443, an IP address or a name without a dot, longer than 800 characters), the page is no HTML (`text/html` or
`application/xhtml+xml` only), is larger than 3 MB, or has no recipe data; **429** (with `Retry-After`) the brake: at most 20 fetches
per person and 60 for the server within 10 minutes, at most 3 at the same moment; **502** `the page could not be fetched`, also for a name that is the server's own or blocked (`MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS`), **one text for
everything that goes wrong on the way** (the name does not resolve, it resolves to an internal address, closed port, timeout, TLS error,
HTTP error status, too many or refused redirects, unreadable compression), so the answer never tells an inside from an outside or an open
port from a closed one.

| Method and path | Returns | Notes |
| --- | --- | --- |
| `POST /web-recipes/preview` | WebPreview | Body `{url, whole?:false, portions?:number, name?}`. Fetches the page (a page fetched in the last 5 minutes comes from a small shared memory: preview, switch and take-over of one address cost one fetch), reads it and shows what would be taken over; saves nothing. A POST because it makes the server open a connection (CSRF guard). |
| `POST /web-recipes` | Food (200) | Body as above plus `refresh?:false` (fetch again) and `group_id?`. Creates the food or, when `web:<address>` exists, updates it (idempotent: the same page with other tracking parameters is the same recipe). **422** when `blocked` (below). |
| `POST /web-recipes/{food_id}/reload` | Food | Fetches the stored address again; the values are renewed, the name, the number of portions and "whole recipe" the person set stay. **404** for a food that is not a web recipe. |

`WebPreview`: `{url, host, name, portions, page_portions, per_portion:Per100, extra:{sodium}, complete, whole, serving_size, ingredients:[text],
warnings:[...], blocked, food_id}`. `url` is the normalised address (scheme and host in lower case, standard port, fragment and
tracking parameters such as `utm_*`, `fbclid`, `gclid` removed, the other parameters sorted). `portions` is the person's number when
given, else the page's (`page_portions`). `ingredients` are the ingredient lines of the page, for looking at; **they are never stored**.
`warnings`: `no_portions`, `portions_range` (the page gives 4-6: the lower is used), `energy_mismatch` (energy off from 4/4/9 kcal per
g of protein/carbohydrates/fat by more than 35 % and 80 kcal), `maybe_whole` (over 1500 kcal per portion with several portions, or a
macro over 150 g: the values may be for the whole recipe), `maybe_per_100` (serving size `100 g` on the page), `rounded_off` (a value
over 500 g per portion was left out). `blocked`: `no_name`, `no_energy` (**no energy value: nothing is taken over, it would count as 0
kcal**), `too_high` (over 5000 kcal per portion), `whole_needs_portions`.

What is read, what is kept: see integrations. Nutrition values are read from `nutrition` (`calories` as kcal, else kJ / 4.184, `proteinContent`,
`carbohydrateContent`, `fatContent`, `saturatedFatContent`, `sugarContent`, `fiberContent`, `sodiumContent` (mg; salt = sodium x 2.5),
`saltContent`) with decimal comma or point, thousands separators and the units g, mg, mcg, kcal, kJ; `recipeYield` as a number, text
("4 Portionen", "Serves 4"), list or `QuantitativeValue`. **Assumption: the values are per serving** (schema.org defines them for
`servingSize`), unless the person says "whole recipe" (they are then divided by the portions).

## Photo recognition

Optional connector (admin switch `vision`, environment `MAHLWERK_VISION`, **off by default**; needs `MAHLWERK_VISION_URL` and
`MAHLWERK_VISION_MODEL`), see [integrations.md](integrations.md#photo-recognition). Nothing is stored: no photo, no answer. All routes need a
normal sign-in (an access token gets **403**; the demo account gets **403**) and the `X-Mahlwerk-Request` header.

| Method and path | Returns | Notes |
| --- | --- | --- |
| `GET /vision/status` | VisionState | `{enabled, configured, ready, per_hour}`; no address, no key. For the interface to show or hide the capture buttons. |
| `POST /vision/meal` | MealResult | The image is the request body (JPEG, PNG or WebP, at most 8 MB and 24 megapixels), like `POST /label-scans`. Query `lang`: `de` or `en` (default `en`), the language of the names. |
| `POST /vision/recipe` | RecipeResult | The same for a photo of a recipe. |

`MealResult`: `{items: [{name, grams, kcal, protein_g, fat_g, carbs_g, confidence}], note}`: at most 30 items; every number except
`name` may be `null`; `grams` 0 to 5000, `kcal` 0 to 5000, the macros 0 to 1000 for **that amount** (not per 100 g), `confidence` 0 to 1; `name` at most
120 characters, `note` at most 300. An empty `items` means no food was recognised. **All values are estimates.**

`RecipeResult`: `{name, portions, ingredients: [text], nutrition_per_portion: {kcal, protein_g, fat_g, carbs_g} | null, note}`:
`name` may be `null`, `portions` 0.25 to 100 or `null`, 1 to 80 `ingredients` of at most 300 characters (`200 g flour`),
`nutrition_per_portion` only when the page shows a table. No preparation text is returned.

Answers: **404** the connector is switched off; **409** not configured; **413** the image is over 8 MB or 24 megapixels; **422** empty body or not a
JPEG, PNG or WebP picture, or `lang` is neither `de` nor `en`; **429** (with `Retry-After`) the brake: `per_hour` photos per person and hour, `MAHLWERK_VISION_PARALLEL` (default two) runs at the same
time on the whole server, the picture worker is busy, or the model itself answered 429/503 (then with its `Retry-After`, and the photo is not counted); **502** the model could not be reached or refused the request, or its answer could not be used
(neutral texts, never the model's own text); **504** the model took longer than 90 seconds. The admin card is `vision` in `GET /admin/connectors`
(`status` `off`, `not_configured` or `ready`; `info`: `model` (the name only), `per_hour`, `env`).

## Suggestions: what still fits today

`GET /recipes/suggestions?date=&limit=5&group=&focus=balanced&anyway=false` ranks the recipes (own, Cookidoo and web ones) by how
well they fit the rest of the day. Everything comes from data on this server (goal, what the person ate, when each recipe was last
logged); nothing is fetched. Goals and history are per person, the recipes are the household's.

- `date` default today; `limit` 1-20; `group` a group id or `none` (recipes in no group); `focus`: `balanced` (default), `protein`, `light`,
  `rotation` (not eaten lately); `anyway=true`: after the goal is reached, light ideas all the same.
- The rest of the day is the goal that counts on `date` (with the active energy added when that setting is on, as everywhere) minus what
  was logged: `rest: {kcal, protein, carbs, fat}` (negative = over; `null` where there is no goal).
- Each recipe is tried at 1/2, 1, 1 1/2 and 2 portions; an amount is possible when it does not go beyond the energy rest by more than 5 % (at least
  30 kcal). The score weighs the fit of the energy (best near 60 % of the rest), the share of the open protein it covers (without a protein
  goal: protein density) and variety (days since it was last in the diary: never or 21 days and more count fully, a recipe eaten
  yesterday or today moves back); carbs and fat beyond what is left cost a little, protein never. Weights by focus and the full rule
  are in `src/mahlwerk/suggest.py`. The order is deterministic (ties: lower food id).
- Answer `{day, state, focus, goal_kcal, rest, candidates, items:[{food:Food, portions, amount, kcal, protein, carbs, fat, after:{kcal,
  protein, carbs, fat}, reasons:[...], score}]}`. `amount` is the amount to log in the unit of the food (100 per portion for Cookidoo and
  web recipes, the serving in grams for an own recipe). `after` is what would be left of the day. `reasons` (one or two): `fills_protein`,
  `high_protein`, `fits_kcal`, `not_eaten_lately`, `light`, `slightly_over`.
- `state`: `ok`; `goal_reached` (nothing left: `items` is empty unless `anyway=true`, then recipes up to 300 kcal at one or half a portion,
  lightest first); `no_goal` (no energy goal: ranked by protein density and variety); `nothing_fits` (no amount fits the rest); `no_recipes`.
- With `focus=light` the amount is one portion (a half only when one does not fit).
- Needs no write token (an access key with `read` scope works).

### Taking over many recipes at once

Every recipe needs its own detail call at Cookidoo (the lists carry no values), and the interface is unofficial. The run is
therefore a **slow, careful background job**:

- **Pace.** At least 3 seconds between two calls (about 100 recipes in 5 to 6 minutes; the preview says `eta_seconds`). The run
  has a **call budget of its own** (110 per 5 minutes per account, 200 for all accounts), apart from the interactive limit of 30 and
  120: the run neither uses up what the pages need nor can it be hurried. A cached recipe or one that is up to date costs no call.
- **One at a time.** One run per Cookidoo account (everybody who uses the shared account sees and shares that run), at most two on
  the server. At most **500 recipes** per run; a bigger selection is refused with its size (take it over collection by collection).
  Recipes the account made itself are not part of the lists and stay out, as with single take-over.
- **Idempotent.** A recipe that is already a food and was fetched less than **7 days** ago is skipped (`fresh`, no call); an older
  one is updated, a new one created. Everything is saved recipe by recipe, so a stop loses nothing and starting again continues.
- **Stops by itself** at once and without a retry when Cookidoo refuses the sign-in (`auth`), asks to slow down or the sign-in is
  braked or locked (`busy`, `wait`, `locked`), or the account was changed meanwhile (`gone`). One failing recipe is listed and the run goes on; **three
  failures in a row** (Cookidoo unreachable or answering strangely) stop it too. A recipe without an energy value per portion is skipped (`no_nutrition`) and listed.
- **Pictures** (with the picture switch on): every recipe taken over or updated by the run gets its picture once; one that is up to date
  but has no picture gets it when its address is known (no call to Cookidoo).
- **Ends** when the account is signed out, removed or changed, the person is blocked, own accounts are switched off (own-account
  runs), the connector is switched off, someone cancels, or the server stops. **A run does not survive a restart** of the server
  (its state is in memory); what was saved stays, and a new run skips it.

`BulkRun`: `{state:"running"|"done"|"cancelled"|"error", cancelling, scope, mode:"recipes"|"pictures", pictures (pictures stored),
no_picture (recipes without one: Cookidoo has none, or it could not be fetched or processed), total, done (incl. skipped and failed), fetched (calls made),
adopted, updated, fresh, no_nutrition, failed, current (name being fetched), failures:[{id, name, kind, reason}] (at most 40),
groups:[names], error, error_kind (why it stopped by itself: auth, busy, wait, locked, gone, unavailable, unexpected, or `unexpected`),
reason, reason_kind (why it was cancelled: user, account, off, shutdown), eta_seconds, started_at, finished_at}`.

**Groups made by a run.** Each collection of the selection gets a group named like it (`Groups of recipes`, `auto: true`), linked
to the collection by its id, not by the name: renaming the group changes nothing, and a later run finds it again. A recipe is added
when the group is new or the recipe is new to the server, so one that somebody took out of a group by hand does not come back. A group
the household **deleted** is remembered and is not made again unasked (the preview shows `dismissed: true`; `regroup: true` brings it
back). If a group of another name exists with the collection's name, the new group is called `Name (Cookidoo)`. The meal plan
(`week`) gets no group: it changes every week and is not a collection.

### Groups of recipes

Groups are shared by the household like the recipes. A member is a **food id**, which covers both kinds of recipe: an own recipe
(`Recipe.food.id`, source `recipe`) and a recipe taken over from Cookidoo (`Food.id`, source `cookidoo`). A recipe can be in
several groups. Deleting a group keeps its recipes; deleting a recipe (or a Cookidoo food) removes it from its groups. Access
keys work like on recipes (read for `GET`, write scope for the rest). Schema version 13 (`recipe_group`, `recipe_group_item`,
`recipe_group_dismissed`).

`Group` is `{id, name, position, auto, count, food_ids}`; `auto` is true for a group made from a Cookidoo collection.

| Method and path | Body | Returns | Notes |
| --- | --- | --- | --- |
| `GET /recipe-groups` | – | Group[] | In order (`position`), each with all its member food ids. |
| `POST /recipe-groups` | `{name}` | Group (201) | 1 to 60 characters, white space is tidied; **409** the name exists (not case sensitive), at most 200 groups. A new group goes last. |
| `PUT /recipe-groups/{id}` | `{name}` | Group | Rename; **409** name taken, **404**. An automatic group keeps its link to the collection. |
| `DELETE /recipe-groups/{id}` | – | 204 | The recipes stay. An automatic group is remembered as deleted (see above). |
| `PUT /recipe-groups/order` | `{ids}` | Group[] | Every group id exactly once, in the new order; **422** otherwise. |
| `POST /recipe-groups/{id}/members` | `{food_ids}` (1 to 1000) | Group | Adds recipes; **422** an id that is not a recipe (a product is refused), **404** the group. Adding twice is once. |
| `POST /recipe-groups/{id}/members/remove` | `{food_ids}` | Group | Takes recipes out of the group (not found ones are ignored). |
| `PUT /recipe-groups/foods/{food_id}` | `{group_ids}` | `int[]` | Exactly these groups for one recipe (the detail view's chips); `[]` takes it out of all. **422** not a recipe, **404** unknown group. |

### Cookidoo accounts

The credentials are stored encrypted (README, Stored credentials). **No answer ever contains a password**, and the e-mail address
is masked. Access keys get **403** on all of these routes; all writes need the `X-Mahlwerk-Request` header; the body limit is the
normal 1 MB; a validation error never echoes the input (the checks answer with a fixed text).

`Account` is `{source:"env"|"stored"|"none"|"unreadable", email:string|null (a***@example.org), country, language, editable:bool,
allowed:bool, key:"env"|"file"|"none"|"invalid"|null (admin routes only: where the key for stored secrets comes from), error:string|null}`.
`unreadable`: an account is stored but the key is missing or does not fit (a database restored without its key file): it counts as
not set and has to be entered again.

| Method and path | Body | Returns | Notes |
| --- | --- | --- | --- |
| `GET /admin/cookidoo/account` | – | Account | The shared household account (admin only). |
| `PUT /admin/cookidoo/account` | `{email, password, country?:"de", language?:"de-DE"}` | Account | Stores it (replaces an earlier one and drops its sign-in and caches). **409** when the environment sets the account (`MAHLWERK_COOKIDOO_EMAIL` and `_PASSWORD` win), **422** invalid values, **503** the key for stored secrets is unusable. |
| `DELETE /admin/cookidoo/account` | – | Account | Removes it. **409** when the environment sets it. |
| `POST /admin/cookidoo/account/check` | – | `{ok:true}` | One fresh sign-in attempt, braked: **429** within 30 seconds of the last check and for five minutes after a refusal (a changed account may be tried again after 30 seconds), **502** refused or not reachable, **409** no account stored, **404** connector off. |
| `GET /me/cookidoo-account` | – | Account | The caller's own account; `allowed` is false when an admin forbade own accounts (then `editable` is false too). |
| `PUT /me/cookidoo-account` | like the admin route | Account | **403** own accounts are switched off, **404** connector off. |
| `DELETE /me/cookidoo-account` | – | Account | Removing stays possible when own accounts are forbidden. |
| `POST /me/cookidoo-account/check` | – | `{ok:true}` | Like the admin check, for the caller's own account (**409** when none). |

A taken-over recipe's food stores the region it was taken over with (country, language) so that its link stays right whichever
account was used.

A taken-over recipe's food also carries `external_id` (`cookidoo:<id>`), `portions` (what the dish makes) and `url` (the recipe
at Cookidoo, built from the configured country and language, `null` for a country without a known address). `GET /foods` takes
`source` and the repeatable `exclude_source` (e.g. `exclude_source=recipe&exclude_source=cookidoo`, as the Products page asks).

How the values become a food: Cookidoo states them for **one portion** (kJ and kcal, fat, saturated fat, carbohydrates,
protein, fibre in g, sodium in mg). Mahlwerk stores a portion as `serving_quantity: 100` g with `per_100` equal to the values of
the portion, so logging `amount: 100` is one portion and 50 is half. Energy comes from kcal, else kJ / 4.184; salt is
sodium x 2.5; sodium also goes to `extra`. Values in unknown units or implausible sizes are left out (unknown, not zero);
a recipe without an energy value, or without a block for one portion, is refused. `name` is the recipe name, `brand` is
`Cookidoo`. Editing such a food in the product editor turns it into an `own` food and is limited to per-100 g ranges.

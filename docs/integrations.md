# Integrations

Mahlwerk talks to other systems in two directions: scripts and home automation read and write with a personal
**access key**, and Mahlwerk pushes **webhooks** to your own URL. Hostnames below are placeholders
(`mahlwerk.example.org`).

## Access keys

Create one in the profile (card "Access keys"): a name, read-only or read and write, optionally an expiry. The key
looks like `mw_` followed by 43 characters and is shown **once**; Mahlwerk keeps only its SHA-256. Send it in a header:

```
Authorization: Bearer mw_...
```

- Never put it in a URL. Query parameters are ignored.
- It works in every auth mode and from any address, also when a reverse proxy normally authenticates the users
  (let the proxy pass `/api/` requests that carry an `Authorization: Bearer mw_` header through, or serve the API
  on a path the proxy does not protect).
- `read` allows GET and HEAD only; anything else answers 403.
- A key acts as its owner but can never create keys or webhooks and is never an admin.
- Revoke it in the profile; a revoked, expired or unknown key answers 401. An admin can switch keys off for the whole
  server (admin area or `MAHLWERK_TOKENS=off`).

### Daily summary

`GET /api/v1/summary/today` is made for automations:

```json
{"day": "2026-11-12", "kcal_eaten": 1240.5, "kcal_goal": 2100, "kcal_left": 859.5, "protein": 61.2, "carbs": 140.0,
 "fat": 44.8, "water_ml": 1250, "water_goal_ml": 2000, "weight_kg": 79.4, "weight_day": "2026-11-12",
 "fasting": {"active": false, "elapsed_seconds": 0, "target_hours": 16}, "logged_today": true,
 "last_entry_at": 1794518632, "steps": 6240, "steps_goal": 8000, "active_kcal": 310.0, "workouts": 2,
 "kcal_goal_bonus": 0}
```

`kcal_goal` is the goal that counts today: with "add active energy to the goal" switched on in the profile it includes the
active energy (`kcal_goal_bonus`). `kcal_left` is negative when over the goal; goal and left are `null` without a goal. `fasting` is `null` when the
fasting timer is off and no fast runs. "Today" is the date on the server.

## Webhooks

Create one in the profile (card "Webhooks"): name, URL (`http` or `https`), the events to send. The signing secret
is shown once. Events: `entry.created`, `entry.updated`, `entry.deleted`, `weight.recorded`, `water.changed`,
`fasting.started`, `fasting.ended`, `goal.changed`, `badge.earned` (sent when the badges are evaluated, which the app
does after changes), `activity.recorded` (a day's steps or active energy were entered or changed by a sync), `workout.created`. "Send test" delivers a `ping`.

```json
{"event": "entry.created", "occurred_at": "2026-11-12T12:31:05Z", "user": {"username": "me"},
 "data": {"entry": {"id": 812, "name": "Oats", "brand": "Acme", "amount": 150, "unit": "g", "kcal": 300,
                    "meal": "lunch", "day": "2026-11-12"}, "day": "2026-11-12", "day_kcal": 1240.5}}
```

Headers: `X-Mahlwerk-Event`, `X-Mahlwerk-Delivery` (the id in the delivery list) and
`X-Mahlwerk-Signature: sha256=<hex>`, the HMAC-SHA256 of the **raw body** with the secret.

Delivery happens in the background: a 5 second timeout, up to three tries (a wait in between) for network errors, 5xx
and 429, no redirects. A slow or broken receiver never slows down or fails a request in Mahlwerk. Answer with any 2xx.
The last 20 deliveries per hook are listed with status and tries. An admin can switch webhooks off or limit the target
hosts (admin area, `MAHLWERK_WEBHOOKS`, `MAHLWERK_WEBHOOK_HOSTS`).

**Targets must be public.** Mahlwerk resolves the host of every target, refuses it unless ALL its addresses are public
(no loopback, private, link-local, CGNAT, multicast or reserved ranges, no `0x7f000001` tricks, IPv4-mapped IPv6 is
unpacked), and sends to exactly the address it checked. This is repeated at every delivery, so a name that later points
inside is refused too (log entry "target not allowed"). An **internal** target (typically Home Assistant in your LAN)
works only if the admin lists its host in the allowed hosts: that is a conscious decision, and then only the listed
hosts may be targets at all. Network errors are all logged as "delivery failed" (no difference between refused,
filtered and timed out).

### Checking the signature

```python
import hashlib, hmac

def valid(secret: str, raw_body: bytes, header: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)
```

Compute it over the bytes as received, before any JSON parsing.

## Home Assistant

`secrets.yaml`:

```yaml
mahlwerk_auth: "Bearer mw_..."
```

REST sensors for "kcal left" and water (a read-only key is enough):

```yaml
rest:
  - resource: https://mahlwerk.example.org/api/v1/summary/today
    headers:
      Authorization: !secret mahlwerk_auth
    scan_interval: 300
    sensor:
      - name: "Mahlwerk kcal left"
        value_template: "{{ value_json.kcal_left }}"
        unit_of_measurement: "kcal"
      - name: "Mahlwerk water"
        value_template: "{{ value_json.water_ml }}"
        unit_of_measurement: "ml"
    binary_sensor:
      - name: "Mahlwerk logged today"
        value_template: "{{ value_json.logged_today }}"
```

Reminder when nothing has been logged by 20:00:

```yaml
automation:
  - alias: "Mahlwerk: nothing logged yet"
    trigger:
      - platform: time
        at: "20:00:00"
    condition:
      - condition: state
        entity_id: binary_sensor.mahlwerk_logged_today
        state: "off"
    action:
      - service: notify.notify
        data:
          message: "Nothing in the food diary yet today."
```

Enter the weight of a smart scale (needs a read and write key):

```yaml
rest_command:
  mahlwerk_weight:
    url: "https://mahlwerk.example.org/api/v1/weights/{{ now().strftime('%Y-%m-%d') }}"
    method: put
    headers:
      Authorization: !secret mahlwerk_auth
      Content-Type: application/json
    payload: '{"kg": {{ kg }}}'

automation:
  - alias: "Scale to Mahlwerk"
    trigger:
      - platform: state
        entity_id: sensor.bathroom_scale_weight
    condition:
      - condition: template
        value_template: "{{ trigger.to_state.state | float(0) > 20 }}"
    action:
      - service: rest_command.mahlwerk_weight
        data:
          kg: "{{ trigger.to_state.state | float | round(1) }}"
```

## Apple Health via Shortcuts

The Shortcuts app on an iPhone can read Apple Health and send the values to `POST /api/v1/health/sync`. The call is
idempotent: sending the same days again changes nothing, so a shortcut that runs several times a day (and always sends
the last three days, to catch late syncs of the watch) is harmless.

What you need: an access key with **read and write** access (profile, card "Access keys"; a read-only key answers 403) and
an address of your Mahlwerk that the iPhone can reach, for example `https://mahlwerk.example.org`. At home the direct address
of the server also works (for example `http://192.168.1.20:8110`); away from home the shortcut needs the public address.
If a reverse proxy does the login, let it pass `/api/` requests that carry `Authorization: Bearer mw_` through (see
"Access keys").

Build the shortcut (names are those of the German Shortcuts app; the English ones are in brackets). The simplest form
sends today only and runs in the evening; only `day` is required, every other value may be left out.

1. **Aktuelles Datum** (Current Date), then **Datum formatieren** (Format Date): custom format `yyyy-MM-dd`, time format
   "Ohne" (None). **Variable festlegen** (Set Variable) `Tag`.
2. **Health-Messwerte suchen** (Find Health Samples): **Schritte** (Steps), start date is today. **Statistiken berechnen**
   (Calculate Statistics): "Summe" (Sum). **Zahl runden** (Round Number) to a whole number, then **Variable festlegen**
   `Schritte`. Steps must be a whole number: `5230,0` or `5.230` makes the server answer 422.
3. The same for **Aktive Energie** (Active Energy), then **Zahlen aus Eingabe abrufen** (Get Numbers from Input), which drops
   the unit ("412,5 kcal"), and **Zahl runden**; variable `Energie` (leave it out if you only want steps). The same for
   the weight, with **Text ersetzen** (Replace Text) of the comma by a point instead of rounding.
   Round it: an iPhone set to German writes `180,5` with a comma, which is no JSON number.
4. **Text**: write the JSON and insert the variables where the brackets are (tap, choose the variable):
   `{"days":[{"day":"[Tag]","steps":[Schritte],"active_kcal":[Energie]}]}` - only the day is in quotes.
   Copy the text rather than typing it: the iPhone keyboard turns `"` into typographic quotes (`„` `“`), which are no
   JSON (or switch off Settings, General, Keyboard, "Intelligente Satzzeichen" / Smart Punctuation).
   **Variable festlegen** `Daten`. Building the body as text is easier than the JSON fields of the next action, which
   cannot take a variable as a whole list.
5. **Inhalte von URL abrufen** (Get Contents of URL): URL `https://mahlwerk.example.org/api/v1/health/sync`, open the
   details: **Methode** (Method) `POST`, **Header** `Authorization` = `Bearer mw_...` (the word `Bearer`, a space, then your
   key) and `Content-Type` = `application/json`, **Haupttext anfordern** (Request Body) **Datei** (File) with `Daten`.
   Check that no header row is left empty: an empty header makes the server answer "Invalid HTTP request received" (or
   nothing at all).
6. **Ergebnis anzeigen** (Show Result) while testing.

Common answers while building it: `missing X-Mahlwerk-Request header` (403) means the `Authorization` header is missing or
lacks the word `Bearer`; 422 names the value that does not fit (usually a number written as text or with a comma).

To also catch days the watch synced late, put steps 1 to 6 into **Wiederholen** (Repeat) 3 times and send one request
per day: before step 1 use **Berechnen** (Calculate) `Wiederholungsindex` (Repeat Index) minus 1 and **Datum anpassen**
(Adjust Date) to subtract that many days from the current date; filter the Health samples with "Startdatum ist zwischen"
(Start Date is between) the start of that day and the start of the next (**Datum anpassen**, "Beginn des Tages abrufen" /
Get Start of Day, and plus 1 day). Sending a day again changes nothing. Weight (`weight_kg`), distance (`distance_m`) and
workouts (`workouts`, see the example below) are added to the same JSON the same way.

Run it once by hand and look at the answer: `new` counts rows that were created, `updated` changed ones, `unchanged` values
that were already stored and `skipped` values left alone because you typed them by hand.

Automate it: Shortcuts, tab **Automation**, **+**, **Tageszeit** (Time of Day), for example 12:00, 18:00 and 22:30 (one
automation per time), **Wiederholen** daily, action **Kurzbefehl ausführen** (Run Shortcut), then switch to **Sofort
ausführen** (Run Immediately) and turn **Beim Ausführen benachrichtigen** (Notify When Run) off. iOS may only run it while the
phone is unlocked or on the home screen for the first time; check the next day that the numbers arrived.

Example of the body the shortcut sends (three days, the second without a weight, the third with a workout that Health calls
"Functional Strength Training"):

```json
{
  "days": [
    {"day": "2026-11-12", "steps": 9100, "active_kcal": 420.5, "distance_m": 6500, "weight_kg": 80.2,
     "workouts": [
       {"external_id": "7F3A-91", "kind": "running", "started_at": 1794467400, "minutes": 32, "kcal": 310,
        "distance_m": 5200}
     ]},
    {"day": "2026-11-11", "steps": 4300, "active_kcal": 190},
    {"day": "2026-11-10", "steps": 12000, "active_kcal": 560,
     "workouts": [
       {"external_id": "B21C-04", "name": "Functional Strength Training", "started_at": 1794294600, "minutes": 40}
     ]}
  ]
}
```

Notes:

- `kind` may be a Mahlwerk kind (`walking`, `running`, `cycling`, `hiking`, `swimming`, `strength`, `yoga`, `pilates`,
  `crosstrainer`, `stairs`, `circuit`, `squash`, `bowling`, `dancing`, `football`, `tennis`, `skiing`, `rowing`, `other`) or a Health
  name; unknown names become `other` and keep their text as the name. Without `kcal` the energy is estimated from the kind,
  the minutes and your latest weight.
- Values you typed in on the day view are not overwritten by the shortcut (add `"overwrite_manual": true` to the body if you
  want the other way round). A weight or a water amount you entered by hand is never replaced.
- At most 400 days per call; one wrong value (a negative number, a weight below 20 kg, a date that is no date) makes the
  whole call answer 422 and stores nothing, so look at the answer when you build the shortcut.
- Active energy from a watch is an estimate and often too high. The profile has a switch to add it to the calorie goal; it is
  off by default.
- Never put the key into the URL; only the header carries it. Create a separate key for the shortcut so you can revoke it
  alone.

## Power Automate and n8n

Use the "When an HTTP request is received" trigger (Power Automate) or a Webhook node (n8n) and put its URL into a
Mahlwerk webhook. Typical flow for a weekly mail: receive `entry.created`, keep the running `day_kcal` of the day, and
let a schedule node read `GET /api/v1/insights` or `GET /api/v1/review` with a read key (header `Authorization: Bearer
mw_...`) on Sunday evening, then send the mail. If the flow tool cannot verify HMAC signatures, keep the URL secret and
limit the target hosts in the admin area. Where it can run code (n8n "Code" node), check `X-Mahlwerk-Signature` as above.

## curl

Requests with a key are exempt from the `X-Mahlwerk-Request: 1` header that every other writing request (POST, PUT,
PATCH, DELETE) needs in all modes (see `api-v1.md`, CSRF). Without a key, e.g. a script behind a proxy login, add
`-H 'X-Mahlwerk-Request: 1'`.

```sh
KEY=mw_...        # keep it out of shell history and scripts you share
BASE=https://mahlwerk.example.org/api/v1

curl -s -H "Authorization: Bearer $KEY" $BASE/summary/today
curl -s -X PUT -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"kg": 79.4}' $BASE/weights/2026-11-12
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"add_ml": 250}' $BASE/water/2026-11-12
```

## Cookidoo

Optional connector (off by default) that takes recipes from [Cookidoo](https://cookidoo.international/) over as foods. It
uses the unofficial `cookidoo-api` package: no public interface exists, it can break at any time, and you use it in
line with Cookidoo's terms at your own responsibility. Install with `pip install "mahlwerk[cookidoo]"` (Python 3.12+),
set `MAHLWERK_COOKIDOO_EMAIL` and `MAHLWERK_COOKIDOO_PASSWORD` in the environment (optionally `MAHLWERK_COOKIDOO_COUNTRY`,
`MAHLWERK_COOKIDOO_LANGUAGE`; defaults `de`, `de-DE`) **or** enter the shared account in the admin area (card Cookidoo), and
switch the connector on there. The environment wins over a stored account.

- The shared household account serves everybody without an own account: they see its meal plan and collections. Each
  person can add an own account in the profile (an admin can forbid that), which is then used for their requests only. The
  accounts never mix (own sign-in, caches and brakes per account).
- A stored account is kept encrypted in the database (AES-256-GCM, key from `MAHLWERK_SECRET_KEY` or a key file next to the
  database, see the README). Credentials never go into a log line, an error text or an API answer.
- A recipe taken over from an own account is shared with the household like every food.
- Only name, portions, nutrition values and the recipe ID are kept (and the address of the recipe's picture), never recipe texts.
  The picture itself only when an admin switches "Store recipe pictures" on (card Cookidoo, or `MAHLWERK_COOKIDOO_IMAGES=on`; off by
  default): then it is fetched once per recipe from the address Cookidoo gives and kept as a small copy on the server (see
  [Recipe pictures](#recipe-pictures)). The pictures belong to Cookidoo; storing them is for your own household and your responsibility.
- Only a recipe ID is ever sent to Cookidoo. A pasted link is reduced to the ID by a strict pattern
  (`https://cookidoo.<tld>/recipes/recipe/<language>/r<digits>`), nothing else is fetched.
- Access keys cannot use the connector (normal sign-in only).

```sh
# with a session cookie / proxy sign-in, as the web interface does it
curl -s -H 'X-Mahlwerk-Request: 1' https://mahlwerk.example.org/api/v1/cookidoo/week
curl -s -H 'X-Mahlwerk-Request: 1' -H 'Content-Type: application/json' \
  -d '{"recipe": "https://cookidoo.de/recipes/recipe/de-DE/r59322"}' https://mahlwerk.example.org/api/v1/cookidoo/adopt
```

The result of `adopt` is a food with `source: "cookidoo"`; log it like any food, `amount: 100` is one portion (the web
interface shows and asks for portions, never for 100 g). In the web interface taken-over recipes appear on the Recipes page,
not under Products: `GET /foods?exclude_source=cookidoo` leaves them out, `GET /foods?source=cookidoo` lists them. Such a
food also answers with `external_id`, `portions` and `url` (the recipe at Cookidoo, only when `MAHLWERK_COOKIDOO_COUNTRY` is
a country whose address is known; the link is built, never fetched).

### Taking over many recipes at once

Under "Take over from Cookidoo" (Recipes page) a collection, the week's plan or everything can be taken over in one go
("Take over all", "Take over the week", "Take over everything"). **The interface is unofficial, so this is slow on purpose.**

- Every recipe needs its own detail call at Cookidoo (the lists have no values). The run makes **one call every 3 seconds at
  most**, so 100 recipes take 5 to 6 minutes; the question before the start says how many calls and how long (an estimate: Cookidoo
  may be slower, and the first call signs in). The calls count against a budget of their own, so the normal use of the pages
  (30 calls in 5 minutes per account) is never locked out by a run and a run cannot be hurried.
- One run per Cookidoo account at a time (people who share the account share the run and see its progress), at most two on
  the server, at most 500 recipes (more: take over collection by collection). The run goes on in the background when the
  dialog is closed; reopening the dialog shows it, also for an hour after it ended. It does **not** survive a restart of
  the server; what was saved stays and a new run skips it.
- A recipe taken over less than 7 days ago is skipped (no call), an older one is updated: running it again is cheap and safe, and
  it is also how a run that was stopped continues.
- It stops at once, without trying again, when Cookidoo refuses the sign-in, asks to slow down or the sign-in is braked: repeated
  wrong sign-ins are what gets an account blocked, so there are none. One recipe that fails (or has no energy value per portion) is
  listed at the end and the run goes on; three failures in a row stop it. It also ends on sign-out, a changed or removed
  account, switching the connector off, and "Stop".
- **Groups.** A collection becomes a group of recipes with its name, linked by the collection's id: renaming the group is
  respected, and a group you delete is not made again unasked (the question offers to make it again). The meal plan gets no
  group. See "Groups of recipes" in [api-v1.md](api-v1.md#groups-of-recipes).

## Recipes from web pages

Paste the address of a recipe page (Recipes page, "Take over from a link"); the server fetches **that one page**, reads the
nutrition values it publishes for search engines and, after a preview, takes the recipe over as a food with its values per
portion. Off by default: an admin switches it on in the admin area (card "Recipes from web pages") or with `MAHLWERK_WEB_RECIPES=on`.
Why off: it is the one feature where the server opens connections to sites that **people** name, which the operator should
decide on consciously (the server's address becomes visible to those sites). It is one click to switch on.

- **What is read:** schema.org `Recipe` as JSON-LD (`<script type="application/ld+json">`, also in `@graph`, lists and the usual
  wrappers, `@type` as text or list). Microdata is not read (it would need a real HTML tree; the standard library has only a tag
  scanner). A page without such data says so; nothing is guessed from the text.
- **What is kept:** name, number of portions, nutrition values per portion, the address and the host (shown as the source), and the
  address of the page's picture. **Not kept and not shown:** preparation steps, descriptions; the picture itself only when an admin
  switched "Store recipe pictures" on for this connector (off by default; see [Recipe pictures](#recipe-pictures)). The ingredient lines are shown in the preview only (and, if
  there are no nutrition values, as a memo while a person types an own recipe, for that sitting) and are never stored: the food has
  no field for them, and storing a site's ingredient list would copy more of its content than the nutrition facts we need.
- **Nutrition values are per serving** unless the person says otherwise (see api-v1.md). The preview warns when the energy does
  not fit the macros or the values look like the whole dish; "The values are for the whole recipe" divides them by the portions.
  Without an energy value nothing is taken over.
- **The fetch** (`src/mahlwerk/webrecipes.py`, `netguard.py`): only `http`/`https`, ports 80 and 443, no user name in the address,
  no IP address; the name is resolved on the server and **every** address must be public (there is no list of exceptions for this
  feature, unlike webhook hosts) and the connection goes to exactly the address that was checked, with the original host in `Host`
  and for TLS (so a changing DNS answer gains nothing); redirects are followed by hand, at most 3, every station is checked again,
  `https` to `http` is refused; 10 seconds in total; at most 3 MB after decompression (counted while it arrives, so a compression
  bomb stops early); only `text/html` and `application/xhtml+xml`; no cookies, no `Referer`, `User-Agent: Mahlwerk/<version>
  (<MAHLWERK_CONTACT>)`; JSON-LD blocks are limited in size, number and search depth; whatever comes back is plain text (tags and
  control characters removed, lengths limited) and the stored link is only ever an `http`/`https` address. Every failure on the way
  gives the same message (only for a *public* site that answered do the texts differ: not HTML, too large, no recipe data, which tell nothing about
  the inside). The 10 seconds cover the whole fetch of an address, name resolution and redirects included. Names that are the server's own (`MAHLWERK_PUBLIC_URL`,
  `MAHLWERK_ALLOWED_HOSTS`) or listed in `MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS` (with their subdomains) are refused like internal targets, also on every redirect;
  list your own domains before you switch the connector on (hairpin NAT). Text encodings are limited to UTF-8, ASCII, ISO-8859-1/-2/-15 and Windows-1250/1252
  (others are read as UTF-8). A brake limits the use (20 per person and 60 in all per 10 minutes, 3 at the same time).
- **robots.txt:** one fetch of one page that a signed-in person names and looks at, like opening it in a browser. Nothing is crawled
  or fetched in bulk, and there is deliberately no "take over a whole site". Mahlwerk does not read `robots.txt` for that. If a site
  does not want to be read, a person can simply not paste its link; an operator who wants to forbid it switches the connector off.
- The address is saved **with its query** and is visible to everybody on the server: do not use links with personal share tokens (only tracking parameters are
  removed). http and https of one page are one recipe; an http address cannot replace one taken over through https. Without an energy value nothing is taken over.
- Only signed-in people can use it (no access keys); a recipe taken over is shared with the household like every food.

```sh
curl -s -H 'X-Mahlwerk-Request: 1' -H 'Content-Type: application/json' \
  -d '{"url": "https://recipes.example.org/lentil-salad"}' https://mahlwerk.example.org/api/v1/web-recipes/preview
```

## Photo recognition

Two functions on one connector: a photo of a **meal** becomes a list of recognised parts with estimated amounts and nutrition
values, and a photo of a **recipe** (book page, print-out, screen) becomes a name, a number of portions and ingredient lines.
It uses an image model that **you** configure. Off by default: an admin switches it on in the admin area (card "Photo
recognition") or with `MAHLWERK_VISION=on`, and it works only once the model is configured. This page describes the server side
(routes, card, settings); [How to use it](#using-photo-recognition-in-the-interface) below describes the capture screens.

**Protocol.** One general one, the widely implemented OpenAI-compatible `POST {base}/chat/completions` with one user message made
of a text and an `image_url` (`data:image/jpeg;base64,...`). It covers local servers (Ollama, LM Studio, llama.cpp) and hosted
providers alike. There is no provider library: the call is plain `httpx` (`src/mahlwerk/vision.py`). The model must reply with one
JSON object (the prompt says so; the shapes are in api-v1.md).

| Variable | Meaning |
| --- | --- |
| `MAHLWERK_VISION_URL` | The base address of the API, normally ending in `/v1`, e.g. `http://127.0.0.1:11434/v1`. `/chat/completions` is added. `http` or `https`, no user name in it. |
| `MAHLWERK_VISION_MODEL` | The name of a model that can read images (a "vision" model). |
| `MAHLWERK_VISION_KEY` | Optional. Sent as `Authorization: Bearer ...`. |
| `MAHLWERK_VISION` | `on` / `off` fixes the switch (the admin area shows it as fixed). Without it the admin decides; default off. |
| `MAHLWERK_VISION_PER_HOUR` | Photos per person and hour, default 30 (1 to 10000). |
| `MAHLWERK_VISION_PARALLEL` | Runs at the same time on the whole server, default 2 (1 to 8). Set it to what your model can really do at once; a local model often manages one. |

Keep the key (and the other settings) in an environment file readable only by the service user (mode `0600`, `EnvironmentFile=` in systemd, `env_file:` in Compose), **not** as `Environment=` in a unit file or in a world-readable Compose file: those are visible to every local user (`systemctl show`, `docker inspect`). An address with a query (`?...`), a fragment or a user name in it counts as not configured.

An internal address is allowed here **on purpose**: a local model lives in your network, and only the operator can set the
environment (unlike webhook hosts or recipe links, which people name). The card shows the name of the model, never the address
or the key.

Example for a local model with [Ollama](https://ollama.com) on the same machine (any vision model you have pulled; from a
container use the host's address instead of `127.0.0.1`):

```sh
ollama pull <a-vision-model>
MAHLWERK_VISION=on
MAHLWERK_VISION_URL=http://127.0.0.1:11434/v1
MAHLWERK_VISION_MODEL=<a-vision-model>
```

**Privacy.** The photo goes to whatever you configured. With a local model nothing leaves your network; with a hosted provider the
photo (shrunk, see below) and your prompt go to that provider and its terms apply: say so to the people who use your server. Before
sending, the server decodes the photo in the picture child process (see SECURITY.md), turns it as the camera meant, shrinks it to
at most 1568 pixels on the long edge and writes a **new JPEG from the pixels alone**: no EXIF, so no GPS position, no camera or
time data, no comment, no embedded profile. **Nothing is stored**: not the photo, not the answer; no log line holds anything of
either (only the kind of a failure and an HTTP status). Recipe photos: only name, portions, ingredients and, if the page has a
table, the values per portion are read; **the method text is neither requested nor kept**.

**The answer is not trusted.** Text inside a photo can steer a model ("ignore your instructions..."), and a model can write
nonsense. So the answer is read strictly: JSON only (also from a fenced block), only the known fields, texts cleaned (no control
characters, no markup) and cut (name 120 characters, at most 30 meal parts or 80 ingredient lines of at most 300 characters), numbers
checked and clamped to sensible ranges, `NaN` and `Infinity` refused. An answer that does not fit is a **502** with a neutral
text; the raw text of the model is never passed on.

**Limits and brakes.** Photos: 8 MB, JPEG, PNG or WebP, at most 24 megapixels (like the label reader). Connection 5 seconds,
whole call 90 seconds (a hard limit: a timer closes the connection), answer at most 256 KB counted as it arrives (`Accept-Encoding: identity`; a compressed answer is refused), redirects are not followed, only the first 64 KB of the model's text are looked at. Per person `MAHLWERK_VISION_PER_HOUR` photos an hour and
**`MAHLWERK_VISION_PARALLEL` runs at the same time** (default two) on the whole server; beyond that **429** with `Retry-After`. When the model itself answers 429 or 503 (it is busy), the person gets **429** with the model's `Retry-After` (default 10 s) and the photo is **not** counted against the hourly allowance. Only signed-in people (no access keys),
never the demo account.

**Limits of the result.** Amounts and nutrition values of a meal are **estimates** from a picture: portion sizes, hidden fat and
sauces are guesses, and models differ a lot. The interface shows them as suggestions to check before anything is booked. Small
local models are often much worse at this than large hosted ones; try yours with photos you know.

```sh
curl -s -H 'X-Mahlwerk-Request: 1' -H 'Authorization: ...' --data-binary @meal.jpg \
  'https://mahlwerk.example.org/api/v1/vision/meal?lang=en'
```

(The session cookie of a browser sign-in is used the same way; an access key is refused with 403.)

### Using photo recognition in the interface

The entries appear only while the connector is on **and** configured (and not in the admin's demo-account view, which is read-only). The
first time on a device a short notice says that the photo goes to the image model set up by the operator and is not stored.

- **Photo of the meal.** Day view, "+" of a meal, then "Photo of the meal" (above the search field, and on the scan tab). Take a
  photo or choose one (it is shrunk in the browser to 1600 px, JPEG). The waiting state can be cancelled; the model needs a few
  seconds, up to 90. The result is a check step with one row per recognised part: name, grams (change them), the food of the
  database it was matched to (the same matcher as "Paste ingredient list"), and "leave out". Nutrition comes from the matched food. Where no
  food fits, search one, or "Use estimate": an own food is made from the model's values (per 100 g, calculated from its amount;
  only when it gave energy and an amount). The sum (energy, protein) is shown before "Add to the diary" books all remaining rows into
  the chosen meal and day; a toast offers "Undo". All amounts are estimates, and the note of the model is shown as plain text.
- **Photograph a recipe.** Recipes page, "+" menu (phone) or "Take over" menu (wide), then "Photograph a recipe". The new recipe
  opens with name and portions filled in and the ingredient check step open (lines already matched). If the photo shows nutrition per
  portion, the check step shows it next to the calculated energy per portion ("on the photo"). "Add another photo" appends the lines of a
  second page. The method is never taken over.
- Failures are explained in plain words with "Try again": a busy model or the hourly limit (429, with the wait from `Retry-After`), an
  unusable answer or an unreachable model (502), a timeout (504), a file that is too large (413), no connection. An empty answer ("nothing
  recognised") offers another photo.
- In the demo build the screens run on made-up answers (`?vision=busy|error|big|empty` in the address shows the failure cases).

## Recipe pictures

A recipe can have a picture: large in its detail, small in the list, tiny among the suggestions.

- **Own photos** are always possible: `PUT /api/v1/foods/{id}/image` with the file as the body (the interface shrinks it in the
  browser first, because a phone photo is large and reverse proxies limit uploads), `DELETE` takes it away. An own photo wins over
  everything and is never replaced by a reload.
- **Provider pictures** need the switch "Store recipe pictures" of the connector (Cookidoo or Recipes from web pages; off by default).
  Then a picture is fetched when a recipe is taken over or reloaded (not again for an address that is stored already, unless the person reloads; every fetch counts against a brake), through the same guarded fetch as web recipes (public
  addresses only, pinned connection, redirects checked, your own names blocked, 10 s, 6 MB, JPEG/PNG/WebP only). For Cookidoo recipes
  taken over before, "Fetch missing pictures" in the Cookidoo dialog runs a slow catch-up (a detail call every 3 seconds at most and
  only for recipes whose picture address is not known, then one picture fetch per recipe). Web recipes get theirs with "Reload from
  <host>"; there is no bulk fetch of web pages by design.
- **On the server** every picture is checked from its header (format, at most 24 megapixels), decoded in a limited child process,
  turned as the camera says, stripped of all metadata (GPS!), converted to sRGB and stored as three WebP files named by their content
  hash in `<database file name>.images` next to the database. The browser asks the server only (`GET /api/v1/images/<hash>/<size>`, signed-in people and
  read keys); the content security policy forbids pictures from anywhere else.

```sh
# an own photo for a recipe (its food id), with an access key that may write
curl -s -X PUT -H "Authorization: Bearer $KEY" --data-binary @dinner.jpg https://mahlwerk.example.org/api/v1/foods/42/image
```

## Suggestions: what still fits today

The day view (a quiet card under the meals, foldable, switchable in the profile) and the Recipes page (section "Fits today" with a
choice of focus and the group filter) show recipes that fit the rest of the day: the energy and protein that are left, a
suggested amount, one or two reasons in words, what would be left afterwards. `GET /api/v1/recipes/suggestions` returns the same
(see api-v1.md); it can feed a home-automation display. It needs no network and no new data; "+" opens the normal amount dialog with
the suggested amount in it.

## Yazio direct sign-in

Optional connector (off by default) that lets a person sign in at Yazio **once** from the profile, so the server can fetch the
diary and show the same preview as the file upload. **Read this before you switch it on.**

- **It is unofficial.** Yazio publishes no API. The calls below come from public, community-written clients; Yazio can change or
  block them at any time, and using them may be against Yazio's terms. An admin switches it on at their own responsibility
  (card "Yazio direct sign-in"). **The project has never run it against the real service**: it is tested only with a stand-in
  that follows the documented answers.
- **Setting it up (operator).** The sign-in needs the `client_id` and `client_secret` of the Yazio app, the identifiers that the
  public export projects listed below carry in their source code. **Mahlwerk ships no defaults** (maintainer's decision), and
  they cannot be entered in the interface: put `MAHLWERK_YAZIO_CLIENT_ID` and `MAHLWERK_YAZIO_CLIENT_SECRET` into the server
  configuration (environment, `.env` or the Compose file), **restart the server**, then switch the connector on in the admin
  area. Until both are set the admin card says "Not configured" and shows this hint. Whether you take the values from those
  projects is your decision and your responsibility. **The file upload works without any of this.**
- **What it does.** `POST https://yzapi.yazio.com/v15/oauth/token` (JSON: client id and secret, `username`, `password`,
  `grant_type: "password"`) once; then, with the returned bearer token and a handful of read-only `GET` requests per day:
  `/user/consumed-items/nutrients-daily` (which days have entries, one request per month), `/user/consumed-items`,
  `/user/exercises` and `/user/widgets/daily-summary` (per day), `/products/{id}` and `/recipes/{id}` (per product and recipe
  that was eaten) and `/user/bodyvalues/weight/last` (per logged day). The answers are put into the structure of the
  exporter's files and imported by the same code as an upload.
- **What it keeps.** Nothing of e-mail address, password and token (memory of the fetching thread for the run only; no refresh
  token). Nothing in logs or error texts. The fetched data waits in memory like an upload (20 minutes) until confirmed.
- **Brakes.** Fixed host and base path, https only, no redirects, 20 s timeout and 2 MB per answer, at most 4 requests at once,
  at most 8000 requests and 20 minutes per run, 1 to 24 months, 2 retries on server errors, no retry of a refused sign-in; per
  person one run at a time and at most 3 sign-in attempts an hour (30 seconds apart), at most 10 an hour on the whole server; 2 runs on the server at once; 48 MB of answers per run; a run ends when its person signs out or is blocked or the connector is switched off.
- **Sources of the interface** (read on 2026-11-13): the exporter whose files the importer reads,
  [aleksandr-bogdanov/yazio-exporter](https://github.com/aleksandr-bogdanov/yazio-exporter) (MIT per its README), the TypeScript
  client [juriadams/yazio](https://github.com/juriadams/yazio) and the community Swagger description
  [saganos/yazio_public_api](https://github.com/saganos/yazio_public_api) (MIT). Mahlwerk contains no code of them; it uses the
  endpoint paths and response fields they document.

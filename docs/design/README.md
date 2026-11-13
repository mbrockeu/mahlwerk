# Design direction "D"

Chosen on 2026-11-12. The reference is `day-view-mockup.html` in this folder (a static mock-up of the day
view at 390 × 844; open the file and read its inline styles, they are the source of truth for sizes).

The look must not be plain or generic. It lives from one strong colour block, chunky uneven shapes and one
recurring signature: the **tick scale** of a grinder dial.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| stone | `#eceee9` | page ground |
| paper | `#f7f8f5` | list rows, sheets, inputs |
| ink | `#17211c` | text, dark surfaces (nav bar, call-to-action row) |
| quiet | `#4b574f` | secondary text (passes 4.5:1 on stone and paper) |
| green | `#1d5c43` | the hero block, primary buttons |
| green-deep | `#174a36` | inner disc of the dial |
| green-tick | `#4d8a70` | unfilled ticks on green |
| lime | `#c9f04a` | filled ticks, scan button, positive accents; text on it is ink |
| orange | `#ff8a1f` | protein tile, dial pointer; text on it is `#17130f` |
| pink | `#ffb8d6` | fat tile |
| hairline | `#c9cec6` | dividers |
| warn | `#9a4a00` | warnings on light ground |

Dark mode is a second set of values for the same tokens, see "Dark theme" below.

## Type

- **Bricolage Grotesque** 800 – page titles and big numbers (letter-spacing −0.03 to −0.05em).
- **Schibsted Grotesk** 400/500/600 – body and labels.
- **IBM Plex Mono** 500/600 – small figures, dates, units, uppercase micro labels (letter-spacing 0.08em).

Fonts must be self-hosted (no request to Google at runtime): download the woff2 files into the app.

## Shapes

- Uneven radii mark the important things: hero `44px 44px 44px 14px`, tiles `28px` with one `8px` corner,
  the call-to-action row `20px 20px 20px 8px`.
- List rows are `paper` pills, radius 20, height 52.
- The navigation is a floating `ink` pill (radius 36, 18px from the bottom, respects the safe area) with the
  lime scan button; the active item is a `paper` pill with icon and label.
- From 900 px the bar becomes a rail on the left. Daily views (Today, Insights, Weight) are on top. Management
  (Products, Recipes, Admin if allowed, then the round profile button with the initial) forms a second group at the
  bottom, set apart by a fine divider, above the scan button.
- On the phone the bar holds the four main places: Today, Insights, Products, Recipes, plus the scan button (the
  active item shows its label as before). Everything else is in the **more menu**: the round avatar at the top right of
  every main page (Today, Insights, Products, Recipes, Weight) opens a small floating `ink` sheet (radius
  `28px 8px 28px 28px`, one square-ish corner under the avatar) with Weight, Badges (if playful feedback is on),
  Profile and goals, Admin (admins) and, in the modes with their own sign-in (`local`, `oidc`), Sign out. Opening
  moves focus into the menu; Up/Down/Home/End move, Esc and a tap outside close, Esc returns focus to the avatar;
  `aria-haspopup`/`aria-expanded`; it unfolds softly (no motion with `prefers-reduced-motion`). The avatar scrolls
  away with the title row, like the title; the title row keeps 56 px free for it. Profile, Badges and Admin have their
  own close button at that place and no avatar. From 900 px the avatar is hidden (the rail has it all).
- Weight has a quiet tile on the day view (latest value, the change over 7 days as arrow and words; it opens the weight
  page; without any value a dashed invitation row instead). Screen: `screens/156-mobile-menu.png`.
- Cookidoo recipes stand in the Recipes list beside the own ones, with a small mono "Cookidoo" label; their detail shows values per
  portion (never "per 100 g"), a note that ingredients and steps are at Cookidoo with a link, "Reload from Cookidoo" and "Remove"
  (no editor); amounts are portions (½, 1, 2). Screen: `screens/158-recipes-cookidoo.png`.
- Recipes from a web page stand in the same list, labelled with their host (mono, small); their detail is the Cookidoo detail with
  "Open at <host>", "Reload from <host>" and "Remove". "Take over from a link" opens a sheet: address field, then a preview card
  (host, name, portions, switch "the values are for the whole recipe", kcal and the three macro tiles, warnings as a "Check" tag
  plus text, ingredients folded, "Take over"). No values: said plainly, no take-over, "Start an own recipe instead". Screen: `screens/161-recipe-link.png`.
- "What still fits today": on the Recipes page a paper section above the chips (title, rest of the day, four focus chips, up to four
  cards with name, source label, amount, kcal and protein, one line of reasons in words, "then n kcal left", a round "+"); on the day view
  the same as a quiet outlined card under the meals that folds up (state remembered per device) and can be switched off in the profile.
  The goal reached is stated calmly, light ideas only on request; never a reprimand. Screen: `screens/162-suggestions.png`.
- Recipe pictures: in the detail a narrow panel (a phone, a sheet, a pane under 640 px) lets the picture fill the top of the green head block edge to
  edge (4:3), its upper corners follow the block (44 px), the lower ones are uneven (`10px` right, `36px` left) against the green; a panel from
  640 px wide (the content in two columns, decided by the width of the panel, not the window) has a head block without a picture and the picture
  as a card of its own in the right column beside the values table, as high as that table (grid rows stretch, `object-fit: cover`, radius
  `28px 28px 8px 28px`, at least 240 px), with the source block (note, "Open at ...") or the ingredients below it and extra nutrients on the left;
  without a picture the right column starts with the source block and "Add photo" stays among the head buttons. No text
  ever lies on it, except the credit of a provider's picture ("Image: Cookidoo") on a small `paper` label at the lower left. Change and remove
  are round `paper` buttons (44 px, radius `16px 16px 16px 6px`) at the upper right of the picture; without a picture the block has an
  "Add photo" ghost button and looks as before. The list gets a 44 px picture on the left of each row (radius `16px 16px 16px 6px`, rows 56 px)
  only once any recipe has one; rows without show a quiet stand-in (a short arc of dial ticks in `hairline` and the first letter in
  `quiet`). Suggestions show a 40 px picture before the name, only while one of the shown recipes has a picture. Lists are decorative
  (`alt=""`), the detail picture says "Photo of <name>". Screen: `screens/163-recipe-images.png`.
- Icons: inline stroke SVG, 2–2.4px, round caps. No emoji, no icon font.

## Signature: the tick scale

- Day ring: 48 ticks on a circle (SVG circle with `stroke-dasharray`), unfilled `green-tick`, filled `lime`,
  an orange pointer knob at the current position. Over 100 % the ring is full and the pointer turns `pink`
  … never red, never a warning tone.
- The same ticks as a straight scale inside the macro tiles and around the scan button.

## Motion

Motion is where the "wow" comes from; keep it short and physical.

- On opening a day the ring fills tick by tick (about 700 ms, ease-out) and the big number counts up.
- After logging an entry the ring advances from the old to the new position and the pointer overshoots
  slightly (spring).
- A successful scan: the scan button pulses once and the amount sheet slides up.
- Honour `prefers-reduced-motion`: no fill animation, no count-up.

## Tone

Friendly and factual. Going over a goal is shown, never scolded. German and English. The language follows the browser unless the profile (card "Appearance") sets
German or English for this device; a change reloads the page once, unsaved goal edits are carried over.

## Dark theme

Chosen in the profile (card "Appearance": Automatic / Light / Dark), kept per device in `localStorage`
(`mahlwerk.theme`). Automatic follows `prefers-color-scheme` and reacts live. A small inline script in
`index.html` sets `data-theme` on `<html>` (and `<meta name="theme-color">`) before the first paint;
`lib/theme.svelte.ts` keeps it current. All colours run through CSS variables; `:root[data-theme='dark']` in
`app.css` redefines them. The manifest colours stay light.

Direction: a green-black ground, cards one step lighter, the green hero kept (a touch deeper), lime / orange /
pink kept as accent and tile colours with dark text on them. Surfaces that are dark in the light theme (navigation,
week review, fasting card, "What is on the menu?" row, kcal block, save bar) become a lighter green-grey surface with
a fine green outline (`--deep`, `--deep-edge`) so that they do not sink into the ground. Selected chips and tabs
invert (light fill, dark text) instead of using the dark surface.

| Token (dark) | Value | Use |
| --- | --- | --- |
| stone | `#0f1512` | ground, inset fields inside cards |
| paper | `#1b2620` | cards, list rows, inputs |
| sheet | `#141c18` | bottom sheet / dialog, with a 1px `#2a3a31` edge, scrim `rgba(0,0,0,.62)` |
| text | `#eef1ec` | text, also `ink` |
| quiet | `#a5b2a9` | secondary text |
| hairline | `#34443b` | dividers; `--field-line` `#4d6355` for input outlines |
| green / green-deep | `#1a6246` / `#134733` | hero blocks, toast |
| primary | `#2a8461` | primary buttons (white text) |
| green-text | `#7fd4a8` | green as text or icon on cards |
| deep | `#22312a` | dark surfaces; edge `#41594b`, inner lines `#46604f` |
| on-deep | `#eef1ec` | text on `deep` |
| sel-bg / sel-fg | `#eef1ec` / `#17211c` | selected chip, tab; active navigation item |
| warn | `#ffb066` | warnings, destructive buttons |
| bar / bar-soft / bar-over | `#4fae85` / `#4f8068` / `#ef8db9` | chart bars, scale fill, over-goal part |
| series-dark | `#5d7b69` | "dark" series (dinner, weekend) |
| track / dim / tick-off | `#2c3a32` / `#6e7e73` / `#5f7568` | empty scale, empty-day dot, unfilled ticks on `deep` |
| focus | `#c9f04a` | focus ring everywhere (3px, offset 2px) |

lime, orange, pink, `on-tile`, `green-tick` are unchanged.

Contrast (WCAG, computed from the values above):

| Pair | Ratio |
| --- | --- |
| text on ground / on card | 16.2 / 13.7 |
| quiet on ground / card / sheet | 8.4 / 7.1 / 7.9 |
| on-deep on deep | 12.0 |
| `#cfd6cc` and `#b9c7bd` (secondary text on deep) on deep | 9.2 / 7.8 |
| white on hero green; `#d5ead0` label on it; lime on it | 7.3; 5.7; 5.6 |
| white on primary button | 4.6 |
| green-text on card | 8.8 |
| warn on card | 8.7 |
| dark text on lime / orange / pink | 12.6 / 7.8 / 11.5 |
| sel-fg on sel-bg | 14.5 |
| white on series-dark (dinner segment) | 4.7 |
| focus ring on ground / card | 14.1 / 11.9 |
| bar on card (graphic, needs 3) | 5.8 |

Weak by design: card against ground (about 1.2) and hairlines (about 1.5) are shape cues, never the only carrier of
information; input outlines use `--field-line` (about 2.4 on a card, better than in the light theme).

Screens: `screens/90-dark-today-mobile.png`, `91-dark-insights-desktop.png`, `92-dark-add-search.png`,
`93-dark-profile.png`, `94-nav-desktop-light.png`.

## Insights calendar

The calendar on the Insights page is a real calendar, not an activity grid. Up to eight weeks (7 and 30 days) it is a
month calendar: one block per month, weeks as rows, Monday first like everywhere in the app, each square with the day
number (Bricolage 800), the kcal and a state mark; today has a lime pill. Beyond that (90 days, a year) it is one column
per week across the card, scrolling sideways on a phone, starting at the newest week, with month labels and a fine step
line at each month change. State is never colour alone: solid green + tick = within the range, hatched + arrow down =
below, pink outline + arrow up = above, dashed outline = nothing logged, grey + dot = logged without a goal. The four
counts above double as the legend, and a detail box (pointer, focus or last tap; the day's own goal) replaces tooltips so
a phone can use it; a second tap or Enter opens the day. Logic: `lib/calendarGrid.ts`. Screen: `screens/153-insights-calendar.png`.

## Insights: nutrients over time

Chosen nutrients are chips (`SeriesMark`: dash pattern + marker, in a token colour) with an "Add nutrient"
button; the picker is the standard sheet (dialog from 900 px) with a search and the groups Macros, Vitamins, Minerals,
More. One nutrient keeps its own unit; two to four share a percent axis with a heavy 100 % line. Lines differ by colour,
dash and marker (circle, square, triangle, diamond) and carry their name at the end (wide) or in the rows below. Few values
(under 20 % of the calories) draw a thin line with hollow points and a "Few values" tag, never a warning tone.
Screen: `screens/154-insights-nutrients.png`.

## Wide windows

Below 900 px nothing changes; from 900 px the navigation is a rail and pages keep a calm reading column (560 px)
unless they are made for width (Today, Insights, Profile, Admin). Two further steps, used by the pages that have
something to show with the room (`.page.split`, `lib/media.svelte.ts`):

- **From 1280 px** the page grows to 1320 px and splits in two: a list or a chart on the left, what belongs to it on
  the right. Products: the list (a click selects, the selected row gets a green outline) and a detail pane with the
  green hero block (name, big kcal number, tick rule, Edit / Add to diary), the three macro tiles and the nutrition
  table; the pane stays in view while the list scrolls. Recipes (their own page, `#/recipes`) show portions, kcal per portion and ingredients.
  Weight: the chart is drawn in a wider box (type keeps its size), on the right three accent tiles (change over 7, 30
  and 90 days), lowest / highest / entries and the recent entries. Only values that the data give are shown.
- **From 1800 px** the maximum width is 1660 px, the ratio shifts towards the content, the detail pane puts its two
  tables side by side, the profile settings flow into two columns.
- Reading text keeps a comfortable line length (credit lines max 70 characters); nothing is simply stretched.
- Screens: `screens/151-products-wide.png`, `screens/152-weight-wide.png`, `screens/155-recipes-wide.png`.

## First-run tour

A guided walk through the day view the first time someone opens it (`components/Tour.svelte`, geometry and tests in
`lib/tour.ts` / `tests/tour.test.mjs`).

- A dark veil with a hole around a real element (the hole copies its corner radii, a lime hairline marks it) and a
  `paper` speech bubble with the signature radius `28px 28px 28px 8px` and a pointer. Steps: ring, macro tiles, first
  meal, scan button, Insights, then the more menu on the phone or the profile on desktop. Elements are found by `data-tour` attributes; the avatar (more menu) is the last step on the
  phone, the round profile button of the rail on desktop. A step without a visible target is skipped.
- Progress is a small tick scale (the current tick is taller), not dots or a bar. Last step: "Let's go".
- The bubble never leaves the screen, is placed on the side with room (above for targets in the lower half, to the
  right of the rail), follows resizing, rotating and scrolling; the target is scrolled into view.
- Accessible: `role="dialog"`, `aria-modal`, labelled; the page behind is `inert`; focus stays in the bubble (Tab
  cycles, Next is focused), Enter / Right = next, Left = back, Esc = skip. Reduced motion switches the movement off
  (global rule). Works in both themes.
- Remembered per person on the server (`settings.tour_seen`, no schema change); the demo remembers it per browser
  (`mahlwerk.tour`). Never starts over another dialog or outside the day view. Profile: "Show the introduction again".
- Screen: `screens/150-tour-mobile.png`.

## Recipe groups and taking over many Cookidoo recipes

- **Chips above the Recipes list:** "All", one chip per group with its count (mono, small), "No group" (only when groups exist) and a round folder button
  that opens the manager. The row scrolls sideways on a phone (no scrollbar, the active chip is scrolled into view); the active chip uses the
  selected-chip colours (`sel-bg`). The choice is in the address (`?group=<id>` or `?group=none`) and combines with the search. No section
  headings: a recipe can be in several groups, so headings would repeat rows.
- **Long lists:** 20 rows at a time with "Show 20 more" ("20 of 136 shown"); search, group filter, the count and "Select all n matches" run over all recipes, a recipe that was just taken over is brought into view; rows use `content-visibility: auto`. 500 recipes stay quick (a filter switch about 10 to 30 ms).
- **Select:** "Select" turns the rows into checkbox rows (real checkboxes, named by the recipe); a bar sticks at the top of the list with the count
  (polite live region), "Select all n", "Clear", "Add to group" (a sheet with the groups and a field for a new one) and, inside a group, "Take out of ...".
- **Manager (sheet):** new group field, then one `paper` row per group with up / down / rename / delete buttons (no dragging); delete is two-step and says the recipes stay.
  Detail view (pane from 1280 px, the Cookidoo sheet, the recipe editor): a "Groups" card with toggle chips (check mark when on) and a field for a new group.
- **Take over many (Cookidoo sheet):** "Take over everything" at the top, "Take over the week" beside the week, "Take over all n" inside each collection. A card with a lime
  outline asks first (how many, how many are up to date, how long, which groups). The run shows as a card with a green outline: plain progress bar
  (`role="progressbar"` with `aria-valuetext`), "12 of 100 · about 6 min left", the recipe it is on, the counts, "Stop"; only its start and end are spoken. A slim banner on the
  Recipes page shows a running run when the sheet is closed. After the end the card lists what was not taken over.
- Screens: `screens/160-recipe-groups.png`.

## Connections and imports (Profile, Admin)

- **Profile, card "Connections"** holds the person's own Cookidoo account (when the connector is on): the masked address and
  region on a `stone` row, "Check connection", "Change" and "Remove access" (two-step), or the form (e-mail, password with a
  "Show" button, country, language). The password is never filled in or shown again. Fields for other services' credentials use
  `autocomplete="off"` / `"new-password"` and their own `name`s so that a password manager does not offer the Mahlwerk sign-in.
- **Card "Import from Yazio"** below it: a primary "Choose files" button, then a `stone` preview block with the numbers as small
  `paper` tiles (days, entries, new foods, weights, water, activity, workouts), an expandable list of what is skipped, the
  "also never-eaten products" check and Import / Discard. The optional direct sign-in sits under a hairline in the same card
  with a calm warning block (left edge in `warn`), the form, the period chips and a plain progress bar. Never a red alert;
  warnings are `warn` text.
- **Admin, connectors:** four groups (Food data, Recipes, Import and demo, Interfaces) of compact cards in two columns from 900 px, one column on
  a phone. A card holds the name, a state label, ONE switch in the head (a switch the environment fixes is disabled and carries a small
  "Environment" label), one sentence, a mono fact line (count, as of date) and a round chevron button (`aria-expanded`) that opens "Settings";
  an open card takes the full row. State labels and looks: lime = Active / Ready, grey = Off, outlined in `warn` = Not set up / Not installed /
  No data, filled `warn` = Error; unofficial interfaces carry an outlined "Unofficial" label and one warning block inside. A card with an error or a
  missing setup opens by itself. Settings are sub-sections with a mono heading (Cookidoo: shared account, own accounts, recipe pictures; catalogue:
  countries as named chips with a choice list and "other country", refresh). Everything only an operator needs (commands with a copy button,
  environment variables, installation, key location) sits in a folded "Technical notes" part inside the open card and only appears when it applies
  (the missing-setup block of Yazio is the exception: visible). "Remove access" is a quiet text button with a second question, never orange.
  The overview of all cards fits about one screen at 1440 x 900 (`screens/164-admin-connectors.png`).
- **Recipes head:** "New recipe" and "Take over" (a menu of the switched-on ways, a plain button when only one is on, none when none) sit in the
  title row; on a phone one lime "+" button opens a menu with "New recipe" and the ways. Menu as the more menu (Up/Down/Home/End, Esc returns focus).
- **Sheets on a phone** can be swiped down by the grip or the head (and by the content when it is scrolled to the top): 120 px or a quarter of the
  height, or a quick flick, closes like the close button; otherwise it springs back. Not from fields, sliders or rows that scroll sideways; not in the
  centred dialogs from 900 px.
- Screen: `screens/159-connections.png`.


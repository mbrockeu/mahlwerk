# Apple Health shortcut

`build_shortcut.py` builds a ready-made Apple Shortcut, "Mahlwerk Health Sync", that reads steps, active energy, body
weight, body fat and lean body mass from Apple Health for the last days and sends each value to `POST /api/v1/health/sync` of your Mahlwerk
(`Authorization: Bearer <access key>`). It needs only the Python standard library. The result,
`Mahlwerk Health Sync.shortcut`, is checked in next to the script (unsigned, 3 days); build it again with
`python3 build_shortcut.py [--days N] [--debug] [--xml]`.

## Install

1. Sign the file on a Mac (an unsigned shortcut cannot be imported on an iPhone):

   ```sh
   shortcuts sign --mode anyone --input "Mahlwerk Health Sync.shortcut" --output "Mahlwerk Health Sync (signed).shortcut"
   ```

2. Send the signed file to the iPhone (AirDrop or iCloud Drive) and open it.
3. On import, enter the address of your Mahlwerk (for example `https://mahlwerk.example.org`, no trailing `/`) and an
   access key with **read and write** access (profile, card "Access keys"; use a key of its own for the shortcut).
4. Allow access to Health when the iPhone asks.

## Use

- The number at **Repeat** is the number of days sent, counted back from today. Leave it at 3 for daily use (it also
  catches late syncs of the watch); for a one-off catch-up set it to, for example, 30, run the shortcut once, and put
  it back.
- To run it every day: Shortcuts, Automation, **Time of Day** (for example in the evening), run the shortcut, choose
  **Run Immediately**.

## Notes

- **Apple Watch:** the shortcut adds up every Health sample of the day. iPhone and watch both count steps and active
  energy, and unlike the Health app the shortcut does not drop the overlap, so Mahlwerk shows about twice the value.
  If you wear a watch, open both **Find Health Samples** actions (steps and active energy), **Add Filter**, **Source**
  **is** and pick your watch. The device has to be picked on the iPhone, so the ready-made file cannot do it. Without a
  watch nothing needs changing. On days you do not wear the watch the filtered value is lower than in Health.
- Nothing is sent that is not in Health: a day without a value for steps, active energy, weight, body fat or lean body mass is skipped.
- Values typed in by hand in Mahlwerk take precedence over what the shortcut sends.
- The Health sample types ("Steps", "Active Calories", "Weight") are tested on an iPhone set to German. Weight is not
  confirmed yet, and neither are the two newer ones, "Body Fat Percentage" and "Lean Body Mass" (constants `HK_BODY_FAT`
  and `HK_LEAN` in the script): if the picker shows other names, change them there and build again, or pick the type in
  the two **Find Health Samples** actions by hand.
- Body fat and lean mass are sent as `body_fat_pct` and `lean_kg` in their own request after the weight, because Mahlwerk
  stores them on the weight of the day: a day without a weight keeps neither. Body fat may arrive as percent (21,3) or as a
  fraction (0,213); the server accepts both. Lean mass is not converted: with Health set to pounds the number would be wrong,
  keep the unit on kilograms (Health, Browse, Body Measurements, Lean Body Mass, Unit). Values typed in by hand are kept.
- The shortcut file format is not officially documented. The script rebuilds it after the community reference
  <https://github.com/viticci/shortcuts-playground-plugin> and exports from Apple's app. After an iOS update the shortcut
  may need to be built and signed again.

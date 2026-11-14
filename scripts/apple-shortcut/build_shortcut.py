#!/usr/bin/env python3
"""Build the unsigned Apple Shortcut "Mahlwerk Health Sync" (binary plist).

Standard library only. The .shortcut file format is not officially documented; it is
rebuilt after the community reference https://github.com/viticci/shortcuts-playground-plugin
and after exports made by Apple's Shortcuts app, and may change with iOS updates.

Usage:  python3 build_shortcut.py [--days N] [--debug] [--xml]
  writes "Mahlwerk Health Sync.shortcut" (binary) next to this script;
  --days N  number of days to send, counted back from today (default 3);
  --debug   adds intermediate result displays (for troubleshooting on the iPhone);
  --xml     also writes a readable "Mahlwerk Health Sync.xml".
Sign it afterwards on a Mac:  shortcuts sign --mode anyone --input X --output Y
"""
import plistlib
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = "Mahlwerk Health Sync"

# --------------------------------------------------------------------------
# Configuration (adjust here)
# --------------------------------------------------------------------------
DEFAULT_ADDRESS = "https://mahlwerk.example.org"
KEY_PLACEHOLDER = "mw_YOUR_ACCESS_KEY"
SYNC_PATH = "/api/v1/health/sync"
DAYS = 3                      # repetitions (today, yesterday, the day before); see --days
ICON_GLYPH = 62337            # appleHealthTrends
ICON_COLOR = 4292093695       # Green

# Picker labels of "Find Health Samples"
HK_STEPS = "Steps"            # observed in the reference
HK_ENERGY = "Active Calories"  # observed in the reference
HK_WEIGHT = "Weight"          # not confirmed yet (the reference fallback would be "Body Mass")

OBJ = "￼"  # U+FFFC placeholder in WFTextTokenString


# --------------------------------------------------------------------------
# Helpers: UUIDs, variable tokens
# --------------------------------------------------------------------------
_NS = uuid.UUID("6d0c2f0e-5b7a-4c3e-9a41-0f6a3b7c1e55")


def uid(label):
    """Deterministic upper-case UUID per label (stable diffs)."""
    return str(uuid.uuid5(_NS, label)).upper()


def ref_out(uuid_, name):
    """Inner token: output of an action."""
    return {"OutputName": name, "OutputUUID": uuid_, "Type": "ActionOutput"}


def ref_var(name):
    """Inner token: named variable (also 'Repeat Index')."""
    return {"Type": "Variable", "VariableName": name}


def attach(token):
    """WFTextTokenAttachment: the parameter IS just the variable."""
    return {"Value": token, "WFSerializationType": "WFTextTokenAttachment"}


def tstr(*parts):
    """WFTextTokenString from text and token parts.

    parts: str = plain text, dict = inner token (ref_out/ref_var).
    Computes string and attachmentsByRange from the real positions.
    """
    s, ranges = "", {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            ranges["{%d, 1}" % len(s)] = p
            s += OBJ
    value = {"string": s}
    if ranges:
        value["attachmentsByRange"] = ranges
    return {"Value": value, "WFSerializationType": "WFTextTokenString"}


def quantity(magnitude, unit):
    return {"Value": {"Magnitude": magnitude, "Unit": unit},
            "WFSerializationType": "WFQuantityFieldValue"}


# --------------------------------------------------------------------------
# Action list
# --------------------------------------------------------------------------
actions = []


def add(identifier, **params):
    actions.append({"WFWorkflowActionIdentifier": identifier,
                    "WFWorkflowActionParameters": params})
    return len(actions) - 1  # ActionIndex


DEBUG = "--debug" in sys.argv
if "--days" in sys.argv:
    DAYS = int(sys.argv[sys.argv.index("--days") + 1])


def debug_show(*parts):
    """Only with --debug: shows an intermediate result (troubleshooting on the iPhone)."""
    if DEBUG:
        add("is.workflow.actions.showresult", Text=tstr(*parts))


def comment(text):
    add("is.workflow.actions.comment", WFCommentActionText=text)


def set_variable(name, token, label):
    add("is.workflow.actions.setvariable", UUID=uid(label),
        WFVariableName=name, WFInput=attach(token))


def health_filter(label, sample_type, start_var, end_var, sort_latest_limit1=False):
    """Find Health Samples: type is X, start date between Anfang and Ende."""
    templates = [
        {   # type row that cannot be removed
            "Bounded": True, "Operator": 4, "Property": "Type", "Removable": False,
            "Values": {"Enumeration": {"Value": sample_type,
                                       "WFSerializationType": "WFStringSubstitutableState"}},
        },
        {   # date row "is between" (Date + AnotherDate)
            "Bounded": True, "Operator": 1003, "Property": "Start Date", "Removable": False,
            "Values": {"Date": attach(ref_var(start_var)),
                       "AnotherDate": attach(ref_var(end_var))},
        },
    ]
    params = {
        "UUID": uid(label),
        "WFContentItemFilter": {
            "Value": {"WFActionParameterFilterPrefix": 1,
                      "WFContentPredicateBoundedDate": False,
                      "WFActionParameterFilterTemplates": templates},
            "WFSerializationType": "WFContentPredicateTableTemplate"},
    }
    if sort_latest_limit1:
        params.update(WFContentItemSortProperty="Start Date",
                      WFContentItemSortOrder="Latest First",
                      WFContentItemLimitEnabled=True,
                      WFContentItemLimitNumber=1)
    add("is.workflow.actions.filter.health.quantity", **params)


def replace_text(label, src_uuid, src_name, find, regex, replace=None):
    p = {"UUID": uid(label),
         "WFInput": tstr(ref_out(src_uuid, src_name)),
         "WFReplaceTextFind": find,
         "WFReplaceTextRegularExpression": regex,
         "WFReplaceTextCaseSensitive": False}
    if replace is not None:
        p["WFReplaceTextReplace"] = replace
    add("is.workflow.actions.text.replace", **p)


def if_has_value(group, var_name):
    add("is.workflow.actions.conditional", GroupingIdentifier=group,
        WFControlFlowMode=0, WFCondition=100,
        WFInput={"Type": "Variable",
                 "Variable": attach(ref_var(var_name))})


def end_if(group):
    add("is.workflow.actions.conditional", GroupingIdentifier=group,
        WFControlFlowMode=2, UUID=uid(group + ":end"))


def send(label, json_parts):
    """Text action with the JSON, then 'Get Contents of URL' (POST, file body)."""
    json_uuid = uid(label + ":json")
    add("is.workflow.actions.gettext", UUID=json_uuid, WFTextActionText=tstr(*json_parts))

    def header(key, *val_parts):
        return {"WFItemType": 0, "WFKey": tstr(key), "WFValue": tstr(*val_parts)}

    add("is.workflow.actions.downloadurl",
        UUID=uid(label + ":post"),
        WFURL=tstr(ref_var("Adresse"), SYNC_PATH),
        WFHTTPMethod="POST",
        WFHTTPBodyType="File",
        WFHTTPHeaders={"Value": {"WFDictionaryFieldValueItems": [
            header("Authorization", "Bearer ", ref_var("Schluessel")),
            header("Content-Type", "application/json")]},
            "WFSerializationType": "WFDictionaryFieldValue"},
        WFFormValues={"Value": {"WFDictionaryFieldValueItems": []},
                      "WFSerializationType": "WFDictionaryFieldValue"},
        # as an attachment, like "Set Variable" (that works); as token text the "File" body stayed empty on the iPhone
        WFRequestVariable=attach(ref_out(json_uuid, "Text")),
        ShowHeaders=False)


def sum_block(prefix, sample_type, var_name, json_key):
    """Steps/active energy: find, sum, number, round, keep digits only, send."""
    h, st, nr, rd, rp = (uid(prefix + s) for s in (":find", ":sum", ":num", ":round", ":digits"))
    health_filter(prefix + ":find", sample_type, "Anfang", "Ende")
    add("is.workflow.actions.statistics", UUID=st, WFStatisticsOperation="Sum",
        Input=attach(ref_out(h, "Health Samples")))
    add("is.workflow.actions.detect.number", UUID=nr,
        WFInput=tstr(ref_out(st, "Statistics")))
    add("is.workflow.actions.round", UUID=rd, WFRoundMode="Normal", WFRoundTo="Ones Place",
        WFInput=attach(ref_out(nr, "Numbers")))
    replace_text(prefix + ":digits", rd, "Rounded Number", "[^0-9]", True)
    set_variable(var_name, ref_out(rp, "Updated Text"), prefix + ":var")
    comment("- The condition checks the variable %s\n- The text contains Tag and %s as variables" % (var_name, var_name))
    grp = uid(prefix + ":if")
    if_has_value(grp, var_name)
    send(prefix, ['{"days":[{"day":"', ref_var("Tag"), '","%s":' % json_key, ref_var(var_name), "}]}"])
    end_if(grp)


# --------------------------------------------------------------------------
# Flow
# --------------------------------------------------------------------------
comment("Mahlwerk Health Sync: Reads the Apple Health values steps, active energy and weight "
        "for the last days and sends each value as JSON by POST to the Mahlwerk interface "
        "(address/api/v1/health/sync). Address and access key are asked for on import.")
comment("Shortcuts generated by Shortcuts Playground. May contain mistakes. Always check the "
        "shortcut's actions first.\n\nThis shortcut was created via the following user prompt:\n\n"
        "> Shortcut that sends Apple Health values (steps, active energy, weight) of the last "
        "days to the Mahlwerk web API (bearer key, JSON body).")

comment("--- SETTINGS ---\n- Address and key are asked for on import\n"
        "- The key is only stored in this text, not in the shortcut name")
idx_addr = len(actions)
addr_uuid = uid("adresse:text")
add("is.workflow.actions.gettext", UUID=addr_uuid, WFTextActionText=DEFAULT_ADDRESS)
set_variable("Adresse", ref_out(addr_uuid, "Text"), "adresse:var")
idx_key = len(actions)
key_uuid = uid("schluessel:text")
add("is.workflow.actions.gettext", UUID=key_uuid, WFTextActionText=KEY_PLACEHOLDER)
set_variable("Schluessel", ref_out(key_uuid, "Text"), "schluessel:var")

# The loop walks back one day at a time without doing any arithmetic: before the loop Ende = tomorrow
# 0:00, in every round Anfang = Ende - 1 day (a fixed value) and at the end of the round Ende = Anfang.
# An offset that uses a variable (repeat index - 1) always subtracted 0 days on the iPhone. The number of
# days is set directly at "Repeat" (daily use 3, one-off catch-up e.g. 30).
comment("--- DAYS ---\n- The number at Repeat = how many days to go back (daily use 3, catch-up e.g. 30)\n"
        "- Ende starts at tomorrow 0:00, every round goes back one day")
now, sod, tom = uid("now"), uid("sod"), uid("tomorrow")
add("is.workflow.actions.date", UUID=now, WFDateActionMode="Current Date")
add("is.workflow.actions.adjustdate", UUID=sod, WFDate=tstr(ref_out(now, "Date")), WFAdjustOperation="Get Start of Day")
add("is.workflow.actions.adjustdate", UUID=tom, WFDate=tstr(ref_out(sod, "Adjusted Date")),
    WFAdjustOperation="Add", WFDuration=quantity("1", "days"))
set_variable("Ende", ref_out(tom, "Adjusted Date"), "ende:start")

comment("--- LOOP ---\n- Anfang = Ende minus 1 day\n- Tag is Anfang as yyyy-MM-dd")
loop = uid("loop")
add("is.workflow.actions.repeat.count", GroupingIdentifier=loop, WFControlFlowMode=0, WFRepeatCount=DAYS)
if True:  # body of the loop (indented as in the shortcut)
    p = "loop:"
    back, fmt = uid(p + "back"), uid(p + "fmt")
    add("is.workflow.actions.adjustdate", UUID=back, WFDate=tstr(ref_var("Ende")),
        WFAdjustOperation="Subtract", WFDuration=quantity("1", "days"))
    set_variable("Anfang", ref_out(back, "Adjusted Date"), p + "anfang:var")
    add("is.workflow.actions.format.date", UUID=fmt, WFDate=tstr(ref_var("Anfang")),
        WFDateFormatStyle="Custom", WFDateFormat="yyyy-MM-dd")  # as in an Apple export
    set_variable("Tag", ref_out(fmt, "Formatted Date"), p + "tag:var")
    debug_show("1) Datum ok: ", ref_var("Tag"))

    comment("--- STEPS ---\n- Sum of the steps of the day, keep digits only")
    sum_block(p + "schritte", HK_STEPS, "Schritte", "steps")
    debug_show("2) Schritte ", ref_var("Tag"), ": [", ref_var("Schritte"), "]")

    comment("--- ACTIVE ENERGY ---\n- Sum of the active calories of the day, keep digits only")
    sum_block(p + "energie", HK_ENERGY, "Energie", "active_kcal")
    debug_show("3) Energie ", ref_var("Tag"), ": [", ref_var("Energie"), "]")

    comment("--- WEIGHT ---\n- Latest measurement of the day, comma becomes point\n"
            "- No unit conversion: kg is only named in the JSON key")
    g_find, g_num, g_rep = uid(p + "gewicht:find"), uid(p + "gewicht:num"), uid(p + "gewicht:rep")
    health_filter(p + "gewicht:find", HK_WEIGHT, "Anfang", "Ende", sort_latest_limit1=True)
    add("is.workflow.actions.detect.number", UUID=g_num, WFInput=tstr(ref_out(g_find, "Health Samples")))
    replace_text(p + "gewicht:rep", g_num, "Numbers", ",", False, replace=".")
    set_variable("Gewicht", ref_out(g_rep, "Updated Text"), p + "gewicht:var")
    debug_show("4) Gewicht ", ref_var("Tag"), ": [", ref_var("Gewicht"), "]")
    grp = uid(p + "gewicht:if")
    if_has_value(grp, "Gewicht")
    send(p + "gewicht", ['{"days":[{"day":"', ref_var("Tag"), '","weight_kg":', ref_var("Gewicht"), "}]}"])
    end_if(grp)

    comment("- Ende = Anfang: the next round takes the day before")
    set_variable("Ende", ref_var("Anfang"), p + "ende:next")

add("is.workflow.actions.repeat.count", GroupingIdentifier=loop, WFControlFlowMode=2, UUID=uid("loop:end"))

# --------------------------------------------------------------------------
# Root
# --------------------------------------------------------------------------
shortcut = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "2700.0.4",
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": ICON_GLYPH,
                       "WFWorkflowIconStartColor": ICON_COLOR},
    "WFWorkflowImportQuestions": [
        {"ActionIndex": idx_addr, "Category": "Parameter", "ParameterKey": "WFTextActionText",
         "Text": "Address of your Mahlwerk (no trailing /)", "DefaultValue": DEFAULT_ADDRESS},
        {"ActionIndex": idx_key, "Category": "Parameter", "ParameterKey": "WFTextActionText",
         "Text": "Your Mahlwerk access key (profile, Access keys; starts with mw_)",
         "DefaultValue": KEY_PLACEHOLDER},
    ],
    "WFWorkflowInputContentItemClasses": [],   # no share sheet input
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowName": NAME,
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowTypes": [],                     # no action extension / widget
}

if __name__ == "__main__":
    out = HERE / (NAME + (" DEBUG" if DEBUG else "") + ".shortcut")
    with open(out, "wb") as f:
        plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
    print("written:", out, "(%d actions)" % len(actions))
    if "--xml" in sys.argv:
        xml = HERE / (NAME + ".xml")
        with open(xml, "wb") as f:
            plistlib.dump(shortcut, f, fmt=plistlib.FMT_XML)
        print("written:", xml)

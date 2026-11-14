"""Ingredient lines (pasted from a cookbook or a web page) to amounts in grams, and the foods that may be meant.

Deterministic and offline: no model, no network. `parse_line` reads one line ("2 EL Olivenöl (extra virgin), kalt gepresst",
"1 1/2 cups flour", "1 Dose Tomaten (400 g)") into quantity, unit, name and note, and works out grams where it can:

  * a mass is converted directly (g, kg, mg, oz, lb, Pfund);
  * a volume (ml, l, EL, TL, cup, ...) goes through a small density table; without a known density 1 g/ml is assumed and
    the line is marked `estimated`;
  * a count ("2 Eier", "1 Zehe Knoblauch", "1 Bund Petersilie") uses a small table of typical weights, always `estimated`;
  * an explicit weight in brackets ("1 Dose (400 g)", "2 Eier (je 60 g)") wins over everything else;
  * what cannot be worked out stays `None`: the person types it in.

`candidates` then looks for the foods a line may mean: own (already stored) foods first, then the basic foods and the
packaged products of the local catalogue, the way the search ranks them. Nothing here writes anything.
"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from .catalog import words as _words

MAX_LINES = 200
MAX_LINE = 300
MAX_TEXT = 20_000
MAX_CANDIDATES = 5
MAX_QUANTITY = 100_000
MAX_GRAMS = 1_000_000


def fold(text: str) -> str:
    """Lower case without diacritics; 'ß' as 'ss' ('Äpfel' -> 'apfel')."""
    decomposed = unicodedata.normalize("NFKD", text.casefold().replace("ß", "ss"))
    return "".join(c for c in decomposed if not unicodedata.combining(c))


# --- units --------------------------------------------------------------------------------------------------------------

# canonical unit -> (kind, factor): "mass" in g, "volume" in ml (a third entry marks a size that varies: the line is estimated)
_MASS = {"g": 1.0, "mg": 0.001, "kg": 1000.0, "oz": 28.3495, "lb": 453.592, "pfund": 500.0}
_VOLUME = {
    "ml": (1.0, False), "cl": (10.0, False), "dl": (100.0, False), "l": (1000.0, False),
    "el": (15.0, False), "tl": (5.0, False), "cup": (240.0, False), "tasse": (250.0, True), "floz": (29.5735, False),
    "pint": (473.176, False), "quart": (946.353, False), "gallon": (3785.41, False), "msp": (0.5, True),
}
_ITEMS = {"piece", "tub", "can", "bunch", "clove", "slice", "pack", "pinch", "stalk", "stick", "sprig", "leaf", "cube", "head", "other"}
_CONTAINERS = {"can", "pack", "cube", "other"}  # "2 Dosen (400 g)": the weight in brackets is that of each one

_ALIASES: dict[str, str] = {}


def _alias(canon: str, *names: str) -> None:
    for name in names:
        _ALIASES[fold(name)] = canon


_alias("g", "g", "gr", "gramm", "gram", "grams", "gramme")
_alias("mg", "mg", "milligramm", "milligram")
_alias("kg", "kg", "kilo", "kilogramm", "kilogram", "kilograms", "kgs")
_alias("oz", "oz", "ounce", "ounces", "unze", "unzen")
_alias("lb", "lb", "lbs", "pound", "pounds")
_alias("pfund", "pfd", "pfund")
_alias("ml", "ml", "milliliter", "millilitre", "milliliters", "millilitres")
_alias("cl", "cl", "centiliter", "zentiliter")
_alias("dl", "dl", "deziliter", "deciliter")
_alias("l", "l", "liter", "litre", "liters", "litres", "ltr")
_alias("el", "el", "essl", "esslöffel", "essloffel", "tbsp", "tbs", "tablespoon", "tablespoons", "tbl")
_alias("tl", "tl", "teel", "teelöffel", "teeloffel", "tsp", "teaspoon", "teaspoons")
_alias("cup", "cup", "cups")
_alias("tasse", "tasse", "tassen")
_alias("floz", "floz", "fl.oz")
_alias("pint", "pint", "pints", "pt")
_alias("quart", "quart", "quarts", "qt")
_alias("gallon", "gallon", "gallons", "gal")
_alias("msp", "msp", "messerspitze", "messerspitzen")
_alias("piece", "stück", "stuck", "stücke", "stk", "st", "piece", "pieces", "pc", "pcs")
_alias("can", "dose", "dosen", "can", "cans", "tin", "tins")
_alias("bunch", "bund", "bündel", "bunch", "bunches")
_alias("clove", "zehe", "zehen", "clove", "cloves")
_alias("slice", "scheibe", "scheiben", "slice", "slices")
_alias("pack", "packung", "packungen", "päckchen", "packchen", "pck", "pckg", "pkg", "pack", "packs", "package", "packages", "packet", "paket", "pakete", "pkt")
_alias("pinch", "prise", "prisen", "pinch", "pinches")
_alias("stalk", "stange", "stangen", "stängel", "stalk", "stalks")
_alias("stick", "stick", "sticks")
_alias("sprig", "zweig", "zweige", "sprig", "sprigs")
_alias("leaf", "blatt", "blätter", "blatter", "leaf", "leaves")
_alias("cube", "würfel", "wurfel", "cube", "cubes")
_alias("other", "glas", "gläser", "glaser", "glass", "jar", "jars", "tube", "tuben", "flasche", "flaschen", "bottle", "bottles",
       "tüte", "tüten", "tute", "beutel", "bag", "bags", "handvoll", "handful", "schuss", "dash", "spritzer", "schale", "bowl", "portion", "portionen")
_alias("tub", "becher", "tub", "tubs", "carton")
_alias("head", "knolle", "knollen", "kopf", "köpfe", "head", "heads", "bulb", "bulbs")

# weight of one count unit by food (key words; the longest key that fits wins); "" is the default for the unit
_UNIT_WEIGHTS: dict[str, dict[str, float]] = {
    "can": {"": 400.0},
    "tub": {"sahne": 200.0, "schlagsahne": 200.0, "cream": 200.0, "schmand": 200.0, "creme fraiche": 150.0, "joghurt": 150.0, "yogurt": 150.0, "yoghurt": 150.0},
    "clove": {"knoblauch": 4.0, "garlic": 4.0},
    "pinch": {"": 0.4, "salz": 0.5, "salt": 0.5},
    "bunch": {
        "": 50.0, "petersilie": 50.0, "parsley": 50.0, "schnittlauch": 25.0, "chives": 25.0, "dill": 30.0, "basilikum": 30.0, "basil": 30.0,
        "koriander": 40.0, "cilantro": 40.0, "coriander": 40.0, "minze": 30.0, "mint": 30.0, "fruhlingszwiebel": 100.0, "spring onion": 100.0,
        "scallion": 100.0, "radieschen": 150.0, "radish": 150.0, "suppengrun": 400.0,
    },
    "slice": {
        "brot": 40.0, "bread": 35.0, "toast": 28.0, "kase": 25.0, "cheese": 25.0, "schinken": 20.0, "ham": 20.0, "speck": 15.0, "bacon": 12.0,
        "salami": 5.0, "tomate": 15.0, "tomato": 15.0, "zitrone": 8.0, "lemon": 8.0, "gurke": 10.0, "cucumber": 10.0, "ananas": 80.0, "pineapple": 80.0,
    },
    "pack": {
        "butter": 250.0, "backpulver": 15.0, "baking powder": 15.0, "vanillezucker": 8.0, "vanilla sugar": 8.0, "hefe": 42.0, "yeast": 7.0,
        "puddingpulver": 37.0, "gelatine": 9.0, "tomatenmark": 70.0,
    },
    "stick": {"butter": 113.0},
    "stalk": {"sellerie": 40.0, "celery": 40.0, "lauch": 150.0, "leek": 150.0, "rosenkohl": 400.0, "zitronengras": 20.0, "lemongrass": 20.0},
    "sprig": {"": 2.0, "thymian": 1.0, "thyme": 1.0, "rosmarin": 3.0, "rosemary": 3.0, "petersilie": 2.0, "parsley": 2.0, "minze": 1.0, "mint": 1.0},
    "leaf": {"lorbeer": 0.2, "bay": 0.2, "basilikum": 0.3, "basil": 0.3, "gelatine": 2.0, "salbei": 0.5, "sage": 0.5},
    "cube": {"hefe": 42.0, "yeast": 42.0, "bruhe": 10.0, "stock": 10.0, "bouillon": 10.0, "brühwurfel": 10.0},
    "head": {"knoblauch": 40.0, "garlic": 40.0, "blumenkohl": 600.0, "cauliflower": 600.0, "brokkoli": 400.0, "broccoli": 400.0, "salat": 300.0, "lettuce": 300.0},
}

# weight of one piece when the line only counts ("2 Eier", "1 mittelgroße Zwiebel", "1 Stück Zitrone")
_PIECES: dict[str, float] = {
    "ei": 55.0, "eier": 55.0, "egg": 55.0, "eggs": 55.0, "eigelb": 18.0, "egg yolk": 18.0, "eiweiss": 33.0, "egg white": 33.0,
    "zwiebel": 80.0, "onion": 80.0, "schalotte": 25.0, "shallot": 25.0, "fruhlingszwiebel": 15.0, "spring onion": 15.0, "scallion": 15.0,
    "knoblauchzehe": 4.0, "garlic clove": 4.0, "karotte": 70.0, "mohre": 70.0, "carrot": 70.0, "kartoffel": 120.0, "potato": 120.0,
    "susskartoffel": 200.0, "sweet potato": 200.0, "tomate": 100.0, "tomato": 100.0, "kirschtomate": 15.0, "cherry tomato": 15.0,
    "apfel": 180.0, "apple": 180.0, "birne": 170.0, "pear": 170.0, "banane": 120.0, "banana": 120.0, "zitrone": 100.0, "lemon": 100.0,
    "limette": 65.0, "lime": 65.0, "orange": 150.0, "paprika": 150.0, "bell pepper": 150.0, "gurke": 350.0, "cucumber": 350.0,
    "zucchini": 200.0, "aubergine": 300.0, "eggplant": 300.0, "avocado": 150.0, "pfirsich": 150.0, "peach": 150.0, "kiwi": 80.0,
    "champignon": 20.0, "mushroom": 20.0, "chilischote": 15.0, "chili": 15.0, "brotchen": 50.0, "roll": 50.0, "mozzarella": 125.0,
    "rote bete": 100.0, "beetroot": 100.0, "hahnchenbrust": 180.0, "chicken breast": 180.0, "lorbeerblatt": 0.2, "bay leaf": 0.2,
    "kohlrabi": 200.0, "fenchel": 250.0, "fennel": 250.0, "lauch": 150.0, "leek": 150.0, "sellerie": 60.0, "celery": 40.0,
}

_SIZE = {"klein": 0.7, "kleine": 0.7, "kleiner": 0.7, "kleines": 0.7, "small": 0.7, "mittel": 1.0, "mittelgross": 1.0, "mittelgrosse": 1.0,
         "mittelgrosser": 1.0, "medium": 1.0, "gross": 1.3, "grosse": 1.3, "grosser": 1.3, "grosses": 1.3, "large": 1.3}

# g per ml, by food (key words; the longest key that fits wins); a volume of anything else is taken as 1 g/ml and marked estimated
_DENSITY: dict[str, float] = {
    "wasser": 1.0, "water": 1.0, "milch": 1.03, "milk": 1.03, "buttermilch": 1.03, "buttermilk": 1.03, "sahne": 1.0, "cream": 1.0,
    "schlagsahne": 1.0, "schmand": 1.0, "joghurt": 1.03, "yogurt": 1.03, "yoghurt": 1.03, "quark": 1.05, "frischkase": 1.0, "cream cheese": 1.0,
    "ol": 0.92, "oil": 0.92, "olivenol": 0.92, "rapsol": 0.92, "sonnenblumenol": 0.92, "essig": 1.01, "vinegar": 1.01,
    "honig": 1.42, "honey": 1.42, "sirup": 1.35, "syrup": 1.35, "ahornsirup": 1.33, "maple syrup": 1.33, "zucker": 0.85, "sugar": 0.85,
    "puderzucker": 0.56, "powdered sugar": 0.56, "icing sugar": 0.56, "brauner zucker": 0.9, "brown sugar": 0.9, "mehl": 0.55, "flour": 0.55,
    "speisestarke": 0.6, "starch": 0.6, "cornstarch": 0.6, "salz": 1.2, "salt": 1.2, "reis": 0.85, "rice": 0.85, "haferflocken": 0.35, "oats": 0.35,
    "butter": 0.95, "kakao": 0.45, "cocoa": 0.45, "backpulver": 0.9, "baking powder": 0.9, "ketchup": 1.1, "tomatenmark": 1.1, "tomato paste": 1.1,
    "senf": 1.05, "mustard": 1.05, "sojasosse": 1.15, "soy sauce": 1.15, "mayonnaise": 0.95, "erdnussbutter": 1.1, "peanut butter": 1.1,
    "wein": 0.99, "wine": 0.99, "bier": 1.0, "beer": 1.0, "bruhe": 1.0, "broth": 1.0, "stock": 1.0, "saft": 1.04, "juice": 1.04,
    "kokosmilch": 0.97, "coconut milk": 0.97, "rosinen": 0.65, "raisins": 0.65, "gemahlene mandeln": 0.4, "ground almonds": 0.4,
    "parmesan": 0.4, "paniermehl": 0.45, "breadcrumbs": 0.45, "semmelbrosel": 0.45,
}

# words that describe how an ingredient is cut or kept, not what it is: they leave the name and go to the note
_PREP = {fold(w) for w in (
    "gehackt", "gehackte", "gehackter", "gehacktes", "gewürfelt", "gewürfelte", "geschnitten", "geschnittene", "gerieben", "geriebene", "geriebener",
    "gemahlen", "gemahlene", "gesiebt", "gesiebte", "geschält", "geschälte", "zerkleinert", "gepresst", "gepresste", "zerdrückt", "fein", "grob",
    "frisch", "frische", "frischer", "frisches", "weich", "weiche", "zimmerwarm", "zimmerwarme", "kalt", "kalte", "warm", "warme", "lauwarm", "lauwarme",
    "geschmolzen", "flüssig", "optional", "chopped", "diced", "sliced", "minced", "grated", "sifted", "peeled", "fresh", "softened", "melted",
    "finely", "roughly", "coarsely", "cold", "warm", "room", "temperature", "crushed", "shredded", "halved", "cubed", "trimmed", "rinsed", "drained",
    "entkernt", "entsteint", "abgetropft", "abgespült", "gewaschen", "gezupft", "ca", "etwa", "circa", "ungefähr", "about", "approx", "approximately",
)}
_ADJECTIVES = {t for w in (
    "rot", "rote", "roter", "roten", "rotes", "grün", "grüne", "grüner", "grünen", "gelb", "gelbe", "gelber", "gelben", "weiß", "weiße", "weißer", "schwarz", "schwarze", "schwarzer",
    "groß", "große", "großer", "großen", "klein", "kleine", "kleiner", "kleinen", "mittelgroß", "mittelgroße", "reif", "reife", "reifer", "reifen", "bio", "frisch", "frische",
    "festkochend", "festkochende", "mehligkochend", "mehligkochende", "säuerlich", "säuerliche", "süß", "süße", "dick", "dicke", "dünn", "dünne", "ganz", "ganze", "halb", "halbe",
    "red", "green", "yellow", "white", "black", "ripe", "large", "small", "big", "medium", "whole", "organic", "fresh", "sweet", "thick", "thin", "half", "extra", "virgin",
    "unsalted", "salted", "plain", "natural", "lean", "dry", "light", "dark",
) for t in _words(w)}
_STOP = {"of", "von", "vom", "und", "and", "or", "oder", "mit", "with", "ohne", "without", "the", "der", "die", "das", "aus", "an", "for", "fur", "in",
         "nach", "typ", "type", "sorte", "art", "extra", "etwa", "ca", "circa"}
_MODIFIERS = {fold(w) for w in (
    "gestr.", "gestr", "gestrichen", "gestrichene", "gestrichener", "gestrichenes", "gehäuft", "gehäufte", "gehäufter", "gehäuftes", "geh.", "geh",
    "level", "heaped", "scant", "rounded", "ca.", "ca", "etwa", "circa", "about", "approx.", "approx", "approximately", "rund",
)}
_OPTIONAL = re.compile(r"\b(optional|nach belieben|nach geschmack|to taste|bei bedarf|as needed|wenn gewünscht|if desired)\b", re.I)

_VULGAR = {"½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6", "⅚": "5/6",
           "⅐": "1/7", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅑": "1/9", "⅒": "1/10"}
_WORD_NUMBERS = {
    "ein": 1, "eine": 1, "einen": 1, "einem": 1, "einer": 1, "eines": 1, "one": 1, "a": 1, "an": 1, "zwei": 2, "two": 2, "drei": 3, "three": 3,
    "vier": 4, "four": 4, "funf": 5, "five": 5, "sechs": 6, "six": 6, "sieben": 7, "seven": 7, "acht": 8, "eight": 8, "neun": 9, "nine": 9,
    "zehn": 10, "ten": 10, "elf": 11, "zwolf": 12, "twelve": 12, "halb": 0.5, "halbe": 0.5, "halber": 0.5, "halbes": 0.5, "half": 0.5,
}

_NUM = r"(?:\d+\s+\d+/\d+|\d+/\d+|\d+(?:[.,]\d+)*|[.,]\d+)"
_NUM_RE = re.compile(_NUM)
_RANGE_RE = re.compile(rf"^({_NUM})\s*(?:-|–|—|bis|to|or|oder)\s*({_NUM})(?![\d/])", re.I)
_QTY_RE = re.compile(rf"^({_NUM})(?![\d/])")
_LEAD_RE = re.compile(r"^(?:[-–—•*·▪●○□☐☑✓✔]+\s*|\[[ xX]?\]\s*)+")
_APPROX_RE = re.compile(r"^(?:ca\.?|etwa|circa|about|approx\.?|approximately|rund|~|≈)\s*", re.I)
_EXPLICIT_RE = re.compile(rf"(?:\b(?:ca\.?|etwa|circa|about|approx\.?|je|à|á|a|each|per)\s+|~|≈|@)?\s*({_NUM})\s*(g|gr|gramm|gramme|grams?|kg|ml|l|oz|lbs?|fl\.?\s*oz|cl|dl)\b\.?", re.I)
_PER_RE = re.compile(rf"\b(?:je|à|á|each)\s+({_NUM})\s*(g|gr|gramm|grams?|kg|ml|l|oz|lbs?)\b", re.I)
_BRACKET_RE = re.compile(r"[(\[]([^()\[\]]*)[)\]]")
_COMMA_RE = re.compile(r",\s+|,(?!\d)|;")
_GLUED_RE = re.compile(r"^(kg|mg|ml|cl|dl|g|l)(?=[A-ZÄÖÜ])")  # lower-case unit, then a capital: "gMehl"
_FLOZ_RE = re.compile(r"^fl\.?\s*oz\b\.?", re.I)
_TOKEN_RE = re.compile(r"^([^\W\d_]+)(\.?)", re.UNICODE)


def parse_number(text: str) -> float | None:
    """'1,5' / '1.5' -> 1.5; '1/2' -> 0.5; '1 1/2' -> 1.5; '1.500' -> 1500 (a thousands separator: three digits after it, integer part 1-999)."""
    text = text.strip()
    try:
        if "/" in text:
            whole, _, frac = text.rpartition(" ")
            top, _, bottom = frac.partition("/")
            if int(bottom) == 0:
                return None
            return (int(whole) if whole else 0) + int(top) / int(bottom)
        parts = re.split(r"[.,]", text)
        seps = re.findall(r"[.,]", text)
        if len(parts) == 1:
            return float(parts[0])
        if len(set(seps)) == 2:  # '1.234,5' or '1,234.5': the last one is the decimal separator
            return float("".join(parts[:-1]) + "." + parts[-1])
        if len(seps) > 1:  # '1.234.567': thousands separators only
            return float("".join(parts))
        whole, frac = parts
        if len(frac) == 3 and whole not in ("", "0") and len(whole) <= 3:
            return float(whole + frac)
        return float((whole or "0") + "." + frac)
    except (ValueError, ZeroDivisionError):
        return None


def _value(text: str, range_ok: bool = True) -> float | None:
    if range_ok and (m := _RANGE_RE.match(text)):
        low, high = parse_number(m.group(1)), parse_number(m.group(2))
        if low is not None and high is not None and 0 < low <= high:
            return (low + high) / 2
    return parse_number(text)


def _clean(raw: str) -> str:
    for char, frac in _VULGAR.items():
        raw = raw.replace(char, f" {frac} ")
    text = unicodedata.normalize("NFKC", raw)
    text = "".join(c for c in text if unicodedata.category(c) not in ("Cc", "Cf") or c in "\t")
    return re.sub(r"\s+", " ", text).strip()


@dataclass
class Line:
    text: str
    quantity: float | None = None
    unit: str | None = None  # as written, lower case ('EL', 'cups', 'Dose')
    name: str = ""
    note: str | None = None
    optional: bool = False
    grams: float | None = None
    ml: float | None = None
    estimated: bool = False
    basis: str = "none"  # mass, volume, explicit, piece, unit or none: where `grams` comes from
    canned: bool = False  # the line counts cans (Dose, can): a canned food is meant


def _lookup(table: dict[str, Any], name: str, default: Any = None, compounds: bool = True) -> Any:
    """The value of the longest key of `table` found in the (folded) name: as a word, its plural, or the end of a compound."""
    folded = fold(name)
    tokens = re.findall(r"[^\W_]+", folded)
    joined = " ".join(tokens)
    for key in sorted((k for k in table if k), key=len, reverse=True):
        if " " in key:
            if key in joined:
                return table[key]
            continue
        for token in tokens:
            if token == key or (len(key) >= 3 and token.startswith(key) and len(token) - len(key) <= 3):
                return table[key]
            if compounds and len(key) >= 4 and token.endswith(key):
                return table[key]
            if len(key) < 3 and token in (key + "s", key + "e", key + "er", key + "en", key + "n"):
                return table[key]
    return table.get("", default)


def _split_explicit(text: str) -> tuple[str, tuple[float, str] | None, bool]:
    """Take an explicit weight or volume out of the text: (rest, (value, canonical unit), per piece?)."""
    explicit = None
    per = False
    rest = text
    if m := _PER_RE.search(rest):
        v = parse_number(m.group(1))
        unit = _ALIASES.get(fold(re.sub(r"[.\s]", "", m.group(2))))
        if v is not None and unit and (unit in _MASS or unit in _VOLUME):
            explicit, per = (v, unit), True
            rest = rest[:m.start()] + " " + rest[m.end():]
    return rest, explicit, per


_CITRUS = {  # fruit: (juice in g, zest in g, juice name, zest name); a typical yield of one fruit
    "zitrone": (45.0, 6.0, "Zitronensaft", "Zitronenschale"), "lemon": (45.0, 6.0, "Zitronensaft", "Zitronenschale"),
    "limette": (30.0, 4.0, "Limettensaft", "Limettenschale"), "lime": (30.0, 4.0, "Limettensaft", "Limettenschale"),
    "orange": (80.0, 8.0, "Orangensaft", "Orangenschale"), "grapefruit": (100.0, 10.0, "Grapefruitsaft", "Grapefruitschale"),
}
_CITRUS_RE = re.compile(
    rf"^(saft|schale|abrieb|juice|zest)\s+(?:von|vom|einer|eines|einem|of|from)\s+(?:({_NUM})\s+|(halben?|half(?:\s+an?)?|an?|1)\s+)?(?:bio[- ]|unbehandelte[nr]?\s+|organic\s+|large\s+|small\s+|gro(?:ß|ss)en?\s+|kleinen?\s+)*([^\W\d_]+)", re.I)


def _citrus(text: str) -> tuple[float, float, str, str] | None:
    """'Saft von 1 Zitrone', 'Schale einer Orange', 'juice of half a lemon': (count, grams, name, word as written), or None."""
    m = _CITRUS_RE.match(text)
    if not m:
        return None
    fruit = fold(m.group(4))
    row = _CITRUS.get(fruit) or _CITRUS.get(fruit.rstrip("n")) or _CITRUS.get(fruit.rstrip("s"))
    if row is None:
        return None
    word = fold(m.group(1))
    if m.group(2):
        count = parse_number(m.group(2))
    elif m.group(3) and fold(m.group(3)).startswith(("halb", "half")):
        count = 0.5
    else:
        count = 1.0
    if not count or not 0 < count <= 1000:
        return None
    juice = word in ("saft", "juice")
    return count, count * (row[0] if juice else row[1]), row[2] if juice else row[3], m.group(1)


def parse_line(raw: str) -> Line | None:
    """One ingredient line, or None for a line that holds nothing (blank, only punctuation, a heading such as 'Für den Teig:')."""
    text = _clean(raw)
    text = _LEAD_RE.sub("", text).strip()
    if not text or not re.search(r"\w", text) or (text.endswith(":") and not re.search(r"\d", text)):
        return None
    line = Line(text=raw.strip())
    notes: list[str] = []
    if _OPTIONAL.search(text):
        line.optional = True

    # explicit weight in brackets or after "je" / "à"
    explicit: tuple[float, str] | None = None
    per_piece = False

    def bracket(m: re.Match) -> str:
        nonlocal explicit, per_piece
        inner = m.group(1).strip()
        if explicit is None and (e := _EXPLICIT_RE.search(inner)):
            v = parse_number(e.group(1))
            unit = _ALIASES.get(fold(re.sub(r"[.\s]", "", e.group(2))))
            if v is not None and unit and (unit in _MASS or unit in _VOLUME) and v > 0:
                explicit = (v, unit)
                per_piece = bool(re.match(r"\s*(?:je|each|per|à|á)\b", m.group(1), re.I))  # "je 60 g": each; plain "(400 g)" is the total, except for cans and packs
                inner = (inner[:e.start()] + " " + inner[e.end():]).strip(" ,;-")
        if inner:
            notes.append(inner)
        return " "

    text = _BRACKET_RE.sub(bracket, text)
    if explicit is None:
        text, explicit, per_piece = _split_explicit(text)
    text = re.sub(r"\s+", " ", text).strip()

    head, *more = _COMMA_RE.split(text, maxsplit=1)
    if more and more[0].strip():
        notes.append(more[0].strip())
    head = head.strip()

    if (citrus := _citrus(head)) is not None:  # "Saft von 1 Zitrone"
        count, weight, name, word = citrus
        line.quantity, line.unit, line.name = count, word, name
        line.grams, line.estimated, line.basis = round(weight, 1), True, "unit"
        line.note = "; ".join(n for n in notes if n)[:300] or None
        return line

    # quantity
    head = _APPROX_RE.sub("", head)
    quantity: float | None = None
    if m := _RANGE_RE.match(head):
        quantity = _value(head)
        head = head[m.end():].strip()
    elif m := _QTY_RE.match(head):
        quantity = parse_number(m.group(1))
        head = head[m.end():].strip()
        if re.match(r"^[x×]\s", head):  # "2 x Eier", "2 x 200 g Mehl"
            head = head[1:].strip()
            if (e := _EXPLICIT_RE.match(head)) and explicit is None:
                value, eunit = parse_number(e.group(1)), _ALIASES.get(fold(re.sub(r"[.\s]", "", e.group(2))))
                if value and eunit and (eunit in _MASS or eunit in _VOLUME):
                    explicit, per_piece = (value, eunit), True
                    head = head[e.end():].strip()
    elif first := re.match(r"^([^\W\d_]+)\b", head):
        word = fold(first.group(1))
        after = head[first.end():].strip()
        if word in _WORD_NUMBERS and (word not in ("a", "an") or _unit_of(after)[0]):
            quantity = float(_WORD_NUMBERS[word])
            head = after
            if half := re.match(r"^(halbe|halber|halbes|halb|half)\b", head, re.I):  # "eine halbe Zitrone", "a half cup"
                quantity *= 0.5
                head = head[half.end():].strip()
    if quantity is None and explicit is None and (e := re.search(rf"\s({_NUM})\s*([^\W\d_]+\.?)$", head)):
        # the amount at the end: "Mehl 200 g", "Salz 1 Prise"
        value, canon_end = parse_number(e.group(1)), _ALIASES.get(fold(e.group(2).rstrip(".")))
        if value and canon_end and (canon_end in _MASS or canon_end in _VOLUME or canon_end in _ITEMS):
            quantity, head = value, f"{e.group(2)} {head[:e.start()].strip()}".strip()
    if quantity is not None and not (0 < quantity <= MAX_QUANTITY):
        quantity = None
    line.quantity = quantity

    # modifiers ("gestr.", "heaped", "große") between quantity and unit
    size = 1.0
    while True:
        m = re.match(r"^([^\W\d_]+\.?)\s*", head, re.UNICODE)
        if not m:
            break
        word = fold(m.group(1))
        if word in _MODIFIERS:
            head = head[m.end():]
        elif word.rstrip(".") in _SIZE and not _unit_of(head)[0]:
            size = _SIZE[word.rstrip(".")]
            head = head[m.end():]
        else:
            break

    unit_word, canon, head = _unit_of(head)
    # "of" / "von" between unit and name
    head = re.sub(r"^(?:of|von|vom|aus)\s+", "", head, flags=re.I)
    if unit_word and quantity is None and canon in _ITEMS:
        quantity = 1.0  # "Prise Salz", "pinch of salt"
        line.quantity = None
    line.unit = unit_word

    # name: first alternative, without cutting words
    name, *alternative = re.split(r"\s+(?:oder|or|und|and|&)\s+", head, maxsplit=1)
    if alternative:
        notes.append(alternative[0])
    kept, dropped = [], []
    for word in name.split():
        (dropped if fold(word.strip(".,;:")) in _PREP else kept).append(word)
    name = " ".join(kept).strip(" -–—.:;/")
    if not name:
        name = head.strip(" -–—.:;/")
        dropped = []
    else:
        notes.extend(dropped)
    line.name = name[:200]
    notes = [n for n in notes if n]
    line.note = "; ".join(notes)[:300] or None

    line.canned = canon == "can" or bool(re.search(r"\b(?:dose|dosen|konserve|can|cans|canned|tin|tinned)\b", raw, re.I))
    _weigh(line, quantity if quantity is not None else None, canon, explicit, per_piece, size)
    return line


def _unit_of(text: str) -> tuple[str | None, str | None, str]:
    """The unit at the start of `text`: (as written, canonical, the rest). (None, None, text) when there is none."""
    if m := _FLOZ_RE.match(text):
        return text[:m.end()].strip(), "floz", text[m.end():].strip()
    m = _TOKEN_RE.match(text)
    if not m:
        return None, None, text
    word = fold(m.group(1))
    canon = _ALIASES.get(word)
    if canon is None and (glued := _GLUED_RE.match(text)):  # "200gMehl", "1ELHonig": a short unit written together with the name
        return glued.group(1), _ALIASES[glued.group(1)], text[glued.end():].strip()
    if canon is None or (len(text) > m.end() and text[m.end()] not in " .,(/;" and not text[m.end():].startswith("-")):
        return None, None, text
    return m.group(1) + m.group(2), canon, text[m.end():].strip()


def _weigh(line: Line, quantity: float | None, canon: str | None, explicit: tuple[float, str] | None, per_piece: bool, size: float) -> None:
    name = line.name
    counted = canon is None or canon in _ITEMS
    amount = quantity if quantity is not None else (1.0 if canon in _ITEMS else None)

    def density() -> float | None:
        return _lookup(_DENSITY, name, None)

    def from_ml(ml: float, varies: bool = False) -> None:
        d = density()
        line.ml = round(ml, 2)
        line.grams = ml * (d if d is not None else 1.0)
        line.estimated = d is None or varies
        line.basis = "volume"

    if explicit is not None and (amount is not None or counted):
        value, unit = explicit
        times = (amount if amount is not None else 1.0) if (counted and (per_piece or canon in _CONTAINERS)) else 1.0
        if unit in _MASS:
            line.grams, line.basis, line.estimated = value * _MASS[unit] * times, "explicit", False
        else:
            from_ml(value * _VOLUME[unit][0] * times)
            line.basis = "explicit"
    elif canon in _MASS and amount is not None:
        line.grams, line.basis = amount * _MASS[canon], "mass"
        if (d := density()) is not None:
            line.ml = round(line.grams / d, 2)
    elif canon in _VOLUME and amount is not None:
        factor, varies = _VOLUME[canon]
        from_ml(amount * factor, varies)
    elif counted and amount is not None:
        each = None
        if canon in _ITEMS and canon != "piece":
            table = _UNIT_WEIGHTS.get(canon)
            if table:
                each = _lookup(table, name, None)
                if each is None:
                    each = table.get("")
        if each is None and canon in (None, "piece"):
            each = _lookup(_PIECES, name, None)
            if each is not None:
                each *= size
        if each is not None:
            line.grams, line.estimated = amount * each, True
            line.basis = "piece" if canon in (None, "piece") else "unit"
    if line.grams is not None:
        if not (0 < line.grams <= MAX_GRAMS):
            line.grams = line.ml = None
            line.estimated, line.basis = False, "none"
        else:
            line.grams = round(line.grams, 1)
    if line.grams is None:
        line.ml = None
        line.estimated = False
        line.basis = "none"


def parse_text(text: str) -> tuple[list[tuple[int, Line]], int]:
    """All lines with something in them as (line number from 1, parsed line), and how many non-empty lines were left out."""
    result, ignored = [], 0
    for number, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        line = parse_line(raw)
        if line is None:
            ignored += 1
        else:
            result.append((number, line))
    return result, ignored


# --- the usual meaning of common ingredients -----------------------------------------------------------------------------
# "keys: search words". The keys are what a line may call the ingredient (German and English, in any inflection that `_lookup` accepts);
# the search words are what to look for in the basic foods first, written the way the BLS names its foods. No catalogue codes: another
# catalogue, or none, simply finds something else (or nothing) and the generic search below takes over.
_USUAL = """
mehl, weizenmehl, flour, wheat flour, plain flour, all-purpose flour, all purpose flour: Weizen Mehl Type 405
vollkornmehl, wholemeal flour, whole wheat flour: Weizen Vollkornmehl
dinkelmehl, spelt flour: Dinkel Mehl Type 630
roggenmehl, rye flour: Roggen Mehl Type 1150
ei, eier, egg, eggs, huhnerei: Hühnerei roh
eigelb, egg yolk, egg yolks: Hühnerei Eigelb roh
eiweiss, eiklar, egg white, egg whites: Hühnerei Eiklar roh
zucker, sugar, haushaltszucker, kristallzucker, feinzucker, granulated sugar, white sugar, caster sugar: Zucker weiß
puderzucker, staubzucker, icing sugar, powdered sugar, confectioners sugar: Puderzucker
brauner zucker, rohrzucker, brown sugar: Zucker braun
vanillezucker, vanillinzucker, vanilla sugar: Vanillinzucker
salz, salt, speisesalz, kochsalz, tafelsalz, table salt: Speisesalz
meersalz, sea salt: Meersalz
pfeffer, pepper, black pepper, schwarzer pfeffer: Pfeffer schwarz
butter: Butter mild gesäuert
margarine: Margarine
sahne, schlagsahne, cream, heavy cream, whipping cream, double cream, kochsahne: Schlagsahne 30
saure sahne, sauerrahm, sour cream: Sauerrahm 10
schmand, creme fraiche, creme fraiche, cream fraiche: Sauerrahm Creme fraiche 30
milch, milk, vollmilch, whole milk: Vollmilch frisch
fettarme milch, low fat milk: Milch fettarm frisch
buttermilch, buttermilk: Buttermilch
joghurt, yogurt, yoghurt, naturjoghurt, plain yogurt: Joghurt mild
fruchtjoghurt, fruit yogurt, fruit yoghurt: Joghurt mild Fruchtzubereitung
quark, magerquark, speisequark, quark cheese: Speisequark Magerstufe
frischkase, cream cheese: Frischkäse
hüttenkase, huttenkase, cottage cheese: Hüttenkäse
olivenol, olive oil, extra virgin olive oil: Olivenöl
ol, oil, pflanzenol, vegetable oil, rapsol, canola oil: Rapsöl
sonnenblumenol, sunflower oil: Sonnenblumenöl
kokosol, coconut oil: Kokosöl
essig, vinegar, weinessig, wine vinegar: Weinessig
balsamico, balsamicoessig, balsamic vinegar: Balsamicoessig
apfelessig, apple cider vinegar: Apfelessig
senf, mustard: Senf mittelscharf
ketchup: Tomatenketchup
tomatenmark, tomato paste, tomato puree: Tomatenmark
sojasauce, sojasosse, soy sauce: Sojasauce
mayonnaise, mayo: Mayonnaise
honig, honey: Honig
ahornsirup, maple syrup: Ahornsirup
backpulver, baking powder: Backpulver
natron, backnatron, baking soda, bicarbonate of soda: Natron
hefe, backhefe, yeast, trockenhefe, frischhefe, dry yeast: Backhefe frisch
speisestarke, starch, cornstarch, corn starch, maisstarke: Mais Stärke
gelatine: Gelatine
kakao, kakaopulver, cocoa, cocoa powder: Kakaopulver schwach entölt
schokolade, chocolate, zartbitterschokolade, dark chocolate: Schokolade Zartbitter
haferflocken, oats, rolled oats, oatmeal: Haferflocken
reis, rice, basmatireis, jasminreis, long grain rice, white rice, weisser reis: Reis poliert roh
vollkornreis, naturreis, brown rice, wholegrain rice: Reis unpoliert roh
wildreis, wild rice: Wildreis roh
nudeln, pasta, spaghetti, penne, fusilli, macaroni, noodles: Teigwaren eifrei roh
brot, bread: Weizenmischbrot
brotchen, bread roll, roll: Weizenbrötchen
paniermehl, semmelbrosel, breadcrumbs: Paniermehl
brühe, bruhe, bouillon, stock, broth, gemusebruhe, vegetable stock, vegetable broth, hühnerbrühe, chicken stock: Gemüse Bouillon
zwiebel, onion, speisezwiebel, gemusezwiebel, yellow onion, red onion, rote zwiebel: Speisezwiebel roh
fruhlingszwiebel, lauchzwiebel, spring onion, scallion, green onion: Frühlingszwiebel roh
schalotte, shallot: Schalotte roh
knoblauch, knoblauchzehe, garlic, garlic clove: Knoblauch roh
karotte, mohre, mohren, carrot, karotten: Karotte Möhre roh
kartoffel, potato, potatoes, kartoffeln: Kartoffel geschält roh
kartoffelpuree, kartoffelbrei, mashed potatoes, mashed potato: Kartoffelpüree
bratkartoffeln, fried potatoes: Bratkartoffeln
pommes, pommes frites, french fries, fries, chips potato: Pommes frites
susskartoffel, sweet potato: Batate Süßkartoffel roh
tomate, tomato, tomatoes, tomaten: Tomate roh
kirschtomate, cherry tomato: Tomate roh
paprika, bell pepper, pepper pod, red pepper: Paprika
gurke, salatgurke, cucumber: Gurke roh
zucchini, courgette: Zucchini roh
aubergine, eggplant: Aubergine roh
spinat, spinach: Spinat roh
spargel, asparagus, grüner spargel, green asparagus, weisser spargel: Spargel roh
brokkoli, broccoli: Broccoli roh
blumenkohl, cauliflower: Blumenkohl roh
lauch, porree, leek: Porree Lauch roh
sellerie, celery, stangensellerie: Bleichsellerie roh
champignon, champignons, pilze, mushroom, mushrooms: Champignon roh
mais, corn, sweetcorn: Zuckermais roh
erbsen, peas: Erbse roh
kichererbsen, chickpeas: Kichererbse
linsen, lentils, braune linsen, brown lentils: Linse reif
rote linsen, red lentils: Linse rot reif
grune bohnen, green beans, brechbohnen, stangenbohnen, grune bohne, green bean: Bohne grün roh
kurbis, pumpkin, squash: Kürbis roh
rote bete, rote rube, beetroot, beet: Rote Rübe Rote Bete roh
kohlrabi: Kohlrabi roh
fenchel, fennel: Gemüsefenchel roh
rotkohl, red cabbage: Rotkohl roh
weisskohl, white cabbage, kohl, cabbage: Weißkohl roh
salat, kopfsalat, lettuce: Kopfsalat roh
eisbergsalat, iceberg lettuce: Eisbergsalat roh
rucola, rocket, arugula: Rucola roh
radieschen, radish: Radieschen roh
avocado: Avocado roh
apfel, apple, apfel, aepfel: Apfel roh
birne, pear: Birne roh
banane, banana: Banane roh
zitrone, lemon, zitronenschale, lemon zest: Zitrone roh
zitronensaft, lemon juice: Zitronensaft
orange: Orange roh
orangensaft, orange juice: Orangensaft
limette, lime: Limette roh
ananas, pineapple: Ananas roh
erdbeere, erdbeeren, strawberry, strawberries: Erdbeere roh
blaubeeren, heidelbeeren, blueberry, blueberries: Heidelbeere roh
himbeeren, raspberry, raspberries: Himbeere roh
weintrauben, trauben, grapes: Weintraube roh
pfirsich, peach: Pfirsich roh
mango: Mango roh
kiwi: Kiwi roh
rosinen, raisins: Rosinen
datteln, dates: Datteln
mandeln, almonds, almond, mandel: Mandel süß
gemahlene mandeln, ground almonds: Mandel gemahlen
walnusse, walnuss, walnuts, walnut: Walnuss
haselnusse, haselnuss, hazelnuts: Haselnuss
erdnusse, erdnuss, peanuts: Erdnuss
cashews, cashewkerne, cashew: Cashewkern
sesam, sesame: Sesam
sonnenblumenkerne, sunflower seeds: Sonnenblumenkerne
leinsamen, flaxseed, flax seeds: Leinsamen
kokosraspeln, desiccated coconut, shredded coconut: Kokosnuss getrocknet
kokosmilch, coconut milk: Kokosmilch
petersilie, parsley: Petersilienblatt roh
basilikum, basil: Basilikum roh
schnittlauch, chives: Schnittlauch roh
dill: Dill
thymian, thyme: Thymian
rosmarin, rosemary: Rosmarin
oregano: Oregano
koriander, cilantro, coriander: Koriander
minze, mint: Minze
ingwer, ginger: Ingwer roh
zimt, cinnamon: Zimt
paprikapulver, paprika powder: Paprika Gewürz
curry, curry powder, currypulver: Curry
muskat, muskatnuss, nutmeg: Muskat
kreuzkummel, cumin: Kreuzkümmel
chili, chilli, peperoni, chilischote: Chili
vanille, vanilla: Vanille
hackfleisch, mince, minced meat, gehacktes, gemischtes hackfleisch, ground meat: Rind Schwein Hackfleisch gemischt roh
rinderhack, rinderhackfleisch, beef mince, ground beef, minced beef: Rind Hackfleisch roh
schweinehack, schweinehackfleisch, pork mince: Schwein Hackfleisch roh
hahnchenbrust, hahnchenbrustfilet, hahnchen, chicken breast, chicken, huhn, hühnerbrust: Hähnchen Brustfilet roh
putenbrust, turkey breast, pute, turkey: Pute Brust roh
rindfleisch, beef, steak, rindersteak, beef steak, rumpsteak, sirloin: Rind Steak Rücken roh
schweinefleisch, pork, schweinekotelett, pork chop, kotelett: Schwein Kotelett roh
schnitzel, schweineschnitzel, pork cutlet, cutlet: Schwein Schnitzel roh
lachs, salmon, lachsfilet: Lachs roh
thunfisch, tuna: Thunfisch
schinken, ham: Schinken
speck, bacon: Speck
wurst, sausage: Bratwurst
tofu: Tofu
gouda: Gouda 40
edamer: Edamer 40
parmesan: Parmesan
mozzarella: Mozzarella
feta, schafskase: Feta
cheddar: Cheddar
emmentaler: Emmentaler
kase, cheese, reibekase, geriebener kase, grated cheese: Gouda 40
wasser, water, leitungswasser: Trinkwasser
wein, wine, weisswein, white wine: Weißwein trocken
rotwein, red wine: Rotwein
bier, beer: Bier
"""


def _parse_usual() -> list[tuple[str, list[str]]]:
    rows = []
    for line in _USUAL.strip().splitlines():
        keys, _, query = line.partition(":")
        rows.append((query.strip(), [fold(k.strip()) for k in keys.split(",") if k.strip()]))
    return rows


_USUAL_KEYS: dict[str, str] = {}
for _query, _keys in _parse_usual():
    for _key in _keys:
        _USUAL_KEYS.setdefault(_key, _query)


_TAILS = tuple(fold(t) for t in ("schoten", "schote", "röschen", "filets", "filet", "scheiben", "stücke", "würfel", "streifen", "blätter", "zehen", "zehe", "spitzen", "kerne", "hälften"))


def usual_query(name: str) -> str | None:
    """The usual search words of an ingredient name ("Eier" -> "Hühnerei roh"), or None."""
    if (found := _lookup(_USUAL_KEYS, name, None, compounds=False)) is not None:
        return found
    for token in _words(name):  # "Paprikaschote", "Brokkoliröschen": the food and a word for its cut or part
        for tail in _TAILS:
            if token.endswith(tail) and len(token) > len(tail) + 2 and (found := _USUAL_KEYS.get(fold(token[: -len(tail)]))) is not None:
                return found
    return None


# --- the finding of foods ------------------------------------------------------------------------------------------------

# words that make a food a prepared one: a name with one of them ranks behind the plain one unless the line says it too
_PREPARED = {t for w in (
    "gebraten", "gekocht", "gedünstet", "geschmort", "gegrillt", "gebacken", "pochiert", "frittiert", "überbacken", "gratiniert", "paniert", "gedämpft",
    "getrocknet", "tiefgefroren", "konserve", "püree", "pürierte", "sauce", "soße", "sosse", "suppe", "pulver", "kuchen", "torte", "salat", "brei",
    "gesüßt", "geräuchert", "gepökelt", "eingelegt", "gesalzen", "mit", "in", "gefüllt", "gesäuert", "fertigprodukt", "gezuckert", "gargezogen",
    "fried", "boiled", "stewed", "braised", "grilled", "baked", "poached", "deep-fried", "gratinated", "breaded", "dried", "deep-frozen", "canned",
    "puree", "soup", "powder", "brotaufstrich", "aufstrich", "dip", "füllung", "creme", "marinade", "spread", "filling", "cream", "cake", "salad", "sweetened", "smoked", "salted", "pickled", "steamed", "roasted", "cooked", "with", "filled", "sugared",
) for t in _words(w)}
_PREPARED.discard("gesauert")  # "Butter mild gesäuert" is the plain butter

# words that say the same about the preparation, in both languages: a line that says one of them is satisfied by a name with any of them
_SAME_PREPARATION = [
    ("gekocht", "boiled", "cooked", "boil"),
    ("gebraten", "fried", "pan-fried", "pan fried", "sautéed", "sauteed"),
    ("gebraten", "gebacken", "gegrillt", "geschmort", "roasted", "baked", "grilled", "roast", "überbacken"),
    ("gedämpft", "gedünstet", "gekocht", "steamed", "stewed"),
    ("geschmort", "gedünstet", "braised", "stewed"),
    ("püree", "puree"),
    ("pochiert", "poached"),
    ("getrocknet", "dried"),
    ("tiefgefroren", "deep-frozen", "frozen", "gefroren"),
    ("konserve", "canned", "tinned"),
    ("geräuchert", "smoked"),
    ("frittiert", "deep-fried", "fried"),
    ("paniert", "breaded"),
]
_SAME_WORDS = [{t for w in group for t in _words(w)} for group in _SAME_PREPARATION]
_PREPARED |= set().union(*_SAME_WORDS)
_PREPARED |= {"eintopf", "auflauf"}
_PREPARED.discard("deep")
_DISH_WORDS = {"suppe", "soup", "salat", "salad", "sauce", "sosse", "soße", "soße", "kuchen", "cake", "torte", "eintopf", "stew", "auflauf", "pie", "pizza", "burger"}


def _is_dish(token: str) -> bool:
    """A dish word or a compound that ends in one (Baumkuchen, Nudelsalat); soups count as the food they are made of."""
    if token in ("suppe", "soup"):
        return False
    return token in _DISH_WORDS or any(len(d) >= 5 and token.endswith(d) and len(token) - len(d) >= 3 for d in _DISH_WORDS - {"suppe"})


_NAME_SPLIT = re.compile(r"[\s\-/&+]+")


def _names_only(name: str, words: list[str], context: set[str]) -> bool:
    """For names people typed (own foods, Yazio, products): every noun before the first comma or bracket is one the line asks for.
    'MILCH Brötchen' is a roll and 'Schoko-Plunder' a pastry, not milk or chocolate; a German name tells its nouns by the capital letter.
    The word itself must be the noun: unlike the catalogue (Speisesalz for Salz) the end of a compound is not enough here."""
    nouns = [w for w in _NAME_SPLIT.split(re.split(r"[,(;]", name, maxsplit=1)[0]) if w[:1].isupper()]
    for noun in nouns:
        tokens = _tokens(noun)
        if not tokens or all(t in _ADJECTIVES or t in _STOP or t in _PREP or t in _PREPARED or t in _RAW or t.isdigit() or t in context for t in tokens):
            continue
        if not any((c := _word_class(w, tokens)) is not None and c <= 0.5 for w in words):  # 'Kokosmilch' is not milk
            return False
    return True


def _expand(context: set[str]) -> tuple[set[str], bool]:
    """The words of a line plus every word that says the same about the preparation; and whether the line names a preparation at all."""
    expanded = set(context)
    named = False
    for group in _SAME_WORDS:
        if any(c in group or any(len(w) >= 5 and c.startswith(w) for w in group) for c in context):
            expanded |= group
            named = True
    return expanded, named


_RAW = {"roh", "raw"}
_USER_SOURCES = ("own", "yazio")
USER_BONUS = 4.0
GOOD_LIMIT = 1.0  # an average word match worse than this (the word only starts a longer word) is no confident suggestion


def _tokens(text: str) -> list[str]:
    """The words of a name as the catalogue sees them (lower case, no diacritics; 'ß' stays), so that they can be compared with its names."""
    return _words(text)


def _word_class(word: str, tokens: list[str]) -> float | None:
    """How well `word` fits the words of a name: 0 the word itself, 0.5 with a plural ending, 1 the end of a compound (Speisesalz for Salz),
    2 the start of a longer word (Salzburger, Butterzwieback), 3 somewhere inside; None when it does not occur."""
    best = None
    for token in tokens:
        if token == word:
            return 0.0
        if token.startswith(word):
            c = 0.5 if len(token) - len(word) <= 3 else 2.0
        elif len(word) >= 4 and token.endswith(word):
            c = 1.0
        elif len(word) >= 4 and word in token:
            c = 3.0
        else:
            continue
        best = c if best is None or c < best else best
    return best


def _score(words: list[str], names: list[str], context: set[str], code: str | None, source: str, said: frozenset[str] = frozenset(),
           sure: bool = True) -> tuple[float, bool, bool] | None:
    """(score, confident, says the preparation of the line) of a food for the search words; smaller is better. None when a word does not occur in any of the names.
    `sure` False: the search words leave out part of the line, so no food can be a confident match (and own foods get no head start)."""
    best = None
    for name in names:
        tokens = _tokens(name)
        if not tokens:
            continue
        classes = [_word_class(w, tokens) for w in words]
        if any(c is None for c in classes):
            continue
        cls = sum(classes)  # type: ignore[arg-type]
        prepared = [t for t in tokens if t in _PREPARED]
        penalty = sum((2 if t.endswith("pulver") else 1) for t in prepared if t not in context)
        penalty += sum(2 for t in tokens if t.endswith("pulver") and t not in _PREPARED and t not in context)  # "Instantpulver": the dry mix
        credit = sum(1 for t in prepared if t in context)
        exact = sum(1 for t in prepared if t in said)  # the very word of the line counts more than one that says the same
        dish = any(_is_dish(t) and t not in context for t in tokens)  # a stew, a cake, a Baumkuchen: not the plain food
        raw = -2.0 if any(t in _RAW for t in tokens) else 0.0
        base = -1.0 if source == "bls" and code and code.endswith("00") else 0.0
        extra = max(0, len(tokens) - len(words)) * 0.2
        first = -1.0 if any(tokens[0] == w or (tokens[0].startswith(w) and len(tokens[0]) - len(w) <= 3) for w in words) else 0.0  # the food comes first in its name
        score = 2 * cls + 3 * penalty - 4 * credit - 3 * exact + raw + base + extra + first
        if best is None or score < best[0]:
            confident = sure and cls <= GOOD_LIMIT * len(words) and not dish and (source == "bls" or _names_only(name, words, context))
            best = (score, confident, credit > 0)
    if best is None:
        return None
    return (best[0] - (USER_BONUS if source in _USER_SOURCES and best[1] else 0.0), best[1], best[2])


_COLOURS = ("grun", "rot", "weiß", "schwarz", "gelb", "braun", "blau", "green", "red", "white", "black", "yellow", "brown", "blue")


def _colour(token: str) -> str | None:
    """'grüne' -> 'grun', 'rote' -> 'rot': the colour a word names (a colour can make a food of its own: grüne Bohnen, rote Linsen)."""
    for stem in _COLOURS:
        if token == stem or (token.startswith(stem) and token[len(stem):] in ("e", "er", "en", "es", "em")):
            return stem
    return None


def _core(full: list[str]) -> list[str]:
    """The words of a name that say what the food is: without numbers, filler words, cutting and preparation words, adjectives."""
    core = [w for w in full if not w.isdigit() and w not in _STOP and w not in _PREP and w not in _ADJECTIVES] or [w for w in full if not w.isdigit() and w not in _STOP]
    return [w for w in core if w not in _PREPARED] or core


def _covers(tokens: list[str], core: list[str]) -> bool:
    """Whether the search words still stand for every word of the name ('schoko' alone does not stand for 'Schoko-Cerealien')."""
    return all(any(t == w or w.startswith(t) or t.startswith(w) for t in tokens) for w in core)


def variants(name: str) -> list[list[str]]:
    """What to look for, most specific first: all words, then fewer (from the end, then from the front), then single words, each also
    without a plural ending. Numbers and filler words ('Typ 405', 'extra') are left out of every variant but the first."""
    full = _tokens(name)
    core = _core(full)
    result: list[list[str]] = []

    def add(tokens: list[str]) -> None:
        if tokens and tokens not in result:
            result.append(tokens)

    add(full)
    coloured = [_colour(w) or w for w in full if not w.isdigit() and w not in _STOP and w not in _PREP and w not in _PREPARED]
    if any(_colour(w) for w in full):  # "grüne Bohnen" -> "grun bohnen" before the colour is dropped
        add(coloured)
    add(core)
    for n in range(len(core) - 1, 0, -1):
        add(core[:n])
    for n in range(1, len(core)):
        add(core[n:])
    for word in reversed(core):  # the noun comes last in German and in English
        add([word])
    for tokens in list(result):
        add([_singular(w) for w in tokens])
    return result[:12]


def _singular(word: str) -> str:
    for ending in ("en", "er", "n", "e", "s"):
        if word.endswith(ending) and len(word) - len(ending) >= 2:
            return word[: -len(ending)]
    return word


@dataclass
class Candidate:
    source: str
    name: str
    brand: str | None
    unit: str
    per_100: dict
    food_id: int | None = None
    code: str | None = None
    good: bool = True  # a confident match; the first candidate is only suggested when it is


def _from_food(food: dict, good: bool) -> Candidate:
    data = food["data"]
    return Candidate(source=food["source"], food_id=food["id"], code=food.get("code"), name=data.get("name") or food.get("code") or "?",
                     brand=data.get("brand"), unit=data.get("unit") or "g", per_100=data["per_100"], good=good)


def _from_item(item: dict, good: bool = True) -> Candidate:
    return Candidate(source=item["source"], code=item["code"], name=item["name"], brand=item.get("brand"), unit=item["unit"], per_100=item["per_100"], good=good)


def _packaged(catalog: Any, tokens: list[str], limit: int, skip: Any, context: set[str], sure: bool = True) -> list[Candidate]:
    query = " ".join(tokens)
    if len(query) < 2:
        return []
    result = []
    for item in catalog.search(query, limit, "openfoodfacts", skip=skip):
        hit = _score(tokens, [item["name"]], context, item["code"], "openfoodfacts", sure=sure)
        result.append(_from_item(item, hit is not None and hit[1]))
    return result


BASIC_POOL = 60  # how many basic foods of a search are ranked again here


def candidates(name: str, own_foods: list[dict], catalog: Any, skip: Any = None, context: str = "", canned: bool = False) -> list[Candidate]:
    """Up to MAX_CANDIDATES foods that may be meant by `name`, best first.

    The search words are tried from the usual meaning of the ingredient (the table above) to ever looser forms of the name; the first
    form that finds an own or basic food wins. Stored foods (own ones, and basic foods and products taken over earlier) and the basic foods
    of the catalogue are ranked together by `_score`: the word as a whole word before the start of a longer one (Butter before
    Butterzwieback), the end of a compound as a whole (Speisesalz for Salz), the raw or plain food before a prepared one unless the line
    says how it is prepared, the shorter name; foods the person made themselves get a head start. Packaged products (Open Food Facts)
    come only after those, and alone only when nothing else was found. `context` is the whole line (what it says about the preparation);
    `canned` says the line is about a can. `own_foods` are store rows (without recipes); `catalog` may be empty or missing its files."""
    context_words = set(_tokens(context))
    if canned:
        context_words |= {"konserve", "canned"}
    said = frozenset(context_words | {t for t in _PREPARED if len(t) >= 5 and any(c.startswith(t) for c in context_words)})  # "gebratenes" says "gebraten"
    context_words, says_prepared = _expand(context_words)
    name_tokens = _tokens(name)
    colours = {c for w in name_tokens if (c := _colour(w))} | (set(name_tokens) & _DISH_WORDS)  # words that make a food of its own
    steps: list[list[str]] = []
    table_steps = 0
    if not _DISH_WORDS & set(name_tokens) and (usual := usual_query(name)) is not None:
        usual_words = _tokens(usual)
        if canned or says_prepared:  # the line names the preparation (a can, "gekocht"): "Tomate roh" becomes "Tomate"
            usual_words = [w for w in usual_words if w not in _RAW] or usual_words
        steps.append(usual_words)
        table_steps = 1
    steps += [t for t in variants(name) if t not in steps]
    core = _core(name_tokens)
    sure = [i < table_steps or _covers(tokens, core) for i, tokens in enumerate(steps)]

    def stored(tokens: list[str]) -> list[tuple[float, int, Candidate]]:
        found = []
        for index, food in enumerate(own_foods):
            data = food["data"]
            if (hit := _score(tokens, [data.get("name") or ""], context_words, food.get("code"), food["source"], said, sure[steps.index(tokens)])) is not None:
                found.append((hit[0], index, _from_food(food, hit[1] and (hit[2] or not says_prepared))))
        return found

    # stored foods are looked for with every form of the name, the first form that finds one wins (a food made by the person is not
    # named like the usual meaning: "Butter selbstgemacht"); the basic foods of the catalogue the same way, in their own pass
    own_hits = next((hits for tokens in steps if (hits := stored(tokens))), [])
    for position, tokens in enumerate(steps):
        scored = list(own_hits)
        loose = position >= table_steps and bool(colours) and not colours & set(tokens)  # "grüne Bohnen" found as "Bohnen", "Chicken soup" as "Chicken": no sure match
        if len(" ".join(tokens)) >= 2:
            for index, item in enumerate(catalog.search(" ".join(tokens), BASIC_POOL, "bls", skip=skip), start=len(own_foods)):
                if (hit := _score(tokens, [item["name"], item.get("name_en") or ""], context_words, item["code"], "bls", said, sure[position])) is not None:
                    scored.append((hit[0], index, _from_item(item, hit[1] and (hit[2] or not says_prepared))))
        if len(scored) > len(own_hits) or (own_hits and tokens is steps[-1]):
            found = [c for _, _, c in sorted(scored, key=lambda r: (r[0], r[1]))][:MAX_CANDIDATES]
            if loose:
                for c in found:
                    c.good = False
            if len(found) < MAX_CANDIDATES and not found[0].good:  # packaged products only where the basic foods give no confident answer
                found += _packaged(catalog, tokens, MAX_CANDIDATES - len(found), skip, context_words, sure[position])
            return found
    if own_hits:
        return [c for _, _, c in sorted(own_hits, key=lambda r: (r[0], r[1]))][:MAX_CANDIDATES]
    for tokens in steps:
        if packaged := _packaged(catalog, tokens, MAX_CANDIDATES, skip, context_words, sure[steps.index(tokens)]):
            return packaged
    return []

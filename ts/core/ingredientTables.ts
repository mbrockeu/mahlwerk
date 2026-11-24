// Word tables of the ingredient reader (generated once from src/mahlwerk/ingredients.py, which stays the reference until the switch).
// Words are already folded (lower case, no diacritics, ß as ss) wherever the Python module folds them. Object order is the dict order:
// it decides ties between keys of the same length in `lookup`.

export const ALIASES: Record<string, string> = {
  "g": "g", "gr": "g", "gramm": "g", "gram": "g", "grams": "g", "gramme": "g", "mg": "mg", "milligramm": "mg", "milligram": "mg", "kg": "kg",
  "kilo": "kg", "kilogramm": "kg", "kilogram": "kg", "kilograms": "kg", "kgs": "kg", "oz": "oz", "ounce": "oz", "ounces": "oz", "unze": "oz",
  "unzen": "oz", "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb", "pfd": "pfund", "pfund": "pfund", "ml": "ml", "milliliter": "ml",
  "millilitre": "ml", "milliliters": "ml", "millilitres": "ml", "cl": "cl", "centiliter": "cl", "zentiliter": "cl", "dl": "dl", "deziliter": "dl",
  "deciliter": "dl", "l": "l", "liter": "l", "litre": "l", "liters": "l", "litres": "l", "ltr": "l", "el": "el", "essl": "el", "essloffel": "el",
  "tbsp": "el", "tbs": "el", "tablespoon": "el", "tablespoons": "el", "tbl": "el", "tl": "tl", "teel": "tl", "teeloffel": "tl", "tsp": "tl",
  "teaspoon": "tl", "teaspoons": "tl", "cup": "cup", "cups": "cup", "tasse": "tasse", "tassen": "tasse", "floz": "floz", "fl.oz": "floz",
  "pint": "pint", "pints": "pint", "pt": "pint", "quart": "quart", "quarts": "quart", "qt": "quart", "gallon": "gallon", "gallons": "gallon",
  "gal": "gallon", "msp": "msp", "messerspitze": "msp", "messerspitzen": "msp", "stuck": "piece", "stucke": "piece", "stk": "piece", "st": "piece",
  "piece": "piece", "pieces": "piece", "pc": "piece", "pcs": "piece", "dose": "can", "dosen": "can", "can": "can", "cans": "can", "tin": "can",
  "tins": "can", "bund": "bunch", "bundel": "bunch", "bunch": "bunch", "bunches": "bunch", "zehe": "clove", "zehen": "clove", "clove": "clove",
  "cloves": "clove", "scheibe": "slice", "scheiben": "slice", "slice": "slice", "slices": "slice", "packung": "pack", "packungen": "pack",
  "packchen": "pack", "pck": "pack", "pckg": "pack", "pkg": "pack", "pack": "pack", "packs": "pack", "package": "pack", "packages": "pack",
  "packet": "pack", "paket": "pack", "pakete": "pack", "pkt": "pack", "prise": "pinch", "prisen": "pinch", "pinch": "pinch", "pinches": "pinch",
  "stange": "stalk", "stangen": "stalk", "stangel": "stalk", "stalk": "stalk", "stalks": "stalk", "stick": "stick", "sticks": "stick",
  "zweig": "sprig", "zweige": "sprig", "sprig": "sprig", "sprigs": "sprig", "blatt": "leaf", "blatter": "leaf", "leaf": "leaf", "leaves": "leaf",
  "wurfel": "cube", "cube": "cube", "cubes": "cube", "glas": "other", "glaser": "other", "glass": "other", "jar": "other", "jars": "other",
  "tube": "other", "tuben": "other", "flasche": "other", "flaschen": "other", "bottle": "other", "bottles": "other", "tute": "other",
  "tuten": "other", "beutel": "other", "bag": "other", "bags": "other", "handvoll": "other", "handful": "other", "schuss": "other", "dash": "other",
  "spritzer": "other", "schale": "other", "bowl": "other", "portion": "other", "portionen": "other", "becher": "tub", "tub": "tub", "tubs": "tub",
  "carton": "tub", "knolle": "head", "knollen": "head", "kopf": "head", "kopfe": "head", "head": "head", "heads": "head", "bulb": "head",
  "bulbs": "head",
};

export const MASS: Record<string, number> = {
  "g": 1.0, "mg": 0.001, "kg": 1000.0, "oz": 28.3495, "lb": 453.592, "pfund": 500.0,
};

export const VOLUME: Record<string, [number, boolean]> = {
  "ml": [1.0, false], "cl": [10.0, false], "dl": [100.0, false], "l": [1000.0, false], "el": [15.0, false], "tl": [5.0, false],
  "cup": [240.0, false], "tasse": [250.0, true], "floz": [29.5735, false], "pint": [473.176, false], "quart": [946.353, false],
  "gallon": [3785.41, false], "msp": [0.5, true],
};

export const ITEMS: string[] = [
  "bunch", "can", "clove", "cube", "head", "leaf", "other", "pack", "piece", "pinch", "slice", "sprig", "stalk", "stick", "tub",
];

export const CONTAINERS: string[] = [
  "can", "cube", "other", "pack",
];

export const UNIT_WEIGHTS: Record<string, Record<string, number>> = {
  "can": { "": 400.0 },
  "tub": { "sahne": 200.0, "schlagsahne": 200.0, "cream": 200.0, "schmand": 200.0, "creme fraiche": 150.0, "joghurt": 150.0, "yogurt": 150.0, "yoghurt": 150.0 },
  "clove": { "knoblauch": 4.0, "garlic": 4.0 },
  "pinch": { "": 0.4, "salz": 0.5, "salt": 0.5 },
  "bunch": { "": 50.0, "petersilie": 50.0, "parsley": 50.0, "schnittlauch": 25.0, "chives": 25.0, "dill": 30.0, "basilikum": 30.0, "basil": 30.0, "koriander": 40.0, "cilantro": 40.0, "coriander": 40.0, "minze": 30.0, "mint": 30.0, "fruhlingszwiebel": 100.0, "spring onion": 100.0, "scallion": 100.0, "radieschen": 150.0, "radish": 150.0, "suppengrun": 400.0 },
  "slice": { "brot": 40.0, "bread": 35.0, "toast": 28.0, "kase": 25.0, "cheese": 25.0, "schinken": 20.0, "ham": 20.0, "speck": 15.0, "bacon": 12.0, "salami": 5.0, "tomate": 15.0, "tomato": 15.0, "zitrone": 8.0, "lemon": 8.0, "gurke": 10.0, "cucumber": 10.0, "ananas": 80.0, "pineapple": 80.0 },
  "pack": { "butter": 250.0, "backpulver": 15.0, "baking powder": 15.0, "vanillezucker": 8.0, "vanilla sugar": 8.0, "hefe": 42.0, "yeast": 7.0, "puddingpulver": 37.0, "gelatine": 9.0, "tomatenmark": 70.0 },
  "stick": { "butter": 113.0 },
  "stalk": { "sellerie": 40.0, "celery": 40.0, "lauch": 150.0, "leek": 150.0, "rosenkohl": 400.0, "zitronengras": 20.0, "lemongrass": 20.0 },
  "sprig": { "": 2.0, "thymian": 1.0, "thyme": 1.0, "rosmarin": 3.0, "rosemary": 3.0, "petersilie": 2.0, "parsley": 2.0, "minze": 1.0, "mint": 1.0 },
  "leaf": { "lorbeer": 0.2, "bay": 0.2, "basilikum": 0.3, "basil": 0.3, "gelatine": 2.0, "salbei": 0.5, "sage": 0.5 },
  "cube": { "hefe": 42.0, "yeast": 42.0, "bruhe": 10.0, "stock": 10.0, "bouillon": 10.0, "brühwurfel": 10.0 },
  "head": { "knoblauch": 40.0, "garlic": 40.0, "blumenkohl": 600.0, "cauliflower": 600.0, "brokkoli": 400.0, "broccoli": 400.0, "salat": 300.0, "lettuce": 300.0 },
};

export const PIECES: Record<string, number> = {
  "ei": 55.0, "eier": 55.0, "egg": 55.0, "eggs": 55.0, "eigelb": 18.0, "egg yolk": 18.0, "eiweiss": 33.0, "egg white": 33.0, "zwiebel": 80.0,
  "onion": 80.0, "schalotte": 25.0, "shallot": 25.0, "fruhlingszwiebel": 15.0, "spring onion": 15.0, "scallion": 15.0, "knoblauchzehe": 4.0,
  "garlic clove": 4.0, "karotte": 70.0, "mohre": 70.0, "carrot": 70.0, "kartoffel": 120.0, "potato": 120.0, "susskartoffel": 200.0,
  "sweet potato": 200.0, "tomate": 100.0, "tomato": 100.0, "kirschtomate": 15.0, "cherry tomato": 15.0, "apfel": 180.0, "apple": 180.0,
  "birne": 170.0, "pear": 170.0, "banane": 120.0, "banana": 120.0, "zitrone": 100.0, "lemon": 100.0, "limette": 65.0, "lime": 65.0, "orange": 150.0,
  "paprika": 150.0, "bell pepper": 150.0, "gurke": 350.0, "cucumber": 350.0, "zucchini": 200.0, "aubergine": 300.0, "eggplant": 300.0,
  "avocado": 150.0, "pfirsich": 150.0, "peach": 150.0, "kiwi": 80.0, "champignon": 20.0, "mushroom": 20.0, "chilischote": 15.0, "chili": 15.0,
  "brotchen": 50.0, "roll": 50.0, "mozzarella": 125.0, "rote bete": 100.0, "beetroot": 100.0, "hahnchenbrust": 180.0, "chicken breast": 180.0,
  "lorbeerblatt": 0.2, "bay leaf": 0.2, "kohlrabi": 200.0, "fenchel": 250.0, "fennel": 250.0, "lauch": 150.0, "leek": 150.0, "sellerie": 60.0,
  "celery": 40.0,
};

export const SIZE: Record<string, number> = {
  "klein": 0.7, "kleine": 0.7, "kleiner": 0.7, "kleines": 0.7, "small": 0.7, "mittel": 1.0, "mittelgross": 1.0, "mittelgrosse": 1.0,
  "mittelgrosser": 1.0, "medium": 1.0, "gross": 1.3, "grosse": 1.3, "grosser": 1.3, "grosses": 1.3, "large": 1.3,
};

export const DENSITY: Record<string, number> = {
  "wasser": 1.0, "water": 1.0, "milch": 1.03, "milk": 1.03, "buttermilch": 1.03, "buttermilk": 1.03, "sahne": 1.0, "cream": 1.0, "schlagsahne": 1.0,
  "schmand": 1.0, "joghurt": 1.03, "yogurt": 1.03, "yoghurt": 1.03, "quark": 1.05, "frischkase": 1.0, "cream cheese": 1.0, "ol": 0.92, "oil": 0.92,
  "olivenol": 0.92, "rapsol": 0.92, "sonnenblumenol": 0.92, "essig": 1.01, "vinegar": 1.01, "honig": 1.42, "honey": 1.42, "sirup": 1.35,
  "syrup": 1.35, "ahornsirup": 1.33, "maple syrup": 1.33, "zucker": 0.85, "sugar": 0.85, "puderzucker": 0.56, "powdered sugar": 0.56,
  "icing sugar": 0.56, "brauner zucker": 0.9, "brown sugar": 0.9, "mehl": 0.55, "flour": 0.55, "speisestarke": 0.6, "starch": 0.6, "cornstarch": 0.6,
  "salz": 1.2, "salt": 1.2, "reis": 0.85, "rice": 0.85, "haferflocken": 0.35, "oats": 0.35, "butter": 0.95, "kakao": 0.45, "cocoa": 0.45,
  "backpulver": 0.9, "baking powder": 0.9, "ketchup": 1.1, "tomatenmark": 1.1, "tomato paste": 1.1, "senf": 1.05, "mustard": 1.05, "sojasosse": 1.15,
  "soy sauce": 1.15, "mayonnaise": 0.95, "erdnussbutter": 1.1, "peanut butter": 1.1, "wein": 0.99, "wine": 0.99, "bier": 1.0, "beer": 1.0,
  "bruhe": 1.0, "broth": 1.0, "stock": 1.0, "saft": 1.04, "juice": 1.04, "kokosmilch": 0.97, "coconut milk": 0.97, "rosinen": 0.65, "raisins": 0.65,
  "gemahlene mandeln": 0.4, "ground almonds": 0.4, "parmesan": 0.4, "paniermehl": 0.45, "breadcrumbs": 0.45, "semmelbrosel": 0.45,
};

export const PREP: string[] = [
  "abgespult", "abgetropft", "about", "approx", "approximately", "ca", "chopped", "circa", "coarsely", "cold", "crushed", "cubed", "diced",
  "drained", "entkernt", "entsteint", "etwa", "fein", "finely", "flussig", "fresh", "frisch", "frische", "frischer", "frisches", "gehackt",
  "gehackte", "gehackter", "gehacktes", "gemahlen", "gemahlene", "gepresst", "gepresste", "gerieben", "geriebene", "geriebener", "geschalt",
  "geschalte", "geschmolzen", "geschnitten", "geschnittene", "gesiebt", "gesiebte", "gewaschen", "gewurfelt", "gewurfelte", "gezupft", "grated",
  "grob", "halved", "kalt", "kalte", "lauwarm", "lauwarme", "melted", "minced", "optional", "peeled", "rinsed", "room", "roughly", "shredded",
  "sifted", "sliced", "softened", "temperature", "trimmed", "ungefahr", "warm", "warme", "weich", "weiche", "zerdruckt", "zerkleinert", "zimmerwarm",
  "zimmerwarme",
];

export const ADJECTIVES: string[] = [
  "big", "bio", "black", "dark", "dick", "dicke", "dry", "dunn", "dunne", "extra", "festkochend", "festkochende", "fresh", "frisch", "frische",
  "ganz", "ganze", "gelb", "gelbe", "gelben", "gelber", "green", "groß", "große", "großen", "großer", "grun", "grune", "grunen", "gruner", "halb",
  "halbe", "half", "klein", "kleine", "kleinen", "kleiner", "large", "lean", "light", "medium", "mehligkochend", "mehligkochende", "mittelgroß",
  "mittelgroße", "natural", "organic", "plain", "red", "reif", "reife", "reifen", "reifer", "ripe", "rot", "rote", "roten", "roter", "rotes",
  "salted", "sauerlich", "sauerliche", "schwarz", "schwarze", "schwarzer", "small", "suß", "suße", "sweet", "thick", "thin", "unsalted", "virgin",
  "weiß", "weiße", "weißer", "white", "whole", "yellow",
];

export const STOP: string[] = [
  "an", "and", "art", "aus", "ca", "circa", "das", "der", "die", "etwa", "extra", "for", "fur", "in", "mit", "nach", "oder", "of", "ohne", "or",
  "sorte", "the", "typ", "type", "und", "vom", "von", "with", "without",
];

export const MODIFIERS: string[] = [
  "about", "approx", "approx.", "approximately", "ca", "ca.", "circa", "etwa", "geh", "geh.", "gehauft", "gehaufte", "gehaufter", "gehauftes",
  "gestr", "gestr.", "gestrichen", "gestrichene", "gestrichener", "gestrichenes", "heaped", "level", "rounded", "rund", "scant",
];

export const VULGAR: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6", "⅚": "5/6", "⅐": "1/7",
  "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅑": "1/9", "⅒": "1/10",
};

export const WORD_NUMBERS: Record<string, number> = {
  "ein": 1, "eine": 1, "einen": 1, "einem": 1, "einer": 1, "eines": 1, "one": 1, "a": 1, "an": 1, "zwei": 2, "two": 2, "drei": 3, "three": 3,
  "vier": 4, "four": 4, "funf": 5, "five": 5, "sechs": 6, "six": 6, "sieben": 7, "seven": 7, "acht": 8, "eight": 8, "neun": 9, "nine": 9, "zehn": 10,
  "ten": 10, "elf": 11, "zwolf": 12, "twelve": 12, "halb": 0.5, "halbe": 0.5, "halber": 0.5, "halbes": 0.5, "half": 0.5,
};

export const CITRUS: Record<string, [number, number, string, string]> = {
  "zitrone": [45.0, 6.0, "Zitronensaft", "Zitronenschale"], "lemon": [45.0, 6.0, "Zitronensaft", "Zitronenschale"],
  "limette": [30.0, 4.0, "Limettensaft", "Limettenschale"], "lime": [30.0, 4.0, "Limettensaft", "Limettenschale"],
  "orange": [80.0, 8.0, "Orangensaft", "Orangenschale"], "grapefruit": [100.0, 10.0, "Grapefruitsaft", "Grapefruitschale"],
};

export const USUAL_KEYS: Record<string, string> = {
  "mehl": "Weizen Mehl Type 405", "weizenmehl": "Weizen Mehl Type 405", "flour": "Weizen Mehl Type 405", "wheat flour": "Weizen Mehl Type 405",
  "plain flour": "Weizen Mehl Type 405", "all-purpose flour": "Weizen Mehl Type 405", "all purpose flour": "Weizen Mehl Type 405",
  "vollkornmehl": "Weizen Vollkornmehl", "wholemeal flour": "Weizen Vollkornmehl", "whole wheat flour": "Weizen Vollkornmehl",
  "dinkelmehl": "Dinkel Mehl Type 630", "spelt flour": "Dinkel Mehl Type 630", "roggenmehl": "Roggen Mehl Type 1150",
  "rye flour": "Roggen Mehl Type 1150", "ei": "Hühnerei roh", "eier": "Hühnerei roh", "egg": "Hühnerei roh", "eggs": "Hühnerei roh",
  "huhnerei": "Hühnerei roh", "eigelb": "Hühnerei Eigelb roh", "egg yolk": "Hühnerei Eigelb roh", "egg yolks": "Hühnerei Eigelb roh",
  "eiweiss": "Hühnerei Eiklar roh", "eiklar": "Hühnerei Eiklar roh", "egg white": "Hühnerei Eiklar roh", "egg whites": "Hühnerei Eiklar roh",
  "zucker": "Zucker weiß", "sugar": "Zucker weiß", "haushaltszucker": "Zucker weiß", "kristallzucker": "Zucker weiß", "feinzucker": "Zucker weiß",
  "granulated sugar": "Zucker weiß", "white sugar": "Zucker weiß", "caster sugar": "Zucker weiß", "puderzucker": "Puderzucker",
  "staubzucker": "Puderzucker", "icing sugar": "Puderzucker", "powdered sugar": "Puderzucker", "confectioners sugar": "Puderzucker",
  "brauner zucker": "Zucker braun", "rohrzucker": "Zucker braun", "brown sugar": "Zucker braun", "vanillezucker": "Vanillinzucker",
  "vanillinzucker": "Vanillinzucker", "vanilla sugar": "Vanillinzucker", "salz": "Speisesalz", "salt": "Speisesalz", "speisesalz": "Speisesalz",
  "kochsalz": "Speisesalz", "tafelsalz": "Speisesalz", "table salt": "Speisesalz", "meersalz": "Meersalz", "sea salt": "Meersalz",
  "pfeffer": "Pfeffer schwarz", "pepper": "Pfeffer schwarz", "black pepper": "Pfeffer schwarz", "schwarzer pfeffer": "Pfeffer schwarz",
  "butter": "Butter mild gesäuert", "margarine": "Margarine", "sahne": "Schlagsahne 30", "schlagsahne": "Schlagsahne 30", "cream": "Schlagsahne 30",
  "heavy cream": "Schlagsahne 30", "whipping cream": "Schlagsahne 30", "double cream": "Schlagsahne 30", "kochsahne": "Schlagsahne 30",
  "saure sahne": "Sauerrahm 10", "sauerrahm": "Sauerrahm 10", "sour cream": "Sauerrahm 10", "schmand": "Sauerrahm Creme fraiche 30",
  "creme fraiche": "Sauerrahm Creme fraiche 30", "cream fraiche": "Sauerrahm Creme fraiche 30", "milch": "Vollmilch frisch",
  "milk": "Vollmilch frisch", "vollmilch": "Vollmilch frisch", "whole milk": "Vollmilch frisch", "fettarme milch": "Milch fettarm frisch",
  "low fat milk": "Milch fettarm frisch", "buttermilch": "Buttermilch", "buttermilk": "Buttermilch", "joghurt": "Joghurt mild",
  "yogurt": "Joghurt mild", "yoghurt": "Joghurt mild", "naturjoghurt": "Joghurt mild", "plain yogurt": "Joghurt mild",
  "fruchtjoghurt": "Joghurt mild Fruchtzubereitung", "fruit yogurt": "Joghurt mild Fruchtzubereitung",
  "fruit yoghurt": "Joghurt mild Fruchtzubereitung", "quark": "Speisequark Magerstufe", "magerquark": "Speisequark Magerstufe",
  "speisequark": "Speisequark Magerstufe", "quark cheese": "Speisequark Magerstufe", "frischkase": "Frischkäse", "cream cheese": "Frischkäse",
  "huttenkase": "Hüttenkäse", "cottage cheese": "Hüttenkäse", "olivenol": "Olivenöl", "olive oil": "Olivenöl", "extra virgin olive oil": "Olivenöl",
  "ol": "Rapsöl", "oil": "Rapsöl", "pflanzenol": "Rapsöl", "vegetable oil": "Rapsöl", "rapsol": "Rapsöl", "canola oil": "Rapsöl",
  "sonnenblumenol": "Sonnenblumenöl", "sunflower oil": "Sonnenblumenöl", "kokosol": "Kokosöl", "coconut oil": "Kokosöl", "essig": "Weinessig",
  "vinegar": "Weinessig", "weinessig": "Weinessig", "wine vinegar": "Weinessig", "balsamico": "Balsamicoessig", "balsamicoessig": "Balsamicoessig",
  "balsamic vinegar": "Balsamicoessig", "apfelessig": "Apfelessig", "apple cider vinegar": "Apfelessig", "senf": "Senf mittelscharf",
  "mustard": "Senf mittelscharf", "ketchup": "Tomatenketchup", "tomatenmark": "Tomatenmark", "tomato paste": "Tomatenmark",
  "tomato puree": "Tomatenmark", "sojasauce": "Sojasauce", "sojasosse": "Sojasauce", "soy sauce": "Sojasauce", "mayonnaise": "Mayonnaise",
  "mayo": "Mayonnaise", "honig": "Honig", "honey": "Honig", "ahornsirup": "Ahornsirup", "maple syrup": "Ahornsirup", "backpulver": "Backpulver",
  "baking powder": "Backpulver", "natron": "Natron", "backnatron": "Natron", "baking soda": "Natron", "bicarbonate of soda": "Natron",
  "hefe": "Backhefe frisch", "backhefe": "Backhefe frisch", "yeast": "Backhefe frisch", "trockenhefe": "Backhefe frisch",
  "frischhefe": "Backhefe frisch", "dry yeast": "Backhefe frisch", "speisestarke": "Mais Stärke", "starch": "Mais Stärke",
  "cornstarch": "Mais Stärke", "corn starch": "Mais Stärke", "maisstarke": "Mais Stärke", "gelatine": "Gelatine",
  "kakao": "Kakaopulver schwach entölt", "kakaopulver": "Kakaopulver schwach entölt", "cocoa": "Kakaopulver schwach entölt",
  "cocoa powder": "Kakaopulver schwach entölt", "schokolade": "Schokolade Zartbitter", "chocolate": "Schokolade Zartbitter",
  "zartbitterschokolade": "Schokolade Zartbitter", "dark chocolate": "Schokolade Zartbitter", "haferflocken": "Haferflocken", "oats": "Haferflocken",
  "rolled oats": "Haferflocken", "oatmeal": "Haferflocken", "reis": "Reis poliert roh", "rice": "Reis poliert roh",
  "basmatireis": "Reis poliert roh", "jasminreis": "Reis poliert roh", "long grain rice": "Reis poliert roh", "white rice": "Reis poliert roh",
  "weisser reis": "Reis poliert roh", "vollkornreis": "Reis unpoliert roh", "naturreis": "Reis unpoliert roh", "brown rice": "Reis unpoliert roh",
  "wholegrain rice": "Reis unpoliert roh", "wildreis": "Wildreis roh", "wild rice": "Wildreis roh", "nudeln": "Teigwaren eifrei roh",
  "pasta": "Teigwaren eifrei roh", "spaghetti": "Teigwaren eifrei roh", "penne": "Teigwaren eifrei roh", "fusilli": "Teigwaren eifrei roh",
  "macaroni": "Teigwaren eifrei roh", "noodles": "Teigwaren eifrei roh", "brot": "Weizenmischbrot", "bread": "Weizenmischbrot",
  "brotchen": "Weizenbrötchen", "bread roll": "Weizenbrötchen", "roll": "Weizenbrötchen", "paniermehl": "Paniermehl", "semmelbrosel": "Paniermehl",
  "breadcrumbs": "Paniermehl", "bruhe": "Gemüse Bouillon", "bouillon": "Gemüse Bouillon", "stock": "Gemüse Bouillon", "broth": "Gemüse Bouillon",
  "gemusebruhe": "Gemüse Bouillon", "vegetable stock": "Gemüse Bouillon", "vegetable broth": "Gemüse Bouillon", "huhnerbruhe": "Gemüse Bouillon",
  "chicken stock": "Gemüse Bouillon", "zwiebel": "Speisezwiebel roh", "onion": "Speisezwiebel roh", "speisezwiebel": "Speisezwiebel roh",
  "gemusezwiebel": "Speisezwiebel roh", "yellow onion": "Speisezwiebel roh", "red onion": "Speisezwiebel roh", "rote zwiebel": "Speisezwiebel roh",
  "fruhlingszwiebel": "Frühlingszwiebel roh", "lauchzwiebel": "Frühlingszwiebel roh", "spring onion": "Frühlingszwiebel roh",
  "scallion": "Frühlingszwiebel roh", "green onion": "Frühlingszwiebel roh", "schalotte": "Schalotte roh", "shallot": "Schalotte roh",
  "knoblauch": "Knoblauch roh", "knoblauchzehe": "Knoblauch roh", "garlic": "Knoblauch roh", "garlic clove": "Knoblauch roh",
  "karotte": "Karotte Möhre roh", "mohre": "Karotte Möhre roh", "mohren": "Karotte Möhre roh", "carrot": "Karotte Möhre roh",
  "karotten": "Karotte Möhre roh", "kartoffel": "Kartoffel geschält roh", "potato": "Kartoffel geschält roh", "potatoes": "Kartoffel geschält roh",
  "kartoffeln": "Kartoffel geschält roh", "kartoffelpuree": "Kartoffelpüree", "kartoffelbrei": "Kartoffelpüree", "mashed potatoes": "Kartoffelpüree",
  "mashed potato": "Kartoffelpüree", "bratkartoffeln": "Bratkartoffeln", "fried potatoes": "Bratkartoffeln", "pommes": "Pommes frites",
  "pommes frites": "Pommes frites", "french fries": "Pommes frites", "fries": "Pommes frites", "chips potato": "Pommes frites",
  "susskartoffel": "Batate Süßkartoffel roh", "sweet potato": "Batate Süßkartoffel roh", "tomate": "Tomate roh", "tomato": "Tomate roh",
  "tomatoes": "Tomate roh", "tomaten": "Tomate roh", "kirschtomate": "Tomate roh", "cherry tomato": "Tomate roh", "paprika": "Paprika",
  "bell pepper": "Paprika", "pepper pod": "Paprika", "red pepper": "Paprika", "gurke": "Gurke roh", "salatgurke": "Gurke roh",
  "cucumber": "Gurke roh", "zucchini": "Zucchini roh", "courgette": "Zucchini roh", "aubergine": "Aubergine roh", "eggplant": "Aubergine roh",
  "spinat": "Spinat roh", "spinach": "Spinat roh", "spargel": "Spargel roh", "asparagus": "Spargel roh", "gruner spargel": "Spargel roh",
  "green asparagus": "Spargel roh", "weisser spargel": "Spargel roh", "brokkoli": "Broccoli roh", "broccoli": "Broccoli roh",
  "blumenkohl": "Blumenkohl roh", "cauliflower": "Blumenkohl roh", "lauch": "Porree Lauch roh", "porree": "Porree Lauch roh",
  "leek": "Porree Lauch roh", "sellerie": "Bleichsellerie roh", "celery": "Bleichsellerie roh", "stangensellerie": "Bleichsellerie roh",
  "champignon": "Champignon roh", "champignons": "Champignon roh", "pilze": "Champignon roh", "mushroom": "Champignon roh",
  "mushrooms": "Champignon roh", "mais": "Zuckermais roh", "corn": "Zuckermais roh", "sweetcorn": "Zuckermais roh", "erbsen": "Erbse roh",
  "peas": "Erbse roh", "kichererbsen": "Kichererbse", "chickpeas": "Kichererbse", "linsen": "Linse reif", "lentils": "Linse reif",
  "braune linsen": "Linse reif", "brown lentils": "Linse reif", "rote linsen": "Linse rot reif", "red lentils": "Linse rot reif",
  "grune bohnen": "Bohne grün roh", "green beans": "Bohne grün roh", "brechbohnen": "Bohne grün roh", "stangenbohnen": "Bohne grün roh",
  "grune bohne": "Bohne grün roh", "green bean": "Bohne grün roh", "kurbis": "Kürbis roh", "pumpkin": "Kürbis roh", "squash": "Kürbis roh",
  "rote bete": "Rote Rübe Rote Bete roh", "rote rube": "Rote Rübe Rote Bete roh", "beetroot": "Rote Rübe Rote Bete roh",
  "beet": "Rote Rübe Rote Bete roh", "kohlrabi": "Kohlrabi roh", "fenchel": "Gemüsefenchel roh", "fennel": "Gemüsefenchel roh",
  "rotkohl": "Rotkohl roh", "red cabbage": "Rotkohl roh", "weisskohl": "Weißkohl roh", "white cabbage": "Weißkohl roh", "kohl": "Weißkohl roh",
  "cabbage": "Weißkohl roh", "salat": "Kopfsalat roh", "kopfsalat": "Kopfsalat roh", "lettuce": "Kopfsalat roh", "eisbergsalat": "Eisbergsalat roh",
  "iceberg lettuce": "Eisbergsalat roh", "rucola": "Rucola roh", "rocket": "Rucola roh", "arugula": "Rucola roh", "radieschen": "Radieschen roh",
  "radish": "Radieschen roh", "avocado": "Avocado roh", "apfel": "Apfel roh", "apple": "Apfel roh", "aepfel": "Apfel roh", "birne": "Birne roh",
  "pear": "Birne roh", "banane": "Banane roh", "banana": "Banane roh", "zitrone": "Zitrone roh", "lemon": "Zitrone roh",
  "zitronenschale": "Zitrone roh", "lemon zest": "Zitrone roh", "zitronensaft": "Zitronensaft", "lemon juice": "Zitronensaft",
  "orange": "Orange roh", "orangensaft": "Orangensaft", "orange juice": "Orangensaft", "limette": "Limette roh", "lime": "Limette roh",
  "ananas": "Ananas roh", "pineapple": "Ananas roh", "erdbeere": "Erdbeere roh", "erdbeeren": "Erdbeere roh", "strawberry": "Erdbeere roh",
  "strawberries": "Erdbeere roh", "blaubeeren": "Heidelbeere roh", "heidelbeeren": "Heidelbeere roh", "blueberry": "Heidelbeere roh",
  "blueberries": "Heidelbeere roh", "himbeeren": "Himbeere roh", "raspberry": "Himbeere roh", "raspberries": "Himbeere roh",
  "weintrauben": "Weintraube roh", "trauben": "Weintraube roh", "grapes": "Weintraube roh", "pfirsich": "Pfirsich roh", "peach": "Pfirsich roh",
  "mango": "Mango roh", "kiwi": "Kiwi roh", "rosinen": "Rosinen", "raisins": "Rosinen", "datteln": "Datteln", "dates": "Datteln",
  "mandeln": "Mandel süß", "almonds": "Mandel süß", "almond": "Mandel süß", "mandel": "Mandel süß", "gemahlene mandeln": "Mandel gemahlen",
  "ground almonds": "Mandel gemahlen", "walnusse": "Walnuss", "walnuss": "Walnuss", "walnuts": "Walnuss", "walnut": "Walnuss",
  "haselnusse": "Haselnuss", "haselnuss": "Haselnuss", "hazelnuts": "Haselnuss", "erdnusse": "Erdnuss", "erdnuss": "Erdnuss", "peanuts": "Erdnuss",
  "cashews": "Cashewkern", "cashewkerne": "Cashewkern", "cashew": "Cashewkern", "sesam": "Sesam", "sesame": "Sesam",
  "sonnenblumenkerne": "Sonnenblumenkerne", "sunflower seeds": "Sonnenblumenkerne", "leinsamen": "Leinsamen", "flaxseed": "Leinsamen",
  "flax seeds": "Leinsamen", "kokosraspeln": "Kokosnuss getrocknet", "desiccated coconut": "Kokosnuss getrocknet",
  "shredded coconut": "Kokosnuss getrocknet", "kokosmilch": "Kokosmilch", "coconut milk": "Kokosmilch", "petersilie": "Petersilienblatt roh",
  "parsley": "Petersilienblatt roh", "basilikum": "Basilikum roh", "basil": "Basilikum roh", "schnittlauch": "Schnittlauch roh",
  "chives": "Schnittlauch roh", "dill": "Dill", "thymian": "Thymian", "thyme": "Thymian", "rosmarin": "Rosmarin", "rosemary": "Rosmarin",
  "oregano": "Oregano", "koriander": "Koriander", "cilantro": "Koriander", "coriander": "Koriander", "minze": "Minze", "mint": "Minze",
  "ingwer": "Ingwer roh", "ginger": "Ingwer roh", "zimt": "Zimt", "cinnamon": "Zimt", "paprikapulver": "Paprika Gewürz",
  "paprika powder": "Paprika Gewürz", "curry": "Curry", "curry powder": "Curry", "currypulver": "Curry", "muskat": "Muskat", "muskatnuss": "Muskat",
  "nutmeg": "Muskat", "kreuzkummel": "Kreuzkümmel", "cumin": "Kreuzkümmel", "chili": "Chili", "chilli": "Chili", "peperoni": "Chili",
  "chilischote": "Chili", "vanille": "Vanille", "vanilla": "Vanille", "hackfleisch": "Rind Schwein Hackfleisch gemischt roh",
  "mince": "Rind Schwein Hackfleisch gemischt roh", "minced meat": "Rind Schwein Hackfleisch gemischt roh",
  "gehacktes": "Rind Schwein Hackfleisch gemischt roh", "gemischtes hackfleisch": "Rind Schwein Hackfleisch gemischt roh",
  "ground meat": "Rind Schwein Hackfleisch gemischt roh", "rinderhack": "Rind Hackfleisch roh", "rinderhackfleisch": "Rind Hackfleisch roh",
  "beef mince": "Rind Hackfleisch roh", "ground beef": "Rind Hackfleisch roh", "minced beef": "Rind Hackfleisch roh",
  "schweinehack": "Schwein Hackfleisch roh", "schweinehackfleisch": "Schwein Hackfleisch roh", "pork mince": "Schwein Hackfleisch roh",
  "hahnchenbrust": "Hähnchen Brustfilet roh", "hahnchenbrustfilet": "Hähnchen Brustfilet roh", "hahnchen": "Hähnchen Brustfilet roh",
  "chicken breast": "Hähnchen Brustfilet roh", "chicken": "Hähnchen Brustfilet roh", "huhn": "Hähnchen Brustfilet roh",
  "huhnerbrust": "Hähnchen Brustfilet roh", "putenbrust": "Pute Brust roh", "turkey breast": "Pute Brust roh", "pute": "Pute Brust roh",
  "turkey": "Pute Brust roh", "rindfleisch": "Rind Steak Rücken roh", "beef": "Rind Steak Rücken roh", "steak": "Rind Steak Rücken roh",
  "rindersteak": "Rind Steak Rücken roh", "beef steak": "Rind Steak Rücken roh", "rumpsteak": "Rind Steak Rücken roh",
  "sirloin": "Rind Steak Rücken roh", "schweinefleisch": "Schwein Kotelett roh", "pork": "Schwein Kotelett roh",
  "schweinekotelett": "Schwein Kotelett roh", "pork chop": "Schwein Kotelett roh", "kotelett": "Schwein Kotelett roh",
  "schnitzel": "Schwein Schnitzel roh", "schweineschnitzel": "Schwein Schnitzel roh", "pork cutlet": "Schwein Schnitzel roh",
  "cutlet": "Schwein Schnitzel roh", "lachs": "Lachs roh", "salmon": "Lachs roh", "lachsfilet": "Lachs roh", "thunfisch": "Thunfisch",
  "tuna": "Thunfisch", "schinken": "Schinken", "ham": "Schinken", "speck": "Speck", "bacon": "Speck", "wurst": "Bratwurst", "sausage": "Bratwurst",
  "tofu": "Tofu", "gouda": "Gouda 40", "edamer": "Edamer 40", "parmesan": "Parmesan", "mozzarella": "Mozzarella", "feta": "Feta",
  "schafskase": "Feta", "cheddar": "Cheddar", "emmentaler": "Emmentaler", "kase": "Gouda 40", "cheese": "Gouda 40", "reibekase": "Gouda 40",
  "geriebener kase": "Gouda 40", "grated cheese": "Gouda 40", "wasser": "Trinkwasser", "water": "Trinkwasser", "leitungswasser": "Trinkwasser",
  "wein": "Weißwein trocken", "wine": "Weißwein trocken", "weisswein": "Weißwein trocken", "white wine": "Weißwein trocken", "rotwein": "Rotwein",
  "red wine": "Rotwein", "bier": "Bier", "beer": "Bier",
};

export const TAILS: string[] = [
  "schoten", "schote", "roschen", "filets", "filet", "scheiben", "stucke", "wurfel", "streifen", "blatter", "zehen", "zehe", "spitzen", "kerne",
  "halften",
];

export const PREPARED: string[] = [
  "auflauf", "aufstrich", "baked", "boil", "boiled", "braised", "breaded", "brei", "brotaufstrich", "cake", "canned", "cooked", "cream", "creme",
  "dip", "dried", "eingelegt", "eintopf", "fertigprodukt", "filled", "filling", "fried", "frittiert", "frozen", "fullung", "gargezogen", "gebacken",
  "gebraten", "gedampft", "gedunstet", "gefroren", "gefullt", "gegrillt", "gekocht", "gepokelt", "gerauchert", "gesalzen", "geschmort", "gesußt",
  "getrocknet", "gezuckert", "gratinated", "gratiniert", "grilled", "in", "konserve", "kuchen", "marinade", "mit", "pan", "paniert", "pickled",
  "poached", "pochiert", "powder", "pulver", "puree", "purierte", "roast", "roasted", "salad", "salat", "salted", "sauce", "sauteed", "smoked",
  "sosse", "soup", "soße", "spread", "steamed", "stewed", "sugared", "suppe", "sweetened", "tiefgefroren", "tinned", "torte", "uberbacken", "with",
];

/** Groups of words that say the same about the preparation of a food. */
export const SAME_WORDS: string[][] = [
  ["boil", "boiled", "cooked", "gekocht"],
  ["fried", "gebraten", "pan", "sauteed"],
  ["baked", "gebacken", "gebraten", "gegrillt", "geschmort", "grilled", "roast", "roasted", "uberbacken"],
  ["gedampft", "gedunstet", "gekocht", "steamed", "stewed"],
  ["braised", "gedunstet", "geschmort", "stewed"],
  ["puree"],
  ["poached", "pochiert"],
  ["dried", "getrocknet"],
  ["deep", "frozen", "gefroren", "tiefgefroren"],
  ["canned", "konserve", "tinned"],
  ["gerauchert", "smoked"],
  ["deep", "fried", "frittiert"],
  ["breaded", "paniert"],
];

export const DISH_WORDS: string[] = [
  "auflauf", "burger", "cake", "eintopf", "kuchen", "pie", "pizza", "salad", "salat", "sauce", "sosse", "soup", "soße", "stew", "suppe", "torte",
];

export const COLOURS: string[] = [
  "grun", "rot", "weiß", "schwarz", "gelb", "braun", "blau", "green", "red", "white", "black", "yellow", "brown", "blue",
];


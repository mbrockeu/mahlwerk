"""Calculating from an ingredient list: the line parser (German and English), the weights, the matching of foods and the route."""

import csv
import time

import pytest

from mahlwerk import demo_account, ingredients
from mahlwerk.catalog import import_bls
from mahlwerk.ingredients import parse_line, parse_number, parse_text

POST = "/api/v1/recipes/ingredients/match"


def parsed(text):
    line = parse_line(text)
    assert line is not None, text
    return line


# --- numbers -------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("text,value", [
    ("200", 200), ("1,5", 1.5), ("1.5", 1.5), ("0.25", 0.25), ("0,125", 0.125), (".5", 0.5), ("1/2", 0.5), ("1 1/2", 1.5), ("3/4", 0.75),
    ("1.500", 1500), ("1,000", 1000), ("1.234,5", 1234.5), ("1,234.5", 1234.5), ("1.234.567", 1234567),
])
def test_numbers(text, value):
    assert parse_number(text) == pytest.approx(value)


def test_nonsense_numbers():
    assert parse_number("1/0") is None
    assert parse_number("") is None


# --- one line ------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("text,quantity,unit,name", [
    ("200 g Mehl", 200, "g", "Mehl"),
    ("200g Zucker", 200, "g", "Zucker"),
    ("1,5 kg Kartoffeln", 1.5, "kg", "Kartoffeln"),
    ("1 EL Olivenöl", 1, "EL", "Olivenöl"),
    ("2 tbsp. olive oil", 2, "tbsp.", "olive oil"),
    ("2 cups flour", 2, "cups", "flour"),
    ("1 1/2 TL Zimt", 1.5, "TL", "Zimt"),
    ("1½ cups sugar", 1.5, "cups", "sugar"),
    ("½ Bund Petersilie", 0.5, "Bund", "Petersilie"),
    ("⅓ cup milk", 1 / 3, "cup", "milk"),
    ("2-3 Zwiebeln", 2.5, None, "Zwiebeln"),
    ("2 – 3 EL Öl", 2.5, "EL", "Öl"),
    ("1 bis 2 Zehen Knoblauch", 1.5, "Zehen", "Knoblauch"),
    ("2 Eier", 2, None, "Eier"),
    ("ca. 200 g Butter", 200, "g", "Butter"),
    ("- 100 g Butter", 100, "g", "Butter"),
    ("• 100 g Butter", 100, "g", "Butter"),
    ("☐ 1 Prise Salz", 1, "Prise", "Salz"),
    ("1 Prise Salz", 1, "Prise", "Salz"),
    ("a pinch of salt", 1, "pinch", "salt"),
    ("eine Prise Salz", 1, "Prise", "Salz"),
    ("ein Bund Schnittlauch", 1, "Bund", "Schnittlauch"),
    ("eine halbe Zitrone", 0.5, None, "Zitrone"),
    ("1 cup of flour", 1, "cup", "flour"),
    ("2 EL von der Butter", 2, "EL", "der Butter"),
    ("1 gestr. TL Backpulver", 1, "TL", "Backpulver"),
    ("1 heaped tbsp honey", 1, "tbsp", "honey"),
    ("1 Stück Ingwer", 1, "Stück", "Ingwer"),
    ("Mehl 200 g", 200, "g", "Mehl"),
    ("Butter oder Margarine 100 g", 100, "g", "Butter"),
    ("1 l Milch", 1, "l", "Milch"),
    ("500 ml Brühe", 500, "ml", "Brühe"),
])
def test_quantity_unit_and_name(text, quantity, unit, name):
    line = parsed(text)
    assert line.quantity == pytest.approx(quantity)
    assert line.unit == unit
    assert line.name == name


def test_note_and_optional():
    line = parsed("2 Zwiebeln, fein gehackt")
    assert line.name == "Zwiebeln" and line.note == "fein gehackt"
    line = parsed("1 EL Honig (optional)")
    assert line.optional and line.note == "optional" and line.name == "Honig"
    line = parsed("200 g gehackte Tomaten")
    assert line.name == "Tomaten" and line.note == "gehackte"
    line = parsed("1 Bund Petersilie, nach Geschmack")
    assert line.optional and line.note == "nach Geschmack"
    assert parsed("3 cloves garlic (minced)").note == "minced"


def test_a_line_without_amount_keeps_the_name_and_no_grams():
    line = parsed("Salz")
    assert (line.quantity, line.unit, line.name, line.grams, line.basis) == (None, None, "Salz", None, "none")
    line = parsed("Pfeffer, nach Geschmack")
    assert line.grams is None and line.optional


@pytest.mark.parametrize("text", ["", "   ", "---", "•", "Für den Teig:", "Sauce:", "***", "()"])
def test_lines_that_hold_nothing(text):
    assert parse_line(text) is None


# --- grams ---------------------------------------------------------------------------------------------------------------


def grams(text):
    line = parsed(text)
    return line.grams, line.estimated, line.basis


def test_mass_is_exact():
    assert grams("200 g Mehl") == (200, False, "mass")
    assert grams("1,5 kg Kartoffeln") == (1500, False, "mass")
    assert grams("500 mg Salz") == (0.5, False, "mass")
    assert grams("4 oz butter") == (113.4, False, "mass")
    assert grams("1 lb ground beef") == (453.6, False, "mass")
    assert grams("1 Pfund Mehl") == (500, False, "mass")


def test_volume_with_a_known_density_is_not_estimated():
    assert grams("250 ml Milch") == (257.5, False, "volume")
    assert grams("1 EL Olivenöl") == (13.8, False, "volume")
    assert grams("1/2 l Wasser") == (500, False, "volume")
    assert grams("2 cups flour") == (264, False, "volume")
    assert parsed("2 cups flour").ml == 480
    assert grams("1 TL Salz")[0] == 6
    assert grams("1 EL Puderzucker")[0] == pytest.approx(8.4)  # the longer key wins over 'zucker'


def test_volume_of_an_unknown_food_is_assumed_to_weigh_like_water_and_marked():
    assert grams("1 EL Zimt") == (15, True, "volume")
    assert grams("1 Tasse Reis") == (212.5, True, "volume")  # a cup of unknown size


def test_pieces_are_estimated():
    assert grams("2 Eier") == (110, True, "piece")
    assert grams("1 Zwiebel") == (80, True, "piece")
    assert grams("1 große Zwiebel") == (104, True, "piece")
    assert grams("1 kleine Zwiebel") == (56, True, "piece")
    assert grams("3 Knoblauchzehen") == (12, True, "piece")
    assert grams("2 Zehen Knoblauch") == (8, True, "unit")
    assert grams("1 Stück Zitrone") == (100, True, "piece")
    assert grams("eine halbe Zitrone") == (50, True, "piece")
    assert grams("1 egg yolk")[0] == 18
    assert grams("2 apples") == (360, True, "piece")
    assert grams("3 Karotten")[0] == 210
    assert grams("1 Frühlingszwiebel")[0] == 15  # not the onion
    assert grams("1 Prise Salz") == (0.5, True, "unit")
    assert grams("½ Bund Petersilie") == (25, True, "unit")
    assert grams("5 Scheiben Brot") == (200, True, "unit")
    assert grams("1 stick butter") == (113, True, "unit")


def test_unknown_counts_have_no_grams():
    assert grams("2 Schnitzel") == (None, False, "none")
    assert grams("3 Päckchen Irgendwas") == (None, False, "none")
    assert grams("1 Bund Radieschen")[0] == 150
    assert grams("200 Mehl") == (None, False, "none")  # a number without unit is no weight


def test_a_weight_in_brackets_wins():
    assert grams("1 Dose Tomaten (400 g)") == (400, False, "explicit")
    assert grams("2 Dosen Tomaten (je 400 g)") == (800, False, "explicit")
    assert grams("1 (14 oz) can tomatoes") == (396.9, False, "explicit")
    assert grams("2 Eier (je 60 g)") == (120, False, "explicit")
    assert grams("2 Dosen Tomaten (400 g)") == (800, False, "explicit")  # cans and packs: the brackets name one
    assert grams("2 große Kartoffeln (ca. 500 g)") == (500, False, "explicit")  # a counted food: the brackets name the total
    assert grams("2 Eier (60 g)") == (60, False, "explicit")
    assert grams("1 Stück Ingwer (ca. 20 g)") == (20, False, "explicit")
    assert grams("1 lb (450 g) butter") == (450, False, "explicit")  # a total next to a mass
    assert grams("2 x 200 g Mehl") == (400, False, "explicit")
    assert grams("1 Dose Mais (Abtropfgewicht 285 g)") == (285, False, "explicit")
    line = parsed("1 Packung Butter (250 g)")
    assert line.grams == 250 and line.name == "Butter"
    assert grams("1 Becher Sahne (200 ml)") == (200, False, "explicit")


def test_containers_without_a_known_weight_have_no_grams():
    assert grams("1 Glas Gurken") == (None, False, "none")  # not the weight of a cucumber
    assert grams("1 handful spinach") == (None, False, "none")
    assert parsed("1 Glas Gurken").name == "Gurken"


def test_a_can_without_weight_is_estimated():
    assert grams("1 Dose Tomaten") == (400, True, "unit")


def test_ranges_and_fractions_in_weights():
    assert grams("2-3 Zwiebeln")[0] == 200
    assert grams("1/2 Zwiebel")[0] == 40
    assert grams("1 1/2 cups milk")[0] == 370.8


# --- rubbish and limits --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("text", [
    "99999999999 g Mehl", "0 g Mehl", "1/0 EL Öl", "-5 g Mehl", "1e5 g Mehl", "∞", "<script>alert(1)</script>", "'; DROP TABLE food; --",
    "1 " + "x" * 5000, "(" * 300, "))))((((", "\x00\x01 2 EL Öl", "٣ g Mehl", "２００ｇ Ｍｅｈｌ", "🙂 200 g Mehl 🙂",
])
def test_rubbish_does_not_break_the_parser(text):
    line = parse_line(text)
    if line is not None:
        assert line.grams is None or 0 < line.grams <= ingredients.MAX_GRAMS
        assert len(line.name) <= 200


def test_unicode_and_odd_spaces():
    assert grams("２００ｇ Ｍｅｈｌ")[0] == 200  # full width
    assert grams("200 g Mehl")[0] == 200  # no-break and thin space
    assert grams("1​ EL Honig")[0] == pytest.approx(21.3)  # zero width space
    line = parsed("200 g Äpfel (säuerlich)")
    assert line.name == "Äpfel" and line.note == "säuerlich"
    assert parsed("2 EL Crème fraîche").name == "Crème fraîche"
    assert parse_line("🙂 200 g Mehl 🙂") is not None


def test_parse_text_numbers_lines_and_counts_ignored():
    rows, ignored = parse_text("Für den Teig:\n200 g Mehl\n\n   \n2 Eier\nSauce:\n")
    assert [(n, l.name) for n, l in rows] == [(2, "Mehl"), (5, "Eier")] and ignored == 2
    rows, _ = parse_text("200 g Mehl\r\n2 Eier\r\n")
    assert [n for n, _ in rows] == [1, 2]


# --- the finding of foods ------------------------------------------------------------------------------------------------


def test_variants_go_from_specific_to_general():
    v = ingredients.variants("Mehl Type 405")
    assert v[0] == ["mehl", "type", "405"] and ["mehl"] in v and ["405"] not in v
    v = ingredients.variants("extra virgin olive oil")
    assert v[0] == ["extra", "virgin", "olive", "oil"] and ["olive", "oil"] in v and ["extra"] not in v  # adjectives are no search words
    assert ["tomat"] in ingredients.variants("Tomaten")  # the stem finds 'Tomate' as a word start
    assert ["ei"] in ingredients.variants("Eier")


BLS_HEADER = ["BLS Code", "Lebensmittelbezeichnung", "Food name", "ENERCC Energie (Kilokalorien) [kcal/100g]", "PROT625 Protein [g/100g]",
              "FAT Fett [g/100g]", "CHO Kohlenhydrate [g/100g]"]
BLS_ROWS = [
    ["B1", "Weizenmehl Type 405", "Wheat flour type 405", "340", "10", "1", "70"],
    ["B2", "Weizenmehl Type 1050", "Wheat flour type 1050", "330", "11", "1.5", "66"],
    ["B3", "Olivenöl", "Olive oil", "880", "0", "99", "0"],
    ["B4", "Mehl Gemischt", "Mixed flour", "335", "9", "1", "69"],
    ["B5", "Zwiebel roh", "Onion, raw", "28", "1.2", "0.2", "4.9"],
    ["B6", "Zwiebelsuppe", "Onion soup", "30", "1", "1", "3"],
    ["B7", "Hühnerei Vollei roh", "Egg, whole, raw", "137", "12", "9.3", "0.4"],
    ["B8", "Ei gekocht", "Egg boiled", "140", "12", "9", "0.5"],
]


@pytest.fixture
def basics(tmp_path):
    """A basic-food catalogue next to the test database (made-up foods)."""
    table = tmp_path / "bls.csv"
    with open(table, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle, delimiter=";")
        writer.writerow(BLS_HEADER)
        writer.writerows(BLS_ROWS)
    import_bls(str(tmp_path / "catalog-bls.db"), str(table))


def own(client, name, kcal=100, **more):
    r = client.post("/api/v1/foods", json={"name": name, "per_100": {"kcal": kcal}, **more})
    assert r.status_code == 201, r.text
    return r.json()


def match(client, text, **kwargs):
    r = client.post(POST, json={"text": text}, **kwargs)
    assert r.status_code == 200, r.text
    return r.json()


def test_route_without_any_catalogue_uses_own_foods(client):
    flour = own(client, "Mehl Type 405", 350)
    own(client, "Hafermilch", 45, unit="ml")
    out = match(client, "200 g Mehl\n250 ml Hafermilch\n3 Zahnstocher")
    mehl, milk, nothing = out["lines"]
    assert mehl["grams"] == 200 and mehl["suggestion"]["food_id"] == flour["id"] and mehl["suggestion"]["source"] == "own"
    assert milk["suggestion"]["unit"] == "ml" and milk["ml"] == 250
    assert nothing["candidates"] == [] and nothing["suggestion"] is None and nothing["grams"] is None
    assert [l["line"] for l in out["lines"]] == [1, 2, 3] and out["ignored"] == 0


def test_own_foods_rank_exact_name_first_and_recipes_never_appear(client):
    own(client, "Vollkornmehl")
    own(client, "Mehl Type 550")
    exact = own(client, "Mehl")
    flour = own(client, "Zutat", 10)
    client.post("/api/v1/recipes", json={"name": "Mehlspeise", "portions": 2, "items": [{"food_id": flour["id"], "amount": 100}]})
    (line,) = match(client, "100 g Mehl")["lines"]
    names = [c["name"] for c in line["candidates"]]
    assert names == ["Mehl", "Mehl Type 550", "Vollkornmehl"] and line["suggestion"]["food_id"] == exact["id"]
    assert "Mehlspeise" not in names


def test_catalogue_candidates_follow_own_foods_basic_before_packaged(client, basics):
    mine = own(client, "Olivenöl nativ", 880, unit="ml")
    out = match(client, "2 EL Olivenöl\n1 Zwiebel\n3 Eier\n2 cups flour\n1 Zwiebeln, gehackt")
    oil, onion, eggs, flour, onions = out["lines"]
    assert oil["suggestion"]["source"] == "own" and oil["suggestion"]["food_id"] == mine["id"]
    assert [c["source"] for c in oil["candidates"]] == ["own", "bls"] and oil["candidates"][1]["code"] == "B3"
    assert oil["candidates"][1]["food_id"] is None
    assert onion["suggestion"]["name"] == "Zwiebel roh" and onion["candidates"][1]["name"] == "Zwiebelsuppe"
    assert onions["suggestion"]["name"] == "Zwiebel roh" and onions["note"] == "gehackt"
    assert eggs["name"] == "Eier" and eggs["suggestion"]["name"] in ("Hühnerei Vollei roh", "Ei gekocht")  # via the singular 'Ei'
    assert flour["suggestion"]["code"] in ("B1", "B2", "B4")  # via the English name
    assert len(flour["candidates"]) <= 5


def test_a_catalogue_item_stored_as_food_shows_as_own(client, basics):
    client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "B3"})
    (line,) = match(client, "1 EL Olivenöl")["lines"]
    assert [(c["source"], c["code"] is None) for c in line["candidates"]] == [("bls", True)]
    assert line["suggestion"]["food_id"] is not None  # no second, catalogue copy next to it


def test_candidates_are_limited_to_five(client):
    for i in range(9):
        own(client, f"Käse Sorte {i}")
    (line,) = match(client, "100 g Käse")["lines"]
    assert len(line["candidates"]) == 5 and {c["source"] for c in line["candidates"]} == {"own"}
    for i in range(9):
        own(client, f"Gouda {i}")
    assert len(match(client, "100 g Gouda")["lines"][0]["candidates"]) <= 5


def test_route_writes_nothing(client, basics):
    own(client, "Mehl")
    before = (client.get("/api/v1/foods?limit=1000").json(), client.get("/api/v1/recipes").json())
    match(client, "200 g Mehl\n1 EL Olivenöl\n2 Eier")
    assert (client.get("/api/v1/foods?limit=1000").json(), client.get("/api/v1/recipes").json()) == before


def test_route_limits(client):
    assert client.post(POST, json={}).status_code == 422
    assert client.post(POST, json={"text": 5}).status_code == 422
    assert match(client, "")["lines"] == [] and match(client, "\n\n  \n")["lines"] == []
    assert len(match(client, "\n".join(["2 Eier"] * 200))["lines"]) == 200
    assert client.post(POST, json={"text": "\n".join(["2 Eier"] * 201)}).status_code == 422
    assert match(client, "x" * 300)["lines"][0]["grams"] is None
    assert client.post(POST, json={"text": "x" * 301}).status_code == 422
    assert client.post(POST, json={"text": "ab\n" * 6001}).status_code == 422  # too long in all (and too many lines)
    assert client.post(POST, json={"text": ("a" * 100 + "\n") * 201}).status_code == 422


def test_route_survives_nasty_lines(client, basics):
    text = "\n".join(["'; DROP TABLE food; --", "%" * 50, '"* OR "a" NEAR b', "( ) [ ]", "NEAR/2 AND OR NOT", "٣ g Mehl", "1 " + "ü" * 280])
    out = match(client, text)
    assert len(out["lines"]) + out["ignored"] == 7


def test_route_is_reasonably_fast_for_a_long_list(client, basics):
    for i in range(30):
        own(client, f"Eigenes Ding {i}")
    started = time.monotonic()
    match(client, "\n".join(["2 EL Olivenöl", "200 g Mehl", "Unbekanntes Zeug", "3 Eier"] * 50))
    assert time.monotonic() - started < 20


def test_route_needs_a_login(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from mahlwerk.main import create_app
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    anonymous = TestClient(create_app(str(tmp_path / "x.db")))
    assert anonymous.post(POST, json={"text": "2 Eier"}).status_code == 401


def test_a_read_access_key_may_use_it_but_not_write(client, make_client):
    token = client.post("/api/v1/me/tokens", json={"name": "ro", "scope": "read"}).json()["token"]
    bare = make_client()
    h = {"Authorization": f"Bearer {token}"}
    assert bare.post(POST, json={"text": "2 Eier"}, headers=h).status_code == 200
    assert bare.post("/api/v1/recipes", json={"name": "x", "portions": 1, "items": []}, headers=h).status_code == 403


def test_demo_policy_lists_the_route():
    assert demo_account.POLICY[("POST", POST)] == "own"


def test_the_matched_foods_make_a_recipe_through_the_ordinary_routes(client, basics):
    flour = own(client, "Mehl", 350)
    out = match(client, "200 g Mehl\n1 EL Olivenöl")
    items = []
    for line in out["lines"]:
        c = line["suggestion"]
        food_id = c["food_id"] or client.post("/api/v1/catalog/adopt", json={"source": c["source"], "code": c["code"]}).json()["id"]
        items.append({"food_id": food_id, "amount": line["grams"]})
    r = client.post("/api/v1/recipes", json={"name": "Test", "portions": 2, "items": items})
    assert r.status_code == 201 and items[0]["food_id"] == flour["id"]
    assert r.json()["food"]["per_100"]["kcal"] is not None


# --- new reading rules ---------------------------------------------------------------------------------------------------


def test_juice_and_zest_of_citrus_fruit():
    line = parsed("Saft von 1 Zitrone")
    assert (line.name, line.quantity, line.grams, line.estimated, line.basis) == ("Zitronensaft", 1, 45, True, "unit")
    assert parsed("Saft einer halben Zitrone").grams == 22.5
    assert parsed("Saft von 2 Limetten").grams == 60
    assert parsed("juice of 1 orange").name == "Orangensaft" and parsed("juice of 1 orange").grams == 80
    assert parsed("juice of half a lemon").grams == 22.5
    line = parsed("Abrieb von 1 Bio-Zitrone")
    assert line.name == "Zitronenschale" and line.grams == 6
    assert parsed("zest of 2 limes").grams == 8
    assert parsed("Saft von 1 Zitrone (ca. 3 EL)").note == "ca. 3 EL"
    assert parse_line("Saft von 1 Drachenfrucht").grams is None  # not a citrus fruit: read like any line


def test_tubs_of_dairy():
    assert grams("1 Becher Sahne") == (200, True, "unit")
    assert grams("2 Becher Schmand") == (400, True, "unit")
    assert grams("1 Becher Joghurt") == (150, True, "unit")
    assert grams("1 Becher Naturjoghurt")[0] == 150
    assert grams("1 Becher Sahne (250 g)") == (250, False, "explicit")
    assert grams("1 Becher Irgendwas") == (None, False, "none")


def test_unit_written_together_with_the_name():
    for text in ("200 gMehl", "200gMehl", "1 kgMehl"):
        line = parsed(text)
        assert line.name == "Mehl" and line.unit in ("g", "kg")
    assert grams("200 gMehl") == (200, False, "mass")
    assert parsed("2 Gurken").name == "Gurken"  # no unit hides in a name that starts with a capital after g


def test_two_foods_in_one_line_read_the_first():
    line = parsed("Salz und Pfeffer")
    assert line.name == "Salz" and line.note == "Pfeffer"
    line = parsed("Butter oder Margarine")
    assert line.name == "Butter"


def test_canned_lines():
    assert parsed("1 Dose Tomaten").canned and parsed("400 g Tomaten aus der Dose").canned and parsed("1 can tomatoes").canned
    assert not parsed("2 Tomaten").canned


def test_preparation_words_of_both_languages_say_the_same():
    expanded, named = ingredients._expand({"cooked", "rice"})
    assert named and {"gekocht", "boiled"} <= expanded
    expanded, named = ingredients._expand({"gebratenes", "huhn"})
    assert named and {"gebraten", "fried"} <= expanded
    assert ingredients._expand({"rice"}) == ({"rice"}, False)
    assert ingredients._colour("grüne") is None and ingredients._colour("grune") == "grun" and ingredients._colour("weiße") == "weiß" and ingredients._colour("green") == "green"
    assert ["grun", "bohnen"] in ingredients.variants("grüne Bohnen")


def test_the_usual_meaning_table():
    assert ingredients.usual_query("Eier") == "Hühnerei roh" == ingredients.usual_query("eggs")
    assert ingredients.usual_query("Mehl") == ingredients.usual_query("flour") == "Weizen Mehl Type 405"
    assert ingredients.usual_query("Brokkoliröschen") == ingredients.usual_query("Brokkoli")
    assert ingredients.usual_query("rote Paprikaschote") == ingredients.usual_query("Paprika")
    assert ingredients.usual_query("Kartoffelmehl") is None  # a compound of another food is not the food
    assert ingredients.usual_query("Kartoffelsalat") is None
    assert ingredients.usual_query("Drachenschuppen") is None


# --- the quality of the first suggestion ---------------------------------------------------------------------------------

TRICKY_ROWS = [  # names as the BLS writes them, with the neighbours that fool a plain search (made-up values)
    ["Q611000", "Butter mild gesäuert", "Best quality butter", "741", "0.7", "83", "0.6"],
    ["Q6A4000", "Butter gesalzen", "Butter salted", "741", "0.7", "83", "0.6"],
    ["D036000", "Butterzwieback", "Butter rusk", "410", "10", "7", "75"],
    ["D311200", "Buttercremetorte (Biskuit)", "Butter cream torte (sponge cake)", "400", "4", "25", "40"],
    ["R111000", "Speisesalz/Siedesalz/Tafelsalz", "Common salt/table salt", "0", "0", "0", "0"],
    ["X900000", "Salzburger Nockerl gebacken", "Salzburger dumplings baked", "200", "6", "8", "25"],
    ["G890702", "Salzgurke milchsauer fermentiert", "Gherkin lactic acid fermented", "10", "0.5", "0.1", "1"],
    ["E111100", "Hühnerei roh", "Chicken egg raw", "137", "12", "9", "0.4"],
    ["E111132", "Hühnerei gekocht", "Chicken egg boiled", "138", "12", "9", "0.4"],
    ["E999000", "Eier-Frischteigwaren roh", "Egg fresh pasta raw", "270", "10", "3", "50"],
    ["C414100", "Mehlmischung glutenfrei", "Flour mix gluten-free", "340", "3", "1", "78"],
    ["C214100", "Weizen Mehl, Type 405", "Wheat flour, Type 405", "340", "10", "1", "70"],
    ["C214200", "Weizen Mehl, Type 550", "Wheat flour, Type 550", "340", "10", "1", "70"],
    ["X548163", "Zwiebeln gebraten", "Onions fried", "90", "1", "6", "8"],
    ["G480100", "Speisezwiebel roh", "Onion raw", "28", "1.2", "0.2", "4.9"],
    ["G480132", "Speisezwiebel gekocht", "Onion boiled", "25", "1", "0.2", "4"],
    ["G620100", "Karotte/Möhre, roh", "Carrot raw", "27", "0.8", "0.2", "4.8"],
    ["X620000", "Karotten-/Möhrenpüree", "Carrot puree", "40", "1", "1", "6"],
    ["S111000", "Zucker weiß (Raffinadezucker/Weißzucker)", "Sugar white (refined sugar)", "400", "0", "0", "100"],
    ["S112000", "Zucker braun (Kandisfarin/Rohzucker)", "Sugar brown (candyfarin/raw sugar)", "390", "0", "0", "98"],
    ["G570100", "Zuckermais roh", "Sweetcorn raw", "90", "3", "1", "16"],
    ["M173800", "Schlagsahne mind. 30 % Fett", "Whipping cream min. 30 % fat", "300", "2", "30", "3"],
    ["X999100", "Sahne-Käsesauce", "Cream cheese sauce", "150", "4", "12", "4"],
    ["G560100", "Tomate roh", "Tomato raw", "18", "0.9", "0.2", "2.6"],
    ["G560900", "Tomate Konserve", "Tomato canned", "19", "1", "0.2", "3"],
    ["R161200", "Tomaten passiert/Tomatenpüree", "Tomato puree", "30", "1.5", "0.3", "5"],
    ["V416100", "Hähnchen Brustfilet, roh", "Chicken breast fillet, raw", "110", "23", "1.5", "0"],
    ["F601100", "Zitrone roh", "Lemon raw", "35", "0.7", "0.5", "3"],
    ["F601600", "Zitronensaft", "Lemon juice", "25", "0.4", "0.1", "2.5"],
    ["N310400", "Zitronenlimonade", "Carbonated lemonade", "40", "0", "0", "10"],
    ["G490100", "Knoblauch roh", "Garlic raw", "140", "6", "0.1", "28"],
    ["G710100", "Bohne grün, roh", "Bean green, raw", "30", "2", "0.2", "5"],
    ["G710132", "Bohne grün, gekocht", "Bean green, boiled", "30", "2", "0.2", "5"],
    ["X900100", "Weinbrand-Bohnen", "Brandy beans", "470", "5", "30", "40"],
    ["X900200", "Weiße-Bohnen-Eintopf", "White bean stew", "90", "5", "2", "12"],
    ["C352000", "Reis poliert, roh", "Rice polished, raw", "350", "7", "0.6", "77"],
    ["C352032", "Reis poliert, gekocht", "Rice polished, boiled", "120", "2.5", "0.2", "27"],
    ["C351000", "Reis unpoliert, roh", "Rice unpolished, raw", "350", "7", "2", "74"],
    ["C351032", "Reis unpoliert, gekocht", "Rice unpolished, boiled", "130", "2.7", "0.9", "28"],
    ["M402500", "Gouda mind. 40 % Fett i. Tr.", "Gouda min. 40 % fat", "350", "25", "28", "0"],
    ["M401600", "Edamer mind. 45 % Fett i. Tr.", "Edam min. 45 % fat", "340", "25", "27", "0"],
    ["V416182", "Hähnchen Brustfilet, gebraten ohne Fett (Pfanne)", "Chicken breast fillet, fried", "150", "30", "3", "0"],
    ["V416172", "Hähnchen Brustfilet, gegrillt", "Chicken breast fillet, grilled", "140", "30", "2", "0"],
    ["D610500", "Zimtsterne (Eiklarmasse)", "Cinnamon stars (meringue)", "430", "7", "17", "60"],
    ["S111100", "Puderzucker", "Icing sugar", "400", "0", "0", "100"],
]
TRICKY_CASES = [  # (line, the name that must be suggested; None: nothing may be suggested)
    ("200 g Butter", "Butter mild gesäuert"), ("100 g butter", "Butter mild gesäuert"),
    ("1 Prise Salz", "Speisesalz/Siedesalz/Tafelsalz"), ("1 tsp salt", "Speisesalz/Siedesalz/Tafelsalz"), ("Salz und Pfeffer", "Speisesalz/Siedesalz/Tafelsalz"),
    ("2 Eier", "Hühnerei roh"), ("3 eggs", "Hühnerei roh"),
    ("200 g Mehl", "Weizen Mehl, Type 405"), ("2 cups flour", "Weizen Mehl, Type 405"), ("200 gMehl", "Weizen Mehl, Type 405"),
    ("1 Zwiebel, fein gehackt", "Speisezwiebel roh"), ("2 onions", "Speisezwiebel roh"), ("1 Zwiebel, gekocht", "Speisezwiebel gekocht"), ("2 gekochte Karotten", None),
    ("2 Karotten", "Karotte/Möhre, roh"), ("2 carrots", "Karotte/Möhre, roh"),
    ("1 TL Zucker", "Zucker weiß (Raffinadezucker/Weißzucker)"), ("100 g sugar", "Zucker weiß (Raffinadezucker/Weißzucker)"),
    ("50 g Puderzucker", "Puderzucker"), ("80 g brauner Zucker", "Zucker braun (Kandisfarin/Rohzucker)"),
    ("1 Becher Sahne", "Schlagsahne mind. 30 % Fett"), ("200 ml heavy cream", "Schlagsahne mind. 30 % Fett"),
    ("2 Tomaten", "Tomate roh"), ("1 Dose Tomaten", "Tomate Konserve"), ("400 g Tomaten aus der Dose", "Tomate Konserve"), ("1 can tomatoes", "Tomate Konserve"),
    ("500 g Hähnchenbrustfilet", "Hähnchen Brustfilet, roh"), ("1 chicken breast", "Hähnchen Brustfilet, roh"),
    ("Saft von 1 Zitrone", "Zitronensaft"), ("juice of 1 lemon", "Zitronensaft"), ("1 Zitrone", "Zitrone roh"),
    ("2 Knoblauchzehen", "Knoblauch roh"), ("3 cloves garlic", "Knoblauch roh"),
    ("120 g Grüne Bohnen", "Bohne grün, roh"), ("100 g Green beans", "Bohne grün, roh"), ("100 g Grüne Bohnen, gekocht", "Bohne grün, gekocht"),
    ("100 g Weiße Bohnen", None),  # a colour can make a food of its own: not "Bohne grün"
    ("150 g Reis", "Reis poliert, roh"), ("180 g Reis gekocht", "Reis poliert, gekocht"), ("150 g Cooked rice", "Reis poliert, gekocht"), ("150 g Vollkornreis", "Reis unpoliert, roh"),
    ("30 g Gouda", "Gouda mind. 40 % Fett i. Tr."), ("30 g Edamer", "Edamer mind. 45 % Fett i. Tr."),
    ("120 g Fried chicken breast", "Hähnchen Brustfilet, gebraten ohne Fett (Pfanne)"), ("120 g Gebratenes Hähnchenfilet", "Hähnchen Brustfilet, gebraten ohne Fett (Pfanne)"),
    ("120 g Grilled chicken breast", "Hähnchen Brustfilet, gegrillt"), ("120 g Hähnchenbrust roh", "Hähnchen Brustfilet, roh"),
    ("250 g Chicken soup", None),  # a soup is not the chicken
    ("1 TL Zimt", None), ("Drachenschuppen", None),
]


@pytest.fixture
def tricky(tmp_path):
    table = tmp_path / "tricky.csv"
    with open(table, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle, delimiter=";")
        writer.writerow(BLS_HEADER)
        writer.writerows(TRICKY_ROWS)
    import_bls(str(tmp_path / "catalog-bls.db"), str(table))


@pytest.mark.parametrize("text,expected", TRICKY_CASES)
def test_first_suggestion_beats_the_misleading_neighbours(client, tricky, text, expected):
    (line,) = match(client, text)["lines"]
    got = line["suggestion"]["name"] if line["suggestion"] else None
    assert got == expected, [c["name"] for c in line["candidates"]]


def test_a_confident_suggestion_may_have_alternatives_that_are_not(client, tricky):
    (line,) = match(client, "1 TL Zimt")["lines"]
    assert line["suggestion"] is None and [c["name"] for c in line["candidates"]] == ["Zimtsterne (Eiklarmasse)"]


def test_sharp_s_is_found_in_the_catalogue(tricky, tmp_path):
    from mahlwerk.catalog import Catalog
    catalog = Catalog(str(tmp_path / "catalog.db"))
    assert "Zucker weiß (Raffinadezucker/Weißzucker)" in [i["name"] for i in catalog.search("weiß", 5, "bls")]
    assert [i["name"] for i in catalog.search("Weißzucker", 5, "bls")] == ["Zucker weiß (Raffinadezucker/Weißzucker)"]


def test_own_foods_still_come_first_and_a_stored_basic_food_is_ranked_like_the_others(client, tricky):
    mine = own(client, "Butter selbstgemacht", 700)
    (line,) = match(client, "100 g Butter")["lines"]
    assert line["suggestion"]["food_id"] == mine["id"]
    adopted = client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "Q6A4000"}).json()
    own_food = client.delete(f"/api/v1/foods/{mine['id']}")
    assert own_food.status_code == 204
    (line,) = match(client, "100 g Butter")["lines"]
    assert line["suggestion"]["name"] == "Butter mild gesäuert"  # the adopted "Butter gesalzen" does not jump the queue
    assert adopted["id"] in [c["food_id"] for c in line["candidates"]]


def test_hit_rate_against_a_real_catalogue():
    """Skipped without the real catalogues: set MAHLWERK_TEST_CATALOG to a folder (or catalog.db) that holds catalog.db and
    catalog-bls.db. Needs at least 90 % sensible first suggestions on the two ingredient lists and 85 % on the list of meal components (scripts/check_ingredients.py)."""
    import importlib.util
    import os
    from pathlib import Path

    from mahlwerk.catalog import Catalog
    target = os.environ.get("MAHLWERK_TEST_CATALOG")
    if not target:
        pytest.skip("MAHLWERK_TEST_CATALOG is not set")
    path = Path(target)
    catalog = Catalog(str(path / "catalog.db" if path.is_dir() else path))
    if catalog.info()["bls"]["products"] < 1000:
        pytest.skip("no real basic-food catalogue there")
    script = Path(__file__).resolve().parents[1] / "scripts" / "check_ingredients.py"
    spec = importlib.util.spec_from_file_location("check_ingredients", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for cases, goal in ((module.CASES, 0.9), (module.HELD_OUT, 0.9), (module.MEALS, 0.85)):
        hits, total, misses = module.run(catalog, path=cases)
        assert hits / total >= goal, f"{cases.name}: {hits}/{total}\n" + "\n".join(misses)

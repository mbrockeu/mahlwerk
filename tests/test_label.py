from mahlwerk import label
from mahlwerk.label import Box

# What the OCR returned for a real phone photo of a curved bottle with a halftone label.
# Note the lost comma ("85g"), the unit read as a digit ("8,59") and the unreadable "Salz".
BOTTLE = [
    Box(683, 550, "Durchscnnittliche Nahrwerte"), Box(935, 644, "Je100ml"), Box(162, 787, "ause"),
    Box(883, 746, "149 k/35 kcal"), Box(995, 829, "0g"), Box(420, 865, "Fett"),
    Box(568, 933, "-davon gesäattigte"), Box(994, 959, "0g"), Box(527, 999, "Fettsauren"),
    Box(974, 1036, "85g"), Box(549, 1080, "Kohienhydrate"), Box(979, 1100, "8,59"),
    Box(560, 1140, "davonZucker"), Box(995, 1171, "0g"), Box(489, 1213, "EiweiB"),
    Box(971, 1248, "0,01g"), Box(476, 1283, "zies"),
]

# A flat table with a per-100 and a per-serving column, slightly rotated.
TWO_COLUMNS = [
    Box(1295, 93, "je 250 ml"), Box(914, 109, "je 100 ml"), Box(350, 133, "Durchschnittliche Nahrwerte"),
    Box(1353, 181, "253 kl / 60 kca"), Box(980, 197, "101 kj / 24 kcal"), Box(173, 232, "Brennwert"),
    Box(1241, 277, "og"), Box(862, 294, "0g"), Box(110, 325, "Fett"),
    Box(1246, 367, "0g"), Box(866, 384, "0g"), Box(358, 405, "davon gesättigte Fettsäuren"),
    Box(1262, 457, "14 g"), Box(888, 473, "5,6 g"), Box(224, 501, "Kohlenhydrate"),
    Box(1286, 546, "13,8 g"), Box(893, 563, "5,5 g"), Box(221, 589, "davon Zucker"),
    Box(1276, 636, "0,3 g"), Box(897, 653, "0,1 g"), Box(152, 682, "Eiweis"),
    Box(1294, 725, "0,03 g"), Box(914, 742, "0,01 g"), Box(133, 773, "Salz"),
]


def rows(*pairs):
    """Boxes for a simple table: label on the left, amount on the right, one row per pair."""
    boxes = []
    for index, (name, amount) in enumerate(pairs):
        boxes += [Box(100, 100 + 50 * index, name), Box(600, 100 + 50 * index, amount)]
    return boxes


def test_real_bottle_photo():
    result = label.interpret(BOTTLE)
    assert result["per_100"] == {
        "kcal": 35, "fat": 0, "saturated_fat": 0, "carbs": 8.5, "sugars": 8.5,
        "fiber": None, "protein": 0, "salt": 0.01,
    }
    assert result["basis"] == "100ml"
    assert set(result["warnings"]) == {"unit_misread", "decimal_guessed"}


def test_two_columns_take_the_per_100_column():
    result = label.interpret(TWO_COLUMNS)
    assert result["per_100"] == {
        "kcal": 24, "fat": 0, "saturated_fat": 0, "carbs": 5.6, "sugars": 5.5,
        "fiber": None, "protein": 0.1, "salt": 0.01,
    }
    assert result["warnings"] == []


def test_table_with_fibre_in_english():
    result = label.interpret(rows(
        ("Energy", "2255kJ/539kcal"), ("Fat", "30.9g"), ("of which saturates", "10.6g"), ("Carbohydrate", "57.5g"),
        ("of which sugars", "56.3g"), ("Fibre", "3.4g"), ("Protein", "6.3g"), ("Salt", "107mg"),
    ) + [Box(300, 40, "Nutrition per 100g")])
    assert result["per_100"]["kcal"] == 539 and result["per_100"]["fiber"] == 3.4
    assert result["per_100"]["salt"] == 0.107 and result["per_100"]["saturated_fat"] == 10.6
    assert result["basis"] == "100g"
    assert result["warnings"] == []


def test_extra_rows_fall_back_to_the_nearest_number():
    result = label.interpret(rows(
        ("Brennwert", "250 kcal"), ("Fett", "12 g"), ("davon gesättigte Fettsäuren", "1,5 g"),
        ("davon einfach ungesättigte", "8 g"), ("Kohlenhydrate", "30 g"), ("davon Zucker", "2 g"),
        ("Eiweiß", "5 g"), ("Salz", "0,9 g"), ("Vitamin C", "12 mg"),
    ))
    assert result["per_100"]["fat"] == 12 and result["per_100"]["carbs"] == 30
    assert result["per_100"]["protein"] == 5 and result["per_100"]["salt"] == 0.9


def test_energy_from_kilojoule_only():
    assert label.interpret([Box(100, 100, "Brennwert"), Box(600, 100, "418 kJ")])["per_100"]["kcal"] == 99.9


def test_implausible_values_are_flagged():
    wrong = rows(("Brennwert", "100 kcal"), ("Fett", "1 g"), ("gesättigte", "3 g"), ("Kohlenhydrate", "5 g"),
                 ("Zucker", "50 g"), ("Eiweiß", "3 g"), ("Salz", "1 g"))
    warnings = label.interpret(wrong)["warnings"]
    assert {"energy_mismatch", "saturated_fat_exceeds_fat", "sugars_exceeds_carbs"} <= set(warnings)


def test_nothing_readable_is_flagged():
    result = label.interpret([Box(100, 100, "Zutaten: Wasser, Apfelsaft")])
    assert result["warnings"] == ["core_values_missing"]
    assert label.interpret([])["warnings"] == ["core_values_missing"]

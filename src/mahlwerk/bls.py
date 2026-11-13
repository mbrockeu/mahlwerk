"""Basic foods from the Bundeslebensmittelschlüssel (BLS 4.0, Max Rubner-Institut).

The BLS is a table of about 7,100 foods (apple, bread, cooked potatoes, dishes) with up to 138 nutrients per
100 g. It is published as an .xlsx workbook; the layout is

    BLS Code | Lebensmittelbezeichnung | Food name | then per nutrient three columns:
    `<TAG> <name> [<unit>/100g]` (the value), `<TAG> Datenherkunft`, `<TAG> Referenz`

Columns are found by their TAG in the header row, never by position. A value is a number, or text: `-` / empty means
not determined (unknown), `TR` (trace) and `<LOD`, `<LOQ`, `<LOD or <LOQ` (below the detection limit) count as 0.

This module only turns rows into foods; `catalog.import_bls` stores them. It has no BLS data in it.
"""

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from . import nutrients
from .nutrition import CORE

CODE = "BLS Code"
NAME_DE = "Lebensmittelbezeichnung"
NAME_EN = "Food name"

# Core values (Per100 key -> BLS tag). Protein is the Nx6.25 figure (the usual label value) and carbohydrates are the
# "available" ones (CHO), which is what food labels and the other sources of this app mean.
CORE_TAGS = {
    "kcal": "ENERCC",
    "fat": "FAT",
    "saturated_fat": "FASAT",
    "carbs": "CHO",
    "sugars": "SUGAR",
    "fiber": "FIBT",
    "protein": "PROT625",
    "salt": "NACL",
}
ENERGY_KJ = "ENERCJ"  # only used for kcal when a food has no kcal value

# Additional nutrients (nutrients.py key -> BLS tag). Where the BLS has several variants the total or the equivalent
# is taken, the one the EU reference intakes refer to: vitamin A as retinol equivalents (VITA, not the RAE variant),
# vitamin E as alpha-tocopherol equivalents (VITE), niacin as niacin equivalents (NIAEQ, includes what the body makes
# from tryptophan), folate as folate equivalents (FOL), iodine as iodide (ID), fats as the "total" groups (FAMS,
# FAPU, FAPUN3). The BLS has no selenium, trans fat, added sugar or caffeine; those stay unknown.
EXTRA_TAGS = {
    "water": "WATER",
    "alcohol": "ALC",
    "sodium": "NA",
    "cholesterol": "CHORL",
    "monounsaturated_fat": "FAMS",
    "polyunsaturated_fat": "FAPU",
    "omega_3": "FAPUN3",
    "starch": "STARCH",
    "calcium": "CA",
    "iron": "FE",
    "potassium": "K",
    "magnesium": "MG",
    "zinc": "ZN",
    "phosphorus": "P",
    "iodine": "ID",
    "copper": "CU",
    "manganese": "MN",
    "chloride": "CLD",
    "fluoride": "FD",
    "chromium": "CR",
    "molybdenum": "MO",
    "vitamin_a": "VITA",
    "vitamin_b1": "THIA",
    "vitamin_b2": "RIBF",
    "vitamin_b3": "NIAEQ",
    "vitamin_b5": "PANTAC",
    "vitamin_b6": "VITB6",
    "vitamin_b7": "BIOT",
    "vitamin_b9": "FOL",
    "vitamin_b12": "VITB12",
    "vitamin_c": "VITC",
    "vitamin_d": "VITD",
    "vitamin_e": "VITE",
    "vitamin_k": "VITK",
}

BELOW_LIMIT = {"tr", "<lod", "<loq", "<lod or <loq"}
_HEADER = re.compile(r"^(\S+)\s.*\[\s*([^/\]\s]+)\s*/\s*100\s*(g|ml)\s*\]\s*$", re.IGNORECASE)
_UNIT_ALIASES = {"ug": "µg", "μg": "µg", "mcg": "µg"}  # micro sign, Greek mu


class BlsError(Exception):
    """The table is not a BLS table."""


def parse_value(text: str) -> float | None:
    """A cell as a number: None for unknown (`-`, empty, text), 0 for trace or below the detection limit."""
    text = (text or "").strip()
    if not text or text == "-":
        return None
    if text.lower() in BELOW_LIMIT:
        return 0.0
    if "," in text and "." not in text:
        text = text.replace(",", ".")  # a CSV written with a German locale
    return nutrients.parse_number(text)


@dataclass
class Columns:
    """Where the wanted values are: nutrient key -> (column index, unit quoted in the header)."""

    code: int
    name: int
    name_en: int | None
    core: dict[str, tuple[int, str]] = field(default_factory=dict)
    extra: dict[str, tuple[int, str]] = field(default_factory=dict)
    kilojoule: tuple[int, str] | None = None
    missing: list[str] = field(default_factory=list)  # wanted TAGs the table does not have


def find_columns(header: list[str]) -> Columns:
    names = {h.strip(): i for i, h in enumerate(header)}
    if CODE not in names or NAME_DE not in names:
        raise BlsError(f"this is not a BLS table: columns {CODE!r} and {NAME_DE!r} are missing")
    by_tag: dict[str, tuple[int, str]] = {}
    for index, cell in enumerate(header):
        match = _HEADER.match(cell.strip())
        if match:
            unit = match.group(2)
            by_tag.setdefault(match.group(1), (index, _UNIT_ALIASES.get(unit.lower(), unit)))
    columns = Columns(code=names[CODE], name=names[NAME_DE], name_en=names.get(NAME_EN))
    for target, tags in ((columns.core, CORE_TAGS), (columns.extra, EXTRA_TAGS)):
        for key, tag in tags.items():
            if tag in by_tag:
                target[key] = by_tag[tag]
            else:
                columns.missing.append(tag)
    columns.kilojoule = by_tag.get(ENERGY_KJ)
    return columns


def mapping(columns: Columns) -> dict[str, tuple[str, str]]:
    """key -> (tag, unit in the table) of every nutrient that was found."""
    tag_of = {**CORE_TAGS, **EXTRA_TAGS}
    return {key: (tag_of[key], unit) for key, (_, unit) in {**columns.core, **columns.extra}.items()}


@dataclass
class Food:
    code: str
    name: str
    name_en: str | None
    per_100: dict[str, float | None]
    extra: dict[str, float]


def _cell(row: list[str], index: int) -> str:
    return row[index] if index < len(row) else ""


def _converted(columns: tuple[int, str], key: str, row: list[str]) -> float | None:
    """The value of nutrient `key` in the unit this app uses (core values: g, kcal for energy)."""
    index, unit = columns
    value = parse_value(_cell(row, index))
    if value is None:
        return None
    if key in CORE_TAGS:
        factor = {"g": 1.0, "kcal": 1.0, "mg": 1e-3, "µg": 1e-6}.get(unit)
        return None if factor is None else value * factor
    return nutrients.from_unit(key, value, unit)


def convert(row: list[str], columns: Columns) -> Food | None | str:
    """One table row -> Food, or the reason it is dropped: 'no_name', 'no_energy', 'implausible'."""
    code = _cell(row, columns.code).strip()
    name = " ".join(_cell(row, columns.name).split())
    if not code or not name:
        return "no_name"
    name_en = " ".join(_cell(row, columns.name_en).split()) if columns.name_en is not None else ""
    per_100: dict[str, float | None] = {}
    for key in CORE_TAGS:
        spec = columns.core.get(key)
        value = _converted(spec, key, row) if spec else None
        per_100[key] = None if value is None else round(value, 2)
    if per_100["kcal"] is None and columns.kilojoule:
        kj = parse_value(_cell(row, columns.kilojoule[0]))
        if kj is not None and columns.kilojoule[1].lower() == "kj":
            per_100["kcal"] = round(kj / 4.184, 1)
    if per_100["kcal"] is None:
        return "no_energy"
    macros = [per_100[k] for k in ("fat", "carbs", "protein")]
    parts = [v for v in per_100.values() if v is not None]
    if per_100["kcal"] > 950 or any(v < 0 for v in parts) or any(v > 100 for k, v in per_100.items() if k != "kcal" and v is not None) or sum(v or 0 for v in macros) > 105:
        return "implausible"
    extra: dict[str, float] = {}
    for key, spec in columns.extra.items():
        value = _converted(spec, key, row)
        if value is not None and nutrients.part_fits(key, value, per_100["fat"], per_100["carbs"]):
            extra[key] = round(value, 4)
    return Food(code, name, name_en or None, per_100, extra)


def foods(rows: Iterable[list[str]], columns: Columns, counts: dict[str, int]) -> Iterator[Food]:
    """Foods of the data rows; `counts` gets one tally per reason a row was dropped."""
    for row in rows:
        if not any(cell.strip() for cell in row):
            continue
        result = convert(row, columns)
        if isinstance(result, str):
            counts[result] = counts.get(result, 0) + 1
        else:
            yield result

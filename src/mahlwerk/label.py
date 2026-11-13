"""Read a photographed nutrition table with a local OCR engine (RapidOCR, runs on the CPU).

Everything stays on the server. The result is a suggestion the user confirms or corrects.

The OCR returns text boxes with positions. Labels and numbers usually come as separate boxes,
and on a curved bottle a number does not sit at the same height as its label. So the values are
not matched by position alone: EU labels list the nutrients in a fixed order, and the numbers of
the per-100 column are assigned in that order whenever their count fits.
"""

import difflib
import importlib.util
import re
import threading
from dataclasses import dataclass
from statistics import median

ORDER = ("kcal", "fat", "saturated_fat", "carbs", "sugars", "fiber", "protein", "salt")
# checked in this order, so "davon gesättigte Fettsäuren" is not taken for fat
KEYWORDS = (
    ("saturated_fat", ("gesättigte", "gesattigte", "saturates", "saturated")),
    ("sugars", ("zucker", "sugars")),
    ("fiber", ("ballaststoffe", "fibre", "fiber")),
    ("kcal", ("brennwert", "energie", "energy")),
    ("carbs", ("kohlenhydrate", "carbohydrate", "carbohydrates")),
    ("protein", ("eiweiß", "eiweiss", "protein")),
    ("salt", ("salz", "salt")),
    ("fat", ("fett", "fat")),
)
NUM = r"[0-9o]+(?:[.,][0-9o]+)?"

_engine = None
_engine_lock = threading.Lock()


class OcrFailed(Exception):
    """The OCR engine could not read the image."""


@dataclass
class Box:
    x: float
    y: float
    text: str


def available() -> bool:
    return importlib.util.find_spec("rapidocr_onnxruntime") is not None


def _to_float(text: str) -> float:
    return float(text.replace("o", "0").replace(",", "."))


def _label(text: str) -> str | None:
    """Which nutrient a box names, tolerating OCR spelling such as "Kohienhydrate"."""
    words = re.findall(r"[a-zäöüß]+", text.lower())
    for key, keywords in KEYWORDS:
        for word in words:
            for keyword in keywords:
                if len(keyword) >= 5 and keyword in word:
                    return key
                if difflib.SequenceMatcher(None, word, keyword).ratio() >= 0.8:
                    return key
    return None


def _energy(text: str) -> float | None:
    compact = text.lower().replace(" ", "")
    if m := re.search(rf"({NUM})kca", compact):
        return _to_float(m.group(1))
    if m := re.search(rf"({NUM})k[jl]", compact):
        return round(_to_float(m.group(1)) / 4.184, 1)
    return None


def _grams(text: str) -> tuple[float, bool] | None:
    """A box that holds one amount: its value and whether the unit had to be guessed."""
    compact = re.sub(r"^[<>≤~]", "", text.lower().replace(" ", ""))
    m = re.fullmatch(rf"({NUM})(mg|g)?", compact)
    if not m:
        return None
    number, unit = m.groups()
    if not re.search(r"\d", number) and unit is None:
        return None  # a stray "o" is not an amount, "og" is
    if unit == "mg":
        return round(_to_float(number) / 1000, 3), False
    if unit is None and len(number) >= 2 and number.endswith("9"):
        # the unit "g" read as the digit 9: "8,5 g" becomes "8,59"
        return _to_float(number[:-1].rstrip(".,")), True
    return _to_float(number), False


def _per_100_column(amounts: list[tuple[Box, float, bool]], width: float) -> list[tuple[Box, float, bool]]:
    """Of several value columns (per 100 g, per serving, ...) keep the leftmost substantial one."""
    by_x = sorted(amounts, key=lambda a: a[0].x)
    clusters = [[by_x[0]]]
    for amount in by_x[1:]:
        if amount[0].x - clusters[-1][-1][0].x > 0.08 * width:
            clusters.append([])
        clusters[-1].append(amount)
    needed = max(2, 0.5 * max(len(c) for c in clusters))
    column = next(c for c in clusters if len(c) >= needed)
    return sorted(column, key=lambda a: a[0].y)


def _energy_gap(per_100: dict) -> float:
    expected = 9 * per_100["fat"] + 4 * per_100["carbs"] + 4 * per_100["protein"] + 2 * (per_100["fiber"] or 0)
    return abs(expected - per_100["kcal"])


def _plausible(per_100: dict) -> bool:
    return _energy_gap(per_100) <= max(25, 0.2 * per_100["kcal"])


def interpret(boxes: list[Box]) -> dict:
    """Turn OCR boxes into per-100 values, a basis and plausibility warnings."""
    per_100: dict[str, float | None] = {key: None for key in ORDER}
    warnings: list[str] = []
    joined = " ".join(b.text for b in boxes)
    basis = "100ml" if re.search(r"100\s?ml", joined, re.I) else "100g" if re.search(r"100\s?g", joined, re.I) else None

    energies = [(b, e) for b in boxes if (e := _energy(b.text)) is not None]
    with_kcal = [pair for pair in energies if "kca" in pair[0].text.lower().replace(" ", "")]
    if energies:
        per_100["kcal"] = min(with_kcal or energies, key=lambda pair: pair[0].x)[1]

    labels: dict[str, Box] = {}
    for box in sorted(boxes, key=lambda b: b.y):
        key = _label(box.text)
        if key and key != "kcal" and key not in labels:
            labels[key] = box

    amounts = [(b, *g) for b in boxes if (g := _grams(b.text)) is not None]
    if amounts:
        width = max(b.x for b in boxes) - min(b.x for b in boxes) or 1
        column = _per_100_column(amounts, width)
        expected = [k for k in ORDER[1:] if k != "fiber" or "fiber" in labels or len(column) == 7]
        if len(column) == len(expected):
            pairs = zip(expected, column)
        else:
            # count does not fit (extra rows, missed boxes): fall back to the nearest number per label
            spacing = median([b.y - a.y for (a, *_), (b, *_) in zip(column, column[1:])] or [0]) or 40
            free = list(column)
            pairs = []
            for key, box in labels.items():
                near = min(free, key=lambda a: abs(a[0].y - box.y), default=None)
                if near and abs(near[0].y - box.y) <= 1.2 * spacing:
                    free.remove(near)
                    pairs.append((key, near))
        for key, (_, value, guessed) in pairs:
            per_100[key] = value
            if guessed and "unit_misread" not in warnings:
                warnings.append("unit_misread")

    core = ("kcal", "fat", "carbs", "protein")
    if any(per_100[k] is None for k in core):
        warnings.append("core_values_missing")
    elif not _plausible(per_100):
        # a lost decimal comma ("85 g" for "8,5 g") is the usual cause; try to put it back
        for key in ("carbs", "fat", "protein"):
            trial = dict(per_100, **{key: per_100[key] / 10})
            if per_100[key] >= 10 and per_100[key] == int(per_100[key]) and _plausible(trial):
                per_100[key] = trial[key]
                warnings.append("decimal_guessed")
                break
        else:
            warnings.append("energy_mismatch")
    for part, whole in (("saturated_fat", "fat"), ("sugars", "carbs")):
        if per_100[part] is not None and per_100[whole] is not None and per_100[part] > per_100[whole] + 0.05:
            warnings.append(f"{part}_exceeds_{whole}")
    if any(v is not None and v > 100 for k, v in per_100.items() if k != "kcal"):
        warnings.append("value_over_100")
    return {"per_100": per_100, "basis": basis, "warnings": warnings}


def read(image: bytes) -> dict:
    """OCR the image and interpret it. The first call loads the models and takes a little longer."""
    global _engine
    try:
        with _engine_lock:
            if _engine is None:
                from rapidocr_onnxruntime import RapidOCR

                _engine = RapidOCR()
            found, _ = _engine(image)
    except Exception as exc:  # the engine raises plain exceptions for unreadable input
        raise OcrFailed(str(exc)[:200] or type(exc).__name__) from exc
    boxes = [
        Box(x=sum(p[0] for p in points) / 4, y=sum(p[1] for p in points) / 4, text=text)
        for points, text, _ in found or []
    ]
    result = interpret(boxes)
    result["text"] = "\n".join(b.text for b in sorted(boxes, key=lambda b: (round(b.y / 25), b.x)))
    return result

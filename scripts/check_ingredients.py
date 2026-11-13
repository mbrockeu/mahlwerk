"""Checks the ingredient matching against a real catalogue and prints the hit rate.

    python scripts/check_ingredients.py [FOLDER-OR-catalog.db] [--all]

FOLDER holds `catalog.db` and `catalog-bls.db` (default: the catalogue next to the default database, see MAHLWERK_DB). Every line of
tests/ingredient_cases.tsv (the table was tuned on it) and tests/ingredient_cases_heldout.tsv (it was not) is read and matched with an empty list of own foods; the suggested food (or, without a suggestion, none)
must match the regular expression of the line (`-`: no suggestion is the right answer, the food is not in the BLS). Prints the rate and every miss. Exit code 1 below 90 %."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mahlwerk import ingredients  # noqa: E402
from mahlwerk.catalog import Catalog, default_path  # noqa: E402

CASES = Path(__file__).resolve().parents[1] / "tests" / "ingredient_cases.tsv"
HELD_OUT = CASES.with_name("ingredient_cases_heldout.tsv")


def load_cases(path: Path = CASES) -> list[tuple[str, str]]:
    cases = []
    for row in path.read_text(encoding="utf-8").splitlines():
        if row.strip() and not row.startswith("#"):
            text, _, expected = row.partition("\t")
            cases.append((text, expected))
    return cases


def suggestion(catalog: Catalog, text: str):
    line = ingredients.parse_line(text)
    found = ingredients.candidates(line.name, [], catalog, None, context=line.text, canned=line.canned)
    return line, (found[0] if found and found[0].good else None), found


def run(catalog: Catalog, show_all: bool = False, path: Path = CASES) -> tuple[int, int, list[str]]:
    hits, misses = 0, []
    cases = load_cases(path)
    for text, expected in cases:
        _, pick, found = suggestion(catalog, text)
        name = pick.name if pick else None
        ok = (name is None) if expected == "-" else name is not None and re.search(expected, name, re.I) is not None
        hits += ok
        if not ok:
            misses.append(f"{text!r}: got {name!r} (expected /{expected}/); candidates: {[c.name for c in found]}")
        elif show_all:
            print(f"ok   {text!r} -> {name}")
    return hits, len(cases), misses


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    target = Path(args[0]) if args else Path(default_path())
    path = target / "catalog.db" if target.is_dir() else target
    catalog = Catalog(str(path))
    if catalog.info()["bls"]["products"] == 0:
        sys.exit(f"no basic foods (BLS) found next to {path}")
    rate = 1.0
    for path in (CASES, HELD_OUT):
        hits, total, misses = run(catalog, "--all" in sys.argv, path)
        print(f"{path.name}: {hits}/{total} = {100 * hits / total:.1f} % sensible first suggestions")
        print(*misses, sep="\n")
        rate = min(rate, hits / total)
    sys.exit(0 if rate >= 0.9 else 1)

"""Basic foods (BLS): reading the table (.xlsx and .csv), mapping, the catalogue file next to the Open Food Facts one,
search, adopt. The foods below are made up; the repository holds no BLS data."""

import csv
import os
import sqlite3
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import pytest
from fastapi.testclient import TestClient

from mahlwerk import bls, tabular
from mahlwerk.catalog import BLS_FIRST, Catalog, CatalogImportError, import_bls, import_off, main
from mahlwerk.main import create_app

# real header texts of the BLS 4.0 table (a dozen of the columns); the TAG is the first word
HEADER = [
    "BLS Code", "Lebensmittelbezeichnung", "Food name",
    "ENERCC Energie (Kilokalorien) [kcal/100g]", "ENERCC Datenherkunft", "ENERCC Referenz",
    "PROT625 Protein (Nx6,25) [g/100g]", "PROT625 Datenherkunft", "PROT625 Referenz",
    "FAT Fett [g/100g]", "FAT Datenherkunft", "FAT Referenz",
    "CHO Kohlenhydrate, verfügbar [g/100g]", "CHO Datenherkunft", "CHO Referenz",
    "FIBT Ballaststoffe, gesamt [g/100g]", "FIBT Datenherkunft", "FIBT Referenz",
    "NACL Salz (Natriumchlorid) [g/100g]", "NACL Datenherkunft", "NACL Referenz",
    "NA Natrium [mg/100g]", "NA Datenherkunft", "NA Referenz",
    "VITD Vitamin D [µg/100g]", "VITD Datenherkunft", "VITD Referenz",
    "VITC Vitamin C [mg/100g]", "VITC Datenherkunft", "VITC Referenz",
    "CU Kupfer [µg/100g]", "CU Datenherkunft", "CU Referenz",
    "FAMS Fettsäure, einfach ungesättigt, gesamt [g/100g]", "FAMS Datenherkunft", "FAMS Referenz",
    "Hinweis",
]
COLUMN = {h.split()[0]: i for i, h in enumerate(HEADER) if "[" in h}


def food(code, name, name_en, **values):
    row = [""] * len(HEADER)
    row[0], row[1], row[2] = code, name, name_en
    for tag, value in values.items():
        row[COLUMN[tag]] = value
        row[COLUMN[tag] + 1] = "Formelberechnung"
    return row


ROWS = [
    food("X100000", "Zauberapfel roh", "Magic apple, raw", ENERCC="52", PROT625="0,3", FAT="0.4", CHO="11.4", FIBT="2",
         NACL="0.01", NA="4", VITD="-", VITC="12", CU="45", FAMS="0.01"),
    food("X100100", "Zauberapfel getrocknet", "Magic apple, dried", ENERCC="240", PROT625="1", FAT="1", CHO="55", FIBT="9",
         VITC="TR", NA="<LOD", VITD=""),
    food("X100200", "Zauberapfelmus mit Zucker", "Magic apple sauce, sweetened", ENERCC="80", PROT625="0.2", FAT="0.1",
         CHO="19", FIBT="1"),
    food("X200000", "Mondbrot", "Moon bread", ENERCC="250", PROT625="8", FAT="2", CHO="49", FIBT="3", NACL="1.2", NA="480",
         VITD="0.1", CU="150"),
    food("X300000", "Ohne Energie", "No energy", PROT625="1"),
    food("X300100", "Unsinn", "Nonsense", ENERCC="2000", PROT625="1", FAT="1", CHO="1"),
    food("X300200", "Zu viel", "Too much", ENERCC="400", PROT625="50", FAT="50", CHO="50"),
    food("", "Ohne Code", "No code", ENERCC="100"),
    [],
]


def write_xlsx(path: Path, rows=ROWS, header=HEADER, inline_last=False) -> str:
    """A minimal workbook: shared strings for text, plain numbers, an inline string, empty cells left out."""
    shared: list[str] = []

    def column(index: int) -> str:
        name = ""
        index += 1
        while index:
            index, rest = divmod(index - 1, 26)
            name = chr(65 + rest) + name
        return name

    def cell(r: int, c: int, value: str, inline: bool) -> str:
        ref = f"{column(c)}{r}"
        try:
            float(value)
            return f'<c r="{ref}"><v>{value}</v></c>'
        except ValueError:
            pass
        if inline:
            return f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
        shared.append(value)
        return f'<c r="{ref}" t="s"><v>{len(shared) - 1}</v></c>'

    body = []
    for r, row in enumerate([header, *rows], 1):
        cells = "".join(cell(r, c, v, inline_last and r == len(rows)) for c, v in enumerate(row) if v != "")
        body.append(f'<row r="{r}">{cells}</row>')
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    parts = {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        "xl/workbook.xml": f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                           '<sheets><sheet name="Daten" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                                      '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{ns}"><sheetData>{"".join(body)}</sheetData></worksheet>',
    }
    parts["xl/sharedStrings.xml"] = f'<sst xmlns="{ns}">' + "".join(f"<si><t>{escape(s)}</t></si>" for s in shared) + "</sst>"
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return str(path)


def write_csv(path: Path, delimiter=";", rows=ROWS) -> str:
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle, delimiter=delimiter)
        writer.writerow(HEADER)
        writer.writerows(r for r in rows if r)
    return str(path)


@pytest.fixture
def table(tmp_path):
    return write_xlsx(tmp_path / "bls.xlsx")


@pytest.fixture
def bls_path(tmp_path):
    """Where a default app (database tmp_path/test.db) looks for the basic foods."""
    return str(tmp_path / "catalog-bls.db")


@pytest.fixture
def loaded(bls_path, table):
    import_bls(bls_path, table)
    return Catalog(str(Path(bls_path).with_name("catalog.db")))


def get(catalog: Catalog, code: str) -> dict:
    item = catalog.get("bls", code)
    assert item is not None
    return item


# reading the table


def test_xlsx_rows_cover_shared_inline_and_missing_cells(tmp_path):
    rows = list(tabular.read_rows(write_xlsx(tmp_path / "a.xlsx", inline_last=True)))
    assert rows[0] == HEADER
    assert rows[1][:3] == ["X100000", "Zauberapfel roh", "Magic apple, raw"]
    assert rows[1][COLUMN["ENERCC"]] == "52" and rows[1][COLUMN["VITD"]] == "-"  # text is kept as it is; the caller decides
    assert rows[-1] == []  # an empty row
    assert len(rows) == len(ROWS) + 1


def test_csv_variant_reads_like_the_workbook(tmp_path):
    for delimiter in (";", ",", "\t"):
        rows = list(tabular.read_rows(write_csv(tmp_path / "t.csv", delimiter)))
        assert rows[0] == HEADER and rows[1][1] == "Zauberapfel roh"
    plain = tmp_path / "plain.txt"
    plain.write_text("just words\nmore words\n")
    with pytest.raises(tabular.TableError):
        list(tabular.read_rows(str(plain)))


def test_unreadable_tables(tmp_path):
    broken = tmp_path / "broken.xlsx"
    with zipfile.ZipFile(broken, "w") as archive:
        archive.writestr("readme.txt", "no sheet")
    with pytest.raises(tabular.TableError):
        list(tabular.read_rows(str(broken)))
    other = write_xlsx(tmp_path / "other.xlsx", rows=[["a", "b"]], header=["Name", "Wert"])
    with pytest.raises(bls.BlsError):
        import_bls(str(tmp_path / "x.db"), other)
    assert not (tmp_path / "x.db").exists() and not (tmp_path / "x.db.new").exists()


# import


def test_import_counts_and_reasons(bls_path, table):
    stats = import_bls(bls_path, table)
    assert stats.read == len(ROWS) and stats.kept == 4
    assert stats.dropped == {"no_energy": 1, "implausible": 2, "no_name": 1}
    assert Catalog(str(Path(bls_path).with_name("catalog.db"))).info()["bls"]["products"] == 4


def test_mapping_uses_tags_and_converts_units(loaded):
    apple = get(loaded, "X100000")
    assert apple["name"] == "Zauberapfel roh" and apple["name_en"] == "Magic apple, raw" and apple["brand"] is None
    assert apple["unit"] == "g" and apple["serving_quantity"] is None and apple["complete"] is True
    assert apple["per_100"] == {"kcal": 52, "fat": 0.4, "saturated_fat": None, "carbs": 11.4, "sugars": None,
                                "fiber": 2, "protein": 0.3, "salt": 0.01}  # decimal comma read
    # BLS quotes copper in µg, the directory uses mg; sodium mg stays mg; "-" is unknown
    assert apple["extra"] == {"sodium": 4, "copper": 0.045, "vitamin_c": 12, "monounsaturated_fat": 0.01}
    assert "vitamin_d" not in apple["extra"]
    assert get(loaded, "X200000")["extra"]["vitamin_d"] == 0.1


def test_trace_and_below_detection_count_as_zero_and_empty_as_unknown(loaded):
    dried = get(loaded, "X100100")
    assert dried["extra"]["vitamin_c"] == 0 and dried["extra"]["sodium"] == 0
    assert "vitamin_d" not in dried["extra"]
    assert bls.parse_value("-") is None and bls.parse_value("") is None and bls.parse_value("abc") is None
    assert bls.parse_value("<LOQ") == 0 and bls.parse_value("<LOD or <LOQ") == 0 and bls.parse_value("1,5") == 1.5


def test_missing_tag_does_not_abort_the_import(tmp_path, bls_path):
    drop = {i for i, h in enumerate(HEADER) if h.startswith(("NACL", "VITC"))}
    header = [h for i, h in enumerate(HEADER) if i not in drop]
    rows = [[v for i, v in enumerate(r) if i not in drop] for r in ROWS if r]
    stats = import_bls(bls_path, write_xlsx(tmp_path / "less.xlsx", rows=rows, header=header))
    assert stats.kept == 4 and "NACL" in stats.missing and "VITC" in stats.missing
    assert "salt" not in stats.mapped and "vitamin_c" not in stats.mapped
    assert stats.mapped["kcal"] == ("ENERCC", "kcal") and stats.mapped["copper"] == ("CU", "µg")
    item = Catalog(str(tmp_path / "catalog.db")).get("bls", "X100000")
    assert item["per_100"]["salt"] is None and "vitamin_c" not in item["extra"]


def test_energy_falls_back_to_kilojoule(tmp_path, bls_path):
    header = [*HEADER[:3], "ENERCJ Energie (Kilojoule) [kJ/100g]", "ENERCJ Datenherkunft", "ENERCJ Referenz", *HEADER[3:]]
    row = ["X1", "Nur Kilojoule", "Only kilojoule", "418.4", "", "", *[""] * (len(HEADER) - 3)]
    import_bls(bls_path, write_xlsx(tmp_path / "kj.xlsx", rows=[row], header=header))
    assert Catalog(str(tmp_path / "catalog.db")).get("bls", "X1")["per_100"]["kcal"] == 100


def test_csv_import_gives_the_same_foods(tmp_path, bls_path):
    other = str(tmp_path / "from-csv.db")
    import_bls(bls_path, write_xlsx(tmp_path / "a.xlsx"))
    import_bls(other, write_csv(tmp_path / "a.csv"))
    one, two = Catalog("x", bls_path), Catalog("x", other)
    assert get(one, "X200000") == get(two, "X200000")


def test_failed_import_keeps_the_old_file(tmp_path, bls_path, table):
    import_bls(bls_path, table)
    empty = write_xlsx(tmp_path / "none.xlsx", rows=[food("X9", "Ohne Energie", "x")])
    with pytest.raises(CatalogImportError):
        import_bls(bls_path, empty)
    assert not os.path.exists(bls_path + ".new")
    assert sqlite3.connect(bls_path).execute("SELECT count(*) FROM product").fetchone()[0] == 4


def test_command_line(tmp_path, table, capsys):
    dest = str(tmp_path / "cli.db")
    assert main(["import-bls", table, "--db", dest]) == 0
    err = capsys.readouterr().err
    assert "4 foods kept" in err and "4 discarded" in err and "tags missing in the table: " in err
    assert Catalog("x", dest).get("bls", "X100000")["name"] == "Zauberapfel roh"
    assert main(["import-bls", str(tmp_path / "missing.xlsx"), "--db", dest]) == 1


# two catalogue files side by side


OFF_HEADER = (Path(__file__).parent / "off_header.tsv").read_text().rstrip("\n").split("\t")


def off_file(tmp_path, names):
    import gzip

    lines = []
    for i, name in enumerate(names):
        fields = {"code": f"40000000{i:04d}", "product_name": name, "countries_tags": "en:germany", "energy-kcal_100g": "100"}
        lines.append("\t".join(fields.get(c, "") for c in OFF_HEADER))
    path = tmp_path / "off.csv.gz"
    path.write_bytes(gzip.compress(("\n".join(["\t".join(OFF_HEADER), *lines]) + "\n").encode()))
    return str(path)


def test_each_import_replaces_only_its_own_file(tmp_path, bls_path, table):
    off_path = str(tmp_path / "catalog.db")
    import_off(off_path, ["en:germany"], off_file(tmp_path, ["Zauberapfel Marke", "Anderes"]))
    import_bls(bls_path, table)
    catalog = Catalog(off_path)
    assert catalog.bls_path == bls_path
    assert catalog.info()["products"] == 2 and catalog.info()["bls"]["products"] == 4
    before = catalog.info()
    import_off(off_path, ["en:germany"], off_file(tmp_path, ["Nur eins"]))
    assert catalog.info()["products"] == 1 and catalog.info()["bls"] == before["bls"]
    import_bls(bls_path, write_xlsx(tmp_path / "small.xlsx", rows=ROWS[:1]))
    assert catalog.info()["products"] == 1 and catalog.info()["bls"]["products"] == 1


def test_bls_file_location(monkeypatch, tmp_path):
    assert Catalog(str(tmp_path / "x" / "catalog.db")).bls_path == str(tmp_path / "x" / "catalog-bls.db")
    monkeypatch.setenv("MAHLWERK_CATALOG_BLS_DB", str(tmp_path / "other.db"))
    assert Catalog(str(tmp_path / "catalog.db")).bls_path == str(tmp_path / "other.db")


def test_missing_file_of_one_source_is_empty(tmp_path, bls_path, table):
    import_bls(bls_path, table)  # no Open Food Facts file at all
    catalog = Catalog(str(tmp_path / "catalog.db"))
    assert [h["code"] for h in catalog.search("zauberapfel", source="bls")][0] == "X100000"
    assert catalog.search("zauberapfel", source="openfoodfacts") == []
    assert [h["source"] for h in catalog.search("zauberapfel")] == ["bls"] * 3


# search


def codes(catalog, query, **kw):
    return [h["code"] for h in catalog.search(query, **kw)]


def test_search_in_german_and_english_with_basics_ranked(loaded):
    assert codes(loaded, "zauberapfel") == ["X100000", "X100100", "X100200"]  # raw form first, then the shorter name
    assert codes(loaded, "magic apple") == ["X100000", "X100100", "X100200"]
    assert codes(loaded, "zauberäpfel") == codes(loaded, "zauberapfel")  # diacritics are folded
    assert codes(loaded, "zauberapfelsaft") == []  # no stemming
    assert codes(loaded, "apple dried") == ["X100100"]
    assert codes(loaded, "mondbr") == ["X200000"] and codes(loaded, "moon") == ["X200000"]
    assert codes(loaded, "nichts") == []


def test_raw_form_beats_a_slightly_shorter_preparation(tmp_path, bls_path):
    rows = [food("A1", "Birne gekocht", "Pear, boiled", ENERCC="40"), food("A2", "Birne roh", "Pear, raw", ENERCC="50"),
            food("A3", "Birne Konserve gezuckert", "Pear, canned", ENERCC="60"),
            food("A4", "Birnenschnaps", "Pear brandy", ENERCC="200")]
    import_bls(bls_path, write_xlsx(tmp_path / "p.xlsx", rows=rows))
    assert codes(Catalog(str(tmp_path / "catalog.db")), "birne")[:3] == ["A2", "A1", "A3"]
    assert codes(Catalog(str(tmp_path / "catalog.db")), "birn")[0] == "A2"


def test_search_lists_basics_first_up_to_eight_then_packaged(tmp_path, bls_path):
    rows = [food(f"B{i}", f"Brot Sorte {i}", f"Bread kind {i}", ENERCC="200") for i in range(12)]
    import_bls(bls_path, write_xlsx(tmp_path / "b.xlsx", rows=rows))
    off_path = str(tmp_path / "catalog.db")
    import_off(off_path, ["en:germany"], off_file(tmp_path, [f"Brot Marke {i}" for i in range(20)]))
    catalog = Catalog(off_path)
    sources = [h["source"] for h in catalog.search("brot", limit=25)]
    assert sources == ["bls"] * BLS_FIRST + ["openfoodfacts"] * 17
    assert len(catalog.search("brot", limit=5)) == 5 and {h["source"] for h in catalog.search("brot", limit=5)} == {"bls"}
    assert len(catalog.search("brot", limit=25, source="bls")) == 12
    assert {h["source"] for h in catalog.search("brot", limit=25, source="openfoodfacts")} == {"openfoodfacts"}
    assert catalog.search("brot", source="nothing") == []


def test_search_route_with_source_filter_and_known_items_left_out(client, tmp_path, loaded):
    items = client.get("/api/v1/catalog", params={"q": "zauberapfel"}).json()
    assert [i["code"] for i in items] == ["X100000", "X100100", "X100200"]
    assert items[0]["source"] == "bls" and items[0]["name_en"] == "Magic apple, raw"
    assert client.get("/api/v1/catalog", params={"q": "zauberapfel", "source": "openfoodfacts"}).json() == []
    assert len(client.get("/api/v1/catalog", params={"q": "zauberapfel", "source": "bls", "limit": 2}).json()) == 2
    assert client.get("/api/v1/catalog", params={"q": "zauberapfel", "source": "x"}).status_code == 422
    client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "X100000"})
    assert [i["code"] for i in client.get("/api/v1/catalog", params={"q": "zauberapfel"}).json()] == ["X100100", "X100200"]


# adopt, /me, diary


def test_adopt_creates_a_food_once(client, loaded):
    ref = {"source": "bls", "code": "X100000"}
    created = client.post("/api/v1/catalog/adopt", json=ref)
    assert created.status_code == 201
    food = created.json()
    assert food["source"] == "bls" and food["code"] is None and food["name"] == "Zauberapfel roh"
    assert food["unit"] == "g" and food["serving_quantity"] is None and food["per_100"]["kcal"] == 52
    again = client.post("/api/v1/catalog/adopt", json=ref)
    assert again.status_code == 200 and again.json()["id"] == food["id"]
    assert [f["id"] for f in client.get("/api/v1/foods", params={"source": "bls"}).json()] == [food["id"]]
    assert client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "nope"}).status_code == 404


def test_editing_an_adopted_basic_food_makes_it_own(client, loaded):
    food = client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "X200000"}).json()
    body = {"name": "Mein Mondbrot", "per_100": food["per_100"], "extra": food["extra"]}
    edited = client.put(f"/api/v1/foods/{food['id']}", json=body)
    assert edited.status_code == 200 and edited.json()["source"] == "own"


def test_me_reports_both_sources(client, tmp_path, loaded):
    info = client.get("/api/v1/me").json()["catalog"]
    assert info["products"] == 0 and info["updated_at"] is None
    assert info["bls"]["products"] == 4 and info["bls"]["updated_at"] > 1_700_000_000


def test_diary_entry_of_a_basic_food_carries_its_micronutrients(client, loaded):
    food = client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "X100000"}).json()
    r = client.post("/api/v1/diary/2025-03-10/entries", json={"food_id": food["id"], "meal": "snack", "amount": 150})
    assert r.status_code == 201 and r.json()["kcal"] == 78
    day = client.get("/api/v1/diary/2025-03-10").json()
    assert day["extra_totals"]["vitamin_c"]["amount"] == pytest.approx(18)
    assert day["extra_totals"]["copper"]["amount"] == pytest.approx(0.0675, abs=1e-3)


def test_demo_cleanup_leaves_basic_foods_alone(tmp_path, monkeypatch, bls_path, table):
    import_bls(bls_path, table)
    monkeypatch.setenv("MAHLWERK_DEMO_DATA", "1")
    client = TestClient(create_app(str(tmp_path / "test.db")))
    food = client.post("/api/v1/catalog/adopt", json={"source": "bls", "code": "X100000"}).json()
    assert client.post("/api/v1/me/demo-data", json={"days": 3}).status_code in (200, 201)
    assert client.delete("/api/v1/me/demo-data").status_code in (200, 204)
    assert client.get(f"/api/v1/foods/{food['id']}").status_code == 200


# the real table (optional)

REAL = os.environ.get("MAHLWERK_TEST_BLS_FILE")


def test_real_table(tmp_path):
    if not REAL or not os.path.isfile(REAL):
        pytest.skip("set MAHLWERK_TEST_BLS_FILE to the BLS 4.0 workbook to run this")
    dest = str(tmp_path / "catalog-bls.db")
    stats = import_bls(dest, REAL)
    assert stats.kept > 7000 and stats.missing == []
    catalog = Catalog(str(tmp_path / "catalog.db"))
    core = sqlite3.connect(dest).execute(
        "SELECT count(*) FROM product WHERE kcal IS NOT NULL AND fat IS NOT NULL AND carbs IS NOT NULL "
        "AND protein IS NOT NULL").fetchone()[0]
    assert core / stats.kept > 0.95
    apple = next(h for h in catalog.search("apfel", source="bls") if h["name"].lower().startswith("apfel"))
    assert 40 <= apple["per_100"]["kcal"] <= 70 and apple["extra"]["vitamin_c"] > 1
    oats = next(h for h in catalog.search("hafer flocken", source="bls"))
    assert 300 <= oats["per_100"]["kcal"] <= 420 and 8 <= oats["per_100"]["protein"] <= 18
    assert 40 <= catalog.search("vollmilch", source="bls")[0]["per_100"]["kcal"] <= 80


def test_compound_word_finds_a_name_written_with_a_space(tmp_path, bls_path):
    rows = [food("H1", "Hafer Flocken, Vollkorn", "Oat flakes, wholegrain", ENERCC="370"),
            food("H2", "Hafer-Flocken zart", "Oat flakes, fine", ENERCC="372"),
            food("H3", "Müsli mit Haferflocken", "Muesli with oat flakes", ENERCC="360"),
            food("H4", "Haferbrei", "Porridge", ENERCC="70")]
    import_bls(bls_path, write_xlsx(tmp_path / "h.xlsx", rows=rows))
    catalog = Catalog(str(tmp_path / "catalog.db"))
    # the compound spelling finds both spaced names, before the name that only contains the word
    found = codes(catalog, "haferflocken")
    assert set(found[:2]) == {"H1", "H2"} and found[2:] == ["H3"]
    assert set(codes(catalog, "oatflakes")) == {"H1", "H2"}  # the English name too
    assert codes(catalog, "haferflocken", limit=2, source="bls")[-1] != "H3"
    assert codes(catalog, "haferbr") == ["H4"]


def test_compound_search_is_skipped_when_enough_names_start_with_the_word(tmp_path, bls_path):
    rows = [food(f"K{i}", f"Kartoffel Sorte {i}", f"Potato kind {i}", ENERCC="70") for i in range(3)]
    rows.append(food("K9", "Kartoffel Salat", "Potato salad", ENERCC="100"))
    rows.append(food("K8", "Karto Ffelchips", "Chips", ENERCC="500"))
    import_bls(bls_path, write_xlsx(tmp_path / "k.xlsx", rows=rows))
    assert "K8" not in codes(Catalog(str(tmp_path / "catalog.db")), "kartoffel")


def test_compound_search_works_on_a_file_without_the_compact_columns(tmp_path, bls_path):
    rows = [food("H1", "Hafer Flocken", "Oat flakes", ENERCC="370"), food("H3", "Müsli mit Haferflocken", "Muesli", ENERCC="360")]
    import_bls(bls_path, write_xlsx(tmp_path / "h.xlsx", rows=rows))
    con = sqlite3.connect(bls_path)
    con.execute("DROP INDEX product_name_compact")
    con.execute("DROP INDEX product_name_compact_en")
    con.execute("ALTER TABLE product DROP COLUMN name_compact")
    con.execute("ALTER TABLE product DROP COLUMN name_compact_en")
    con.commit()
    con.close()
    catalog = Catalog(str(tmp_path / "catalog.db"))
    assert codes(catalog, "haferflocken") == ["H3"]  # as before: only the name with the word itself
    assert codes(catalog, "hafer") == ["H1", "H3"]


def test_compound_search_in_the_packaged_products(tmp_path):
    off_path = str(tmp_path / "catalog.db")
    import_off(off_path, ["en:germany"], off_file(tmp_path, ["Hafer Flocken zart", "Müsli mit Haferflocken"]))
    assert [h["name"] for h in Catalog(off_path).search("haferflocken", source="openfoodfacts")] == ["Hafer Flocken zart", "Müsli mit Haferflocken"]


def test_whole_name_written_apart_comes_first_even_with_many_prefix_hits(tmp_path):
    from mahlwerk import catalog as cat

    path = tmp_path / "bls.db"
    names = ["Haferflocken-Kekse", "Haferflocken gesüßt", "Haferflocken mit Milch", "Haferflocken-Brei", "Hafer Flocken"]
    con = sqlite3.connect(path)
    con.executescript(cat.SCHEMA)
    for i, name in enumerate(names):
        con.execute(
            "INSERT INTO product (source, code, name, unit, kcal, popularity, name_key, name_compact) "
            "VALUES ('bls', ?, ?, 'g', 100, 0, ?, ?)",
            (f"X{i}", name, cat.name_key(name), cat.name_compact(name)),
        )
    con.commit()
    con.close()
    hits = cat.Catalog(str(tmp_path / "off.db"), str(path)).search("haferflocken", source="bls", limit=5)
    assert hits and hits[0]["name"] == "Hafer Flocken"

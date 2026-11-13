"""Product catalogue: import from the Open Food Facts CSV export, search, adopt, barcode lookup. No network."""

import gzip
import sqlite3
from pathlib import Path

import pytest
from conftest import NUTELLA
from fastapi.testclient import TestClient

from mahlwerk.catalog import Catalog, CatalogImportError, import_off, main
from mahlwerk.main import create_app

HEADER = (Path(__file__).parent / "off_header.tsv").read_text().rstrip("\n").split("\t")
assert len(HEADER) == 211


def ean(base: str) -> str:
    """Complete a 12-digit base with its EAN-13 check digit."""
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(base))
    return base + str((10 - total % 10) % 10)


def line(code, name, kcal="100", country="en:germany", **extra):
    """One CSV line with the real 211 columns; unnamed ones stay empty."""
    fields = {"code": code, "product_name": name, "countries_tags": country, "energy-kcal_100g": kcal, **extra}
    unknown = set(fields) - set(HEADER)
    assert not unknown, unknown
    return "\t".join(fields.get(column, "") for column in HEADER)


def per(fat="1", carbs="10", protein="2", **extra):
    return {"fat_100g": fat, "carbohydrates_100g": carbs, "proteins_100g": protein, **extra}


ROWS = [
    line(ean("400000000001"), "Apfel", "47", **per("0.3", "11", "0.4", **{"sugars_100g": "10", "unique_scans_n": "3"}),
         quantity="1 kg", serving_size="150 g", serving_quantity="150"),
    line(ean("400000000002"), "Apfelschorle Holunder Bio 6x1,5 l", "22", **per("0", "5", "0"), quantity="6x1,5 l",
         unique_scans_n="120"),
    line(ean("400000000003"), "Bio Apfel Chips", "350", **per("1", "80", "2")),
    line(ean("400000000004"), "Apfelmus", "55", **per("0.1", "13", "0.3")),
    line(ean("400000000005"), "Äpfel, bio", "45", **per("0.2", "10", "0.3")),
    line(ean("400000000006"), "Haferflocken zart", "372", **per("7", "59", "13.5", **{"salt_100g": "0.02"}),
         brands="Kölln, Andere"),
    line(ean("400000000007"), 'Müsli "Crunchy" (Test)-Mix*', "400", **per("8", "60", "10")),
    line(ean("400000000008"), "Nur kJ", "", **per("1", "10", "2"), **{"energy_100g": "1000"}),
    line(ean("400000000009"), "Cola Zero", "0", **per("0", "0", "0"), quantity="1,5 l"),
    line(NUTELLA, "Nutella aus dem Katalog", "539", **per("30.9", "57.5", "6.3"), brands="Ferrero"),
    # not wanted
    line("3000000000011", "Pomme", "52", country="en:france"),
    line(ean("400000000010"), "Ohne Kalorien", ""),
    line(ean("400000000011"), "", "100"),
    line(ean("400000000012"), "Zu viele kcal", "5000"),
    line(ean("400000000013"), "Zu viele Kohlenhydrate", "300", **per("1", "150", "2")),
    line(ean("400000000014"), "Negatives Fett", "100", **per("-5", "10", "2")),
    line(ean("400000000015"), "Zusammen über 100", "400", **per("60", "60", "30")),
    "4000000000164\tzu kurze Zeile",
]
# a row seen from both countries and a duplicate code: one product
ROWS.append(line(ean("400000000001"), "Apfel", "47", country="en:germany,en:austria", **per("0.3", "11", "0.4"),
                  serving_quantity="150"))


def gz(path: Path, rows=ROWS, header=HEADER) -> str:
    path.write_bytes(gzip.compress(("\n".join(["\t".join(header), *rows]) + "\n").encode()))
    return str(path)


@pytest.fixture
def source(tmp_path):
    return gz(tmp_path / "off.csv.gz")


@pytest.fixture
def catalog_path(tmp_path):
    """Where a default app (database tmp_path/test.db) looks for the catalogue."""
    return str(tmp_path / "catalog.db")


@pytest.fixture
def filled(catalog_path, source):
    import_off(catalog_path, ["en:germany"], source)
    return Catalog(catalog_path)


# import


def test_import_filters_and_counts(catalog_path, source):
    stats = import_off(catalog_path, ["en:germany"], source)
    assert stats.read == len(ROWS)
    assert stats.kept == 10  # nine distinct wanted codes plus Nutella; the duplicate collapses
    assert stats.other_country == 1
    assert stats.incomplete == 2  # no energy, no name
    assert stats.nonsense == 4
    assert stats.broken == 1
    assert stats.truncated is False
    info = Catalog(catalog_path).info()
    assert info["products"] == 10 and info["updated_at"] > 1_700_000_000


def test_import_converts_values(filled):
    apple = filled.get("openfoodfacts", ean("400000000001"))
    assert apple["name"] == "Apfel" and apple["unit"] == "g"
    assert apple["per_100"] == {"kcal": 47, "fat": 0.3, "saturated_fat": None, "carbs": 11, "sugars": None,
                                "fiber": None, "protein": 0.4, "salt": None}
    assert apple["complete"] is True
    spritzer = filled.search("apfelschorle")[0]
    assert spritzer["unit"] == "ml" and spritzer["quantity"] == "6x1,5 l"
    oats = filled.get("openfoodfacts", ean("400000000006"))
    assert oats["brand"] == "Kölln" and oats["per_100"]["salt"] == 0.02
    kj = filled.get("openfoodfacts", ean("400000000008"))
    assert kj["per_100"]["kcal"] == 239.0  # 1000 kJ
    assert filled.get("openfoodfacts", "3000000000011") is None  # other country
    assert filled.get("openfoodfacts", ean("400000000012")) is None  # implausible
    assert filled.get("openfoodfacts", "nope") is None


def test_import_several_countries(catalog_path, source):
    stats = import_off(catalog_path, ["en:germany", "France"], source)
    assert stats.kept == 11 and stats.other_country == 0
    assert Catalog(catalog_path).get("openfoodfacts", "3000000000011")["name"] == "Pomme"


def test_import_of_a_cut_off_file_keeps_what_was_complete(tmp_path, catalog_path):
    full = gzip.compress(("\n".join(["\t".join(HEADER), *ROWS]) + "\n").encode())
    cut = tmp_path / "cut.csv.gz"
    cut.write_bytes(full[: len(full) - 30])
    stats = import_off(catalog_path, ["en:germany"], str(cut))
    assert stats.truncated is True
    assert stats.kept > 0
    assert Catalog(catalog_path).get("openfoodfacts", ean("400000000001")) is not None


def test_import_rejects_unusable_sources(tmp_path, catalog_path):
    with pytest.raises(CatalogImportError, match="columns missing"):
        import_off(catalog_path, ["en:germany"], gz(tmp_path / "a.gz", header=HEADER[:50]))
    with pytest.raises(CatalogImportError, match="gzip"):
        plain = tmp_path / "plain.csv"
        plain.write_text("\t".join(HEADER) + "\n")
        import_off(catalog_path, ["en:germany"], str(plain))
    with pytest.raises(CatalogImportError, match="no country"):
        import_off(catalog_path, [], gz(tmp_path / "b.gz"))
    assert not Path(catalog_path).exists() and not Path(catalog_path + ".new").exists()


def test_import_swaps_atomically_and_keeps_the_old_file_on_failure(tmp_path, catalog_path, source):
    import_off(catalog_path, ["en:germany"], source)
    reading = sqlite3.connect(f"file:{catalog_path}?mode=ro", uri=True)  # a running server mid-request
    before = reading.execute("SELECT count(*) FROM product").fetchone()[0]

    second = gz(tmp_path / "second.csv.gz", [line(ean("400000000020"), "Nur das hier", "10", **per())])
    import_off(catalog_path, ["en:germany"], second)
    assert reading.execute("SELECT count(*) FROM product").fetchone()[0] == before  # old file still readable
    reading.close()
    fresh = Catalog(catalog_path)
    assert fresh.info()["products"] == 1 and fresh.get("openfoodfacts", ean("400000000020"))
    assert not Path(catalog_path + ".new").exists()

    with pytest.raises(CatalogImportError, match="no product matched"):
        import_off(catalog_path, ["en:spain"], source)
    assert fresh.info()["products"] == 1  # untouched
    assert not Path(catalog_path + ".new").exists()


def test_command_line(tmp_path, source, capsys):
    target = tmp_path / "cli" / "catalog.db"
    assert main(["import-off", "--source", source, "--db", str(target), "--country", "en:germany"]) == 0
    assert "10 products kept" in capsys.readouterr().err
    assert Catalog(str(target)).info()["products"] == 10
    assert main(["import-off", "--source", str(tmp_path / "missing.csv.gz"), "--db", str(target)]) == 1


# search


def names(catalog, query, limit=25):
    return [h["name"] for h in catalog.search(query, limit)]


def test_search_prefix_and_diacritics(filled):
    assert "Haferflocken zart" in names(filled, "hafer")
    assert "Haferflocken zart" in names(filled, "HAFERFLOCKEN")
    assert set(names(filled, "apfel")) >= {"Apfel", "Äpfel, bio", "Apfelmus", "Bio Apfel Chips"}
    assert "Äpfel, bio" in names(filled, "äpfel")
    assert "Apfel" in names(filled, "äpfel")


def test_search_needs_every_word_in_name_or_brand(filled):
    assert names(filled, "haferflocken kölln") == ["Haferflocken zart"]  # brand word
    assert names(filled, "kolln hafer") == ["Haferflocken zart"]
    assert names(filled, "hafer zart") == ["Haferflocken zart"]
    assert names(filled, "hafer schorle") == []
    assert names(filled, "apfel bio") and all("Bio" in n or "bio" in n for n in names(filled, "apfel bio"))


def test_search_ranks_simple_products_first(filled):
    found = names(filled, "apfel")
    assert found[0] == "Apfel"
    assert found.index("Apfelmus") < found.index("Apfelschorle Holunder Bio 6x1,5 l")
    assert found[-1] == "Bio Apfel Chips"  # the word is not at the start of the name
    assert len(filled.search("apfel", 2)) == 2


@pytest.mark.parametrize("query", ['"', "*", "(", ")", "-", "ap*", '"apfel', "apfel)", "NEAR(a b)", "a OR b", "^a", "a:b", "'", "\\", "%_", "  "])
def test_search_survives_special_characters(filled, query):
    assert isinstance(filled.search(query), list)


def test_search_with_special_characters_in_the_name(filled):
    assert names(filled, 'müsli "crunchy" (test)-mix*') == ['Müsli "Crunchy" (Test)-Mix*']
    assert names(filled, "crunchy") == ['Müsli "Crunchy" (Test)-Mix*']


def test_missing_catalogue_is_empty(tmp_path):
    empty = Catalog(str(tmp_path / "nothing.db"))
    assert empty.search("apfel") == [] and empty.get("openfoodfacts", "1") is None
    assert empty.info() == {"products": 0, "updated_at": None, "bls": {"products": 0, "updated_at": None}}


def test_concurrent_reads(filled):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: names(filled, "apfel"), range(64)))
    assert all(r == results[0] for r in results)


# API


def test_catalog_search_route(client, filled):
    items = client.get("/api/v1/catalog", params={"q": "apfel"}).json()
    assert items[0]["name"] == "Apfel"
    assert set(items[0]) == {"source", "code", "name", "brand", "quantity", "serving_size", "serving_quantity", "unit",
                             "per_100", "extra", "complete", "name_en"}
    assert items[0]["source"] == "openfoodfacts" and items[0]["code"] == ean("400000000001")
    assert items[0]["serving_quantity"] == 150 and items[0]["complete"] is True
    assert len(client.get("/api/v1/catalog", params={"q": "apfel", "limit": 2}).json()) == 2
    assert client.get("/api/v1/catalog", params={"q": "ä"}).json() == []
    assert client.get("/api/v1/catalog", params={"q": " a "}).json() == []
    assert client.get("/api/v1/catalog").json() == []
    assert client.get("/api/v1/catalog", params={"q": "apfel", "limit": 51}).status_code == 422
    assert client.get("/api/v1/catalog", params={"q": "apfel", "limit": 0}).status_code == 422
    assert client.get("/api/v1/catalog", params={"q": '"*(-'}).json() == []


def test_catalog_limit_defaults_to_25(client, tmp_path, catalog_path):
    rows = [line(f"41000000{i:05d}", f"Brot Nummer {i}", "200", **per()) for i in range(40)]
    import_off(catalog_path, ["en:germany"], gz(tmp_path / "many.gz", rows))
    assert len(client.get("/api/v1/catalog", params={"q": "brot"}).json()) == 25
    assert len(client.get("/api/v1/catalog", params={"q": "brot", "limit": 50}).json()) == 40


def test_adopt_creates_a_food_once(client, filled):
    ref = {"source": "openfoodfacts", "code": ean("400000000001")}
    created = client.post("/api/v1/catalog/adopt", json=ref)
    assert created.status_code == 201
    food = created.json()
    assert food["name"] == "Apfel" and food["code"] == ref["code"] and food["source"] == "openfoodfacts"
    assert food["per_100"]["kcal"] == 47 and food["serving_quantity"] == 150 and food["empty"] is False
    again = client.post("/api/v1/catalog/adopt", json=ref)
    assert again.status_code == 200 and again.json()["id"] == food["id"]
    assert client.get(f"/api/v1/foods/{food['id']}").json()["name"] == "Apfel"
    # a local food is no longer offered by the catalogue
    assert "Apfel" not in [i["name"] for i in client.get("/api/v1/catalog", params={"q": "apfel"}).json()]
    # and can be logged right away
    r = client.post("/api/v1/diary/2025-03-10/entries", json={"food_id": food["id"], "meal": "snack", "amount": 200})
    assert r.status_code == 201 and r.json()["kcal"] == 94


def test_adopt_unknown_product_is_404(client, filled):
    assert client.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": "123"}).status_code == 404
    assert client.post("/api/v1/catalog/adopt", json={"source": "other", "code": "123"}).status_code == 422
    assert client.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts"}).status_code == 422


def test_adopt_replaces_a_remembered_miss(client, tmp_path, catalog_path, upstream):
    other = "4006381333931"
    assert client.get(f"/api/v1/foods/barcode/{other}").status_code == 404  # upstream miss is remembered
    import_off(catalog_path, ["en:germany"], gz(tmp_path / "late.gz", [line(other, "Jetzt im Katalog", "10", **per())]))
    adopted = client.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": other})
    assert adopted.status_code == 201 and adopted.json()["name"] == "Jetzt im Katalog"
    assert upstream.calls == 1


def test_barcode_lookup_uses_the_catalogue_without_upstream(client, filled, upstream):
    first = client.get(f"/api/v1/foods/barcode/{NUTELLA}")
    assert first.status_code == 200
    body = first.json()
    assert body["name"] == "Nutella aus dem Katalog" and body["brand"] == "Ferrero"
    assert body["source"] == "openfoodfacts" and body["cached"] is False
    second = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert second["id"] == body["id"] and second["cached"] is True
    assert upstream.calls == 0


def test_barcode_lookup_prefers_own_food_over_catalogue(client, filled, upstream):
    mine = client.put(f"/api/v1/foods/barcode/{NUTELLA}", json={"name": "Mein Aufstrich", "per_100": {"kcal": 1}})
    assert mine.status_code == 200
    body = client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()
    assert body["name"] == "Mein Aufstrich" and body["source"] == "own"
    assert upstream.calls == 0


def test_barcode_lookup_beats_a_remembered_miss(client, tmp_path, catalog_path, upstream):
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").status_code == 200 and upstream.calls == 1  # no catalogue yet
    other = "4006381333931"
    assert client.get(f"/api/v1/foods/barcode/{other}").status_code == 404  # upstream miss is remembered
    import_off(catalog_path, ["en:germany"], gz(tmp_path / "late.gz", [line(other, "Jetzt im Katalog", "10", **per())]))
    assert client.get(f"/api/v1/foods/barcode/{other}").json()["name"] == "Jetzt im Katalog"
    assert upstream.calls == 2


def test_barcode_lookup_falls_back_to_upstream_when_not_in_catalogue(client, filled, upstream):
    assert client.get("/api/v1/foods/barcode/4006381333931").status_code == 404
    assert upstream.calls == 1


def test_without_catalogue_everything_is_empty(client, upstream):
    assert client.get("/api/v1/catalog", params={"q": "apfel"}).json() == []
    assert client.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": "1"}).status_code == 404
    assert client.get("/api/v1/me").json()["catalog"] == {"products": 0, "updated_at": None, "bls": {"products": 0, "updated_at": None}}
    assert client.get(f"/api/v1/foods/barcode/{NUTELLA}").json()["name"] == "Nutella"  # live lookup as before
    assert upstream.calls == 1


def test_me_reports_the_catalogue(client, filled):
    info = client.get("/api/v1/me").json()["catalog"]
    assert info["products"] == 10 and info["updated_at"] == filled.info()["updated_at"]


def test_catalogue_path_can_be_configured(monkeypatch, tmp_path, source):
    elsewhere = tmp_path / "elsewhere" / "c.db"
    import_off(str(elsewhere), ["en:germany"], source)
    monkeypatch.setenv("MAHLWERK_CATALOG_DB", str(elsewhere))
    app = create_app(str(tmp_path / "x.db"))
    assert TestClient(app).get("/api/v1/me").json()["catalog"]["products"] == 10


def test_catalogue_routes_need_a_login(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    app = create_app(str(tmp_path / "p.db"))
    stranger = TestClient(app, client=("203.0.113.9", 1), headers={"Remote-User": "anna"})
    assert stranger.get("/api/v1/catalog", params={"q": "apfel"}).status_code == 401
    assert stranger.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": "1"}).status_code == 401
    member = TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": "anna"})
    assert member.get("/api/v1/catalog", params={"q": "apfel"}).status_code == 200

"""Recipe pictures: the processing (hostile files), the folder, the delivery, own photos, the provider fetch and its switches.

No test needs a network: the web is `httpx.MockTransport`, names resolve through the fake resolver of conftest. Every picture in
here is made by the tests themselves (flat colours and gradients), none is a photo.
"""

import io
import os
import sqlite3
import struct
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from conftest import DROP_V14
from mahlwerk import cookidoo, imageproc, imagestore
from mahlwerk.cookidoo import NutritionEntry, RecipeDetails
from mahlwerk.db import Store
from mahlwerk.imageproc import ImageRejected
from mahlwerk.main import create_app
from test_cookidoo import fake  # noqa: F401  (the stand-in client)
from test_web_recipes import GOOD, PAGE, Chunks, Web, html

PNG_SIG = b"\x89PNG\r\n\x1a\n"


# ---- pictures made by the tests ----


def gradient(w=1600, h=1200, mode="RGB") -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for x in range(0, w, 8):  # coarse blocks: fast to make, smooth enough to compress
        for y in range(0, h, 8):
            colour = (x * 255 // w, y * 255 // h, 120)
            for dx in range(8):
                for dy in range(8):
                    if x + dx < w and y + dy < h:
                        px[x + dx, y + dy] = colour
    return img.convert(mode) if mode != "RGB" else img


def encode(img: Image.Image, fmt: str, **kw) -> bytes:
    out = io.BytesIO()
    img.save(out, fmt, **kw)
    return out.getvalue()


def jpeg_with_gps(orientation=1) -> bytes:
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "Secret Camera Maker"
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2], gps[3], gps[4] = "N", (52.0, 31.0, 12.0), "E", (13.0, 24.0, 18.0)
    return encode(gradient(400, 200), "JPEG", exif=exif, comment=b"PRIVATE COMMENT")


def decode(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def solid(colour=(10, 120, 200), size=(300, 200), fmt="JPEG") -> bytes:
    return encode(Image.new("RGB", size, colour), fmt)


# ---- processing ----


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_three_formats_give_three_webp_sizes(fmt):
    done = imageproc.process(encode(gradient(1600, 1200), fmt))
    assert set(done.files) == {"l", "m", "s"} and len(done.hash) == 32 and all(c in "0123456789abcdef" for c in done.hash)
    big, mid, small = (decode(done.files[k]) for k in "lms")
    assert big.format == mid.format == small.format == "WEBP"
    assert big.size == (960, 720) and mid.size == (240, 240) and small.size == (96, 96)
    assert (done.width, done.height) == (960, 720)
    assert len(done.files["l"]) < 150 * 1024


def test_a_small_picture_is_not_enlarged():
    done = imageproc.process(solid(size=(300, 200)))
    assert decode(done.files["l"]).size == (300, 200)


def test_same_pixels_give_the_same_name_and_other_pixels_another():
    a, b = imageproc.process(solid((1, 2, 3))), imageproc.process(solid((1, 2, 3)))
    assert a.hash == b.hash and imageproc.process(solid((200, 2, 3))).hash != a.hash


def test_exif_rotation_is_applied_and_every_piece_of_metadata_is_gone():
    source = jpeg_with_gps(orientation=6)
    assert b"Secret Camera Maker" in source and b"PRIVATE COMMENT" in source  # the test picture does carry them
    assert Image.open(io.BytesIO(source)).getexif().get_ifd(0x8825)  # ... and GPS
    done = imageproc.process(source)
    big = decode(done.files["l"])
    assert big.size == (200, 400)  # 400 x 200 turned by the camera's orientation 6
    for name, data in done.files.items():
        for marker in (b"EXIF", b"XMP ", b"ICCP", b"Secret", b"PRIVATE", b"Exif", b"GPS"):
            assert marker not in data, (name, marker)
        image = decode(data)
        assert not image.getexif() and "exif" not in image.info and "icc_profile" not in image.info and "xmp" not in image.info


def test_transparency_lies_on_the_paper_colour():
    img = Image.new("RGBA", (200, 200), (255, 0, 0, 0))
    done = imageproc.process(encode(img, "PNG"))
    r, g, b = decode(done.files["l"]).convert("RGB").getpixel((100, 100))
    assert abs(r - 0xF7) <= 4 and abs(g - 0xF8) <= 4 and abs(b - 0xF5) <= 4


def test_a_palette_png_with_transparency_and_a_cmyk_jpeg_and_a_16_bit_grey_png_work():
    pal = Image.new("P", (50, 50), 0)
    pal.putpalette([255, 0, 0] * 256)
    assert imageproc.process(encode(pal, "PNG", transparency=0)).files["l"]
    assert imageproc.process(encode(Image.new("CMYK", (60, 40), (0, 100, 100, 0)), "JPEG")).files["l"]
    grey = Image.new("I;16", (60, 40), 30000)
    assert imageproc.process(encode(grey, "PNG")).files["l"]


def test_an_animation_becomes_its_first_picture():
    red, blue = Image.new("RGB", (80, 60), (250, 0, 0)), Image.new("RGB", (80, 60), (0, 0, 250))
    data = encode(red, "WEBP", save_all=True, append_images=[blue, Image.new("RGB", (80, 60), (0, 250, 0))], duration=100, loop=0, lossless=True)
    assert getattr(Image.open(io.BytesIO(data)), "n_frames", 1) == 3
    r, g, b = decode(imageproc.process(data).files["l"]).convert("RGB").getpixel((40, 30))
    assert r > 200 and b < 60


def png_claiming(width, height) -> bytes:
    """A PNG whose header claims a size (the rest is a small real picture): refused from the header, never decoded."""
    real = encode(Image.new("RGB", (4, 4), (1, 2, 3)), "PNG")
    return real[:16] + struct.pack(">II", width, height) + real[24:]


@pytest.mark.parametrize("data,kind", [
    (b"", "format"),
    (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "format"),
    (b"GIF89a" + b"\x01\x00\x01\x00" + b"\x00" * 40, "format"),
    (encode(Image.new("RGB", (10, 10)), "GIF"), "format"),
    (encode(Image.new("RGB", (10, 10)), "BMP"), "format"),
    (b"not a picture at all" * 50, "format"),
    (png_claiming(50000, 50000), "too_many_pixels"),
    (png_claiming(7000, 6000), "too_many_pixels"),
    (b"\xff\xd8" + b"\xff\xc0\x00\x11\x08" + struct.pack(">HH", 30000, 30000) + b"\x03" + b"\x00" * 20, "too_many_pixels"),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 30, "format"),
])
def test_hostile_or_wrong_files_are_refused_with_a_reason(data, kind):
    with pytest.raises(ImageRejected) as excinfo:
        imageproc.process(data)
    assert excinfo.value.kind == kind and str(excinfo.value)


def test_a_truncated_or_corrupt_picture_is_refused_not_a_crash():
    whole = encode(gradient(800, 600), "JPEG")
    for cut in (whole[:len(whole) // 2], whole[:300], whole[:-5000]):
        try:
            done = imageproc.process(cut)  # a decoder may make do with a short tail: then it is a picture
            assert done.files["l"]
        except ImageRejected as exc:
            assert exc.kind in ("broken", "format")
    noise = Image.frombytes("RGB", (200, 200), os.urandom(200 * 200 * 3))
    png = encode(noise, "PNG")
    with pytest.raises(ImageRejected):
        imageproc.process(png[:len(png) // 2])
    with pytest.raises(ImageRejected):
        imageproc.process(png[:200] + b"\x00" * 400 + png[600:])


def test_too_large_a_file_is_refused_before_anything_runs():
    with pytest.raises(ImageRejected) as excinfo:
        imageproc.process(b"\xff\xd8" + b"\x00" * (imageproc.MAX_INPUT_BYTES + 1))
    assert excinfo.value.kind == "too_large"


def test_a_child_that_hangs_or_cannot_start_is_a_refusal(monkeypatch):
    def hang(*a, **k):
        raise subprocess.TimeoutExpired("x", 1)

    monkeypatch.setattr(subprocess, "run", hang)
    with pytest.raises(ImageRejected) as excinfo:
        imageproc.process(solid())
    assert excinfo.value.kind == "broken"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no such file")))
    with pytest.raises(ImageRejected) as excinfo:
        imageproc.process(solid())
    assert excinfo.value.kind == "unavailable"


def test_the_child_runs_with_limits_and_refuses_to_start_by_accident():
    # run by hand without the guard variable: refuses
    done = subprocess.run([os.sys.executable, "-I", "-m", "mahlwerk.imageproc"], input=solid(), capture_output=True, env={})
    assert done.returncode == 2 and done.stdout == b""
    # a big flat picture (far inside the limits) is fine and quick
    big = encode(Image.new("RGB", (5000, 4500), (30, 60, 90)), "PNG")
    assert len(big) < 200_000
    assert decode(imageproc.process(big).files["l"]).size == (960, 864)


def test_only_one_child_at_a_time_and_a_second_request_is_told_to_wait(monkeypatch):
    assert imageproc._TURN.acquire(timeout=1)
    try:
        monkeypatch.setattr(imageproc, "WAIT_FOR_TURN", 0.05)
        with pytest.raises(ImageRejected) as excinfo:
            imageproc.process(solid())
        assert excinfo.value.kind == "busy"
    finally:
        imageproc._TURN.release()


def test_pillow_with_webp_is_there():
    assert imageproc.check()


# ---- the folder ----


@pytest.fixture
def files(tmp_path):
    return imagestore.ImageStore(tmp_path / "images", max_bytes=10_000_000)


def test_files_are_written_atomically_private_and_named_by_content(files):
    done = imageproc.process(solid())
    files.put(done)
    names = sorted(p.name for p in files.dir.iterdir() if p.name != imagestore.MARKER)
    assert names == sorted(f"{done.hash}-{k}.webp" for k in "lms")  # nothing temporary is left
    assert oct(files.dir.stat().st_mode & 0o777) == "0o700"
    assert all(oct(p.stat().st_mode & 0o777) == "0o600" for p in files.dir.iterdir() if p.name.endswith('.webp'))
    files.put(done)  # the same picture again costs nothing
    assert len([p for p in files.dir.iterdir() if p.name.endswith('.webp')]) == 3 and files.has(done.hash)


@pytest.mark.parametrize("digest,size", [
    ("../../etc/passwd", "l"), ("A" * 32, "l"), ("a" * 31, "l"), ("a" * 33, "l"), ("a" * 32, "x"), ("a" * 32, "L"), ("a" * 32, "l/../l"),
    ("a" * 31 + "%", "l"), ("", "l"), ("a" * 32 + "\n", "l"),
])
def test_only_exact_names_make_a_path(files, digest, size):
    assert files.path(digest, size) is None
    assert files.path("a" * 32, "m") == files.dir / ("a" * 32 + "-m.webp")


def test_the_folder_has_an_upper_limit(tmp_path):
    small = imagestore.ImageStore(tmp_path / "i", max_bytes=300)
    with pytest.raises(imagestore.StoreFull):
        small.put(imageproc.process(encode(gradient(500, 500), "PNG")))
    assert not small.dir.exists() or not any(small.dir.glob("*.webp"))


def test_the_limit_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("MAHLWERK_IMAGES_MAX_MB", "2")
    assert imagestore.max_bytes_from_env() == 2 * 1024 * 1024
    monkeypatch.setenv("MAHLWERK_IMAGES_MAX_MB", "junk")
    assert imagestore.max_bytes_from_env() == 1024 * 1024 * 1024


def test_sweep_deletes_only_old_files_nobody_refers_to(files):
    keep, lost, young = (imageproc.process(solid(c)) for c in ((1, 1, 1), (2, 2, 2), (3, 3, 3)))
    for done in (keep, lost, young):
        files.put(done)
    (files.dir / (imagestore.TMP_PREFIX + "leftover")).write_bytes(b"x")
    old = files.clock() - 2 * imagestore.GRACE_SECONDS
    for path in list(files.dir.iterdir()):
        if young.hash not in path.name and path.name != imagestore.MARKER:
            os.utime(path, (old, old))
    removed = files.sweep({keep.hash})
    assert removed == 4  # the three files of `lost` and the temporary one
    assert files.has(keep.hash) and files.has(young.hash) and not files.has(lost.hash)  # young: written a moment ago, maybe not linked yet
    assert files.sweep({keep.hash}, limit=0) == 0


# ---- the API: own photos, delivery, tidy-up ----


def recipe(client, name="Porridge"):
    oats = client.post("/api/v1/foods", json={"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}).json()
    body = {"name": name, "portions": 2, "items": [{"food_id": oats["id"], "amount": 100}]}
    return client.post("/api/v1/recipes", json=body).json()


def put_photo(client, food_id, data, **kw):
    return client.put(f"/api/v1/foods/{food_id}/image", content=data, headers={"Content-Type": "image/jpeg"}, **kw)


def image_files(client) -> list[str]:
    folder = client.app.state.images.files.dir
    return sorted(p.name for p in folder.iterdir() if p.name.endswith(".webp")) if folder.exists() else []


def test_an_own_photo_for_an_own_recipe_and_its_delivery(client):
    r = recipe(client)
    food_id = r["food"]["id"]
    assert r["food"]["image"] is None
    done = put_photo(client, food_id, jpeg_with_gps())
    assert done.status_code == 200, done.text
    image = done.json()["image"]
    assert image["origin"] == "own" and image["credit"] is None and len(image["hash"]) == 32
    for size, edge in (("l", None), ("m", 240), ("s", 96)):
        got = client.get(f"/api/v1/images/{image['hash']}/{size}")
        assert got.status_code == 200 and got.headers["content-type"] == "image/webp"
        assert got.headers["x-content-type-options"] == "nosniff"
        assert got.headers["cache-control"] == "private, max-age=31536000, immutable"
        assert got.headers["etag"] == f'"{image["hash"]}-{size}"'
        assert got.content[:4] == b"RIFF" and got.content[8:12] == b"WEBP"
        if edge:
            assert decode(got.content).size == (edge, edge)
    # the recipe shows it in the list and in the single answer
    assert client.get(f"/api/v1/recipes/{r['id']}").json()["food"]["image"]["hash"] == image["hash"]
    assert client.get("/api/v1/recipes").json()[0]["food"]["image"]["hash"] == image["hash"]
    assert client.get(f"/api/v1/foods/{food_id}").json()["image"]["hash"] == image["hash"]


def test_editing_the_recipe_keeps_the_picture(client):
    r = recipe(client)
    h = put_photo(client, r["food"]["id"], solid()).json()["image"]["hash"]
    body = {"name": "Porridge deluxe", "portions": 3, "items": [{"food_id": r["items"][0]["food_id"], "amount": 150}]}
    assert client.put(f"/api/v1/recipes/{r['id']}", json=body).json()["food"]["image"]["hash"] == h


def test_conditional_requests_get_304_and_unknown_things_404(client):
    h = put_photo(client, recipe(client)["food"]["id"], solid()).json()["image"]["hash"]
    first = client.get(f"/api/v1/images/{h}/m")
    again = client.get(f"/api/v1/images/{h}/m", headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304 and again.content == b"" and again.headers["cache-control"].endswith("immutable")
    assert client.get(f"/api/v1/images/{h}/m", headers={"If-None-Match": '"other"'}).status_code == 200
    for path in (f"{h}/xl", f"{h}/L", f"{h.upper()}/m", f"{h[:-1]}/m", "0" * 32 + "/m", f"{h}x/m", "..%2F..%2Fetc%2Fpasswd/m", f"{h}/m%2F..%2Fl"):
        assert client.get(f"/api/v1/images/{path}").status_code == 404, path


def test_every_other_api_answer_still_says_no_store(client):
    assert client.get("/api/v1/recipes").headers["cache-control"] == "no-store"


def test_a_missing_file_is_a_recipe_without_picture_not_an_error(client):
    r = recipe(client)
    h = put_photo(client, r["food"]["id"], solid()).json()["image"]["hash"]
    for p in client.app.state.images.files.dir.glob("*.webp"):
        p.unlink()
    assert client.get(f"/api/v1/images/{h}/l").status_code == 404
    assert client.get(f"/api/v1/recipes/{r['id']}").status_code == 200  # the rest works; the interface shows its placeholder


def test_replacing_and_removing_tidies_the_files(client):
    r = recipe(client)
    fid = r["food"]["id"]
    first = put_photo(client, fid, solid((10, 20, 30))).json()["image"]["hash"]
    assert len(image_files(client)) == 3
    second = put_photo(client, fid, solid((200, 20, 30))).json()["image"]["hash"]
    assert second != first and len(image_files(client)) == 3 and all(second in n for n in image_files(client))
    assert client.get(f"/api/v1/images/{first}/l").status_code == 404
    gone = client.delete(f"/api/v1/foods/{fid}/image")
    assert gone.status_code == 200 and gone.json()["image"] is None and image_files(client) == []
    assert client.get(f"/api/v1/images/{second}/l").status_code == 404
    assert client.delete(f"/api/v1/foods/{fid}/image").status_code == 200  # nothing to remove is fine


def test_two_recipes_may_share_a_file_and_it_stays_until_the_last_one_goes(client):
    a, b = recipe(client, "A"), recipe(client, "B")
    h = put_photo(client, a["food"]["id"], solid()).json()["image"]["hash"]
    assert put_photo(client, b["food"]["id"], solid()).json()["image"]["hash"] == h and len(image_files(client)) == 3
    assert client.delete(f"/api/v1/recipes/{a['id']}").status_code == 204
    assert len(image_files(client)) == 3 and client.get(f"/api/v1/images/{h}/s").status_code == 200
    assert client.delete(f"/api/v1/foods/{b['food']['id']}/image").status_code == 200 and image_files(client) == []


def test_deleting_the_recipe_deletes_its_picture(client):
    r = recipe(client)
    put_photo(client, r["food"]["id"], solid())
    assert client.delete(f"/api/v1/recipes/{r['id']}").status_code == 204 and image_files(client) == []


def test_a_product_is_not_a_recipe(client, food):
    assert put_photo(client, food["id"], solid()).status_code == 409
    assert client.delete(f"/api/v1/foods/{food['id']}/image").status_code == 409
    assert put_photo(client, 99999, solid()).status_code == 404 and client.delete("/api/v1/foods/99999/image").status_code == 404


@pytest.mark.parametrize("data,status", [
    (b"", 422), (b"<svg/>", 422), (png_claiming(50000, 50000), 413), (b"x" * 5000, 422),
    (encode(Image.new("RGB", (9, 9)), "GIF"), 422),
])
def test_a_bad_upload_is_refused_without_a_500_and_leaves_nothing(client, data, status):
    fid = recipe(client)["food"]["id"]
    r = put_photo(client, fid, data)
    assert r.status_code == status and r.json()["detail"] and image_files(client) == []
    assert client.get(f"/api/v1/foods/{fid}").json()["image"] is None


def test_the_body_limit_applies_to_the_photo_route(client):
    fid = recipe(client)["food"]["id"]
    r = put_photo(client, fid, b"\xff\xd8" + b"\x00" * (8 * 1024 * 1024 + 10))
    assert r.status_code == 413


def test_a_full_folder_says_so(client):
    fid = recipe(client)["food"]["id"]
    client.app.state.images.files.max_bytes = 100
    r = put_photo(client, fid, solid())
    assert r.status_code == 507 and "MAHLWERK_IMAGES_MAX_MB" in r.json()["detail"]


def test_a_picture_needs_a_sign_in(duo):
    ann, ben = duo
    r = recipe(ann)
    h = put_photo(ann, r["food"]["id"], solid()).json()["image"]["hash"]
    stranger = TestClient(ann.app, client=("10.0.0.5", 1))  # a trusted proxy but no user header: nobody signed in
    assert stranger.get(f"/api/v1/images/{h}/l").status_code == 401
    assert stranger.put(f"/api/v1/foods/{r['food']['id']}/image", content=solid()).status_code == 401
    untrusted = TestClient(ann.app, client=("198.51.100.9", 1), headers={"Remote-User": "ann"})  # a header from a peer nobody trusts
    assert untrusted.get(f"/api/v1/images/{h}/l").status_code == 401
    assert ben.get(f"/api/v1/images/{h}/l").status_code == 200  # the household shares its recipes and pictures


def test_a_read_token_may_look_but_not_change(client):
    r = recipe(client)
    fid = r["food"]["id"]
    h = put_photo(client, fid, solid()).json()["image"]["hash"]
    read = client.post("/api/v1/me/tokens", json={"name": "r", "scope": "read"}).json()["token"]
    write = client.post("/api/v1/me/tokens", json={"name": "w", "scope": "write"}).json()["token"]
    bare = TestClient(client.app)
    bare.headers.pop("X-Mahlwerk-Request", None)
    auth = lambda t: {"Authorization": f"Bearer {t}"}  # noqa: E731
    assert bare.get(f"/api/v1/images/{h}/m", headers=auth(read)).status_code == 200
    assert bare.put(f"/api/v1/foods/{fid}/image", content=solid(), headers=auth(read)).status_code == 403
    assert bare.delete(f"/api/v1/foods/{fid}/image", headers=auth(read)).status_code == 403
    assert bare.put(f"/api/v1/foods/{fid}/image", content=solid((9, 9, 9)), headers=auth(write)).status_code == 200


def test_the_content_security_policy_is_not_widened():
    from mahlwerk import security

    assert "img-src 'self' data: blob:;" in security.build_csp(None) + ";"


def test_the_demo_cleanup_and_import_undo_leave_files_to_the_sweep(client):
    # a food deleted behind the routes' back (demo cleanup, import undo) leaves files that the start-up sweep takes away
    r = recipe(client)
    put_photo(client, r["food"]["id"], solid())
    store = client.app.state.store
    with sqlite3.connect(store.path) as con:
        con.execute("DELETE FROM recipe")
        con.execute("DELETE FROM food WHERE source = 'recipe'")
    assert store.image_hashes() == set() and len(image_files(client)) == 3
    images = client.app.state.images
    old = images.files.clock() - 2 * imagestore.GRACE_SECONDS
    for p in images.files.dir.glob('*.webp'):
        os.utime(p, (old, old))
    assert images.sweep() == 3 and image_files(client) == []


# ---- the migration ----


def test_version_13_database_gets_the_picture_columns_without_losing_data(tmp_path):
    path = str(tmp_path / "v13.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V14)
    con.executescript(
        """
        INSERT INTO food (id, source, found, data, fetched_at, external_id) VALUES (7, 'cookidoo', 1,
            '{"name": "Soup", "per_100": {"kcal": 100}}', 1, 'cookidoo:r100001');
        PRAGMA user_version = 13;
        """
    )
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    columns = {r[1] for r in con.execute("PRAGMA table_info(food)")}
    assert {"image_hash", "image_origin", "image_at", "image_url"} <= columns
    assert "food_image_hash" in {r[0] for r in con.execute("SELECT name FROM sqlite_master")}
    con.close()
    food = store.get_food_by_external_id("cookidoo:r100001")
    assert food["id"] == 7 and food["image_hash"] is None and food["data"]["name"] == "Soup"
    assert store.set_food_image(7, "a" * 32, "own", None) is None and store.get_food(7)["image_origin"] == "own"
    Store(path)  # opening it again changes nothing


# ---- the provider's picture ----

IMG = "https://recipes.example.org/pics/salad.jpg"


def serve_picture(web, url=IMG, data=None, content_type="image/jpeg", status=200, headers=None):
    data = data if data is not None else encode(gradient(800, 600), "JPEG")
    web.pages[url] = lambda: httpx.Response(status, headers={"content-type": content_type, **(headers or {})}, stream=Chunks(data))


def page_with(image, **extra):
    return {**GOOD, "image": image, **extra}


@pytest.fixture
def web():
    return Web()


@pytest.fixture
def make_app(tmp_path, monkeypatch, web):
    def make(images=True, **env):
        monkeypatch.setenv("MAHLWERK_WEB_RECIPES", "1")
        if images:
            monkeypatch.setenv("MAHLWERK_WEB_RECIPES_IMAGES", "1")
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        app = create_app(str(tmp_path / "w.db"), web_transport=httpx.MockTransport(web))
        web.cache = app.state.web_cache
        return TestClient(app)

    return make


def adopt(client, url=PAGE, **kw):
    return client.post("/api/v1/web-recipes", json={"url": url, **kw})


def asked(web, url):
    return [r for r in web.seen if f"{r.url.scheme}://{r.headers['host']}{r.url.raw_path.decode()}" == url]


def test_web_picture_is_fetched_once_and_stored_when_the_switch_is_on(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    r = adopt(client)
    assert r.status_code == 200, r.text
    image = r.json()["image"]
    assert image["origin"] == "web" and image["credit"] == "recipes.example.org"
    assert client.get(f"/api/v1/images/{image['hash']}/l").status_code == 200
    assert len(asked(web, IMG)) == 1
    request = asked(web, IMG)[0]
    assert request.headers["accept"].startswith("image/") and "cookie" not in request.headers and "referer" not in request.headers


def test_web_picture_switch_off_means_no_request_for_it(make_app, web):
    client = make_app(images=False)
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    r = adopt(client)
    assert r.status_code == 200 and r.json()["image"] is None and asked(web, IMG) == []
    assert client.app.state.store.get_food(r.json()["id"])["image_url"] is None  # the address is not even remembered while the switch is off
    assert image_files(client) == []


def test_web_switch_default_is_off(tmp_path, monkeypatch, web):
    monkeypatch.setenv("MAHLWERK_WEB_RECIPES", "1")
    client = TestClient(create_app(str(tmp_path / "d.db"), web_transport=httpx.MockTransport(web)))
    assert next(c for c in client.get("/api/v1/admin/connectors").json() if c["key"] == "web_recipes")["config"] == {"images": False}
    assert not client.app.state.features.cookidoo_images and not client.app.state.features.web_images


@pytest.mark.parametrize("value,expected", [
    ("/pics/rel.jpg", "https://recipes.example.org/pics/rel.jpg"),
    ("pics/rel.jpg", "https://recipes.example.org/pics/rel.jpg"),
    ("//cdn.example.net/a.jpg", "https://cdn.example.net/a.jpg"),
    (["/pics/rel.jpg", "/other.jpg"], "https://recipes.example.org/pics/rel.jpg"),
    ({"@type": "ImageObject", "url": "/pics/rel.jpg", "width": 800}, "https://recipes.example.org/pics/rel.jpg"),
    ([{"@type": "ImageObject", "contentUrl": "/pics/rel.jpg"}], "https://recipes.example.org/pics/rel.jpg"),
])
def test_the_picture_forms_and_relative_addresses(make_app, web, value, expected):
    client = make_app()
    web.page(PAGE, html(page_with(value)))
    serve_picture(web, expected)
    r = adopt(client)
    assert r.json()["image"]["origin"] == "web" and len(asked(web, expected)) == 1


@pytest.mark.parametrize("value", ["", None, 5, [], {}, "data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://x.example/a.jpg",
                                   "https://user:pw@recipes.example.org/a.jpg", "https://recipes.example.org:8443/a.jpg", "http://127.0.0.1/a.jpg",
                                   "https://" + "a" * 900 + ".example/x.jpg"])
def test_unusable_picture_values_give_a_recipe_without_picture(make_app, web, value):
    client = make_app()
    web.page(PAGE, html(page_with(value)))
    r = adopt(client)
    assert r.status_code == 200 and r.json()["image"] is None and len(web.seen) == 1  # only the page was fetched


@pytest.mark.parametrize("host", ["internal.example", "dual.example", "localhost"])
def test_a_picture_on_an_internal_address_is_never_fetched(make_app, web, host):
    client = make_app()
    url = f"https://{host}/a.jpg"
    web.page(PAGE, html(page_with(url)))
    serve_picture(web, url)
    r = adopt(client)
    assert r.status_code == 200 and r.json()["image"] is None and asked(web, url) == []


def test_a_redirect_to_an_internal_address_is_refused(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    web.pages[IMG] = lambda: httpx.Response(302, headers={"location": "http://internal.example/secret.jpg"})
    serve_picture(web, "http://internal.example/secret.jpg")
    r = adopt(client)
    assert r.status_code == 200 and r.json()["image"] is None and asked(web, "http://internal.example/secret.jpg") == []


def test_a_redirect_to_another_public_picture_is_followed_and_checked(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    web.pages[IMG] = lambda: httpx.Response(301, headers={"location": "https://cdn.example.net/real.jpg"})
    serve_picture(web, "https://cdn.example.net/real.jpg")
    assert adopt(client).json()["image"]["origin"] == "web"


def test_the_servers_own_names_are_blocked_for_pictures_too(make_app, web):
    client = make_app(MAHLWERK_PUBLIC_URL="https://mahlwerk.example.com", MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS="blocked.example")
    for url in ("https://mahlwerk.example.com/a.jpg", "https://img.blocked.example/a.jpg"):
        web.page(PAGE, html(page_with(url)))
        serve_picture(web, url)
        r = adopt(client, refresh=True)
        assert r.status_code == 200 and r.json()["image"] is None and asked(web, url) == [], url


@pytest.mark.parametrize("content_type", ["text/html", "image/svg+xml", "image/gif", "image/avif", "image/heic", "application/octet-stream", ""])
def test_only_jpeg_png_and_webp_are_accepted_as_a_content_type(make_app, web, content_type):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web, content_type=content_type)
    assert adopt(client).json()["image"] is None


def test_a_picture_that_is_too_large_is_refused_by_header_and_by_counting(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web, data=b"\xff\xd8" + b"\x00" * (7 * 1024 * 1024))
    assert adopt(client).json()["image"] is None
    web.pages[IMG] = lambda: httpx.Response(200, headers={"content-type": "image/jpeg", "content-length": str(9 * 1024 * 1024)}, stream=Chunks(b"x"))
    assert adopt(client, refresh=True).json()["image"] is None


def test_a_compression_bomb_stops_at_the_limit(make_app, web):
    import gzip

    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    bomb = gzip.compress(b"\x00" * (50 * 1024 * 1024), 9)
    assert len(bomb) < 6 * 1024 * 1024
    web.pages[IMG] = lambda: httpx.Response(200, headers={"content-type": "image/jpeg", "content-encoding": "gzip"}, stream=Chunks(bomb))
    assert adopt(client).json()["image"] is None


def test_a_picture_that_is_not_one_leaves_the_recipe_without(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web, data=b"\xff\xd8\xff\xe0 this is no jpeg")
    r = adopt(client)
    assert r.status_code == 200 and r.json()["image"] is None and image_files(client) == []


def test_an_error_status_leaves_the_recipe_without_picture(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web, status=500)
    assert adopt(client).json()["image"] is None


def test_a_reload_renews_the_provider_picture_but_never_an_own_photo(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web, data=solid((200, 0, 0), (400, 300)))
    food = adopt(client).json()
    first = food["image"]["hash"]
    serve_picture(web, data=solid((0, 200, 0), (400, 300)))
    renewed = client.post(f"/api/v1/web-recipes/{food['id']}/reload").json()
    assert renewed["image"]["hash"] != first and renewed["image"]["origin"] == "web" and len(image_files(client)) == 3
    own = put_photo(client, food["id"], solid((0, 0, 200))).json()["image"]
    assert own["origin"] == "own"
    seen = len(asked(web, IMG))
    again = client.post(f"/api/v1/web-recipes/{food['id']}/reload").json()
    assert again["image"]["hash"] == own["hash"] and again["image"]["origin"] == "own" and len(asked(web, IMG)) == seen  # not even asked
    assert adopt(client, refresh=True).json()["image"]["hash"] == own["hash"]


def test_taking_a_provider_picture_away_is_remembered(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    food = adopt(client).json()
    assert client.delete(f"/api/v1/foods/{food['id']}/image").json()["image"] is None and image_files(client) == []
    seen = len(asked(web, IMG))
    assert client.post(f"/api/v1/web-recipes/{food['id']}/reload").json()["image"] is None and len(asked(web, IMG)) == seen
    # an own photo can still be set afterwards
    assert put_photo(client, food["id"], solid()).json()["image"]["origin"] == "own"


def test_removing_an_own_photo_lets_a_reload_fetch_the_provider_picture_again(make_app, web):
    client = make_app(images=False)
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    food = adopt(client).json()
    put_photo(client, food["id"], solid())
    assert client.delete(f"/api/v1/foods/{food['id']}/image").json()["image"] is None
    client.app.state.features.store.set_global("web_recipes.images", True)
    assert client.post(f"/api/v1/web-recipes/{food['id']}/reload").json()["image"]["origin"] == "web"


def test_an_own_photo_works_whatever_the_switches_say(make_app, web):
    client = make_app(images=False)
    web.page(PAGE, html(page_with(IMG)))
    food = adopt(client).json()
    assert put_photo(client, food["id"], solid()).json()["image"]["origin"] == "own"


def test_the_admin_switches_for_pictures(make_app, web):
    client = make_app(images=False)
    patch = lambda key, cfg: client.patch(f"/api/v1/admin/connectors/{key}", json={"config": cfg})  # noqa: E731
    assert patch("web_recipes", {"images": True}).json()["config"] == {"images": True}
    assert client.app.state.features.web_images is True
    assert patch("cookidoo", {"images": True}).json()["config"]["images"] is True
    assert patch("cookidoo", {"images": True, "personal": False}).json()["config"] == {"personal": False, "images": True}
    assert patch("web_recipes", {"images": "yes"}).status_code == 422 and patch("web_recipes", {"other": True}).status_code == 422
    assert patch("web_recipes", {}).status_code == 200


def test_the_environment_can_fix_the_picture_switch(make_app):
    client = make_app(images=False, MAHLWERK_WEB_RECIPES_IMAGES="0")
    card = next(c for c in client.get("/api/v1/admin/connectors").json() if c["key"] == "web_recipes")
    assert "config.images" in card["locked"] and card["config"] == {"images": False}
    assert client.patch("/api/v1/admin/connectors/web_recipes", json={"config": {"images": True}}).status_code == 409


def test_a_full_folder_does_not_stop_a_recipe_from_being_taken_over(make_app, web):
    client = make_app()
    client.app.state.images.files.max_bytes = 10
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    r = adopt(client)
    assert r.status_code == 200 and r.json()["image"] is None


# ---- Cookidoo ----

COOKIDOO_IMG = "https://assets.example.net/recipes/r100001.jpg"


def cookidoo_app(tmp_path, monkeypatch, fake, web, images=True):
    monkeypatch.setenv("MAHLWERK_COOKIDOO", "1")
    if images:
        monkeypatch.setenv("MAHLWERK_COOKIDOO_IMAGES", "1")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", "someone@example.invalid")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", "pw-not-real")
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    app = create_app(str(tmp_path / "ck.db"), web_transport=httpx.MockTransport(web))
    app.state.cookidoo.factory = lambda settings: fake
    return TestClient(app)


def lentils(image=COOKIDOO_IMG):
    values = {"kcal": (497, "kcal"), "fat": (8, "g"), "carb2": (73, "g"), "protein": (37, "g")}
    return RecipeDetails("r100001", "Red lentil salad", 4.0, [NutritionEntry(1, "Portion", values)], image)


def test_cookidoo_adopt_fetches_the_picture_from_the_address_in_the_details(tmp_path, monkeypatch, fake, web):
    client = cookidoo_app(tmp_path, monkeypatch, fake, web)
    fake.recipes["r100001"] = lentils()
    serve_picture(web, COOKIDOO_IMG)
    r = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"})
    assert r.status_code == 200, r.text
    assert r.json()["image"]["origin"] == "cookidoo" and r.json()["image"]["credit"] == "Cookidoo"
    assert len(asked(web, COOKIDOO_IMG)) == 1 and client.get(f"/api/v1/images/{r.json()['image']['hash']}/s").status_code == 200


def test_cookidoo_switch_off_means_no_fetch_and_no_stored_address(tmp_path, monkeypatch, fake, web):
    client = cookidoo_app(tmp_path, monkeypatch, fake, web, images=False)
    fake.recipes["r100001"] = lentils()
    serve_picture(web, COOKIDOO_IMG)
    r = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"})
    assert r.status_code == 200 and r.json()["image"] is None and web.seen == []
    assert client.app.state.store.get_food(r.json()["id"])["image_url"] is None


def test_cookidoo_without_a_picture_address_or_with_a_bad_one_still_takes_the_recipe_over(tmp_path, monkeypatch, fake, web):
    client = cookidoo_app(tmp_path, monkeypatch, fake, web)
    for image in (None, "ftp://x.example/a.jpg", "https://internal.example/a.jpg", "https://127.0.0.1/a.jpg"):
        fake.recipes["r100001"] = lentils(image)
        r = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"})
        assert r.status_code == 200 and r.json()["image"] is None and web.seen == [], image


def test_cookidoo_reload_keeps_an_own_photo(tmp_path, monkeypatch, fake, web):
    client = cookidoo_app(tmp_path, monkeypatch, fake, web)
    fake.recipes["r100001"] = lentils()
    serve_picture(web, COOKIDOO_IMG)
    food = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    own = put_photo(client, food["id"], solid((5, 5, 200))).json()["image"]["hash"]
    seen = len(web.seen)
    again = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    assert again["image"]["hash"] == own and again["image"]["origin"] == "own" and len(web.seen) == seen


def test_the_catch_up_preview_and_start_need_the_switch(tmp_path, monkeypatch, fake, web):
    client = cookidoo_app(tmp_path, monkeypatch, fake, web, images=False)
    fake.recipes["r100001"] = lentils()
    client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"})
    pre = client.get("/api/v1/cookidoo/images/preview").json()
    assert pre == {"enabled": False, "total": 1, "to_fetch": 1, "eta_seconds": 4, "limit": 500}
    assert client.post("/api/v1/cookidoo/images").status_code == 409


def test_the_catch_up_fetches_pictures_paced_with_a_call_only_where_the_address_is_unknown(tmp_path, monkeypatch, fake, web):
    import time

    client = cookidoo_app(tmp_path, monkeypatch, fake, web, images=False)
    for rid in ("r100001", "r100002", "r100003"):
        fake.recipes[rid] = RecipeDetails(rid, f"Recipe {rid}", 4.0, lentils().nutrition, f"https://assets.example.net/{rid}.jpg")
    client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"})  # taken over before pictures were switched on: no address is stored
    client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100002"})
    store = client.app.state.store
    third = store.put_external_food("cookidoo:r100003", "cookidoo", {**store.get_food_by_external_id("cookidoo:r100001")["data"], "name": "Third"})[0]
    own = put_photo(client, third, solid()).json()["image"]["hash"]  # an own photo: never touched
    for rid in ("r100001", "r100002"):
        serve_picture(web, f"https://assets.example.net/{rid}.jpg")
    client.app.state.features.store.set_global("cookidoo.images", True)
    runs = client.app.state.cookidoo_runs
    sleeps: list[float] = []

    async def sleep(seconds):
        sleeps.append(seconds)

    runs.sleep = sleep
    import asyncio

    asyncio.run(client.app.state.cookidoo.forget(cookidoo.SHARED))  # the details cached by the adoptions above are gone: a real call is needed
    fake.calls.clear()
    pre = client.get("/api/v1/cookidoo/images/preview").json()
    assert pre["enabled"] and pre["total"] == 2 and pre["to_fetch"] == 2
    client.__enter__()  # a run lives on the event loop of the app: keep it open (the lifespan) until the run is over
    started = client.post("/api/v1/cookidoo/images")
    assert started.status_code == 202 and started.json()["mode"] == "pictures"
    for _ in range(200):
        state = client.get("/api/v1/cookidoo/import").json()
        if state["state"] != "running":
            break
        time.sleep(0.05)
    assert state["state"] == "done" and state["mode"] == "pictures" and state["pictures"] == 2 and state["fetched"] == 2, state
    assert fake.calls.count("recipe") == 2  # one detail call per recipe: no address is stored while the switch is off
    assert len(asked(web, "https://assets.example.net/r100001.jpg")) == 1 and len(asked(web, "https://assets.example.net/r100002.jpg")) == 1
    foods = {r["external_id"]: r for r in client.get("/api/v1/foods?source=cookidoo").json()}
    assert foods["cookidoo:r100001"]["image"]["origin"] == "cookidoo" and foods["cookidoo:r100002"]["image"]["origin"] == "cookidoo"
    assert client.get(f"/api/v1/foods/{third}").json()["image"]["hash"] == own
    assert client.get("/api/v1/cookidoo/images/preview").json()["total"] == 0  # nothing left to catch up
    assert client.post("/api/v1/cookidoo/images").status_code == 422
    client.__exit__(None, None, None)


# ---- pictures inside the run that takes many recipes over ----


def test_the_bulk_run_fetches_each_picture_once_only_when_switched_on(tmp_path):
    import asyncio

    from mahlwerk import webrecipes
    from mahlwerk.recipeimages import RecipeImages
    from test_cookidoo_bulk import World, details

    world = World(tmp_path, n=6)
    shown = {}
    pictures = solid((30, 90, 150), (320, 240))

    class Fetcher:
        def __init__(self):
            self.urls = []

        def fetch_image(self, url):
            self.urls.append(url)
            return webrecipes.Page(url, "", pictures)

    fetcher = Fetcher()
    images = RecipeImages(world.store, imagestore.ImageStore(tmp_path / "images", max_bytes=50_000_000))
    on = [False]
    world.runs.images, world.runs.fetcher, world.runs.images_on = images, fetcher, lambda: on[0]

    def with_image(rid):
        d = details(rid)
        return cookidoo.RecipeDetails(d.id, d.name, d.portions, d.nutrition, f"https://assets.example.net/{rid}.jpg")

    original = world.hub.factory

    class Client:
        def __init__(self, inner):
            self.inner = inner

        def __getattr__(self, name):
            return getattr(self.inner, name)

        async def recipe(self, rid):
            await self.inner.recipe(rid)
            return with_image(rid)

    world.hub.factory = lambda settings: Client(original(settings))
    first = asyncio.run(world.go("all"))
    assert first.state == "done" and fetcher.urls == [] and first.counts["pictures"] == 0  # off: no fetch ...
    assert all(world.food(i)["image_url"] is None for i in world.ids)  # ... and no address kept
    # on: the recipes are old enough to be fetched again, so the details bring the addresses and the pictures come once
    on[0] = True
    world.clock.now += 8 * 86400
    second = asyncio.run(world.go("all"))
    assert second.state == "done" and sorted(fetcher.urls) == sorted(f"https://assets.example.net/{i}.jpg" for i in world.ids)
    assert second.counts["pictures"] == 6 and all(world.food(i)["image_origin"] == "cookidoo" for i in world.ids)
    again = asyncio.run(world.go("all"))
    assert again.state == "done" and len(fetcher.urls) == 6  # the same address is not fetched again, also when the recipe itself is renewed
    assert len(list((tmp_path / "images").glob("*.webp"))) == 3  # one picture, shared by six recipes
    # an own photo is never replaced
    shown["own"] = images.attach(world.food(world.ids[0])["id"], solid((200, 10, 10)), "own")
    world.store.update_food(world.food(world.ids[1])["id"], "cookidoo", world.food(world.ids[1])["data"])
    world.store.clear_food_image(world.food(world.ids[1])["id"], "none")
    world.clock.now += 8 * 86400  # everything is old now: the run asks Cookidoo again
    final = asyncio.run(world.go("all"))
    assert final.state == "done" and len(fetcher.urls) == 6  # the same address is not fetched again; the own and the taken-away one are not asked for
    assert world.food(world.ids[0])["image_hash"] == shown["own"] and world.food(world.ids[1])["image_hash"] is None


def test_an_own_photo_set_while_a_provider_picture_was_on_its_way_wins(client):
    from mahlwerk import webrecipes

    r = recipe(client)
    fid = r["food"]["id"]
    images = client.app.state.images
    store = client.app.state.store
    store.set_food_image(fid, "a" * 32, "web", None)  # as if this were a web recipe with a provider's picture already
    store.clear_food_image(fid)

    class SlowFetcher:
        def fetch_image(self, url):
            images.attach(fid, solid((1, 200, 1)), "own")  # meanwhile somebody sets an own photo
            return webrecipes.Page(url, "", solid((200, 1, 1)))

    assert images.fetch_provider(SlowFetcher(), fid, "https://img.example.net/a.jpg", "web") is False
    row = store.get_food(fid)
    assert row["image_origin"] == "own" and len(image_files(client)) == 3


# ---- review round: brake and "not again" (M1) ----


def set_flag(client, key, value=True):
    client.app.state.features.store.set_global(key, value)


def test_web_picture_is_not_fetched_again_for_the_same_address_unless_reloaded(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    first = adopt(client).json()
    assert first["image"]["origin"] == "web" and len(asked(web, IMG)) == 1
    for _ in range(5):  # forty adoptions of one address must not mean forty fetches at the foreign host
        assert adopt(client).json()["image"]["hash"] == first["image"]["hash"]
    assert len(asked(web, IMG)) == 1
    assert adopt(client, refresh=True).status_code == 200 and len(asked(web, IMG)) == 2  # an explicit refresh asks again
    assert client.post(f"/api/v1/web-recipes/{first['id']}/reload").status_code == 200 and len(asked(web, IMG)) == 3


def test_a_changed_picture_address_is_fetched(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    serve_picture(web, "https://recipes.example.org/pics/other.jpg", solid((9, 99, 9)))
    adopt(client)
    web.page(PAGE, html(page_with("https://recipes.example.org/pics/other.jpg")))
    again = adopt(client)
    assert again.json()["image"]["origin"] == "web" and len(asked(web, "https://recipes.example.org/pics/other.jpg")) == 1


def test_the_picture_fetch_counts_against_the_brake(make_app, web):
    client = make_app(images=False)
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    adopt(client)  # the page: one fetch of the brake
    set_flag(client, "web_recipes.images")
    client.app.state.web_brake.per_user = 1  # the person has used their share
    assert adopt(client).json()["image"] is None and asked(web, IMG) == []  # page from the cache, picture refused by the brake
    client.app.state.web_brake.per_user = 20
    assert adopt(client).json()["image"]["origin"] == "web" and len(asked(web, IMG)) == 1


def test_cookidoo_picture_not_again_unless_asked_and_braked(tmp_path, monkeypatch, fake, web):
    client = cookidoo_app(tmp_path, monkeypatch, fake, web)
    fake.recipes["r100001"] = lentils()
    serve_picture(web, COOKIDOO_IMG)
    for _ in range(4):
        assert client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()["image"]["origin"] == "cookidoo"
    assert len(asked(web, COOKIDOO_IMG)) == 1
    assert client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "refresh_image": True}).status_code == 200
    assert len(asked(web, COOKIDOO_IMG)) == 2
    client.app.state.image_brake.per_user = 0  # nothing more for this person
    client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "refresh_image": True})
    assert len(asked(web, COOKIDOO_IMG)) == 2


# ---- hint (b): no plain http picture from an https page ----


def test_a_plain_http_picture_from_an_https_page_is_not_fetched(make_app, web):
    client = make_app()
    url = "http://recipes.example.org/pics/plain.jpg"
    web.page(PAGE, html(page_with(url)))
    serve_picture(web, url)
    assert adopt(client).json()["image"] is None and asked(web, url) == []


# ---- M2: the child ----


def test_no_colour_management_library_is_used_and_a_profile_is_dropped():
    from PIL import ImageCms

    source = Path(imageproc.__file__).read_text()
    assert "import ImageCms" not in source and "ImageCms," not in source and "profileToProfile" not in source
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    img = Image.new("RGB", (60, 40), (20, 120, 220))
    with_icc = encode(img, "JPEG", icc_profile=profile)
    assert b"ICC_PROFILE" in with_icc
    done = imageproc.process(with_icc)
    assert all(b"ICCP" not in data and b"ICC_PROFILE" not in data for data in done.files.values())
    assert "icc_profile" not in decode(done.files["l"]).info


def test_the_child_is_hardened_before_it_decodes():
    code = (
        "import os, sys, resource\n"
        "from mahlwerk import imageproc\n"
        "extra = os.open('/dev/null', os.O_RDONLY)\n"
        "imageproc._harden()\n"
        "try:\n    os.fstat(extra); print('FD-OPEN')\nexcept OSError:\n    print('fd-closed')\n"
        "print(resource.getrlimit(resource.RLIMIT_FSIZE)[0], resource.getrlimit(resource.RLIMIT_NOFILE)[0], resource.getrlimit(resource.RLIMIT_NPROC)[0], resource.getrlimit(resource.RLIMIT_AS)[0] == 768*1024*1024)\n"
        "try:\n    open('should-not-exist.txt', 'w').write('x' * 100000); print('WROTE')\nexcept OSError:\n    print('no-write')\n"
        "print(os.listdir('.'))\n"
    )
    done = subprocess.run([os.sys.executable, "-I", "-c", code], capture_output=True, text=True, cwd="/")
    assert done.returncode == 0, done.stderr
    lines = done.stdout.split("\n")
    assert lines[0] == "fd-closed" and lines[1] == "0 8 0 True" and lines[2] == "no-write" and lines[3] == "[]"


def test_the_childs_answer_is_checked_again(monkeypatch):
    real = subprocess.run([os.sys.executable, "-I", "-m", "mahlwerk.imageproc"], input=solid(), capture_output=True,
                          env={"MAHLWERK_IMAGE_CHILD": "1", "PATH": os.environ.get("PATH", "")}).stdout
    assert imageproc._parse(real).files  # the real answer passes
    head_len = struct.unpack(">I", real[4:8])[0]
    head = real[8:8 + head_len].replace(b'"width": 300', b'"width": 301')
    forged = real[:4] + struct.pack(">I", len(head)) + head + real[8 + head_len:]
    with pytest.raises(ImageRejected):
        imageproc._parse(forged)
    with pytest.raises(ImageRejected):
        imageproc._parse(real + b"extra")


# ---- M3: waiting, memory, throttle ----


def test_too_many_waiting_requests_are_refused_at_once(monkeypatch):
    held = [imageproc._QUEUE.acquire(blocking=False) for _ in range(1 + imageproc.MAX_WAITING)]
    try:
        import time as _t

        started = _t.monotonic()
        with pytest.raises(ImageRejected) as excinfo:
            imageproc.process(solid())
        assert excinfo.value.kind == "busy" and _t.monotonic() - started < 1  # no waiting for a turn
    finally:
        for ok in held:
            if ok:
                imageproc._QUEUE.release()


def webp_claiming(width, height) -> bytes:
    """A lossless WebP whose header claims a size (the rest is a tiny real picture)."""
    real = bytearray(encode(Image.new("RGBA", (4, 4), (1, 2, 3, 4)), "WEBP", lossless=True))
    assert real[12:16] == b"VP8L"
    bits = struct.unpack("<I", bytes(real[21:25]))[0]
    bits = (bits & ~((1 << 28) - 1)) | (width - 1) | ((height - 1) << 14)
    real[21:25] = struct.pack("<I", bits)
    return bytes(real)


def test_the_lossless_webp_that_claims_6300_squared_is_refused_before_anything_decodes():
    data = webp_claiming(6300, 6300)
    assert len(data) < 200 and imagesize_of(data) == (6300, 6300)
    with pytest.raises(ImageRejected) as excinfo:
        imageproc.process(data)
    assert excinfo.value.kind == "too_many_pixels"


def imagesize_of(data):
    from mahlwerk import imagesize

    return imagesize.dimensions(data)


def test_a_big_but_allowed_lossless_webp_stays_inside_the_memory_limit():
    big = encode(Image.new("RGBA", (4000, 4000), (200, 30, 30, 120)), "WEBP", lossless=True)  # 16 megapixels, a few KB
    assert len(big) < 100_000
    done = imageproc.process(big)  # RLIMIT_AS is 768 MB: an overrun would be a refusal ("broken")
    assert decode(done.files["l"]).size == (960, 960)


def test_the_decoded_size_is_estimated_before_decoding(monkeypatch):
    monkeypatch.setattr(imageproc, "MAX_DECODED_BYTES", 1000)
    with pytest.raises(ImageRejected) as excinfo:
        imageproc._variants(encode(Image.new("RGB", (100, 100)), "PNG"))
    assert excinfo.value.kind == "too_many_pixels"


def test_uploads_are_throttled_per_person(client):
    fid = recipe(client)["food"]["id"]
    codes = [put_photo(client, fid, solid((i, 5, 5), (40, 30))).status_code for i in range(22)]
    assert codes[:20] == [200] * 20 and codes[20:] == [429, 429]


# ---- N1: a recipe turned into an own product loses its picture ----


def test_turning_a_taken_over_recipe_into_an_own_product_takes_its_picture_with_it(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    food = adopt(client).json()
    h = food["image"]["hash"]
    body = {"name": "Mine", "per_100": {"kcal": 100, "protein": 1, "carbs": 1, "fat": 1}}
    r = client.put(f"/api/v1/foods/{food['id']}", json=body)
    assert r.status_code == 200 and r.json()["source"] == "own" and r.json()["image"] is None
    assert client.get(f"/api/v1/images/{h}/l").status_code == 404 and image_files(client) == []
    assert client.get(f"/api/v1/foods/{food['id']}").json()["image"] is None


# ---- N2: the folder is only touched when it is ours ----


def test_a_foreign_folder_is_left_alone(tmp_path):
    foreign = tmp_path / "pics"
    foreign.mkdir(mode=0o755)
    (foreign / ".tmp-theirs").write_bytes(b"keep me")
    (foreign / "notes.txt").write_text("not ours")
    store = imagestore.ImageStore(foreign, max_bytes=10_000_000)
    with pytest.raises(imagestore.StoreError) as excinfo:
        store.put(imageproc.process(solid()))
    assert "not made by Mahlwerk" in str(excinfo.value) and str(foreign) not in str(excinfo.value)
    assert oct(foreign.stat().st_mode & 0o777) == "0o755"
    assert store.sweep(set()) == 0 and (foreign / ".tmp-theirs").exists() and (foreign / "notes.txt").exists()
    assert sorted(p.name for p in foreign.iterdir()) == [".tmp-theirs", "notes.txt"]


def test_our_own_folder_has_a_marker_and_an_empty_existing_one_is_adopted(tmp_path):
    empty = tmp_path / "e"
    empty.mkdir()
    store = imagestore.ImageStore(empty, max_bytes=10_000_000)
    store.put(imageproc.process(solid()))
    assert (empty / imagestore.MARKER).is_file() and oct(empty.stat().st_mode & 0o777) == "0o700"
    fresh = imagestore.ImageStore(tmp_path / "f", max_bytes=10_000_000)
    fresh.put(imageproc.process(solid((4, 5, 6))))
    assert (tmp_path / "f" / imagestore.MARKER).is_file()


def test_the_default_folder_is_named_after_the_database(client):
    assert client.app.state.images.files.dir.name == Path(client.app.state.store.path).name + ".images"


# ---- N3: disk problems, tidy-up ----


def test_a_full_disk_is_a_507_and_leaves_no_partial_set(client, monkeypatch):
    fid = recipe(client)["food"]["id"]
    calls = {"n": 0}
    real_replace = os.replace

    def failing(src, dst):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(28, "No space left on device")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", failing)
    r = put_photo(client, fid, solid())
    assert r.status_code == 507 and "disk" in r.json()["detail"] and image_files(client) == []
    assert not [p for p in client.app.state.images.files.dir.iterdir() if p.name.startswith(imagestore.TMP_PREFIX)]
    assert client.get(f"/api/v1/foods/{fid}").json()["image"] is None


def test_the_sweep_also_runs_on_a_write_once_a_day(client):
    images = client.app.state.images
    r = recipe(client)
    put_photo(client, r["food"]["id"], solid((1, 1, 1)))  # makes the folder
    orphan = images.files.dir / ("f" * 32 + "-l.webp")
    orphan.write_bytes(b"x")
    old = images.files.clock() - 3 * imagestore.GRACE_SECONDS
    os.utime(orphan, (old, old))
    put_photo(client, r["food"]["id"], solid((2, 2, 2)))  # not a day yet: the orphan stays
    assert orphan.exists()
    images.files.last_sweep = images.files.clock() - 2 * 86400
    put_photo(client, r["food"]["id"], solid((3, 3, 3)))
    assert not orphan.exists()


def test_removing_demo_data_tidies_the_files(duo):
    ann, _ = duo
    images = ann.app.state.images
    images.files._ensure()
    orphan = images.files.dir / ("e" * 32 + "-m.webp")
    orphan.write_bytes(b"x")
    old = images.files.clock() - 3 * imagestore.GRACE_SECONDS
    os.utime(orphan, (old, old))
    assert ann.delete("/api/v1/me/demo-data").status_code == 200 and not orphan.exists()


# ---- N4: failures and the start of the catch-up ----


def test_a_failed_fetch_is_remembered_and_the_catch_up_skips_it_for_a_week(make_app, web):
    client = make_app()
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web, status=500)
    food = adopt(client).json()
    store = client.app.state.store
    row = store.get_food(food["id"])
    assert row["image_origin"] == "failed" and food["image"] is None
    now = row["image_at"]
    assert store.foods_without_image("web", now + 3600) == []
    assert [r["id"] for r in store.foods_without_image("web", now + 8 * 86400)] == [food["id"]]
    serve_picture(web)  # a later explicit reload may still succeed
    assert client.post(f"/api/v1/web-recipes/{food['id']}/reload").json()["image"]["origin"] == "web"


def test_the_catch_up_may_be_started_only_every_ten_minutes(tmp_path):
    import asyncio

    from test_cookidoo_bulk import World, access

    world = World(tmp_path, n=6)
    asyncio.run(world.go("all"))
    now = world.clock.now

    async def start():
        plan = cookidoo_bulk.make_image_plan(world.store, now)
        run = world.runs.start(access(), plan, None)
        await run.task
        return run

    from mahlwerk import cookidoo_bulk

    assert asyncio.run(start()).mode == "pictures"
    world.clock.now += 300
    with pytest.raises(cookidoo_bulk.BulkError) as excinfo:
        asyncio.run(start())
    assert excinfo.value.kind == "wait"
    world.clock.now += 400
    assert asyncio.run(start()).mode == "pictures"


# ---- the small wish: restore a taken-away provider picture ----


def test_restoring_a_taken_away_provider_picture(make_app, web):
    client = make_app(images=False)
    set_flag(client, "web_recipes.images", True)
    web.page(PAGE, html(page_with(IMG)))
    serve_picture(web)
    food = adopt(client).json()
    fid = food["id"]
    assert client.post(f"/api/v1/foods/{fid}/image/restore").status_code == 409  # nothing was taken away
    gone = client.delete(f"/api/v1/foods/{fid}/image").json()
    assert gone["image"] is None and gone["image_removed"] is True
    set_flag(client, "web_recipes.images", False)
    assert client.post(f"/api/v1/foods/{fid}/image/restore").status_code == 409  # the switch is off
    set_flag(client, "web_recipes.images", True)
    back = client.post(f"/api/v1/foods/{fid}/image/restore")
    assert back.status_code == 200 and back.json()["image_removed"] is False
    assert client.post(f"/api/v1/web-recipes/{fid}/reload").json()["image"]["origin"] == "web"

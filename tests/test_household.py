"""Household members and guests: guests read everything shared and create their own foods, recipes and groups, but change or
delete only what they made. The rules are enforced by the API (403), not by the interface."""

import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import CSRF, DROP_V16, NUTELLA, PW, UNKNOWN
from mahlwerk import cookidoo
from mahlwerk.db import Store
from mahlwerk.main import create_app
from test_cookidoo import SECRET_MAIL, SECRET_PASSWORD, FakeClient

PEER = "10.0.0.5"
FOOD = {"name": "Oats", "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4}}
RECIPE = {"name": "Porridge", "portions": 2}


@pytest.fixture
def server(monkeypatch, tmp_path, upstream):
    """Proxy mode with MAHLWERK_HOUSEHOLD_GROUPS=eltern (and admin). `who(name, groups)` makes a client for a person."""
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", PEER)
    monkeypatch.setenv("MAHLWERK_HOUSEHOLD_GROUPS", "eltern")
    app = create_app(str(tmp_path / "h.db"), transport=httpx.MockTransport(upstream))

    def who(name: str, groups: str = "") -> TestClient:
        return TestClient(app, client=(PEER, 1), headers={"Remote-User": name, "Remote-Groups": groups})

    who.app = app
    return who


@pytest.fixture
def mum(server):
    return server("mum", "eltern")


@pytest.fixture
def guest(server):
    return server("gast", "freunde")


@pytest.fixture
def house(mum):
    """What the household owns: a food, a recipe (made of it) and a group holding the recipe."""
    food = mum.post("/api/v1/foods", json=FOOD).json()
    recipe = mum.post("/api/v1/recipes", json={**RECIPE, "items": [{"food_id": food["id"], "amount": 100}]}).json()
    group = mum.post("/api/v1/recipe-groups", json={"name": "Breakfast"}).json()
    assert mum.post(f"/api/v1/recipe-groups/{group['id']}/members", json={"food_ids": [recipe["food"]["id"]]}).status_code == 200
    return {"food": food, "recipe": recipe, "group": group}


def test_household_flag_follows_the_groups(mum, guest, server):
    assert mum.get("/api/v1/me").json()["household"] is True
    assert guest.get("/api/v1/me").json()["household"] is False
    assert server("boss", "admin").get("/api/v1/me").json()["household"] is True  # the admin group always counts
    assert server("nobody").get("/api/v1/me").json()["household"] is False
    # the groups are read at every request: moving to the household group takes effect at once
    assert server("gast", "eltern").get("/api/v1/me").json()["household"] is True
    assert guest.get("/api/v1/me").json()["household"] is False


def test_guest_cannot_change_or_delete_what_the_household_owns(guest, house):
    food, recipe, group = house["food"], house["recipe"], house["group"]
    seen = guest.get(f"/api/v1/foods/{food['id']}").json()
    assert seen["can_edit"] is False and guest.get(f"/api/v1/recipes/{recipe['id']}").json()["can_edit"] is False
    assert all(g["can_edit"] is False for g in guest.get("/api/v1/recipe-groups").json())
    for call in (
        lambda: guest.put(f"/api/v1/foods/{food['id']}", json=FOOD),
        lambda: guest.delete(f"/api/v1/foods/{food['id']}"),
        lambda: guest.put(f"/api/v1/foods/{food['id']}/piece", json={"label": "slice", "grams": 25}),
        lambda: guest.delete(f"/api/v1/foods/{food['id']}/piece"),
        lambda: guest.put(f"/api/v1/recipes/{recipe['id']}", json={**RECIPE, "items": [{"food_id": food["id"], "amount": 50}]}),
        lambda: guest.delete(f"/api/v1/recipes/{recipe['id']}"),
        lambda: guest.put(f"/api/v1/foods/{recipe['food']['id']}/image", content=b"x"),
        lambda: guest.delete(f"/api/v1/foods/{recipe['food']['id']}/image"),
        lambda: guest.post(f"/api/v1/foods/{recipe['food']['id']}/image/restore"),
        lambda: guest.put(f"/api/v1/recipe-groups/{group['id']}", json={"name": "Mine now"}),
        lambda: guest.delete(f"/api/v1/recipe-groups/{group['id']}"),
        lambda: guest.post(f"/api/v1/recipe-groups/{group['id']}/members", json={"food_ids": [recipe["food"]["id"]]}),
        lambda: guest.post(f"/api/v1/recipe-groups/{group['id']}/members/remove", json={"food_ids": [recipe["food"]["id"]]}),
        lambda: guest.put("/api/v1/recipe-groups/order", json={"ids": [group["id"]]}),
        lambda: guest.put(f"/api/v1/recipe-groups/foods/{recipe['food']['id']}", json={"group_ids": []}),
    ):
        r = call()
        assert r.status_code == 403 and r.json()["detail"], r.text
    # nothing changed
    assert guest.get(f"/api/v1/foods/{food['id']}").json()["name"] == "Oats"
    assert guest.get("/api/v1/recipe-groups").json()[0]["food_ids"] == [recipe["food"]["id"]]
    assert guest.get("/api/v1/recipes").json()[0]["id"] == recipe["id"]


def test_guest_reads_everything_and_uses_it(guest, house):
    food, recipe = house["food"], house["recipe"]
    assert [f["id"] for f in guest.get("/api/v1/foods").json()][-1] == food["id"] or food["id"] in [f["id"] for f in guest.get("/api/v1/foods").json()]
    entry = guest.post("/api/v1/diary/2026-01-10/entries", json={"food_id": recipe["food"]["id"], "meal": "lunch", "amount": 100})
    assert entry.status_code == 201
    # a recipe of a guest can be made of the household's foods
    own = guest.post("/api/v1/recipes", json={"name": "Mine", "portions": 1, "items": [{"food_id": food["id"], "amount": 30}]})
    assert own.status_code == 201


def test_guest_owns_what_they_create(guest, mum, house):
    created = guest.post("/api/v1/foods", json={**FOOD, "name": "Guest bread"})
    assert created.status_code == 201 and created.json()["can_edit"] is True
    fid = created.json()["id"]
    assert guest.get(f"/api/v1/foods/{fid}").json()["can_edit"] is True
    assert guest.put(f"/api/v1/foods/{fid}", json={**FOOD, "name": "Better bread"}).json()["name"] == "Better bread"
    assert guest.put(f"/api/v1/foods/{fid}/piece", json={"label": "slice", "grams": 30}).status_code == 200
    assert guest.delete(f"/api/v1/foods/{fid}/piece").status_code == 204
    assert [f["can_edit"] for f in guest.get("/api/v1/foods?q=bread").json()] == [True]
    assert guest.delete(f"/api/v1/foods/{fid}").status_code == 204
    # the household may change what a guest made
    again = guest.post("/api/v1/foods", json={**FOOD, "name": "Guest cake"}).json()
    assert mum.get(f"/api/v1/foods/{again['id']}").json()["can_edit"] is True
    assert mum.put(f"/api/v1/foods/{again['id']}", json={**FOOD, "name": "Cake"}).status_code == 200
    assert mum.delete(f"/api/v1/foods/{again['id']}").status_code == 204


def test_guest_owns_their_recipes_and_groups(guest, mum, house):
    base = guest.post("/api/v1/foods", json={**FOOD, "name": "Flour"}).json()
    body = {"name": "Pancakes", "portions": 2, "items": [{"food_id": base["id"], "amount": 100}]}
    made = guest.post("/api/v1/recipes", json=body)
    assert made.status_code == 201 and made.json()["can_edit"] is True and made.json()["food"]["can_edit"] is True
    rid, fid = made.json()["id"], made.json()["food"]["id"]
    assert guest.put(f"/api/v1/recipes/{rid}", json={**body, "name": "Crepes"}).json()["food"]["name"] == "Crepes"
    group = guest.post("/api/v1/recipe-groups", json={"name": "Sweet"})
    assert group.status_code == 201 and group.json()["can_edit"] is True
    gid = group.json()["id"]
    assert guest.put(f"/api/v1/recipe-groups/{gid}", json={"name": "Sweeter"}).status_code == 200
    # an own group may hold the household's recipes too, and the recipe may stay in the household's group meanwhile
    both = [house["recipe"]["food"]["id"], fid]
    assert guest.post(f"/api/v1/recipe-groups/{gid}/members", json={"food_ids": both}).json()["food_ids"] == sorted(both)
    assert guest.post(f"/api/v1/recipe-groups/{gid}/members/remove", json={"food_ids": [fid]}).status_code == 200
    # setting the groups of a recipe: only the guest's own groups may change
    hid = house["group"]["id"]
    assert guest.put(f"/api/v1/recipe-groups/foods/{house['recipe']['food']['id']}", json={"group_ids": [hid, gid]}).status_code == 200
    assert guest.put(f"/api/v1/recipe-groups/foods/{house['recipe']['food']['id']}", json={"group_ids": [gid]}).status_code == 403
    assert guest.put(f"/api/v1/recipe-groups/foods/{fid}", json={"group_ids": [hid]}).status_code == 403
    assert guest.put(f"/api/v1/recipe-groups/foods/{fid}", json={"group_ids": [gid]}).status_code == 200
    assert guest.delete(f"/api/v1/recipe-groups/{gid}").status_code == 204
    assert guest.delete(f"/api/v1/recipes/{rid}").status_code == 204
    # the household's group and recipe are all still there
    assert [g["id"] for g in mum.get("/api/v1/recipe-groups").json()] == [hid]
    assert [r["id"] for r in mum.get("/api/v1/recipes").json()] == [house["recipe"]["id"]]


def test_household_may_change_everything(mum, guest, house):
    mine = guest.post("/api/v1/foods", json=FOOD).json()
    group = guest.post("/api/v1/recipe-groups", json={"name": "Theirs"}).json()
    recipe = guest.post("/api/v1/recipes", json={**RECIPE, "items": [{"food_id": mine["id"], "amount": 10}]}).json()
    assert mum.put(f"/api/v1/foods/{house['food']['id']}", json={**FOOD, "name": "Rolled oats"}).status_code == 200
    assert mum.put(f"/api/v1/recipe-groups/{group['id']}", json={"name": "Renamed"}).status_code == 200
    assert mum.put("/api/v1/recipe-groups/order", json={"ids": [house["group"]["id"], group["id"]]}).status_code == 200
    assert mum.put(f"/api/v1/recipes/{recipe['id']}", json={**RECIPE, "items": [{"food_id": mine["id"], "amount": 20}]}).status_code == 200
    assert mum.delete(f"/api/v1/recipes/{recipe['id']}").status_code == 204
    assert mum.delete(f"/api/v1/recipe-groups/{group['id']}").status_code == 204
    assert mum.delete(f"/api/v1/recipes/{house['recipe']['id']}").status_code == 204
    assert mum.delete(f"/api/v1/foods/{house['food']['id']}").status_code == 204


def test_barcode_rule_for_guests(guest, mum, upstream):
    own = {**FOOD, "name": "Own Nutella"}
    # a barcode the household fetched from Open Food Facts is the household's: a guest never replaces it
    assert mum.get(f"/api/v1/foods/barcode/{NUTELLA}").status_code == 200
    r = guest.put(f"/api/v1/foods/barcode/{NUTELLA}", json=own)
    assert r.status_code == 403
    assert guest.get(f"/api/v1/foods/barcode/{NUTELLA}").json()["name"] == "Nutella"
    assert mum.put(f"/api/v1/foods/barcode/{NUTELLA}", json=own).json()["name"] == "Own Nutella"  # the household may
    # a remembered miss is no entry: the guest may make one, and then owns it
    assert mum.get(f"/api/v1/foods/barcode/{UNKNOWN}").status_code == 404
    made = guest.put(f"/api/v1/foods/barcode/{UNKNOWN}", json={**FOOD, "name": "Mystery"})
    assert made.status_code == 200 and made.json()["can_edit"] is True
    assert guest.put(f"/api/v1/foods/barcode/{UNKNOWN}", json={**FOOD, "name": "Mystery 2"}).json()["name"] == "Mystery 2"


def test_what_a_guest_fetches_from_outside_is_the_households(server, guest, mum):
    """Open Food Facts, the catalogue, web pages and Cookidoo fill shared entries: whoever looks first must not own them."""
    got = guest.get(f"/api/v1/foods/barcode/{NUTELLA}")  # fetched from Open Food Facts by a guest
    assert got.status_code == 200 and got.json()["can_edit"] is False
    fid = got.json()["id"]
    assert guest.put(f"/api/v1/foods/{fid}", json=FOOD).status_code == 403
    assert guest.delete(f"/api/v1/foods/{fid}").status_code == 403
    assert guest.put(f"/api/v1/foods/barcode/{NUTELLA}", json=FOOD).status_code == 403
    assert server.app.state.store.get_food(fid)["owner"] is None
    assert mum.get(f"/api/v1/foods/{fid}").json()["can_edit"] is True  # the household may always


def test_a_guest_catalogue_adoption_is_the_households(server, guest, monkeypatch):
    class Cat:
        def get(self, source, code):
            return {"source": "openfoodfacts", "code": NUTELLA, "name": "Nutella", "brand": None, "quantity": None, "serving_size": None,
                    "serving_quantity": None, "unit": "g", "per_100": {"kcal": 539, "fat": 30.9, "carbs": 57.5, "protein": 6.3}, "extra": {}, "complete": True}
    from mahlwerk.deps import get_catalog
    server.app.dependency_overrides[get_catalog] = lambda: Cat()
    try:
        r = guest.post("/api/v1/catalog/adopt", json={"source": "openfoodfacts", "code": NUTELLA})
    finally:
        server.app.dependency_overrides.clear()
    assert r.status_code == 201 and r.json()["can_edit"] is False
    assert server.app.state.store.get_food(r.json()["id"])["owner"] is None
    assert guest.put(f"/api/v1/foods/{r.json()['id']}", json=FOOD).status_code == 403


def test_a_stale_household_barcode_refetched_by_a_guest_stays_the_households(server, guest, mum, upstream):
    got = mum.get(f"/api/v1/foods/barcode/{NUTELLA}").json()  # the household's entry from Open Food Facts
    con = sqlite3.connect(server.app.state.store.path)
    con.execute("UPDATE food SET fetched_at = 1 WHERE id = ?", (got["id"],))  # stale: the next look fetches again
    con.commit()
    con.close()
    again = guest.get(f"/api/v1/foods/barcode/{NUTELLA}")
    assert again.status_code == 200 and again.json()["id"] == got["id"] and again.json()["can_edit"] is False
    assert guest.put(f"/api/v1/foods/{got['id']}", json=FOOD).status_code == 403


def test_a_guest_stays_a_guest_when_the_store_is_asked_without_a_flag(tmp_path):
    store = Store(str(tmp_path / "x.db"))
    user = store.get_or_create_user("sam", "Sam", False)
    assert user["household"] is False
    assert store.get_or_create_user("sam", "Sam")["household"] is False  # e.g. a Yazio import: no flag, no change
    assert store.get_or_create_user("new", "New")["household"] is True
    assert store.get_or_create_user("sam", "Sam", True)["household"] is True


def test_a_guest_cannot_overwrite_a_guest(server, guest):
    made = guest.post("/api/v1/foods", json=FOOD).json()
    other = server("gast2", "freunde")
    assert other.put(f"/api/v1/foods/{made['id']}", json=FOOD).status_code == 403
    assert other.delete(f"/api/v1/foods/{made['id']}").status_code == 403
    assert other.get(f"/api/v1/foods/{made['id']}").json()["can_edit"] is False


def test_everybody_is_household_without_the_variable(monkeypatch, tmp_path):
    monkeypatch.delenv("MAHLWERK_HOUSEHOLD_GROUPS", raising=False)
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", PEER)
    app = create_app(str(tmp_path / "plain.db"))
    ann = TestClient(app, client=(PEER, 1), headers={"Remote-User": "ann"})
    ben = TestClient(app, client=(PEER, 1), headers={"Remote-User": "ben", "Remote-Groups": "whatever"})
    assert ann.get("/api/v1/me").json()["household"] is True
    fid = ann.post("/api/v1/foods", json=FOOD).json()["id"]
    assert ben.get(f"/api/v1/foods/{fid}").json()["can_edit"] is True
    assert ben.put(f"/api/v1/foods/{fid}", json={**FOOD, "name": "Changed"}).status_code == 200
    assert ben.delete(f"/api/v1/foods/{fid}").status_code == 204
    monkeypatch.delenv("MAHLWERK_AUTH")
    assert TestClient(create_app(str(tmp_path / "single.db"))).get("/api/v1/me").json()["household"] is True  # single mode: always


def test_a_token_of_a_guest_stays_a_guest(server, guest, mum, house):
    token = guest.post("/api/v1/me/tokens", json={"name": "phone", "scope": "write"}).json()["token"]
    bare = TestClient(server.app, headers={"Authorization": f"Bearer {token}", **CSRF})  # no proxy headers: only the token
    assert bare.get("/api/v1/me").json()["household"] is False
    fid = house["food"]["id"]
    assert bare.put(f"/api/v1/foods/{fid}", json=FOOD).status_code == 403
    assert bare.delete(f"/api/v1/foods/{fid}").status_code == 403
    mine = bare.post("/api/v1/foods", json=FOOD)
    assert mine.status_code == 201 and bare.delete(f"/api/v1/foods/{mine.json()['id']}").status_code == 204
    # the household's token keeps the household's rights
    household = mum.post("/api/v1/me/tokens", json={"name": "phone", "scope": "write"}).json()["token"]
    bare = TestClient(server.app, headers={"Authorization": f"Bearer {household}", **CSRF})
    assert bare.get("/api/v1/me").json()["household"] is True
    assert bare.put(f"/api/v1/foods/{fid}", json={**FOOD, "name": "Via token"}).status_code == 200


# ---- local mode: an admin sets it per user ----


def test_local_mode_admin_makes_a_user_a_guest(browser, admin):
    r = admin.post("/api/v1/admin/users", json={"username": "sam", "password": PW, "household": False})
    assert r.status_code == 201 and r.json()["household"] is False
    sam = browser()
    assert sam.post("/api/v1/auth/login", json={"username": "sam", "password": PW}).status_code == 200
    assert sam.get("/api/v1/me").json()["household"] is False
    fid = admin.post("/api/v1/foods", json=FOOD).json()["id"]
    assert sam.put(f"/api/v1/foods/{fid}", json=FOOD).status_code == 403
    assert {u["username"]: u["household"] for u in admin.get("/api/v1/admin/users").json()} == {"alex": True, "sam": False}
    assert admin.patch("/api/v1/admin/users/sam", json={"household": True}).json()["household"] is True
    assert sam.put(f"/api/v1/foods/{fid}", json={**FOOD, "name": "Now allowed"}).status_code == 200
    assert admin.patch("/api/v1/admin/users/sam", json={"household": False}).json()["household"] is False
    assert sam.get("/api/v1/me").json()["household"] is False
    assert sam.patch("/api/v1/admin/users/alex", json={"household": False}).status_code == 403  # not an admin
    # an admin is always a household member
    assert admin.patch("/api/v1/admin/users/alex", json={"household": False}).json()["household"] is True
    # ... also for an access key of that admin (the stored flag is honest too), and a guest made admin becomes a member
    token = admin.post("/api/v1/me/tokens", json={"name": "k", "scope": "write"}).json()["token"]
    bare = TestClient(admin.app, headers={"Authorization": f"Bearer {token}", **CSRF})
    assert bare.get("/api/v1/me").json()["household"] is True
    assert admin.patch("/api/v1/admin/users/sam", json={"is_admin": True}).json()["household"] is True
    assert admin.app.state.store.local_user("sam")["household"] == 1


# ---- Cookidoo: the household's account is not for guests ----


@pytest.fixture
def cook(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", PEER)
    monkeypatch.setenv("MAHLWERK_HOUSEHOLD_GROUPS", "eltern")
    monkeypatch.setenv("MAHLWERK_COOKIDOO", "1")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", SECRET_MAIL)
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", SECRET_PASSWORD)
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    app = create_app(str(tmp_path / "ck.db"))
    fake = FakeClient()
    app.state.cookidoo.factory = lambda settings: fake
    return (TestClient(app, client=(PEER, 1), headers={"Remote-User": "mum", "Remote-Groups": "eltern"}),
            TestClient(app, client=(PEER, 1), headers={"Remote-User": "gast", "Remote-Groups": "x"}), fake)


def test_guest_does_not_get_the_household_cookidoo_account(cook):
    mum, guest, fake = cook
    assert mum.get("/api/v1/cookidoo/status").json()["state"] == "ready"
    assert guest.get("/api/v1/cookidoo/status").json()["state"] == "not_configured"
    for path in ("/api/v1/cookidoo/week", "/api/v1/cookidoo/collections", "/api/v1/cookidoo/recipe?ref=r100001"):
        assert guest.get(path).status_code == 409, path
    assert guest.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).status_code == 409
    assert fake.calls == []  # the shared account was never used for the guest
    assert guest.post("/api/v1/cookidoo/import", json={"scope": "all"}).status_code == 403
    assert guest.post("/api/v1/cookidoo/images").status_code in (403, 409)
    assert mum.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).status_code == 200


def test_guest_with_an_own_cookidoo_account_adopts_for_the_household(cook):
    mum, guest, fake = cook
    assert guest.put("/api/v1/me/cookidoo-account", json={"email": "g@example.invalid", "password": "pw-not-real-1"}).status_code == 200
    adopted = guest.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "collection": "c1"})
    assert adopted.status_code == 200 and adopted.json()["can_edit"] is False  # an external entry belongs to the household
    assert guest.put(f"/api/v1/foods/{adopted.json()['id']}", json=FOOD).status_code == 403
    assert mum.get("/api/v1/recipe-groups").json() == []  # no shared collection group made by a guest
    # a recipe the household took over is theirs: the guest cannot renew it
    assert mum.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).status_code == 200  # the household may renew a guest's
    fake.recipes["r100002"] = fake.recipes["r100001"].__class__(**{**vars(fake.recipes["r100001"]), "id": "r100002"})
    assert mum.post("/api/v1/cookidoo/adopt", json={"recipe": "r100002"}).status_code == 200
    assert guest.post("/api/v1/cookidoo/adopt", json={"recipe": "r100002"}).status_code == 403


# ---- web recipes ----


def test_pictures_of_a_household_web_recipe_are_the_households(server, mum, guest):
    """A recipe taken over from a web page by the household (no owner): a guest cannot give it a picture or take it away."""
    store: Store = server.app.state.store
    fid, _ = store.put_external_food("web:example.org/a", "web", {"name": "A", "per_100": {"kcal": 100}, "url": "https://example.org/a"}, None)
    assert guest.get(f"/api/v1/foods/{fid}").json()["can_edit"] is False
    assert mum.get(f"/api/v1/foods/{fid}").json()["can_edit"] is True
    assert guest.put(f"/api/v1/foods/{fid}/image", content=b"x").status_code == 403
    assert guest.delete(f"/api/v1/foods/{fid}/image").status_code == 403


# ---- migration ----


def test_version_15_database_gets_household_and_owner_columns(tmp_path):
    path = str(tmp_path / "v15.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V16)
    con.executescript(
        """
        INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'me', 'Me', 1), (2, 'ann', 'Ann', 1);
        INSERT INTO food (id, source, found, data, fetched_at) VALUES
            (7, 'own', 1, '{"name": "Rice", "per_100": {"kcal": 130}}', 1),
            (8, 'recipe', 1, '{"name": "Soup", "per_100": {"kcal": 50}}', 1);
        INSERT INTO recipe (id, food_id, portions, created_by, updated_at) VALUES (1, 8, 2, 2, 1);
        PRAGMA user_version = 15;
        """
    )
    con.commit()
    con.close()
    store = Store(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 17
    assert {r[1] for r in con.execute("PRAGMA table_info(food)")} >= {"created_by"}
    assert [r[0] for r in con.execute("SELECT household FROM user ORDER BY id")] == [1, 1]  # existing users stay household members
    con.close()
    assert store.get_food(7)["owner"] is None  # an old food belongs to the household
    assert store.get_food(8)["owner"] == 2  # an old recipe keeps its author
    Store(path)  # and a second start changes nothing

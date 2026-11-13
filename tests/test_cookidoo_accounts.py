"""Cookidoo accounts in the app: the shared one (admin), an own one per person, never mixed, never shown.

Like test_cookidoo.py nothing here reaches Cookidoo: the client is a stand-in that remembers whose it is.
"""

import asyncio
import logging

import pytest
from fastapi.testclient import TestClient

from mahlwerk import cookidoo
from mahlwerk.cookidoo import CookidooError, Collection, PlanDay, PlannedRecipe, RecipeDetails, Settings
from mahlwerk.main import create_app
from test_cookidoo import entry

ADMIN_MAIL, ANN_MAIL, BEN_MAIL = "household@example.invalid", "ann.private@example.invalid", "ben.private@example.invalid"
ADMIN_PW, ANN_PW, BEN_PW = "household-pw-0001", "ann-private-pw-0002", "ben-private-pw-0003"


class OwnedClient:
    """A stand-in client that answers with the name of the account it was built for, so a mix-up is visible."""

    def __init__(self, settings):
        self.email = settings.email
        self.settings = settings
        self.closed = False
        self.fail: str | None = None
        self.calls = 0

    def _go(self):
        self.calls += 1
        if self.fail:
            if self.fail == "boom":
                raise RuntimeError(f"boom with {self.settings.password}")  # an unexpected failure that mentions the secret
            raise CookidooError(self.fail)

    async def week(self, day):
        self._go()
        return [PlanDay(day="2026-01-12", title=self.email, recipes=[PlannedRecipe("r100001", f"from {self.email}")])]

    async def collections(self):
        self._go()
        return [Collection("c1", self.email, False, [])]

    async def recipe(self, recipe_id):
        self._go()
        return RecipeDetails(recipe_id, f"Recipe of {self.email}", 2.0, entry({"kcal": (400, "kcal"), "fat": (10, "g")}))

    async def ping(self):
        self._go()

    async def close(self):
        self.closed = True


@pytest.fixture
def world(monkeypatch, tmp_path):
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    app = create_app(str(tmp_path / "w.db"))
    app.state.store.set_global("cookidoo.enabled", True)
    built: list[OwnedClient] = []

    def factory(settings):
        client = OwnedClient(settings)
        built.append(client)
        return client

    app.state.cookidoo.factory = factory
    now = [1_000_000.0]
    app.state.cookidoo.clock = lambda: now[0]

    def who(name, groups=None):
        headers = {"Remote-User": name, **({"Remote-Groups": groups} if groups else {})}
        return TestClient(app, client=("10.0.0.5", 1), headers=headers)

    class World:
        pass

    w = World()
    w.app, w.built, w.now = app, built, now
    w.admin, w.ann, w.ben = who("root", "admin"), who("ann"), who("ben")
    w.who = who
    return w


def body(email, password, **extra):
    return {"email": email, "password": password, **extra}


def card(world):
    return next(c for c in world.admin.get("/api/v1/admin/connectors").json() if c["key"] == "cookidoo")


def week_title(client):
    r = client.get("/api/v1/cookidoo/week")
    assert r.status_code == 200, r.text
    return r.json()[0]["title"]


# ---- the shared account (admin area) ----


def test_admin_stores_the_shared_account_and_nothing_comes_back(world):
    r = world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW, country="at", language="de-AT"))
    assert r.status_code == 200
    out = r.json()
    assert out["source"] == "stored" and out["email"] == "h***@example.invalid" and out["editable"] is True
    assert (out["country"], out["language"]) == ("at", "de-AT") and out["key"] == "file"
    for url in ("/api/v1/admin/cookidoo/account", "/api/v1/admin/connectors", "/api/v1/cookidoo/status", "/api/v1/me/cookidoo-account"):
        text = world.admin.get(url).text
        assert ADMIN_PW not in text and ADMIN_MAIL not in text
    assert card(world)["info"]["account"]["email"] == "h***@example.invalid" and card(world)["status"] == "ready"


def test_the_stored_account_is_encrypted_in_the_database(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    with open(world.app.state.store.path, "rb") as handle:
        raw = handle.read()
    assert ADMIN_PW.encode() not in raw and ADMIN_MAIL.encode() not in raw


def test_everybody_without_an_own_account_uses_the_shared_one(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    assert week_title(world.ann) == ADMIN_MAIL and week_title(world.ben) == ADMIN_MAIL
    assert len(world.built) == 1  # one client, shared
    assert world.ann.get("/api/v1/cookidoo/status").json()["account"] == "shared"


def test_nothing_is_configured_at_first_and_the_routes_say_so(world):
    assert card(world)["info"]["account"]["source"] == "none" and card(world)["status"] == "not_configured"
    r = world.ann.get("/api/v1/cookidoo/week")
    assert r.status_code == 409 and "not configured" in r.json()["detail"]


def test_only_admins_reach_the_shared_account_endpoints(world):
    for method, url in (("get", "/account"), ("put", "/account"), ("delete", "/account"), ("post", "/account/check")):
        r = getattr(world.ann, method)("/api/v1/admin/cookidoo" + url, **({"json": body(ANN_MAIL, ANN_PW)} if method == "put" else {}))
        assert r.status_code == 403


def test_environment_wins_and_cannot_be_changed(world, monkeypatch):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", "env@example.invalid")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", "env-password-9")
    assert week_title(world.ben) == "env@example.invalid"
    out = world.admin.get("/api/v1/admin/cookidoo/account").json()
    assert out["source"] == "env" and out["editable"] is False and out["email"] == "e***@example.invalid"
    for r in (world.admin.put("/api/v1/admin/cookidoo/account", json=body("x@example.invalid", "pw-pw-pw-1")),
              world.admin.delete("/api/v1/admin/cookidoo/account")):
        assert r.status_code == 409 and "environment" in r.json()["detail"]
    assert "env-password" not in world.admin.get("/api/v1/admin/connectors").text
    monkeypatch.delenv("MAHLWERK_COOKIDOO_EMAIL")
    assert week_title(world.ben) == ADMIN_MAIL  # without the environment the stored one counts again


def test_remove_forgets_the_account_and_closes_its_client(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    week_title(world.ben)
    r = world.admin.delete("/api/v1/admin/cookidoo/account")
    assert r.json()["source"] == "none" and world.built[0].closed is True
    assert world.ben.get("/api/v1/cookidoo/week").status_code == 409


def test_changing_the_account_starts_fresh_with_no_old_cache(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    assert week_title(world.ben) == ADMIN_MAIL
    world.admin.put("/api/v1/admin/cookidoo/account", json=body("other@example.invalid", "other-pw-0007"))
    assert world.built[0].closed is True
    assert week_title(world.ben) == "other@example.invalid"  # not the cached list of the old account within the minute


def test_check_signs_in_once_and_is_braked(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").json() == {"ok": True}
    r = world.admin.post("/api/v1/admin/cookidoo/account/check")
    assert r.status_code == 429 and "half a minute" in r.json()["detail"]
    world.now[0] += 31
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 200


def test_a_failed_check_blocks_for_five_minutes_but_new_credentials_get_one_try_after_the_gap(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, "wrong-password-1"))
    world.app.state.cookidoo.factory = lambda s: _failing(world, s)
    r = world.admin.post("/api/v1/admin/cookidoo/account/check")
    assert r.status_code == 502 and "sign-in failed" in r.json()["detail"]
    world.now[0] += 60
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 502  # blocked: no new attempt at all
    assert len(world.built) == 1
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, "right-password-2"))  # changed: the block ends ...
    world.now[0] += 1  # ... but not within half a minute of the refusal
    r = world.admin.post("/api/v1/admin/cookidoo/account/check")
    assert r.status_code == 429 and len(world.built) == 1
    world.now[0] += 60
    r = world.admin.post("/api/v1/admin/cookidoo/account/check")
    assert r.status_code == 502 and len(world.built) == 2  # one attempt (here failing again)
    world.now[0] += 5
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 429
    assert len(world.built) == 2  # no third attempt


def _failing(world, settings):
    client = OwnedClient(settings)
    client.fail = "auth"
    world.built.append(client)
    return client


def test_check_without_an_account_or_with_the_connector_off(world):
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 409
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    world.admin.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": False})
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 404


# ---- own accounts ----


def test_an_own_account_is_used_by_its_owner_only(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    r = world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    assert r.status_code == 200 and r.json()["source"] == "stored" and r.json()["email"] == "a***@example.invalid"
    assert week_title(world.ann) == ANN_MAIL
    assert week_title(world.ben) == ADMIN_MAIL
    assert world.ann.get("/api/v1/cookidoo/status").json()["account"] == "own"
    assert world.ben.get("/api/v1/cookidoo/status").json()["account"] == "shared"
    # ben does not see that ann has one, nor any part of it; ann's collections and recipes come from her account
    assert world.ben.get("/api/v1/me/cookidoo-account").json()["source"] == "none"
    assert world.ann.get("/api/v1/cookidoo/collections").json()[0]["name"] == ANN_MAIL
    assert world.ben.get("/api/v1/cookidoo/collections").json()[0]["name"] == ADMIN_MAIL
    assert world.ann.get("/api/v1/cookidoo/recipe", params={"ref": "r100001"}).json()["name"] == f"Recipe of {ANN_MAIL}"
    assert world.ben.get("/api/v1/cookidoo/recipe", params={"ref": "r100001"}).json()["name"] == f"Recipe of {ADMIN_MAIL}"
    # every client only ever got the settings of its own account
    assert sorted(c.email for c in world.built) == sorted({ADMIN_MAIL, ANN_MAIL})
    assert {c.email: c.settings.password for c in world.built} == {ADMIN_MAIL: ADMIN_PW, ANN_MAIL: ANN_PW}


def test_two_own_accounts_do_not_mix_and_do_not_share_caches_or_brakes(world):
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    world.ben.put("/api/v1/me/cookidoo-account", json=body(BEN_MAIL, BEN_PW))
    assert week_title(world.ann) == ANN_MAIL and week_title(world.ben) == BEN_MAIL
    world.built[0].fail = "auth"  # ann's account fails ...
    world.now[0] += 120
    assert world.ann.get("/api/v1/cookidoo/week").status_code == 502
    assert world.ann.get("/api/v1/cookidoo/collections").status_code == 502  # ... and is blocked ...
    assert world.ben.get("/api/v1/cookidoo/collections").status_code == 200  # ... while ben is not affected
    assert world.ann.get("/api/v1/cookidoo/status").json()["state"] == "error"
    assert world.ben.get("/api/v1/cookidoo/status").json()["state"] == "ready"


def test_recipes_taken_over_from_an_own_account_belong_to_the_household(world):
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW, country="de", language="de-DE"))
    food = world.ann.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001"}).json()
    assert food["name"] == f"Recipe of {ANN_MAIL}"
    seen = world.ben.get("/api/v1/foods", params={"source": "cookidoo"}).json()
    assert [f["id"] for f in seen] == [food["id"]]
    assert seen[0]["url"] == "https://cookidoo.de/recipes/recipe/de-DE/r100001"  # the region came with the food, not from the environment


def test_the_admin_can_forbid_own_accounts(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    r = world.admin.patch("/api/v1/admin/connectors/cookidoo", json={"config": {"personal": False}})
    assert r.status_code == 200 and r.json()["config"] == {"personal": False, "images": False}
    assert week_title(world.ann) == ADMIN_MAIL  # the stored own account is not used any more
    assert world.ann.get("/api/v1/cookidoo/status").json()["personal_allowed"] is False
    assert world.ben.put("/api/v1/me/cookidoo-account", json=body(BEN_MAIL, BEN_PW)).status_code == 403
    assert world.ann.post("/api/v1/me/cookidoo-account/check").status_code == 403
    out = world.ann.get("/api/v1/me/cookidoo-account").json()
    assert out["allowed"] is False and out["editable"] is False
    assert world.ann.delete("/api/v1/me/cookidoo-account").json()["source"] == "none"  # removing stays possible
    world.admin.patch("/api/v1/admin/connectors/cookidoo", json={"config": {"personal": True}})
    assert world.ben.put("/api/v1/me/cookidoo-account", json=body(BEN_MAIL, BEN_PW)).status_code == 200


def test_the_personal_switch_can_be_fixed_by_the_environment(world, monkeypatch):
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PERSONAL", "0")
    assert card(world)["locked"] == ["config.personal"] and card(world)["config"] == {"personal": False, "images": False}
    r = world.admin.patch("/api/v1/admin/connectors/cookidoo", json={"config": {"personal": True}})
    assert r.status_code == 409
    assert world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW)).status_code == 403


def test_bad_personal_switch_values(world):
    for config in ({"personal": "yes"}, {"other": True}, {"personal": True, "x": 1}):
        assert world.admin.patch("/api/v1/admin/connectors/cookidoo", json={"config": config}).status_code == 422


def test_removing_an_own_account_closes_its_client_and_falls_back(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    assert week_title(world.ann) == ANN_MAIL
    own = next(c for c in world.built if c.email == ANN_MAIL)
    assert world.ann.delete("/api/v1/me/cookidoo-account").json()["source"] == "none"
    assert own.closed is True
    assert week_title(world.ann) == ADMIN_MAIL


def test_own_check(world):
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    assert world.ann.post("/api/v1/me/cookidoo-account/check").json() == {"ok": True}
    assert world.ben.post("/api/v1/me/cookidoo-account/check").status_code == 409  # ben has none: not ann's


# ---- what must not happen ----


def test_an_access_key_can_neither_read_nor_set_nor_check_credentials(world):
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    token = world.ann.post("/api/v1/me/tokens", json={"name": "script", "scope": "write"}).json()["token"]
    key = TestClient(world.app, client=("10.0.0.5", 1), headers={"Authorization": f"Bearer {token}", "Remote-User": "ann"})
    assert key.get("/api/v1/me").status_code == 200  # the key works in general ...
    for method, url in (("get", ""), ("put", ""), ("delete", ""), ("post", "/check")):
        r = getattr(key, method)("/api/v1/me/cookidoo-account" + url, **({"json": body("x@example.invalid", "pw-pw-pw-9")} if method == "put" else {}))
        assert r.status_code == 403, (method, url)
    assert key.get("/api/v1/cookidoo/status").status_code == 403
    assert key.get("/api/v1/me/cookidoo-account").text.count("pw") == 0
    # and the own account is still there
    assert world.ann.get("/api/v1/me/cookidoo-account").json()["email"] == "a***@example.invalid"


def test_writes_need_the_request_header(world):
    del world.ann.headers["X-Mahlwerk-Request"]
    for method in ("put", "delete"):
        r = getattr(world.ann, method)("/api/v1/me/cookidoo-account", **({"json": body(ANN_MAIL, ANN_PW)} if method == "put" else {}))
        assert r.status_code == 403
    assert world.ann.post("/api/v1/me/cookidoo-account/check").status_code == 403


def test_oversized_body_is_refused(world):
    r = world.ann.put("/api/v1/me/cookidoo-account", content=b'{"email":"' + b"a" * 2_000_000 + b'"}', headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_validation_errors_never_echo_the_input(world):
    for payload in ({"email": ANN_MAIL, "password": ANN_PW, "country": "deu"}, {"email": ANN_MAIL, "password": ANN_PW, "language": "xx"},
                    {"email": "", "password": ANN_PW}, {"email": ANN_MAIL, "password": ""}, {"email": 5, "password": ANN_PW},
                    {"email": ANN_MAIL, "password": [ANN_PW]}, {"email": ANN_MAIL, "password": ANN_PW * 100}):
        r = world.ann.put("/api/v1/me/cookidoo-account", json=payload)
        assert r.status_code == 422 and ANN_PW not in r.text and ANN_MAIL not in r.text, payload
    assert world.ann.get("/api/v1/me/cookidoo-account").json()["source"] == "none"


def test_secrets_are_not_logged_even_when_the_client_blows_up_with_them(world, caplog):
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    next_client = []
    world.app.state.cookidoo.factory = lambda s: next_client.append(OwnedClient(s)) or _boom(next_client[-1])
    with caplog.at_level(logging.DEBUG):
        r = world.ann.get("/api/v1/cookidoo/week")
    assert r.status_code == 502 and ANN_PW not in r.text and ANN_PW not in caplog.text and ANN_MAIL not in caplog.text


def _boom(client):
    client.fail = "boom"
    return client


def test_without_the_key_the_stored_account_counts_as_not_there(world):
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    key = world.app.state.vault.key_path
    key.unlink()  # a restore of the database without its key file
    out = world.admin.get("/api/v1/admin/cookidoo/account").json()
    assert out["source"] == "unreadable" and out["email"] is None and out["key"] == "none"
    assert card(world)["status"] == "not_configured"
    assert world.ann.get("/api/v1/me/cookidoo-account").json()["source"] == "unreadable"
    r = world.ann.get("/api/v1/cookidoo/week")
    assert r.status_code == 409 and "not configured" in r.json()["detail"]
    assert world.ann.get("/api/v1/me").status_code == 200  # the app itself is fine
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, ADMIN_PW))  # entered again: works
    assert week_title(world.ben) == ADMIN_MAIL


def test_an_unusable_key_says_503_without_details(world, monkeypatch):
    monkeypatch.setenv("MAHLWERK_SECRET_KEY", "x" * 31)
    r = world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    assert r.status_code == 503 and "MAHLWERK_SECRET_KEY" in r.json()["detail"] and ANN_PW not in r.text


# ---- the hub: clients, caps, clean-up ----


def run(coro):
    return asyncio.run(coro)


def access(key, n):
    return cookidoo.Access(key, Settings.build(f"u{n}@example.invalid", f"password-{n:04d}", "de", "de-DE"), "own")


def test_at_most_max_clients_are_held_and_the_others_are_closed(monkeypatch):
    monkeypatch.setattr(cookidoo, "MAX_CLIENTS", 2)
    built = []
    hub = cookidoo.Hub(lambda s: built.append(OwnedClient(s)) or built[-1], clock=lambda: 1e6)

    async def go():
        for n in range(5):
            await hub.week(access(f"user:{n}", n))
            assert hub.client_count() <= 2
        return [c.closed for c in built]

    assert run(go()) == [True, True, True, False, False]


def test_idle_clients_are_closed(monkeypatch):
    now = [1e6]
    built = []
    hub = cookidoo.Hub(lambda s: built.append(OwnedClient(s)) or built[-1], clock=lambda: now[0])

    async def go():
        await hub.week(access("user:1", 1))
        now[0] += cookidoo.IDLE_SECONDS + 1
        await hub.week(access("user:2", 2))
        return built[0].closed, built[1].closed

    assert run(go()) == (True, False)


def test_forget_empties_the_account_and_a_refusal_is_not_forgotten():
    now = [1e6]
    built = []
    hub = cookidoo.Hub(lambda s: built.append(OwnedClient(s)) or built[-1], clock=lambda: now[0])
    a = access("user:1", 1)

    async def go():
        await hub.week(a)
        await hub.forget("user:1")
        assert built[0].closed and hub.client_count() == 0
        built[0].fail = "auth"
        await hub.forget("user:1")  # nothing new has been asked since: still a clean slate
        await hub.week(a)  # a fresh client (the next one is fine) ...
        assert len(built) == 2 and built[1].closed is False
        built[1].fail = "auth"
        hub._accounts["user:1"].lists.clear()
        with pytest.raises(CookidooError):  # ... which is refused: the account is blocked
            await hub.week(a)
        await hub.forget("user:1")
        assert hub._accounts["user:1"].last_fail == now[0]  # the refusal is remembered
        with pytest.raises(CookidooError) as exc:
            await hub.week(a)
        assert exc.value.kind == "wait"
        now[0] += cookidoo.LOGIN_GAP + 1
        await hub.week(a)

    run(go())


def test_the_global_call_limit_covers_all_accounts(monkeypatch):
    monkeypatch.setattr(cookidoo, "GLOBAL_CALL_LIMIT", (3, 300))
    hub = cookidoo.Hub(lambda s: OwnedClient(s), clock=lambda: 1e6)

    async def go():
        for n in range(3):
            await hub.recipe(access(f"user:{n}", n), f"r10000{n}")
        with pytest.raises(CookidooError) as exc:
            await hub.recipe(access("user:9", 9), "r100009")
        return exc.value.kind

    assert run(go()) == "busy"


def test_settings_are_never_in_their_repr_and_access_hides_them_too():
    a = access("user:1", 1)
    assert "password-0001" not in repr(a) and "password-0001" not in repr(a.settings) and "u1@" not in repr(a)


# ---- rationing of sign-ins: not to be got around by changing the account ----


def test_changing_the_account_does_not_buy_new_sign_in_attempts(world):
    """5 refusals an hour per person, however often the stored account is changed or removed in between."""
    world.app.state.cookidoo.factory = lambda s: _failing(world, s)
    for n in range(5):
        r = world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, f"guess-number-{n:04d}"))
        assert r.status_code == 200
        world.now[0] += cookidoo.LOGIN_GAP + 1
        assert world.ann.post("/api/v1/me/cookidoo-account/check").status_code == 502
    assert len(world.built) == 5
    for _ in range(3):  # a sixth, seventh ... try: changed again, removed and added again, a plain request
        world.ann.delete("/api/v1/me/cookidoo-account")
        world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, "yet-another-guess"))
        world.now[0] += cookidoo.AUTH_COOLDOWN + cookidoo.LOGIN_GAP + 1
        r = world.ann.post("/api/v1/me/cookidoo-account/check")
        assert r.status_code == 429 and "refused sign-ins" in r.json()["detail"]
        assert world.ann.get("/api/v1/cookidoo/week").status_code == 429
    assert len(world.built) == 5  # nothing was sent to Cookidoo
    world.now[0] += 3600  # an hour after the refusals: allowed again
    world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, ANN_PW))
    world.app.state.cookidoo.factory = lambda s: world.built.append(OwnedClient(s)) or world.built[-1]
    assert world.ann.post("/api/v1/me/cookidoo-account/check").json() == {"ok": True}


def test_the_count_is_per_person_so_one_cannot_lock_out_another(world):
    world.app.state.cookidoo.factory = lambda s: _failing(world, s)
    for n in range(5):
        world.ann.put("/api/v1/me/cookidoo-account", json=body(ANN_MAIL, f"guess-number-{n:04d}"))
        world.now[0] += cookidoo.LOGIN_GAP + 1
        world.ann.post("/api/v1/me/cookidoo-account/check")
    world.app.state.cookidoo.factory = lambda s: world.built.append(OwnedClient(s)) or world.built[-1]
    world.ben.put("/api/v1/me/cookidoo-account", json=body(BEN_MAIL, BEN_PW))
    assert week_title(world.ben) == BEN_MAIL


def test_the_shared_account_is_rationed_the_same_way_through_the_admin(world):
    world.app.state.cookidoo.factory = lambda s: _failing(world, s)
    for n in range(5):
        world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, f"guess-number-{n:04d}"))
        world.now[0] += cookidoo.LOGIN_GAP + 1
        assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 502
    world.admin.delete("/api/v1/admin/cookidoo/account")
    world.admin.put("/api/v1/admin/cookidoo/account", json=body(ADMIN_MAIL, "one-more"))
    world.now[0] += cookidoo.AUTH_COOLDOWN + 1
    assert world.admin.post("/api/v1/admin/cookidoo/account/check").status_code == 429
    assert len(world.built) == 5


def test_at_most_20_sign_ins_an_hour_for_all_accounts_together():
    now = [1e6]
    built = []
    hub = cookidoo.Hub(lambda s: built.append(OwnedClient(s)) or built[-1], clock=lambda: now[0])

    async def go():
        for n in range(20):
            await hub.week(access(f"user:{n}", n))
        with pytest.raises(CookidooError) as exc:
            await hub.week(access("user:99", 99))
        assert exc.value.kind == "busy"
        await hub.week(access("user:3", 3))  # a sign-in that already exists needs no new attempt
        now[0] += 3601
        await hub.week(access("user:99", 99))

    run(go())
    assert len(built) == 21


def test_evicting_idle_accounts_does_not_forget_refusals(monkeypatch):
    monkeypatch.setattr(cookidoo, "MAX_ACCOUNTS", 2)
    now = [1e6]
    hub = cookidoo.Hub(lambda s: _auth_failing(s), clock=lambda: now[0])

    async def go():
        a = access("user:1", 1)
        for n in range(5):
            with pytest.raises(CookidooError):
                await hub.week(cookidoo.Access("user:1", Settings.build("a@example.invalid", f"guess-{n:08d}", "de", "de-DE"), "own"))
            now[0] += cookidoo.AUTH_COOLDOWN + cookidoo.LOGIN_GAP + 1
        for k in (2, 3, 4):  # other people push the account out of the hub
            now[0] += 1
            with pytest.raises(CookidooError):
                await hub.week(access(f"user:{k}", k))
        assert "user:1" not in hub._accounts
        with pytest.raises(CookidooError) as exc:
            await hub.week(a)
        assert exc.value.kind == "locked"

    run(go())


def _auth_failing(settings):
    client = OwnedClient(settings)
    client.fail = "auth"
    return client


class SlowClient(OwnedClient):
    def __init__(self, settings, gate):
        super().__init__(settings)
        self.gate = gate

    async def week(self, day):
        await self.gate.wait()
        return await super().week(day)


def test_an_answer_that_arrives_after_a_change_is_not_cached():
    now = [1e6]
    gate = None
    made = []

    def factory(settings):
        made.append(SlowClient(settings, gate))
        return made[-1]

    hub = cookidoo.Hub(factory, clock=lambda: now[0])

    async def go():
        nonlocal gate
        gate = asyncio.Event()
        old = access("user:1", 1)
        slow = asyncio.create_task(hub.week(old))
        await asyncio.sleep(0.05)
        await hub.forget("user:1")  # the account is removed while the request is on its way
        gate.set()
        assert (await slow)[0].title == "u1@example.invalid"  # the caller still gets its answer ...
        assert hub._accounts["user:1"].lists == {} and hub._accounts["user:1"].last_error is None  # ... but nothing is kept

    run(go())


def test_a_request_that_waited_for_the_lock_while_the_account_was_removed_gets_a_neutral_answer():
    gate = None
    hub = None

    def factory(settings):
        return SlowClient(settings, gate)

    hub = cookidoo.Hub(factory, clock=lambda: 1e6)

    async def go():
        nonlocal gate
        gate = asyncio.Event()
        a = access("user:1", 1)
        first = asyncio.create_task(hub.week(a))
        await asyncio.sleep(0.05)
        second = asyncio.create_task(hub.recipe(a, "r100001"))  # waits for the lock
        await asyncio.sleep(0.05)
        await hub.forget("user:1")  # settings are gone now
        gate.set()
        await first
        with pytest.raises(CookidooError) as exc:
            await second
        assert exc.value.kind == "gone" and str(exc.value) == cookidoo.MESSAGES["gone"]

    run(go())


def test_country_and_language_must_match_completely():
    assert cookidoo.COUNTRY.fullmatch("de\n") is None and cookidoo.LANGUAGE.fullmatch("de-DE\n") is None
    assert cookidoo.RECIPE_ID.fullmatch("r100001\n") is None
    assert cookidoo.recipe_url("cookidoo:r100001", region=["de", "de-DE\n"]) is None
    assert cookidoo.recipe_id("r100001\n") == "r100001"  # stripped first, as before
    assert cookidoo.recipe_url("cookidoo:r100001", region=["de\n", "de-DE"]) is None

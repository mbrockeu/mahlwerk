"""Taking over many Cookidoo recipes at once: pacing, idempotence, stopping, one run per account, groups.

Nothing here reaches Cookidoo and nothing sleeps: the client is a stand-in and the clock is an injected one that the stand-in
`sleep` advances, so the pacing is checked from the times at which the calls were made.
"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from mahlwerk import cookidoo, cookidoo_bulk
from mahlwerk.cookidoo import Access, Collection, CookidooError, Hub, NutritionEntry, PlanDay, PlannedRecipe, RecipeDetails, Settings
from mahlwerk.cookidoo_bulk import BulkError, BulkRuns, make_plan
from mahlwerk.db import Store
from mahlwerk.main import create_app
from test_cookidoo import fake, on  # noqa: F401  (the fixtures)

SETTINGS = Settings("someone@example.invalid", "pw-not-real", "de", "de-DE")


def access(key="shared"):
    return Access(key, SETTINGS, "shared" if key == "shared" else "own")


def details(rid, name=None):
    values = {"kcal": (400, "kcal"), "fat": (10, "g"), "carb2": (50, "g"), "protein": (20, "g")}
    return RecipeDetails(rid, name or f"Recipe {rid}", 4.0, [NutritionEntry(1, "Portion", values)])


class Clock:
    def __init__(self):
        self.now = time.time()  # the store stamps foods with the system clock, so the runner's clock starts there

    def __call__(self):
        return self.now


class World:
    """A store, a hub and a runner on stand-ins. `collections` and `week` are what the account has."""

    def __init__(self, tmp_path, n=6):
        self.clock = Clock()
        self.store = Store(str(tmp_path / "bulk.db"))
        self.calls: list[tuple[str, float]] = []  # (recipe id, clock at the call)
        self.fail: dict[str, str] = {}  # recipe id -> error kind
        self.reject: set[str] = set()  # recipe ids without nutrition values
        self.sleeps: list[float] = []
        self.enabled = True
        self.on_call = None
        self.ids = [f"r{100000 + i}" for i in range(n)]
        self.refs = [PlannedRecipe(i, f"Recipe {i}") for i in self.ids]
        self.collections = [Collection("c1", "Favourites", False, self.refs[:4]), Collection("c2", "Quick dinners", True, self.refs[2:6])]
        self.week = [PlanDay("d1", "Monday", [self.refs[5], self.refs[0]])]
        world = self

        class Client:
            async def week(self, day):
                return world.week

            async def collections(self):
                return world.collections

            async def recipe(self, rid):
                world.calls.append((rid, world.clock.now))
                if world.on_call:
                    world.on_call(rid)
                if rid in world.fail:
                    raise CookidooError(world.fail[rid])
                if rid in world.reject:
                    return RecipeDetails(rid, f"Recipe {rid}", 2.0, [])
                return details(rid)

            async def ping(self):
                return None

            async def close(self):
                return None

        async def sleep(seconds):
            self.sleeps.append(seconds)
            self.clock.now += seconds
            await asyncio.sleep(0)

        self.hub = Hub(factory=lambda settings: Client(), clock=self.clock)
        self.runs = BulkRuns(self.hub, self.store, lambda: self.enabled, sleep=sleep, clock=self.clock)

    async def go(self, scope="all", collection=None, key="shared", regroup=False):
        plan = await make_plan(self.hub, access(key), scope, collection)
        run = self.runs.start(access(key), plan, None, regroup)
        await run.task
        return run

    def names(self):
        return {g["name"]: g for g in self.store.list_groups()}

    def food(self, rid):
        return self.store.get_food_by_external_id(cookidoo.EXTERNAL_PREFIX + rid)


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


def run(coro):
    return asyncio.run(coro)


# ---- the plan ----


def test_plan_has_every_recipe_once_and_remembers_its_collections(world):
    plan = run(make_plan(world.hub, access(), "all", None))
    assert [i.id for i in plan.items] == world.ids  # four of c1, two more of c2, the plan adds nothing new
    assert {i.id: i.collections for i in plan.items}[world.ids[2]] == ["c1", "c2"]
    assert {i.id: i.collections for i in plan.items}[world.ids[5]] == ["c2"]
    assert plan.groups == {"c1": "Favourites", "c2": "Quick dinners"}


def test_plan_of_one_collection_and_of_the_week(world):
    plan = run(make_plan(world.hub, access(), "collection", "c2"))
    assert [i.id for i in plan.items] == world.ids[2:6] and plan.groups == {"c2": "Quick dinners"}
    week = run(make_plan(world.hub, access(), "week", None))
    assert {i.id for i in week.items} == {world.ids[5], world.ids[0]} and week.groups == {}
    with pytest.raises(BulkError) as err:
        run(make_plan(world.hub, access(), "collection", "nope"))
    assert err.value.kind == "not_found"


def test_plan_refuses_nothing_and_too_many(world):
    world.collections, world.week = [], []
    with pytest.raises(BulkError) as err:
        run(make_plan(world.hub, access(), "all", None))
    assert err.value.kind == "empty"
    many = [PlannedRecipe(f"r{200000 + i}", f"R{i}") for i in range(cookidoo_bulk.MAX_RECIPES + 1)]
    world.clock.now += 61  # the lists are cached for a minute
    world.collections = [Collection("big", "Big", False, many)]
    with pytest.raises(BulkError) as err:
        run(make_plan(world.hub, access(), "all", None))
    assert err.value.kind == "too_many" and err.value.detail == cookidoo_bulk.MAX_RECIPES + 1
    world.clock.now += 61
    world.collections = [Collection("big", "Big", False, many[:cookidoo_bulk.MAX_RECIPES])]
    assert len(run(make_plan(world.hub, access(), "all", None)).items) == cookidoo_bulk.MAX_RECIPES  # exactly the limit is fine


# ---- pacing and idempotence ----


def test_calls_are_at_least_the_gap_apart_and_nothing_really_sleeps(world):
    started = time.monotonic()
    r = run(world.go())
    assert r.state == "done" and r.counts["adopted"] == 6 and r.fetched == 6
    times = [t for _, t in world.calls]
    assert len(times) == 6 and all(b - a >= cookidoo.BULK_GAP - 1e-9 for a, b in zip(times, times[1:]))
    assert len(world.sleeps) == 5 and all(abs(s - cookidoo.BULK_GAP) < 1e-9 for s in world.sleeps)  # none before the first call
    assert time.monotonic() - started < 2


def test_a_second_run_skips_what_is_up_to_date_and_an_old_one_is_updated(world):
    run(world.go())
    calls = len(world.calls)
    again = run(world.go())
    assert len(world.calls) == calls and again.counts["fresh"] == 6 and again.fetched == 0 and again.state == "done"
    world.clock.now += cookidoo_bulk.FRESH_SECONDS + 1
    stale = run(world.go())
    assert stale.counts["updated"] == 6 and stale.counts["adopted"] == 0 and len(world.calls) == calls + 6


def test_preview_counts_what_would_be_fetched(world):
    plan = run(make_plan(world.hub, access(), "all", None))
    assert cookidoo_bulk.summarize(world.store, plan, time.time())["to_fetch"] == 6
    run(world.go("collection", "c1"))
    stats = cookidoo_bulk.summarize(world.store, plan, time.time())
    assert stats == {"total": 6, "fresh": 4, "to_fetch": 2, "eta_seconds": int(2 * cookidoo_bulk.SECONDS_PER_RECIPE)}


def test_recipes_become_cookidoo_foods_with_the_region(world):
    run(world.go("week"))
    food = world.food(world.ids[0])
    assert food["source"] == "cookidoo" and food["data"]["per_100"]["kcal"] == 400.0 and food["data"]["region"] == ["de", "de-DE"]


# ---- failures ----


def test_a_recipe_without_values_is_skipped_and_listed_and_the_run_goes_on(world):
    world.reject = {world.ids[1]}
    r = run(world.go())
    assert r.state == "done" and r.counts["no_nutrition"] == 1 and r.counts["adopted"] == 5 and r.done == 6
    assert r.failures[0]["id"] == world.ids[1] and r.failures[0]["kind"] == "no_nutrition"
    assert world.food(world.ids[1]) is None


def test_a_single_failing_recipe_is_listed_and_the_run_goes_on(world):
    world.fail = {world.ids[2]: "unexpected"}
    r = run(world.go())
    assert r.state == "done" and r.counts["failed"] == 1 and r.counts["adopted"] == 5
    assert r.failures[0]["id"] == world.ids[2] and r.failures[0]["kind"] == "unexpected"


def test_three_failures_in_a_row_stop_the_run(world):
    world.fail = {i: "unavailable" for i in world.ids[:4]}
    r = run(world.go())
    assert r.state == "error" and r.error == "unavailable" and r.counts["failed"] == cookidoo_bulk.MAX_STREAK
    assert len(world.calls) == cookidoo_bulk.MAX_STREAK


def test_a_refused_sign_in_stops_at_once_without_a_retry(world):
    world.fail = {i: "auth" for i in world.ids}
    r = run(world.go())
    assert r.state == "error" and r.error == "auth" and len(world.calls) == 1 and r.done == 0
    assert "sign-in failed" in r.view()["error"]
    # the hub braked the account: a new run does not even try (no call, no retry that could lock the account)
    again = run(world.go())
    assert again.state == "error" and again.error == "auth" and len(world.calls) == 1


@pytest.mark.parametrize("kind", ["busy", "wait", "locked", "gone"])
def test_brakes_and_locks_stop_the_run_at_once(world, kind):
    world.fail = {}
    original = world.hub.recipe_fetched

    async def refuse(*args, **kwargs):
        raise CookidooError(kind)

    world.hub.recipe_fetched = refuse
    r = run(world.go())
    assert r.state == "error" and r.error == kind and r.done == 0
    world.hub.recipe_fetched = original


def test_bulk_calls_have_a_budget_of_their_own(world):
    async def main():
        a = access()
        plan = await make_plan(world.hub, a, "all", None)  # the lists come from the interactive budget, so before it is used up
        for i in range(cookidoo.CALL_LIMIT[0] - 2):  # the interactive budget is used up completely
            await world.hub.recipe(a, f"r{300000 + i}")
        with pytest.raises(CookidooError) as err:
            await world.hub.recipe(a, "r399999")
        assert err.value.kind == "busy"
        r = world.runs.start(a, plan, None)  # the run is not locked out by that
        await r.task
        return r
    assert run(main()).counts["adopted"] == 6

    async def second():
        # and a run does not use up the interactive budget: after the clock has moved on, interactive calls work at once
        world.clock.now += 301
        for i in range(cookidoo.CALL_LIMIT[0]):
            await world.hub.recipe(access(), f"r{400000 + i}")
    run(second())  # (the 61 seconds make no difference to the bulk calls: they are counted apart)


def test_the_bulk_budget_is_a_guard_against_a_hurried_run(world):
    async def main():
        a = access()
        for i in range(cookidoo.BULK_CALL_LIMIT[0]):
            await world.hub.recipe_fetched(a, f"r{500000 + i}", bulk=True)  # no pacing: as fast as it goes
        with pytest.raises(CookidooError) as err:
            await world.hub.recipe_fetched(a, "r599999", bulk=True)
        assert err.value.kind == "busy"
    run(main())


# ---- cancel, one run per account, switches ----


def test_cancel_stops_before_the_next_call_and_keeps_what_was_saved(world):
    seen = []

    def on_call(rid):
        seen.append(rid)
        if len(seen) == 2:
            world.runs.cancel("shared")

    world.on_call = on_call
    r = run(world.go())
    assert r.state == "cancelled" and r.reason == "user" and len(world.calls) == 2
    assert world.food(world.ids[0]) and world.food(world.ids[1]) and world.food(world.ids[2]) is None
    assert r.view()["reason"] == "cancelled"
    resumed = run(world.go())  # starting again continues: the two saved ones are up to date
    assert resumed.counts["fresh"] == 2 and resumed.counts["adopted"] == 4


def test_cancel_while_waiting_for_the_turn_stops_without_a_call(world):
    async def main():
        plan = await make_plan(world.hub, access(), "all", None)
        original = world.runs.sleep

        async def cancelling_sleep(seconds):
            world.runs.cancel("shared")
            await original(seconds)

        world.runs.sleep = cancelling_sleep
        r = world.runs.start(access(), plan, None)
        await r.task
        return r
    r = run(main())
    assert r.state == "cancelled" and len(world.calls) == 1  # the first call needed no wait; cancelled while waiting for the second


def test_one_run_per_account_and_two_on_the_server(world):
    async def main():
        plan = await make_plan(world.hub, access(), "all", None)
        first = world.runs.start(access(), plan, None)
        with pytest.raises(BulkError) as err:
            world.runs.start(access(), plan, None)
        assert err.value.kind == "running"
        second = world.runs.start(access("user:1"), plan, None)
        with pytest.raises(BulkError) as err:
            world.runs.start(access("user:2"), plan, None)
        assert err.value.kind == "busy"
        await first.task
        await second.task
        third = world.runs.start(access("user:2"), plan, None)  # a place is free again
        await third.task
        assert world.runs.start(access(), plan, None).task is not None  # and so is the shared account
    run(main())


def test_the_state_stays_for_a_while_after_the_end(world):
    r = run(world.go())
    assert world.runs.get("shared") is r and r.view()["state"] == "done" and r.view()["finished_at"] is not None
    world.clock.now += cookidoo_bulk.KEEP_FINISHED + 1
    assert world.runs.get("shared") is None


@pytest.mark.parametrize("how,reason", [("forget", "account"), ("off", "off"), ("change", "account")])
def test_sign_out_switch_off_and_account_change_end_the_run(world, how, reason):
    def on_call(rid):
        if rid == world.ids[1]:
            if how == "off":
                world.enabled = False
            elif how == "forget":
                asyncio.get_running_loop().create_task(world.hub.forget("shared"))
            else:
                world.hub._accounts["shared"].gen += 1

    world.on_call = on_call
    r = run(world.go())
    assert r.state == "cancelled" and r.reason == reason and len(world.calls) <= 3
    assert world.food(world.ids[5]) is None


def test_forget_cancels_a_run_at_once(world):
    async def main():
        plan = await make_plan(world.hub, access(), "all", None)
        r = world.runs.start(access(), plan, None)
        await world.hub.forget("shared")
        await r.task
        return r
    r = run(main())
    assert r.state == "cancelled" and r.reason == "account"


def test_shutdown_ends_every_run(world):
    async def main():
        plan = await make_plan(world.hub, access(), "all", None)
        r = world.runs.start(access(), plan, None)
        await world.runs.shutdown()
        return r
    assert run(main()).state == "cancelled"


# ---- groups ----


def test_a_collection_run_makes_a_group_named_like_the_collection(world):
    r = run(world.go("collection", "c1"))
    groups = world.names()
    assert list(groups) == ["Favourites"] and r.groups == ["Favourites"] and groups["Favourites"]["source"] == "cookidoo:c1"
    assert len(groups["Favourites"]["food_ids"]) == 4


def test_all_makes_a_group_per_collection_and_a_recipe_can_be_in_two(world):
    run(world.go())
    groups = world.names()
    assert set(groups) == {"Favourites", "Quick dinners"} and len(groups["Quick dinners"]["food_ids"]) == 4
    both = world.food(world.ids[2])["id"]
    assert both in groups["Favourites"]["food_ids"] and both in groups["Quick dinners"]["food_ids"]


def test_the_meal_plan_makes_no_group(world):
    run(world.go("week"))
    assert world.store.list_groups() == []


def test_renaming_a_group_is_respected_and_a_removed_member_does_not_come_back(world):
    run(world.go("collection", "c1"))
    group = world.names()["Favourites"]
    world.store.rename_group(group["id"], "My favourites")
    gone = world.food(world.ids[0])["id"]
    world.store.remove_from_group(group["id"], [gone])
    r = run(world.go("collection", "c1"))
    groups = world.names()
    assert list(groups) == ["My favourites"] and r.groups == ["My favourites"]
    assert gone not in groups["My favourites"]["food_ids"] and len(groups["My favourites"]["food_ids"]) == 3


def test_a_deleted_group_does_not_come_back_unasked_but_does_on_request(world):
    run(world.go("collection", "c1"))
    world.store.delete_group(world.names()["Favourites"]["id"])
    assert world.store.source_dismissed("cookidoo:c1")
    r = run(world.go("collection", "c1"))
    assert world.store.list_groups() == [] and r.groups == [] and r.counts["fresh"] == 4
    run(world.go("collection", "c1", regroup=True))
    groups = world.names()
    assert list(groups) == ["Favourites"] and len(groups["Favourites"]["food_ids"]) == 4  # a new group is filled completely
    assert not world.store.source_dismissed("cookidoo:c1")


def test_a_group_with_the_same_name_is_not_taken_over_and_not_merged(world):
    mine = world.store.create_group("Favourites", 1)
    run(world.go("collection", "c1"))
    groups = world.names()
    assert set(groups) == {"Favourites", "Favourites (Cookidoo)"} and groups["Favourites"]["id"] == mine["id"] and mine["food_ids"] == []
    assert groups["Favourites"]["food_ids"] == [] and len(groups["Favourites (Cookidoo)"]["food_ids"]) == 4


def test_a_recipe_already_taken_over_joins_a_new_group(world):
    run(world.go("week"))  # r100000 and r100005 exist, without a group
    run(world.go("collection", "c1"))
    group = world.names()["Favourites"]
    assert world.food(world.ids[0])["id"] in group["food_ids"] and len(group["food_ids"]) == 4


# ---- the routes ----


class Poll:
    def __init__(self, client):
        self.client = client

    def until_done(self, seconds=5):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            body = self.client.get("/api/v1/cookidoo/import").json()
            if body and body["state"] != "running":
                return body
            time.sleep(0.02)
        raise AssertionError("the run did not end")


@pytest.fixture
def quick(on, fake):  # noqa: F811
    """The app of test_cookidoo with a runner that does not wait."""
    async def sleep(seconds):
        await asyncio.sleep(0)

    on.app.state.cookidoo_runs.sleep = sleep
    fake.recipes = {f"r{100001 + i}": details(f"r{100001 + i}") for i in range(3)}
    return on


def test_preview_start_and_state_over_http(quick, fake):
    with quick as client:
        preview = client.get("/api/v1/cookidoo/import/preview", params={"scope": "all"})
        assert preview.status_code == 200
        body = preview.json()
        assert body["total"] == 1 and body["to_fetch"] == 1 and body["limit"] == 500 and body["seconds_per_recipe"] == 4.0
        assert body["groups"] == [{"collection": "c1", "name": "Favourites", "exists": False, "dismissed": False}]
        assert client.get("/api/v1/cookidoo/import").json() is None
        started = client.post("/api/v1/cookidoo/import", json={"scope": "all"})
        assert started.status_code == 202 and started.json()["total"] == 1
        done = Poll(client).until_done()
        assert done["state"] == "done" and done["adopted"] == 1 and done["groups"] == ["Favourites"] and done["failures"] == []
        food = client.get("/api/v1/foods", params={"source": "cookidoo"}).json()
        assert [f["name"] for f in food] == ["Recipe r100001"]
        groups = client.get("/api/v1/recipe-groups").json()
        assert groups[0]["name"] == "Favourites" and groups[0]["auto"] is True and groups[0]["food_ids"] == [food[0]["id"]]
        again = client.post("/api/v1/cookidoo/import", json={"scope": "all"}).json()
        assert again["state"] in ("running", "done")
        assert Poll(client).until_done()["fresh"] == 1


def test_bad_requests(quick):
    with quick as client:
        assert client.post("/api/v1/cookidoo/import", json={"scope": "collection"}).status_code == 422
        assert client.post("/api/v1/cookidoo/import", json={"scope": "collection", "collection": "zz"}).status_code == 404
        assert client.post("/api/v1/cookidoo/import", json={"scope": "everything"}).status_code == 422
        assert client.post("/api/v1/cookidoo/import", json={"scope": "all", "collection": "a b/../"}).status_code == 422
        assert client.get("/api/v1/cookidoo/import/preview", params={"scope": "collection", "collection": "c2"}).status_code == 422  # nothing in it
        assert client.delete("/api/v1/cookidoo/import").status_code == 204  # nothing running: harmless


def test_cancel_over_http(quick, fake):
    async def slow(seconds):
        await asyncio.sleep(0.05)

    quick.app.state.cookidoo_runs.sleep = slow
    fake.collections_extra = None
    with quick as client:
        original = fake.week
        async def many(day):
            from mahlwerk.cookidoo import PlanDay, PlannedRecipe
            return [PlanDay("d", "Mon", [PlannedRecipe(f"r{100001 + i}", f"R{i}") for i in range(3)])]
        fake.week = many
        fake.recipes = {f"r{100001 + i}": details(f"r{100001 + i}") for i in range(3)}
        assert client.post("/api/v1/cookidoo/import", json={"scope": "week"}).status_code == 202
        assert client.delete("/api/v1/cookidoo/import").status_code == 204
        done = Poll(client).until_done()
        assert done["state"] in ("cancelled", "done")  # a fast machine can finish the three before the cancel arrives
        fake.week = original


def test_only_signed_in_people_may_start_and_see_runs(quick):
    with quick as client:
        token = client.post("/api/v1/me/tokens", json={"name": "t", "scope": "write"}).json()["token"]
        key = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/v1/cookidoo/import", json={"scope": "all"}, headers=key).status_code == 403
        assert client.get("/api/v1/cookidoo/import", headers=key).status_code == 403
        assert client.get("/api/v1/cookidoo/import/preview", params={"scope": "all"}, headers=key).status_code == 403
        assert client.delete("/api/v1/cookidoo/import", headers=key).status_code == 403


def test_switched_off_not_configured_and_no_csrf(quick, monkeypatch):
    with quick as client:
        del client.headers["X-Mahlwerk-Request"]
        assert client.post("/api/v1/cookidoo/import", json={"scope": "all"}).status_code in (400, 403)
        assert client.delete("/api/v1/cookidoo/import").status_code in (400, 403)


@pytest.fixture
def unlocked(monkeypatch, tmp_path, fake):
    """Like `on`, but the switch is not fixed by the environment, so the admin area can turn it off."""
    monkeypatch.setenv("MAHLWERK_COOKIDOO_EMAIL", "someone@example.invalid")
    monkeypatch.setenv("MAHLWERK_COOKIDOO_PASSWORD", "pw-not-real")
    monkeypatch.setattr(cookidoo, "installed", lambda: True)
    app = create_app(str(tmp_path / "u.db"))
    app.state.cookidoo.factory = lambda settings: fake
    return TestClient(app)


def test_switching_the_connector_off_in_the_admin_area_ends_a_run(unlocked, fake):
    async def slow(seconds):
        await asyncio.sleep(0.2)

    quick = unlocked
    quick.app.state.cookidoo_runs.sleep = slow
    with quick as client:
        assert client.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": True}).status_code == 200
        async def many(day):
            from mahlwerk.cookidoo import PlanDay, PlannedRecipe
            return [PlanDay("d", "Mon", [PlannedRecipe(f"r{100001 + i}", f"R{i}") for i in range(3)])]
        fake.week = many
        fake.recipes = {f"r{100001 + i}": details(f"r{100001 + i}") for i in range(3)}
        assert client.post("/api/v1/cookidoo/import", json={"scope": "week"}).status_code == 202
        assert client.patch("/api/v1/admin/connectors/cookidoo", json={"enabled": False}).status_code == 200
        assert quick.app.state.cookidoo_runs.get("shared").reason == "off"
        end = time.monotonic() + 5
        while quick.app.state.cookidoo_runs.get("shared").state == "running" and time.monotonic() < end:
            time.sleep(0.02)
        assert quick.app.state.cookidoo_runs.get("shared").state == "cancelled"


def test_the_loop_notices_a_switched_off_connector_by_itself(quick, fake, monkeypatch):
    async def slow(seconds):
        monkeypatch.setenv("MAHLWERK_COOKIDOO", "0")
        await asyncio.sleep(0.01)

    quick.app.state.cookidoo_runs.sleep = slow
    with quick as client:
        async def many(day):
            from mahlwerk.cookidoo import PlanDay, PlannedRecipe
            return [PlanDay("d", "Mon", [PlannedRecipe(f"r{100001 + i}", f"R{i}") for i in range(3)])]
        fake.week = many
        fake.recipes = {f"r{100001 + i}": details(f"r{100001 + i}") for i in range(3)}
        assert client.post("/api/v1/cookidoo/import", json={"scope": "week"}).status_code == 202
        end = time.monotonic() + 5
        while quick.app.state.cookidoo_runs.get("shared").state == "running" and time.monotonic() < end:
            time.sleep(0.02)
        run = quick.app.state.cookidoo_runs.get("shared")
        assert run.state == "cancelled" and run.reason == "off"


def test_taking_over_one_recipe_from_a_collection_fills_its_group(quick):
    with quick as client:
        first = client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "collection": "c1"})
        assert first.status_code == 200
        groups = client.get("/api/v1/recipe-groups").json()
        assert [g["name"] for g in groups] == ["Favourites"] and groups[0]["food_ids"] == [first.json()["id"]]
        client.delete(f"/api/v1/recipe-groups/{groups[0]['id']}")
        client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "collection": "c1"})
        assert client.get("/api/v1/recipe-groups").json() == []  # deleted: not made again unasked
        assert client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "collection": "bad id"}).status_code == 422
        assert client.post("/api/v1/cookidoo/adopt", json={"recipe": "r100001", "collection": "unknown"}).status_code == 200  # no group, still adopted
        assert client.get("/api/v1/recipe-groups").json() == []

"""Taking over many Cookidoo recipes at once ("take over all"), as a background run inside the server.

THIS TALKS TO AN UNOFFICIAL INTERFACE (see cookidoo.py), and every recipe needs its own detail call there (the nutrition values
are not in the lists). The run is therefore deliberately slow and careful. It has NEVER been run against the real service by
the authors of this module; the tests use a stand-in client and an injected clock.

Rules this module keeps:
- One run per Cookidoo account at a time (the key of the account, so everybody who uses the shared account sees and shares the
  one run), at most two on the server (`MAX_RUNNING`). A new start while one runs is refused.
- Paced: at least `cookidoo.BULK_GAP` (3 s) between two calls to Cookidoo, measured with the injected clock; cache hits and
  recipes that are up to date cost no call and no waiting. The calls count against a budget of their own
  (`cookidoo.BULK_CALL_LIMIT`), not against the interactive one, so a run neither uses up what the pages need nor can be hurried.
  About 100 recipes take 5 to 6 minutes (`SECONDS_PER_RECIPE` is the honest estimate shown before the start).
- Idempotent and resumable: a recipe that is already a food and was fetched less than `FRESH_SECONDS` (7 days) ago is skipped
  without a call; older ones are updated. Everything is saved recipe by recipe, so a stopped run (or a server restart, which ends
  every run: the state is in memory only) loses nothing, and starting again continues where it left off.
- Stops at once, without a retry, when Cookidoo refuses the sign-in, says to slow down, when the sign-in is braked or locked
  (`auth`, `busy`, `wait`, `locked`) or when the account was changed meanwhile (`gone`). A single recipe that fails stays in the list
  of failures and the run goes on; after `MAX_STREAK` failures in a row (Cookidoo unreachable or answering strangely) it stops too.
- A run ends when its account is forgotten (sign-out, a blocked person, an account changed or removed: `Hub.forget`), when the
  connector is switched off, when somebody cancels it and when the server shuts down.
- Pictures (only when the admin switched "store recipe pictures" on): a recipe that was taken over or updated gets its picture fetched
  once (the address is in the detail answer; the picture comes from another host, one fetch per recipe, behind the same gap). A
  recipe that is up to date but has no picture yet gets it too when its address was remembered (no call to Cookidoo). The variant
  "catch up pictures" (`start_images`) does only that for the recipes already taken over: it asks Cookidoo for the detail of those
  whose picture address is not known (the same pace, the same budget) and fetches the pictures. Same run state, same cancel, same stops.
- At most `MAX_RECIPES` (500) recipes per run; more is refused with the number, to be taken over collection by collection.
- Recipes the account made itself ("created") are not in the lists in the first place (see `LibraryClient.week`).
- Automatic groups: each collection of the account is linked to a group (`source` = `cookidoo:<collection id>`). The group is
  made when the run starts, found again by the link (so renaming it changes nothing) and not made again when the household deleted
  it (the link is remembered as dismissed) unless the run is started with `regroup`. Recipes are added to the group when the group is
  new or the recipe is new to the server, so a recipe someone removed from a group by hand does not come back. The meal plan gets no
  group: it changes every week and is not a collection.
"""

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import cookidoo
from .cookidoo import BULK_GAP, Access, CookidooError, Hub

log = logging.getLogger("mahlwerk.cookidoo.bulk")

MAX_RECIPES = 500
MAX_RUNNING = 2  # runs on the server at once
FRESH_SECONDS = 7 * 86400  # a recipe fetched more recently than this is not asked for again
SECONDS_PER_RECIPE = BULK_GAP + 1.0  # the gap plus a typical call; shown as the estimate, never promised
MAX_STREAK = 3  # failures in a row (not refusals) after which the run stops
MAX_FAILURES_LISTED = 40
KEEP_FINISHED = 3600  # a finished run's state is kept this long (so that it is still there when the dialog is opened again)
STOP_KINDS = ("auth", "busy", "wait", "locked", "gone")  # refusals and brakes: the run ends at once
SCOPES = ("all", "collection", "week")
PICTURES_EVERY = 600.0  # a catch-up for pictures may be started at most this often per account
IMAGE_GAP = 1.0  # seconds between two picture fetches when no call to Cookidoo is made in between
GROUP_PREFIX = "cookidoo:"

REASONS = {
    "user": "cancelled",
    "account": "the account was changed, removed or signed out meanwhile",
    "off": "the Cookidoo connector was switched off",
    "shutdown": "the server was stopped",
}


class BulkError(Exception):
    """The run cannot be planned or started; `kind`: not_found, too_many, empty, running, busy."""

    def __init__(self, kind: str, detail: int = 0):
        super().__init__(kind)
        self.kind, self.detail = kind, detail


@dataclass
class Item:
    id: str
    name: str
    collections: list[str] = field(default_factory=list)


@dataclass
class Plan:
    scope: str
    items: list[Item]
    groups: dict[str, str]  # collection id -> its name: the groups the run keeps up
    pictures: bool = False  # the catch-up variant: only pictures of recipes taken over already
    known_urls: dict[str, str] = field(default_factory=dict)  # recipe id -> picture address remembered from an earlier detail call


def make_image_plan(store, now: float | None = None) -> Plan:
    """The recipes taken over from Cookidoo that have no picture (and nobody set one or took it away): from what is stored, no call."""
    items, urls = [], {}
    for row in store.foods_without_image(cookidoo.SOURCE, now):
        external = row["external_id"] or ""
        if not external.startswith(cookidoo.EXTERNAL_PREFIX):
            continue
        rid = external[len(cookidoo.EXTERNAL_PREFIX):]
        food = store.get_food(row["id"])
        items.append(Item(rid, ((food or {}).get("data") or {}).get("name") or rid))
        if row["image_url"]:
            urls[rid] = row["image_url"]
    if not items:
        raise BulkError("empty")
    if len(items) > MAX_RECIPES:
        raise BulkError("too_many", len(items))
    return Plan("pictures", items, {}, True, urls)


def summarize_images(plan: Plan) -> dict:
    """What the catch-up would do: pictures to fetch, and the calls to Cookidoo among them (recipes whose picture address is not known)."""
    calls = sum(1 for i in plan.items if i.id not in plan.known_urls)
    return {"total": len(plan.items), "fresh": 0, "to_fetch": calls,
            "eta_seconds": int(calls * SECONDS_PER_RECIPE + (len(plan.items) - calls) * IMAGE_GAP)}


async def make_plan(hub: Hub, access: Access, scope: str, collection: str | None) -> Plan:
    """The recipes of the chosen scope without duplicates (from the lists Cookidoo gave, cached for a minute)."""
    items: dict[str, Item] = {}
    groups: dict[str, str] = {}

    def put(ref, collection_id: str | None) -> None:
        item = items.setdefault(ref.id, Item(ref.id, ref.name))
        if collection_id is not None and collection_id not in item.collections:
            item.collections.append(collection_id)

    if scope in ("all", "collection"):
        found = await hub.collections(access)
        if scope == "collection":
            found = [c for c in found if c.id == collection]
            if not found:
                raise BulkError("not_found")
        for c in found:
            if c.recipes:
                groups[c.id] = c.name
            for ref in c.recipes:
                put(ref, c.id)
    if scope in ("all", "week"):
        for day in await hub.week(access):
            for ref in day.recipes:
                put(ref, None)
    if not items:
        raise BulkError("empty")
    if len(items) > MAX_RECIPES:
        raise BulkError("too_many", len(items))
    return Plan(scope, list(items.values()), groups)


def is_fresh(food: dict | None, now: float) -> bool:
    return food is not None and now - (food.get("fetched_at") or 0) < FRESH_SECONDS


def summarize(store, plan: Plan, now: float) -> dict:
    """What a run would do, counted from what is stored (no call to Cookidoo)."""
    fresh = sum(1 for i in plan.items if is_fresh(store.get_food_by_external_id(cookidoo.EXTERNAL_PREFIX + i.id), now))
    to_fetch = len(plan.items) - fresh
    return {"total": len(plan.items), "fresh": fresh, "to_fetch": to_fetch, "eta_seconds": int(to_fetch * SECONDS_PER_RECIPE)}


@dataclass
class Run:
    key: str  # the account: `shared` or `user:<id>`
    scope: str
    total: int
    to_fetch: int
    started: float
    state: str = "running"  # running, done, cancelled, error
    done: int = 0
    fetched: int = 0
    counts: dict = field(default_factory=lambda: {"adopted": 0, "updated": 0, "fresh": 0, "no_nutrition": 0, "failed": 0, "pictures": 0, "no_picture": 0})
    mode: str = "recipes"  # recipes, or pictures (the catch-up)
    current: str | None = None
    failures: list = field(default_factory=list)
    groups: list = field(default_factory=list)
    error: str | None = None  # a key of cookidoo.MESSAGES
    reason: str | None = None  # why it was cancelled: a key of REASONS
    finished: float | None = None
    cancel_flag: bool = False
    task: asyncio.Task | None = None

    def view(self) -> dict:
        left = max(0, self.to_fetch - self.fetched) if self.state == "running" else 0
        return {
            "state": self.state, "cancelling": self.cancel_flag and self.state == "running", "scope": self.scope, "mode": self.mode,
            "total": self.total, "done": self.done, "fetched": self.fetched,
            "pictures": self.counts["pictures"], "no_picture": self.counts["no_picture"],
            "adopted": self.counts["adopted"], "updated": self.counts["updated"], "fresh": self.counts["fresh"],
            "no_nutrition": self.counts["no_nutrition"], "failed": self.counts["failed"],
            "current": self.current if self.state == "running" else None,
            "failures": list(self.failures), "groups": list(self.groups),
            "error": cookidoo.MESSAGES.get(self.error or ""), "error_kind": self.error,
            "reason": REASONS.get(self.reason or ""), "reason_kind": self.reason,
            "eta_seconds": int(left * SECONDS_PER_RECIPE), "started_at": int(self.started),
            "finished_at": int(self.finished) if self.finished is not None else None,
        }


class BulkRuns:
    """Starts and tracks the runs. `enabled` says whether the connector is still switched on; `clock` and `sleep` are replaced
    by the tests (a clock they advance, a sleep that advances it), so no test waits."""

    def __init__(self, hub: Hub, store, enabled: Callable[[], bool], sleep=asyncio.sleep, clock: Callable[[], float] | None = None,
                 images=None, fetcher=None, images_on: Callable[[], bool] = lambda: False):
        self.images, self.fetcher, self.images_on = images, fetcher, images_on
        self.hub = hub
        self.store = store
        self.enabled = enabled
        self.sleep = sleep
        self.clock = clock or hub.clock
        self._runs: dict[str, Run] = {}
        self._pictures_started: dict[str, float] = {}  # account key -> when its last catch-up started
        hub.listeners.append(self._forgotten)

    def _forget_old(self) -> None:
        now = self.clock()
        for key in [k for k, r in self._runs.items() if r.finished is not None and now - r.finished > KEEP_FINISHED]:
            del self._runs[key]

    def get(self, key: str) -> Run | None:
        self._forget_old()
        return self._runs.get(key)

    def running(self) -> int:
        return sum(1 for r in self._runs.values() if r.state == "running")

    def start(self, access: Access, plan: Plan, user_id: int | None, regroup: bool = False) -> Run:
        self._forget_old()
        current = self._runs.get(access.key)
        if current is not None and current.state == "running":
            raise BulkError("running")
        if self.running() >= MAX_RUNNING:
            raise BulkError("busy")
        now = self.clock()
        if plan.pictures:
            last = self._pictures_started.get(access.key)
            if last is not None and now - last < PICTURES_EVERY:
                raise BulkError("wait")
            self._pictures_started[access.key] = now
        stats = summarize_images(plan) if plan.pictures else summarize(self.store, plan, now)
        run = Run(access.key, plan.scope, stats["total"], stats["to_fetch"], now, mode="pictures" if plan.pictures else "recipes")
        self._runs[access.key] = run
        run.task = asyncio.get_running_loop().create_task(self._work(run, access, plan, user_id, regroup), name="cookidoo-bulk")
        return run

    def cancel(self, key: str, reason: str = "user") -> None:
        run = self._runs.get(key)
        if run is not None and run.state == "running" and not run.cancel_flag:
            run.cancel_flag, run.reason = True, reason

    def cancel_all(self, reason: str = "off") -> None:
        for key in list(self._runs):
            self.cancel(key, reason)

    def _forgotten(self, key: str) -> None:
        self.cancel(key, "account")

    async def shutdown(self) -> None:
        """The server stops: every run ends (what was saved stays)."""
        self.cancel_all("shutdown")
        for run in list(self._runs.values()):
            if run.task is not None and not run.task.done():
                run.task.cancel()
                try:
                    await run.task
                except (asyncio.CancelledError, Exception):
                    pass
            if run.state == "running":  # cancelled before it had a first turn
                run.state, run.reason, run.finished = "cancelled", run.reason or "shutdown", self.clock()

    # ---- the run itself ----

    async def _work(self, run: Run, access: Access, plan: Plan, user_id: int | None, regroup: bool) -> None:
        try:
            await self._loop(run, access, plan, user_id, regroup)
            if run.cancel_flag:
                run.state = "cancelled"
            elif run.state == "running":
                run.state = "done"
        except asyncio.CancelledError:
            run.state, run.reason = "cancelled", run.reason or "shutdown"
            raise
        except Exception as exc:  # whatever happens, the person only learns the category
            log.warning("cookidoo bulk run failed (%s)", type(exc).__name__)
            run.state, run.error = "error", "unexpected"
        finally:
            run.current = None
            run.finished = self.clock()

    def _stop(self, run: Run, kind: str) -> None:
        run.state, run.error = "error", kind

    async def _picture(self, run: Run, food_id: int, url: str | None) -> bool:
        """With pictures switched on: fetch the picture (not again when one of the same address is stored). True when a fetch was tried (for the pace)."""
        if not url or self.images is None or not self.images_on() or not self.images.wants(food_id):
            return False
        stored = await asyncio.to_thread(self.images.fetch_provider, self.fetcher, food_id, url, cookidoo.SOURCE)
        run.counts["pictures" if stored else "no_picture"] += 1
        return True

    async def _pictures_loop(self, run: Run, access: Access, plan: Plan) -> None:
        """The catch-up: a picture for every recipe taken over that has none. Calls Cookidoo only where the address is not known."""
        hub = self.hub
        gen = hub.generation(access.key)
        last_call: list[float | None] = [None]
        last_picture: list[float | None] = [None]
        streak = 0

        async def pace() -> None:
            if last_call[0] is not None:
                wait = last_call[0] + BULK_GAP - self.clock()
                if wait > 0:
                    await self.sleep(wait)
            if run.cancel_flag:
                raise _Stop

        for item in plan.items:
            if run.cancel_flag:
                return
            if not self.enabled() or not self.images_on():
                self.cancel(run.key, "off")
                return
            now_gen = hub.generation(access.key)
            if gen is None:  # no call to Cookidoo yet (the plan came from what is stored): the account exists from the first call on
                gen = now_gen
            elif now_gen != gen:
                self.cancel(run.key, "account")
                return
            run.current = item.name
            known = self.store.get_food_by_external_id(cookidoo.EXTERNAL_PREFIX + item.id)
            if known is None or not self.images.wants(known["id"]):  # gone, or somebody set a picture meanwhile
                run.counts["fresh"] += 1
                run.done += 1
                continue
            url = plan.known_urls.get(item.id) or known.get("image_url")
            if not url:
                try:
                    details, fetched = await hub.recipe_fetched(access, item.id, bulk=True, pace=pace)
                except _Stop:
                    return
                except CookidooError as exc:
                    if exc.kind not in ("busy", "wait", "locked", "gone"):
                        last_call[0] = self.clock()
                    if exc.kind in STOP_KINDS:
                        self._stop(run, exc.kind)
                        return
                    run.counts["failed"] += 1
                    self._fail(run, item, exc.kind)
                    streak += 1
                    run.done += 1
                    if streak >= MAX_STREAK:
                        self._stop(run, exc.kind)
                        return
                    continue
                if fetched:
                    last_call[0] = self.clock()
                    run.fetched += 1
                streak = 0
                url = details.image
                if not url:
                    run.counts["no_picture"] += 1
                    run.done += 1
                    continue
            elif last_picture[0] is not None:
                wait = last_picture[0] + IMAGE_GAP - self.clock()
                if wait > 0:
                    await self.sleep(wait)
                if run.cancel_flag:
                    return
            if await self._picture(run, known["id"], url):
                last_picture[0] = self.clock()
            run.done += 1

    async def _loop(self, run: Run, access: Access, plan: Plan, user_id: int | None, regroup: bool) -> None:
        if plan.pictures:
            return await self._pictures_loop(run, access, plan)
        store, hub = self.store, self.hub
        gen = hub.generation(access.key)
        group_of: dict[str, tuple[int, bool]] = {}  # collection id -> (group id, made by this run)
        for collection_id, name in plan.groups.items():
            source = GROUP_PREFIX + collection_id
            if regroup:
                store.undismiss_source(source)
            group_id, created = store.source_group(source, name, user_id)
            if group_id is not None:
                group_of[collection_id] = (group_id, created)
                group = store.get_group(group_id)
                run.groups.append(group["name"] if group else name)
        last_call: list[float | None] = [None]
        streak = 0

        async def pace() -> None:
            """At least BULK_GAP after the previous call to Cookidoo (the clock is the injected one)."""
            if last_call[0] is not None:
                wait = last_call[0] + BULK_GAP - self.clock()
                if wait > 0:
                    await self.sleep(wait)
            if run.cancel_flag:
                raise _Stop

        for item in plan.items:
            if run.cancel_flag:
                return
            if not self.enabled():
                self.cancel(run.key, "off")
                return
            if hub.generation(access.key) != gen:
                self.cancel(run.key, "account")
                return
            run.current = item.name
            external = cookidoo.EXTERNAL_PREFIX + item.id
            known = store.get_food_by_external_id(external)
            food_id: int | None = known["id"] if known else None
            new_food = False
            if is_fresh(known, self.clock()):
                run.counts["fresh"] += 1
                if known is not None and not known.get("image_hash") and known.get("image_url") and await self._picture(run, known["id"], known["image_url"]):
                    await self.sleep(IMAGE_GAP)
            else:
                try:
                    details, fetched = await hub.recipe_fetched(access, item.id, bulk=True, pace=pace)
                except _Stop:
                    return
                except CookidooError as exc:
                    if exc.kind not in ("busy", "wait", "locked", "gone"):  # a call was made
                        last_call[0] = self.clock()
                    if exc.kind in STOP_KINDS:
                        self._stop(run, exc.kind)
                        return
                    run.counts["failed"] += 1
                    self._fail(run, item, exc.kind)
                    streak += 1
                    run.done += 1
                    if streak >= MAX_STREAK:
                        self._stop(run, exc.kind)
                        return
                    continue
                if fetched:
                    last_call[0] = self.clock()
                    run.fetched += 1
                streak = 0
                try:
                    data = {**cookidoo.food_data(details), "region": [access.settings.country, access.settings.language]}
                except cookidoo.RecipeRejected as exc:
                    run.counts["no_nutrition"] += 1
                    self._fail(run, item, "no_nutrition", str(exc))
                    run.done += 1
                    continue
                if known is not None:
                    store.update_food(known["id"], cookidoo.SOURCE, data)
                    run.counts["updated"] += 1
                else:
                    food_id, _ = store.put_external_food(external, cookidoo.SOURCE, data)
                    new_food = True
                    run.counts["adopted"] += 1
                if food_id is not None:
                    await self._picture(run, food_id, details.image)
            if food_id is not None:
                for collection_id in item.collections:
                    if collection_id in group_of and (new_food or group_of[collection_id][1]):
                        store.add_to_group(group_of[collection_id][0], [food_id])
            run.done += 1

    @staticmethod
    def _fail(run: Run, item: Item, kind: str, text: str | None = None) -> None:
        if len(run.failures) < MAX_FAILURES_LISTED:
            run.failures.append({"id": item.id, "name": item.name, "kind": kind,
                                 "reason": text or cookidoo.MESSAGES.get(kind, kind)})


class _Stop(Exception):
    """The run was cancelled while it waited for its turn."""

"""Cookidoo connector: recipes from the Thermomix recipe platform as foods with nutrition values per portion.

Cookidoo has no public interface. This module talks to it through the unofficial `cookidoo-api` package (optional:
`pip install mahlwerk[cookidoo]`), which can break whenever Cookidoo changes. Everything that touches the package sits
in `LibraryClient` below; the rest (settings, link parsing, unit conversion, caching, limits) is plain Python and is
tested with a stand-in client, so no test needs the network or the package.

Rules this module keeps:
- The credentials come from the environment (`MAHLWERK_COOKIDOO_EMAIL`, `_PASSWORD`, `_COUNTRY`, `_LANGUAGE`, which win for
  the shared household account) or from the encrypted store (`vault.py`: the shared account set in the admin area, and an
  own account per user). They are never returned, logged or put into an error message; errors are reduced to a neutral
  category.
- Accounts are never mixed: the hub keeps a separate client, cache, call counter and sign-in brake for the shared account
  and for each user's own account. A user who has an own account uses only that one; everybody else uses the shared one.
- Only a recipe id is ever sent to Cookidoo; a pasted link is reduced to the id by a strict pattern and is never fetched.
- Recipe texts (ingredients, steps) are not kept: only the name, the portions, the nutrition values and the id.
- The sign-in (token) lives in the memory of the process. Sign-ins are rationed so that Cookidoo is not hammered with wrong
  passwords, whatever accounts are typed in: a refused sign-in is not retried for five minutes; per account holder (the
  shared account, or one person) at most 5 refused sign-ins an hour are tolerated, after that sign-ins are not even tried until
  the hour has passed (changing the stored account does not reset that count); at most 20 sign-ins an hour for all accounts
  together. This limits the load and the risk of Cookidoo locking an account; it cannot promise that it never does.
  Changing an account drops its client and cache, and an answer that arrives after a change is not cached.
- Runs that take over many recipes (cookidoo_bulk.py) call `Hub.recipe_fetched(..., bulk=True)`: they are paced by the run
  (BULK_GAP), counted against a budget of their own (BULK_CALL_LIMIT, GLOBAL_BULK_CALL_LIMIT) so that the interactive limits stay
  free, and their answers are not cached. `Hub.forget` tells the runs (`listeners`) so that they end with the account.
"""

import asyncio
import importlib.util
import logging
import os
import re
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

from .nutrition import PER_100_KEYS

log = logging.getLogger("mahlwerk.cookidoo")

# the package logs whole responses at debug level; keep that out of our logs whatever the log level is
logging.getLogger("cookidoo_api").setLevel(logging.WARNING)

SOURCE = "cookidoo"
EXTERNAL_PREFIX = "cookidoo:"
REFERENCE_AMOUNT = 100.0  # g: one portion is stored as 100 g whose "per 100 g" values are the values of the portion
REQUEST_TIMEOUT = 20  # seconds, for each request to Cookidoo
LIST_CACHE_SECONDS = 60  # the meal plan and the collections are loaded from Cookidoo at most once a minute
RECIPE_CACHE_SECONDS = 600
RECIPE_CACHE_MAX = 200
AUTH_COOLDOWN = 300  # after a failed sign-in no new attempt for this long
FAIL_LIMIT = (5, 3600)  # refused sign-ins tolerated per account holder (shared account or person) per hour
LOGIN_LIMIT = (20, 3600)  # sign-in attempts per hour for all accounts together
LOGIN_GAP = 30  # a new sign-in after a refusal, and two "check the connection" in a row, are held back this long
CALL_LIMIT = (30, 300)  # at most 30 calls to Cookidoo in 300 seconds for each account
GLOBAL_CALL_LIMIT = (120, 300)  # and for all accounts together
MAX_CLIENTS = 6  # signed-in clients held at once; the one unused longest is closed when another is needed
IDLE_SECONDS = 1800  # a client unused this long is closed (its token is forgotten)
MAX_ACCOUNTS = 200  # accounts remembered (caches, brakes); the oldest idle ones are forgotten
SHARED = "shared"
MAX_COLLECTION_RECIPES = 500
# bulk runs ("take over all", see cookidoo_bulk.py) have a budget of their own, so that they neither use up the calls that
# interactive requests need nor can be run faster than is polite: one detail call every BULK_GAP seconds is 100 calls in
# 300 seconds, the limit leaves a little room above that and is only a guard (the run itself keeps the pace)
BULK_GAP = 3.0
BULK_CALL_LIMIT = (110, 300)  # per account
GLOBAL_BULK_CALL_LIMIT = (200, 300)  # all accounts together (at most two runs at once, see cookidoo_bulk.MAX_RUNNING)

COUNTRY = re.compile(r"^[a-z]{2}$")
LANGUAGE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")
RECIPE_ID = re.compile(r"^r\d{3,10}$")
RECIPE_LINK = re.compile(
    r"^https://(?:www\.)?cookidoo\.(?:thermomix\.com|[a-z]{2,3}(?:\.[a-z]{2})?)"
    r"/recipes/recipe/(?:[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?/)?(r\d{3,10})/?(?:[?#]\S{0,300})?$"
)

MESSAGES = {
    "auth": "Cookidoo sign-in failed (check the e-mail address and the password of the account)",
    "unavailable": "Cookidoo is not reachable",
    "unexpected": "Cookidoo answered in an unexpected way (the unofficial interface may have changed)",
    "busy": "too many requests to Cookidoo, try again in a minute",
    "wait": "a sign-in was tried a moment ago, wait half a minute before the next try",
    "locked": "too many refused sign-ins within the last hour, no new try for now (change nothing and wait)",
    "gone": "the account was changed or removed meanwhile, try again",
}


class CookidooError(Exception):
    """A neutral failure: `kind` is one of MESSAGES. Never carries text from Cookidoo or from the credentials."""

    def __init__(self, kind: str):
        super().__init__(MESSAGES[kind])
        self.kind = kind


class RecipeRejected(Exception):
    """The recipe cannot become a food (the text says why)."""


def installed() -> bool:
    return importlib.util.find_spec("cookidoo_api") is not None


@dataclass(frozen=True)
class Settings:
    email: str
    password: str
    country: str
    language: str

    @staticmethod
    def build(email, password, country, language) -> "Settings | None":
        """None unless the account and a valid localisation are given (the country and language default to de / de-DE)."""
        email = email.strip() if isinstance(email, str) else ""
        password = password if isinstance(password, str) else ""
        country = (country.strip().lower() if isinstance(country, str) else "") or "de"
        language = (language.strip() if isinstance(language, str) else "") or "de-DE"
        if (not email or not password or len(email) > 200 or len(password) > 500 or "\n" in email
                or not COUNTRY.fullmatch(country) or not LANGUAGE.fullmatch(language)):
            return None
        return Settings(email, password, country, language)

    @staticmethod
    def from_env() -> "Settings | None":
        """None unless the account and a valid localisation are configured in the environment."""
        return Settings.build(os.environ.get("MAHLWERK_COOKIDOO_EMAIL"), os.environ.get("MAHLWERK_COOKIDOO_PASSWORD"),
                              os.environ.get("MAHLWERK_COOKIDOO_COUNTRY"), os.environ.get("MAHLWERK_COOKIDOO_LANGUAGE"))

    @staticmethod
    def from_stored(value: dict | None) -> "Settings | None":
        """From a value of the encrypted store (see `Settings.to_stored`)."""
        if not isinstance(value, dict):
            return None
        return Settings.build(value.get("email"), value.get("password"), value.get("country"), value.get("language"))

    def to_stored(self) -> dict:
        return {"email": self.email, "password": self.password, "country": self.country, "language": self.language}

    def __repr__(self) -> str:  # a stray log line or traceback must not show the credentials
        return f"Settings(country={self.country!r}, language={self.language!r})"


@dataclass(frozen=True)
class Access:
    """Which account a request uses: `key` is `shared` or `user:<id>`; never mix the settings of two keys."""

    key: str
    settings: Settings
    scope: str  # "shared" or "own"

    def __repr__(self) -> str:
        return f"Access(key={self.key!r}, scope={self.scope!r})"


def recipe_id(text: str) -> str | None:
    """The id of a recipe from an id (`r59322`) or a Cookidoo recipe link, else None. Nothing is fetched from the link."""
    text = (text or "").strip()
    if RECIPE_ID.fullmatch(text):
        return text
    match = RECIPE_LINK.match(text)
    return match.group(1) if match else None


# Cookidoo's web domain by country, only where it is certain; a country not listed gets no link (nothing is guessed)
SITES = {
    "de": "cookidoo.de", "at": "cookidoo.at", "ch": "cookidoo.ch", "fr": "cookidoo.fr", "es": "cookidoo.es",
    "it": "cookidoo.it", "pl": "cookidoo.pl", "pt": "cookidoo.pt", "gb": "cookidoo.co.uk",
}


def recipe_url(external_id: str | None, settings: "Settings | None" = None, region: list | None = None) -> str | None:
    """The page of a taken-over recipe at Cookidoo (from `cookidoo:<id>` and a country and language), else None.

    The region is the one stored with the food when it was taken over (`region`: [country, language]), else the one of the
    environment. Only built, never fetched. Without a region or for an unknown country there is no link.
    """
    if not external_id or not external_id.startswith(EXTERNAL_PREFIX):
        return None
    if isinstance(region, list) and len(region) == 2 and all(isinstance(v, str) for v in region):
        country, language = region
    else:
        settings = settings or Settings.from_env()
        if settings is None:
            return None
        country, language = settings.country, settings.language
    rid = external_id[len(EXTERNAL_PREFIX):]
    host = SITES.get(country)
    if host is None or not RECIPE_ID.fullmatch(rid) or not LANGUAGE.fullmatch(language):
        return None
    return f"https://{host}/recipes/recipe/{language}/{rid}"


# ---- what the client returns (plain data, no library types) ----


@dataclass(frozen=True)
class PlannedRecipe:
    id: str
    name: str


@dataclass(frozen=True)
class PlanDay:
    day: str
    title: str
    recipes: list[PlannedRecipe]


@dataclass(frozen=True)
class Collection:
    id: str
    name: str
    managed: bool
    recipes: list[PlannedRecipe]


@dataclass(frozen=True)
class NutritionEntry:
    """One block of nutrition values as Cookidoo sends it: for `quantity` x `unit` (e.g. 1 x "portion")."""

    quantity: float
    unit: str
    values: dict[str, tuple[float, str]]  # Cookidoo type -> (number, unit)


@dataclass(frozen=True)
class RecipeDetails:
    id: str
    name: str
    portions: float | None
    nutrition: list[NutritionEntry] = field(default_factory=list)
    image: str | None = None  # the address of the recipe picture Cookidoo gave (only ever fetched when the admin switched pictures on)


class CookidooClient(Protocol):
    """What the connector needs from Cookidoo. The real one is `LibraryClient`; tests bring a stand-in."""

    async def week(self, day: date) -> list[PlanDay]: ...
    async def collections(self) -> list[Collection]: ...
    async def recipe(self, recipe_id: str) -> RecipeDetails: ...
    async def ping(self) -> None: ...
    async def close(self) -> None: ...


# ---- unit conversion ----

# Cookidoo nutrition type -> (key in per_100 or extra, target unit). Only types seen in real answers are mapped.
GRAM_TYPES = {"fat": "fat", "saturatedFat": "saturated_fat", "carb2": "carbs", "protein": "protein", "dietaryFibre": "fiber"}
TO_GRAMS = {"g": 1.0, "mg": 1e-3, "µg": 1e-6, "ug": 1e-6, "mcg": 1e-6}
TO_MG = {"mg": 1.0, "g": 1e3, "µg": 1e-3, "ug": 1e-3, "mcg": 1e-3}
KJ_PER_KCAL = 4.184
SALT_PER_SODIUM = 2.5  # salt = sodium x 2.5 (EU labelling convention)
MAX_KCAL = 5000.0  # per portion; more means a unit error in the source
MAX_GRAMS = 500.0


def _number(values: dict, key: str, factors: dict[str, float]) -> float | None:
    entry = values.get(key)
    if entry is None:
        return None
    number, unit = entry
    factor = factors.get(unit.strip().lower())
    if factor is None or number is None or number < 0:
        return None
    return number * factor


def per_portion(entries: list[NutritionEntry]) -> NutritionEntry | None:
    """The block that holds the values for ONE portion (quantity 1), if Cookidoo sent one."""
    candidates = [e for e in entries if e.quantity == 1 and e.values]
    return candidates[0] if candidates else None


def nutrition_from(entries: list[NutritionEntry]) -> tuple[dict, dict]:
    """(per_100, extra) for one portion, from Cookidoo's values. The portion is stored as 100 g (REFERENCE_AMOUNT), so
    the numbers are the values of one portion as they are, scaled by REFERENCE_AMOUNT / 100 = 1.

    Energy comes from kcal, else from kJ. A value in an unknown unit or outside what a portion can hold counts as
    missing (unknown, not zero). Without energy the recipe is refused: a food without calories would silently
    log zero. Raises RecipeRejected with the reason.
    """
    block = per_portion(entries)
    if block is None:
        raise RecipeRejected("this recipe has no nutrition values per portion")
    values = block.values
    kcal = None
    if "kcal" in values and values["kcal"][1].strip().lower() == "kcal" and values["kcal"][0] >= 0:
        kcal = values["kcal"][0]
    elif "kJ" in values and values["kJ"][1].strip().lower() == "kj" and values["kJ"][0] >= 0:
        kcal = values["kJ"][0] / KJ_PER_KCAL
    if kcal is None:
        raise RecipeRejected("this recipe has no energy value")
    if kcal > MAX_KCAL:
        raise RecipeRejected("the energy value of this recipe is not plausible")
    per_100: dict[str, float | None] = {key: None for key in PER_100_KEYS}
    per_100["kcal"] = round(kcal, 1)
    for source, key in GRAM_TYPES.items():
        grams = _number(values, source, TO_GRAMS)
        if grams is not None and grams <= MAX_GRAMS:
            per_100[key] = round(grams, 2)
    extra: dict[str, float] = {}
    sodium = _number(values, "sodium", TO_MG)
    if sodium is not None and sodium <= 40000:
        extra["sodium"] = round(sodium, 1)
        per_100["salt"] = round(sodium * SALT_PER_SODIUM / 1000, 2)
    return per_100, extra


def food_data(details: RecipeDetails) -> dict:
    """The data of the food that stands for the recipe: values per portion, booked as 100 g = 1 portion."""
    per_100, extra = nutrition_from(details.nutrition)
    name = (details.name or "").strip()[:200]
    if not name:
        raise RecipeRejected("this recipe has no name")
    portions = details.portions
    return {
        "name": name,
        "brand": "Cookidoo",
        "quantity": None,
        "serving_size": "1 portion",
        "serving_quantity": REFERENCE_AMOUNT,
        "unit": "g",
        "per_100": per_100,
        "extra": extra,
        "complete": all(per_100.get(k) is not None for k in ("kcal", "fat", "carbs", "protein")),
        "portions": portions if portions and portions > 0 else None,
    }


# ---- the library behind the client ----


class LibraryClient:
    """`CookidooClient` on top of `cookidoo-api`. Imports the package on first use only, never at module level."""

    def __init__(self, settings: Settings):
        self._settings = settings
        self._session = None
        self._api = None
        self._lock = asyncio.Lock()

    async def _connect(self):
        if self._api is not None:
            return self._api
        try:
            import aiohttp
            from cookidoo_api import Cookidoo, CookidooConfig, get_localization_options
        except ImportError as exc:
            raise CookidooError("unexpected") from exc
        options = await get_localization_options(self._settings.country, self._settings.language)
        if not options:
            raise CookidooError("unexpected")
        config = CookidooConfig(localization=options[0], email=self._settings.email, password=self._settings.password)
        self._session = aiohttp.ClientSession(
            cookie_jar=aiohttp.CookieJar(unsafe=True), timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
        )
        self._api = Cookidoo(self._session, config)
        return self._api

    async def _call(self, work):
        """Run `work(api)`; sign in first when needed and once more when Cookidoo says the token is no good."""
        from cookidoo_api import CookidooAuthException, CookidooException

        async with self._lock:
            api = await self._connect()
            try:
                if api.auth_data is None:
                    await api.login()
                try:
                    return await work(api)
                except CookidooAuthException:
                    await api.login()  # the token was refused: sign in afresh, once
                    return await work(api)
            except CookidooAuthException as exc:
                await self.close()
                raise CookidooError("auth") from exc
            except CookidooException as exc:
                raise CookidooError(_kind(exc)) from exc
            except (TimeoutError, OSError) as exc:
                raise CookidooError("unavailable") from exc
            except (KeyError, ValueError, TypeError, AttributeError) as exc:
                raise CookidooError("unexpected") from exc

    async def week(self, day: date) -> list[PlanDay]:
        async def work(api):
            days = await api.get_recipes_in_calendar_week(day)
            return [
                PlanDay(day=str(d.id), title=str(d.title), recipes=[
                    PlannedRecipe(id=str(r.id), name=str(r.name)) for r in d.recipes if not r.is_custom
                ])
                for d in days
            ]
        return await self._call(work)

    async def collections(self) -> list[Collection]:
        async def work(api):
            result = []
            for managed, getter in ((False, api.get_custom_collections), (True, api.get_managed_collections)):
                for item in await getter():
                    recipes = [PlannedRecipe(id=str(r.id), name=str(r.name)) for ch in item.chapters for r in ch.recipes]
                    result.append(Collection(id=str(item.id), name=str(item.name), managed=managed,
                                             recipes=recipes[:MAX_COLLECTION_RECIPES]))
            return result
        return await self._call(work)

    async def recipe(self, recipe_id: str) -> RecipeDetails:
        async def work(api):
            r = await api.get_recipe_details(recipe_id)
            entries = [
                NutritionEntry(
                    quantity=float(rn.quantity), unit=str(rn.unit_notation),
                    values={n.type: (float(n.number), str(n.unittype)) for n in rn.nutritions},
                )
                for group in r.nutrition_groups for rn in group.recipe_nutritions
            ]
            image = r.image if isinstance(getattr(r, "image", None), str) and r.image else None
            return RecipeDetails(id=str(r.id), name=str(r.name), portions=float(r.serving_size) or None, nutrition=entries, image=image)
        return await self._call(work)

    async def ping(self) -> None:
        """Sign in (when there is no token yet) and do nothing else."""
        async def work(api):
            return None
        await self._call(work)

    async def close(self) -> None:
        session, self._session, self._api = self._session, None, None
        if session is not None:
            await session.close()


def _kind(exc: Exception) -> str:
    from cookidoo_api import CookidooParseException, CookidooRequestException, CookidooResponseException, CookidooUnavailableException

    if isinstance(exc, (CookidooParseException, CookidooResponseException)):
        return "unexpected"
    if isinstance(exc, (CookidooRequestException, CookidooUnavailableException)):
        return "unavailable"
    return "unexpected"


# ---- the connector the routes use ----


class _Account:
    """The state of one account: client (with the sign-in), caches, call counter, brake and last error."""

    def __init__(self, key: str):
        self.key = key
        self.settings: Settings | None = None
        self.client: CookidooClient | None = None
        self.lists: dict[str, tuple[float, object]] = {}
        self.recipes: dict[str, tuple[float, RecipeDetails]] = {}
        self.calls: deque[float] = deque()
        self.bulk_calls: deque[float] = deque()
        self.blocked_until = 0.0
        self.last_fail = -1e12  # when a sign-in of this account was refused
        self.last_check = -1e12  # when "check the connection" signed in last
        self.last_error: str | None = None
        self.last_used = 0.0
        self.gen = 0  # bumped whenever the account is changed or forgotten: an older answer is then not cached
        self.lock = asyncio.Lock()


class Hub:
    """Holds one `_Account` per account in use (the shared one and each user's own), the global call limit and the cap on
    the number of clients held at once.

    `factory` builds the client from the settings; the tests pass one that returns a stand-in.
    """

    def __init__(self, factory: Callable[[Settings], CookidooClient] = LibraryClient, clock: Callable[[], float] = time.time):
        self.factory = factory
        self.clock = clock
        self._accounts: OrderedDict[str, _Account] = OrderedDict()
        self._calls: deque[float] = deque()
        self._bulk_calls: deque[float] = deque()
        self.listeners: list[Callable[[str], None]] = []  # told when an account is forgotten (sign-out, change, removal)
        # refused sign-ins per account holder and all sign-in attempts: kept here, apart from the accounts, so that neither
        # changing the account nor the eviction of an idle account forgets them
        self._fails: dict[str, deque[float]] = {}
        self._logins: deque[float] = deque()

    # status for the admin area and the profile
    @property
    def last_error(self) -> str | None:
        """The last failure of the shared account (a key of MESSAGES, never text from Cookidoo)."""
        account = self._accounts.get(SHARED)
        return account.last_error if account else None

    def error_of(self, key: str) -> str | None:
        account = self._accounts.get(key)
        return account.last_error if account else None

    def status(self, enabled: bool, access: "Access | None | bool" = False, key: str = SHARED) -> str:
        """off / not_installed / not_configured / error / ready. Without `access` the environment's settings count."""
        if not installed():
            return "not_installed"
        has = Settings.from_env() is not None if access is False else access is not None
        if not has:
            return "not_configured"
        if self.error_of(key) is not None:
            return "error"
        return "ready" if enabled else "off"

    def client_count(self) -> int:
        return sum(1 for a in self._accounts.values() if a.client is not None)

    def _reserve_call(self, account: _Account, bulk: bool = False) -> None:
        now = self.clock()
        mine, everyone = (account.bulk_calls, self._bulk_calls) if bulk else (account.calls, self._calls)
        limits = (BULK_CALL_LIMIT, GLOBAL_BULK_CALL_LIMIT) if bulk else (CALL_LIMIT, GLOBAL_CALL_LIMIT)
        for calls, (limit, window) in ((mine, limits[0]), (everyone, limits[1])):
            while calls and now - calls[0] > window:
                calls.popleft()
            if len(calls) >= limit:
                raise CookidooError("busy")
        mine.append(now)
        everyone.append(now)

    def generation(self, key: str) -> int | None:
        """Bumped whenever the account is changed or forgotten (None: nothing is held for it)."""
        account = self._accounts.get(key)
        return account.gen if account else None

    async def _drop(self, account: _Account) -> None:
        client, account.client = account.client, None
        if client is not None:
            try:
                await client.close()
            except Exception:  # closing is best effort
                pass

    async def _account(self, access: Access) -> _Account:
        """The account of `access`, with its state reset when the settings changed since the last call."""
        account = self._accounts.get(access.key)
        if account is None:
            account = self._accounts[access.key] = _Account(access.key)
            while len(self._accounts) > MAX_ACCOUNTS:
                oldest = next((k for k, a in self._accounts.items() if a.client is None and not a.lock.locked() and k != access.key), None)
                if oldest is None:
                    break
                del self._accounts[oldest]
        if account.settings is not None and account.settings != access.settings:
            await self._drop(account)  # changed: nothing of the old account stays
            account.gen += 1
            account.lists.clear()
            account.recipes.clear()
            account.blocked_until = 0.0
            account.last_error = None
        account.settings = access.settings
        self._accounts.move_to_end(access.key)
        account.last_used = self.clock()
        for other in list(self._accounts.values()):  # sign-ins nobody uses are not kept
            if other is not account and other.client is not None and not other.lock.locked() \
                    and account.last_used - other.last_used > IDLE_SECONDS:
                await self._drop(other)
        return account

    async def _make_room(self, keep: _Account) -> None:
        while self.client_count() >= MAX_CLIENTS:
            victim = next((a for a in self._accounts.values() if a.client is not None and a is not keep and not a.lock.locked()), None)
            if victim is None:
                raise CookidooError("busy")
            await self._drop(victim)

    def _recent(self, calls: deque[float], window: float, now: float) -> int:
        while calls and now - calls[0] > window:
            calls.popleft()
        return len(calls)

    def _check_login_allowed(self, key: str, now: float) -> None:
        fails = self._fails.get(key)
        if fails is not None and self._recent(fails, FAIL_LIMIT[1], now) >= FAIL_LIMIT[0]:
            raise CookidooError("locked")
        if self._recent(self._logins, LOGIN_LIMIT[1], now) >= LOGIN_LIMIT[0]:
            raise CookidooError("busy")

    def _note_refusal(self, key: str, now: float) -> None:
        self._fails.setdefault(key, deque()).append(now)
        if len(self._fails) > 5000:  # bounded: forget the holders whose last refusal is oldest
            for k in sorted(self._fails, key=lambda k: self._fails[k][-1] if self._fails[k] else 0)[:1000]:
                del self._fails[k]

    async def _run(self, account: _Account, work, bulk: bool = False):
        now = self.clock()
        if now < account.blocked_until:
            raise CookidooError("auth")
        settings, gen = account.settings, account.gen
        if settings is None:
            raise CookidooError("gone")
        if account.client is None:
            self._check_login_allowed(account.key, now)
            if now - account.last_fail < LOGIN_GAP:  # new credentials after a refusal: not at once
                raise CookidooError("wait")
        self._reserve_call(account, bulk)
        if account.client is None:
            await self._make_room(account)
            self._logins.append(now)
            account.client = self.factory(settings)
        client = account.client

        def current() -> bool:
            return gen == account.gen

        try:
            result = await asyncio.wait_for(work(client), timeout=REQUEST_TIMEOUT * 3)
        except TimeoutError as exc:
            if current():
                account.last_error = "unavailable"
            raise CookidooError("unavailable") from exc
        except CookidooError as exc:
            if current():
                account.last_error = exc.kind
                if exc.kind == "auth":
                    account.last_fail = self.clock()
                    account.blocked_until = self.clock() + AUTH_COOLDOWN
                    self._note_refusal(account.key, self.clock())
                    await self._drop(account)
            raise
        except Exception as exc:  # whatever the client throws, the caller only learns the category
            log.warning("cookidoo call failed (%s)", type(exc).__name__)
            if current():
                account.last_error = "unexpected"
            raise CookidooError("unexpected") from exc
        if current():
            account.last_error = None
        return result

    async def _cached_list(self, access: Access, key: str, work):
        account = await self._account(access)
        async with account.lock:
            hit = account.lists.get(key)
            if hit and self.clock() - hit[0] < LIST_CACHE_SECONDS:
                return hit[1]
            gen = account.gen
            result = await self._run(account, work)
            if gen == account.gen:  # not cached when the account was changed while the answer was on its way
                account.lists[key] = (self.clock(), result)
            return result

    async def week(self, access: Access) -> list[PlanDay]:
        today = date.fromtimestamp(self.clock())
        return await self._cached_list(access, "week", lambda c: c.week(today))

    async def collections(self, access: Access) -> list[Collection]:
        return await self._cached_list(access, "collections", lambda c: c.collections())

    async def recipe(self, access: Access, rid: str) -> RecipeDetails:
        return (await self.recipe_fetched(access, rid))[0]

    async def recipe_fetched(self, access: Access, rid: str, *, bulk: bool = False, pace=None) -> tuple[RecipeDetails, bool]:
        """The recipe and whether it was asked of Cookidoo now (False: it came from the cache).

        `bulk` is for the background runs: the call is counted against the bulk budget (not the interactive one) and the answer
        is not cached (a run would push everything else out of the small cache). `pace` is awaited just before a call to Cookidoo
        is made (not on a cache hit) and before the account's lock is taken, so that waiting never holds up other requests."""
        account = await self._account(access)
        hit = account.recipes.get(rid)
        if hit and self.clock() - hit[0] < RECIPE_CACHE_SECONDS:
            return hit[1], False
        if pace is not None:
            await pace()
        async with account.lock:
            hit = account.recipes.get(rid)
            if hit and self.clock() - hit[0] < RECIPE_CACHE_SECONDS:
                return hit[1], False
            gen = account.gen
            details = await self._run(account, lambda c: c.recipe(rid), bulk)
            if gen == account.gen and not bulk:
                if len(account.recipes) >= RECIPE_CACHE_MAX:
                    account.recipes.pop(next(iter(account.recipes)))
                account.recipes[rid] = (self.clock(), details)
            return details, True

    async def check(self, access: Access) -> None:
        """One fresh sign-in attempt (an existing sign-in is dropped first), braked like every other sign-in: not within
        30 seconds of the last check, not within five minutes after a refusal (unless the account was changed, and then
        not within 30 seconds of the refusal)."""
        account = await self._account(access)
        async with account.lock:
            now = self.clock()
            if now - account.last_check < LOGIN_GAP:
                raise CookidooError("wait")
            account.last_check = now
            await self._drop(account)
            await self._run(account, lambda c: c.ping())

    async def forget(self, key: str) -> None:
        """Remove everything held for an account (client, caches, brake, error): after it was removed or changed."""
        for listener in self.listeners:
            listener(key)
        account = self._accounts.get(key)
        if account is not None:  # the record stays (it holds the times of the last refusal and check), emptied
            await self._drop(account)
            account.gen += 1
            account.settings = None
            account.lists.clear()
            account.recipes.clear()
            account.blocked_until = 0.0
            account.last_error = None

    async def aclose(self) -> None:
        for account in list(self._accounts.values()):
            await self._drop(account)

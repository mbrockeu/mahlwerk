"""One-time direct sign-in at Yazio: fetch the diary of the signed-in account and hand it over in the structure of the
exporter's files, so that the import core (`yazio.py`) is the same as for an uploaded export.

THIS TALKS TO AN UNOFFICIAL INTERFACE. Yazio publishes no API; what is used here was worked out from public, community
written clients (see docs/integrations.md for the sources). It can change or be blocked at any time, and using it may be
against Yazio's terms: it is switched off by default and an admin has to switch it on, on their own responsibility.
It has NEVER been run against the real service by the authors of this module; the tests use a stand-in (httpx.MockTransport)
that follows the answers the public clients document.

Rules this module keeps:
- Fixed target: only `https://yzapi.yazio.com/v15` (the base is a constant, not a setting), no redirects are followed,
  every id that goes into a path is checked against a strict pattern first, every request has a time limit and every
  answer a size limit.
- The e-mail address and the password are used for ONE sign-in request and then forgotten; the access token lives in
  the memory of the fetching thread for the duration of the run and is dropped with it. No refresh token is used or kept.
  None of it is stored, logged or put into an error message; failures are reduced to the neutral categories of MESSAGES.
- The app identifiers (`client_id`, `client_secret` of the Yazio app) are not part of this repository: they come from
  `MAHLWERK_YAZIO_CLIENT_ID` / `MAHLWERK_YAZIO_CLIENT_SECRET`, and without them the direct sign-in is not available.
- Politeness and brakes: at most 4 requests at once, 48 MB of answers per run, a budget of requests and of time per run, a bounded period (at most
  24 months), one run per person at a time, at most 2 runs on the server at once, at most 3 sign-in attempts per person
  and hour and 30 seconds between two of them, at most 10 per hour on the whole server (so a wrong password is not repeated and the
  server cannot be used to try passwords against Yazio accounts in bulk).
"""

import asyncio
import json
import logging
import os
import re
import threading
import time
from calendar import monthrange
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date

import httpx

log = logging.getLogger("mahlwerk.yazio")

BASE = "https://yzapi.yazio.com/v15"
HOST = "yzapi.yazio.com"
REQUEST_TIMEOUT = 20.0
MAX_ANSWER = 2 * 1024 * 1024  # bytes of one answer
CONCURRENCY = 4
MAX_REQUESTS = 8000
MAX_SECONDS = 20 * 60
MAX_MONTHS = 24
DEFAULT_MONTHS = 12
MAX_DAYS = 800
RETRIES = 2
MAX_RUN_BYTES = 48 * 1024 * 1024  # all answers of one run together; more is a clean stop ("too_large")
GLOBAL_ATTEMPTS = (10, 3600)  # sign-in attempts per hour for the whole server, whoever makes them
ATTEMPTS = (3, 3600)  # sign-in attempts per person: at most 3 in an hour
ATTEMPT_GAP = 30.0  # and 30 seconds between two
MAX_RUNNING = 2  # runs on the server at once
KEEP_FINISHED = 1800  # a finished run's state is kept this long

MESSAGES = {
    "auth": "Yazio refused the sign-in (check the e-mail address and the password)",
    "busy": "Yazio asked to slow down (too many requests); try again later",
    "unavailable": "Yazio is not reachable",
    "unexpected": "Yazio answered in an unexpected way (the unofficial interface may have changed)",
    "too_large": "an answer of Yazio was larger than allowed",
    "limit": "the run needed more requests or time than allowed; choose a shorter period",
    "expired": "the sign-in with Yazio ran out during the run; start again",
    "no_data": "no diary days were found in the chosen period",
    "cancelled": "cancelled",
}

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # one safe path segment (real ids are UUIDs)
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class LiveError(Exception):
    """A neutral failure: `kind` is a key of MESSAGES. Never carries text from Yazio or from the credentials."""

    def __init__(self, kind: str):
        super().__init__(MESSAGES[kind])
        self.kind = kind


def app_identity() -> tuple[str, str] | None:
    """The app identifiers from the environment, or None (then the direct sign-in is not available)."""
    client_id = os.environ.get("MAHLWERK_YAZIO_CLIENT_ID", "").strip()
    client_secret = os.environ.get("MAHLWERK_YAZIO_CLIENT_SECRET", "").strip()
    return (client_id, client_secret) if client_id and client_secret else None


class Credentials:
    """E-mail address and password for one sign-in; `take` hands them out once and forgets them."""

    def __init__(self, email: str, password: str):
        self._email, self._password = email, password

    def take(self) -> tuple[str, str]:
        email, password, self._email, self._password = self._email, self._password, "", ""
        return email, password

    def __repr__(self) -> str:
        return "Credentials(...)"


@dataclass
class Progress:
    phase: str = "login"  # login, discover, days, products, weights, done
    done: int = 0
    total: int = 0
    requests: int = 0
    bytes: int = 0
    cancelled: threading.Event = field(default_factory=threading.Event)


def _day(value) -> str | None:
    if isinstance(value, str) and _DAY.fullmatch(value[:10]) and (len(value) == 10 or value[10] in "T "):
        try:
            date.fromisoformat(value[:10])
        except ValueError:
            return None
        return value[:10]
    return None


class Fetcher:
    """Fetches the diary. `transport` is for the tests (a stand-in for Yazio)."""

    def __init__(self, identity: tuple[str, str], transport: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], float] = time.monotonic, sleep=asyncio.sleep, today: Callable[[], date] = date.today):
        self.identity = identity
        self.transport = transport
        self.clock = clock
        self.sleep = sleep
        self.today = today

    # ---- one request ----

    async def _send(self, http: httpx.AsyncClient, progress: Progress, method: str, path: str, *, token: str | None = None,
                    params: dict | None = None, body: dict | None = None, retries: int = RETRIES):
        """The parsed JSON answer, or None for 404. Raises LiveError."""
        if progress.cancelled.is_set():
            raise LiveError("cancelled")
        if self.clock() > self.deadline or progress.requests >= MAX_REQUESTS:
            raise LiveError("limit")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        for attempt in range(retries + 1):
            progress.requests += 1
            try:
                async with http.stream(method, BASE + path, params=params, json=body, headers=headers) as response:
                    status = response.status_code
                    if status in (301, 302, 303, 307, 308):
                        raise LiveError("unexpected")  # redirects are never followed
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data += chunk
                        if len(data) > MAX_ANSWER:
                            raise LiveError("too_large")
                    progress.bytes += len(data)
                    if progress.bytes > MAX_RUN_BYTES:
                        raise LiveError("too_large")
            except LiveError:
                raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt < retries:
                    await self.sleep(2 ** attempt)
                    continue
                raise LiveError("unavailable") from None
            if status == 404:
                return None
            if status in (401, 403):
                raise LiveError("auth" if path == "/oauth/token" else "expired")
            if status == 400 and path == "/oauth/token":
                raise LiveError("auth")
            if status == 429:
                raise LiveError("busy")
            if status >= 500:
                if attempt < retries:
                    await self.sleep(2 ** attempt)
                    continue
                raise LiveError("unavailable")
            if status >= 400:
                raise LiveError("unexpected")
            if status == 204 or not data:
                return None
            try:
                return json.loads(bytes(data))
            except (ValueError, RecursionError):
                raise LiveError("unexpected") from None
        raise LiveError("unavailable")  # pragma: no cover

    # ---- the run ----

    async def run(self, credentials: Credentials, months: int, progress: Progress) -> dict[str, dict]:
        """Sign in once, fetch the period, return `{"days.json": ..., "products.json": ..., "weight.json": ...}`."""
        months = max(1, min(MAX_MONTHS, months))
        self.deadline = self.clock() + MAX_SECONDS
        limits = httpx.Limits(max_connections=CONCURRENCY, max_keepalive_connections=CONCURRENCY)
        async with httpx.AsyncClient(
            transport=self.transport, timeout=httpx.Timeout(REQUEST_TIMEOUT), follow_redirects=False, limits=limits,
            headers={"User-Agent": "Mahlwerk (one-time import)", "Accept": "application/json"},
        ) as http:
            token = await self._login(http, progress, credentials)
            try:
                return await self._fetch(http, progress, token, months)
            finally:
                token = ""

    async def _login(self, http, progress: Progress, credentials: Credentials) -> str:
        email, password = credentials.take()
        client_id, client_secret = self.identity
        body = {"client_id": client_id, "client_secret": client_secret, "username": email, "password": password,
                "grant_type": "password"}
        email = password = ""
        try:
            answer = await self._send(http, progress, "POST", "/oauth/token", body=body, retries=0)
        finally:
            body.clear()
        token = answer.get("access_token") if isinstance(answer, dict) else None
        if not isinstance(token, str) or not token or len(token) > 8192 or "\n" in token or "\r" in token:
            raise LiveError("unexpected")
        return token

    async def _many(self, progress: Progress, jobs: list, work) -> list:
        """Run `work(job)` for every job, a few at a time; the first LiveError stops everything."""
        gate = asyncio.Semaphore(CONCURRENCY)
        results: list = [None] * len(jobs)

        async def one(index: int, job):
            async with gate:
                results[index] = await work(job)
                progress.done += 1

        tasks = [asyncio.create_task(one(i, job)) for i, job in enumerate(jobs)]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        return results

    async def _fetch(self, http, progress: Progress, token: str, months: int) -> dict[str, dict]:
        get = lambda path, **params: self._send(http, progress, "GET", path, token=token, params=params or None)  # noqa: E731
        # 1. which days have entries: one request per month
        progress.phase, progress.done, progress.total = "discover", 0, months
        today = self.today()
        first = (today.year * 12 + today.month - 1) - (months - 1)
        days: list[str] = []
        for index in range(months):
            year, month = divmod(first + index, 12)
            month += 1
            last_day = monthrange(year, month)[1]
            listing = await get("/user/consumed-items/nutrients-daily", start=f"{year:04d}-{month:02d}-01",
                                end=f"{year:04d}-{month:02d}-{last_day:02d}")
            for item in listing if isinstance(listing, list) else []:
                day = _day(item.get("date")) if isinstance(item, dict) else None
                if day and day <= today.isoformat():
                    days.append(day)
            progress.done += 1
        days = sorted(set(days))
        if not days:
            raise LiveError("no_data")
        if len(days) > MAX_DAYS:
            raise LiveError("limit")

        # 2. the days: entries, exercises and the daily summary (water, steps, active energy, goals)
        progress.phase, progress.done, progress.total = "days", 0, len(days)

        async def one_day(day: str):
            consumed = await get("/user/consumed-items", date=day)
            if not isinstance(consumed, dict):
                return None
            exercises = await get("/user/exercises", date=day)
            summary = await get("/user/widgets/daily-summary", date=day)
            content = {"consumed": {k: consumed.get(k) if isinstance(consumed.get(k), list) else []
                                    for k in ("products", "recipe_portions", "simple_products")}}
            if isinstance(exercises, dict):
                content["exercises"] = exercises
            if isinstance(summary, dict):
                content["daily_summary"] = summary
            return content

        fetched = await self._many(progress, days, one_day)
        day_map = {day: content for day, content in zip(days, fetched) if content is not None}
        if not day_map:
            raise LiveError("no_data")

        # 3. the products and recipes the entries refer to
        product_ids, recipe_ids = set(), set()
        for content in day_map.values():
            for item in content["consumed"]["products"]:
                if isinstance(item, dict) and isinstance(item.get("product_id"), str) and _ID.fullmatch(item["product_id"]):
                    product_ids.add(item["product_id"])
            for item in content["consumed"]["recipe_portions"]:
                if isinstance(item, dict) and isinstance(item.get("recipe_id"), str) and _ID.fullmatch(item["recipe_id"]):
                    recipe_ids.add(item["recipe_id"])
        progress.phase, progress.done = "products", 0
        wanted = [("products", pid) for pid in sorted(product_ids)] + [("recipes", rid) for rid in sorted(recipe_ids)]
        progress.total = len(wanted)

        async def one_item(job):
            kind, ident = job
            return await get(f"/{kind}/{ident}")

        found = await self._many(progress, wanted, one_item)
        catalog: dict[str, dict] = {"products": {}, "recipes": {}}
        for (kind, ident), content in zip(wanted, found):
            if isinstance(content, dict):
                catalog[kind][ident] = content

        # 4. the weight: the last value at or before each logged day
        progress.phase, progress.done, progress.total = "weights", 0, len(day_map)

        async def one_weight(day: str):
            return await get("/user/bodyvalues/weight/last", date=day)

        answers = await self._many(progress, list(day_map), one_weight)
        weights = _weights(list(day_map), answers)
        progress.phase = "done"
        return {"days.json": day_map, "products.json": catalog, "weight.json": weights}


def _weights(days: list[str], answers: list) -> dict[str, float]:
    """The answers say the LAST weight up to a date, so the same value comes back on many days. With a date in the answer
    that is the day of the measurement; without one, a day counts only when the value differs from the day before."""
    out: dict[str, float] = {}
    previous = None
    for day, answer in zip(days, answers):
        value = answer.get("value") if isinstance(answer, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        measured = _day(answer.get("date")) if isinstance(answer, dict) else None
        if measured:
            out[measured] = float(value)
        elif value != previous:
            out[day] = float(value)
        previous = value
    return out


# ---- runs in the background, one per person ----


@dataclass
class Run:
    user_id: int
    progress: Progress = field(default_factory=Progress)
    state: str = "running"  # running, done, error, cancelled
    error: str | None = None  # a key of MESSAGES
    started: float = 0.0
    finished: float | None = None
    thread: threading.Thread | None = None

    def view(self) -> dict:
        p = self.progress
        return {"state": self.state, "phase": p.phase, "done": p.done, "total": p.total, "requests": p.requests,
                "error": MESSAGES.get(self.error or ""), "error_kind": self.error}


class Refused(Exception):
    """A new run is not allowed now; `kind`: running, busy (too many on the server), gap, hourly."""

    def __init__(self, kind: str, wait: int = 0):
        super().__init__(kind)
        self.kind, self.wait = kind, wait


class Runs:
    """Starts and tracks the background runs. `deliver(user_id, files)` is called with the fetched files of a run that
    succeeded (it puts them into the person's staging area); the credentials never leave the run."""

    def __init__(self, deliver: Callable[[int, dict[str, dict]], None], transport=None, clock: Callable[[], float] = time.time):
        self.deliver = deliver
        self.transport = transport
        self.clock = clock
        self.sleep = asyncio.sleep  # the tests replace these two
        self.today: Callable[[], date] = date.today
        self._lock = threading.Lock()
        self._runs: dict[int, Run] = {}
        self._attempts: dict[int, list[float]] = {}
        self._global: list[float] = []

    def _forget_old(self, now: float) -> None:
        for uid in [u for u, r in self._runs.items() if r.finished is not None and now - r.finished > KEEP_FINISHED]:
            del self._runs[uid]
        for uid in [u for u, times in self._attempts.items() if not times or now - times[-1] > ATTEMPTS[1]]:
            del self._attempts[uid]

    def start(self, user_id: int, credentials: Credentials, months: int) -> Run:
        identity = app_identity()
        if identity is None:
            raise LiveError("unexpected")
        now = self.clock()
        with self._lock:
            self._forget_old(now)
            current = self._runs.get(user_id)
            if current is not None and current.state == "running":
                raise Refused("running")
            if sum(1 for r in self._runs.values() if r.state == "running") >= MAX_RUNNING:
                raise Refused("busy")
            self._global = [t for t in self._global if now - t < GLOBAL_ATTEMPTS[1]]
            if len(self._global) >= GLOBAL_ATTEMPTS[0]:
                raise Refused("global", int(GLOBAL_ATTEMPTS[1] - (now - self._global[0])) + 1)
            times = [t for t in self._attempts.get(user_id, []) if now - t < ATTEMPTS[1]]
            if times and now - times[-1] < ATTEMPT_GAP:
                raise Refused("gap", int(ATTEMPT_GAP - (now - times[-1])) + 1)
            if len(times) >= ATTEMPTS[0]:
                raise Refused("hourly", int(ATTEMPTS[1] - (now - times[0])) + 1)
            times.append(now)
            self._global.append(now)
            self._attempts[user_id] = times
            run = Run(user_id, started=now)
            self._runs[user_id] = run
        fetcher = Fetcher(identity, self.transport, sleep=self.sleep, today=self.today)
        run.thread = threading.Thread(target=self._work, args=(run, fetcher, credentials, months), daemon=True, name="yazio-run")
        run.thread.start()
        return run

    def _work(self, run: Run, fetcher: Fetcher, credentials: Credentials, months: int) -> None:
        try:
            files = asyncio.run(fetcher.run(credentials, months, run.progress))
            if run.progress.cancelled.is_set():
                raise LiveError("cancelled")
            self.deliver(run.user_id, files)
            run.state = "done"
        except LiveError as exc:
            run.error = exc.kind
            run.state = "cancelled" if exc.kind == "cancelled" else "error"
        except Exception as exc:  # whatever happens, the person only learns the category
            log.warning("yazio run failed (%s)", type(exc).__name__)
            run.error = "unexpected"
            run.state = "error"
        finally:
            credentials.take()
            run.finished = self.clock()

    def get(self, user_id: int) -> Run | None:
        with self._lock:
            self._forget_old(self.clock())
            return self._runs.get(user_id)

    def cancel(self, user_id: int) -> None:
        run = self.get(user_id)
        if run is not None and run.state == "running":
            run.progress.cancelled.set()

    def cancel_all(self) -> None:
        with self._lock:
            runs = list(self._runs.values())
        for run in runs:
            if run.state == "running":
                run.progress.cancelled.set()

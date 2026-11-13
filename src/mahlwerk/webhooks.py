"""Outgoing webhooks: events of a user are POSTed to the URLs the user registered.

Delivery never happens in the request path. A request only puts a small job on a queue (`Dispatcher.publish`); a
background thread looks up the user's hooks and hands each delivery to a small pool of sender threads. A sender
tries up to three times (with a wait in between), never follows redirects and gives up after a timeout of five
seconds per try. A broken or slow hook therefore can neither slow down nor fail a request.

Each delivery is logged (`webhook_delivery`, the last 20 per hook are kept). The body is signed with the hook's
secret: header `X-Mahlwerk-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.
"""

import hashlib
import hmac
import json
import logging
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable
from urllib.parse import urlsplit, urlunsplit

import httpx

from . import netguard

log = logging.getLogger("mahlwerk.webhooks")

EVENTS = (
    "entry.created", "entry.updated", "entry.deleted", "weight.recorded", "water.changed",
    "fasting.started", "fasting.ended", "goal.changed", "badge.earned", "activity.recorded", "workout.created",
)
PING = "ping"
TIMEOUT = 5.0
MAX_ATTEMPTS = 3
BACKOFF = (2.0, 10.0)  # seconds to wait before the second and the third try
POOL = 4
MAX_URL = 500

# (url, body, headers, timeout) -> HTTP status code; raises on connection problems
Sender = Callable[[str, bytes, dict, float], int]


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def check_url(url: str) -> str | None:
    """Why the URL cannot be a webhook target, or None when it is fine (http or https with a host, no credentials)."""
    if len(url) > MAX_URL:
        return "url is too long"
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return "not a valid url"
    if parts.scheme not in ("http", "https"):
        return "url must start with http:// or https://"
    if not host:
        return "url needs a host"
    if parts.username or parts.password:
        return "url must not contain a user name or password"
    return None


def host_of(url: str) -> str | None:
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None


def make_sender(transport: httpx.BaseTransport | None = None):
    """The real transport: one POST, redirects are not followed, environment proxies are not used. It connects to the
    address that was checked (`address`), sends the original host in the Host header and uses it for TLS (SNI and
    certificate check), so the checked address is the one that is reached."""

    def send(url: str, body: bytes, headers: dict, timeout: float, address: str | None = None) -> int:
        extensions: dict = {}
        if address is not None:
            parts = urlsplit(url)
            literal = f"[{address}]" if ":" in address else address
            netloc = literal + (f":{parts.port}" if parts.port else "")
            headers = {**headers, "Host": parts.netloc.rsplit("@", 1)[-1]}
            extensions = {"sni_hostname": parts.hostname}
            url = urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))
        with httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False, transport=transport) as client:
            return client.post(url, content=body, headers=headers, extensions=extensions).status_code

    send.pinned = True  # type: ignore[attr-defined]
    return send


http_sender = make_sender()


def _describe(exc: Exception) -> str:
    # one text for every network problem: it must not tell a closed port from a filtered one or a timeout
    return "delivery failed"


class Dispatcher:
    def __init__(self, store, features, sender=http_sender):
        self.store = store
        self.features = features
        self.sender = sender
        self.timeout = TIMEOUT
        self.backoff = BACKOFF
        self._jobs: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._pool: ThreadPoolExecutor | None = None
        self._lock = threading.Lock()
        self._idle = threading.Condition()
        self._open = 0  # jobs and deliveries not finished yet

    # request side

    def publish(self, user_id: int, username: str, event: str, data: dict, hook_id: int | None = None) -> None:
        """Queue an event. Cheap and safe: it never raises and never waits for the network."""
        if self._stop.is_set():
            return
        try:
            job = {"user_id": user_id, "username": username, "event": event, "data": data,
                   "at": int(time.time()), "hook_id": hook_id}
            self._begin()
            self._ensure_running()
            self._jobs.put(job)
        except Exception:  # pragma: no cover - the diary must never fail because of a hook
            log.exception("could not queue webhook event")

    # bookkeeping, also used by the tests

    def _begin(self) -> None:
        with self._idle:
            self._open += 1

    def _done(self) -> None:
        with self._idle:
            self._open -= 1
            if self._open <= 0:
                self._idle.notify_all()

    def wait_idle(self, timeout: float = 10.0) -> bool:
        """Block until every queued event is delivered (or given up)."""
        with self._idle:
            return self._idle.wait_for(lambda: self._open <= 0, timeout)

    def _ensure_running(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._pool = ThreadPoolExecutor(max_workers=POOL, thread_name_prefix="mahlwerk-hook")
            self._thread = threading.Thread(target=self._run, name="mahlwerk-webhooks", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Stop cleanly: no new work, waits end at once, running sends finish or time out."""
        self._stop.set()
        self._jobs.put(None)
        thread, pool = self._thread, self._pool
        if thread is not None:
            thread.join(timeout=self.timeout + 2)
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)

    # worker side

    def _run(self) -> None:
        while not self._stop.is_set():
            job = self._jobs.get()
            if job is None:
                break
            try:
                self._fan_out(job)
            except Exception:
                log.exception("webhook job failed")
            finally:
                self._done()

    def _fan_out(self, job: dict) -> None:
        if not self.features.webhooks:
            return
        if job["hook_id"] is not None:
            hook = self.store.webhook_by_id(job["hook_id"])
            hooks = [hook] if hook and self.store.get_webhook(job["user_id"], hook["id"]) else []
        else:
            hooks = self.store.hooks_for_event(job["user_id"], job["event"])
        for hook in hooks:
            delivery_id = self.store.start_delivery(hook["id"], job["event"])
            self._begin()
            try:
                self._pool.submit(self._deliver, hook, delivery_id, job)
            except RuntimeError:  # the pool is already shut down
                self._done()

    def _target(self, url: str, host: str | None):
        """The address to connect to, or False when the target may not be called. Checked at EVERY delivery: a hook made
        before this check existed, or whose DNS name now points inside, is refused too."""
        if check_url(url) or not self.features.host_allowed(host):
            return False
        try:
            port = urlsplit(url).port or (443 if url.lower().startswith("https") else 80)
            return netguard.pick_address(host, port, allow_internal=self.features.host_listed(host))
        except (netguard.TargetNotAllowed, ValueError):
            return False

    def _deliver(self, hook: dict, delivery_id: int, job: dict) -> None:
        status: int | None = None
        error: str | None = None
        attempts = 0
        try:
            host = host_of(hook["url"])
            body = json.dumps(
                {"event": job["event"], "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(job["at"])),
                 "user": {"username": job["username"]}, "data": job["data"]},
                separators=(",", ":"), ensure_ascii=False, allow_nan=False,
            ).encode()
            headers = {
                "Content-Type": "application/json", "User-Agent": "Mahlwerk-Webhook",
                "X-Mahlwerk-Event": job["event"], "X-Mahlwerk-Delivery": str(delivery_id),
                "X-Mahlwerk-Signature": sign(hook["secret"], body),
            }
            address = self._target(hook["url"], host)
            if address is False:
                error = "target not allowed"
            else:
                while attempts < MAX_ATTEMPTS and not self._stop.is_set():
                    attempts += 1
                    status, error = None, None
                    try:
                        if getattr(self.sender, "pinned", False):
                            status = self.sender(hook["url"], body, headers, self.timeout, address)
                        else:
                            status = self.sender(hook["url"], body, headers, self.timeout)
                    except Exception as exc:
                        error = _describe(exc)
                    else:
                        if 200 <= status < 300:
                            break
                        error = f"HTTP {status}"
                        if status < 500 and status != 429:
                            break  # the receiver said no; asking again will not help
                    self.store.update_delivery(delivery_id, attempts, status, error, finished=False)
                    if attempts < MAX_ATTEMPTS and self._stop.wait(self.backoff[min(attempts - 1, len(self.backoff) - 1)]):
                        break
        except Exception as exc:
            log.exception("webhook delivery failed")
            error = error or _describe(exc)
        finally:
            try:
                ok = status is not None and 200 <= status < 300
                self.store.update_delivery(delivery_id, attempts, status, None if ok else error, finished=True)
                self.store.prune_deliveries(hook["id"])
            except Exception:
                log.exception("could not log webhook delivery")
            self._done()


def emit(request, user: dict, event: str, data: dict) -> None:
    """Called by the routes after a change. Never raises. The demo account never sends anything out."""
    if user.get("is_demo"):
        return
    try:
        request.app.state.webhooks.publish(user["id"], user["username"], event, data)
    except Exception:  # pragma: no cover
        log.exception("webhook emit failed")

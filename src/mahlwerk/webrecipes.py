"""Recipes from web pages: the address of a recipe goes in, name, portions and nutrition per portion come out.

What is read: the structured data a page carries for search engines (schema.org `Recipe` as JSON-LD in
`<script type="application/ld+json">`, also inside `@graph` and lists, `@type` as text or list). Microdata is NOT read:
doing that cleanly needs a real HTML tree and the standard library only has a tag scanner.

What is kept: name, number of portions, nutrition values per portion, the address and the host. Never kept or shown:
preparation steps, descriptions (copyright). The ONE picture the page names (`image`) is fetched and stored on this server only
when an admin switched "store recipe pictures" on for this connector (default off): see recipeimages.py; the address of the
picture is controlled by the site, so it is fetched like the page itself (same checks, see below). The ingredient lines are returned in the PREVIEW only so that a
person can look at them while typing an own recipe; they are not stored (the food has no field for them) and a recipe that
is taken over again starts from a fresh fetch.

Assumption about the nutrition values: schema.org defines `NutritionInformation` as the values of ONE serving
(`servingSize`), and the common recipe plugins and sites write them that way. The page may still give values for the whole
dish (or per 100 g); that is why the preview carries plausibility warnings and the person can say "the values are for the
whole recipe" (they are then divided by the portions). This was not checked against live pages (no page is fetched while
developing; see CONTRIBUTING), it follows the schema.org definition.

The fetch is the sensitive part, because the server calls an address a signed-in person typed:
  * only http/https, no user name or password, only the standard ports 80 and 443, a host name (no IP literal),
  * the host is resolved here, EVERY address must be public (netguard; there is no exception list for this feature) and
    the connection goes to exactly the address that was checked, with the original host in Host and for TLS (no DNS
    rebinding between check and connect),
  * redirects are followed by hand, at most 3, every station is checked again, https to http is refused,
  * 10 seconds for everything, at most 3 MB of (decompressed) body, counted while it arrives; only text/html and
    application/xhtml+xml; gzip/deflate are inflated with a bound, so a compression bomb stops at the limit,
  * a picture is fetched the same way (`Fetcher.fetch_image`): at most 6 MB, only image/jpeg, image/png and image/webp (no SVG, no GIF,
    no AVIF), afterwards decoded in a child process with limits (imageproc.py),
  * no cookies (a fresh client per station), no Referer, a fixed User-Agent with project name and contact,
  * every problem on the way (does not resolve, internal address, closed port, timeout, redirect loop, HTTP error) gives
    the same text, so the feature cannot tell an inside from an outside or an open from a closed port,
  * a brake per person and one for the server, and at most 3 fetches at the same time.
Whatever comes back is text: tags and control characters are removed and every length is limited.
robots.txt: one fetch of one page a person names themself and looks at (like opening it in a browser); nothing is crawled,
nothing is fetched in bulk, and there is deliberately no "take over a whole site".
"""

import codecs
import html
import json
import math
import os
import re
import threading
import time
import unicodedata
import zlib
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

import httpx

from . import netguard

SOURCE = "web"
EXTERNAL_PREFIX = "web:"
BRAND_PREFIX = "Web · "  # the brand of a taken-over web recipe; an entry keeps only its brand, so this is how it is recognised
REFERENCE_AMOUNT = 100.0  # g: one portion is stored as 100 g whose "per 100 g" values are the values of the portion (as for Cookidoo)

TOTAL_TIMEOUT = 10.0  # seconds for the whole fetch (all stations)
MAX_BYTES = 3 * 1024 * 1024  # decompressed
MAX_REDIRECTS = 3
MAX_URL = 800
PORTS = (80, 443)
CONTENT_TYPES = ("text/html", "application/xhtml+xml")
IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")
MAX_IMAGE_BYTES = 6 * 1024 * 1024  # a picture, as sent (a compressed answer is counted decompressed)
MAX_BLOCKS = 40  # JSON-LD blocks read per page
MAX_BLOCK_BYTES = 1024 * 1024
MAX_NODES = 3000  # objects looked at while searching for the recipe
MAX_DEPTH = 6
MAX_INGREDIENTS = 100
MAX_NAME = 200
MAX_LINE = 200
MAX_KCAL = 5000.0  # per portion; more means a unit error (or the whole recipe)
MAX_GRAMS = 500.0
MAX_PORTIONS = 200.0
KJ_PER_KCAL = 4.184
SALT_PER_SODIUM = 2.5

NEUTRAL = "the page could not be fetched"  # THE text for everything that goes wrong on the way

TRACKING = re.compile(r"^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|_gl|yclid|twclid|ttclid|wbraid|gbraid|ref_src|ref_url|spm|si)$", re.I)
CONTROL = {"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"}


class LinkRejected(Exception):
    """The text is not an address this feature will fetch."""


class FetchFailed(Exception):
    """Anything that went wrong on the way. `kind` is for the logs and tests only, the person always gets NEUTRAL,
    except `not_html` and `too_large`, which are only known after a connection to a public address."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


# ---- addresses ----


def _host_ok(host: str) -> str:
    host = host.strip().rstrip(".").lower()
    if not host or len(host) > 253 or any(c in host for c in " /\\@#?%[]:"):
        raise LinkRejected("host")
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise LinkRejected("host") from None
    labels = ascii_host.split(".")
    if len(labels) < 2 or any(not l or len(l) > 63 or l.startswith("-") or l.endswith("-") for l in labels):
        raise LinkRejected("host")
    if not re.fullmatch(r"[a-z0-9-]+", "".join(labels).replace("-", "a")) or not re.search(r"[a-z]", labels[-1]):
        raise LinkRejected("host")  # a number-like name is an IP literal in disguise (127.1, 0x7f.1, 2130706433)
    return ascii_host


def check_address(url: str) -> tuple[str, str, int]:
    """(normalised address, ascii host, port) of an address this feature may fetch, else LinkRejected.

    Normal form (so the same page is never taken over twice): scheme and host in lower case, the standard port dropped, no
    fragment, tracking parameters (utm_*, fbclid, gclid ...) removed, the remaining parameters sorted, an empty path is `/`.
    """
    url = (url or "").strip()
    if not url or len(url) > MAX_URL or any(unicodedata.category(c) in CONTROL or c.isspace() for c in url):
        raise LinkRejected("form")
    try:
        parts = urlsplit(url)
        port = parts.port
        host = parts.hostname
    except ValueError:
        raise LinkRejected("form") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not host:
        raise LinkRejected("scheme")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise LinkRejected("userinfo")
    if port is not None and port not in PORTS:
        raise LinkRejected("port")
    ascii_host = _host_ok(host)
    path = parts.path or "/"
    try:
        query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True, max_num_fields=60) if not TRACKING.match(k)))
    except (ValueError, UnicodeError):  # more than 60 parameters, odd escapes
        raise LinkRejected("query") from None
    explicit = f":{port}" if port is not None and port != (443 if scheme == "https" else 80) else ""
    return urlunsplit((scheme, ascii_host + explicit, path, query, "")), ascii_host, port or (443 if scheme == "https" else 80)


def external_id(address: str) -> str:
    """`web:<host><path>?<query>`: the scheme is left out, so http and https of one page are one recipe."""
    parts = urlsplit(address)
    return EXTERNAL_PREFIX + urlunsplit(("", parts.netloc, parts.path, parts.query, "")).lstrip("/")


def host_label(address: str) -> str:
    """The host to show: without `www.`, always in its ASCII form (an international name shows as `xn--...`, never as look-alike letters)."""
    host = urlsplit(address).hostname or ""
    return host[4:] if host.startswith("www.") else host


def safe_link(url) -> str | None:
    """The stored address as a link: only an http(s) address that passes the same check, else None (never `javascript:` etc.)."""
    if not isinstance(url, str):
        return None
    try:
        return check_address(url)[0]
    except LinkRejected:
        return None


# ---- the brake ----


class Brake:
    """At most `per_user` fetches per person and `total` for the server within `window` seconds, at most `parallel` at once.
    In the memory of this process; the clock is injectable so that tests do not sleep."""

    def __init__(self, clock: Callable[[], float] = time.time, per_user: int = 20, total: int = 60, window: float = 600.0, parallel: int = 3):
        self.clock, self.per_user, self.total, self.window = clock, per_user, total, window
        self._lock = threading.Lock()
        self._users: dict[int, deque] = {}
        self._all: deque = deque()
        self._slots = threading.BoundedSemaphore(parallel)

    def _trim(self, queue: deque, now: float) -> None:
        while queue and queue[0] <= now - self.window:
            queue.popleft()

    def allow(self, user_id: int) -> int:
        """0 = go ahead (and counted), else the seconds to wait."""
        now = self.clock()
        with self._lock:
            mine = self._users.setdefault(user_id, deque())
            self._trim(mine, now)
            self._trim(self._all, now)
            for queue, limit in ((mine, self.per_user), (self._all, self.total)):
                if len(queue) >= limit:
                    return max(1, int(queue[0] + self.window - now) + 1)
            mine.append(now)
            self._all.append(now)
            if len(self._users) > 5000:  # bound on memory: forget people who have nothing in the window
                for key in [k for k, q in self._users.items() if not q or q[-1] <= now - self.window]:
                    del self._users[key]
        return 0

    def slot(self) -> bool:
        return self._slots.acquire(blocking=False)

    def release(self) -> None:
        self._slots.release()


# ---- fetching ----

Transport = httpx.BaseTransport | None


def _decoder(encoding: str, first: bytes):
    if encoding in ("", "identity"):
        return None
    if encoding in ("gzip", "x-gzip"):
        return zlib.decompressobj(31)
    if encoding == "deflate":  # zlib-wrapped as the standard says, or raw as some servers send it
        zlib_header = len(first) >= 2 and first[0] & 0x0F == 8 and (first[0] * 256 + first[1]) % 31 == 0
        return zlib.decompressobj(15 if zlib_header else -15)
    raise FetchFailed("encoding")


def _read_body(response: httpx.Response, deadline: float, clock, limit: int = MAX_BYTES) -> bytes:
    """The body, decompressed, at most `limit` (a compression bomb stops at the limit, counted on what comes out)."""
    length = response.headers.get("content-length")
    if length and length.isdigit() and int(length) > limit:
        raise FetchFailed("too_large")
    encoding = response.headers.get("content-encoding", "").strip().lower()
    decoder, out, raw_total = None, bytearray(), 0
    started = False
    try:
        for chunk in response.iter_raw():
            if clock() > deadline:
                raise FetchFailed("timeout")
            raw_total += len(chunk)
            if raw_total > limit:
                raise FetchFailed("too_large")
            if not started:
                decoder, started = _decoder(encoding, chunk), True
            if decoder is None:
                out += chunk
            else:
                data = decoder.decompress(chunk, limit + 1 - len(out))
                out += data
                while decoder.unconsumed_tail and len(out) <= limit:
                    out += decoder.decompress(decoder.unconsumed_tail, limit + 1 - len(out))
            if len(out) > limit:
                raise FetchFailed("too_large")
    except zlib.error:
        raise FetchFailed("encoding") from None
    return bytes(out)


# Text encodings that are read. Anything else a page names is read as UTF-8 (wrong letters at worst): a name is NEVER looked up as a
# codec, because some codecs are quadratic or odd (punycode, idna, utf-7, rot13, hex, zlib ...) and would hold the process for minutes.
CHARSETS = {
    "utf-8": "utf-8", "utf8": "utf-8", "us-ascii": "ascii", "ascii": "ascii",
    "iso-8859-1": "latin-1", "latin1": "latin-1", "latin-1": "latin-1", "l1": "latin-1",
    "iso-8859-15": "iso8859-15", "latin-9": "iso8859-15", "latin9": "iso8859-15",
    "windows-1252": "cp1252", "cp1252": "cp1252", "iso-8859-2": "iso8859-2", "windows-1250": "cp1250", "cp1250": "cp1250",
}


def _charset(content_type: str, head: bytes) -> str:
    match = re.search(r"charset\s*=\s*[\"']?([A-Za-z0-9_.:-]{1,40})", content_type, re.I) or re.search(rb"<meta[^>]{0,200}charset\s*=\s*[\"']?([A-Za-z0-9_.:-]{1,40})", head, re.I)
    name = match.group(1) if match else "utf-8"
    name = name.decode("ascii", "replace") if isinstance(name, bytes) else name
    return CHARSETS.get(name.lower(), "utf-8")


def decode(body: bytes, content_type: str) -> str:
    if body.startswith(codecs.BOM_UTF8):
        return body[3:].decode("utf-8", "replace")
    if body.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):  # only with a byte order mark, never because a header says so
        return body.decode("utf-16", "replace")
    return body.decode(_charset(content_type, body[:2048]), "replace")


@dataclass
class Page:
    url: str  # the address of the last station
    text: str
    data: bytes = b""  # a picture: its bytes


class _Job:
    """What one fetch shares with the thread that waits for it."""

    def __init__(self):
        self.client: httpx.Client | None = None
        self.cancel = False
        self.result: Page | None = None
        self.error: BaseException | None = None
        self.done = threading.Event()
        self.lock = threading.Lock()


def blocked_hosts() -> list[str]:
    """Names that may not be fetched: MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS, the host of MAHLWERK_PUBLIC_URL and the names in
    MAHLWERK_ALLOWED_HOSTS (the server's own names: through a router a public name can lead back into the home network, where it may
    meet permissions that go by address). An entry blocks the name and all its subdomains."""
    names: list[str] = []
    for item in os.environ.get("MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS", "").split(","):
        names.append(item)
    for item in os.environ.get("MAHLWERK_ALLOWED_HOSTS", "").split(","):
        names.append(item)
    public = os.environ.get("MAHLWERK_PUBLIC_URL", "").strip()
    if public:
        try:
            names.append(urlsplit(public).hostname or "")
        except ValueError:
            pass
    out = []
    for name in names:
        name = name.strip().lower().lstrip("*").lstrip(".").rstrip(".")
        if name.count(":") == 1:
            name = name.split(":")[0]
        if name and name != "*" and name not in out:
            out.append(name)
    return out


def is_blocked(host: str, blocked: list[str]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == b or host.endswith("." + b) for b in blocked)


class Fetcher:
    """Fetches one page by the rules in the module text. `transport` is a stand-in for the network in tests.

    The whole fetch of an address (name resolution, connecting, TLS, headers, body and all redirects) runs in a thread of its own that the
    caller waits for at most `total_timeout` seconds. After that the caller gets a failure, the connection is closed so that the thread
    ends (a name resolution cannot be interrupted: that thread ends when the resolver answers). At most `max_workers` such threads exist
    at the same time (hung ones count), so they cannot pile up; a further fetch then fails at once."""

    def __init__(self, user_agent: str, transport: Transport = None, clock: Callable[[], float] = time.monotonic,
                 total_timeout: float = TOTAL_TIMEOUT, max_workers: int = 8):
        self.user_agent = user_agent
        self.transport = transport
        self.clock = clock
        self.total_timeout = total_timeout
        self.blocked: Callable[[], list[str]] = blocked_hosts
        self._workers = threading.BoundedSemaphore(max_workers)

    def fetch(self, address: str) -> Page:
        return self._run(address, False)

    def fetch_image(self, address: str) -> Page:
        """A picture (JPEG, PNG or WebP, at most MAX_IMAGE_BYTES) by the same rules as a page; `Page.data` holds the bytes."""
        return self._run(address, True)

    def _run(self, address: str, image: bool) -> Page:
        if not self._workers.acquire(blocking=False):
            raise FetchFailed("busy")
        job = _Job()

        def run() -> None:
            try:
                job.result = self._fetch(address, job, image)
            except BaseException as exc:  # noqa: BLE001 - handed to the waiting caller
                job.error = exc
            finally:
                job.done.set()
                self._workers.release()

        try:
            threading.Thread(target=run, name="mahlwerk-webfetch", daemon=True).start()
        except RuntimeError:
            self._workers.release()
            raise FetchFailed("busy") from None
        if not job.done.wait(self.total_timeout):
            job.cancel = True
            with job.lock:
                client = job.client
            if client is not None:
                try:
                    client.close()
                except Exception:  # noqa: BLE001
                    pass
            raise FetchFailed("timeout")
        if isinstance(job.error, FetchFailed):
            raise job.error
        if job.error is not None or job.result is None:
            raise FetchFailed("network")
        return job.result

    def _fetch(self, address: str, job: _Job, image: bool = False) -> Page:
        deadline = self.clock() + self.total_timeout
        current = address
        for station in range(MAX_REDIRECTS + 1):
            try:
                current, host, port = check_address(current)
                if is_blocked(host, self.blocked()):
                    raise netguard.TargetNotAllowed
                ip = netguard.pick_address(host, port)  # raises TargetNotAllowed unless every address is public
            except (LinkRejected, netguard.TargetNotAllowed, ValueError):
                raise FetchFailed("target") from None
            remaining = deadline - self.clock()
            if remaining <= 0 or job.cancel:
                raise FetchFailed("timeout")
            url, headers, extensions = netguard.pinned_target(current, ip)
            headers = {**headers, "User-Agent": self.user_agent, "Accept-Encoding": "gzip, deflate",
                       "Accept": "image/webp,image/jpeg,image/png;q=0.9" if image else "text/html,application/xhtml+xml;q=0.9"}
            timeout = httpx.Timeout(min(remaining, 5.0), connect=min(remaining, 4.0))
            try:
                with httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False, transport=self.transport) as client:
                    with job.lock:
                        job.client = client
                        if job.cancel:
                            raise FetchFailed("timeout")
                    with client.stream("GET", url, headers=headers, extensions=extensions) as response:
                        if response.status_code in (301, 302, 303, 307, 308):
                            location = response.headers.get("location", "")
                            nxt = urljoin(current, location) if location else ""
                            if not nxt or station == MAX_REDIRECTS:
                                raise FetchFailed("redirect")
                            if current.startswith("https://") and nxt.lower().startswith("http://"):
                                raise FetchFailed("downgrade")
                            current = nxt
                            continue
                        if response.status_code != 200:
                            raise FetchFailed("status")
                        content_type = response.headers.get("content-type", "")
                        kind = content_type.split(";")[0].strip().lower()
                        if image:
                            if kind not in IMAGE_TYPES:
                                raise FetchFailed("not_image")
                            return Page(current, "", _read_body(response, deadline, self.clock, MAX_IMAGE_BYTES))
                        if kind not in CONTENT_TYPES:
                            raise FetchFailed("not_html")
                        body = _read_body(response, deadline, self.clock)
                        return Page(current, decode(body, content_type))
            except FetchFailed:
                raise
            except (httpx.HTTPError, httpx.InvalidURL, OSError, ValueError, UnicodeError, LookupError):
                raise FetchFailed("network") from None
        raise FetchFailed("redirect")


# ---- reading the page ----


class _LdScripts(HTMLParser):
    """Collects the text of `<script type="application/ld+json">` blocks; everything else is ignored. Comments are skipped
    by the scanner, so a block that is commented out is not read."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.blocks: list[str] = []
        self._current: list[str] | None = None
        self._size = 0

    def handle_starttag(self, tag, attrs):
        if tag == "script" and len(self.blocks) < MAX_BLOCKS:
            kind = next((v for k, v in attrs if k == "type" and v), "")
            if kind.split(";")[0].strip().lower() == "application/ld+json":
                self._current, self._size = [], 0

    def handle_data(self, data):
        if self._current is not None:
            self._size += len(data)
            if self._size <= MAX_BLOCK_BYTES:
                self._current.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._current is not None:
            if self._size <= MAX_BLOCK_BYTES:
                self.blocks.append("".join(self._current))
            self._current = None


def _no_constant(name: str):
    raise ValueError(name)  # NaN, Infinity and -Infinity are no numbers for us: the block is skipped


def finite(value) -> float | None:
    """`value` as a finite float of sane size, else None (NaN, infinity, huge integers, text that is no number)."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) and abs(number) <= 1e12 else None


def json_ld_blocks(page: str) -> list:
    """The parsed JSON-LD values of the page (broken blocks are skipped)."""
    if "ld+json" not in page[:MAX_BYTES * 2].lower():  # nothing to read: skip the (pure Python, slowish) scan of a page without any
        return []
    scanner = _LdScripts()
    try:
        scanner.feed(page)
        scanner.close()
    except Exception:  # a scanner that gives up on odd markup: take what it had
        pass
    values = []
    for raw in scanner.blocks:
        text = raw.strip()
        text = re.sub(r"^(?:<!--|//\s*<!\[CDATA\[|/\*\s*<!\[CDATA\[\s*\*/)", "", text).strip()
        text = re.sub(r"(?:-->|//\s*\]\]>|/\*\s*\]\]>\s*\*/)$", "", text).strip()
        if not text:
            continue
        try:
            values.append(json.loads(text, parse_constant=_no_constant))
        except (ValueError, RecursionError):
            continue
    return values


def _is_recipe(node: dict) -> bool:
    kind = node.get("@type")
    kinds = kind if isinstance(kind, list) else [kind]
    return any(isinstance(k, str) and re.split(r"[/:#]", k)[-1].lower() == "recipe" for k in kinds)


def find_recipes(values: list) -> list[dict]:
    """Every `Recipe` object in the JSON-LD values: at the top, in `@graph`, in lists and in the usual wrappers (`mainEntity`,
    `itemListElement`, `item`), searched breadth first with a bound on depth and on the number of objects."""
    found, queue, seen = [], deque((v, 0) for v in values), 0
    while queue and seen < MAX_NODES:
        node, depth = queue.popleft()
        if isinstance(node, list):
            if depth < MAX_DEPTH:
                queue.extend((n, depth + 1) for n in node[:500])
            continue
        if not isinstance(node, dict):
            continue
        seen += 1
        if _is_recipe(node):
            found.append(node)
        if depth < MAX_DEPTH:
            for key in ("@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item", "hasPart"):
                if key in node and isinstance(node[key], (dict, list)):
                    queue.append((node[key], depth + 1))
    return found


def clean_text(value, limit: int = MAX_LINE) -> str:
    """Plain text from whatever the page gave: tags and entities resolved, control characters gone, blanks collapsed, cut off."""
    if isinstance(value, (list, tuple)):
        value = next((v for v in value if isinstance(v, str) and v.strip()), "")
    if isinstance(value, dict):
        value = value.get("name") or value.get("@value") or ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return ""
    text = html.unescape(re.sub(r"<[^>]{0,300}>", " ", value[:limit * 8]))
    text = "".join(c for c in text if unicodedata.category(c) not in CONTROL or c in "\n\t ")
    return " ".join(text.split())[:limit]


_NUMBER = re.compile(r"-?\d[\d.,  ' ]*")


def parse_number(text: str, thousands_ok: bool = False) -> float | None:
    """The first number in a text: `12,5`, `12.5`, `1.200`, `1,200`, `1 200`, `1.234,5`, `1,234.5`. A single separator followed by
    exactly three digits is a thousands separator only when `thousands_ok` (milligrams, kcal, kJ), else a decimal sign."""
    match = _NUMBER.match(text.strip().replace("−", "-")) or _NUMBER.search(text)
    if not match:
        return None
    raw = re.sub(r"[  ' ]", "", match.group(0).rstrip(".,' "))
    if not raw or raw == "-":
        return None
    dots, commas = raw.count("."), raw.count(",")
    if dots and commas:
        decimal = "." if raw.rfind(".") > raw.rfind(",") else ","
        raw = raw.replace("," if decimal == "." else ".", "").replace(decimal, ".")
    elif dots + commas > 1:  # 1.234.567 or 1,234,567
        raw = raw.replace(".", "").replace(",", "")
    elif dots + commas == 1:
        sign = "." if dots else ","
        head, tail = raw.split(sign)
        thousands = thousands_ok and len(tail) == 3 and head.lstrip("-").isdigit() and 1 <= len(head.lstrip("-")) <= 3 and not head.lstrip("-").startswith("0")
        raw = head + tail if thousands else head + "." + tail
    try:
        return finite(raw)
    except ValueError:
        return None


_UNIT = re.compile(r"(?<![A-Za-z])(kcal|kj|cal|mg|g|gr|gramm|gram|grams|mcg|µg|μg|ug)\b", re.I)


def _with_unit(value, bare_thousands: bool = False) -> tuple[float | None, str]:
    """(number, unit in lower case or '') of a nutrition value given as number or text such as `523 kcal` or `12,5 g`.
    `bare_thousands`: a number without unit may use `1.200` for 1200 (energy and sodium, which are whole numbers)."""
    if isinstance(value, bool):
        return None, ""
    if isinstance(value, (int, float)):
        return finite(value), ""
    if isinstance(value, dict):  # a QuantitativeValue
        number, unit = _with_unit(value.get("value"), bare_thousands)
        return number, unit or clean_text(value.get("unitText") or value.get("unitCode") or "", 12).lower()
    if isinstance(value, list):
        return _with_unit(next((v for v in value if v not in (None, "")), None), bare_thousands)
    if not isinstance(value, str):
        return None, ""
    text = html.unescape(value)[:200]
    unit = _UNIT.search(text)
    unit_name = unit.group(1).lower() if unit else ""
    return parse_number(text, thousands_ok=unit_name in ("mg", "kcal", "kj", "cal") or (unit_name == "" and bare_thousands)), unit_name


def parse_energy(value) -> float | None:
    """kcal from `523 kcal`, `523`, `2190 kJ`, `523 kcal / 2190 kJ` (kcal wins when both are there), else None."""
    if isinstance(value, str):
        text = html.unescape(value)[:200]
        kcal = re.search(r"(-?\d[\d.,\s]*)\s*(?:kcal|calories|cal\b)", text, re.I)
        if kcal:
            number = parse_number(kcal.group(1), thousands_ok=True)
            return number if number is not None and number >= 0 else None
        kj = re.search(r"(-?\d[\d.,\s]*)\s*kj\b", text, re.I)
        if kj:
            number = parse_number(kj.group(1), thousands_ok=True)
            return None if number is None or number < 0 else number / KJ_PER_KCAL
    number, unit = _with_unit(value, True)
    if number is None or number < 0:
        return None
    return number / KJ_PER_KCAL if unit == "kj" else number


_GRAMS = {"": 1.0, "g": 1.0, "gr": 1.0, "gramm": 1.0, "gram": 1.0, "grams": 1.0, "mg": 0.001, "mcg": 1e-6, "µg": 1e-6, "μg": 1e-6, "ug": 1e-6}


def parse_grams(value, default_unit: str = "g") -> float | None:
    number, unit = _with_unit(value, default_unit == "mg")
    if number is None or number < 0:
        return None
    unit = unit or default_unit
    factor = _GRAMS.get(unit)
    return None if factor is None else number * factor


def parse_yield(value) -> tuple[float | None, bool]:
    """(portions, was_a_range) from `recipeYield`: 4, "4", "4 portions", "Serves 4", "4-6 servings", ["8", "8 servings"], a
    QuantitativeValue. None when there is no usable number (0 and more than MAX_PORTIONS count as none)."""
    if isinstance(value, dict):
        value = value.get("value", value.get("name"))
    candidates = value if isinstance(value, list) else [value]
    for item in candidates[:6]:
        if isinstance(item, bool) or item is None:
            continue
        if isinstance(item, (int, float)):
            number, ranged = finite(item), False
        elif isinstance(item, dict):
            number, ranged = parse_yield(item)
        elif isinstance(item, str):
            text = html.unescape(item)[:120]
            ranged = bool(re.search(r"\d\s*(?:-|–|to|bis)\s*\d", text))
            number = parse_number(text)
        else:
            continue
        if number is not None and 0 < number <= MAX_PORTIONS:
            return round(number, 2), ranged
    return None, False


GRAM_FIELDS = {
    "protein": "proteinContent", "carbs": "carbohydrateContent", "fat": "fatContent", "saturated_fat": "saturatedFatContent",
    "sugars": "sugarContent", "fiber": "fiberContent",
}


@dataclass
class Parsed:
    """What a page said, before it is interpreted: the nutrition values AS WRITTEN (per serving unless the person says otherwise)."""
    name: str
    portions: float | None
    portions_range: bool
    values: dict  # kcal, protein, carbs, fat, saturated_fat, sugars, fiber (g), salt (g), sodium (mg); missing = None
    serving_size: str
    ingredients: list[str] = field(default_factory=list)
    image: str | None = None  # the address of the picture the page names, as written (maybe relative); see `image_address`


def _image_text(value, depth: int = 0) -> str:
    """The first address in an `image` value: a text, a list of them, an `ImageObject` (`url`, `contentUrl`, `@id`)."""
    if isinstance(value, str):
        return value.strip()
    if depth < 3 and isinstance(value, list):
        for item in value[:6]:
            found = _image_text(item, depth + 1)
            if found:
                return found
    if depth < 3 and isinstance(value, dict):
        for key in ("url", "contentUrl", "@id"):
            found = _image_text(value.get(key), depth + 1)
            if found:
                return found
    return ""


def image_address(raw: str | None, page_url: str) -> str | None:
    """The absolute, checked address of the picture (a relative or protocol-relative one is resolved against the page), else None.
    Only what check_address lets through: http(s), standard ports, a host name; the fetch checks every station again."""
    if not raw or len(raw) > MAX_URL:
        return None
    try:
        address = check_address(urljoin(page_url, raw.strip()))[0]
    except (LinkRejected, ValueError):
        return None
    if page_url.lower().startswith("https://") and address.startswith("http://"):
        return None  # a picture over plain http from a page served over https: not fetched (it could be swapped on the way)
    return address


def parse_recipe(node: dict) -> Parsed:
    nutrition = node.get("nutrition")
    if isinstance(nutrition, list):
        nutrition = next((n for n in nutrition if isinstance(n, dict)), None)
    nutrition = nutrition if isinstance(nutrition, dict) else {}
    values: dict = {"kcal": parse_energy(nutrition["calories"]) if "calories" in nutrition else None}
    for key, name in GRAM_FIELDS.items():
        values[key] = parse_grams(nutrition[name]) if name in nutrition else None
    sodium = parse_grams(nutrition["sodiumContent"], "mg") if "sodiumContent" in nutrition else None  # grams here
    values["sodium"] = None if sodium is None else sodium * 1000.0
    salt = parse_grams(nutrition["saltContent"]) if "saltContent" in nutrition else None
    values["salt"] = salt if salt is not None else (sodium * SALT_PER_SODIUM if sodium is not None else None)
    portions, ranged = parse_yield(node.get("recipeYield", node.get("yield")))
    raw_lines = node.get("recipeIngredient", node.get("ingredients"))
    lines = raw_lines if isinstance(raw_lines, list) else [raw_lines] if isinstance(raw_lines, str) else []
    ingredients = [line for line in (clean_text(i, MAX_LINE) for i in lines[:MAX_INGREDIENTS]) if line]
    return Parsed(
        name=clean_text(node.get("name"), MAX_NAME), portions=portions, portions_range=ranged, values=values,
        serving_size=clean_text(nutrition.get("servingSize"), 60), ingredients=ingredients,
        image=_image_text(node.get("image", node.get("thumbnailUrl"))) or None,
    )


def parse_page(page: str) -> Parsed | None:
    """The recipe of a page: the first one that has nutrition values, else the first one. None without any `Recipe`."""
    recipes = find_recipes(json_ld_blocks(page))
    if not recipes:
        return None
    parsed = [parse_recipe(r) for r in recipes[:20]]
    return next((p for p in parsed if p.values["kcal"] is not None), parsed[0])


# ---- interpreting ----


@dataclass
class Interpreted:
    name: str
    portions: float | None
    per_portion: dict  # kcal, fat, saturated_fat, carbs, sugars, fiber, protein, salt (None = unknown)
    extra: dict  # sodium in mg per portion
    complete: bool
    warnings: list[str]
    blocked: str | None  # why it cannot be taken over as it is (the preview says it, the take-over refuses it)


def _scaled(values: dict, divisor: float) -> dict:
    return {k: None if v is None else v / divisor for k, v in values.items()}


def energy_estimate(v: dict) -> float | None:
    if any(v.get(k) is None for k in ("protein", "carbs", "fat")):
        return None
    return 4 * v["protein"] + 4 * v["carbs"] + 9 * v["fat"]


def interpret(parsed: Parsed, *, whole: bool = False, portions: float | None = None, name: str | None = None) -> Interpreted:
    """Values per portion from what the page said. `whole`: the page gave the values for the whole recipe, so they are divided
    by the portions. `portions` and `name` are the corrections of the person. Warning codes: no_portions, portions_range,
    energy_mismatch, maybe_whole, maybe_per_100, rounded_off. Blocked: no_name, no_energy, too_high, whole_needs_portions."""
    warnings: list[str] = []
    count = portions if portions is not None and 0 < portions <= MAX_PORTIONS else parsed.portions
    if portions is None:
        if parsed.portions is None:
            warnings.append("no_portions")
        elif parsed.portions_range:
            warnings.append("portions_range")
    chosen_name = clean_text(name, MAX_NAME) if name is not None else parsed.name
    values = {k: finite(v) for k, v in parsed.values.items()}
    blocked = None
    divisor = 1.0
    if whole:
        if count is None:
            blocked = "whole_needs_portions"
        else:
            divisor = count
    raw = _scaled({k: v for k, v in values.items()}, divisor)
    kcal = raw["kcal"]
    per = {k: raw.get(k) for k in ("kcal", "fat", "saturated_fat", "carbs", "sugars", "fiber", "protein", "salt")}
    for key in ("fat", "saturated_fat", "carbs", "sugars", "fiber", "protein", "salt"):
        if per[key] is not None and per[key] > MAX_GRAMS:
            per[key] = None  # not plausible for one portion: unknown, not a wrong number
            warnings.append("rounded_off")
    extra = {} if raw["sodium"] is None or raw["sodium"] > 40000 else {"sodium": round(raw["sodium"], 1)}
    per = {k: None if v is None else round(v, 2) for k, v in per.items()}
    per["kcal"] = None if kcal is None else round(kcal, 1)
    if not chosen_name:
        blocked = blocked or "no_name"
    if kcal is None:
        blocked = blocked or "no_energy"
    elif kcal > MAX_KCAL:
        blocked = blocked or "too_high"
    if kcal is not None and blocked != "too_high":
        estimate = energy_estimate(per)
        if estimate is not None and abs(kcal - estimate) > max(80.0, 0.35 * estimate):
            warnings.append("energy_mismatch")
        if not whole and (((count or 1) > 1 and kcal > 1500) or any((per[k] or 0) > 150 for k in ("carbs", "fat", "protein"))):
            warnings.append("maybe_whole")
        if re.search(r"\b100\s*(?:g|ml)\b", parsed.serving_size, re.I) and (count or 1) > 1:
            warnings.append("maybe_per_100")
    complete = all(per.get(k) is not None for k in ("kcal", "fat", "carbs", "protein"))
    return Interpreted(chosen_name, count, per, extra, complete, list(dict.fromkeys(warnings)), blocked)


def food_data(item: Interpreted, address: str, host_from: str | None = None) -> dict:
    """The food that stands for the recipe: the values of ONE portion, stored as 100 g (so 100 g = 1 portion in the diary). The
    brand carries the host after BRAND_PREFIX (the host of the page that answered, `host_from`; `address` is the one the person gave). No steps, pictures, descriptions or ingredient lines."""
    return {
        "name": item.name[:MAX_NAME],
        "brand": BRAND_PREFIX + host_label(host_from or address),
        "quantity": None,
        "serving_size": "1 portion",
        "serving_quantity": REFERENCE_AMOUNT,
        "unit": "g",
        "per_100": item.per_portion,
        "extra": item.extra,
        "complete": item.complete,
        "portions": item.portions,
        "url": address,
    }


# ---- remembering what was fetched for a few minutes ----


class Cache:
    """What a page gave, for a few minutes: the preview, the switch "whole recipe" and the take-over of the same address
    need one fetch, not three. Shared by everybody (it is a public page), small and bounded."""

    def __init__(self, clock: Callable[[], float] = time.time, ttl: float = 300.0, size: int = 64):
        self.clock, self.ttl, self.size = clock, ttl, size
        self._items: dict[str, tuple[float, Parsed | None, str]] = {}
        self._lock = threading.Lock()

    def get(self, key: str):
        with self._lock:
            hit = self._items.get(key)
            if hit and hit[0] > self.clock():
                return hit[1], hit[2]
            self._items.pop(key, None)
        return None

    def put(self, key: str, parsed: Parsed | None, address: str) -> None:
        with self._lock:
            if len(self._items) >= self.size:
                self._items.pop(min(self._items, key=lambda k: self._items[k][0]), None)
            self._items[key] = (self.clock() + self.ttl, parsed, address)

    def drop(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

"""Sign-in through an OpenID Connect provider (MAHLWERK_AUTH=oidc): configuration, the provider client and the checks of
the ID token. The routes are in routes/oidc.py.

The flow is the Authorization Code Flow with PKCE (S256), with `state` and `nonce`.

About the signature of the ID token (SECURITY.md has the long version): it is NOT verified, on purpose and as the
standard allows. OpenID Connect Core 3.1.3.7 step 6: when the ID token is received directly from the token endpoint over
TLS, "the TLS server validation MAY be used to validate the issuer in place of checking the token signature". That is
exactly this code: the token arrives in the response of our own HTTPS request to the token endpoint that the provider's
discovery document (also fetched over HTTPS from the configured issuer) names. No other party ever hands us a token.
Everything else in 3.1.3.7 IS checked: iss, aud (and azp), exp, iat, nonce, and the presence of sub. The price: whoever
can terminate or forge TLS to the provider can forge identities, and the check fails open if the issuer is `http`
(MAHLWERK_OIDC_ALLOW_HTTP, for tests and localhost only). No JWT library and no key fetching are needed.
"""

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import httpx

CALLBACK_PATH = "/api/v1/auth/oidc/callback"
DEFAULT_SCOPES = "openid profile groups"
DISCOVERY_TTL = 3600
STALE_MAX = 86400  # a failed refresh may keep using the cached document for this long
MAX_BODY = 256 * 1024
PENDING_TTL = 600
TOTAL_DEADLINE = 10.0  # seconds for one request to the provider, however slowly the bytes trickle in
DISCOVERY_PAUSE = 60  # after a failed discovery fetch nobody tries again for this long
RATE_LIMIT = 30  # login and callback requests per address and minute, each
RATE_WINDOW = 60
RATE_MAX_KEYS = 20000
CLOCK_SKEW = 60  # seconds of tolerance for exp, iat and nbf
IAT_MAX_AGE = 600  # a token issued longer ago than this is not the answer to the request we just made
USERNAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$")  # checked on the RAW value, lower-cased only afterwards
TRUE = ("1", "true", "yes")


class OidcError(Exception):
    """A sign-in that must end. `code` is shown to the browser (a fixed word); `detail` goes to the log only and never
    contains tokens, codes, secrets or claim values."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in TRUE


def is_loopback(host: str) -> bool:
    host = host.strip("[]").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_url(value: str, allow_http: bool) -> bool:
    """An https URL with a host, no user info, no fragment. With `allow_http` (MAHLWERK_OIDC_ALLOW_HTTP) plain http is
    accepted for loopback hosts only (localhost, 127.0.0.0/8, ::1): nothing else may ever travel unencrypted."""
    try:
        parsed = urlparse(value)
        parsed.port  # noqa: B018  (raises for a bad port)
    except ValueError:
        return False
    if not parsed.hostname or "@" in parsed.netloc or parsed.fragment:
        return False
    return parsed.scheme == "https" or (allow_http and parsed.scheme == "http" and is_loopback(parsed.hostname))


@dataclass(frozen=True)
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str = field(default="", repr=False)  # never printed: not in repr, not in logs, not in answers
    client_auth: str = "basic"
    scopes: str = DEFAULT_SCOPES
    scopes_given: bool = False
    username_claim: str = "preferred_username"
    name_claim: str = "name"
    groups_claim: str = "groups"
    admin_group: str = "admin"
    redirect_url: str = ""
    home_path: str = "/"
    button_label: str = ""
    link_existing: bool = False
    allow_http: bool = False

    @classmethod
    def from_env(cls, admin_group: str) -> "OidcConfig":
        """Read and check the settings; ValueError (naming the variable, never a value) if something is missing or wrong,
        so that a half configured server does not start."""
        env = os.environ.get
        allow_http = _flag("MAHLWERK_OIDC_ALLOW_HTTP")
        issuer = env("MAHLWERK_OIDC_ISSUER", "").strip()
        client_id = env("MAHLWERK_OIDC_CLIENT_ID", "").strip()
        public = env("MAHLWERK_PUBLIC_URL", "").strip()
        redirect = env("MAHLWERK_OIDC_REDIRECT_URL", "").strip()
        missing = [name for name, value in (("MAHLWERK_OIDC_ISSUER", issuer), ("MAHLWERK_OIDC_CLIENT_ID", client_id)) if not value]
        if not redirect and not public:
            missing.append("MAHLWERK_PUBLIC_URL (or MAHLWERK_OIDC_REDIRECT_URL)")
        if missing:
            raise ValueError("MAHLWERK_AUTH=oidc needs " + ", ".join(missing))
        scheme = "https" if not allow_http else "https (or http on loopback)"
        if not _is_url(issuer, allow_http) or urlparse(issuer).query:
            raise ValueError(f"MAHLWERK_OIDC_ISSUER must be a {scheme} URL without query or fragment (http only on loopback and only with MAHLWERK_OIDC_ALLOW_HTTP=1)")
        home = "/"
        if not redirect:
            if not _is_url(public, allow_http) or urlparse(public).query:
                raise ValueError(f"MAHLWERK_PUBLIC_URL must be a {scheme} URL (http only on loopback and only with MAHLWERK_OIDC_ALLOW_HTTP=1)")
            base = public.rstrip("/")
            redirect = base + CALLBACK_PATH
            home = (urlparse(public).path.rstrip("/") or "") + "/"
        elif not _is_url(redirect, allow_http) or urlparse(redirect).query:
            raise ValueError(f"MAHLWERK_OIDC_REDIRECT_URL must be a {scheme} URL (http only on loopback and only with MAHLWERK_OIDC_ALLOW_HTTP=1)")
        elif redirect.endswith(CALLBACK_PATH):
            home = (urlparse(redirect).path[: -len(CALLBACK_PATH)].rstrip("/") or "") + "/"
        method = env("MAHLWERK_OIDC_CLIENT_AUTH", "basic").strip().lower()
        if method not in ("basic", "post"):
            raise ValueError("MAHLWERK_OIDC_CLIENT_AUTH must be 'basic' or 'post'")
        label = "".join(ch for ch in env("MAHLWERK_OIDC_BUTTON_LABEL", "").strip() if ch.isprintable())[:60]
        scopes_raw = " ".join(env("MAHLWERK_OIDC_SCOPES", "").replace(",", " ").split())
        scopes = scopes_raw or DEFAULT_SCOPES
        if "openid" not in scopes.split():
            raise ValueError("MAHLWERK_OIDC_SCOPES must contain 'openid'")
        return cls(
            issuer=issuer, client_id=client_id, client_secret=env("MAHLWERK_OIDC_CLIENT_SECRET", "").strip(), client_auth=method,
            scopes=scopes, scopes_given=bool(scopes_raw),
            username_claim=env("MAHLWERK_OIDC_USERNAME_CLAIM", "").strip() or "preferred_username",
            name_claim=env("MAHLWERK_OIDC_NAME_CLAIM", "").strip() or "name",
            groups_claim=env("MAHLWERK_OIDC_GROUPS_CLAIM", "").strip() or "groups",
            admin_group=admin_group, redirect_url=redirect, home_path=home, button_label=label,
            link_existing=_flag("MAHLWERK_OIDC_LINK_EXISTING"), allow_http=allow_http,
        )


def clean_username(value: object) -> str | None:
    """The user name from the claim, normalised like the local mode does (lower case, a-z 0-9 . _ -, up to 40), or None."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    # ASCII and the pattern on the raw value first: lower() on "K" (Kelvin sign) gives a plain "k", and a name must not
    # become something else than what the provider sent
    if not value.isascii() or not USERNAME.match(value):
        return None
    return value.lower()


def clean_display(value: object, fallback: str) -> str:
    if isinstance(value, str):
        value = "".join(ch for ch in value.strip() if ch.isprintable())[:80].strip()
        if value:
            return value
    return fallback


def groups_of(value: object) -> set[str]:
    """Group names from the claim: a list of strings (or one string)."""
    if isinstance(value, str):
        return {value} if value else set()
    if isinstance(value, list):
        return {item for item in value if isinstance(item, str) and item}
    return set()


def pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")


def safe_next(value: str | None, home_path: str = "/") -> str:
    """Where to go after the sign-in: only a plain path on this site, anything else becomes the start page. Refused:
    other hosts or schemes (`//host`, `/\\host`, `https:`), control characters, and an over-long value."""
    if not value or len(value) > 300 or not value.startswith("/") or value.startswith("//") or "\\" in value or value.startswith("/api"):
        return home_path
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return home_path
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc:
        return home_path
    return value


def _json_segment(segment: str) -> dict:
    try:
        raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
        data = json.loads(raw)
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise OidcError("failed", "id token is not a JWT") from exc
    if not isinstance(data, dict):
        raise OidcError("failed", "id token is not a JWT")
    return data


def _number(value: object) -> float | None:
    """A finite number, else None: no bool, no NaN or Infinity, no integer too big for a float."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def check_id_token(token: str, *, issuer: str, client_id: str, nonce: str, now: float) -> dict:
    """The claims of an ID token received from the token endpoint over TLS, after the checks of OpenID Connect Core
    3.1.3.7 except the signature (see the module text). Raises OidcError."""
    parts = token.split(".")
    if len(parts) != 3:
        raise OidcError("failed", "id token is not a JWT")
    _json_segment(parts[0])  # the header must at least be JSON
    claims = _json_segment(parts[1])
    if claims.get("iss") != issuer:
        raise OidcError("failed", "id token: wrong issuer")
    aud = claims.get("aud")
    audiences = [aud] if isinstance(aud, str) else aud if isinstance(aud, list) and all(isinstance(a, str) for a in aud) else []
    if client_id not in audiences:
        raise OidcError("failed", "id token: client is not in aud")
    azp = claims.get("azp")
    if (len(audiences) > 1 and azp is None) or (azp is not None and azp != client_id):
        raise OidcError("failed", "id token: azp does not match")
    exp, iat, nbf = _number(claims.get("exp")), _number(claims.get("iat")), _number(claims.get("nbf"))
    if exp is None or exp + CLOCK_SKEW <= now:
        raise OidcError("failed", "id token: expired or no exp")
    if iat is None or iat > now + CLOCK_SKEW or iat < now - IAT_MAX_AGE:
        raise OidcError("failed", "id token: iat is not recent")
    if "nbf" in claims and (nbf is None or nbf > now + CLOCK_SKEW):
        raise OidcError("failed", "id token: not yet valid")
    got = claims.get("nonce")
    if not isinstance(got, str) or not hmac.compare_digest(got.encode(), nonce.encode()):
        raise OidcError("failed", "id token: nonce differs")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or len(sub) > 255:
        raise OidcError("failed", "id token: no usable sub")
    return claims


@dataclass
class Pending:
    state: str
    nonce: str
    verifier: str
    next: str


def seal_login(key: bytes, pending: Pending, now: float) -> str:
    """The pending sign-in as ONE cookie value: the data, the expiry and an HMAC-SHA256 over both. Nothing is kept on the
    server, so strangers cannot push other people's sign-ins out of a table, and several workers or a restart do not matter.
    The content is signed, not encrypted: it is an HttpOnly cookie that only this browser sends back (Secure behind HTTPS)."""
    body = b64url(json.dumps({"s": pending.state, "n": pending.nonce, "v": pending.verifier, "x": pending.next, "e": int(now) + PENDING_TTL},
                             separators=(",", ":")).encode())
    return body + "." + b64url(hmac.new(key, body.encode(), hashlib.sha256).digest())


def open_login(key: bytes, value: str, now: float) -> Pending | None:
    """The pending sign-in in a cookie value, or None when the signature or the data is wrong or the 10 minutes are over
    (decided from the signed expiry, on the server's clock).

    Single use is NOT enforced here: the cookie is deleted by the callback's answer, and the real guard is the provider, which
    accepts an authorization code once. A copy of the cookie replayed with the same code finds the code spent. The state in the
    URL must equal the one in the cookie, which binds the answer to the browser that started the sign-in (login CSRF)."""
    body, _, mac = value.partition(".")
    if not body or not mac or len(value) > 4000:
        return None
    expected = b64url(hmac.new(key, body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(mac.encode(), expected.encode()):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if data["e"] <= now:
            return None
        return Pending(str(data["s"]), str(data["n"]), str(data["v"]), str(data["x"]))
    except (ValueError, KeyError, TypeError, binascii.Error):
        return None


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class RateLimit:
    """At most `limit` requests per key within `window` seconds (sliding), in memory: keeps one address from making the
    server call the provider without end. A restart forgets it, which is fine for this purpose."""

    def __init__(self, clock: Callable[[], float] = time.time, limit: int = RATE_LIMIT, window: int = RATE_WINDOW):
        self.clock, self.limit, self.window = clock, limit, window
        self._lock = threading.Lock()
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> int:
        """0 = go ahead (and counted), else the seconds to wait."""
        now = self.clock()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if t > now - self.window]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                return max(1, int(hits[0] + self.window - now) + 1)
            hits.append(now)
            self._hits[key] = hits
            if len(self._hits) > RATE_MAX_KEYS:
                for k in [k for k, v in self._hits.items() if not v or v[-1] <= now - self.window]:
                    del self._hits[k]
            return 0


class OidcClient:
    """Talks to the provider: discovery (cached), authorization URL, code exchange, userinfo. Never follows redirects, has
    time limits (per read and a hard total per request) and reads at most MAX_BODY bytes of an answer.

    `trust_env` stays at httpx's default on purpose: the proxy variables (HTTPS_PROXY ...) and SSL_CERT_FILE / SSL_CERT_DIR
    are honoured, which is how a provider with its own certificate authority is made trusted (README)."""

    def __init__(self, config: OidcConfig, transport: httpx.BaseTransport | None = None, clock: Callable[[], float] = time.time,
                 monotonic: Callable[[], float] = time.monotonic):
        self.config = config
        self.clock = clock
        self.monotonic = monotonic
        self._http = httpx.Client(transport=transport, timeout=httpx.Timeout(8.0, connect=5.0), follow_redirects=False,
                                  headers={"Accept": "application/json", "User-Agent": "Mahlwerk"})
        self._state = threading.Lock()  # guards the fields below, never held during a network call
        self._fetching = threading.Lock()  # one discovery fetch at a time
        self._doc: dict | None = None
        self._fetched = 0.0
        self._retry_at = 0.0

    def close(self) -> None:
        self._http.close()

    # -- transport helpers ---------------------------------------------------------------------------------------

    def _read_json(self, method: str, url: str, what: str, **kwargs) -> dict:
        started = self.monotonic()
        try:
            with self._http.stream(method, url, **kwargs) as response:
                if response.status_code != 200:
                    raise OidcError("failed", f"{what}: HTTP {response.status_code}")
                if "json" not in response.headers.get("content-type", "").lower():
                    raise OidcError("failed", f"{what}: not JSON")
                body = b""
                for chunk in response.iter_bytes():
                    body += chunk
                    if len(body) > MAX_BODY:
                        raise OidcError("failed", f"{what}: answer too large")
                    if self.monotonic() - started > TOTAL_DEADLINE:  # a provider that drips bytes cannot hold a worker
                        raise OidcError("failed", f"{what}: took longer than {TOTAL_DEADLINE:g} s")
        except httpx.HTTPError as exc:
            raise OidcError("failed", f"{what}: {type(exc).__name__}") from None  # the exception text is not logged: it could carry a URL
        if self.monotonic() - started > TOTAL_DEADLINE:
            raise OidcError("failed", f"{what}: took longer than {TOTAL_DEADLINE:g} s")
        try:
            data = json.loads(body)
        except ValueError:
            raise OidcError("failed", f"{what}: not JSON") from None
        if not isinstance(data, dict):
            raise OidcError("failed", f"{what}: unexpected JSON")
        return data

    def _url_ok(self, value: object) -> bool:
        # an https issuer never has http endpoints; plain http (loopback only) exists only for an http issuer in the test setup
        return isinstance(value, str) and _is_url(value, self.config.allow_http and self.config.issuer.startswith("http://"))

    # -- discovery -----------------------------------------------------------------------------------------------

    def discovery(self) -> dict:
        """The provider's discovery document, cached for an hour. The issuer inside must be exactly the configured one and
        the endpoints must be https (unless MAHLWERK_OIDC_ALLOW_HTTP on loopback).

        Nobody waits for the provider here: only one request refreshes at a time, the others get the cached copy (up to a
        day old) or an immediate error. After a failed fetch nobody tries again for a minute. So a provider that hangs costs
        one worker thread for at most the total deadline per minute, not the whole service."""
        now = self.clock()
        with self._state:
            doc, age, paused = self._doc, now - self._fetched, now < self._retry_at
        if doc is not None and age < DISCOVERY_TTL:
            return doc
        stale = doc if doc is not None and age < STALE_MAX else None
        if paused or not self._fetching.acquire(blocking=False):
            if stale is not None:
                return stale
            raise OidcError("failed", "discovery: provider not reachable (pause after a failure, or a fetch is running)")
        try:
            try:
                fresh = self._fetch_discovery()
            except OidcError:
                with self._state:
                    self._retry_at = self.clock() + DISCOVERY_PAUSE
                if stale is not None:
                    return stale
                raise
            with self._state:
                self._doc, self._fetched, self._retry_at = fresh, self.clock(), 0.0
            return fresh
        finally:
            self._fetching.release()

    def _fetch_discovery(self) -> dict:
        url = self.config.issuer.rstrip("/") + "/.well-known/openid-configuration"
        doc = self._read_json("GET", url, "discovery")
        if doc.get("issuer") != self.config.issuer:
            raise OidcError("failed", "discovery: issuer differs from the configured one")
        for key in ("authorization_endpoint", "token_endpoint"):
            if not self._url_ok(doc.get(key)):
                raise OidcError("failed", f"discovery: {key} missing or not https")
        if doc.get("userinfo_endpoint") is not None and not self._url_ok(doc["userinfo_endpoint"]):
            raise OidcError("failed", "discovery: userinfo_endpoint not https")
        return doc

    # -- the flow ------------------------------------------------------------------------------------------------

    def scopes(self, doc: dict) -> str:
        """The scopes to ask for. Configured ones are used as they are. The default (openid profile groups) is cut down to
        what the provider lists in scopes_supported, because some providers answer an unknown scope with an error."""
        wanted = self.config.scopes.split()
        supported = doc.get("scopes_supported")
        if not self.config.scopes_given and isinstance(supported, list) and supported:
            wanted = [s for s in wanted if s == "openid" or s in supported]
        return " ".join(wanted)

    def authorization_url(self, state: str, nonce: str, challenge: str) -> str:
        doc = self.discovery()
        parsed = urlparse(doc["authorization_endpoint"])
        query = parse_qsl(parsed.query, keep_blank_values=True) + [
            ("response_type", "code"), ("client_id", self.config.client_id), ("redirect_uri", self.config.redirect_url),
            ("scope", self.scopes(doc)), ("state", state), ("nonce", nonce),
            ("code_challenge", challenge), ("code_challenge_method", "S256"),
        ]
        return urlunparse(parsed._replace(query=urlencode(query, quote_via=quote)))

    def exchange(self, code: str, verifier: str) -> dict:
        """Trade the code for the tokens at the token endpoint (PKCE verifier included). Returns the JSON answer."""
        doc = self.discovery()
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": self.config.redirect_url, "code_verifier": verifier}
        headers = {}
        config = self.config
        if config.client_secret and config.client_auth == "basic":
            # RFC 6749 2.3.1: id and secret are form-encoded before they are joined
            pair = f"{quote(config.client_id, safe='')}:{quote(config.client_secret, safe='')}"
            headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
        else:
            form["client_id"] = config.client_id
            if config.client_secret:
                form["client_secret"] = config.client_secret
        return self._read_json("POST", doc["token_endpoint"], "token endpoint", data=form, headers=headers)

    def userinfo(self, access_token: str) -> dict:
        doc = self.discovery()
        endpoint = doc.get("userinfo_endpoint")
        if not endpoint:
            return {}
        return self._read_json("GET", endpoint, "userinfo", headers={"Authorization": "Bearer " + access_token})

    def identity(self, code: str, verifier: str, nonce: str) -> dict:
        """The whole back half of the flow: exchange the code, check the ID token, complete the claims from userinfo when
        the ones we need are not in the token. Returns {sub, username, display_name, admin, issuer}; raises OidcError."""
        config = self.config
        tokens = self.exchange(code, verifier)
        id_token = tokens.get("id_token")
        if not isinstance(id_token, str) or not id_token:
            raise OidcError("failed", "token endpoint: no id_token")
        claims = check_id_token(id_token, issuer=config.issuer, client_id=config.client_id, nonce=nonce, now=self.clock())
        wanted = (config.username_claim, config.name_claim, config.groups_claim)
        access = tokens.get("access_token")
        if any(claims.get(name) is None for name in wanted) and isinstance(access, str) and access:
            extra = self.userinfo(access)
            if extra:
                if extra.get("sub") != claims["sub"]:
                    raise OidcError("failed", "userinfo: sub differs from the id token")
                for name in wanted:
                    if claims.get(name) is None and extra.get(name) is not None:
                        claims[name] = extra[name]
        username = clean_username(claims.get(config.username_claim))
        if username is None:
            raise OidcError("name", "no usable user name in the claims")
        display = clean_display(claims.get(config.name_claim), username)
        return {"issuer": config.issuer, "sub": claims["sub"], "username": username, "display_name": display,
                "admin": config.admin_group in groups_of(claims.get(config.groups_claim))}


def new_login() -> tuple[str, str, str, str]:
    """(state, nonce, PKCE verifier, challenge): all random, the verifier 86 characters (limit 43 to 128)."""
    verifier = secrets.token_urlsafe(64)
    return secrets.token_urlsafe(32), secrets.token_urlsafe(32), verifier, pkce_challenge(verifier)

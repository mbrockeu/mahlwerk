"""Response headers for every answer, the CSRF header, the host check and the request size limits."""

import base64
import hashlib
import ipaddress
import logging
import re
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import _bearer_token, _peer_is_trusted, normalize_host

log = logging.getLogger("mahlwerk.security")

CSRF_HEADER = "x-mahlwerk-request"
CSRF_VALUE = "1"
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S | re.I)

# Request body limits (bytes): everything is small JSON except the label photo, the photo of a recipe and the bulk Health upload. A realistic
# sync (400 days with up to 50 workouts a day of about 300 bytes each) stays below 6 MB, so 8 MB is the ceiling there.
LIMIT_DEFAULT = 1 * 1024 * 1024
LIMIT_UPLOAD = 8 * 1024 * 1024
LIMITS = {"/api/v1/label-scans": LIMIT_UPLOAD, "/api/v1/health/sync": LIMIT_UPLOAD}
# The Yazio export (days.json of a few years of entries) is big; this route has its own, larger limit (as sent: the
# browser packs large files with gzip first). Its decompressed size is limited again in yazio_stage.
LIMIT_YAZIO = 24 * 1024 * 1024
LIMIT_PREFIXES = {"/api/v1/me/yazio/files/": LIMIT_YAZIO}


PICTURE_PATH = re.compile(r"^/api/v1/foods/\d{1,12}/image$")  # an own photo for a recipe (the interface shrinks it first)


def limit_for(path: str) -> int:
    if path in LIMITS or PICTURE_PATH.match(path):
        return LIMITS.get(path, LIMIT_UPLOAD)
    return next((limit for prefix, limit in LIMIT_PREFIXES.items() if path.startswith(prefix)), LIMIT_DEFAULT)


def build_csp(web_dir: Path | None) -> str:
    """The Content-Security-Policy of the built interface.

    - scripts: our own files, `'wasm-unsafe-eval'` for the barcode reader (WebAssembly), and the SHA-256 of each inline
      script in index.html (the theme script that runs before the first paint). The hash is computed from the file that
      is actually served, so a rebuild needs no change here.
    - styles: `'unsafe-inline'` because Svelte sets style attributes and scoped style tags; no scripts can run through it.
    - images: self, `data:` (inline icons) and `blob:` (a photo taken for the label reader or a recipe). Recipe pictures are files
      of this server (`/api/v1/images/...`), never an address of a provider: nothing in the policy was widened for them.
    - the camera needs no source in the policy (getUserMedia is not governed by it); `blob:` media is allowed for streams.
    - no frames, no plugins, no base-tag tricks, forms only to ourselves; nothing is loaded from other hosts.
    """
    hashes = []
    index = web_dir / "index.html" if web_dir else None
    if index and index.is_file():
        for body in INLINE_SCRIPT.findall(index.read_text(encoding="utf-8")):
            if body.strip():
                hashes.append("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
    script = " ".join(["'self'", "'wasm-unsafe-eval'", *hashes])
    return "; ".join([
        "default-src 'self'",
        f"script-src {script}",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "font-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ])


SECURITY_HEADERS = (
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
    (b"x-frame-options", b"DENY"),
)


class BodyLimit:
    """Pure ASGI middleware: refuses a request body over the limit with 413 without reading it all. It checks
    Content-Length up front and counts the bytes of a streamed (chunked) body as they arrive."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in WRITE_METHODS or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        limit = limit_for(scope["path"])
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > limit:
                    return await self._refuse(send, limit)
            except ValueError:
                return await self._refuse(send, limit, status=400)
        seen = 0
        refused = False

        async def counting_receive():
            nonlocal seen, refused
            if refused:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    # answer now and tell the app the client is gone; FastAPI would turn an exception raised here into a
                    # 400 "error parsing the body". What the app sends afterwards is dropped.
                    refused = True
                    await self._refuse(send, limit)
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message):
            if not refused:
                await send(message)

        await self.app(scope, counting_receive, guarded_send)

    @staticmethod
    async def _refuse(send, limit: int, status: int = 413):
        body = ('{"detail":"request body too large (at most %d bytes)"}' % limit if status == 413 else '{"detail":"bad Content-Length"}').encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                                (b"connection", b"close"), *SECURITY_HEADERS]})
        await send({"type": "http.response.body", "body": body})


def _private_peer_with_forwarding(request: Request) -> bool:
    if request.client is None or "x-forwarded-for" not in request.headers:
        return False
    try:
        return ipaddress.ip_address(request.client.host).is_private
    except ValueError:
        return False


def install(app: FastAPI, csp: str) -> None:
    app.state.proxy_warned = False

    # CSRF: the session of the local mode lives in a cookie, which a foreign page could make the browser send. A request
    # that needs the custom header `X-Mahlwerk-Request` cannot be forged that way: a page on another site can only add
    # such a header through a cross-origin fetch, which the browser allows only after a CORS pre-flight, and this app
    # sends no CORS headers (no CORSMiddleware, no Access-Control-* anywhere), so the pre-flight fails. HTML forms cannot
    # set custom headers at all. SameSite=Lax on the cookie is a second layer. The header is required in ALL modes: in
    # `single` (no login at all) and `proxy` (browser credentials of the proxy) a foreign page could otherwise write
    # with the visitor's network position or proxy login. Access tokens are sent in the Authorization header, which a
    # foreign page cannot add either, and are not cookies: they are exempt.
    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        config = request.app.state.auth
        if (
            config.mode == "local" and not request.app.state.proxy_warned and _private_peer_with_forwarding(request)
            and not _peer_is_trusted(request, config.trusted)
        ):
            request.app.state.proxy_warned = True
            log.warning(
                "A request from a private address (%s) carries X-Forwarded-For but that address is not in "
                "MAHLWERK_TRUSTED_PROXIES. Behind a reverse proxy every visitor then shares one address for the "
                "login brake. List the proxy in MAHLWERK_TRUSTED_PROXIES.", request.client.host)
        if (
            config.allowed_hosts is not None and path != "/healthz"
            and normalize_host(request.headers.get("host", "")) not in config.allowed_hosts
        ):
            response = JSONResponse({"detail": "host not allowed: add the name you use to MAHLWERK_ALLOWED_HOSTS"}, status_code=421)
        elif (
            request.method in WRITE_METHODS
            and path.startswith("/api/")
            and _bearer_token(request) is None
            and request.headers.get(CSRF_HEADER) != CSRF_VALUE
        ):
            response = JSONResponse({"detail": "missing X-Mahlwerk-Request header"}, status_code=403)
        else:
            response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        if path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        else:
            response.headers.setdefault("Content-Security-Policy", csp)
        return response

    app.add_middleware(BodyLimit)  # added last = outermost: the body is never read for an oversized request

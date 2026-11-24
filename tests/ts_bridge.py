"""Runs the API tests against the TypeScript server instead of the Python app (MAHLWERK_TS=1).

Imported by conftest.py before anything else. It replaces `mahlwerk.main.create_app` and `fastapi.testclient.TestClient`
with stand-ins: `create_app` asks the test host (ts/server/testhost.ts) for a fresh app with the current MAHLWERK_*
environment and the given database file; `TestClient` is an httpx client that talks to that app and tells the host which
TCP peer to pretend (`client=(peer, port)`). A `clock` given to create_app is sent before each request.

Outgoing HTTP of the TS app never leaves the machine: a small HTTP server in a thread of this process (`_Bridge`) receives
every request the TS app wants to send, keyed by purpose (off, oidc, yazio, web, vision, webhook), and answers it with the mock
transport the test gave `create_app` (transport= is "off", the others by name; webhooks have none: the receivers of the tests
are real servers, so a webhook to 127.0.0.1 or ::1 is really sent, everything else fails to connect). DNS questions of the TS netguard are answered by `netguard.resolver`, which
conftest replaces by the fake resolver. Test-only: the production server has no such path.

Tests that reach into the Python internals (`app.state`, the Store, module functions) cannot run this way; the in-scope
list is ts/api_tests.txt.
"""

import asyncio
import atexit
import base64
import inspect
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("MAHLWERK_TS_NODE", "/opt/node22/bin/node")
_host: dict = {}


def _base() -> str:
    if "url" not in _host:
        proc = subprocess.Popen(
            [NODE, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/testhost.ts"],
            cwd=ROOT / "ts", stdout=subprocess.PIPE, text=True)
        port = proc.stdout.readline().strip()
        if not port.isdigit():
            proc.kill()
            raise RuntimeError(f"test host did not start: {port!r}")
        _host.update(proc=proc, url=f"http://127.0.0.1:{port}")
        atexit.register(proc.kill)
    return _host["url"]


_apps: dict[str, "RemoteApp"] = {}
_PURPOSE = {"off": "transport", "oidc": "oidc_transport", "yazio": "yazio_transport", "web": "web_transport",
            "vision": "vision_transport", "webhook": "webhook_transport"}


def _error_kind(exc: Exception) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, (httpx.ConnectError, OSError)):
        return "connect"
    return "other"


def _call_transport(transport, payload: dict) -> dict:
    url, headers, extensions = payload["url"], payload["headers"], {}
    if payload.get("address"):  # the app connects to the address it checked: a mock sees what a Python mock sees (the IP, the name in Host)
        from mahlwerk import netguard

        url, pinned, extensions = netguard.pinned_target(url, payload["address"])
        headers = {**headers, **pinned}
    request = httpx.Request(payload["method"], url, headers=headers, extensions=extensions,
                            content=base64.b64decode(payload["body"]) if payload["body"] else None)
    # (a MockTransport is both kinds: the sync way is used, unless its handler is an async function, as for Yazio)
    if not isinstance(transport, httpx.BaseTransport) or (isinstance(transport, httpx.MockTransport) and inspect.iscoroutinefunction(transport.handler)):
        async def run():
            response = await transport.handle_async_request(request)
            body = response.content if response.is_stream_consumed else b"".join([c async for c in response.aiter_raw()])
            return response, body
        response, body = asyncio.run(run())
    else:
        response = transport.handle_request(request)
        # the bytes as they were sent (a body with a content-encoding stays encoded: the app inflates it itself)
        body = response.content if response.is_stream_consumed else b"".join(response.iter_raw())
    headers: dict[str, str] = {}
    for key, value in response.headers.multi_items():
        headers[key.lower()] = f"{headers[key.lower()]}, {value}" if key.lower() in headers else value
    return {"status": response.status_code, "headers": headers, "body": base64.b64encode(body).decode()}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silent
        pass

    def do_POST(self):
        from mahlwerk import netguard

        parts = self.path.strip("/").split("/")
        payload = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        try:
            app = _apps[parts[-1]]
            if parts[0] == "dns":
                answer = {"addresses": list(netguard.resolver(payload["host"], payload["port"]))}
            else:
                transport = getattr(app, _PURPOSE[parts[1]], None)
                if transport is None and parts[1] == "webhook" and payload.get("address") in ("127.0.0.1", "::1"):
                    # Python's webhook sender has no mock either: the receivers of the tests are real servers on the loopback
                    # address, and only there (nothing else leaves the machine)
                    transport = httpx.HTTPTransport()
                answer = _call_transport(transport, payload) if transport is not None else {"error": "connect", "message": "no transport"}
        except Exception as exc:  # what a real network does: an error the caller maps (a mock that raises httpx errors)
            answer = {"error": _error_kind(exc), "message": f"{type(exc).__name__}: {exc}"[:200]}
        data = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _bridge() -> str:
    if "bridge" not in _host:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        _host["bridge"] = f"http://127.0.0.1:{server.server_address[1]}"
        atexit.register(server.shutdown)
    return _host["bridge"]


def _environment() -> dict:
    return {k: v for k, v in os.environ.items() if k.startswith("MAHLWERK_")}


class _State:
    """Only so that `app.state.x` gives a clear error instead of a confusing one."""

    def __getattr__(self, name):
        raise NotImplementedError(f"app.state.{name} is Python-internal; this test cannot run against the TS server")


class RemoteApp:
    def __init__(self, db_path=None, transport=None, *, clock=None, oidc_transport=None, yazio_transport=None,
                 web_transport=None, vision_transport=None, webhook_transport=None, password_cost=None, **_ignored):
        env = _environment()
        path = db_path or env.get("MAHLWERK_DB", "./data/mahlwerk.db")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        r = httpx.post(_base() + "/__test/app", json={"env": env, "db": str(path), "bridge": _bridge(),
                                                      "password_cost": list(password_cost) if password_cost else None}, timeout=30)
        if r.status_code == 400 and "startup_error" in r.json():  # the server refuses this configuration (Python: ValueError)
            raise ValueError(r.json()["startup_error"])
        r.raise_for_status()
        self.env = env
        self.id = r.json()["id"]
        self.transport, self.oidc_transport, self.yazio_transport = transport, oidc_transport, yazio_transport
        self.web_transport, self.vision_transport, self.webhook_transport = web_transport, vision_transport, webhook_transport
        self.last_env = json.dumps(env, sort_keys=True)
        _apps[self.id] = self
        self.clock = clock
        self.state = _State()


_TODAY_MODULES = ("diary", "activity", "admin", "insights", "profile", "demo_view", "export", "suggestions", "summary")


def _patched_today():
    """The day a test set by patching `today` in a route module (monkeypatch), as an ISO string; None when nothing is patched."""
    import importlib

    from mahlwerk.routes import diary

    original = diary._ts_original_today  # taken in install(), before any test could patch it
    days = set()
    for name in _TODAY_MODULES:
        fn = getattr(importlib.import_module(f"mahlwerk.routes.{name}"), "today", original)
        if fn is not original:
            days.add(fn().isoformat())
    return days.pop() if len(days) == 1 else None


class _ToHost(httpx.HTTPTransport):
    """Delivers to the test host but leaves the request as the client built it (cookies and redirects stay with
    "testserver"); the Host header keeps the name the app should see."""

    def __init__(self, app: "RemoteApp"):
        super().__init__()
        self.app = app

    def handle_request(self, request):
        # Python reads os.environ at the moment it needs a value, and tests change it after the app was made (monkeypatch):
        # the TS app gets the current MAHLWERK_* environment with every request that differs from the last one it saw.
        env = json.dumps({k: v for k, v in os.environ.items() if k.startswith("MAHLWERK_")}, sort_keys=True)
        if env != self.app.last_env:
            self.app.last_env = env
            request.headers["x-test-env"] = env
        if (day := _patched_today()) is not None:
            request.headers["x-test-today"] = day
        if self.app.clock is not None:
            httpx.post(f"{_base()}/__test/clock/{self.app.id}/{self.app.clock()}", timeout=10)
        env = _environment()
        if env != self.app.env:  # a test changed the environment after create_app (the features read it live, like os.environ)
            httpx.post(f"{_base()}/__test/env/{self.app.id}", json=env, timeout=10)
            self.app.env = env
        raw = {k: v for k, v in request.headers.items() if v != v.strip()}  # h11 refuses a value with blanks at the ends, Starlette's client sends it
        if raw:
            for k, v in raw.items():
                request.headers[k] = v.strip()
            request.headers["x-test-rawheaders"] = base64.b64encode(json.dumps(raw).encode()).decode()
        target = httpx.URL(_base())
        original = request.url
        request.headers["x-test-scheme"] = original.scheme  # the app decides on the Secure flag from it
        request.url = original.copy_with(scheme=target.scheme, host=target.host, port=target.port)
        try:
            return super().handle_request(request)
        finally:
            request.url = original  # cookies and redirects stay with the name the test used


class RemoteClient(httpx.Client):
    """The parts of Starlette's TestClient the tests use: base URL http://testserver, redirects followed, `client=` peer."""

    def __init__(self, app: RemoteApp, base_url="http://testserver", raise_server_exceptions=True, root_path="",
                 cookies=None, headers=None, follow_redirects=True, client=("testclient", 50000)):
        self.app = app
        hdrs = {"x-test-app": app.id, "x-test-peer": client[0], "user-agent": "testclient"}
        super().__init__(base_url=base_url, headers=hdrs, cookies=cookies, follow_redirects=follow_redirects,
                         transport=_ToHost(app), timeout=60)
        if headers:
            self.headers.update(headers)

    def __enter__(self):
        return self


def install() -> None:
    import fastapi.testclient
    import mahlwerk.main

    from mahlwerk.routes import diary

    diary._ts_original_today = diary.today
    mahlwerk.main.create_app = RemoteApp
    fastapi.testclient.TestClient = RemoteClient

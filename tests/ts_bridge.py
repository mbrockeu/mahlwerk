"""Runs the API tests against the TypeScript server instead of the Python app (MAHLWERK_TS=1).

Imported by conftest.py before anything else. It replaces `mahlwerk.main.create_app` and `fastapi.testclient.TestClient`
with stand-ins: `create_app` asks the test host (ts/server/testhost.ts) for a fresh app with the current MAHLWERK_*
environment and the given database file; `TestClient` is an httpx client that talks to that app and tells the host which
TCP peer to pretend (`client=(peer, port)`). A `clock` given to create_app is sent before each request. Mock transports
(OFF, OIDC, Yazio, web, vision) are not supported yet: tests that rely on them fail and are counted as open.

Tests that reach into the Python internals (`app.state`, the Store, module functions) cannot run this way; the in-scope
list is ts/api_tests.txt.
"""

import atexit
import os
import subprocess
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


class _State:
    """Only so that `app.state.x` gives a clear error instead of a confusing one."""

    def __getattr__(self, name):
        raise NotImplementedError(f"app.state.{name} is Python-internal; this test cannot run against the TS server")


class RemoteApp:
    def __init__(self, db_path=None, transport=None, *, clock=None, **_ignored):
        env = {k: v for k, v in os.environ.items() if k.startswith("MAHLWERK_")}
        path = db_path or env.get("MAHLWERK_DB", "./data/mahlwerk.db")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        r = httpx.post(_base() + "/__test/app", json={"env": env, "db": str(path)}, timeout=30)
        r.raise_for_status()
        self.id = r.json()["id"]
        self.clock = clock
        self.state = _State()


class _ToHost(httpx.HTTPTransport):
    """Delivers to the test host but leaves the request as the client built it (cookies and redirects stay with
    "testserver"); the Host header keeps the name the app should see."""

    def __init__(self, app: "RemoteApp"):
        super().__init__()
        self.app = app

    def handle_request(self, request):
        if self.app.clock is not None:
            httpx.post(f"{_base()}/__test/clock/{self.app.id}/{self.app.clock()}", timeout=10)
        target = httpx.URL(_base())
        request.url = request.url.copy_with(scheme=target.scheme, host=target.host, port=target.port)
        return super().handle_request(request)


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

    mahlwerk.main.create_app = RemoteApp
    fastapi.testclient.TestClient = RemoteClient

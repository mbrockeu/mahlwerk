import os
import socket

import httpx
import pytest
from fastapi.testclient import TestClient

from mahlwerk import netguard
from mahlwerk.main import create_app

NUTELLA = "3017620422003"
UNKNOWN = "4006381333931"
SHELL = "4068706059940"

PRODUCT = {
    "code": NUTELLA,
    "status": 1,
    "product": {
        "product_name": "Nutella",
        "brands": "Ferrero, Nutella",
        "serving_size": "15 g",
        "nutriments": {
            "energy-kcal_100g": 539,
            "fat_100g": 30.9,
            "carbohydrates_100g": 57.5,
            "proteins_100g": 6.3,
        },
    },
}


class Upstream:
    """Fake Open Food Facts that counts calls and can be switched to failing."""

    def __init__(self):
        self.calls = 0
        self.fail = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        assert request.headers["user-agent"].startswith("Mahlwerk/")
        if self.fail:
            return httpx.Response(503, text="unavailable")
        if request.url.path.endswith(SHELL):
            return httpx.Response(200, json={"status": 1, "product": {"completeness": 0.09}})
        if request.url.path.endswith(NUTELLA):
            return httpx.Response(200, json=PRODUCT)
        return httpx.Response(404, json={"status": 0})


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    for name in (
        "MAHLWERK_AUTH",
        "MAHLWERK_SINGLE_USER",
        "MAHLWERK_PROXY_USER_HEADER",
        "MAHLWERK_PROXY_NAME_HEADER",
        "MAHLWERK_TRUSTED_PROXIES",
        "MAHLWERK_CACHE_DAYS",
        "MAHLWERK_DEMO_DATA",
        "MAHLWERK_CATALOG_DB",
        "MAHLWERK_CATALOG_BLS_DB",
        "MAHLWERK_DB",
        "MAHLWERK_PROXY_GROUPS_HEADER",
        "MAHLWERK_ADMIN_GROUP",
        "MAHLWERK_TOKENS",
        "MAHLWERK_WEBHOOKS",
        "MAHLWERK_WEBHOOK_HOSTS",
        "MAHLWERK_OFF_LOOKUP",
        "MAHLWERK_OFF_COUNTRIES",
        "MAHLWERK_COOKIE_SECURE",
        "MAHLWERK_SETUP_TOKEN",
        "MAHLWERK_DOCS",
        "MAHLWERK_COOKIDOO",
        "MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS",
        "MAHLWERK_COOKIDOO_PERSONAL",
        "MAHLWERK_COOKIDOO_IMAGES",
        "MAHLWERK_WEB_RECIPES_IMAGES",
        "MAHLWERK_IMAGES_MAX_MB",
        "MAHLWERK_SECRET_KEY",
        "MAHLWERK_YAZIO_LOGIN",
        "MAHLWERK_VISION",
        "MAHLWERK_VISION_URL",
        "MAHLWERK_VISION_MODEL",
        "MAHLWERK_VISION_KEY",
        "MAHLWERK_VISION_PER_HOUR",
        "MAHLWERK_YAZIO_CLIENT_ID",
        "MAHLWERK_YAZIO_CLIENT_SECRET",
        "MAHLWERK_COOKIDOO_EMAIL",
        "MAHLWERK_COOKIDOO_PASSWORD",
        "MAHLWERK_COOKIDOO_COUNTRY",
        "MAHLWERK_COOKIDOO_LANGUAGE",
        "MAHLWERK_PUBLIC_URL",
        "MAHLWERK_SESSION_DAYS",
        "MAHLWERK_SESSION_MAX_DAYS",
        *(n for n in os.environ if n.startswith("MAHLWERK_OIDC_")),
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MAHLWERK_WEB_DIR", str(tmp_path / "no-web"))
    # the test client calls the app as "testserver"; the host check has its own tests
    monkeypatch.setenv("MAHLWERK_ALLOWED_HOSTS", "*")


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    """No test needs a network: names resolve to a public address, `internal.example` to a LAN one, `dual.example` to
    both, numeric hosts to themselves (like the system would)."""
    names = {"internal.example": ["10.0.0.7"], "dual.example": ["93.184.216.34", "10.0.0.7"], "v6.example": ["2606:2800:220:1::1"],
             "localhost": ["127.0.0.1", "::1"], "rebind.example": ["93.184.216.34"]}

    def resolver(host, port):
        if host in names:
            return names[host]
        try:  # numeric forms the way the system reads them: 0x7f000001, 2130706433, 127.1 are all 127.0.0.1
            return list(dict.fromkeys(i[4][0] for i in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, flags=socket.AI_NUMERICHOST)))
        except socket.gaierror:
            pass
        if host.endswith(".invalid"):
            raise socket.gaierror("no such host")
        return ["93.184.216.34"]

    monkeypatch.setattr(netguard, "resolver", resolver)


@pytest.fixture(autouse=True)
def csrf_header_by_default(monkeypatch):
    """The interface always sends X-Mahlwerk-Request; so do the test clients, unless a test removes it on purpose
    (`del client.headers["X-Mahlwerk-Request"]`)."""
    original = TestClient.__init__

    def init(self, *args, **kwargs):
        original(self, *args, **kwargs)
        self.headers.setdefault("X-Mahlwerk-Request", "1")

    monkeypatch.setattr(TestClient, "__init__", init)


@pytest.fixture
def upstream():
    return Upstream()


@pytest.fixture
def make_client(tmp_path, upstream):
    """Build clients on one shared database; `peer` sets the TCP address the app sees."""
    app = create_app(str(tmp_path / "test.db"), transport=httpx.MockTransport(upstream))

    def make(peer: str = "testclient", **headers) -> TestClient:
        return TestClient(app, client=(peer, 50000), headers=headers)

    return make


@pytest.fixture
def client(make_client):
    return make_client()


@pytest.fixture
def food(client):
    """An own food: 200 kcal, 10 g protein per 100 g."""
    body = {"name": "Oats", "brand": "Acme", "serving_size": "40 g",
            "per_100": {"kcal": 200, "protein": 10, "carbs": 30, "fat": 4, "sugars": 1}}
    return client.post("/api/v1/foods", json=body).json()


@pytest.fixture
def duo(monkeypatch, tmp_path):
    """Two users on one server (proxy mode) with demo data switched on: (ann, ben)."""
    monkeypatch.setenv("MAHLWERK_AUTH", "proxy")
    monkeypatch.setenv("MAHLWERK_TRUSTED_PROXIES", "10.0.0.5")
    monkeypatch.setenv("MAHLWERK_DEMO_DATA", "1")
    app = create_app(str(tmp_path / "duo.db"))
    return tuple(TestClient(app, client=("10.0.0.5", 1), headers={"Remote-User": name}) for name in ("ann", "ben"))


# What version 14 added (recipe pictures), to take a fresh database back to version 13.
DROP_V14 = ("DROP INDEX food_image_hash; ALTER TABLE food DROP COLUMN image_hash; ALTER TABLE food DROP COLUMN image_origin; "
            "ALTER TABLE food DROP COLUMN image_at; ALTER TABLE food DROP COLUMN image_url;")

# What version 13 added (recipe groups), to take a fresh database back to version 12 (after DROP_V14).
DROP_V13 = DROP_V14 + "DROP TRIGGER recipe_group_item_food_gone; DROP TABLE recipe_group; DROP TABLE recipe_group_item; DROP TABLE recipe_group_dismissed;"

# What version 12 added (stored secrets), to take a fresh database back to version 11 (after DROP_V13).
DROP_V12 = DROP_V13 + "DROP TABLE secret;"

# What version 11 added (provider identities of the oidc sign-in mode), to take a fresh database back to version 10.
DROP_V11 = DROP_V12 + "DROP TABLE oidc_identity;"

# What version 10 added (accounts of the local sign-in mode), to take a fresh database back to version 9 (after DROP_V11).
DROP_V10 = DROP_V11 + """
DROP TABLE auth_session;
ALTER TABLE user DROP COLUMN password_hash; ALTER TABLE user DROP COLUMN disabled; ALTER TABLE user DROP COLUMN local_admin;
"""

# What version 9 added, to take a fresh database back to version 8 in the migration tests (run it before older drops).
# It includes DROP_V10: the older migration tests start from a database that is back at version 8 or earlier.
DROP_V9 = DROP_V10 + """
DROP TABLE workout; DROP TABLE activity_day;
ALTER TABLE goal DROP COLUMN steps; ALTER TABLE weight DROP COLUMN health; ALTER TABLE water DROP COLUMN health;
"""


# --- local sign-in mode (shared by test_local_auth and test_hardening) ---

CSRF = {"X-Mahlwerk-Request": "1"}
PW = "correct horse battery"
PW2 = "another long passphrase"
COST = (16, 8, 1)  # tiny scrypt cost: only the tests may lower it (an argument of create_app, no environment variable)


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def local_app(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    return create_app(str(tmp_path / "local.db"), password_cost=COST, clock=clock)


@pytest.fixture
def browser(local_app):
    """Make a fresh client (its own cookie jar) that sends the CSRF header like the interface does."""
    def make(peer: str = "198.51.100.7", **headers) -> TestClient:
        return TestClient(local_app, client=(peer, 50000), headers={**CSRF, **headers})
    return make


@pytest.fixture
def admin(browser):
    c = browser()
    assert c.post("/api/v1/auth/setup", json={"username": "alex", "password": PW}).status_code == 201
    return c



"""Sign-in through an OpenID Connect provider (MAHLWERK_AUTH=oidc). The provider is a stand-in behind httpx.MockTransport:
no test needs a network, and the clock is injected."""

import base64
import hashlib
import json
import logging
import sqlite3
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import CSRF, DROP_V11
from mahlwerk.db import Store
from mahlwerk.main import create_app

SESSION = "__Host-mahlwerk_session"  # the cookie names over HTTPS (the test clients use the https public address)
PENDING = "__Host-mahlwerk_oidc"
ISSUER = "https://id.example.org"
PUBLIC = "https://mahlwerk.example.org"
SECRET = "s3cr3t-value-that-must-never-leak"
CALLBACK = "/api/v1/auth/oidc/callback"
LOGIN = "/api/v1/auth/oidc/login"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt(claims: dict) -> str:
    return b64(b'{"alg":"none"}') + "." + b64(json.dumps(claims).encode()) + "."  # unsigned: the signature is not checked


class Provider:
    """A tiny provider. `claims` are what the user has; `token_claims` override or add to the ID token; `userinfo` is what
    the userinfo endpoint answers. Every request is kept in `calls`."""

    def __init__(self, clock):
        self.clock = clock
        self.calls: list[httpx.Request] = []
        self.doc = {
            "issuer": ISSUER, "authorization_endpoint": ISSUER + "/authorize", "token_endpoint": ISSUER + "/token",
            "userinfo_endpoint": ISSUER + "/userinfo", "scopes_supported": ["openid", "profile", "email", "groups"],
        }
        self.sub = "sub-1"
        self.claims = {"preferred_username": "alex", "name": "Alex Example", "groups": ["family"]}
        self.in_token = True  # put the claims into the ID token (else only into userinfo)
        self.token_claims: dict = {}
        self.userinfo_claims: dict | None = None
        self.token_status = 200
        self.id_token_override: str | None = None
        self.codes: dict[str, dict] = {}
        self.discovery_status = 200

    def token_payload(self) -> dict:
        now = int(self.clock())
        return {"iss": ISSUER, "aud": "mahlwerk", "sub": self.sub, "iat": now, "exp": now + 300}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path
        if path == "/.well-known/openid-configuration":
            return httpx.Response(self.discovery_status, json=self.doc)
        if path == "/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            auth = self.codes.pop(form.get("code", ""), None)
            if self.token_status != 200 or auth is None:
                return httpx.Response(self.token_status if self.token_status != 200 else 400, json={"error": "invalid_grant", "error_description": SECRET})
            verifier = form.get("code_verifier", "")
            if b64(hashlib.sha256(verifier.encode()).digest()) != auth["challenge"]:
                return httpx.Response(400, json={"error": "invalid_grant"})
            claims = {**self.token_payload(), "nonce": auth["nonce"], **(self.claims if self.in_token else {}), **self.token_claims}
            claims = {k: v for k, v in claims.items() if v is not None}
            return httpx.Response(200, json={"token_type": "Bearer", "access_token": "at-1", "id_token": jwt(claims) if self.id_token_override is None else self.id_token_override})
        if path == "/userinfo":
            assert request.headers["authorization"] == "Bearer at-1"
            return httpx.Response(200, json=self.userinfo_claims if self.userinfo_claims is not None else {"sub": self.sub, **self.claims})
        return httpx.Response(404)

    def authorize(self, location: str) -> tuple[str, str]:
        """The user agrees: returns (code, state) for the callback."""
        query = {k: v[0] for k, v in parse_qs(urlparse(location).query).items()}
        code = "code-" + str(len(self.codes) + 1) + query["state"][:4]
        self.codes[code] = {"challenge": query["code_challenge"], "nonce": query["nonce"]}
        return code, query["state"]


@pytest.fixture
def idp(clock):
    return Provider(clock)


@pytest.fixture
def make_app(monkeypatch, tmp_path, clock, idp):
    def make(**env):
        settings = {"MAHLWERK_AUTH": "oidc", "MAHLWERK_OIDC_ISSUER": ISSUER, "MAHLWERK_OIDC_CLIENT_ID": "mahlwerk",
                    "MAHLWERK_PUBLIC_URL": PUBLIC, **env}
        for key, value in settings.items():
            monkeypatch.setenv(key, value)
        return create_app(str(tmp_path / "oidc.db"), clock=clock, oidc_transport=httpx.MockTransport(idp))
    return make


@pytest.fixture
def app(make_app):
    return make_app()


def browser(app) -> TestClient:
    return TestClient(app, base_url=PUBLIC, client=("198.51.100.7", 50000), headers=CSRF)


@pytest.fixture
def web(app):
    return browser(app)


def start(web, idp, **params) -> tuple[str, str]:
    r = web.get(LOGIN, params=params, follow_redirects=False)
    assert r.status_code == 302, r.text
    return idp.authorize(r.headers["location"])


def sign_in(web, idp, **params) -> httpx.Response:
    code, state = start(web, idp, **params)
    return web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False)


def ok(r: httpx.Response, to: str = "/") -> None:
    assert r.status_code == 303 and r.headers["location"] == to, (r.status_code, r.headers.get("location"))
    assert SESSION + "=" in r.headers.get("set-cookie", "")


def refused(r: httpx.Response, code: str) -> None:
    assert r.status_code == 303 and r.headers["location"] == "/?auth_error=" + code, r.headers.get("location")
    assert SESSION + "=" not in r.headers.get("set-cookie", "").replace(SESSION + '=""', "").replace(SESSION + "=;", "")


# --- the happy path ---------------------------------------------------------------------------------------------------


def test_sign_in_creates_the_user_and_a_session(web, idp):
    assert web.get("/api/v1/me").status_code == 401
    status = web.get("/api/v1/auth/status").json()
    assert status["mode"] == "oidc" and status["authenticated"] is False and status["oidc_label"] is None and status["setup_required"] is False
    ok(sign_in(web, idp))
    me = web.get("/api/v1/auth/status").json()
    assert me["authenticated"] is True and me["username"] == "alex" and me["display_name"] == "Alex Example" and me["is_admin"] is False
    assert web.post("/api/v1/diary", json={"day": "2026-01-02", "meal": "lunch", "name": "x", "kcal": 1}).status_code != 401
    cookie = web.cookies.jar
    assert any(c.name == SESSION and c.secure for c in cookie)


def test_authorization_request_has_pkce_state_nonce_and_the_configured_redirect(web, idp):
    r = web.get(LOGIN, follow_redirects=False)
    location = urlparse(r.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == ISSUER + "/authorize"
    q = {k: v[0] for k, v in parse_qs(location.query).items()}
    assert q["response_type"] == "code" and q["client_id"] == "mahlwerk" and q["code_challenge_method"] == "S256"
    assert q["redirect_uri"] == PUBLIC + CALLBACK and q["scope"] == "openid profile groups"
    assert len(q["state"]) >= 40 and len(q["nonce"]) >= 40 and len(q["code_challenge"]) == 43
    cookie = r.headers["set-cookie"].lower()
    assert cookie.startswith(PENDING.lower() + "=") and "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie and "max-age=600" in cookie and "path=/;" in cookie + ";" and "domain" not in cookie


def test_verifier_reaches_the_token_endpoint_and_matches_the_challenge(web, idp):
    ok(sign_in(web, idp))  # the stand-in provider refuses the code when verifier and challenge do not belong together
    token_call = next(c for c in idp.calls if c.url.path == "/token")
    form = parse_qs(token_call.content.decode())
    assert form["grant_type"] == ["authorization_code"] and form["redirect_uri"] == [PUBLIC + CALLBACK] and 43 <= len(form["code_verifier"][0]) <= 128


def test_public_client_sends_no_secret_and_only_the_client_id(web, idp):
    ok(sign_in(web, idp))
    call = next(c for c in idp.calls if c.url.path == "/token")
    assert "authorization" not in call.headers and parse_qs(call.content.decode())["client_id"] == ["mahlwerk"] and "client_secret" not in call.content.decode()


def test_client_secret_basic_by_default(make_app, idp):
    web = browser(make_app(MAHLWERK_OIDC_CLIENT_SECRET=SECRET))
    ok(sign_in(web, idp))
    call = next(c for c in idp.calls if c.url.path == "/token")
    assert call.headers["authorization"] == "Basic " + base64.b64encode(f"mahlwerk:{SECRET}".encode()).decode()
    assert SECRET not in call.content.decode()


def test_client_secret_post_when_asked(make_app, idp):
    web = browser(make_app(MAHLWERK_OIDC_CLIENT_SECRET=SECRET, MAHLWERK_OIDC_CLIENT_AUTH="post"))
    ok(sign_in(web, idp))
    call = next(c for c in idp.calls if c.url.path == "/token")
    form = parse_qs(call.content.decode())
    assert "authorization" not in call.headers and form["client_secret"] == [SECRET] and form["client_id"] == ["mahlwerk"]


def test_button_label_in_status(make_app):
    status = browser(make_app(MAHLWERK_OIDC_BUTTON_LABEL="Example ID")).get("/api/v1/auth/status").json()
    assert status["oidc_label"] == "Example ID"


def test_default_scopes_are_cut_to_what_the_provider_supports(web, idp, app):
    idp.doc["scopes_supported"] = ["openid", "profile", "email"]
    q = parse_qs(urlparse(web.get(LOGIN, follow_redirects=False).headers["location"]).query)
    assert q["scope"] == ["openid profile"]


def test_configured_scopes_are_sent_as_they_are(make_app, idp):
    web = browser(make_app(MAHLWERK_OIDC_SCOPES="openid profile roles"))
    idp.doc["scopes_supported"] = ["openid", "profile"]
    q = parse_qs(urlparse(web.get(LOGIN, follow_redirects=False).headers["location"]).query)
    assert q["scope"] == ["openid profile roles"]


def test_next_path_is_followed_after_sign_in(web, idp):
    ok(sign_in(web, idp, next="/history?x=1"), "/history?x=1")


@pytest.mark.parametrize("bad", ["https://evil.example", "//evil.example", "/\\evil.example", "evil", "/a\nb", "javascript:alert(1)", "/api/v1/me", "/" + "a" * 400])
def test_no_open_redirect(web, idp, bad):
    r = web.get(LOGIN, params={"next": bad}, follow_redirects=False)
    if r.status_code != 302:  # an over-long value is refused by the parameter check, which is fine too
        assert r.status_code == 422
        return
    code, state = idp.authorize(r.headers["location"])
    ok(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False))


# --- state, cookie, replay ----------------------------------------------------------------------------------------------


def test_wrong_state_is_refused_and_burns_the_pending_login(web, idp):
    code, state = start(web, idp)
    refused(web.get(CALLBACK, params={"code": code, "state": "x" * len(state)}, follow_redirects=False), "failed")
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")  # no second try


def test_missing_state_is_refused(web, idp):
    code, _ = start(web, idp)
    refused(web.get(CALLBACK, params={"code": code}, follow_redirects=False), "failed")


def test_state_is_single_use(web, idp):
    code, state = start(web, idp)
    ok(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False))
    again = browser(web.app)
    again.cookies.set(PENDING, web.cookies.get(PENDING) or "x")
    refused(again.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")


def test_pending_login_expires_after_ten_minutes(web, idp, clock):
    code, state = start(web, idp)
    clock.now += 601
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")


def test_login_csrf_the_victim_has_no_cookie_for_the_attackers_state(app, idp):
    attacker, victim = browser(app), browser(app)
    code, state = start(attacker, idp)  # the attacker signs in at the provider with their own account
    refused(victim.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")
    assert victim.get("/api/v1/auth/status").json()["authenticated"] is False


# --- the ID token ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("claims", [
    {"iss": "https://evil.example"}, {"iss": None}, {"aud": "other"}, {"aud": ["other"]}, {"aud": None},
    {"aud": ["mahlwerk", "other"]},  # several audiences without azp
    {"aud": ["mahlwerk", "other"], "azp": "other"}, {"azp": "other"},
    {"exp": 1}, {"exp": None}, {"exp": "soon"}, {"exp": True},
    {"iat": 1}, {"iat": None}, {"iat": 4_000_000_000}, {"nbf": 4_000_000_000},
    {"nonce": "other"}, {"nonce": None},
    {"sub": None}, {"sub": ""}, {"sub": 7}, {"sub": "x" * 300},
])
def test_bad_id_token_claims_are_refused(web, idp, claims):
    idp.token_claims = claims
    refused(sign_in(web, idp), "failed")
    assert web.get("/api/v1/auth/status").json()["authenticated"] is False


def test_several_audiences_with_matching_azp_pass(web, idp):
    idp.token_claims = {"aud": ["mahlwerk", "other"], "azp": "mahlwerk"}
    ok(sign_in(web, idp))


def test_small_clock_difference_is_tolerated(web, idp, clock):
    now = int(clock())
    idp.token_claims = {"iat": now + 30, "exp": now + 5}  # exp a few seconds ahead, iat slightly in the future
    ok(sign_in(web, idp))


def test_garbage_instead_of_an_id_token(web, idp):
    for bad in ("not-a-jwt", "a.b", "a.b.c", jwt({}) + ".x"):
        idp.id_token_override = bad
        refused(sign_in(web, idp), "failed")
    idp.id_token_override = b64(b"{}") + "." + b64(b"[]") + "."
    refused(sign_in(web, idp), "failed")


def test_no_id_token_in_the_answer(web, idp):
    idp.id_token_override = ""
    idp.token_claims = {}
    refused(sign_in(web, idp), "failed")


def test_unsigned_token_is_accepted_by_design_but_only_over_the_token_endpoint(web, idp):
    # the signature is not checked (OIDC Core 3.1.3.7: TLS validates the issuer); a token that did not come from the token
    # endpoint's answer has no way in: the callback takes a code only
    ok(sign_in(web, idp))
    r = browser(web.app).get(CALLBACK, params={"id_token": jwt(idp.token_payload()), "state": "x"}, follow_redirects=False)
    refused(r, "expired")


# --- the provider ---------------------------------------------------------------------------------------------------------


def test_discovery_with_another_issuer_is_refused(web, idp):
    idp.doc["issuer"] = "https://evil.example"
    r = web.get(LOGIN, follow_redirects=False)
    refused(r, "failed")


@pytest.mark.parametrize("key", ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"])
def test_discovery_with_http_endpoints_is_refused(web, idp, key):
    idp.doc[key] = "http://id.example.org/x"
    refused(web.get(LOGIN, follow_redirects=False), "failed")


def test_discovery_without_endpoints_is_refused(web, idp):
    del idp.doc["token_endpoint"]
    refused(web.get(LOGIN, follow_redirects=False), "failed")


def test_discovery_failure_and_cache(web, idp, clock):
    idp.discovery_status = 503
    refused(web.get(LOGIN, follow_redirects=False), "failed")
    idp.discovery_status = 200
    refused(web.get(LOGIN, follow_redirects=False), "failed")  # the pause after a failure: nobody asks the provider for a minute
    assert sum(c.url.path.endswith("openid-configuration") for c in idp.calls) == 1
    clock.now += 61
    ok(sign_in(web, idp))
    n = sum(c.url.path.endswith("openid-configuration") for c in idp.calls)
    web2 = browser(web.app)
    ok(sign_in(web2, idp))
    assert sum(c.url.path.endswith("openid-configuration") for c in idp.calls) == n  # cached
    clock.now += 3601
    idp.discovery_status = 503  # refresh fails: the cached copy keeps serving
    ok(sign_in(browser(web.app), idp))
    ok(sign_in(browser(web.app), idp))


def test_redirects_are_not_followed(app, idp):
    def redirecting(request):
        if request.url.path == "/token":
            return httpx.Response(302, headers={"location": "https://evil.example/steal"})
        return idp(request)
    web = browser(create_app(str(app.state.store.path) + "2", oidc_transport=httpx.MockTransport(redirecting), clock=app.state.clock))
    code, state = start(web, idp)
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "failed")


def test_oversized_answer_is_refused(app, idp):
    def huge(request):
        if request.url.path == "/token":
            return httpx.Response(200, content=b'{"id_token":"' + b"a" * 400_000 + b'"}', headers={"content-type": "application/json"})
        return idp(request)
    web = browser(create_app(str(app.state.store.path) + "2", oidc_transport=httpx.MockTransport(huge), clock=app.state.clock))
    code, state = start(web, idp)
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "failed")


def test_provider_error_goes_back_neutrally(web, idp):
    _, state = start(web, idp)
    r = web.get(CALLBACK, params={"error": "access_denied", "error_description": "<script>", "state": state}, follow_redirects=False)
    refused(r, "denied")


def test_provider_error_with_wrong_state_is_a_plain_failure(web, idp):
    start(web, idp)
    refused(web.get(CALLBACK, params={"error": "access_denied", "state": "nope"}, follow_redirects=False), "failed")


def test_token_endpoint_failure(web, idp):
    idp.token_status = 500
    refused(sign_in(web, idp), "failed")


def test_issuer_in_the_answer_must_match(web, idp):
    code, state = start(web, idp)
    refused(web.get(CALLBACK, params={"code": code, "state": state, "iss": "https://evil.example"}, follow_redirects=False), "failed")


def test_matching_iss_parameter_passes(web, idp):
    code, state = start(web, idp)
    ok(web.get(CALLBACK, params={"code": code, "state": state, "iss": ISSUER}, follow_redirects=False))


# --- claims ---------------------------------------------------------------------------------------------------------------


def test_missing_claims_come_from_userinfo(web, idp):
    idp.in_token = False
    ok(sign_in(web, idp))
    assert any(c.url.path == "/userinfo" for c in idp.calls)
    assert web.get("/api/v1/auth/status").json()["username"] == "alex"


def test_userinfo_is_not_asked_when_the_token_has_everything(web, idp):
    ok(sign_in(web, idp))
    assert not any(c.url.path == "/userinfo" for c in idp.calls)


def test_userinfo_with_another_sub_is_refused(web, idp):
    idp.in_token = False
    idp.userinfo_claims = {"sub": "someone-else", "preferred_username": "mallory", "groups": ["admin"]}
    refused(sign_in(web, idp), "failed")


def test_userinfo_without_sub_is_refused(web, idp):
    idp.in_token = False
    idp.userinfo_claims = {"preferred_username": "mallory"}
    refused(sign_in(web, idp), "failed")


def test_no_user_name_at_all(web, idp):
    idp.claims = {"name": "Nameless"}
    refused(sign_in(web, idp), "name")


@pytest.mark.parametrize("name", ["", " ", "a b", "x" * 41, "-alex", "al@ex", 7, ["alex"]])
def test_unusable_user_names_are_refused(web, idp, name):
    idp.claims = {"preferred_username": name}
    refused(sign_in(web, idp), "name")


def test_user_name_is_normalised_like_in_local_mode(web, idp):
    idp.claims = {"preferred_username": "  Alex.B_1 ", "name": "  "}
    ok(sign_in(web, idp))
    status = web.get("/api/v1/auth/status").json()
    assert status["username"] == "alex.b_1" and status["display_name"] == "alex.b_1"


def test_other_claim_names_are_configurable(make_app, idp):
    web = browser(make_app(MAHLWERK_OIDC_USERNAME_CLAIM="nick", MAHLWERK_OIDC_NAME_CLAIM="full", MAHLWERK_OIDC_GROUPS_CLAIM="roles", MAHLWERK_ADMIN_GROUP="boss"))
    idp.claims = {"nick": "kim", "full": "Kim Example", "roles": ["boss"]}
    ok(sign_in(web, idp))
    assert web.get("/api/v1/auth/status").json() == {
        "oidc_label": None, "mode": "oidc", "setup_required": False, "setup_code_required": False, "authenticated": True,
        "username": "kim", "display_name": "Kim Example", "is_admin": True}


# --- who is who ---------------------------------------------------------------------------------------------------------


def test_the_same_sub_is_the_same_account_even_when_the_name_changes(app, web, idp):
    ok(sign_in(web, idp))
    first = web.get("/api/v1/me").json()
    web.post("/api/v1/water/2026-01-02", json={"add_ml": 250})
    idp.claims = {"preferred_username": "alex2", "name": "Alexandra"}
    other = browser(app)
    ok(sign_in(other, idp))
    status = other.get("/api/v1/auth/status").json()
    assert status["username"] == "alex" and status["display_name"] == "Alexandra"  # the name stays, the display name follows
    assert other.get("/api/v1/me").json()["username"] == first["username"]
    assert other.get("/api/v1/diary/2026-01-02").json()["water"]["ml"] == 250


def test_name_of_another_identity_is_a_conflict(app, web, idp):
    ok(sign_in(web, idp))
    idp.sub = "sub-2"  # somebody else now carries the name alex at the provider
    refused(sign_in(browser(app), idp), "conflict")
    assert app.state.store.admin_counts()["users"] == 1


def test_existing_user_is_not_taken_over_by_default(make_app, idp):
    app = make_app()
    app.state.store.get_or_create_user("alex", "Alex")  # data of an earlier proxy or single installation
    web = browser(app)
    refused(sign_in(web, idp), "exists")
    assert app.state.store.admin_counts()["users"] == 1


def test_existing_user_is_linked_when_switched_on(make_app, idp):
    app = make_app(MAHLWERK_OIDC_LINK_EXISTING="1")
    old = app.state.store.get_or_create_user("Alex", "Alex")  # the case does not matter
    app.state.store.set_goal(old["id"], {"kcal": 2000, "protein": 100, "carbs": 200, "fat": 60})
    web = browser(app)
    ok(sign_in(web, idp))
    assert app.state.store.admin_counts()["users"] == 1
    assert web.get("/api/v1/me").json()["goal"]["kcal"] == 2000
    idp.claims = {"preferred_username": "someone", "name": "x"}
    ok(sign_in(browser(app), idp))  # known identity: the link counts, not the name
    assert app.state.store.admin_counts()["users"] == 1


@pytest.mark.parametrize("link", ["", "1"])
def test_the_reserved_name_of_the_demo_account_is_never_signed_in(make_app, idp, link):
    app = make_app(MAHLWERK_OIDC_LINK_EXISTING=link) if link else make_app()
    idp.claims = {"preferred_username": "~demo", "name": "Demo", "groups": ["admin"]}
    web = browser(app)
    refused(sign_in(web, idp), "name")
    assert web.get("/api/v1/me").status_code == 401
    # also a demo account that exists (an admin switched it on) is not linkable by a provider user of that name
    store = app.state.store
    user_id, _ = store.create_demo_user()
    refused(sign_in(browser(app), idp), "name")
    assert store.admin_counts()["users"] == 0 and store.local_user("~demo")["id"] == user_id
    assert app.state.store.local_user("~demo")["password_hash"] is None


def test_linking_does_not_take_a_user_that_has_another_identity(make_app, idp):
    app = make_app(MAHLWERK_OIDC_LINK_EXISTING="1")
    ok(sign_in(browser(app), idp))
    idp.sub = "sub-2"
    refused(sign_in(browser(app), idp), "conflict")


def test_admin_follows_the_group_at_every_sign_in(app, idp):
    idp.claims = {"preferred_username": "alex", "groups": ["admin", "family"]}
    web = browser(app)
    ok(sign_in(web, idp))
    assert web.get("/api/v1/auth/status").json()["is_admin"] is True
    assert web.get("/api/v1/admin/overview").json()["auth_mode"] == "oidc"
    idp.claims = {"preferred_username": "alex", "groups": ["family"]}
    ok(sign_in(web, idp))  # signing in again takes the right away
    assert web.get("/api/v1/auth/status").json()["is_admin"] is False
    assert web.get("/api/v1/admin/overview").status_code == 403
    idp.claims = {"preferred_username": "alex"}  # no groups claim at all: no admin
    ok(sign_in(web, idp))
    assert web.get("/api/v1/admin/overview").status_code == 403


def test_admin_group_is_configurable(make_app, idp):
    web = browser(make_app(MAHLWERK_ADMIN_GROUP="mahlwerk-admins"))
    idp.claims = {"preferred_username": "alex", "groups": ["admin", "mahlwerk-admins"]}
    ok(sign_in(web, idp))
    assert web.get("/api/v1/auth/status").json()["is_admin"] is True


def test_groups_claim_as_a_single_string(web, idp):
    idp.claims = {"preferred_username": "alex", "groups": "admin"}
    ok(sign_in(web, idp))
    assert web.get("/api/v1/auth/status").json()["is_admin"] is True


def test_admin_blocks_and_unblocks_a_user(app, idp):
    boss = browser(app)
    idp.claims = {"preferred_username": "boss", "groups": ["admin"]}
    ok(sign_in(boss, idp))
    idp.sub, idp.claims = "sub-2", {"preferred_username": "sam", "name": "Sam"}
    sam = browser(app)
    ok(sign_in(sam, idp))
    assert sam.get("/api/v1/me").status_code == 200
    users = {u["username"]: u for u in boss.get("/api/v1/admin/users").json()}
    assert users["sam"]["sso"] is True and users["sam"]["has_password"] is False
    assert boss.patch("/api/v1/admin/users/sam", json={"disabled": True}).status_code == 200
    assert sam.get("/api/v1/me").status_code == 401  # the session ended with the block
    refused(sign_in(browser(app), idp), "blocked")
    assert boss.patch("/api/v1/admin/users/sam", json={"disabled": False}).status_code == 200
    ok(sign_in(browser(app), idp))


def test_admin_right_and_self_block_cannot_be_set_by_hand(app, idp):
    boss = browser(app)
    idp.claims = {"preferred_username": "boss", "groups": ["admin"]}
    ok(sign_in(boss, idp))
    assert boss.patch("/api/v1/admin/users/boss", json={"disabled": True}).status_code == 409
    assert boss.patch("/api/v1/admin/users/boss", json={"is_admin": False}).status_code == 409


def test_non_admin_cannot_block(app, idp):
    web = browser(app)
    ok(sign_in(web, idp))
    assert web.patch("/api/v1/admin/users/alex", json={"disabled": True}).status_code == 403


# --- other modes' doors stay shut -----------------------------------------------------------------------------------------


def test_password_endpoints_answer_404(web, idp):
    idp.claims = {"preferred_username": "alex", "groups": ["admin"]}
    ok(sign_in(web, idp))
    assert web.post("/api/v1/auth/setup", json={"username": "x", "password": "correct horse battery"}).status_code == 404
    assert web.post("/api/v1/auth/login", json={"username": "alex", "password": "correct horse battery"}).status_code == 404
    assert web.post("/api/v1/auth/password", json={"current_password": "a", "new_password": "correct horse battery"}).status_code == 404
    assert web.post("/api/v1/admin/users", json={"username": "x", "password": "correct horse battery"}).status_code == 404
    assert web.post("/api/v1/admin/users/alex/password", json={"password": "correct horse battery"}).status_code == 404


def test_oidc_endpoints_answer_404_in_other_modes(client):
    assert client.get(LOGIN, follow_redirects=False).status_code == 404
    assert client.get(CALLBACK, follow_redirects=False).status_code == 404


def test_remote_user_headers_are_ignored(app):
    web = TestClient(app, base_url=PUBLIC, client=("10.0.0.5", 1), headers={**CSRF, "Remote-User": "alex", "Remote-Groups": "admin"})
    assert web.get("/api/v1/me").status_code == 401
    assert web.get("/api/v1/auth/status").json()["authenticated"] is False
    assert web.get("/api/v1/admin/overview").status_code == 401


def test_sign_out_ends_the_session(web, idp):
    ok(sign_in(web, idp))
    token = web.cookies.get(SESSION)
    assert web.post("/api/v1/auth/logout").status_code == 204
    web.cookies.set(SESSION, token)  # the old cookie is worth nothing any more
    assert web.get("/api/v1/me").status_code == 401


def test_sign_out_needs_the_csrf_header(web, idp):
    ok(sign_in(web, idp))
    del web.headers["X-Mahlwerk-Request"]
    assert web.post("/api/v1/auth/logout").status_code == 403
    assert web.get("/api/v1/me").status_code == 200


def test_access_tokens_still_work(web, idp):
    ok(sign_in(web, idp))
    made = web.post("/api/v1/me/tokens", json={"name": "phone", "scope": "write"}).json()
    other = browser(web.app)
    assert other.get("/api/v1/me", headers={"Authorization": "Bearer " + made["token"]}).status_code == 200


def test_session_slides_and_ends(web, idp, clock):
    # the oidc defaults: 7 days sliding, 30 days at most (local mode keeps 30 and 180)
    assert "max-age=604800" in sign_in(web, idp).headers["set-cookie"].lower()
    for _ in range(4):
        clock.now += 6 * 86400
        assert web.get("/api/v1/me").status_code == 200  # used within a week: renewed
    clock.now += 8 * 86400  # 32 days after the sign-in: over the absolute limit although it was used all along
    assert web.get("/api/v1/me").status_code == 401
    ok(sign_in(browser(web.app), idp))
    clock.now += 8 * 86400
    assert web.get("/api/v1/me").status_code == 401  # a week of silence ends it


def test_session_days_are_configurable(make_app, idp, clock):
    web = browser(make_app(MAHLWERK_SESSION_DAYS="2", MAHLWERK_SESSION_MAX_DAYS="5"))
    ok(sign_in(web, idp))
    assert "max-age=172800" in sign_in(browser(web.app), idp).headers["set-cookie"].lower()
    for _ in range(4):
        clock.now += 86400
        assert web.get("/api/v1/me").status_code == 200
    clock.now += 86400  # day 5: over the absolute limit although it was used all along
    assert web.get("/api/v1/me").status_code == 401


# --- secrets stay secret -------------------------------------------------------------------------------------------------


def test_the_secret_is_in_no_answer_and_no_log(make_app, idp, caplog):
    app = make_app(MAHLWERK_OIDC_CLIENT_SECRET=SECRET)
    web = browser(app)
    caplog.set_level(logging.DEBUG)
    seen = []
    seen.append(web.get(LOGIN, follow_redirects=False))
    idp.token_status = 400  # the provider echoes the secret in its error text: must not reach us or the log
    seen.append(sign_in(web, idp))
    idp.token_status = 200
    seen.append(sign_in(web, idp))
    seen += [web.get("/api/v1/auth/status"), web.get("/api/v1/admin/overview"), web.get("/api/v1/admin/users")]
    for r in seen:
        assert SECRET not in r.text and SECRET not in "".join(f"{k}: {v}" for k, v in r.headers.items())
    assert SECRET not in caplog.text and SECRET not in repr(app.state.auth) and SECRET not in repr(app.state.auth.oidc)
    assert "id_token" not in caplog.text and "at-1" not in caplog.text


# --- configuration ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("missing", ["MAHLWERK_OIDC_ISSUER", "MAHLWERK_OIDC_CLIENT_ID", "MAHLWERK_PUBLIC_URL"])
def test_missing_settings_stop_the_start_with_a_clear_message(make_app, monkeypatch, missing):
    base = {"MAHLWERK_OIDC_ISSUER": ISSUER, "MAHLWERK_OIDC_CLIENT_ID": "mahlwerk", "MAHLWERK_PUBLIC_URL": PUBLIC}
    for key, value in base.items():
        if key != missing:
            monkeypatch.setenv(key, value)
    monkeypatch.setenv("MAHLWERK_AUTH", "oidc")
    with pytest.raises(ValueError, match=missing):
        create_app()


@pytest.mark.parametrize("env", [
    {"MAHLWERK_OIDC_ISSUER": "http://id.example.org"}, {"MAHLWERK_OIDC_ISSUER": "id.example.org"},
    {"MAHLWERK_OIDC_ISSUER": "https://id.example.org/?a=1"}, {"MAHLWERK_PUBLIC_URL": "http://mahlwerk.example.org"},
    {"MAHLWERK_OIDC_CLIENT_AUTH": "bearer"}, {"MAHLWERK_OIDC_SCOPES": "profile"}, {"MAHLWERK_SESSION_DAYS": "0"},
])
def test_bad_settings_stop_the_start(make_app, env):
    with pytest.raises(ValueError):
        make_app(**env)


def test_http_is_possible_only_with_the_unsafe_switch(make_app, idp):
    with pytest.raises(ValueError, match="ALLOW_HTTP"):
        make_app(MAHLWERK_OIDC_ISSUER="http://127.0.0.1:8121")
    make_app(MAHLWERK_OIDC_ISSUER="http://127.0.0.1:8121", MAHLWERK_PUBLIC_URL="http://127.0.0.1:8122", MAHLWERK_OIDC_ALLOW_HTTP="1")


def test_redirect_url_can_be_given_directly(make_app, idp):
    web = browser(make_app(MAHLWERK_PUBLIC_URL="", MAHLWERK_OIDC_REDIRECT_URL="https://other.example.org/mw/api/v1/auth/oidc/callback"))
    q = parse_qs(urlparse(web.get(LOGIN, follow_redirects=False).headers["location"]).query)
    assert q["redirect_uri"] == ["https://other.example.org/mw/api/v1/auth/oidc/callback"]
    ok(sign_in(web, idp), "/mw/")


def test_redirect_uri_never_comes_from_the_host_header(web, idp):
    q = parse_qs(urlparse(web.get(LOGIN, headers={"Host": "evil.example", "X-Forwarded-Host": "evil.example"}, follow_redirects=False).headers["location"]).query)
    assert q["redirect_uri"] == [PUBLIC + CALLBACK]


def test_interactive_docs_are_off(app):
    assert browser(app).get("/docs").status_code == 404


def test_host_check_still_applies(make_app, idp):
    app = make_app(MAHLWERK_ALLOWED_HOSTS="mahlwerk.example.org")
    assert browser(app).get(LOGIN, headers={"Host": "evil.example"}, follow_redirects=False).status_code == 421


# --- migration ------------------------------------------------------------------------------------------------------------


def test_version_10_database_gets_the_identity_table_without_losing_data(tmp_path):
    path = str(tmp_path / "v10.db")
    Store(path)
    con = sqlite3.connect(path)
    con.executescript(DROP_V11)
    con.executescript(
        """
        INSERT INTO user (id, username, display_name, created_at) VALUES (1, 'me', 'Me', 1);
        INSERT INTO goal (user_id, kcal, protein, carbs, fat) VALUES (1, 2000, 100, 200, 60);
        PRAGMA user_version = 10;
        """
    )
    con.commit()
    con.close()

    store = Store(path)

    con = sqlite3.connect(path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 14
    assert "oidc_identity" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    con.close()
    assert store.get_goal(1)["kcal"] == 2000
    Store(path)  # opening again changes nothing
    user = store.oidc_sign_in(ISSUER, "sub-1", "me", "Me", False, link_existing=True)  # the old user can be linked
    assert user["id"] == 1


# --- review round: discovery under a hanging provider (M1) -----------------------------------------------------------------

from mahlwerk import oidc  # noqa: E402
from mahlwerk.oidc import OidcClient, OidcConfig, OidcError  # noqa: E402


class Ticker:
    """A monotonic clock the tests move by hand."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def client_for(handler, clock, ticker=None, **config) -> OidcClient:
    cfg = OidcConfig(issuer=ISSUER, client_id="mahlwerk", redirect_url=PUBLIC + CALLBACK, **config)
    return OidcClient(cfg, httpx.MockTransport(handler), clock, ticker or Ticker())


def doc_response(idp):
    return httpx.Response(200, json=idp.doc)


class Drip(httpx.SyncByteStream):
    """A body that arrives in small pieces and moves the monotonic clock with every piece."""

    def __init__(self, ticker, step, pieces=20):
        self.ticker, self.step, self.pieces = ticker, step, pieces

    def __iter__(self):
        yield b"{"
        for _ in range(self.pieces):
            self.ticker.t += self.step
            yield b" "


def test_a_dripping_provider_hits_the_total_deadline(clock, idp):
    ticker = Ticker()
    handler = lambda r: httpx.Response(200, headers={"content-type": "application/json"}, stream=Drip(ticker, 3))  # noqa: E731
    with pytest.raises(OidcError, match="longer than"):
        client_for(handler, clock, ticker).discovery()
    assert ticker.t - 1000 < 30  # it stopped after a few pieces, it did not read them all (20 x 3 s)


def test_token_and_userinfo_calls_have_the_same_deadline(clock, idp):
    ticker = Ticker()
    handler = lambda r: httpx.Response(200, headers={"content-type": "application/json"}, stream=Drip(ticker, 3))  # noqa: E731
    client = client_for(lambda r: doc_response(idp) if "well-known" in r.url.path else handler(r), clock, ticker)
    with pytest.raises(OidcError, match="longer than"):
        client.exchange("code", "verifier")
    with pytest.raises(OidcError, match="longer than"):
        client.userinfo("token")


def test_only_one_discovery_fetch_runs_and_the_others_do_not_wait(clock, idp):
    inner: list = []
    client: OidcClient

    def handler(request):
        try:
            client.discovery()  # a second caller while the fetch is in progress: no waiting, no second fetch
        except OidcError as exc:
            inner.append(exc.detail)
        return doc_response(idp)

    client = client_for(handler, clock)
    assert client.discovery()["issuer"] == ISSUER
    assert len(inner) == 1 and "fetch is running" in inner[0]


def test_failed_discovery_pauses_for_a_minute_and_the_old_copy_serves(clock, idp):
    calls = []
    status = [200]

    def handler(request):
        calls.append(clock.now)
        return httpx.Response(status[0], json=idp.doc)

    client = client_for(handler, clock)
    first = client.discovery()
    clock.now += 3601  # stale
    status[0] = 503
    assert client.discovery() is first  # failed refresh: the old copy
    for _ in range(5):
        assert client.discovery() is first
    assert len(calls) == 2  # one failure, then the pause: nobody asked again
    clock.now += 61
    status[0] = 200
    assert client.discovery() is not first and len(calls) == 3


def test_failed_discovery_without_a_copy_fails_at_once_during_the_pause(clock, idp):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503)

    client = client_for(handler, clock)
    for _ in range(4):
        with pytest.raises(OidcError):
            client.discovery()
    assert len(calls) == 1


# --- review round: the pending sign-in is one signed cookie (M2) ------------------------------------------------------------


def test_nothing_about_pending_sign_ins_is_kept_in_the_process(app, web, idp):
    start(web, idp)
    assert not hasattr(app.state, "pending")


def test_tampered_or_foreign_cookie_is_refused(make_app, web, idp, tmp_path):
    code, state = start(web, idp)
    value = web.cookies.get(PENDING)
    body, _, mac = value.partition(".")
    for bad in (body + "." + mac[:-2] + ("AA" if mac[-2:] != "AA" else "BB"), body[:-1] + ("A" if body[-1] != "A" else "B") + "." + mac, body, "." + mac, "x.y", ""):
        web.cookies.set(PENDING, bad)
        refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")
    # signed with another installation's key: refused as well
    other = oidc.seal_login(b"k" * 32, oidc.Pending(state, "n", "v", "/"), 1_800_000_000.0)
    web.cookies.set(PENDING, other)
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")


def test_the_expiry_comes_from_the_signed_content(web, idp, clock, app):
    code, state = start(web, idp)
    value = web.cookies.get(PENDING)
    clock.now += 601  # the browser would have dropped the cookie; one that is kept anyway does not work
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "expired")
    assert oidc.open_login(app.state.store.secret_key("oidc_cookie"), value, clock.now - 601) is not None
    assert oidc.open_login(app.state.store.secret_key("oidc_cookie"), value, clock.now) is None


def test_the_callback_always_deletes_the_cookie(web, idp):
    code, state = start(web, idp)
    r = web.get(CALLBACK, params={"code": code, "state": "wrong"}, follow_redirects=False)
    assert PENDING + '=""' in r.headers["set-cookie"] or PENDING + "=;" in r.headers["set-cookie"]
    assert "max-age=0" in r.headers["set-cookie"].lower()


def test_a_second_login_replaces_the_first_one(web, idp):
    code1, state1 = start(web, idp)
    code2, state2 = start(web, idp)  # a second tab
    refused(web.get(CALLBACK, params={"code": code1, "state": state1}, follow_redirects=False), "failed")  # state differs: retry
    code3, state3 = start(web, idp)
    ok(web.get(CALLBACK, params={"code": code3, "state": state3}, follow_redirects=False))


def test_a_replayed_cookie_finds_the_code_spent(web, idp):
    code, state = start(web, idp)
    value = web.cookies.get(PENDING)
    ok(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False))
    thief = browser(web.app)
    thief.cookies.set(PENDING, value)
    refused(thief.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "failed")  # the provider refuses the second use


def test_the_signing_key_is_made_once_and_kept_in_the_database(app, web, idp, make_app):
    key = app.state.store.secret_key("oidc_cookie")
    assert len(key) == 32 and key == app.state.store.secret_key("oidc_cookie") and key != app.state.store.secret_key("other")
    code, state = start(web, idp)
    second = make_app()  # another process on the same database: same key, so it can finish the sign-in the first one started
    other = browser(second)
    r = other.get(CALLBACK, params={"code": code, "state": state}, headers={"Cookie": f"{PENDING}={web.cookies.get(PENDING)}"}, follow_redirects=False)
    ok(r)
    for r in (web.get("/api/v1/auth/status"), web.get("/api/v1/admin/overview")):
        assert key.hex() not in r.text


def test_login_and_callback_are_limited_per_address(web, idp, clock):
    for _ in range(30):
        assert web.get(LOGIN, follow_redirects=False).status_code == 302
    r = web.get(LOGIN, follow_redirects=False)
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    assert browser(web.app).get(LOGIN, follow_redirects=False).status_code == 429  # same address
    elsewhere = TestClient(web.app, base_url=PUBLIC, client=("203.0.113.9", 1), headers=CSRF)
    assert elsewhere.get(LOGIN, follow_redirects=False).status_code == 302
    for _ in range(30):
        assert web.get(CALLBACK, follow_redirects=False).status_code == 303
    assert web.get(CALLBACK, follow_redirects=False).status_code == 429
    clock.now += 61
    assert web.get(LOGIN, follow_redirects=False).status_code == 302


# --- review round: user names (M3) ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["Klex", "İlex", "alexK", "aléx", "ａlex", "alex​", "al ex"])
def test_lookalike_user_names_are_not_folded_onto_ascii(web, idp, name):
    idp.claims = {"preferred_username": name}
    refused(sign_in(web, idp), "name")


def test_clean_username_unit():
    assert oidc.clean_username(" Alex.B ") == "alex.b" and oidc.clean_username("Klex") is None and oidc.clean_username("a" * 41) is None


def test_local_mode_refuses_the_same_lookalikes(local_app):
    c = TestClient(local_app, client=("198.51.100.7", 1), headers=CSRF)
    for name in ("Klex", "İlex", "aléx"):
        assert c.post("/api/v1/auth/setup", json={"username": name, "password": "correct horse battery"}).status_code == 422
    assert c.post("/api/v1/auth/setup", json={"username": " Alex ", "password": "correct horse battery"}).json()["username"] == "alex"


# --- review round: cookie names (N1) --------------------------------------------------------------------------------------


def test_secure_cookies_carry_the_host_prefix_and_only_that_name_is_read(monkeypatch, tmp_path, clock):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    monkeypatch.setenv("MAHLWERK_COOKIE_SECURE", "1")
    app = create_app(str(tmp_path / "l.db"), password_cost=(16, 8, 1), clock=clock)
    c = TestClient(app, base_url="https://mahlwerk.example.org", client=("198.51.100.7", 1), headers=CSRF)
    r = c.post("/api/v1/auth/setup", json={"username": "alex", "password": "correct horse battery"})
    header = r.headers["set-cookie"].lower()
    assert header.startswith("__host-mahlwerk_session=") and "path=/;" in header + ";" and "secure" in header and "domain" not in header
    token = c.cookies.get("__Host-mahlwerk_session")
    plain = TestClient(app, base_url="https://mahlwerk.example.org", client=("198.51.100.7", 1), headers={**CSRF, "Cookie": "mahlwerk_session=" + token})
    assert plain.get("/api/v1/me").status_code == 401  # the unprefixed name is not accepted over HTTPS
    assert c.get("/api/v1/me").status_code == 200
    assert c.post("/api/v1/auth/logout").status_code == 204
    assert "__host-mahlwerk_session=" in c.post("/api/v1/auth/logout").headers["set-cookie"].lower()


def test_without_secure_the_old_names_stay(browser, admin):
    assert admin.cookies.get("mahlwerk_session")


# --- review round: sessions of another mode (N2) ----------------------------------------------------------------------------


def test_sessions_from_local_mode_do_not_count_in_oidc_mode(monkeypatch, tmp_path, clock, idp):
    monkeypatch.setenv("MAHLWERK_AUTH", "local")
    local = create_app(str(tmp_path / "shared.db"), password_cost=(16, 8, 1), clock=clock)
    c = TestClient(local, client=("198.51.100.7", 1), headers=CSRF)
    c.post("/api/v1/auth/setup", json={"username": "alex", "password": "correct horse battery"})
    token = c.cookies.get("mahlwerk_session")
    for key, value in {"MAHLWERK_AUTH": "oidc", "MAHLWERK_OIDC_ISSUER": ISSUER, "MAHLWERK_OIDC_CLIENT_ID": "mahlwerk",
                       "MAHLWERK_PUBLIC_URL": PUBLIC, "MAHLWERK_OIDC_LINK_EXISTING": "1"}.items():
        monkeypatch.setenv(key, value)
    app = create_app(str(tmp_path / "shared.db"), clock=clock, oidc_transport=httpx.MockTransport(idp))
    old = TestClient(app, base_url=PUBLIC, client=("198.51.100.7", 1), headers={**CSRF, "Cookie": f"{SESSION}={token}"})
    assert old.get("/api/v1/me").status_code == 401  # alex has no identity at this issuer yet
    ok(sign_in(browser(app), idp))  # signing in links the old user ...
    assert old.get("/api/v1/me").status_code == 401  # ... and the old session stays dead


def test_sessions_do_not_survive_a_change_of_issuer(make_app, idp, clock, monkeypatch, tmp_path):
    web = browser(make_app())
    ok(sign_in(web, idp))
    assert web.get("/api/v1/me").status_code == 200
    token = web.cookies.get(SESSION)
    monkeypatch.setenv("MAHLWERK_OIDC_ISSUER", "https://other-id.example.org")
    app2 = create_app(str(tmp_path / "oidc.db"), clock=clock, oidc_transport=httpx.MockTransport(idp))
    again = TestClient(app2, base_url=PUBLIC, client=("198.51.100.7", 1), headers={**CSRF, "Cookie": f"{SESSION}={token}"})
    assert again.get("/api/v1/me").status_code == 401


# --- review round: http only on loopback (N3) --------------------------------------------------------------------------------


@pytest.mark.parametrize("issuer", ["http://id.example.org", "http://localhost.example.org", "http://10.0.0.5", "http://127.0.0.1.example.org"])
def test_http_is_refused_for_anything_but_loopback_even_with_the_switch(make_app, issuer):
    with pytest.raises(ValueError):
        make_app(MAHLWERK_OIDC_ISSUER=issuer, MAHLWERK_OIDC_ALLOW_HTTP="1")


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "127.8.9.1", "[::1]"])
def test_http_on_loopback_works_with_the_switch(make_app, host):
    make_app(MAHLWERK_OIDC_ISSUER=f"http://{host}:8121", MAHLWERK_PUBLIC_URL=f"http://{host}:8122", MAHLWERK_OIDC_ALLOW_HTTP="1")


def test_an_https_issuer_never_has_http_endpoints_even_with_the_switch(make_app, web, idp):
    app = make_app(MAHLWERK_OIDC_ALLOW_HTTP="1")  # https issuer, switch on
    idp.doc["token_endpoint"] = "http://127.0.0.1:8121/token"
    refused(browser(app).get(LOGIN, follow_redirects=False), "failed")


# --- review round: odd numbers in the token (H1) -------------------------------------------------------------------------------


@pytest.mark.parametrize("claims", [
    {"exp": float("nan")}, {"exp": float("inf")}, {"iat": float("nan")}, {"iat": float("-inf")}, {"nbf": float("nan")},
    {"nbf": "now"}, {"exp": 10 ** 400}, {"iat": 10 ** 400}, {"nbf": 10 ** 400}, {"exp": [1]}, {"iat": False},
])
def test_odd_numbers_in_the_id_token_are_a_clean_refusal_not_a_crash(web, idp, claims):
    idp.token_claims = claims
    refused(sign_in(web, idp), "failed")


# --- review round: RFC 9207 (H4) ---------------------------------------------------------------------------------------------


def test_iss_is_required_when_the_provider_announces_it(web, idp):
    idp.doc["authorization_response_iss_parameter_supported"] = True
    code, state = start(web, idp)
    refused(web.get(CALLBACK, params={"code": code, "state": state}, follow_redirects=False), "failed")
    code, state = start(web, idp)
    ok(web.get(CALLBACK, params={"code": code, "state": state, "iss": ISSUER}, follow_redirects=False))
    _, state = start(web, idp)  # an error answer needs it as well
    refused(web.get(CALLBACK, params={"error": "access_denied", "state": state}, follow_redirects=False), "failed")


def test_iss_stays_optional_when_not_announced(web, idp):
    ok(sign_in(web, idp))


# --- review round: host check default (H8) -------------------------------------------------------------------------------------


def test_host_check_defaults_to_the_public_host_and_loopback(make_app, monkeypatch):
    app = make_app()
    monkeypatch.delenv("MAHLWERK_ALLOWED_HOSTS")  # conftest sets "*" for all tests; make_app ran with it, so build again
    app = make_app()
    assert app.state.auth.allowed_hosts == {"mahlwerk.example.org", "localhost", "127.0.0.1", "[::1]"}
    web = TestClient(app, base_url=PUBLIC, headers=CSRF)
    assert web.get("/api/v1/auth/status").status_code == 200
    assert web.get("/api/v1/auth/status", headers={"Host": "evil.example"}).status_code == 421
    assert web.get("/healthz", headers={"Host": "evil.example"}).status_code == 200  # exempt


def test_host_check_default_can_be_overridden(make_app, monkeypatch):
    app = make_app(MAHLWERK_ALLOWED_HOSTS="*")
    assert app.state.auth.allowed_hosts is None
    app = make_app(MAHLWERK_ALLOWED_HOSTS="a.example.org")
    assert app.state.auth.allowed_hosts == {"a.example.org"}


def test_public_url_with_a_port_gives_the_bare_host(make_app, monkeypatch):
    monkeypatch.delenv("MAHLWERK_ALLOWED_HOSTS")
    app = make_app(MAHLWERK_PUBLIC_URL="https://mahlwerk.example.org:8443")
    assert "mahlwerk.example.org" in app.state.auth.allowed_hosts

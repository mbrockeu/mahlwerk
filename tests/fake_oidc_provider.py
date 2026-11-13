"""A tiny stand-in OpenID Connect provider for trying the oidc sign-in in a real browser (not a test module, nothing here
is secure: it agrees to everything and signs nothing, which Mahlwerk accepts by design, see SECURITY.md).

    python tests/fake_oidc_provider.py 8121 http://127.0.0.1:8122/api/v1/auth/oidc/callback

Then start Mahlwerk with MAHLWERK_AUTH=oidc, MAHLWERK_OIDC_ISSUER=http://127.0.0.1:8121, MAHLWERK_OIDC_CLIENT_ID=mahlwerk,
MAHLWERK_PUBLIC_URL=http://127.0.0.1:8122 and MAHLWERK_OIDC_ALLOW_HTTP=1.
"""

import base64
import hashlib
import json
import secrets
import sys
import time
from urllib.parse import parse_qs, urlencode

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8121
REDIRECT = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8122/api/v1/auth/oidc/callback"
ISSUER = f"http://127.0.0.1:{PORT}"
USER = {"sub": "fake-user-1", "preferred_username": "alex", "name": "Alex Example", "groups": ["admin"]}

app = FastAPI()
codes: dict[str, dict] = {}


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@app.get("/.well-known/openid-configuration")
def discovery() -> dict:
    return {"issuer": ISSUER, "authorization_endpoint": ISSUER + "/authorize", "token_endpoint": ISSUER + "/token",
            "userinfo_endpoint": ISSUER + "/userinfo", "scopes_supported": ["openid", "profile", "groups"],
            "code_challenge_methods_supported": ["S256"]}


@app.get("/authorize")
def authorize(request: Request):
    q = request.query_params
    assert q["response_type"] == "code" and q["code_challenge_method"] == "S256" and q["redirect_uri"] == REDIRECT, dict(q)
    code = secrets.token_urlsafe(16)
    codes[code] = {"challenge": q["code_challenge"], "nonce": q["nonce"], "client_id": q["client_id"]}
    return RedirectResponse(REDIRECT + "?" + urlencode({"code": code, "state": q["state"], "iss": ISSUER}), status_code=302)  # consent is instant


@app.post("/token")
async def token(request: Request):
    form = {k: v[0] for k, v in parse_qs((await request.body()).decode()).items()}  # no python-multipart needed
    grant = codes.pop(form.get("code", ""), None)
    if grant is None or b64(hashlib.sha256(form.get("code_verifier", "").encode()).digest()) != grant["challenge"] or form.get("redirect_uri") != REDIRECT:
        return JSONResponse({"error": "invalid_grant"}, status_code=400)
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": grant["client_id"], "sub": USER["sub"], "iat": now, "exp": now + 300, "nonce": grant["nonce"]}
    id_token = b64(b'{"alg":"none"}') + "." + b64(json.dumps(claims).encode()) + "."
    return {"token_type": "Bearer", "access_token": "probe-access-token", "id_token": id_token}


@app.get("/userinfo")
def userinfo() -> dict:
    return USER  # the ID token above carries no profile claims: Mahlwerk has to ask here


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

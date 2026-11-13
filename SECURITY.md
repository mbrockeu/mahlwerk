# Security policy

## Supported versions

Only the latest released version receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: on the repository page open
**Security**, then **Advisories**, then **Report a vulnerability**
(<https://github.com/mbrockeu/mahlwerk/security/advisories/new>).

Describe what you found, how to reproduce it and which version is affected. This is a small project run by one
maintainer, so replies may take a few days.

## Deployment notes

- `MAHLWERK_AUTH=single` has no login and must not be exposed to the internet.
- `MAHLWERK_AUTH=local` has its own accounts. Serve it over HTTPS only (passwords and the session cookie are not
  protected on plain HTTP) and set `MAHLWERK_COOKIE_SECURE=1` behind a TLS proxy. The brake against password guessing
  keeps its counts in process memory. Scrypt cost cannot be lowered by configuration.
- `MAHLWERK_AUTH=oidc` hands the sign-in to an OpenID Connect provider. Serve Mahlwerk over HTTPS, keep the issuer on `https`
  (`MAHLWERK_OIDC_ALLOW_HTTP=1` is for tests and `localhost` only and removes the protection described below), run one
  worker, and read the section "OpenID Connect: what is and is not verified" below.
- In `proxy` mode the service must be reachable only through the trusted reverse proxy, which has to remove or
  overwrite **`Remote-User`, `Remote-Name` and `Remote-Groups`** on every request. If `Remote-Groups` is not
  overwritten, any signed-in user can make themselves an admin by sending it. See the README for an nginx example.
- Set `MAHLWERK_ALLOWED_HOSTS` to the names you use (DNS rebinding) and a body size limit at the proxy.
- **Recipes from web pages** (off by default) fetch an address that a signed-in person types. The server resolves the host, requires every
  address to be public (`netguard.py`; no exception list for this feature), connects to exactly the address it checked, follows at
  most 3 redirects and checks each station again, accepts only http(s) on ports 80 and 443, limits time (10 s), size (3 MB after
  decompression) and content type, keeps no cookies, answers every failure with the same text and is braked per person and for the
  server. If your server can reach internal services through a *public* address (a split-horizon name, a public IP that is routed
  inside), the check cannot know: leave the connector off or filter outgoing traffic at the network. **Hairpin NAT:** your own public name
  can lead back into the home network through the router, where it may meet permissions that go by address; the server's own names
  (`MAHLWERK_PUBLIC_URL`, `MAHLWERK_ALLOWED_HOSTS`) are blocked automatically and `MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS` takes further ones (name and
  subdomains): list all your domains before you switch the connector on. IP addresses are refused by the syntax check and, as names, by the
  resolution check. The whole fetch of an address (name resolution, connection, TLS, headers, body, redirects) is cut off after 10 seconds; a
  name resolution cannot be interrupted, so its thread lives on until the resolver answers (at most 8 such threads exist). The saved address
  including its query is visible to the household: do not use links with personal tokens. Report bypasses privately.
- **Recipe pictures.** Pictures of Cookidoo and web recipes (off by default, a switch per connector) are fetched with the same
  guarded fetcher as web recipes (public addresses only, pinned connection, redirects checked, own hosts blocked, 10 s, at most 6 MB,
  only `image/jpeg`, `image/png`, `image/webp`). Every picture (also an own upload, at most 8 MB) is decoded in a **child process**
  (`python -m mahlwerk.imageproc`) with **resource limits and reduced rights, not a complete sandbox**: an address-space limit (768 MB), a
  CPU limit (20 s), a wall-clock limit (30 s), no files it may write (`RLIMIT_FSIZE` 0), 8 file descriptors, no new processes
  (`RLIMIT_NPROC` 0), all inherited descriptors closed, an empty working directory and, where the system allows it without privileges
  (`os.unshare`, Python 3.12+), an own empty network and user namespace (skipped silently otherwise). It can still read whatever the server's
  user can read, and the decoders (libjpeg, libpng, libwebp inside Pillow) are native code: **keep Pillow up to date**. One child runs at a
  time, at most two requests wait for it (the rest get 503 at once), and an own photo is limited to 20 per person in 10 minutes. The pixel
  size is read from the header first (at most 24 megapixels, and at most 300 MB of decoded pixels, `Image.MAX_IMAGE_PIXELS` set as well),
  Pillow opens only JPEG, PNG and WebP, only the first frame is read, an embedded colour profile is discarded (no LittleCMS parsing of an
  attacker's profile; pixels count as sRGB), and the result is re-encoded from raw pixels, so no metadata (EXIF/GPS, XMP, ICC, comments)
  survives. The child's answer is checked again by the parent (sizes, byte counts). A crash or hang of the decoder ends that child only and is
  answered as "could not be read". Files are named by
  their content hash (never by input), written atomically with mode `0600`; the delivery route checks the hash strictly
  (32 lower-case hex digits) and the size against a fixed list, serves only pictures a recipe still uses, as `image/webp` with
  `nosniff`, and only to signed-in people. The content security policy is unchanged (`img-src 'self' data: blob:`): the interface never
  loads a provider's picture. The folder is `<database file name>.images` with a marker file; a folder without the marker is never changed or
  tidied. Provider pictures are fetched only when the connector's switch is on, not again for an address that is already stored (unless a
  person reloads), and every fetch counts against the brake; no picture address is stored while the switch is off, a plain-http picture of an
  https page is refused. **Because of the long private cache, pictures stay in the browser cache of a device after sign-out: on a shared
  device clear the site data.** The hash is derived from the picture's content (anyone who has the same picture can compute it); it matters only
  to signed-in people, since the route needs a sign-in. The one deliberate exception to `Cache-Control: no-store` on the API is this route
  (`private, max-age=31536000, immutable`: the address carries the content hash).
- Webhook targets must be public addresses unless an admin lists the host. Run one worker (the password login brake and the sign-in rate limit are in memory).
- Writing requests need the `X-Mahlwerk-Request: 1` header (or a bearer key) in all modes.
- **The demo account (switch for admins).** The built-in demo account (`demo`, off by default, `MAHLWERK_DEMO_ACCOUNT`) is the
  one place an admin can "act as" another user; it is not a general "sign in as" feature and there is no route that names another
  user. What it is: the real sign-in stays, and a second `HttpOnly`, `SameSite=Lax` cookie (`mahlwerk_demo`, `__Host-` prefixed over
  HTTPS), HMAC-signed with a key kept in the table `setting` (like the OpenID Connect cookie), says "show me the demo account". It
  holds the real user's id, a binding to the real session (so signing in again or another browser's cookie is worthless) and an
  expiry (12 hours). It is checked on every request: the real identity must still be valid **and** an admin **and** the demo account
  on and present, otherwise the cookie is ignored and removed. Starting and ending it are `POST` routes with the CSRF header, refused
  for access keys, which never look at the cookie. The account is the user row named `~demo`, a name no sign-in
  path can produce (the local and OpenID Connect name rules refuse `~`; a proxy header, `MAHLWERK_SINGLE_USER`, access keys,
  sessions and the Yazio command are refused for exactly that row). A real user called `demo` is an ordinary user. The row is never
  deleted (ids are reused in SQLite tables without AUTOINCREMENT): "delete" empties it and switches it off. The demo account has no password, no admin right, no keys; the admin area refuses to
  manage it as a user. What a demo request may do is one table (`src/mahlwerk/demo_account.py`) that every route must appear in
  (a test fails for a new route until it is classified); anything not allowed there, shared data and everything that reaches out
  (webhooks, keys, connectors, imports, Cookidoo, web recipes) is refused with 403, no debug copy of a label photo is kept, and webhook events of the demo account are never
  sent. Limits: a demo request sees the household's products and recipes (read-only), and the sample foods it uses are rows of
  the shared `food` table (marked `demo_account`; for everybody but the demo view they do not exist: not listed, not readable,
  not loggable, not usable in recipes by id; removed with the account).
  **Several tabs.** The cookie is browser-wide, so every request carries `X-Mahlwerk-View: own|demo` (what the page believes) and every
  answer names the real view. A write for another view is refused with 409 `view changed` before it runs (a write as the demo account
  without the header too), the page then reloads its profile, shows a note and does not repeat the action; tabs tell each other
  through a `BroadcastChannel`. This stops a stale tab from booking into the wrong diary (or firing the real account's webhooks).
  **It is not a guest mode:** "Back" always works and whoever holds the signed-in device holds the admin account. In `single` and
  `proxy` mode the cookie is tied to the user id only (there is no session), lives 2 hours and survives a sign-out at the proxy for
  that time; serve it over HTTPS with `MAHLWERK_COOKIE_SECURE=1` so that it gets the `__Host-` prefix.
- **Stored credentials.** Passwords for other services (Cookidoo) are kept in the table `secret`, encrypted with AES-256-GCM
  (`cryptography`), key from `MAHLWERK_SECRET_KEY` or the key file `<database>.key` (mode 0600, made on first use, never
  overwritten). This protects a copy of the database; it does not protect against someone with access to the running server, its
  environment or the key file: they can decrypt. `MAHLWERK_SECRET_KEY` must have at least 32 characters (`openssl rand -base64 32`) and is stretched with scrypt and a random salt stored in the database.
  A key file readable by group or others is warned about in the log. **Back up the key file** (preferably not next to the database backup) or
  the stored credentials become unreadable after a restore (they then count as not set and are entered again; nothing crashes).
  Values are bound to their row (user and name) as associated data. They are never returned (the API says "set" or not, with
  the e-mail address masked), never logged, never part of an error message (validation errors of these routes leave the
  input out), and access keys cannot read or set them. Treat `MAHLWERK_SECRET_KEY` as a secret and rotate it by entering the
  credentials again after changing it.
- **Yazio import.** An upload is held in memory per person for 20 minutes (limits: 24 MB as sent, 24 MB per file and 32 MB per
  person after unpacking, 96 MB on the whole server; a packed-to-unpacked ratio above 100 and, counted on the raw bytes before
  parsing, more than 200,000 objects/lists or 2 million elements are refused, so one parse stays around 150 MB at most; one heavy
  job (upload, preview, import) at a time on the server, others get 429; the file name is checked before the body is read; ZIPs are
  never extracted to disk, their entry count and directory size are read from the end of the file before zipfile opens it (ZIP64
  refused), unsafe paths refuse the ZIP, unpacking is bounded whatever a ZIP header declares). The route has its own body limit, the rest of the API keeps 1 MB. The optional
  direct sign-in (off by default, admin switch, needs the app identifiers in the environment) talks only to Yazio's API host over
  https without following redirects, uses e-mail address and password for one request and keeps nothing; it is braked per
  person (3 attempts an hour, 30 s apart) and for the whole server (10 attempts an hour, 2 runs at once, 48 MB per run); a run ends
  when its person signs out or is blocked or when the connector is switched off, and what it fetched is then dropped. The direct sign-in uses an unofficial interface and has never been run against the real
  service by the project.

## OpenID Connect: what is and is not verified

**The signature of the ID token is not checked, on purpose.** OpenID Connect Core 3.1.3.7 (step 6) says that when the ID token
is received directly from the token endpoint, "the TLS server validation MAY be used to validate the issuer in place of
checking the token signature". Mahlwerk receives the token only that way: in the answer to its own HTTPS request to the token
endpoint, whose address comes from the provider's discovery document, itself fetched over HTTPS from the configured issuer. No
token ever arrives through the browser (the callback takes a one-time `code` only). That is why Mahlwerk needs no JWT library,
no key fetching and no key rotation handling.

What this assumes, and what it costs:

- The TLS connection to the provider is not intercepted: the certificate chain is checked by httpx against the `certifi` CA
  bundle (not the operating system's store; `SSL_CERT_FILE` / `SSL_CERT_DIR` replace it, which is how a private CA is trusted, and
  the proxy variables `HTTPS_PROXY` and friends are honoured, `trust_env` stays on deliberately). Whoever
  can forge or terminate TLS to the provider (a rogue certificate authority, a TLS-intercepting proxy you installed
  yourself, a compromised provider host) can sign anybody in, including as an admin. With a signature check they could not forge
  the token, but they could still read the code exchange; the difference is real, though small for a household server.
- The issuer must be `https`. `MAHLWERK_OIDC_ALLOW_HTTP=1` removes the assumption for the loopback only: it accepts `http` for
  `localhost`, `127.0.0.0/8` and `::1` and nothing else (a start error otherwise); with an `https` issuer `http` endpoints are always
  refused. It exists for the automated tests and a provider on the same machine.
- Provider endpoints are used as the discovery document names them (https required, no redirects followed, time limits per read
  and a hard 10 seconds per request, answers capped at 256 KiB). Only one discovery fetch runs at a time and nobody waits for it:
  the others get the cached copy or an immediate error, and after a failure nobody asks again for 60 seconds, so a hanging
  provider cannot stall the service. The provider is trusted configuration, so its addresses are not restricted to public ones: a provider in
  your LAN works.

Everything else in 3.1.3.7 **is** checked, for every sign-in: `iss` equals the issuer in the discovery document, which equals
the configured one exactly; `aud` contains the client ID (with several audiences `azp` must be present and equal it, and a
present `azp` must always equal it); `exp` has not passed (60 seconds of tolerance); `iat` is not in the future (60 seconds) and
not older than 10 minutes; `nbf` if present; `nonce` equals the one made for this sign-in; `sub` is present. Also: the PKCE
challenge (S256) is sent and the verifier is presented at the token endpoint; `state` is random, tied to a short-lived `HttpOnly`
cookie of the browser that started the sign-in and usable once; an `iss` parameter in the callback (RFC 9207) must match; claims
taken from the userinfo endpoint count only when its `sub` equals the ID token's; `exp`, `iat` and `nbf` must be finite numbers. When the
provider announces `authorization_response_iss_parameter_supported`, the `iss` parameter is required. Starting a sign-in stores
nothing on the server: the pending sign-in is one HttpOnly cookie signed with HMAC-SHA256 (key: 32 random bytes in the database,
made at first use, never output), valid 10 minutes by its signed expiry, deleted at every callback. The cookie is signed, not
encrypted, so it holds the PKCE verifier in the clear for that browser (HttpOnly, `Secure` behind HTTPS). One use of the code is
enforced by the provider, not by Mahlwerk. Login and callback are limited per address (30 a minute each).

Further notes:

- The authorization code appears in the callback URL and therefore in access logs of Mahlwerk and the proxy in front of it. It is
  single-use and useless without the PKCE verifier that only the server knows.
- Users are tied to the provider's `sub`, not to the name. The takeover of an existing user by name
  (`MAHLWERK_OIDC_LINK_EXISTING=1`) trusts the provider's names completely: anyone who can register or rename themselves at the
  provider into the name of an existing user would get that user's diary. It is off by default; use it only to move over and
  switch it off afterwards.
- The admin right and the groups are read at each sign-in. Taking a person out of the admin group (or disabling them at the provider)
  does not end a running session: it takes effect at the next sign-in. Shorten `MAHLWERK_SESSION_DAYS` / `MAHLWERK_SESSION_MAX_DAYS`
  if that is too slow, or block the user in the admin area (which ends their sessions and keys at once). The group name must match
  exactly; the claim must be a list of strings (one string counts as one group).
- User names from the provider must be ASCII (`a-z A-Z 0-9 . _ -`, 40 characters at most, checked before lower-casing, so look-alike
  characters such as the Kelvin sign are refused). The same rule now applies to names created in `local` mode.
- There is no sign-out at the provider (RP-initiated logout is not implemented); the provider's own session stays.
- Cookies over HTTPS carry the `__Host-` prefix (`__Host-mahlwerk_session`, `__Host-mahlwerk_oidc`; Path `/`, no Domain) and only
  those names are read then, so a sibling site cannot plant or overwrite them. Plain-HTTP setups keep the unprefixed names.
- A session counts in `oidc` mode only for a user with a link at the configured issuer; sessions left from `local` mode or another
  issuer are refused. Access keys, however, are independent of the mode and stay valid after a switch: revoke them (Profile, or block
  the user) if you do not want that.
- Defaults in `oidc` mode: sessions 7 days sliding, 30 days at most, because a right withdrawn at the provider ends a running
  session only that way. The host check is on by default (public host plus loopback).

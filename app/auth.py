"""OIDC sign-in against Keycloak: a gate, not an account model.

Keycloak answers "is this you"; Mastermind stores nothing about who you are. No
user table, no roles, no `created_by`, no audit trail -- the signed cookie is the
whole session, and deleting it is signing out.

Pure predicates and URL building sit beside the two HTTP calls the flow needs
(discovery and the code exchange), in the `validation.py` genre: one concern, its
own module. Scheduling rules live in `validation.py` and a reader looking for
them should not meet OIDC there.

**No new dependency, and this is the reason.** OIDC Core section 3.1.3.7(6): "If
the ID Token is received via direct communication between the Client and the
Token Endpoint (which it is in this flow), the TLS server validation MAY be used
to validate the issuer in place of checking the token signature." A confidential
client doing a back-channel exchange over TLS is exactly that case, so the
payload is decoded rather than verified -- no JWKS fetch, no crypto library. It
holds **only** under those two conditions, which `check_transport` enforces: a
public/PKCE client, or a plain-http token endpoint, must verify signatures, and
that means Authlib.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from urllib.parse import urlencode, urlsplit

import httpx

# --- environment -------------------------------------------------------------

# Every value below is configured on the Sign-in page and stored in the settings
# row; these variables are the fallback for a deployment that predates those
# columns, and are read only where the column is empty. The rule that keeps the
# secrets out of `/api/export` is `db.settings_without_sso`, which strips the
# whole `sso_` prefix -- see the comment on the settings table.
#
# Two exceptions, both deliberate, and both environment-only:
#
# `MASTERMIND_SSO=off` is the recovery hatch -- a rotated secret, a deleted
# client, a realm that is down. Stored in the database it would be unreachable
# in exactly the situations it exists for.
#
# `MASTERMIND_PUBLIC` describes the socket rather than the deployment, and it
# decides whether `/api/sso` is exempt from sign-in. A column for it would let
# the page that edits it lock itself away.
ENV_SSO = "MASTERMIND_SSO"
ENV_CLIENT_SECRET = "MASTERMIND_OIDC_SECRET"
ENV_SESSION_KEY = "MASTERMIND_SESSION_KEY"
# Set by the container when it binds a non-loopback interface. It closes the
# Sign-in page's own exemption -- see `main.EXEMPT_PATHS`.
ENV_PUBLIC = "MASTERMIND_PUBLIC"
# The escape hatch for a `http://` realm on a developer machine. Without it a
# plain-http token endpoint is refused, because the no-signature-check argument
# above rests entirely on TLS.
ENV_ALLOW_HTTP = "MASTERMIND_OIDC_ALLOW_HTTP"
# Overrides the redirect URI derived from the request. Needed when the app sits
# behind a proxy, or when the realm has one spelling registered and the browser
# uses another -- Keycloak compares the string exactly, and `localhost` and
# `127.0.0.1` are two different entries.
ENV_REDIRECT_URI = "MASTERMIND_OIDC_REDIRECT_URI"

SESSION_COOKIE = "mm_session"
# The state/nonce of a sign-in that has not come back yet. A cookie rather than
# server memory so nothing is pinned to one worker and a restart mid-flow fails
# closed instead of confusingly.
TRANSACTION_COOKIE = "mm_oidc_tx"

SESSION_HOURS = 12
TRANSACTION_MINUTES = 10

# Small tolerance for a clock that disagrees with the realm's by a few seconds.
CLOCK_SKEW_SECONDS = 60

DISCOVERY_PATH = "/.well-known/openid-configuration"
DISCOVERY_TIMEOUT_SECONDS = 10


class AuthError(Exception):
    """A sign-in that cannot be trusted. The message is shown to the person."""


# --- configuration -----------------------------------------------------------

# Everything non-secret lives in the settings row, so it survives a restart and
# is editable from the Sign-in page. `sso_enabled` is never written directly by
# the page: only a real round trip flips it. See `main.arm_sso`.
CONFIG_FIELDS = (
    "sso_issuer",
    "sso_client_id",
    "sso_identity_claim",
    "sso_allowlist",
    "sso_mode",
    "sso_enabled",
)

MODE_ALLOWLIST = "allowlist"
MODE_ANY = "any"
MODES = (MODE_ALLOWLIST, MODE_ANY)

DEFAULT_IDENTITY_CLAIM = "preferred_username"


def sso_env_off():
    """True when `MASTERMIND_SSO=off` disarms the gate for this process."""
    return os.environ.get(ENV_SSO, "").strip().lower() == "off"


def is_public_binding():
    """True when the app is served on a non-loopback interface."""
    return os.environ.get(ENV_PUBLIC, "").strip().lower() in ("1", "true", "yes")


DATABASE = "database"
ENVIRONMENT = "environment"


def resolve(settings, column, variable):
    """A configured value and where it came from: the settings row, then the environment.

    Empty in the row means "not configured here", which is what makes the
    environment a fallback rather than a competitor -- a deployment that predates
    these columns keeps working until somebody types a value on the page.
    """
    stored = str((settings or {}).get(column) or "").strip()
    if stored:
        return stored, DATABASE
    from_environment = os.environ.get(variable, "").strip()
    if from_environment:
        return from_environment, ENVIRONMENT
    return "", ""


def client_secret(settings=None):
    return resolve(settings, "sso_client_secret", ENV_CLIENT_SECRET)[0]


def redirect_uri_override(settings=None):
    """The registered redirect URI, when the request's own is not what Keycloak has."""
    return resolve(settings, "sso_redirect_uri", ENV_REDIRECT_URI)[0]


def allows_http(settings=None):
    """Whether a plain-http token endpoint is accepted. See `check_transport`."""
    if (settings or {}).get("sso_allow_http"):
        return True
    return os.environ.get(ENV_ALLOW_HTTP, "").strip().lower() in ("1", "true", "yes")


def mask_secret(secret, tail=4):
    """Dots plus the last few characters, so the operator can tell which secret loaded.

    A Keycloak secret is 32 characters and the operator has the full value in the
    realm console; four of them are what makes "the stale one is still in the
    environment" visible. Anything short enough for the tail to be a meaningful
    fraction of it is masked whole -- that includes every test fixture.
    """
    if not secret:
        return ""
    if len(secret) <= tail * 2:
        return "•" * len(secret)
    return "•" * (len(secret) - tail) + secret[-tail:]


def secret_report(settings, column, variable):
    """A secret as the page may see it: masked, its length, and which source won."""
    value, source = resolve(settings, column, variable)
    return {
        "name": variable,
        "set": bool(value),
        "source": source,
        "masked": mask_secret(value),
        "length": len(value),
    }


def env_report(settings=None):
    """Where each configured value came from. Masked secrets, never whole ones."""
    return {
        "client_secret": secret_report(settings, "sso_client_secret", ENV_CLIENT_SECRET),
        "session_key": secret_report(settings, "sso_session_key", ENV_SESSION_KEY),
        "redirect_uri": {"name": ENV_REDIRECT_URI,
                         "value": redirect_uri_override(settings),
                         "source": resolve(settings, "sso_redirect_uri", ENV_REDIRECT_URI)[1]},
        "allow_http": {"name": ENV_ALLOW_HTTP, "set": allows_http(settings)},
        "sso_env_off": sso_env_off(),
        "sso_env_name": ENV_SSO,
        "public_binding": is_public_binding(),
    }


_fallback_session_key = secrets.token_urlsafe(32)


def session_key(settings=None):
    """The cookie signing key, or a per-process one so sign-in still works.

    An unset key is not fatal, it is forgetful: every restart invalidates every
    session. The Sign-in page says so rather than letting it be discovered.
    Changing it on the page is the same event -- everyone signs in again.
    """
    return resolve(settings, "sso_session_key", ENV_SESSION_KEY)[0] or _fallback_session_key


def config_from_settings(settings):
    """The SSO half of the settings row, with defaults filled in."""
    return {
        "issuer": (settings.get("sso_issuer") or "").strip(),
        "client_id": (settings.get("sso_client_id") or "").strip(),
        "identity_claim": (settings.get("sso_identity_claim")
                           or DEFAULT_IDENTITY_CLAIM).strip(),
        "allowlist": settings.get("sso_allowlist") or "",
        "mode": (settings.get("sso_mode") or MODE_ALLOWLIST).strip(),
        "enabled": bool(settings.get("sso_enabled")),
    }


def is_configured(config, settings=None):
    """True when there is enough to attempt a sign-in at all."""
    return bool(config["issuer"] and config["client_id"] and client_secret(settings))


def parse_allowlist(text):
    """Split an allowlist written with commas, newlines or both."""
    parts = (text or "").replace(",", "\n").split("\n")
    return [part.strip() for part in parts if part.strip()]


def identity_of(claims, identity_claim):
    """The claim the deployment calls identity, as a string. May be empty."""
    value = claims.get(identity_claim)
    return str(value).strip() if value not in (None, "") else ""


def is_allowed(claims, mode, allowlist, identity_claim=DEFAULT_IDENTITY_CLAIM):
    """Whether these claims may in. Pure -- the whole authorisation decision.

    `allowlist` is compared case-insensitively: Keycloak usernames are
    case-preserving, and an entry differing only in case is a typo rather than a
    different person.
    """
    identity = identity_of(claims, identity_claim)
    if not identity:
        return False
    if mode == MODE_ANY:
        return True
    permitted = {entry.lower() for entry in parse_allowlist(allowlist)}
    return identity.lower() in permitted


# --- the provider ------------------------------------------------------------


def discovery_url(issuer):
    return issuer.rstrip("/") + DISCOVERY_PATH


def http_client(timeout=DISCOVERY_TIMEOUT_SECONDS):
    """The client both provider calls go through. One seam, so a test can stub the realm.

    `verify` is left at its default on purpose: TLS validation is what stands in
    for checking the ID token's signature.
    """
    return httpx.Client(timeout=timeout)


def fetch_metadata(issuer, timeout=DISCOVERY_TIMEOUT_SECONDS):
    """Read the realm's discovery document. Raises `AuthError` with the reason."""
    if not issuer:
        raise AuthError("No issuer URL is configured.")
    try:
        with http_client(timeout) as client:
            response = client.get(discovery_url(issuer))
        response.raise_for_status()
        metadata = response.json()
    except httpx.HTTPStatusError as error:
        raise AuthError(
            f"The issuer answered {error.response.status_code} for "
            f"{discovery_url(issuer)}."
        ) from error
    except httpx.ConnectError as error:
        # The corporate-CA case lands here: httpx trusts `certifi`, not the
        # Windows store, so a private CA fails while the browser succeeds.
        raise AuthError(
            f"Could not reach {discovery_url(issuer)} -- {error}. Check the VPN, "
            "and whether the realm's certificate is signed by a private CA."
        ) from error
    except httpx.HTTPError as error:
        raise AuthError(f"Could not read the discovery document -- {error}.") from error
    except ValueError as error:
        raise AuthError("The discovery document is not JSON.") from error

    for field in ("issuer", "authorization_endpoint", "token_endpoint"):
        if not metadata.get(field):
            raise AuthError(f"The discovery document names no `{field}`.")
    return metadata


def check_transport(metadata, settings=None):
    """Refuse a plain-http token endpoint, which the no-signature rule needs TLS for."""
    if urlsplit(metadata["token_endpoint"]).scheme == "https":
        return
    if allows_http(settings):
        return
    raise AuthError(
        "The token endpoint is not https. The ID token's signature is not checked "
        "locally, which is only sound over TLS. Tick \"Accept a plain-http realm\" "
        f"on the Sign-in page, or set {ENV_ALLOW_HTTP}=1, to accept this on a "
        "development realm."
    )


def authorize_url(metadata, client_id, redirect_uri, state, nonce, scope="openid profile email"):
    """Where to send the browser to sign in."""
    query = urlencode({
        "client_id": client_id,
        "response_type": "code",
        "scope": scope,
        "redirect_uri": redirect_uri,
        "state": state,
        "nonce": nonce,
    })
    return f"{metadata['authorization_endpoint']}?{query}"


def logout_url(metadata, post_logout_uri, client_id):
    """Keycloak's end-session URL, or None when the realm publishes none."""
    endpoint = metadata.get("end_session_endpoint")
    if not endpoint:
        return None
    query = urlencode({"post_logout_redirect_uri": post_logout_uri, "client_id": client_id})
    return f"{endpoint}?{query}"


def exchange_code(metadata, client_id, secret, code, redirect_uri,
                  timeout=DISCOVERY_TIMEOUT_SECONDS, settings=None):
    """Swap an authorization code for tokens. Back channel, client secret, TLS."""
    check_transport(metadata, settings)
    try:
        with http_client(timeout) as client:
            response = client.post(
                metadata["token_endpoint"],
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "client_id": client_id,
                    "client_secret": secret,
                },
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as error:
        raise AuthError(f"The token endpoint could not be reached -- {error}.") from error

    if response.status_code != 200:
        # Keycloak names the fault in the body, and it is nearly always the
        # redirect URI not matching the registered one character for character.
        raise AuthError(
            f"The token exchange was refused ({response.status_code}): "
            f"{response.text[:300]}"
        )
    try:
        payload = response.json()
    except ValueError as error:
        raise AuthError("The token endpoint did not answer with JSON.") from error
    if not payload.get("id_token"):
        raise AuthError("The token response carries no id_token.")
    return payload


def decode_segment(segment):
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def claims_from_id_token(id_token):
    """Read an ID token's claims without checking its signature. See the module docstring."""
    parts = id_token.split(".")
    if len(parts) != 3:
        raise AuthError("The id_token is not a JWT.")
    try:
        return json.loads(decode_segment(parts[1]))
    except (ValueError, TypeError) as error:
        raise AuthError("The id_token's payload is not readable JSON.") from error


def check_claims(claims, issuer, client_id, nonce, now=None):
    """Validate iss, aud, exp and nonce. Raises `AuthError` naming what failed."""
    now = time.time() if now is None else now

    if claims.get("iss") != issuer:
        raise AuthError(
            f"The token's issuer is {claims.get('iss')!r}, not the configured "
            f"{issuer!r}."
        )

    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if client_id not in audiences:
        raise AuthError("The token was not issued for this client.")
    # Only meaningful when several audiences are present; checked because the
    # spec asks for it and it costs one line.
    if len(audiences) > 1 and claims.get("azp") not in (None, client_id):
        raise AuthError("The token's authorized party is another client.")

    expiry = claims.get("exp")
    if not isinstance(expiry, (int, float)):
        raise AuthError("The token carries no expiry.")
    if now > expiry + CLOCK_SKEW_SECONDS:
        raise AuthError("The token has expired.")

    if nonce and claims.get("nonce") != nonce:
        raise AuthError("The token's nonce does not match this sign-in.")
    return claims


# --- the cookie --------------------------------------------------------------

# Signed, never encrypted: it carries no secret, only who you are and until when.
# Nothing is stored server-side, so signing out is deleting it and there is
# nothing to repair when the signing key changes.


def _sign(body, key):
    return hmac.new(key.encode(), body, hashlib.sha256).digest()


def seal(payload, key):
    """Sign a small dict into a cookie value."""
    body = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True).encode()).rstrip(b"=")
    signature = base64.urlsafe_b64encode(_sign(body, key)).rstrip(b"=")
    return f"{body.decode()}.{signature.decode()}"


def unseal(value, key, now=None):
    """Read a sealed cookie, or None when it is tampered with, stale or malformed."""
    now = time.time() if now is None else now
    if not value or "." not in value:
        return None
    body, _, signature = value.rpartition(".")
    try:
        expected = base64.urlsafe_b64encode(_sign(body.encode(), key)).rstrip(b"=").decode()
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(decode_segment(body))
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if now > payload.get("exp", 0):
        return None
    return payload


def new_session(claims, identity_claim, hours=SESSION_HOURS, now=None):
    """The cookie payload for a signed-in person: subject, name, expiry."""
    now = time.time() if now is None else now
    return {
        "sub": str(claims.get("sub", "")),
        "name": identity_of(claims, identity_claim),
        "exp": int(now + hours * 3600),
    }


def new_transaction(state, nonce, destination, arming, minutes=TRANSACTION_MINUTES, now=None):
    """The cookie payload carrying one in-flight sign-in."""
    now = time.time() if now is None else now
    return {
        "state": state,
        "nonce": nonce,
        "next": destination,
        "arm": bool(arming),
        "exp": int(now + minutes * 60),
    }


def random_token():
    return secrets.token_urlsafe(24)

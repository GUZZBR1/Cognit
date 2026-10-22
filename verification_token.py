"""Server-side, single-use verification tokens.

Call ``issue`` only after the server has authorized the application, session,
and action. The token is a short-lived HMAC-SHA256 signed claim set; it is not
an authorization decision by itself.

The default nonce store is atomic within one process. Multi-process or
multi-host deployments must provide a shared ``NonceStore`` whose
``consume_once`` operation is atomic across all verifiers.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from collections.abc import Callable, Mapping
from typing import Protocol


_TOKEN_VERSION = 1
_MAX_TOKEN_BYTES = 8192
_MAX_TTL_SECONDS = 300
_INVALID_TOKEN = "invalid verification token"


class VerificationError(ValueError):
    """Raised when a token is malformed, invalid, expired, or already used."""


class NonceStore(Protocol):
    """Storage that atomically permits a nonce to be consumed only once."""

    def consume_once(self, nonce: str, expires_at: int, now: int) -> bool:
        """Return true once for a nonce that has not expired or been consumed."""


class InMemoryNonceStore:
    """Thread-safe, process-local nonce store for single-process deployments."""

    def __init__(self) -> None:
        self._consumed: dict[str, int] = {}
        self._lock = threading.Lock()

    def consume_once(self, nonce: str, expires_at: int, now: int) -> bool:
        with self._lock:
            expired = [key for key, expiry in self._consumed.items() if expiry <= now]
            for key in expired:
                del self._consumed[key]

            if nonce in self._consumed or expires_at <= now:
                return False

            self._consumed[nonce] = expires_at
            return True


class VerificationTokenService:
    """Issue and consume tokens bound to one application, site, session, action.

    ``application_secrets`` must contain server-held keys of at least 32 bytes.
    Supply a shared ``nonce_store`` when multiple processes must coordinate
    replay protection. The default expiry is 60 seconds and may be configured
    up to five minutes.
    """

    def __init__(
        self,
        application_secrets: Mapping[str, bytes],
        *,
        token_ttl_seconds: int = 60,
        nonce_store: NonceStore | None = None,
        clock: Callable[[], float] = time.time,
        nonce_factory: Callable[[], str] | None = None,
    ) -> None:
        if not isinstance(token_ttl_seconds, int) or not 1 <= token_ttl_seconds <= _MAX_TTL_SECONDS:
            raise ValueError("token_ttl_seconds must be between 1 and 300")
        if not application_secrets:
            raise ValueError("at least one application secret is required")

        self._application_secrets: dict[str, bytes] = {}
        for application_id, secret in application_secrets.items():
            self._require_identifier(application_id, "application_id")
            if not isinstance(secret, bytes) or len(secret) < 32:
                raise ValueError("application secrets must contain at least 32 bytes")
            self._application_secrets[application_id] = secret

        self._ttl = token_ttl_seconds
        self._nonce_store = nonce_store if nonce_store is not None else InMemoryNonceStore()
        self._clock = clock
        self._nonce_factory = nonce_factory or (lambda: secrets.token_urlsafe(32))

    def issue(
        self,
        *,
        application_id: str,
        site_id: str,
        session_id: str,
        action: str,
    ) -> str:
        """Sign an already-authorized server-side request for one use."""
        self._require_identifier(application_id, "application_id")
        self._require_identifier(site_id, "site_id")
        self._require_identifier(session_id, "session_id")
        self._require_identifier(action, "action")
        secret = self._application_secrets.get(application_id)
        if secret is None:
            raise ValueError("unknown application")

        issued_at = int(self._clock())
        claims = {
            "v": _TOKEN_VERSION,
            "application_id": application_id,
            "site_id": site_id,
            "session_id": session_id,
            "action": action,
            "issued_at": issued_at,
            "expires_at": issued_at + self._ttl,
            "nonce": self._nonce_factory(),
        }
        self._require_identifier(claims["nonce"], "nonce")
        payload = self._encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
        signature = self._encode(hmac.new(secret, payload.encode("ascii"), hashlib.sha256).digest())
        return f"v{_TOKEN_VERSION}.{payload}.{signature}"

    def verify_and_consume(
        self,
        token: str,
        *,
        application_id: str,
        site_id: str,
        session_id: str,
        action: str,
    ) -> dict[str, str | int]:
        """Validate server-known bindings and atomically consume the token nonce.

        The expected binding values must come from the server-side request and
        session context, not from the token or a client-side verification result.
        """
        try:
            self._require_identifier(application_id, "application_id")
            self._require_identifier(site_id, "site_id")
            self._require_identifier(session_id, "session_id")
            self._require_identifier(action, "action")
            secret = self._application_secrets.get(application_id)
            if secret is None or not isinstance(token, str) or len(token) > _MAX_TOKEN_BYTES:
                raise VerificationError(_INVALID_TOKEN)

            version, payload, supplied_signature = token.split(".")
            if version != f"v{_TOKEN_VERSION}":
                raise VerificationError(_INVALID_TOKEN)
            signature = self._decode(supplied_signature)
            expected_signature = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).digest()
            if not hmac.compare_digest(signature, expected_signature):
                raise VerificationError(_INVALID_TOKEN)

            claims = json.loads(self._decode(payload).decode("utf-8"))
            expected_fields = {
                "v",
                "application_id",
                "site_id",
                "session_id",
                "action",
                "issued_at",
                "expires_at",
                "nonce",
            }
            if not isinstance(claims, dict) or set(claims) != expected_fields:
                raise VerificationError(_INVALID_TOKEN)
            if type(claims["v"]) is not int or claims["v"] != _TOKEN_VERSION:
                raise VerificationError(_INVALID_TOKEN)
            if any(not isinstance(claims[field], str) or not claims[field] for field in (
                "application_id", "site_id", "session_id", "action", "nonce"
            )):
                raise VerificationError(_INVALID_TOKEN)
            if any(type(claims[field]) is not int for field in ("issued_at", "expires_at")):
                raise VerificationError(_INVALID_TOKEN)

            now = int(self._clock())
            issued_at = claims["issued_at"]
            expires_at = claims["expires_at"]
            if (
                issued_at > now
                or expires_at <= now
                or expires_at <= issued_at
                or expires_at - issued_at > self._ttl
            ):
                raise VerificationError(_INVALID_TOKEN)

            if (
                claims["application_id"] != application_id
                or claims["site_id"] != site_id
                or claims["session_id"] != session_id
                or claims["action"] != action
            ):
                raise VerificationError(_INVALID_TOKEN)

        except VerificationError:
            raise
        except (UnicodeError, ValueError, TypeError, KeyError, AttributeError, json.JSONDecodeError):
            raise VerificationError(_INVALID_TOKEN) from None

        if not self._nonce_store.consume_once(claims["nonce"], expires_at, now):
            raise VerificationError(_INVALID_TOKEN)
        return claims

    @staticmethod
    def _require_identifier(value: object, name: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")

    @staticmethod
    def _encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")

    @staticmethod
    def _decode(value: str) -> bytes:
        if not value or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for char in value):
            raise ValueError("invalid base64url segment")
        decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        if VerificationTokenService._encode(decoded) != value:
            raise ValueError("non-canonical base64url segment")
        return decoded

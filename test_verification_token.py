import base64
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from verification_token import (
    InMemoryNonceStore,
    VerificationError,
    VerificationTokenService,
)


SECRET = b"test-only-secret-key-with-at-least-32-bytes"
EXPECTED = {
    "application_id": "app-1",
    "site_id": "site-1",
    "session_id": "session-1",
    "action": "submit-answer",
}


class MutableClock:
    def __init__(self, now: int) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now


class VerificationTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = MutableClock(1_800_000_000)
        self.service = VerificationTokenService(
            {"app-1": SECRET}, clock=self.clock, token_ttl_seconds=60
        )

    def issue(self) -> str:
        return self.service.issue(**EXPECTED)

    def verify(self, token: str, **overrides: str) -> dict[str, str | int]:
        return self.service.verify_and_consume(token, **(EXPECTED | overrides))

    def test_matching_token_succeeds_once_and_replay_is_rejected(self) -> None:
        token = self.issue()
        claims = self.verify(token)
        self.assertEqual(claims["application_id"], "app-1")
        with self.assertRaises(VerificationError):
            self.verify(token)

    def test_token_binds_application_site_session_and_action(self) -> None:
        for field, wrong_value in (
            ("application_id", "app-2"),
            ("site_id", "site-2"),
            ("session_id", "session-2"),
            ("action", "delete-account"),
        ):
            with self.subTest(field=field):
                token = self.issue()
                with self.assertRaises(VerificationError):
                    self.verify(token, **{field: wrong_value})
                # A mismatched request cannot consume a token meant for the valid request.
                self.verify(token)

    def test_expired_and_future_issued_tokens_are_rejected(self) -> None:
        token = self.issue()
        self.clock.now += 60
        with self.assertRaises(VerificationError):
            self.verify(token)

        future_clock = MutableClock(1_800_000_000)
        future_service = VerificationTokenService(
            {"app-1": SECRET}, clock=future_clock, token_ttl_seconds=60
        )
        future_token = future_service.issue(**EXPECTED)
        future_clock.now -= 1
        with self.assertRaises(VerificationError):
            future_service.verify_and_consume(future_token, **EXPECTED)

    def test_tampered_payload_or_signature_is_rejected(self) -> None:
        token = self.issue()
        version, payload, signature = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        claims["action"] = "other-action"
        changed_payload = base64.urlsafe_b64encode(
            json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
        ).rstrip(b"=").decode()
        with self.assertRaises(VerificationError):
            self.verify(f"{version}.{changed_payload}.{signature}")

        changed_signature = ("A" if signature[0] != "A" else "B") + signature[1:]
        with self.assertRaises(VerificationError):
            self.verify(f"{version}.{payload}.{changed_signature}")

    def test_noncanonical_signature_encoding_is_rejected(self) -> None:
        token = self.issue()
        version, payload, signature = token.split(".")
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        last_index = alphabet.index(signature[-1])
        alternative = alphabet[(last_index & 0b110000) | ((last_index + 1) & 0b001111)]
        changed_signature = signature[:-1] + alternative
        self.assertNotEqual(changed_signature, signature)
        with self.assertRaises(VerificationError):
            self.verify(f"{version}.{payload}.{changed_signature}")

    def test_malformed_token_and_unknown_application_are_rejected(self) -> None:
        with self.assertRaises(VerificationError):
            self.verify("not-a-token")
        with self.assertRaises(VerificationError):
            self.service.verify_and_consume(
                self.issue(), **(EXPECTED | {"application_id": "unknown"})
            )

    def test_nonce_is_consumed_by_at_most_one_concurrent_verification(self) -> None:
        token = self.issue()
        barrier = threading.Barrier(2)

        def verify() -> bool:
            barrier.wait()
            try:
                self.verify(token)
                return True
            except VerificationError:
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: verify(), range(2)))
        self.assertEqual(sum(results), 1)

    def test_nonce_store_releases_expired_entries(self) -> None:
        store = InMemoryNonceStore()
        self.assertTrue(store.consume_once("nonce", expires_at=10, now=1))
        self.assertFalse(store.consume_once("nonce", expires_at=20, now=2))
        self.assertTrue(store.consume_once("nonce", expires_at=20, now=10))

    def test_nonce_store_errors_remain_visible(self) -> None:
        class BrokenNonceStore:
            def consume_once(self, nonce: str, expires_at: int, now: int) -> bool:
                raise ValueError("nonce backend unavailable")

        service = VerificationTokenService(
            {"app-1": SECRET}, clock=self.clock, nonce_store=BrokenNonceStore()
        )
        token = service.issue(**EXPECTED)
        with self.assertRaisesRegex(ValueError, "nonce backend unavailable"):
            service.verify_and_consume(token, **EXPECTED)

    def test_secret_and_ttl_configuration_are_bounded(self) -> None:
        with self.assertRaises(ValueError):
            VerificationTokenService({"app-1": b"short"})
        with self.assertRaises(ValueError):
            VerificationTokenService({"app-1": SECRET}, token_ttl_seconds=301)


if __name__ == "__main__":
    unittest.main()

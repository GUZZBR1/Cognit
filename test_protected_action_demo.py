import http.cookiejar
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

from examples.protected_action_demo import DemoServer, Handler


class ProtectedActionDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = DemoServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.client = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.client.open(self.base + "/")

    def request(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = Request(
            self.base + path,
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with self.client.open(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def challenge(self):
        status, challenge = self.request("/api/challenge")
        self.assertEqual(status, 200)
        return challenge

    def test_correct_challenge_issues_and_consumes_token_for_action(self):
        challenge = self.challenge()
        status, verified = self.request("/api/verify", {
            "challenge_id": challenge["challenge_id"], "answer": "azul"
        })
        self.assertEqual(status, 200)
        self.assertEqual(verified["status"], "verified")
        self.assertTrue(verified["token"])
        status, duplicate_verification = self.request("/api/verify", {
            "challenge_id": challenge["challenge_id"], "answer": "azul"
        })
        self.assertEqual(status, 403)
        self.assertEqual(duplicate_verification["status"], "secondary_verification_required")

        status, released = self.request("/api/action", {"token": verified["token"]})
        self.assertEqual(status, 200)
        self.assertEqual(released["status"], "released")
        self.assertEqual(released["payload"], "Código protegido: ORBIT-42")
        status, replay = self.request("/api/action", {"token": verified["token"]})
        self.assertEqual(status, 403)
        self.assertEqual(replay["status"], "blocked")

    def test_wrong_answer_routes_to_secondary_verification_without_token(self):
        challenge = self.challenge()
        status, failed = self.request("/api/verify", {
            "challenge_id": challenge["challenge_id"], "answer": "vermelho"
        })
        self.assertEqual(status, 403)
        self.assertEqual(failed["status"], "secondary_verification_required")
        status, secondary = self.request("/api/secondary-verification")
        self.assertEqual(status, 200)
        self.assertEqual(secondary["status"], "secondary_verification_required")
        status, action = self.request("/api/action", {})
        self.assertEqual(status, 403)
        self.assertEqual(action["status"], "blocked")

    def test_client_state_without_token_and_wrong_challenge_cannot_release_action(self):
        challenge = self.challenge()
        status, action = self.request("/api/action", {"released": True, "verified": True})
        self.assertEqual(status, 403)
        self.assertNotIn("payload", action)

        status, rejected = self.request("/api/verify", {
            "challenge_id": "client-substituted", "answer": "azul"
        })
        self.assertEqual(status, 403)
        self.assertEqual(rejected["status"], "secondary_verification_required")
        status, action = self.request("/api/action", {"released": True})
        self.assertEqual(status, 403)
        self.assertEqual(action["status"], "blocked")
        self.assertNotIn("payload", action)


if __name__ == "__main__":
    unittest.main()

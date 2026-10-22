#!/usr/bin/env python3
"""Runnable stdlib-only mock for docs/api/verification-v0.yaml.

This deliberately does not implement or call Cognit's verification engines.
It demonstrates the five HTTP operations and their request/response shapes only.
Run `python3 examples/verification_api_mock.py --demo` for a complete local flow.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.request import Request, urlopen
import uuid


sessions: dict[str, dict] = {}
challenges: dict[str, dict] = {}
tokens: dict[str, dict] = {}
API_KEY = "mock-app-key"


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self.headers.get("Authorization") != f"Bearer {API_KEY}":
            self.send_json(401, {"error": {"code": "unauthorized", "message": "Invalid app key"}})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": {"code": "invalid_request", "message": "Invalid JSON"}})
            return

        if self.path == "/v0/sessions":
            session_id = str(uuid.uuid4())
            sessions[session_id] = {"state": "active", "attempt_state": "pending", "site_id": body.get("site_id")}
            self.send_json(201, {"session_id": session_id, "state": "active", "attempt_state": "pending", "expires_at": "2030-01-01T00:00:00Z"})
            return

        parts = self.path.strip("/").split("/")
        if len(parts) == 4 and parts[0] == "v0" and parts[1] == "sessions":
            session_id, operation = parts[2], parts[3]
            session = sessions.get(session_id)
            if session is None:
                self.send_json(404, {"error": {"code": "not_found", "message": "Session not found"}})
                return
            if operation == "challenge":
                challenge_id = str(uuid.uuid4())
                challenges[challenge_id] = {"session_id": session_id, "answer": "blue"}
                self.send_json(200, {"challenge_id": challenge_id, "stimulus": "mock grid", "question": "Which color?", "choices": ["blue", "red"], "order": ["top-left", "bottom-right"], "duration_ms": 100, "expires_at": "2030-01-01T00:00:00Z"})
            elif operation == "result":
                challenge = challenges.get(body.get("challenge_id"))
                if challenge is None or challenge["session_id"] != session_id:
                    self.send_json(404, {"error": {"code": "not_found", "message": "Challenge not found"}})
                    return
                accepted = body.get("answer") == challenge["answer"]
                session["attempt_state"] = "succeeded" if accepted else "failed"
                self.send_json(200, {"result_id": str(uuid.uuid4()), "accepted": accepted, "state": session["attempt_state"]})
            elif operation == "verify":
                self.send_json(200, {"session_id": session_id, "state": session["state"], "attempt_state": session["attempt_state"]})
            else:
                self.send_json(404, {"error": {"code": "not_found", "message": "Operation not found"}})
            return

        if self.path == "/v0/tokens/validate":
            token = tokens.get(body.get("token"))
            expected = (body.get("site_id"), body.get("session_id"), body.get("action"))
            if token is None or token["claims"] != expected or token["used"]:
                self.send_json(400, {"error": {"code": "invalid_token", "message": "Token invalid or already used"}})
                return
            token["used"] = True
            self.send_json(200, {"valid": True, "action": expected[2], "expires_at": "2030-01-01T00:00:00Z"})
            return
        self.send_json(404, {"error": {"code": "not_found", "message": "Route not found"}})

    def log_message(self, _format: str, *_args) -> None:
        # Keep the mock quiet; a real service should avoid logging request bodies,
        # answers, tokens, credentials, or telemetry.
        pass


def demo() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/v0"

    def post(path: str, payload: dict) -> dict:
        request = Request(f"{base}{path}", data=json.dumps(payload).encode(), method="POST", headers={
            "Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"
        })
        with urlopen(request) as response:
            return json.load(response)

    try:
        session = post("/sessions", {"site_id": "demo-site", "ttl_seconds": 600})
        challenge = post(f"/sessions/{session['session_id']}/challenge", {"challenge_type": "mock-choice"})
        result = post(f"/sessions/{session['session_id']}/result", {"challenge_id": challenge["challenge_id"], "answer": "blue"})
        verification = post(f"/sessions/{session['session_id']}/verify", {})
        demo_token = "mock-token-for-demonstration"
        tokens[demo_token] = {"claims": ("demo-site", session["session_id"], "demo-action"), "used": False}
        validation = post("/tokens/validate", {"token": demo_token, "site_id": "demo-site", "session_id": session["session_id"], "action": "demo-action"})
        print(json.dumps({"session": session, "challenge": challenge, "result": result, "verification": verification, "token_validation": validation}, indent=2))
    finally:
        server.shutdown()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="run the five-operation flow against the local mock")
    args = parser.parse_args()
    if args.demo:
        demo()
    else:
        ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()

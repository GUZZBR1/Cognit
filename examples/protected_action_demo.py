#!/usr/bin/env python3
"""Run a tiny HTTP demo of a server-protected action.

Start with ``python3 examples/protected_action_demo.py`` and open
http://127.0.0.1:8080. This is an educational, single-process example.
"""

from __future__ import annotations

import json
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import sys
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from verification_token import VerificationError, VerificationTokenService


APP_ID = "protected-action-demo"
SITE_ID = "local-demo-site"
ACTION = "reveal-secret"
SECRET = secrets.token_bytes(32)
TOKENS = VerificationTokenService({APP_ID: SECRET})
LOCK = threading.Lock()
SESSIONS: dict[str, dict] = {}


def session_for(handler: BaseHTTPRequestHandler) -> str | None:
    cookies = SimpleCookie(handler.headers.get("Cookie", ""))
    morsel = cookies.get("demo_session")
    session_id = morsel.value if morsel else None
    if session_id in SESSIONS:
        return session_id
    return None


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, body: dict, *, cookie: str | None = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/":
            payload = (ROOT / "protected-action-demo.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            if session_for(self) is None:
                session_id = uuid.uuid4().hex
                with LOCK:
                    SESSIONS[session_id] = {"challenge": None, "verified": False, "released": False}
                self.send_header("Set-Cookie", f"demo_session={session_id}; HttpOnly; SameSite=Strict; Path=/")
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/src/protected-action-demo.js":
            payload = (ROOT / "src/protected-action-demo.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/api/challenge":
            session_id = self.get_session()
            if session_id is None:
                return
            challenge_id = uuid.uuid4().hex
            with LOCK:
                SESSIONS[session_id].update(challenge=challenge_id, verified=False, failed=False)
            self.send_json(200, {
                "challenge_id": challenge_id,
                "question": "Qual é a cor do quadrado?",
                "choices": ["azul", "vermelho"],
            })
        elif self.path == "/api/secondary-verification":
            session_id = self.get_session()
            if session_id is None:
                return
            with LOCK:
                failed = SESSIONS[session_id].get("failed")
            if not failed:
                self.send_json(409, {"status": "no_secondary_check", "message": "Não há falha pendente."})
                return
            self.send_json(200, {
                "status": "secondary_verification_required",
                "message": "A resposta não foi confirmada. Tente um novo desafio; a ação continua bloqueada.",
            })
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        session_id = self.get_session()
        if session_id is None:
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "invalid_json"})
            return

        if self.path == "/api/verify":
            with LOCK:
                state = SESSIONS[session_id]
                if body.get("challenge_id") != state.get("challenge"):
                    if not state.get("verified"):
                        state.update(challenge=None, verified=False, failed=True)
                    self.send_json(403, {"status": "secondary_verification_required"})
                    return
                if body.get("answer") != "azul":
                    state.update(challenge=None, verified=False, failed=True)
                    self.send_json(403, {"status": "secondary_verification_required"})
                    return
                # A challenge authorizes at most one token issuance.
                state.update(challenge=None, verified=True, failed=False)
            # All bindings come from this server module and its session cookie.
            token = TOKENS.issue(
                application_id=APP_ID,
                site_id=SITE_ID,
                session_id=session_id,
                action=ACTION,
            )
            self.send_json(200, {"status": "verified", "token": token})
        elif self.path == "/api/action":
            token = body.get("token")
            try:
                TOKENS.verify_and_consume(
                    token,
                    application_id=APP_ID,
                    site_id=SITE_ID,
                    session_id=session_id,
                    action=ACTION,
                )
            except (VerificationError, ValueError, TypeError):
                self.send_json(403, {"status": "blocked", "message": "Verificação ausente, inválida ou já usada."})
                return
            with LOCK:
                state = SESSIONS[session_id]
                if not state.get("verified") or state.get("released"):
                    self.send_json(403, {"status": "blocked"})
                    return
                state["released"] = True
            self.send_json(200, {
                "status": "released",
                "payload": "Código protegido: ORBIT-42",
                "message": "Ação protegida liberada pelo servidor.",
            })
        else:
            self.send_json(404, {"error": "not_found"})

    def get_session(self) -> str | None:
        session_id = session_for(self)
        if session_id is None:
            self.send_json(401, {"error": "session_required"})
        return session_id

    def log_message(self, _format: str, *_args) -> None:
        pass


class DemoServer(ThreadingHTTPServer):
    daemon_threads = True


def main() -> None:
    server = DemoServer(("127.0.0.1", 8080), Handler)
    print("Protected action demo: http://127.0.0.1:8080")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

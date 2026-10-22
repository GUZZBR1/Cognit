# Protected action demo

This minimal local site demonstrates one protected action. The browser submits a challenge answer to the Python server. Only after the server checks the answer does it issue a short-lived token bound to the server's application, site, session cookie, and action. The action endpoint validates and consumes that token through `VerificationTokenService`; replaying it fails.

The answer is `azul`. An incorrect answer routes to the secondary-verification message and issues no token. Editing browser state cannot unlock the action because only the server's `/api/action` response controls the protected content, and that endpoint requires a valid one-time token.

## Run locally

From the repository root, run:

```sh
python3 examples/protected_action_demo.py
```

Open <http://127.0.0.1:8080>. Select **azul** to release the action. Select **vermelho** to see the secondary-verification path, then use **Novo desafio** to retry. Stop the server with Ctrl-C.

The app secret is generated and kept in the Python process; it is never sent to the page. This demo uses an in-memory session map and nonce store for one local process. Production deployments need persistent session handling, a shared atomic nonce store across server instances, HTTPS, and normal authentication/authorization around protected business actions.

## Focused tests

```sh
python3 -m unittest -v test_protected_action_demo.py
```

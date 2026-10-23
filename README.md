# Cognit

Cognit is a human-presence verification product library with a browser SDK and a Go reference verification service.

## Product components

- `src/cognit/client-sdk.ts` is the typed browser client. `npm run build:sdk` emits browser JavaScript and declarations in `dist/`.
- `src/reaction-time-collector.mjs` and `src/mouse-telemetry.mjs` collect attempt timing and derived mouse features.
- `browser-automation-signals.js` reports heuristic browser signals. A signal is not proof of automation, and an empty result does not prove human presence.
- `challenge/`, `journey/`, `go/session/`, `go/decisionpolicy/`, `risk_score/`, and `verificationtoken/` contain independently testable Go components.
- `docs/api/verification-v0.yaml` defines the application-facing verification API contract.

Keep signing secrets and final policy decisions on the server. Treat browser signals and risk assessments as uncertain evidence; use `UNKNOWN` when evidence is insufficient.

## Run the reference verification API

The Go server is an in-memory, single-process example requiring Go 1.22 or newer. It uses a bearer key and a separate token signing secret, each at least 32 bytes:

```sh
export COGNIT_APP_KEY='replace-this-with-a-secret-of-at-least-32-bytes'
export COGNIT_SIGNING_SECRET='replace-with-a-separate-random-secret-at-least-32-bytes'
go run ./cmd/verification-server
```

With `curl` and `jq`, these requests create a session, complete the sample challenge, retrieve the server-issued token, and validate it once for the `default` action:

```sh
base=http://localhost:8080/v0
auth="Authorization: Bearer $COGNIT_APP_KEY"

session=$(curl -sS -X POST "$base/sessions" -H "$auth" -H 'Content-Type: application/json' \
  -d '{"site_id":"demo-site"}' | jq -r .session_id)
challenge=$(curl -sS -X POST "$base/sessions/$session/challenge" -H "$auth" -H 'Content-Type: application/json' \
  -d '{"challenge_type":"choice"}')
challenge_id=$(jq -r .challenge_id <<<"$challenge")
curl -sS -X POST "$base/sessions/$session/result" -H "$auth" -H 'Content-Type: application/json' \
  -d "{\"challenge_id\":\"$challenge_id\",\"answer\":\"blue\",\"reaction_time_ms\":900}"
token=$(curl -sS -X POST "$base/sessions/$session/verify" -H "$auth" | jq -r .token)
curl -sS -X POST "$base/tokens/validate" -H "$auth" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$token\",\"site_id\":\"demo-site\",\"session_id\":\"$session\",\"action\":\"default\"}"
```

The token is withheld until the session succeeds. Validation checks the application, site, session, action, expiry, and one-use nonce. The sample challenge always expects `blue` and is for protocol demonstration only. Sessions, request quotas, and consumed-token tracking are process-local; shared storage, atomic cross-instance transitions, and distributed quotas are required before multi-instance deployment.

## Browser SDK mock

Build and test the SDK, then start its local mock server:

```sh
npm install
npm run build:sdk
npm run test:sdk
node examples/browser/mock-server.mjs
```

Open `http://127.0.0.1:4173` and choose **Run mock flow**. The mock does not contact a real verification server.

## Validation

- Root Go packages: `go test ./...`
- Nested Go modules: run `go test ./...` inside `go/session` and `go/decisionpolicy`.
- Browser SDK: `npm run test:sdk`

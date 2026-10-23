# Cognit

Cognit is a human-presence verification product library. This repository contains the runtime building blocks for challenges, session and journey state, behavioral signals, risk and policy evaluation, browser integration, and signed verification tokens.

## Product components

- `src/cognit/client-sdk.js` is the browser client for a host application's verification service.
- `src/fixed-challenges.js`, `src/seeded-generator.js`, `challenge_generator.py`, and `challenge_mutations.mjs` provide fixed and reproducible challenge generation.
- `src/reaction-time-collector.mjs` and `src/mouse-telemetry.mjs` collect attempt timing and return derived mouse features without retaining raw trajectories.
- `browser-automation-signals.js` reports heuristic browser signals. An individual signal is not proof of automation, and an empty result does not prove human presence.
- `src/cognit/session-engine.ts` and `journey_tracker.py` provide session state and an event timeline.
- `risk_score.py` combines available evidence into an advisory score. `decision_policy.py` maps it to configured `ALLOW`, `CHALLENGE`, `RESTRICT`, `BLOCK`, or `UNKNOWN` outcomes.
- `verification_token.py` issues and validates server-side, action-bound, expiring, one-use signed tokens.
- `docs/api/verification-v0.yaml` defines the application-facing verification API contract.

Keep signing secrets and final policy decisions on the server. Supply token claims and expected bindings from trusted server-side context. Treat risk scores and browser signals as uncertain evidence; they do not establish identity or intent. Use `UNKNOWN` when evidence is missing or insufficient.

This repository provides product components and a small Go reference service; it does not include a hosted verification service. Applications must connect the SDK to their own authenticated server implementation.

## Run the reference verification API

The Go server is an in-memory, single-process example requiring Go 1.22 or newer. It uses the Go standard library, a bearer key, and an independent token signing secret, each at least 32 bytes:

```sh
export COGNIT_APP_KEY='replace-this-with-a-secret-of-at-least-32-bytes'
export COGNIT_SIGNING_SECRET='replace-with-a-separate-random-secret-at-least-32-bytes'
go run ./cmd/verification-server
```

With `curl` and `jq`, the following requests create a session, complete the sample challenge, retrieve the server-issued token, and validate it once for the `default` action:

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

The token is omitted by `/verify` until the session succeeds. Validation checks the application, site, session, action, expiry, and one-use nonce. A completed attempt is terminal: repeating `/result` or requesting another challenge returns `invalid_request`; start a new session to try again. Bearer credentials can rotate without changing token signatures, which use the dedicated signing secret.

`server.NewWithAdapters` accepts `SessionStore`, `ChallengeProvider`, `DecisionPolicy`, and `TokenService` through `server.Adapters`; omitted adapters use `MemorySessions`, `SampleChallenges`, `AnswerPolicy`, and `MemoryTokens`. The sample challenge always expects `blue` and demonstrates the protocol only. The server decides acceptance from the private answer and policy; browser-supplied decisions are rejected.

Sessions, request quotas, and consumed-token tracking are process-local and reset on restart. Use shared storage, atomic session transitions, atomic nonce consumption, and distributed quotas before deploying multiple instances. Each application has separate per-operation quotas, configurable through `server.Config`; multiple bearer keys for one application share its quotas. Run checks with `go test ./...` and `go vet ./...`.

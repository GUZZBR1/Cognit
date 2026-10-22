# Cognit

Cognit is an early human-presence verification prototype. The product code in this branch covers perceptual challenges, session and journey state, browser and mouse signals, risk and policy evaluation, server-side verification tokens, and minimal integration demos.

## Run the demos

The SDK flow is available at `integration-demo.html`. From the repository root, start a static server:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/integration-demo.html`. This page uses an in-memory service stub and a fake token for demonstration; it does not authorize a protected action. The SDK sends no secrets and makes no final security decision.

The server-side protected-action example can be run with:

```sh
python3 examples/protected_action_demo.py
```

See `docs/protected-action-demo.md` for its local flow. The API contract is in `docs/api/verification-v0.yaml`; `python3 examples/verification_api_mock.py --demo` runs a local mock of that contract, not a hosted Cognit service.

## Product components

- `src/fixed-challenges.js`, `src/seeded-generator.js`, `challenge_generator.py`, and `challenge_mutations.mjs` define fixed and reproducible challenge generation.
- `src/reaction-time-collector.mjs` and `src/mouse-telemetry.mjs` collect attempt timing and return derived mouse features. `src/feature-pipeline.mjs` wraps mouse features in a versioned, provenance-bearing record; see `docs/feature-pipeline-v1.md`.
- `browser-automation-signals.js` reports heuristic browser signals. A single signal is not proof of automation, and an empty result does not prove a human is present.
- `src/cognit/session-engine.ts`, `src/cognit/history-profile-engine.ts`, and `journey_tracker.py` provide session state, optional app-scoped history, and an event timeline.
- `risk_score.py` combines available evidence into an advisory risk score. `decision_policy.py` maps evidence to configurable `ALLOW`, `CHALLENGE`, `RESTRICT`, `BLOCK`, or `UNKNOWN` outcomes.
- `src/cognit/client-sdk.js` provides the browser integration client. The host application's server remains responsible for authorization and verification.
- `verification_token.py` issues and verifies server-side, action-bound, expiring, one-use signed tokens. Multi-process deployments need a shared nonce store with atomic consume-once behavior.

## Security boundaries

Keep signing secrets and final policy decisions on the server. Supply token claims and expected bindings from trusted server-side context, never from browser state. Treat risk scores and browser signals as evidence with uncertainty; they do not establish a person's identity or intent. Use `UNKNOWN` when evidence is missing or insufficient.

## Checks

Node.js 22.12 or newer is required for the TypeScript syntax checks.

```sh
npm test
npm run test:python
npm run check
```

The test suites use the Node.js and Python standard libraries; no third-party runtime or test dependencies are required.

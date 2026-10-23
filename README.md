# Cognit

Cognit is a human-presence verification product library with a browser SDK, Go runtime components, and an experimental research lab.

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

With `curl` and `jq`, create a session, complete the sample challenge, retrieve the server-issued token, and validate it once for the `default` action. The sample challenge always expects `blue` and is for protocol demonstration only. Sessions, request quotas, and consumed-token tracking are process-local; shared storage, atomic cross-instance transitions, and distributed quotas are required before multi-instance deployment.

## Browser SDK mock

Build and test the SDK, then start its local mock server:

```sh
npm install
npm run build:sdk
npm run test:sdk
node examples/browser/mock-server.mjs
```

Open `http://127.0.0.1:4173` and choose **Run mock flow**. The mock does not contact a real verification server.

## Experimental lab

This branch preserves the test suite and research tools excluded from `main`: controlled Playwright, Selenium, and Puppeteer runners; the human dataset pilot; AI Observer and classifier experiments; feature and session-signature prototypes; and benchmark/evaluation scripts. Browser attack runners are restricted to the local Cognit demo.

Install this branch's development dependencies with `npm install`. Run the suites with `npm test` and `npm run test:python`. The controlled browser runners are available as `npm run run:playwright`, `npm run attack-lab:selenium`, and `npm run attack-lab:puppeteer`.

## Validation

- Root Go packages: `go test ./...`
- Nested Go modules: run `go test ./...` inside `go/session` and `go/decisionpolicy`.
- Browser SDK: `npm run test:sdk`
- Experimental Python: `npm run test:python`

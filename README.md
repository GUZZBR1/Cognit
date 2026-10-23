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

## Experimental browser baseline exports

The existing Playwright, Selenium, and Puppeteer runners execute only the local `cognit-fixed-demo`. Normalize one of their JSON exports without launching a browser:

```sh
npm run export:browser-baseline -- --framework playwright \
  --input /path/to/playwright-results.json \
  --context /path/to/trial-record-v1.json \
  --output browser-baseline-results.json
```

Use `--framework selenium` or `--framework puppeteer` for those runner outputs. The context identifies TrialRecord version `1.0.0`, framework, manifest ID, Cognit commit, protocol version, canonical config and its SHA-256, seed, tool/browser versions, and the controlled demo's loopback origin. The adapter rejects non-loopback targets and requires authored-answer disclosure. The legacy runner output does not attest the observed URL, so `target_origin` is declared context, not execution attestation. It emits `SIMULATED`/`AUTOMATION_CONTROLLED` records with `oracle_access: true`; these are not perception evidence or human ground truth.

Run adapter checks with `npm run test:browser-baseline`. Its schema fixture is local to the adapter and does not define the canonical TrialRecord contract.

## Scripted automation scenarios

Run controlled, reproducible behavior scenarios against local challenge fixtures with `npm run demo:scripted-automation -- --scenario steady --seed demo-1`. Use `--compare bursty` for descriptive summaries or `--config examples/scripted-automation/scenario.example.json` for custom parameter ranges. Records are labeled `SCRIPTED_AUTOMATION` and `SIMULATED`; the runner keeps aggregated cursor features and does not send data to production policy. See [the scenario guide](docs/scripted-automation.md).

## Visual agent adapter (experimental)

The visual adapter is screenshot-only: it gives an agent screenshot bytes and viewport dimensions, then accepts bounded coordinate clicks. It does not provide DOM, selectors, network requests, navigation, challenge fixtures, or expected answers. The Playwright port pins the page to the local `http://127.0.0.1:4173/visual-agent-demo` and allows only the demo document and local script. Other origins and unexpected browser capabilities are blocked. The existing SDK mock API exposes challenge data, so it is not the agent input surface.

Run the deterministic fixture policy and tests with `npm run visual-agent:mock`, `npm run visual-agent:browser-mock`, and `npm run test:visual-agent`. Screenshots are not stored, actions contain coordinates only, sensitive configuration is redacted, and the outcome remains `UNKNOWN` until independent evidence exists. Mock commands are `SIMULATED`; real model execution is not wired yet.

## TrialRecord v1

Validate and export per-attempt experimental records with `npm run test:trial-record-v1` and `TRIAL_RECORD_PSEUDONYM_KEY='replace-with-a-secret-of-at-least-32-characters' node scripts/trial-record.mjs --input fixtures/trial-record-v1/records.json --manifest fixtures/trial-record-v1/manifest.json --output /tmp/cognit-trial-record-v1.jsonl`. The JSONL output is deterministic and hashed; provenance and UNKNOWN labels are preserved, and invalid/oracle records are reported rather than treated as human ground truth. See [the TrialRecord contract](docs/trial-record-v1.md).

## Validation

- Root Go packages: `go test ./...`
- Nested Go modules: run `go test ./...` inside `go/session` and `go/decisionpolicy`.
- Browser SDK: `npm run test:sdk`
- Experimental Python: `npm run test:python`
- Trial Manifest v1 fixtures and validator: `node scripts/trial-manifest.mjs` and `npm run test:trial-manifest` (see [the contract](docs/trial-manifest-v1.md))
- Human confirmation pilot: `npm run test:human-confirmation` and `node examples/human-confirmation/main.js`
- Scripted automation: `npm run test:scripted-automation`

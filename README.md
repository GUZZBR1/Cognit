# Cognit

## Perceptual challenge

A small, client-only perception challenge. Choose an authored pattern and display duration, study it, then answer after it disappears. The result is shown on screen and can be downloaded as JSON.

Serve this directory with any static HTTP server and open `index.html`. For example:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. The app uses native browser modules and has no install step or external dependencies.

## Human dataset pilot

The pilot displays study information and requires explicit consent before a challenge can start. Participation is voluntary and can be withdrawn at any time with **Withdraw and delete**. Withdrawal removes that participant's records from the page's in-memory collection and ends the session. The page does not transmit data or persist it between reloads. If a participant already exported a dataset file, that file is outside the page's control; the participant can use the researcher contact details on the study invitation to request deletion of retained copies.

The dataset uses a random page-session pseudonym and records only challenge/stimulus IDs, display duration, a challenge-allowlisted answer, correctness, response time, consent version/time, and record time. It excludes civil identity, contact details, raw mouse trajectories, and absolute input timestamps. Raw capture is disabled and unavailable. In-memory records expire after 30 days even while the page stays open; the research operator must delete exported copies by then and honor earlier withdrawal requests.

`HUMAN_CONFIRMED` is deliberately absent from participant collection and cannot be set through the page's dataset API. After collection, a study operator may add it to an exported record only after an independent human review of participation (for example, direct observation in a researcher-facilitated session). The operator records the review method, evidence origin, and procedure/reference. Challenge answers, scores, models, and automation signals never establish this label. Missing provenance means the label is omitted. These fields describe the human review trail; they do not establish civil identity.

The operator-added fields have this shape:

```json
{
  "HUMAN_CONFIRMED": true,
  "human_confirmation": {
    "method": "independent human review",
    "origin": "researcher-facilitated session observation",
    "procedure": "study protocol version and observation reference"
  }
}
```

Each completed attempt produces one JSON object:

```json
{
  "challenge_id": "color-count-01",
  "stimulus_id": "grid-blue-01",
  "duration_ms": 100,
  "response": "3",
  "correct": true,
  "reaction_time_ms": 843
}
```

`duration_ms` is the selected exposure duration. `reaction_time_ms` is measured with the browser's monotonic `performance.now()` clock from when the answer prompt becomes available until submission. Browser timers can drift, so this is a lightweight demonstration and not a lab-precision measurement.

Fixed challenges and expected answers are authored in `src/fixed-challenges.js`. The deterministic seed-based generator is an independent API in `src/seeded-generator.js`; the fixed runner does not call it. There is no adaptive generation, person classification, or production threshold.

## Reaction time collector

`ReactionTimeCollector` records the first movement, click, interaction, and response timestamps for one attempt. Pass timestamps from the same monotonic clock in milliseconds (for example, `performance.now()`). Missing event timestamps are returned as `null`. Movement and click events also count as interactions; only the first timestamp for each event is retained.

Call `finish(timestamp)` when the attempt ends. The result includes the stimulus and first-event timestamps plus `totalTime`, calculated as the end timestamp minus the stimulus timestamp. The total therefore remains available when no response was recorded.

```js
import { ReactionTimeCollector } from "./src/reaction-time-collector.mjs";

const attempt = new ReactionTimeCollector(performance.now());
attempt.recordMovement(performance.now());
attempt.recordClick(performance.now());
const result = attempt.finish(performance.now());
```

## Tests

Run the Node.js test suite with Node 22 or newer:

```sh
npm test
```

## Experimental browser automation signals

`browser-automation-signals.js` collects heuristic signals observable in the current page and returns a local JSON result. It sends no network requests, creates no identifier, and does not classify a person as a bot or human. Call `CognitAutomationSignals.collect(window)` from the browser console after loading the script.

Signals include `navigator.webdriver`, known Playwright/Selenium/Puppeteer globals, `cdc_*` markers, a headless Chrome user-agent token, and empty plugin/language lists. Each signal includes evidence and limitations. Individual indicators can be hidden, change across versions, or appear in legitimate testing; an empty result only means that the known indicators were not observed.

The test suite uses simulated browser environments. It validates the result structure and cautious interpretation, not real browser runs of each automation framework.

## Attack Lab browser runners

With Node.js 22.12 or newer and Python 3 installed, install the development dependencies with `npm install`, then run `npm run attack-lab:selenium` and `npm run attack-lab:puppeteer`. Both runners serve Cognit locally and execute the same three authored challenges from `src/fixed-challenges.js` at a 50 ms display duration. Puppeteer uses its downloaded Chrome; Selenium uses Chrome available on the system (Selenium Manager resolves the driver, and `CHROME_BIN` can select a non-default Chrome binary).

Each command writes a JSON run document under `attack-lab/` by default. An optional first argument selects another output path, for example `npm run attack-lab:selenium -- attack-lab/selenium.json`. The document uses the Playwright runner's `schema_version`, `session_id`, `started_at`, `source`, and `attempts` envelope. Each attempt carries the same challenge/stimulus IDs, duration, `mouse_telemetry`, `ground_truth.expected_answer`, and `observed_result` fields, plus framework/browser metadata and browser feature observations. Mouse telemetry uses Cognit's shared aggregator. Both runners validate each observed Cognit result against the authored answer before writing the file.

The document envelope matches Playwright exactly; each attempt extends its row shape with tool/version and feature metadata for direct scenario-level comparison.

## Server-side decision policy

`decision_policy.py` maps a numeric risk score and confidence to a decision using a caller-supplied policy. It does not set production thresholds or make claims about identity or intent. A policy consists of ordered `PolicyRule` score bands (inclusive endpoints), a minimum confidence, and optional signal keys that must be present. The first matching rule wins. Configure bands for `ALLOW`, `CHALLENGE`, `RESTRICT`, `BLOCK`, or `UNKNOWN`; unmatched or insufficient evidence returns `UNKNOWN`.

Scores must be finite numbers from 0 through 100; confidence must be finite from 0 through 1. Missing/invalid inputs, confidence below the configured minimum, missing required signals, and unmatched bands return `UNKNOWN` with a machine-readable reason. Invalid policy configurations raise `ValueError`. Signal values are opaque to this engine: rules test signal presence, not identity, intent, or signal meaning.

Run the Python tests with `python3 -m unittest discover -v`.

## Model evaluation harness

`evaluation_runner.py` runs an existing predictor against labeled cases and
writes a JSON report. Each case supplies `actual_positive`, an `input` value,
and optionally `human_ground_truth`. The evaluator receives only `input` and
returns `predicted_positive` (a boolean or `None` for an unknown result) and an
optional numeric `score` where higher values indicate stronger positive
evidence.

```python
from evaluation_runner import run_evaluation, write_report

cases = [
    {"actual_positive": True, "input": request},
    {"actual_positive": False, "human_ground_truth": True, "input": human_request},
]
report = run_evaluation(cases, existing_predictor, evaluator_name="risk-model-v1")
write_report(report, "evaluation-report.json")
```

The positive class is whatever the caller labels `True` (for example, a case
flagged as automation). Unknown predictions are excluded from confusion-matrix
denominators and reported in `excluded_unknown`. Precision is TP/(TP+FP), recall
is TP/(TP+FN), FPR is FP/(FP+TN), and FNR is FN/(FN+TP); each report entry
includes its numerator and denominator. A zero denominator produces a null
value and an unavailable reason. AUC uses the optional ranking score, handles
ties by average rank, reports positive/negative pair counts, and is unavailable
unless scored rows include both classes. Human FPR is calculated separately
from rows explicitly marked `human_ground_truth: true` whose actual label is
negative and prediction is known; its eligible human denominator is shown in
the report.

Latency measures only the evaluator call, in milliseconds, and reports the
mean, median, and call count. The JSON report omits timestamps and records the
evaluator name. Metric output is stable for the same cases, predictions, and
measured latencies; observed latency naturally varies between real runs. The
harness computes metrics for caller-supplied
models or rules and does not select thresholds or compare feature groups.

## Signed verification tokens

`verification_token.py` provides a framework-neutral server-side token issuer and verifier. Configure one random secret of at least 32 bytes per application on the server; never send these secrets to a client. After the server confirms that a session is authorized for an action, call `VerificationTokenService.issue` with the application, site, session, and action IDs. Send the resulting token to the trusted verification service.

The verifier must supply the expected application, site, session, and action from its own server-side context. `verify_and_consume` checks the HMAC-SHA256 signature, claim bindings, issue and expiry times, then atomically consumes the nonce. A token is accepted once. The default in-memory nonce store is safe for concurrent requests in one process; deployments with multiple processes or hosts must inject a shared store with an atomic `consume_once` operation.

Tokens expire after 60 seconds by default; the configured lifetime can be at most five minutes. Run the Python tests with `python3 -m unittest discover -v`.
## Offline AI observer (shadow mode)

`ai_observer.py` analyzes a minimized JSON export locally and writes an aggregate
report to stdout. It only opens the input for reading; it does not make network
requests, mutate the source, import the decision policy, write policy, or take
part in a live decision. Example:

```sh
python3 ai_observer.py minimized-export.json > observer-report.json
```

Input is JSON schema version 1. `source_id` identifies the dataset origin for
audit purposes. Use a stable export or collection name, not a session or person
identifier. Each record should contain only minimized signal summaries:

```json
{
  "schema_version": 1,
  "source_id": "weekly-minimized-export",
  "records": [
    {"signals": {"browser": {"webdriver": false}, "mouse": {"pause_count": 2}}},
    {"signals": {"browser": {"webdriver": true}, "mouse": {"pause_count": 1}}}
  ]
}
```

Signal groups contain scalar string, boolean, or numeric fields. Null, missing,
and nested values (including raw trajectories) are not analyzed; their aggregate
count is reported. Report field names encode the group and field as a JSON pair
to keep dotted names distinct. The report includes per-field aggregate summaries, repeated
and singleton categorical fingerprint counts, and numeric candidates outside
the dataset's 1.5×IQR fences. Fingerprints and categorical value summaries use
SHA-256 digests so raw categorical values are not copied into the report. These
digests support correlation and provenance checks; they are not anonymization
and can be guessed for low-entropy values.
The output also records the source identifier, canonical input hash, observer
version, configuration, and configuration hash. Identical input and code
version produce a deterministic report.

To compare possible false-positive/negative candidates, include `positive_class`
at the dataset level and an optional `evaluation` on reviewed records. Each
evaluation must provide `prediction` and `reviewed_outcome` (`positive` or
`negative`) plus `review_provenance` with non-empty `method`, `origin`, and
`procedure` fields. The report exposes only aggregate candidate counts; it does
not copy these per-record labels or provenance into the output.

Observations are separate from conclusions; conclusions are always empty.
Outliers and unusual fingerprints are review candidates, not evidence of
automation, malicious intent, or model error. Small or unusable datasets are
marked `insufficient_data`. Missing signals can reflect omission or collection
limits. False-positive/negative counts identify disagreements with externally
supplied, independently reviewed reference outcomes; those outcomes are not
ground truth, and the counts still need human interpretation. Without reviewed
comparisons, the report marks that no candidates can be counted. Do not use
observer output as ground truth or to change live policy or decisions.

Run its tests with `python3 -m unittest test_ai_observer -v` or run the full
Python suite with `python3 -m unittest discover -v`.

## Client SDK v0 integration example

Open `http://localhost:8000/integration-demo.html` to run a complete browser-side flow through `CognitClient`: create a session, retrieve and render a challenge, send aggregated mouse telemetry, submit a response, and poll for the result and verification token. The page uses a clearly labeled in-memory service stub; its response and `demo-token-not-for-production` token are illustrative and authorize no action. The button on the page simulates a network failure so the error state can be seen.

The SDK receives its service URL and `fetch` implementation from the host application. It sends no secret and makes no security decision. Replace the demo stub with an authenticated application backend before using a real service; the backend owns authorization and token issuance. Mouse samples are aggregated in the page with `aggregateMouseAttempt` and only the aggregate features are sent.

Each completed attempt produces one JSON object:

```json
{
  "challenge_id": "color-count-01",
  "stimulus_id": "grid-blue-01",
  "duration_ms": 100,
  "response": "3",
  "correct": true,
  "reaction_time_ms": 843
}
```

`duration_ms` is the selected exposure duration. `reaction_time_ms` is measured with the browser's monotonic `performance.now()` clock from when the answer prompt becomes available until submission. Browser timers can drift, so this is a lightweight demonstration and not a lab-precision measurement.

Fixed challenges and expected answers are authored in `src/fixed-challenges.js`. The deterministic seed-based generator is an independent API in `src/seeded-generator.js`; the fixed runner does not call it. There is no adaptive generation, person classification, or production threshold.


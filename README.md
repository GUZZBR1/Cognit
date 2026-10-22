# Cognit

## Perceptual challenge

A small, client-only perception challenge. Choose an authored pattern and either a timed visual or untimed text presentation, then answer. The result is shown on screen and can be downloaded as JSON.

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

`duration_ms` is the selected exposure duration. `reaction_time_ms` is measured with the browser's monotonic `performance.now()` clock from when the answer prompt becomes available until submission. They are `null` for the untimed text presentation. Browser timers can drift, so this is a lightweight demonstration and not a lab-precision measurement. Both presentations use the same challenge, response, and correctness check; the presentation choice is not part of the result.

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

## Verified ad events

`ad_events.py` defines an allowlisted record for an ad `impression` or `interaction`. Each event has its own opaque `event_id`, an `ad_id`, a timezone-aware occurrence time, and the opaque `verification_result_id` plus `decision_version` that associate it with the result. `verification_result_origin` identifies the verifier that produced the linked result. The event carries the result's finite `confidence` (0–1) and a required `confidence_origin` naming the confidence producer/method; an optional `risk_score` is included only when the result producer provides one. The integration must copy these values from the trusted verification result and must not infer or recalculate them from ad activity.

Confidence here describes the verification result's evidence coverage/reliability as reported by its producer (for example, `risk_score.score_risk.v1`). It is not a probability that a person is human. User-facing copy should describe a result as an estimate that may be wrong, for example: “This result is an estimate based on the available evidence and may be incorrect; it does not confirm a person's identity.” Do not say “100% human” or imply certainty.

The record has no session ID, identity, challenge response, signal details, or raw telemetry fields. Keep linkage to the opaque result reference; do not enrich the event with session data. Ad events are measurement records only and must never be fed into `risk_score.py` or `decision_policy.py`. Raw mouse, browser, timing, and other verification telemetry must not be sent to advertisers.

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

## History/profile v0

`src/cognit/history-profile-engine.ts` accepts an application ID and a pseudonym generated and supplied by that application. It keeps only recent session activity timestamps and optional `succeeded`/`failed` result categories, so applications can use prior outcomes as context. The engine does not generate pseudonyms, accept raw telemetry or personal attributes, persist data, or connect pseudonyms across applications. A pseudonym is not anonymization.

History is held in memory for up to 30 days by default and at most 10 recent sessions per app/pseudonym pair. Both limits can be configured. The origin is the caller application; the purpose is to summarize recent activity and outcomes within that application's scope. `getProfile` returns `undefined` when no retained history is available. Consumers must treat that as unavailable context, not as a risk signal or evidence of suspicious behavior. The engine does not integrate with or change risk scoring.

Applications opt out with `optOut(appId, pseudonym)`, which deletes the profile currently held by the engine. Since the application owns consent and the pseudonym, it must also stop calling `recordSession` for that pseudonym after opt-out. This v0 does not persist data across process restarts or coordinate deletion of copies held elsewhere.

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

## Human signature representation v0

`src/session-signature.mjs` builds a reproducible experimental representation
from already minimized, caller-supplied per-session aggregates. It emits a
version-0 flat map of canonical `group.field` numeric values and an explicit
unavailable list by group. It does not read raw events, collect identifiers,
persist profiles, or classify sessions. Run the synthetic comparison report
with `npm run report:session-signatures`; run focused coverage with
`node --test test/session-signature.test.mjs`.

Inputs use the existing feature boundaries: `perception` maps
`duration_ms` and `correct` from a minimized challenge result; `timing` accepts
caller-derived `durationMs` and `reactionTimeMs` (never absolute timestamps);
`behavior.features` accepts only the listed aggregates from the existing mouse
feature pipeline (`distancePx`, `durationMs`, `meanSpeedPxPerMs`, `pauseCount`,
`directionChanges`, `speedVariation`, and `trajectoryEntropyBits`). `journey`
accepts only optional aggregate counts (`sessionCount`, `succeededCount`,
`failedCount`); it does not consume timestamps or pseudonyms from the journey
engine. `browser` accepts allowlisted boolean observations named for the
existing browser heuristics. These flags are unweighted observations, not
verdicts. `history` accepts the same optional counts only when an application
explicitly supplies them; it is absent by default. Where no suitable minimized
input exists, the group remains unavailable rather than being reconstructed
from raw data.

Missing groups, absent fields, nulls, non-finite or negative measurements,
fractional counts, and unsupported value types are marked unavailable and
never imputed as zero. Boolean values are accepted only for correctness and
browser flags, then become 0/1. The comparator also rejects unknown feature
keys and invalid values in a supplied signature. Pair comparison uses only
finite numeric features available in both signatures. For each common feature, difference is
`abs(a-b) / max(1, abs(a), abs(b))`; reported distance is the arithmetic mean
of those differences. The report includes common feature count, union count,
and common/union coverage. With no common values, distance is `null`. This is a
simple exploratory baseline: features have equal weight and the scale rule is
not learned or calibrated. It supports cautious experimental similarity
comparisons only, not identity, class, or human/automation claims.

The checked-in `test/fixtures/session-signatures-v0.json` contains synthetic
session names, not persistent pseudonyms. Output ordering and arithmetic are
deterministic for a given input and schema version. Feature mappings and
missingness semantics are versioned by the module's `schemaVersion`; changing
names, units, or transformations requires a version change and comparable
inputs should use the same version. History remains opt-in and app-scoped under
the existing history engine's consent/retention controls; this representation
does not instantiate that engine or create a per-person profile by default.

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

## Verification API v0 contract

The [OpenAPI 3.1 contract](docs/api/verification-v0.yaml) specifies five application-facing operations: create a session, request a challenge, submit a result, verify a session, and validate a token. It is a versioned integration contract, not a hosted Cognit service. [The stdlib mock](examples/verification_api_mock.py) demonstrates all five HTTP calls locally: `python3 examples/verification_api_mock.py --demo`.

Applications authenticate server-to-server with a bearer API key over TLS. Keep credentials and signing secrets on the server; bind each key to one application, and resolve every session and record inside that authenticated application's namespace. A deployment should enforce per-application rate limits, return `429` with `Retry-After`, and avoid logging credentials, tokens, submitted answers, or raw telemetry. Retain only operational identifiers and outcome data needed for debugging and audit, with short retention. Limits and retention periods are deployment policy; this contract does not prescribe production values.

## Operational dashboard

The dashboard aggregates completed challenge attempts during the current page visit. Its source and period are shown with the count. Decision rates, risk distribution, service latency percentiles, false-positive estimates, and model/rule versions are marked unavailable because this client-only prototype has no connected operational event, latency, audited ground-truth, or active model/rule source. Participant response time is not service latency. The dashboard exposes aggregate counts only and does not show individual attempt records.

# Cognit

## Perceptual challenge

A small, client-only perception challenge. Choose an authored pattern and display duration, study it, then answer after it disappears. The result is shown on screen and can be downloaded as JSON.

Serve this directory with any static HTTP server and open `index.html`. For example:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. The app uses native browser modules and has no install step or external dependencies.

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

## Server-side decision policy

`decision_policy.py` maps a numeric risk score and confidence to a decision using a caller-supplied policy. It does not set production thresholds or make claims about identity or intent. A policy consists of ordered `PolicyRule` score bands (inclusive endpoints), a minimum confidence, and optional signal keys that must be present. The first matching rule wins. Configure bands for `ALLOW`, `CHALLENGE`, `RESTRICT`, `BLOCK`, or `UNKNOWN`; unmatched or insufficient evidence returns `UNKNOWN`.

Scores must be finite numbers from 0 through 100; confidence must be finite from 0 through 1. Missing/invalid inputs, confidence below the configured minimum, missing required signals, and unmatched bands return `UNKNOWN` with a machine-readable reason. Invalid policy configurations raise `ValueError`. Signal values are opaque to this engine: rules test signal presence, not identity, intent, or signal meaning.

Run the Python tests with `python3 -m unittest discover -v`.

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
count is reported. The report includes per-field aggregate summaries, repeated
and singleton categorical fingerprint counts, and numeric candidates outside
the dataset's 1.5×IQR fences. Fingerprints and categorical value summaries use
SHA-256 digests so raw categorical values are not copied into the report. These
digests support correlation and provenance checks; they are not anonymization
and can be guessed for low-entropy values.
The output also records the source identifier, canonical input hash, observer
version, configuration, and configuration hash. Identical input and code
version produce a deterministic report.

Observations are separate from conclusions; conclusions are always empty.
Outliers and unusual fingerprints are review candidates, not evidence of
automation, malicious intent, or model error. Small or unusable datasets are
marked `insufficient_data`. Missing signals can reflect omission or collection
limits. The observer does not infer false positives or false negatives. Those
assessments need labels supplied and independently reviewed outside this tool,
with their own provenance. Do not use observer output as ground truth or to
change live policy or decisions.

Run its tests with `python3 -m unittest test_ai_observer -v` or run the full
Python suite with `python3 -m unittest discover -v`.

## Signed verification tokens

`verification_token.py` provides a framework-neutral server-side token issuer and verifier. Configure one random secret of at least 32 bytes per application on the server; never send these secrets to a client. After the server confirms that a session is authorized for an action, call `VerificationTokenService.issue` with the application, site, session, and action IDs. Send the resulting token to the trusted verification service.

The verifier must supply the expected application, site, session, and action from its own server-side context. `verify_and_consume` checks the HMAC-SHA256 signature, claim bindings, issue and expiry times, then atomically consumes the nonce. A token is accepted once. The default in-memory nonce store is safe for concurrent requests in one process; deployments with multiple processes or hosts must inject a shared store with an atomic `consume_once` operation.

Tokens expire after 60 seconds by default; the configured lifetime can be at most five minutes. Run the Python tests with `python3 -m unittest discover -v`.

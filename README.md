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

## Verified ad events

`ad_events.py` defines an allowlisted record for an ad `impression` or `interaction`. Each event has its own opaque `event_id`, an `ad_id`, a timezone-aware occurrence time, and the opaque `verification_result_id` plus `decision_version` that associate it with the result. `verification_result_origin` identifies the verifier that produced the linked result. The event carries the result's finite `confidence` (0–1) and a required `confidence_origin` naming the confidence producer/method; an optional `risk_score` is included only when the result producer provides one. The integration must copy these values from the trusted verification result and must not infer or recalculate them from ad activity.

Confidence here describes the verification result's evidence coverage/reliability as reported by its producer (for example, `risk_score.score_risk.v1`). It is not a probability that a person is human. User-facing copy should describe a result as an estimate that may be wrong, for example: “This result is an estimate based on the available evidence and may be incorrect; it does not confirm a person's identity.” Do not say “100% human” or imply certainty.

The record has no session ID, identity, challenge response, signal details, or raw telemetry fields. Keep linkage to the opaque result reference; do not enrich the event with session data. Ad events are measurement records only and must never be fed into `risk_score.py` or `decision_policy.py`. Raw mouse, browser, timing, and other verification telemetry must not be sent to advertisers.

Run the Python tests with `python3 -m unittest discover -v`.

## Signed verification tokens

`verification_token.py` provides a framework-neutral server-side token issuer and verifier. Configure one random secret of at least 32 bytes per application on the server; never send these secrets to a client. After the server confirms that a session is authorized for an action, call `VerificationTokenService.issue` with the application, site, session, and action IDs. Send the resulting token to the trusted verification service.

The verifier must supply the expected application, site, session, and action from its own server-side context. `verify_and_consume` checks the HMAC-SHA256 signature, claim bindings, issue and expiry times, then atomically consumes the nonce. A token is accepted once. The default in-memory nonce store is safe for concurrent requests in one process; deployments with multiple processes or hosts must inject a shared store with an atomic `consume_once` operation.

Tokens expire after 60 seconds by default; the configured lifetime can be at most five minutes. Run the Python tests with `python3 -m unittest discover -v`.

# Accessibility experiment adapter v1

This local adapter records the visual and accessible presentations as separate
experimental conditions. It consumes minimized JSON sessions; it does not
rebuild the historical #26 interface or change the production API, Risk Score,
or policy. The old `index.html` / `src/app.js` demo was removed when the
repository split lab examples from the product library. The #26 route and its
untimed behavior remain visible in commit `bcd88965`.

## Record contract

Each session has `session_id`, `challenge_id`, `accessibility_mode`,
`completion_status`, and `attempts`. Each attempt separately carries
`attempt_id`, `challenge_id`, `accessibility_mode`, `attempt_number`, `status`,
`challenge_result`, and `duration_ms`. Session and attempt modality are never
copied from one another. Missing modality, completion, result, status, attempt
number, or duration remains missing/`UNKNOWN` in the report. Modes are
`VISUAL`, `ACCESSIBLE`, and `UNKNOWN`; results are `CORRECT`, `INCORRECT`, or
`UNKNOWN`.

The adapter allowlists fields and rejects extras. In particular, it does not
accept a reason for using the accessible presentation, raw telemetry, risk
scores, policy outcomes, participant details, or free text. It does not compute
Risk Score or policy and does not pass modality to either system.

## Local report

The input must be an object with `evidence_class: "SIMULATED"` and a `sessions`
array. Missing or other evidence classes are rejected; the CLI will not silently
label arbitrary/unproven inputs as simulated.

Run the adapter against the paired simulated fixture:

```sh
node scripts/accessibility-experiment.mjs fixtures/accessibility-experiment-v1/equivalent-challenges.json
```

The JSON report separates each modality and includes session/attempt
denominators, completion, retries, abandonment, observed duration, per-challenge
results, and missing-value counts. Empty strata are `UNAVAILABLE` and rates
without an observed denominator are `null`. Reports from this adapter are
always `SIMULATED`; fixtures demonstrate classification and report behavior,
not real participant outcomes or accessibility equivalence.

The fixture pairs the same challenge ID across visual and accessible modes.
Accessible timing is `null` because the historical text route is untimed. This
does not treat missing timing as zero.

## Validation

```sh
node --test test/accessibility-experiment.test.mjs
python3 -m unittest test_accessibility_risk_isolation.py
node scripts/accessibility-experiment.mjs fixtures/accessibility-experiment-v1/equivalent-challenges.json
```

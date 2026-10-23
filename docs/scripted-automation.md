# Scripted automation scenarios

The local scenario runner measures how controlled timing, cursor movement, pauses, and retries affect Cognit's derived signals. It uses only a local challenge fixture; it does not call a verification service or feed results into a production policy.

Run either built-in profile with a fixed seed:

```sh
node examples/scripted-automation/run.mjs --scenario steady --seed demo-1 --trials 5
```

Compare both profiles descriptively against the same fixture:

```sh
node examples/scripted-automation/run.mjs --scenario steady --seed demo-1 --trials 5 --compare bursty
```

A custom profile can be stored as JSON and replayed with `--config`. The example at `examples/scripted-automation/scenario.example.json` lists every configurable range: initial delay, cursor speed, segment count, pause count/duration, retry limit, time after movement before response, and simulated correctness probability. Active movement duration is calculated from the selected speed and generated path. Command line options can override `seed`, `trials`, `fixture`, and `scenario_id` values from the config.

Each emitted record contains the profile, trial count, sampled parameters, seed, attempt/retry index, result, aggregate mouse features, timing, fixture identifier, and provenance. It intentionally excludes raw cursor points and response contents. A fixture without `expected_answer` produces `UNKNOWN`; comparisons across mismatched or unavailable fixture attribution also produce `UNKNOWN`. All output is marked `SIMULATED` and `SCRIPTED_AUTOMATION`; this is not evidence of human behavior or adversary prevalence. Oracle access is marked when the fixture includes an expected answer. Comparisons report descriptive counts and averages only.

The runner is a local lab utility outside the published SDK allowlist. It does not import risk scoring, verification-token, session, or policy code, and it does not block users.

Custom profiles are bounded before generation: each integer profile range tops out at 1,000, a scenario can produce at most 10,000 attempt records, and at most 1,000,000 cursor points. Pause durations must be positive whenever the profile can select a pause.

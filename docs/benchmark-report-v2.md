# Descriptive benchmark report v2

Run `python3 benchmark_report.py --human FILE --playwright FILE --selenium FILE --puppeteer FILE --output REPORT.json`. Omit unavailable inputs; the report marks their groups and metrics `UNAVAILABLE`. The historical `schema_version: 1` human `records` and automation `attempts` exports remain accepted. A v1 adapter snapshot may also supply `trial_records` in one group file; each row retains `session_id`, `attempt_id`, `challenge_id`, `evidence_class`, `actor_class`, `oracle_access`, `observed_result`, and `perception_metric_eligible` fields.

## Primary endpoints

- `challenge_completed_correctly`: completed challenge attempts with explicit correctness; challenge performance does not prove humanity.
- `challenge_applied`: records with a challenge identifier or explicit application flag; reports `CHALLENGE`, `RESTRICT`, `BLOCK`, and `UNKNOWN` outcome counts separately.
- `human_false_positive_rate`: among independently confirmed humans with a stable `participant_id`, select one primary session per participant: earliest valid timezone-aware `session_started_at`, ties by lexicographically smallest `session_id`. Selection is outcome-blind. Numerator is participants whose primary session had any nested attempt receive `RESTRICT` or `BLOCK`; denominator is participants whose primary session has at least one known outcome. Retries do not increase independent n.
- `automation_escape_to_protected_action`: non-oracle automation sessions with both known policy outcome and known tri-state reach state; numerator has at least one explicitly observed `true`. Any `true` wins within a session, all applicable attempts must be explicitly `false` for a negative state, and remaining sessions are `UNKNOWN` and excluded.

All primary binary rates use the two-sided 95% Clopper-Pearson exact binomial interval. At zero events the upper bound is greater than zero. Outcome `UNKNOWN` remains counted but is excluded from binary denominators. Oracle-assisted records are excluded from perception conclusions. Empty groups and metrics have no fabricated values.

Historical continuous and attempt summaries are secondary, retain deterministic cluster bootstrap, and are not the primary participant-level estimate. Reports preserve source SHA-256 hashes. Fixture output is `SIMULATED`; input data alone does not justify `MEASURED_LAB` without participant/actor and provenance review.

Fixtures: `fixtures/benchmark-v1/` covers empty data, zero events, positive events, repeated sessions, explicit outcomes, and oracle exclusion.
# TrialRecord v1 JSONL integration

The report accepts the QC-validated JSONL from `scripts/trial-record.mjs` as an automated input. It verifies the export header, QC counts, and accepted-row artifact hash, then maps nested TrialRecord v1 fields without filling absent observations. `protected_action_reached` stays tri-state through per-session aggregation: any explicit `true` wins, only all-explicit-`false` sessions become `false`, and all other combinations remain `UNKNOWN`. Escape-rate eligibility requires both known policy and known reach state; unknown policy, unknown reach, and oracle exclusions are reported separately. A `SIMULATED` source marker stays attached to JSONL and report outputs even when moved outside the fixture directory; `OBSERVED` and `REPLAYED` declarations are not treated as measured evidence. See [Experimental pipeline readiness v1](experimental-pipeline-readiness-v1.md) for the field mapping and reproducible fixture commands.

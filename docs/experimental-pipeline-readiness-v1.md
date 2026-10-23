# Experimental pipeline readiness v1

## Target and boundary

For this experimental pipeline stage, `experiments/beta-lab` is the canonical integration target. `main` remains the production target. TrialRecord, benchmark, fixtures, reports, and protocol material stay on the experimental branch; the production package allowlist remains limited to the SDK artifacts. Run `npm run check:production-boundary` after changes to verify that boundary.

This workflow is deterministic and fixture-only. The fixtures and their derived reports are `SIMULATED`; they do not provide participant evidence, establish effectiveness, authorize a pilot, or show that a protocol step was performed. The report builder emits `UNAVAILABLE`, `SIMULATED`, or `UNVERIFIED_INPUTS`; it does not promote fixture data to `MEASURED` or `MEASURED_LAB`.

## TrialRecord to benchmark mapping

`scripts/trial-record.mjs` validates the manifest and per-attempt rows, writes a QC header, and emits accepted canonical TrialRecord v1 rows as JSONL. `benchmark_report.py` accepts that JSONL directly for an automated group and checks the export header, complete successful QC counts, and artifact hash before adapting rows:

| TrialRecord v1 | Benchmark input | Rule |
| --- | --- | --- |
| `session_id` | `session_id` | Preserved; session is the escape-rate unit. |
| `trial_id` | `attempt_id` | Preserved as the attempt identifier. |
| `actor` | `actor_class` | `AUTOMATION_CONTROL` maps to `AUTOMATION_CONTROLLED`; `AI_AGENT` stays `AI_AGENT`. Other actors do not become automation labels. |
| `oracle_access` | `oracle_access` | Preserved; oracle-assisted sessions are excluded. |
| `outcome.observations.policy` | `observed_result.policy_outcome` | `allow`, `block`, `challenge`, and `unknown` map to uppercase benchmark values. Missing or unknown remains `UNKNOWN`. |
| `outcome.observations.protected_action_reached` | `protected_action_reached` | `true`, `false`, `null`, and absent are preserved. Null/absent mean `UNKNOWN`; no value is inferred. |
| `outcome.observations.protected_action_reached_provenance` | `protected_action_reached_provenance` | Retained as observation provenance, associated with the exact source `trial_id`; it is not actor ground truth. |
| `evidence_class` | `evidence_class` | The TrialRecord actor/evidence category stays distinct from report-level evidence status. |
| Manifest `evidence_class` | JSONL header `source_evidence_class` | `SIMULATED` remains attached to the artifact when it moves outside a `fixtures/` path. `OBSERVED` and `REPLAYED` remain unverified by this report workflow. |

An observation of `true` on any applicable attempt makes its session `true`. A session is `false` only if every applicable attempt has an explicit `false`. Any remaining session state is `UNKNOWN`. The escape-rate denominator includes only non-oracle automation sessions with both a known policy outcome and known session reach state. The report separately counts unknown policy, unknown reach, and oracle exclusions, and includes attempt and session reach-state counts.

## Reproduce the fixture report

From the repository root on `experiments/beta-lab` (or its issue work branch):

```sh
TRIAL_RECORD_PSEUDONYM_KEY='simulated-fixture-pseudonym-key-32-bytes' \
  node scripts/trial-record.mjs \
    --input fixtures/trial-record-benchmark-v1/records.json \
    --manifest fixtures/trial-record-benchmark-v1/manifest.json \
    --output fixtures/trial-record-benchmark-v1/trial-record-export.jsonl
python3 benchmark_report.py \
  --playwright fixtures/trial-record-benchmark-v1/trial-record-export.jsonl \
  --output fixtures/trial-record-benchmark-v1/benchmark-report.json
```

The fixture pseudonym key is public test material, not a secret for participant data. For future studies, provide a separately managed key and never commit it. JSONL output is deterministically sorted and hashed. The manifest evidence class is copied into the export header so a fixture export stays `SIMULATED` even after it is moved. The report records the source SHA-256, QC counts, escape numerator/denominator, reach observation counts, and exclusions. The generated fixture report must remain `SIMULATED`.

## Protocol readiness references

- [Trial Manifest v1](trial-manifest-v1.md) and [issue #45](https://github.com/GUZZBR1/Cognit/issues/45) define run metadata, unknown values, label provenance, and the limits of structural validation.
- [Human confirmation v1](human-confirmation-v1.md) and [issue #46](https://github.com/GUZZBR1/Cognit/issues/46) define independent direct observation over the exact session and attempt, consent as a separate step, required provenance, retention, and withdrawal.

Human confirmation requires an independent observer and provenance associated with the exact attempt. Consent does not confirm a human label. Correctness, timing, policy, browser signals, risk scores, and model output are not confirmation. The TrialRecord reach observation is a separate outcome observation and does not establish actor identity. Structural checks validate supplied provenance fields; they do not authenticate an observer or prove an observation happened.

The existing human-confirmation contract sets a 30-day default in-memory retention period, requires operators to delete exported copies within that period or sooner after withdrawal, and explains that external copies must be removed by their holders. The contract describes expected handling; it does not prove consent, retention, withdrawal, approval, or compliance occurred. This issue authorizes no participant collection or pilot execution.

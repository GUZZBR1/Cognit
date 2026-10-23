# TrialRecord v1 — QC e export versionado

Issue: https://github.com/GUZZBR1/Cognit/issues/51

## Objective
Create an isolated, versioned per-attempt record contract with local quality control and deterministic minimized JSONL export. TrialRecord references a run manifest; it does not duplicate manifest-level protocol/build/environment/configuration.

## Acceptance criteria
- A versioned JSON Schema covers trial identity, actor/label, provenance, manifest reference, challenge/seed/config reference, outcome/timing, evidence class, and explicit oracle access.
- UNKNOWN is preserved; Risk Score, prediction, and policy remain observations and cannot establish ground truth. Labels without independent valid provenance are rejected.
- QC reports missing required fields, duplicate IDs, inconsistent references, invalid provenance/labels, and impossible timestamps/values.
- Deterministic JSONL export includes contract version, artifact hash, and QC report; repeated identical input yields identical bytes/hash.
- Export strips PII and unnecessary raw telemetry/trajectories.
- Local fixtures cover HUMAN_CONFIRMED, automation control, AI agent, UNKNOWN, accessible, oracle-assisted, and invalid rows.
- CLI validates and exports fixtures without requiring producers, benchmark, database, or network.

## Strategy
Use a standalone Node CLI and versioned JSON Schema following repository conventions. Keep input handling local and deterministic. Build fixture manifest references into the fixture set so validation does not depend on issue #45 implementation. Test schema, QC, privacy minimization, and reproducible export.

## Required verification
Run focused Node tests and CLI fixture validation/export, then repository SDK test/build and Go tests if runtime/dependencies permit. Inspect output bytes and git diff for PII/raw telemetry leaks.

## Definition of Done
Documented contract/schema, executable validator/exporter, success/error fixtures, tests covering all issue criteria, passing relevant checks, independent adversarial review addressed, coherent commit(s), pushed branch, and open PR against main linked to #51. No merge.

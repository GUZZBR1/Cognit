# Trial Manifest v1

`schemas/trial-manifest-v1.schema.json` defines the run-level JSON contract. A
manifest is identified by `manifest_id` and records the study and protocol,
Cognit commit, RFC 3339 creation time, browser/OS, actor and version, challenge
set ID/version, optional exact challenge membership, seed, configuration digest,
accessible mode, evidence class, result, and observations. It describes the conditions claimed for one run; it does not
prove that the run occurred. `SIMULATED` is fixture evidence only.

`manifest_sha256` binds the complete canonical document after omitting that
field itself. It is a content digest, not a signature or proof of authorship.

The only supported contract and protocol versions are `1.0.0`. Unknown versions
fail validation so a consumer cannot silently interpret a future contract.
Required fields and nested objects reject unknown keys. The validator returns
sorted, path-qualified diagnostics to keep command output stable.

## Configuration digest

`config_sha256` is lowercase SHA-256 over UTF-8 canonical JSON for `config`:
object keys are sorted recursively, arrays keep their order, and JSON has no
insignificant whitespace. Use `hashConfig(config)` from
`scripts/trial-manifest.mjs` to calculate it. Changing any configuration value
without updating the digest fails validation.

## Evidence and labels

`actor.type` and `result` may be `UNKNOWN` and are preserved as supplied.
`ground_truth`, when present, requires one of the explicit independent
provenance values (`independent_human_confirmation`, `dataset_label`, or
`external_oracle`). Risk score, policy, and classifier outputs belong under
`observations`; they cannot be named as ground-truth provenance. An observation
is an assessment and does not redefine the run-level result or actor label.

## Validate

Run all positive and negative local fixtures:

```sh
node scripts/trial-manifest.mjs
npm run test:trial-manifest
```

Validate an individual manifest and print its protocol, commit, and config hash:

```sh
node scripts/trial-manifest.mjs path/to/manifest.json
```

QC and TrialRecord export remain separate contracts. The experimental pipeline requires exact `challenge_ids` membership in the canonical manifest, then links its export manifest by ID, version, and content digest; see [experimental pipeline readiness](experimental-pipeline-readiness-v1.md).

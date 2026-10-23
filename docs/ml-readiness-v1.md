# Grouped ML readiness gate v1

Run the training-free gate on a JSON manifest:

```sh
python3 scripts/ml_readiness.py fixtures/ml-readiness/eligible.json
```

The command writes one deterministic JSON report to stdout. It exits `0` for
`ML_READY=YES`, `1` for a valid manifest that fails the gate, and `2` when the
manifest cannot be read. `ml_ready` is `YES` or `NO`; stable reason codes explain
every failed gate. The report echoes the protocol version, trainable classes,
coverage minima, precision target, and confidence level for audit. It includes
record counts for every label, including
`UNKNOWN`, independent-group counts per split, and overlap counts. It does not
include record or group identifiers.

## Input contract

The manifest has three top-level fields:

- `protocol`: a predeclared protocol with `version`, unique non-empty
  `group_dimensions` including `participant` and `session` (and
  `agent_config` when an agent label is trainable), `trainable_labels` (which
  must exclude `UNKNOWN`), and `criteria`. Only those three dimensions are
  supported in v1.
- `final_holdout`: must declare `sealed: true` and
  `available_for_tuning: false`.
- `records`: records with a unique opaque `record_id`, a `split` (`train`,
  `validation`, or `final_holdout`), `ground_truth`, and one opaque group ID for
  every protocol group dimension.

Each ground-truth label must be one of `HUMAN`, `SCRIPTED_AUTOMATION`,
`AI_AGENT`, or `UNKNOWN`. Provenance must be `independent_human_confirmation`,
`dataset_label`, or `external_oracle`, with a non-empty `reference` to its
source. The supported protocol version is `grouped-split-v1`. A classifier is
not an accepted provenance source. The gate checks the declared source type and
reference presence; it cannot inspect the referenced source's truth. `UNKNOWN`
stays in the reported counts and is never included in trainable classes.

`criteria` declares `minimum_class_records_per_split` for each trainable class,
`minimum_independent_groups_per_split` for each group dimension and split,
`precision_target`, and `confidence_level`. These values belong to the
pre-registered experiment protocol. The gate requires them and enforces the
declared coverage minima; it adds no fixed sample-size cutoff. The precision
target and confidence level are recorded as prerequisites for a later offline
experiment. This gate cannot establish model precision because it does not
train or evaluate a model.

Group values must be disjoint between every pair of partitions for every
declared dimension. The protocol chooses the applicable identity dimensions,
such as participant, session, and agent/configuration units. The holdout must be
present and declared sealed and unavailable for tuning. These manifest
assertions are auditable inputs; the gate does not provide storage-level access
control for a holdout.

The report always says `evidence_mode: SIMULATED` and
`training_invoked: false`. `ML_READY=YES` only permits a controlled offline
experiment under the declared protocol; it does not establish real-world
generalization or production readiness.

Run tests with:

```sh
python3 -m unittest discover -s test/ml_readiness -v
```

# Supervised classifier v0

`supervised_classifier.py` is an offline experiment over aggregate, versioned
feature rows. It does not collect labels, produce production decisions, or use
its own predictions as labels. It reuses feature values from
`buildMouseFeatureRecord` in `src/feature-pipeline.mjs`; the input dataset must
carry `feature_pipeline_version: 1` for each record.

## Dataset format

Keep the dataset outside the repository when it contains research records. The
JSON envelope requires a stable dataset source and a `records` array:

```json
{
  "source": "independent-review-export-v1",
  "records": [
    {
      "label": "HUMAN",
      "label_provenance": {
        "reviewer_type": "independent_human",
        "method": "researcher-facilitated observation",
        "origin": "study session review",
        "procedure": "protocol-v1"
      },
      "feature_pipeline_version": 1,
      "features": {"distancePx": 42.0, "pauseCount": 1}
    }
  ]
}
```

Allowed reviewed labels are `HUMAN`, `BROWSER_AUTOMATION`, and `AI_AGENT`.
`UNKNOWN` records are counted and excluded from training. For every trained
label, a human reviewer must supply non-empty review method, evidence origin,
and procedure fields. These declarations are caller-supplied metadata and must
be audited against the study evidence; model output, browser signals, challenge
scores, and predictions are not independent ground truth. Feature names and
versions must match across usable rows. Null numeric features remain missing
values rather than being converted to zero.

## Run

Install either optional CPU boosting package in the active Python environment,
then run the experiment:

```sh
python3 -m pip install lightgbm xgboost
python3 supervised_classifier.py reviewed-dataset.json classifier-report.json --test-fraction 0.2 --seed 42
```

The runner trains whichever of LightGBM or XGBoost is installed and reports an
explicit unavailable reason for a missing package. A deterministic stratified
random split keeps at least one test and one train row per eligible class.
Classes with fewer than two reviewed examples are unavailable. If fewer than
two classes can be trained, no model is fitted. The report includes the source,
feature version, class counts, split seed/fraction, model metrics, absent
classes, missing optional models, and limitations.

This first experiment uses one random split and small datasets may not
generalize. Results are research evidence only; do not use them for production
decisions or to create labels for later training.

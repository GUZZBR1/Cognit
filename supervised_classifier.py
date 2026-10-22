"""Experimental, offline multiclass training on independently reviewed rows.

This module does not collect labels, infer them, or connect predictions to a
production decision. XGBoost and LightGBM are optional runtime dependencies.
"""

from __future__ import annotations

import json
import random
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from math import isfinite
from pathlib import Path
from typing import Any

FEATURE_VERSION = 1
LABELS = ("HUMAN", "BROWSER_AUTOMATION", "AI_AGENT")
PROVENANCE_FIELDS = ("method", "origin", "procedure")


def prepare_dataset(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Validate independently reviewed labels and return usable feature rows.

    Records use ``label`` (one of LABELS or UNKNOWN), ``label_provenance``
    (reviewer_type=independent_human, method/origin/procedure),
    ``feature_pipeline_version``, and a numeric
    ``features`` mapping. UNKNOWN rows are counted but never used for fitting.
    """
    if not isinstance(records, Sequence) or isinstance(records, (str, bytes)):
        raise TypeError("records_must_be_a_sequence")
    rows = []
    excluded = Counter()
    feature_names: tuple[str, ...] | None = None
    for index, record in enumerate(records):
        if not isinstance(record, Mapping):
            raise TypeError(f"record_{index}_must_be_an_object")
        label = record.get("label")
        if label == "UNKNOWN":
            excluded["unknown_label"] += 1
            continue
        if label not in LABELS:
            raise ValueError(f"record_{index}_has_invalid_label")
        provenance = record.get("label_provenance")
        if not isinstance(provenance, Mapping) or provenance.get("reviewer_type") != "independent_human" or any(
            not isinstance(provenance.get(field), str) or not provenance[field].strip()
            for field in PROVENANCE_FIELDS
        ):
            raise ValueError(f"record_{index}_requires_independent_label_provenance")
        if record.get("feature_pipeline_version") != FEATURE_VERSION:
            raise ValueError(f"record_{index}_has_unsupported_feature_version")
        features = record.get("features")
        if not isinstance(features, Mapping) or not features:
            excluded["missing_features"] += 1
            continue
        names = tuple(sorted(features))
        if feature_names is None:
            feature_names = names
        elif names != feature_names:
            raise ValueError(f"record_{index}_feature_schema_mismatch")
        vector = []
        for name in names:
            value = features[name]
            if value is None:
                vector.append(float("nan"))
            elif isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
                raise ValueError(f"record_{index}_feature_{name}_must_be_numeric_or_null")
            else:
                vector.append(float(value))
        rows.append({"label": label, "features": vector})
    return {
        "rows": rows,
        "feature_names": list(feature_names or ()),
        "class_counts": dict(sorted(Counter(row["label"] for row in rows).items())),
        "excluded": dict(sorted(excluded.items())),
    }


def stratified_split(rows: Sequence[Mapping[str, Any]], test_fraction: float = 0.2, seed: int = 42) -> tuple[list[int], list[int], list[str]]:
    """Split eligible classes deterministically; classes with <2 rows abstain."""
    if not 0 < test_fraction < 1:
        raise ValueError("test_fraction_must_be_between_zero_and_one")
    by_class: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        by_class.setdefault(row["label"], []).append(index)
    rng = random.Random(seed)
    train: list[int] = []
    test: list[int] = []
    unavailable: list[str] = []
    for label, indexes in sorted(by_class.items()):
        rng.shuffle(indexes)
        if len(indexes) < 2:
            unavailable.append(label)
            continue
        test_count = min(len(indexes) - 1, max(1, round(len(indexes) * test_fraction)))
        test.extend(indexes[:test_count])
        train.extend(indexes[test_count:])
    return sorted(train), sorted(test), unavailable


def _metrics(actual: list[str], predicted: list[str], labels: list[str]) -> dict[str, Any]:
    total = len(actual)
    correct = sum(a == p for a, p in zip(actual, predicted))
    per_class = {}
    for label in labels:
        tp = sum(a == label and p == label for a, p in zip(actual, predicted))
        support = sum(a == label for a in actual)
        predicted_count = sum(p == label for p in predicted)
        per_class[label] = {
            "support": support,
            "precision": tp / predicted_count if predicted_count else None,
            "recall": tp / support if support else None,
        }
    return {"accuracy": correct / total if total else None, "test_rows": total, "per_class": per_class}


def train_and_report(records: Sequence[Mapping[str, Any]], *, dataset_source: str, test_fraction: float = 0.2, seed: int = 42) -> dict[str, Any]:
    """Train each installed boosting implementation and return a JSON report."""
    if not isinstance(dataset_source, str) or not dataset_source.strip():
        raise ValueError("dataset_source_is_required")
    prepared = prepare_dataset(records)
    train_idx, test_idx, sparse_classes = stratified_split(prepared["rows"], test_fraction, seed)
    train_labels = sorted({prepared["rows"][i]["label"] for i in train_idx})
    eligible = len(train_labels) >= 2 and bool(test_idx)
    models: dict[str, Any] = {}
    unavailable_models = []
    if eligible:
        X_train = [prepared["rows"][i]["features"] for i in train_idx]
        y_train = [prepared["rows"][i]["label"] for i in train_idx]
        X_test = [prepared["rows"][i]["features"] for i in test_idx]
        y_test = [prepared["rows"][i]["label"] for i in test_idx]
        try:
            from lightgbm import LGBMClassifier
            estimator = LGBMClassifier(random_state=seed, verbosity=-1, n_jobs=1)
            estimator.fit(X_train, y_train)
            models["LightGBM"] = _metrics(y_test, list(estimator.predict(X_test)), train_labels)
        except ImportError:
            unavailable_models.append({"name": "LightGBM", "reason": "dependency_not_installed"})
        try:
            from xgboost import XGBClassifier
            estimator = XGBClassifier(random_state=seed, n_estimators=100, eval_metric="mlogloss", n_jobs=1)
            label_to_id = {label: index for index, label in enumerate(train_labels)}
            estimator.fit(X_train, [label_to_id[label] for label in y_train])
            decoded = [train_labels[int(value)] for value in estimator.predict(X_test)]
            models["XGBoost"] = _metrics(y_test, decoded, train_labels)
        except ImportError:
            unavailable_models.append({"name": "XGBoost", "reason": "dependency_not_installed"})
    return {
        "schema_version": 1,
        "experiment": "supervised-classifier-v0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "feature_pipeline_version": FEATURE_VERSION,
        "dataset_source": dataset_source.strip(),
        "training_status": "trained" if models else "unavailable",
        "training_unavailable_reason": None if models else (
            "fewer_than_two_trainable_classes" if not eligible else "no_boosting_dependency_installed"
        ),
        "feature_names": prepared["feature_names"],
        "label_source_requirement": "independent_review_provenance_required; model_outputs_are_not_labels",
        "data": {
            "input_rows": len(records),
            "labeled_rows": len(prepared["rows"]),
            "class_counts": prepared["class_counts"],
            "excluded": prepared["excluded"],
            "train_rows": len(train_idx),
            "test_rows": len(test_idx),
            "split": {"method": "deterministic_stratified_random", "test_fraction": test_fraction, "seed": seed},
        },
        "unavailable_classes": sorted(set(sparse_classes) | (set(LABELS) - set(prepared["class_counts"]))),
        "models": models,
        "unavailable_models": unavailable_models,
        "limitations": [
            "Experimental offline evaluation only; do not use for production decisions.",
            "Independent label provenance is caller-supplied and requires external audit.",
            "Classes absent from reviewed data or with fewer than two examples are unavailable.",
            "UNKNOWN records are excluded and are never treated as a learned class.",
            "Small datasets and one random split do not establish generalization.",
        ],
    }


def write_report(report: Mapping[str, Any], path: str | Path) -> None:
    Path(path).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", help="JSON file containing source and records")
    parser.add_argument("report", help="path for the JSON evaluation report")
    parser.add_argument("--test-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    if not isinstance(dataset, Mapping) or not isinstance(dataset.get("records"), list):
        parser.error("dataset must be a JSON object with a records array")
    report = train_and_report(dataset["records"], dataset_source=dataset.get("source"), test_fraction=args.test_fraction, seed=args.seed)
    write_report(report, args.report)
    print(json.dumps({"models": list(report["models"]), "unavailable_models": report["unavailable_models"], "report": args.report}))


if __name__ == "__main__":
    main()

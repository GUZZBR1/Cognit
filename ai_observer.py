"""Deterministic, offline observer for minimized Cognit signal exports.

This module reports distribution-deviation scores for human review. Scores do
not classify or make decisions about sessions or people.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from collections import Counter
from collections.abc import Mapping
from typing import Any

OBSERVER_VERSION = "1.0.0"
INPUT_SCHEMA_VERSION = 1
MIN_RECORDS = 4
MIN_PATTERN_COUNT = 2
IQR_MULTIPLIER = 1.5


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _validate_finite_json(value: Any, path: str = "input") -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{path} contains a non-finite number")
    if isinstance(value, int) and not isinstance(value, bool):
        try:
            if not math.isfinite(float(value)):
                raise ValueError(f"{path} contains a non-finite number")
        except OverflowError as error:
            raise ValueError(f"{path} contains a number outside the supported range") from error
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} contains a non-string object key")
            _validate_finite_json(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _validate_finite_json(child, f"{path}[{index}]")


def _flatten_signals(record: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    signals = record.get("signals")
    if not isinstance(signals, Mapping):
        return {}, 1

    flattened: dict[str, Any] = {}
    ignored = 0
    for group, fields in signals.items():
        if not isinstance(group, str) or not isinstance(fields, Mapping):
            ignored += 1
            continue
        for field, value in fields.items():
            if not isinstance(field, str):
                ignored += 1
            elif value is None:
                ignored += 1
            elif isinstance(value, (str, bool, int, float)):
                flattened[_canonical_json([group, field])] = value
            else:
                # Raw trajectories and other nested/high-cardinality payloads
                # are outside this minimized format and are never traversed.
                ignored += 1
    return flattened, ignored


def _quantile(sorted_values: list[float], fraction: float) -> float:
    position = (len(sorted_values) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return sorted_values[lower]
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def analyze_dataset(dataset: Mapping[str, Any]) -> dict[str, Any]:
    """Analyze a minimized v1 dataset and return summaries with row scores."""
    if not isinstance(dataset, Mapping):
        raise ValueError("dataset must be a JSON object")
    _validate_finite_json(dataset)
    if dataset.get("schema_version") != INPUT_SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {INPUT_SCHEMA_VERSION}")
    source_id = dataset.get("source_id")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("source_id must be a non-empty origin identifier")
    records = dataset.get("records")
    if not isinstance(records, list):
        raise ValueError("records must be an array")
    if any(not isinstance(record, Mapping) for record in records):
        raise ValueError("each record must be an object")

    positive_class = dataset.get("positive_class")
    if positive_class is not None and (not isinstance(positive_class, str) or not positive_class.strip()):
        raise ValueError("positive_class must be a non-empty string when provided")
    reviewed_comparisons: list[tuple[str, str]] = []
    for index, record in enumerate(records):
        evaluation = record.get("evaluation")
        if evaluation is None:
            continue
        if not isinstance(evaluation, Mapping) or set(evaluation) != {
            "prediction", "reviewed_outcome", "review_provenance"
        }:
            raise ValueError(f"records[{index}].evaluation has an invalid shape")
        prediction = evaluation["prediction"]
        reviewed_outcome = evaluation["reviewed_outcome"]
        if prediction not in ("positive", "negative") or reviewed_outcome not in ("positive", "negative"):
            raise ValueError(f"records[{index}].evaluation outcomes must be positive or negative")
        provenance = evaluation["review_provenance"]
        if not isinstance(provenance, Mapping) or set(provenance) != {"method", "origin", "procedure"}:
            raise ValueError(f"records[{index}].evaluation requires review provenance")
        if any(not isinstance(provenance[key], str) or not provenance[key].strip()
               for key in ("method", "origin", "procedure")):
            raise ValueError(f"records[{index}].evaluation review provenance fields must be non-empty strings")
        reviewed_comparisons.append((prediction, reviewed_outcome))
    if reviewed_comparisons and (not isinstance(positive_class, str) or not positive_class.strip()):
        raise ValueError("positive_class is required when reviewed evaluations are provided")

    flattened_records: list[dict[str, Any]] = []
    ignored_values = 0
    for record in records:
        flattened, ignored = _flatten_signals(record)
        flattened_records.append(flattened)
        ignored_values += ignored

    field_values: dict[str, list[Any]] = {}
    pattern_counts: Counter[str] = Counter()
    for values in flattened_records:
        for field, value in values.items():
            field_values.setdefault(field, []).append(value)
        categorical = {
            field: value
            for field, value in values.items()
            if isinstance(value, (str, bool))
        }
        if categorical:
            pattern_counts[_digest(categorical)] += 1

    observations: list[dict[str, Any]] = []
    field_summaries: dict[str, Any] = {}
    numeric_fences: dict[str, tuple[float, float]] = {}
    for field in sorted(field_values):
        values = field_values[field]
        numeric = [float(value) for value in values if isinstance(value, (int, float)) and not isinstance(value, bool)]
        categorical = [value for value in values if isinstance(value, (str, bool))]
        summary: dict[str, Any] = {
            "present_count": len(values),
            "missing_count": len(records) - len(values),
        }
        if numeric:
            ordered = sorted(numeric)
            q1 = _quantile(ordered, 0.25)
            q3 = _quantile(ordered, 0.75)
            spread = q3 - q1
            lower = q1 - IQR_MULTIPLIER * spread
            upper = q3 + IQR_MULTIPLIER * spread
            numeric_fences[field] = (lower, upper)
            outliers = [value for value in ordered if value < lower or value > upper]
            summary["numeric"] = {
                "count": len(ordered),
                "mean": round(statistics.fmean(ordered), 6),
                "median": round(statistics.median(ordered), 6),
                "min": round(ordered[0], 6),
                "max": round(ordered[-1], 6),
                "outlier_count_iqr_1_5": len(outliers),
            }
            if outliers:
                observations.append({
                    "kind": "numeric_outlier_candidate",
                    "field": field,
                    "observation": "A numeric value falls outside the 1.5×IQR range in this dataset.",
                    "evidence": {
                        "sample_count": len(ordered),
                        "outlier_count": len(outliers),
                        "lower_fence": round(lower, 6),
                        "upper_fence": round(upper, 6),
                    },
                    "conclusion": None,
                })
        if categorical:
            counts = Counter(_digest(value) for value in categorical)
            summary["categorical"] = {
                "distinct_value_count": len(counts),
                "value_frequency_hashes": [
                    {"value_sha256": value_hash, "count": counts[value_hash]}
                    for value_hash in sorted(counts)
                ],
            }
        field_summaries[field] = summary

    record_scores = []
    for index, values in enumerate(flattened_records):
        numeric_field_count = 0
        outlier_field_count = 0
        for field, (lower, upper) in numeric_fences.items():
            value = values.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                numeric_field_count += 1
                if value < lower or value > upper:
                    outlier_field_count += 1
        record_scores.append({
            "record_index": index,
            "score": round(100 * outlier_field_count / numeric_field_count, 2)
            if numeric_field_count else None,
            "numeric_field_count": numeric_field_count,
            "outlier_field_count": outlier_field_count,
        })

    repeated_patterns = [count for count in pattern_counts.values() if count >= MIN_PATTERN_COUNT]
    rare_patterns = [count for count in pattern_counts.values() if count < MIN_PATTERN_COUNT]
    if repeated_patterns:
        observations.append({
            "kind": "repeated_pattern_cluster",
            "field": None,
            "observation": "Some categorical signal fingerprints recur in multiple records.",
            "evidence": {
                "distinct_fingerprints": len(pattern_counts),
                "repeated_fingerprint_count": len(repeated_patterns),
                "records_in_repeated_fingerprints": sum(repeated_patterns),
                "minimum_cluster_size": MIN_PATTERN_COUNT,
            },
            "conclusion": None,
        })
    if rare_patterns:
        observations.append({
            "kind": "uncommon_pattern_candidate",
            "field": None,
            "observation": "Some categorical signal fingerprints occur only once in this dataset.",
            "evidence": {
                "distinct_fingerprints": len(pattern_counts),
                "singleton_fingerprint_count": len(rare_patterns),
                "records_in_singleton_fingerprints": sum(rare_patterns),
            },
            "conclusion": None,
        })

    potential_false_positives = sum(
        prediction == "positive" and reviewed == "negative"
        for prediction, reviewed in reviewed_comparisons
    )
    potential_false_negatives = sum(
        prediction == "negative" and reviewed == "positive"
        for prediction, reviewed in reviewed_comparisons
    )
    if potential_false_positives:
        observations.append({
            "kind": "potential_false_positive_candidate",
            "field": None,
            "observation": "Some positive predictions differ from independently reviewed negative outcomes.",
            "evidence": {
                "positive_class": positive_class,
                "candidate_count": potential_false_positives,
                "reviewed_comparison_count": len(reviewed_comparisons),
            },
            "conclusion": None,
        })
    if potential_false_negatives:
        observations.append({
            "kind": "potential_false_negative_candidate",
            "field": None,
            "observation": "Some negative predictions differ from independently reviewed positive outcomes.",
            "evidence": {
                "positive_class": positive_class,
                "candidate_count": potential_false_negatives,
                "reviewed_comparison_count": len(reviewed_comparisons),
            },
            "conclusion": None,
        })

    record_count = len(records)
    usable_records = sum(bool(record) for record in flattened_records)
    sufficient = record_count >= MIN_RECORDS and usable_records >= MIN_RECORDS
    if not sufficient:
        observations.append({
            "kind": "data_coverage",
            "field": None,
            "observation": "The dataset is too small or has no usable scalar signal values for pattern review.",
            "evidence": {
                "record_count": record_count,
                "records_with_usable_signals": usable_records,
                "minimum_record_count": MIN_RECORDS,
                "minimum_usable_record_count": MIN_RECORDS,
            },
            "conclusion": None,
        })

    config = {
        "minimum_record_count": MIN_RECORDS,
        "minimum_usable_record_count": MIN_RECORDS,
        "minimum_pattern_count": MIN_PATTERN_COUNT,
        "numeric_outlier_method": "Tukey IQR",
        "iqr_multiplier": IQR_MULTIPLIER,
    }
    return {
        "report_schema_version": 1,
        "observer_version": OBSERVER_VERSION,
        "status": "analyzed" if sufficient else "insufficient_data",
        "provenance": {
            "source_id": source_id,
            "canonical_input_sha256": _digest(dataset),
            "configuration": config,
            "configuration_sha256": _digest(config),
            "record_count": record_count,
            "records_with_usable_signals": usable_records,
        "reviewed_comparison_count": len(reviewed_comparisons),
        "unreviewed_record_count": record_count - len(reviewed_comparisons),
        "potential_false_positive_count": potential_false_positives,
        "potential_false_negative_count": potential_false_negatives,
            "ignored_or_missing_values": ignored_values,
        },
        "field_summaries": field_summaries,
        "record_scores": record_scores,
        "observations": observations,
        "conclusions": [],
        "limitations": [
            "Observations describe aggregates in this export; they do not establish intent, identity, or causal patterns.",
            "Fingerprints and provenance use plain SHA-256; digests correlate values but do not provide anonymization or resist guessing for low-entropy inputs.",
            "Singleton and numeric outlier candidates depend on this dataset and the configured deterministic thresholds.",
            "Potential false-positive and false-negative counts compare supplied predictions with independently reviewed reference outcomes; those outcomes are not ground truth and remain subject to human interpretation.",
            "No false-positive or false-negative candidates can be counted without externally supplied review outcomes and their provenance.",
            "Missing signals may reflect omission, collection limits, or unavailable telemetry; they are not evidence of absence.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze a minimized Cognit JSON export offline.")
    parser.add_argument("input", help="path to a minimized JSON dataset (read only)")
    args = parser.parse_args(argv)
    try:
        with open(args.input, "r", encoding="utf-8") as source_file:
            dataset = json.load(source_file, parse_constant=_reject_json_constant)
        report = analyze_dataset(dataset)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"ai_observer: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False))
    return 0


def _reject_json_constant(token: str) -> None:
    raise ValueError(f"invalid number: {token}")


if __name__ == "__main__":
    raise SystemExit(main())

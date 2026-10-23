"""Deterministic binary evaluation metrics for fixture records.

``actual_positive=True`` is the positive class, ``predicted_positive=True`` is
a positive prediction, and larger ``score`` values indicate stronger evidence
for the positive class. Unknown predictions (``None``) are excluded from
confusion-derived metrics.
"""

from collections.abc import Iterable, Mapping
from math import isfinite
from statistics import mean, median
from typing import Any


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if isfinite(number) else None


def _metric(numerator: int, denominator: int, *, zero_reason: str) -> dict[str, Any]:
    result: dict[str, Any] = {"numerator": numerator, "denominator": denominator}
    if denominator:
        result["value"] = numerator / denominator
    else:
        result["value"] = None
        result["unavailable_reason"] = zero_reason
    return result


def _auc(rows: list[tuple[bool, float]]) -> tuple[float, int] | None:
    positives = sum(actual_positive for actual_positive, _ in rows)
    negatives = len(rows) - positives
    if not positives or not negatives:
        return None
    ordered = sorted(rows, key=lambda row: row[1])
    positive_rank_sum = 0.0
    index = 0
    while index < len(ordered):
        end = index + 1
        while end < len(ordered) and ordered[end][1] == ordered[index][1]:
            end += 1
        average_rank = ((index + 1) + end) / 2
        positive_rank_sum += average_rank * sum(
            actual_positive for actual_positive, _ in ordered[index:end]
        )
        index = end
    concordant_pairs = positive_rank_sum - positives * (positives + 1) / 2
    return concordant_pairs, positives * negatives


def evaluate_records(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Return a JSON-serializable report for boolean-labeled evaluation records.

    Rows with invalid labels are ignored. AUC treats larger ``score`` values
    as stronger positive evidence.
    """
    tp = fp = tn = fn = excluded_unknown = 0
    human_fp = human_negatives = 0
    scored: list[tuple[bool, float]] = []
    latencies: list[float] = []
    for record in records:
        if not isinstance(record, Mapping):
            continue
        actual = record.get("actual_positive")
        predicted = record.get("predicted_positive")
        if not isinstance(actual, bool) or (predicted is not None and not isinstance(predicted, bool)):
            continue
        if predicted is None:
            excluded_unknown += 1
        elif actual and predicted:
            tp += 1
        elif actual:
            fn += 1
        elif predicted:
            fp += 1
        else:
            tn += 1
        if record.get("human_ground_truth") is True and actual is False and predicted is not None:
            human_negatives += 1
            if predicted:
                human_fp += 1
        score = _finite_number(record.get("score"))
        if score is not None:
            scored.append((actual, score))
        latency = _finite_number(record.get("latency_ms"))
        if latency is not None and latency >= 0:
            latencies.append(latency)

    metrics: dict[str, Any] = {
        "precision": _metric(tp, tp + fp, zero_reason="zero_predicted_positive_denominator"),
        "recall": _metric(tp, tp + fn, zero_reason="zero_actual_positive_denominator"),
        "fpr": _metric(fp, fp + tn, zero_reason="zero_actual_negative_denominator"),
        "fnr": _metric(fn, fn + tp, zero_reason="zero_actual_positive_denominator"),
        "human_fpr": _metric(human_fp, human_negatives, zero_reason="zero_eligible_human_negative_denominator"),
    }
    metrics["human_fpr"]["scope"] = "human_ground_truth_true_actual_negatives_with_known_prediction"
    auc_stats = _auc(scored)
    if auc_stats is None:
        metrics["auc"] = {
            "value": None,
            "numerator": 0,
            "denominator": 0,
            "positive_count": sum(actual for actual, _ in scored),
            "negative_count": sum(not actual for actual, _ in scored),
            "positive_direction": "higher_score",
        }
        metrics["auc"]["unavailable_reason"] = "scored_rows_require_both_classes"
    else:
        numerator, denominator = auc_stats
        metrics["auc"] = {
            "value": numerator / denominator,
            "numerator": numerator,
            "denominator": denominator,
            "positive_count": sum(actual for actual, _ in scored),
            "negative_count": sum(not actual for actual, _ in scored),
            "positive_direction": "higher_score",
        }
    latency_summary: dict[str, Any] = {"count": len(latencies), "unit": "ms"}
    if latencies:
        latency_summary.update(mean=mean(latencies), median=median(latencies))
    else:
        latency_summary.update(mean=None, median=None, unavailable_reason="no_valid_latency_values")
    return {
        "positive_class": True,
        "counts": {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "excluded_unknown": excluded_unknown},
        "metrics": metrics,
        "latency": latency_summary,
    }

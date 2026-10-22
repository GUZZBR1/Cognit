"""Run a predictor against labeled cases and write its evaluation report."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from time import perf_counter_ns
from typing import Any

from evaluation_harness import evaluate_records


def run_evaluation(
    cases: Iterable[Mapping[str, Any]],
    evaluator: Callable[[Any], Mapping[str, Any]],
    *,
    evaluator_name: str | None = None,
    timer_ns: Callable[[], int] = perf_counter_ns,
) -> dict[str, Any]:
    """Evaluate cases and measure each evaluator call in milliseconds.

    Each case contains ``actual_positive`` and ``input``, plus optional
    ``human_ground_truth``. The evaluator receives only ``input`` and returns
    ``predicted_positive`` (bool or ``None`` for unknown), plus an optional
    ranking ``score`` where higher means more positive evidence.
    """
    records: list[dict[str, Any]] = []
    case_count = 0
    for case in cases:
        case_count += 1
        if not isinstance(case, Mapping) or not isinstance(case.get("actual_positive"), bool):
            raise ValueError("each case must have a boolean actual_positive label")
        human_truth = case.get("human_ground_truth")
        if human_truth is not None and not isinstance(human_truth, bool):
            raise ValueError("human_ground_truth must be a boolean when supplied")

        started = timer_ns()
        prediction = evaluator(case.get("input"))
        elapsed_ms = (timer_ns() - started) / 1_000_000
        if not isinstance(prediction, Mapping):
            raise ValueError("evaluator must return a mapping")
        predicted_positive = prediction.get("predicted_positive")
        if predicted_positive is not None and not isinstance(predicted_positive, bool):
            raise ValueError("predicted_positive must be a boolean or None")

        record = {
            "actual_positive": case["actual_positive"],
            "predicted_positive": predicted_positive,
            "latency_ms": elapsed_ms,
        }
        if human_truth is not None:
            record["human_ground_truth"] = human_truth
        if "score" in prediction:
            record["score"] = prediction["score"]
        records.append(record)

    report = evaluate_records(records)
    if evaluator_name is None:
        module_name = getattr(evaluator, "__module__", None) or type(evaluator).__module__
        callable_name = getattr(evaluator, "__qualname__", None) or type(evaluator).__qualname__
        evaluator_name = ".".join((module_name, callable_name))
    if not isinstance(evaluator_name, str) or not evaluator_name.strip():
        raise ValueError("evaluator_name must be a non-empty string")
    report["evaluator"] = evaluator_name
    report["run"] = {"case_count": case_count, "evaluated_count": len(records)}
    return report


def write_report(report: Mapping[str, Any], output_path: str | Path) -> None:
    """Write a stable, timestamp-free JSON report."""
    Path(output_path).write_text(
        json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )

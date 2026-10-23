#!/usr/bin/env python3
"""Deterministic, training-free gate for grouped ML dataset readiness."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

SPLITS = ("train", "validation", "final_holdout")
LABELS = ("HUMAN", "SCRIPTED_AUTOMATION", "AI_AGENT", "UNKNOWN")
GROUP_DIMENSIONS = ("participant", "session", "agent_config")
REASONS = {
    "INVALID_INPUT": "Input or protocol structure is invalid.",
    "PROTOCOL_CRITERIA_MISSING": "Predeclared statistical criteria are missing or invalid.",
    "PROTOCOL_VERSION_INVALID": "The split protocol version is missing or unsupported.",
    "GROUP_ID_MISSING": "A required protocol group identity is missing.",
    "GROUP_LEAKAGE": "A protocol group occurs in incompatible partitions.",
    "HOLDOUT_MISSING": "The final holdout is absent.",
    "HOLDOUT_NOT_SEALED": "The final holdout is not sealed and unavailable for tuning.",
    "LABEL_PROVENANCE_INVALID": "A label is missing independent, valid provenance.",
    "CLASS_COVERAGE_INSUFFICIENT": "Predeclared class coverage criteria are not met.",
    "GROUP_COVERAGE_INSUFFICIENT": "Predeclared independent-group coverage criteria are not met.",
}


def _load(path: Path) -> Any:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def _valid_thresholds(protocol: Any) -> bool:
    if not isinstance(protocol, dict):
        return False
    groups = protocol.get("group_dimensions")
    criteria = protocol.get("criteria")
    if (not isinstance(groups, list) or not groups or "session" not in groups or
            "participant" not in groups or
            any(item not in GROUP_DIMENSIONS for item in groups) or
            any(not isinstance(item, str) or not item for item in groups) or
            len(set(groups)) != len(groups) or not isinstance(criteria, dict)):
        return False
    class_min = criteria.get("minimum_class_records_per_split")
    group_min = criteria.get("minimum_independent_groups_per_split")
    precision = criteria.get("precision_target")
    confidence = criteria.get("confidence_level")
    trainable = protocol.get("trainable_labels")
    if (not isinstance(class_min, dict) or not isinstance(group_min, dict) or
            not isinstance(precision, (int, float)) or isinstance(precision, bool) or
            not 0 < precision <= 1 or not math.isfinite(precision) or
            not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or
            not 0 < confidence < 1 or not math.isfinite(confidence) or
            not isinstance(trainable, list) or not trainable or
            "UNKNOWN" in trainable or any(label not in LABELS for label in trainable)):
        return False
    if set(trainable) & {"AI_AGENT", "SCRIPTED_AUTOMATION"} and "agent_config" not in groups:
        return False
    for label in trainable:
        minimum = class_min.get(label)
        if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 1:
            return False
    for dimension in groups:
        limits = group_min.get(dimension)
        if (not isinstance(limits, dict) or
                any(not isinstance(limits.get(split), int) or isinstance(limits[split], bool) or
                    limits[split] < 1 for split in SPLITS)):
            return False
    return True


def evaluate(manifest: Any) -> dict[str, Any]:
    reasons: set[str] = set()
    if not isinstance(manifest, dict) or not isinstance(manifest.get("records"), list):
        return _report(["INVALID_INPUT"], {}, {}, {})
    protocol = manifest.get("protocol")
    if not _valid_thresholds(protocol):
        reasons.add("PROTOCOL_CRITERIA_MISSING")
        return _report(reasons, {}, {}, {})
    if protocol.get("version") != "grouped-split-v1":
        reasons.add("PROTOCOL_VERSION_INVALID")

    dimensions = protocol["group_dimensions"]
    trainable = set(protocol["trainable_labels"])
    labels: dict[str, Counter[str]] = {split: Counter() for split in SPLITS}
    group_ids: dict[str, dict[str, dict[str, set[str]]]] = {
        split: {dimension: defaultdict(set) for dimension in dimensions} for split in SPLITS
    }
    holdout_records = 0
    record_ids: set[str] = set()

    for row in manifest["records"]:
        if not isinstance(row, dict) or row.get("split") not in SPLITS:
            reasons.add("INVALID_INPUT")
            continue
        split = row["split"]
        if split == "final_holdout":
            holdout_records += 1
        record_id = row.get("record_id")
        if not isinstance(record_id, str) or not record_id:
            reasons.add("INVALID_INPUT")
        elif record_id in record_ids:
            reasons.add("INVALID_INPUT")
        else:
            record_ids.add(record_id)
        ground_truth = row.get("ground_truth")
        if (not isinstance(ground_truth, dict) or ground_truth.get("label") not in LABELS or
                not isinstance(ground_truth.get("provenance"), str) or
                ground_truth.get("provenance") not in (
                    "independent_human_confirmation", "dataset_label", "external_oracle"
                ) or not isinstance(ground_truth.get("reference"), str) or
                not ground_truth.get("reference")):
            reasons.add("LABEL_PROVENANCE_INVALID")
            continue
        label = ground_truth["label"]
        labels[split][label] += 1
        group_map = row.get("groups")
        if not isinstance(group_map, dict):
            reasons.add("GROUP_ID_MISSING")
            continue
        for dimension in dimensions:
            value = group_map.get(dimension)
            if not isinstance(value, str) or not value:
                reasons.add("GROUP_ID_MISSING")
                continue
            group_ids[split][dimension][value].add(record_id if isinstance(record_id, str) else "")

    holdout = manifest.get("final_holdout")
    if holdout_records == 0:
        reasons.add("HOLDOUT_MISSING")
    if (not isinstance(holdout, dict) or holdout.get("sealed") is not True or
            holdout.get("available_for_tuning") is not False):
        reasons.add("HOLDOUT_NOT_SEALED")

    overlaps: dict[str, dict[str, int]] = {}
    for dimension in dimensions:
        by_split = {split: set(group_ids[split][dimension]) for split in SPLITS}
        dimension_overlap: dict[str, int] = {}
        for left_index, left in enumerate(SPLITS):
            for right in SPLITS[left_index + 1:]:
                common = by_split[left] & by_split[right]
                dimension_overlap[f"{left}:{right}"] = len(common)
        overlaps[dimension] = dimension_overlap
        if any(dimension_overlap.values()):
            reasons.add("GROUP_LEAKAGE")

    class_counts = {
        split: {label: labels[split][label] for label in (*LABELS, "ALL")}
        for split in SPLITS
    }
    for split in SPLITS:
        class_counts[split]["ALL"] = sum(labels[split].values())
        for label in trainable:
            if labels[split][label] < protocol["criteria"]["minimum_class_records_per_split"][label]:
                reasons.add("CLASS_COVERAGE_INSUFFICIENT")
        for dimension in dimensions:
            count = len(group_ids[split][dimension])
            required = protocol["criteria"]["minimum_independent_groups_per_split"][dimension][split]
            if count < required:
                reasons.add("GROUP_COVERAGE_INSUFFICIENT")

    group_counts = {
        split: {dimension: len(group_ids[split][dimension]) for dimension in dimensions}
        for split in SPLITS
    }
    report = _report(reasons, class_counts, group_counts, overlaps)
    report["protocol"] = {
        "version": protocol.get("version"),
        "trainable_labels": sorted(trainable),
        "precision_target": protocol["criteria"]["precision_target"],
        "confidence_level": protocol["criteria"]["confidence_level"],
        "minimum_class_records_per_split": protocol["criteria"]["minimum_class_records_per_split"],
        "minimum_independent_groups_per_split": protocol["criteria"]["minimum_independent_groups_per_split"],
    }
    return report


def _report(reasons: set[str] | list[str], classes: dict[str, Any],
            groups: dict[str, Any], overlaps: dict[str, Any]) -> dict[str, Any]:
    codes = sorted(reasons)
    return {
        "report_version": "ml-readiness-v1",
        "evidence_mode": "SIMULATED",
        "ml_ready": "YES" if not codes else "NO",
        "reasons": [{"code": code, "message": REASONS[code]} for code in codes],
        "counts": {"classes_by_split": classes, "independent_groups_by_split": groups},
        "group_overlap_counts": overlaps,
        "training_invoked": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="JSON records and predeclared split protocol")
    args = parser.parse_args()
    try:
        report = evaluate(_load(args.manifest))
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps(_report(["INVALID_INPUT"], {}, {}, {}), sort_keys=True))
        print(f"cannot read manifest: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if report["ml_ready"] == "YES" else 1


if __name__ == "__main__":
    raise SystemExit(main())

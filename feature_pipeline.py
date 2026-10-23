"""Versioned, aggregate-only Python port of the mouse feature pipeline."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


PIPELINE_VERSION = 1
INPUT_SCHEMA_VERSION = 1
TRANSFORMATION_VERSION = 1
DEFAULT_PAUSE_THRESHOLD_MS = 100
_DEFAULT_OPTIONS = object()
FEATURE_NAMES = (
    "distancePx",
    "durationMs",
    "meanSpeedPxPerMs",
    "maxSpeedPxPerMs",
    "meanAccelerationPxPerMs2",
    "meanAbsoluteAccelerationPxPerMs2",
    "pauseCount",
    "pauseDurationMs",
    "directionChanges",
    "speedVariation",
    "trajectoryEntropyBits",
)


def _finite_number(value: Any) -> bool:
    # bool is an int subclass in Python, but JavaScript Number.isFinite rejects it.
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _aggregate(points: Any, pause_threshold_ms: Any) -> dict[str, Any]:
    if not isinstance(points, list):
        return {"status": "invalid", "issues": ["points_must_be_an_array"], "pointCount": 0, "features": None}
    if not _finite_number(pause_threshold_ms) or pause_threshold_ms < 0:
        return {"status": "invalid", "issues": ["invalid_pause_threshold"], "pointCount": len(points), "features": None}
    if len(points) < 2:
        return {"status": "incomplete", "issues": ["insufficient_points"], "pointCount": len(points), "features": None}

    for index, point in enumerate(points):
        if not isinstance(point, dict):
            return {"status": "invalid", "issues": ["malformed_point"], "pointCount": len(points), "features": None}
        if not all(_finite_number(point.get(field)) for field in ("x", "y", "t")):
            return {"status": "invalid", "issues": ["non_finite_point_value"], "pointCount": len(points), "features": None}
        if index and point["t"] <= points[index - 1]["t"]:
            return {"status": "invalid", "issues": ["non_monotonic_timestamp"], "pointCount": len(points), "features": None}

    segments = []
    distance_px = 0.0
    pause_count = 0
    pause_duration_ms = 0.0
    for previous, current in zip(points, points[1:]):
        dx = current["x"] - previous["x"]
        dy = current["y"] - previous["y"]
        duration_ms = current["t"] - previous["t"]
        distance = math.hypot(dx, dy)
        speed = distance / duration_ms
        if not all(_finite_number(value) for value in (dx, dy, duration_ms, distance, speed)):
            return {"status": "invalid", "issues": ["non_finite_derived_value"], "pointCount": len(points), "features": None}
        segments.append({"dx": dx, "dy": dy, "durationMs": duration_ms, "distance": distance, "speed": speed})
        distance_px += distance
        if distance == 0 and duration_ms >= pause_threshold_ms:
            pause_count += 1
            pause_duration_ms += duration_ms

    duration_ms = points[-1]["t"] - points[0]["t"]
    speeds = [segment["speed"] for segment in segments]
    mean_speed = distance_px / duration_ms
    mean_segment_speed = sum(speeds) / len(speeds)
    speed_variance = sum((speed - mean_segment_speed) ** 2 for speed in speeds) / len(speeds)
    speed_variation = None if mean_segment_speed == 0 else math.sqrt(speed_variance) / mean_segment_speed

    accelerations = []
    for previous, current in zip(segments, segments[1:]):
        midpoint_interval = (previous["durationMs"] + current["durationMs"]) / 2
        accelerations.append((current["speed"] - previous["speed"]) / midpoint_interval)

    moving = [segment for segment in segments if segment["distance"] > 0]
    direction_bins = [0] * 8
    directions = []
    for segment in moving:
        angle = (math.atan2(segment["dy"], segment["dx"]) + 2 * math.pi) % (2 * math.pi)
        bin_index = math.floor((angle + math.pi / 8) / (math.pi / 4)) % 8
        direction_bins[bin_index] += 1
        directions.append(bin_index)
    direction_changes = sum(a != b for a, b in zip(directions, directions[1:]))
    entropy = 0.0
    for count in direction_bins:
        if count:
            probability = count / len(moving)
            entropy -= probability * math.log2(probability)

    features = {
        "distancePx": distance_px,
        "durationMs": duration_ms,
        "meanSpeedPxPerMs": mean_speed,
        "maxSpeedPxPerMs": max(speeds),
        "meanAccelerationPxPerMs2": sum(accelerations) / len(accelerations) if accelerations else None,
        "meanAbsoluteAccelerationPxPerMs2": sum(abs(value) for value in accelerations) / len(accelerations) if accelerations else None,
        "pauseCount": pause_count,
        "pauseDurationMs": pause_duration_ms,
        "directionChanges": direction_changes,
        "speedVariation": speed_variation,
        "trajectoryEntropyBits": entropy,
    }
    if not all(value is None or _finite_number(value) for value in features.values()):
        return {"status": "invalid", "issues": ["non_finite_derived_value"], "pointCount": len(points), "features": None}
    return {"status": "complete", "issues": [], "pointCount": len(points), "features": features}


def build_mouse_feature_record(input_record: Any, options: Any = _DEFAULT_OPTIONS) -> dict[str, Any]:
    """Build a provenance-bearing feature record without retaining raw points."""
    if not isinstance(input_record, dict):
        raise TypeError("input_must_be_an_object")
    if type(input_record.get("schemaVersion")) is not int or input_record["schemaVersion"] != INPUT_SCHEMA_VERSION:
        raise TypeError("unsupported_input_schema_version")
    if options is _DEFAULT_OPTIONS:
        options = {}
    if not isinstance(options, dict):
        raise TypeError("options_must_be_an_object")
    if "attemptId" in input_record and not isinstance(input_record["attemptId"], str):
        raise TypeError("attempt_id_must_be_a_string")
    if "points" in input_record and not isinstance(input_record["points"], list):
        raise TypeError("points_must_be_an_array")

    missing_fields = []
    points = input_record.get("points")
    if "points" not in input_record:
        missing_fields.append("points")
    if points is not None:
        for index, point in enumerate(points):
            if not isinstance(point, dict):
                raise TypeError(f"malformed_point_{index}")
            for field in ("x", "y", "t"):
                if field not in point:
                    missing_fields.append(f"points[{index}].{field}")

    pause_threshold = options.get("pauseThresholdMs", DEFAULT_PAUSE_THRESHOLD_MS)
    aggregated = None if missing_fields else _aggregate(points, pause_threshold)
    provenance_pause_threshold = pause_threshold if _finite_number(pause_threshold) else None
    status = "incomplete" if missing_fields else aggregated["status"]
    issues = ["missing_input_fields"] if missing_fields else aggregated["issues"]
    features = None if aggregated is None else aggregated["features"]
    unavailable = [name for name, value in features.items() if value is None] if features is not None else list(FEATURE_NAMES)
    record = {
        "schemaVersion": INPUT_SCHEMA_VERSION,
        "pipelineVersion": PIPELINE_VERSION,
        "provenance": {
            "source": "mouse-telemetry",
            "inputSchemaVersion": input_record["schemaVersion"],
            "transformation": {
                "name": "aggregateMouseAttempt",
                "version": TRANSFORMATION_VERSION,
                "parameters": {"pauseThresholdMs": provenance_pause_threshold},
            },
        },
        "status": status,
        "issues": issues,
        "pointCount": len(points) if points is not None else 0,
        "features": features,
        "missingInputFields": missing_fields,
        "unavailableFeatures": unavailable,
    }
    if "attemptId" in input_record:
        record["attemptId"] = input_record["attemptId"]
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build an aggregate mouse feature record from a JSON attempt.")
    parser.add_argument("input", type=Path, help="path to an input attempt JSON file")
    args = parser.parse_args(argv)
    try:
        input_record = json.loads(args.input.read_text(encoding="utf-8"))
        result = build_mouse_feature_record(input_record)
        json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        sys.stdout.write("\n")
    except (OSError, json.JSONDecodeError, TypeError, ValueError, OverflowError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

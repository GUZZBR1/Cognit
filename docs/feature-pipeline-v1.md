# Mouse feature pipeline v1

This document defines the planned version 1 record for converting one supplied mouse attempt into aggregate features. The pipeline reuses `aggregateMouseAttempt` from `src/mouse-telemetry.mjs`; it does not add another feature extractor.

## Input

The caller supplies one attempt with this shape:

```json
{
  "schemaVersion": 1,
  "attemptId": "attempt-optional",
  "points": [
    { "x": 10, "y": 20, "t": 1000 },
    { "x": 14, "y": 23, "t": 1016 }
  ]
}
```

`schemaVersion` must be `1`. `attemptId` is optional and, when present, is a string chosen by the caller. `points` is an ordered array of points. Each `x` and `y` is a finite coordinate in CSS pixels; `t` is a finite timestamp in milliseconds from a consistent clock. Timestamps must strictly increase. The aggregator needs at least two points to calculate features.

The planned entry point is:

```js
buildMouseFeatureRecord(input, options = {})
```

`options.pauseThresholdMs` sets the minimum stationary segment duration counted as a pause. It defaults to `100` milliseconds and must be a finite, non-negative number. The wrapper passes the supported threshold to `aggregateMouseAttempt` and records its effective value with the result.

## Output record

A record contains the input schema version and pipeline version, provenance, aggregate status and issues, point count, features, and explicit availability metadata. `attemptId` is copied when supplied.

```json
{
  "schemaVersion": 1,
  "pipelineVersion": 1,
  "attemptId": "attempt-optional",
  "provenance": {
    "source": "mouse-telemetry",
    "inputSchemaVersion": 1,
    "transformation": {
      "name": "aggregateMouseAttempt",
      "version": 1,
      "parameters": { "pauseThresholdMs": 100 }
    }
  },
  "status": "complete",
  "issues": [],
  "pointCount": 2,
  "features": {
    "distancePx": 5,
    "durationMs": 16,
    "meanSpeedPxPerMs": 0.3125,
    "maxSpeedPxPerMs": 0.3125,
    "meanAccelerationPxPerMs2": null,
    "meanAbsoluteAccelerationPxPerMs2": null,
    "pauseCount": 0,
    "pauseDurationMs": 0,
    "directionChanges": 0,
    "speedVariation": 0,
    "trajectoryEntropyBits": 0
  },
  "missingInputFields": [],
  "unavailableFeatures": [
    "meanAccelerationPxPerMs2",
    "meanAbsoluteAccelerationPxPerMs2"
  ]
}
```

`pipelineVersion` identifies this wrapper contract. `provenance` records where the points came from, which input schema was used, which transformation ran, its version, and the effective parameters. The transformation version refers to the existing aggregator contract; bump it if its behavior changes in a way that can change feature values. The pipeline version changes when the record contract or wrapper behavior changes.

`status` follows the aggregator: `complete`, `incomplete`, or `invalid`. `issues` contains machine-readable reasons. The wrapper adds `missing_input_fields` for absent points or coordinates. The aggregator can report `invalid_pause_threshold`, `insufficient_points`, `non_finite_point_value`, `non_monotonic_timestamp`, and `non_finite_derived_value` for this input path.

For a missing required field, the wrapper reports the field names in `missingInputFields`, records an issue, and does not present a complete record. An unsupported input schema or structurally malformed envelope throws `TypeError`; schema versions are never silently accepted. `unavailableFeatures` lists features that cannot be calculated for that attempt. If aggregation is incomplete or invalid, `features` is `null` and `unavailableFeatures` contains every feature name in the v1 schema. When aggregation succeeds, a feature can still be `null` where its formula has no meaningful denominator or input—for example, acceleration with fewer than three points, or speed variation when mean segment speed is zero. A single nonzero-speed segment has a speed variation of `0`, because its population standard deviation is zero. `unavailableFeatures` includes the feature names whose values are null.

Missing, incomplete, invalid, or `null` values mean that the feature is unavailable. They are not zero, evidence of inactivity, or a positive or negative behavioral signal. Consumers must preserve that distinction and must not impute a favorable or unfavorable value without a separate, documented policy.

The output contains aggregate values only. It does not collect new browser events and does not include raw points, coordinates, timestamps, or the original trajectory.

## Features and semantics

The aggregator treats each adjacent pair of points as a segment. Segment distance is Euclidean distance in pixels; segment speed is distance divided by elapsed milliseconds. A segment is stationary when its distance is zero. A stationary segment is counted as a pause when its duration is at least `pauseThresholdMs`.

| Feature | Unit | Definition |
| --- | --- | --- |
| `distancePx` | CSS pixels | Sum of Euclidean distances across adjacent point pairs. |
| `durationMs` | milliseconds | Last point timestamp minus first point timestamp. |
| `meanSpeedPxPerMs` | pixels per millisecond | Total distance divided by total duration. |
| `maxSpeedPxPerMs` | pixels per millisecond | Maximum speed among adjacent-point segments. |
| `meanAccelerationPxPerMs2` | pixels per millisecond squared | Arithmetic mean of signed changes in adjacent segment speeds divided by the time between their midpoints. `null` when there are no acceleration samples. |
| `meanAbsoluteAccelerationPxPerMs2` | pixels per millisecond squared | Arithmetic mean of the absolute acceleration samples. `null` when there are no acceleration samples. |
| `pauseCount` | pauses | Count of stationary segments whose duration is at least `pauseThresholdMs`. |
| `pauseDurationMs` | milliseconds | Sum of the durations of counted pause segments. |
| `directionChanges` | changes | Count of consecutive moving segments whose quantized direction bins differ. Stationary segments are excluded. |
| `speedVariation` | unitless coefficient | Population standard deviation of segment speeds divided by their arithmetic mean. `null` when the mean segment speed is zero. |
| `trajectoryEntropyBits` | bits | Shannon entropy (`-Σ p log₂ p`) of moving-segment counts in eight compass-direction bins. Stationary segments are excluded. |

Directions use eight compass bins, each 45 degrees wide, based on `atan2(dy, dx)` with the positive x-axis as zero. Entropy is `0` if all moving segments fall in one bin. If there are no moving segments, the current aggregator returns `0` for entropy because every direction-bin count is zero. This is a limitation of the current aggregator semantics; consumers should use `pauseCount` and `distancePx` to distinguish that case from a single-bin moving trajectory.

Acceleration compares each pair of adjacent segment speeds. The elapsed interval is the average of the two segment durations, equivalent to the time between their midpoints. Therefore, an attempt with only one segment has no acceleration sample and the two acceleration features are `null`.

## Validation behavior

The wrapper rejects non-object input, unsupported schema versions, non-string `attemptId`, non-array `points`, malformed point objects, and non-object options with `TypeError`. Missing `points` or point coordinates return `incomplete` with `missing_input_fields` and the absent field paths. For a present points array, the aggregator reports invalid pause thresholds, non-finite input or derived values, and timestamps that do not strictly increase. Fewer than two points returns `incomplete` with `insufficient_points`. When aggregation is incomplete or invalid, the wrapper retains `pointCount` when it can determine it, sets `features` to `null`, and marks every v1 feature unavailable rather than fabricating values.

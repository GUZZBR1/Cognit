# Python mouse feature pipeline v1

`feature_pipeline.py` is a standard-library-only Python port of the v1 wrapper in `src/feature-pipeline.mjs` and the aggregator in `src/mouse-telemetry.mjs`. It accepts one attempt using schema version 1 and emits a versioned aggregate record. The command-line interface reads a JSON file and writes one JSON record to stdout:

```sh
python3 feature_pipeline.py test/fixtures/mouse-attempt-v1.json
```

The input contains `schemaVersion: 1`, optional string `attemptId`, and an ordered `points` array of `{x, y, t}` objects. Coordinates are CSS pixels and timestamps are milliseconds from a consistent clock. Timestamps must strictly increase. `pauseThresholdMs` can be passed through the Python function options; it defaults to 100 ms and must be finite and non-negative.

If a caller supplies a non-finite pause threshold, the record is `invalid` with `invalid_pause_threshold`; provenance stores that non-JSON value as `null` so the record remains valid JSON.

The output includes `schemaVersion`, `pipelineVersion`, `provenance`, `status`, `issues`, `pointCount`, `features`, `missingInputFields`, and `unavailableFeatures`; `attemptId` is copied when supplied. It contains aggregate values only and never includes point objects, coordinates, timestamps, or the source trajectory. Missing required fields produce `incomplete` with their paths listed. Unsupported schemas and malformed envelopes raise `TypeError`. Invalid point data, timestamps, thresholds, and derived values retain explicit issue codes. When aggregation is incomplete or invalid, `features` is null and every feature is listed as unavailable. Feature values that have no meaningful denominator are also null and listed in `unavailableFeatures`.

## Feature semantics

Each adjacent point pair forms a segment. Distance is Euclidean distance; speed is distance divided by elapsed time. Total distance is the sum of segment distances, and duration is last timestamp minus first. Mean speed is total distance divided by total duration, and maximum speed is the largest segment speed. A stationary segment is a pause when its duration is at least the threshold; pause count and duration include only such segments.

Direction uses eight compass bins of 45 degrees, using `atan2(dy, dx)` and the positive x-axis as zero. Direction changes count differing bins between consecutive moving segments; stationary segments are omitted. Trajectory entropy is Shannon entropy in bits over moving-segment bins. With no moving segments the existing aggregator returns zero entropy. Speed variation is the population standard deviation of segment speeds divided by their arithmetic mean, or null if that mean is zero. Acceleration samples are signed changes in adjacent segment speeds divided by the time between their midpoints; signed and absolute means are null when no samples exist.

Null or missing values represent unavailable data, not zero or behavioral evidence. Consumers must preserve this distinction. Pipeline version identifies the record wrapper; transformation version identifies the existing aggregator semantics. Increment the appropriate version if a change can affect its contract or output.

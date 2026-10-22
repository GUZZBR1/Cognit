const SCHEMA_VERSION = 1;

function result(status, issues, pointCount = 0, features = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    issues,
    pointCount,
    features,
  };
}

/**
 * Aggregate a single mouse interaction attempt without returning its trajectory.
 * Points use the shape { x, y, t }, where t is a timestamp in milliseconds.
 *
 * A pause is a stationary segment at or above `pauseThresholdMs` (default 100).
 * Direction changes and entropy use moving segments quantized to eight compass
 * directions. Speed variation is the coefficient of variation across segment
 * speeds; acceleration is the signed and absolute change in speed over time.
 * If a feature has no meaningful denominator, it is `null`.
 */
export function aggregateMouseAttempt(points, options = {}) {
  if (!Array.isArray(points)) {
    return result('invalid', ['points_must_be_an_array']);
  }

  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return result('invalid', ['options_must_be_an_object']);
  }

  const pauseThresholdMs = options.pauseThresholdMs ?? 100;
  if (!Number.isFinite(pauseThresholdMs) || pauseThresholdMs < 0) {
    return result('invalid', ['invalid_pause_threshold'], points.length);
  }

  if (points.length < 2) {
    return result('incomplete', ['insufficient_points'], points.length);
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === null || typeof point !== 'object' || Array.isArray(point)) {
      return result('invalid', ['malformed_point'], points.length);
    }
    if (![point.x, point.y, point.t].every(Number.isFinite)) {
      return result('invalid', ['non_finite_point_value'], points.length);
    }
    if (index > 0 && point.t <= points[index - 1].t) {
      return result('invalid', ['non_monotonic_timestamp'], points.length);
    }
  }

  const segments = [];
  let distancePx = 0;
  let pauseCount = 0;
  let pauseDurationMs = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const durationMs = current.t - previous.t;
    const distance = Math.hypot(dx, dy);
    const speed = distance / durationMs;

    if (![dx, dy, durationMs, distance, speed].every(Number.isFinite)) {
      return result('invalid', ['non_finite_derived_value'], points.length);
    }

    distancePx += distance;
    segments.push({ dx, dy, durationMs, distance, speed });

    if (distance === 0 && durationMs >= pauseThresholdMs) {
      pauseCount += 1;
      pauseDurationMs += durationMs;
    }
  }

  const durationMs = points.at(-1).t - points[0].t;
  const speeds = segments.map((segment) => segment.speed);
  const meanSpeedPxPerMs = distancePx / durationMs;
  const meanSegmentSpeedPxPerMs = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
  const speedVariance = speeds.reduce(
    (sum, speed) => sum + (speed - meanSegmentSpeedPxPerMs) ** 2,
    0,
  ) / speeds.length;
  const speedVariation = meanSegmentSpeedPxPerMs === 0
    ? null
    : Math.sqrt(speedVariance) / meanSegmentSpeedPxPerMs;

  const accelerations = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const midpointIntervalMs = (previous.durationMs + current.durationMs) / 2;
    accelerations.push((current.speed - previous.speed) / midpointIntervalMs);
  }

  const movingSegments = segments.filter((segment) => segment.distance > 0);
  const directionBins = Array(8).fill(0);
  const directions = movingSegments.map((segment) => {
    const angle = (Math.atan2(segment.dy, segment.dx) + 2 * Math.PI) % (2 * Math.PI);
    const bin = Math.floor((angle + Math.PI / 8) / (Math.PI / 4)) % 8;
    directionBins[bin] += 1;
    return bin;
  });
  const directionChanges = directions.slice(1).reduce(
    (count, direction, index) => count + Number(direction !== directions[index]),
    0,
  );
  const trajectoryEntropyBits = directionBins.reduce((entropy, count) => {
    if (count === 0) return entropy;
    const probability = count / movingSegments.length;
    return entropy - probability * Math.log2(probability);
  }, 0);

  const features = {
    distancePx,
    durationMs,
    meanSpeedPxPerMs,
    maxSpeedPxPerMs: speeds.reduce((maximum, speed) => Math.max(maximum, speed), 0),
    meanAccelerationPxPerMs2: accelerations.length
      ? accelerations.reduce((sum, value) => sum + value, 0) / accelerations.length
      : null,
    meanAbsoluteAccelerationPxPerMs2: accelerations.length
      ? accelerations.reduce((sum, value) => sum + Math.abs(value), 0) / accelerations.length
      : null,
    pauseCount,
    pauseDurationMs,
    directionChanges,
    speedVariation,
    trajectoryEntropyBits,
  };

  if (!Object.values(features).every((value) => value === null || Number.isFinite(value))) {
    return result('invalid', ['non_finite_derived_value'], points.length);
  }

  return result('complete', [], points.length, features);
}

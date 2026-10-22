import { aggregateMouseAttempt } from './mouse-telemetry.mjs';

const PIPELINE_VERSION = 1;
const INPUT_SCHEMA_VERSION = 1;
const TRANSFORMATION_VERSION = 1;
const FEATURE_NAMES = [
  'distancePx',
  'durationMs',
  'meanSpeedPxPerMs',
  'maxSpeedPxPerMs',
  'meanAccelerationPxPerMs2',
  'meanAbsoluteAccelerationPxPerMs2',
  'pauseCount',
  'pauseDurationMs',
  'directionChanges',
  'speedVariation',
  'trajectoryEntropyBits',
];

/** Build a versioned, provenance-bearing feature record from one mouse attempt. */
export function buildMouseFeatureRecord(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input_must_be_an_object');
  }
  if (input.schemaVersion !== INPUT_SCHEMA_VERSION) {
    throw new TypeError('unsupported_input_schema_version');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options_must_be_an_object');
  }
  if (input.attemptId !== undefined && typeof input.attemptId !== 'string') {
    throw new TypeError('attempt_id_must_be_a_string');
  }
  if (input.points !== undefined && !Array.isArray(input.points)) {
    throw new TypeError('points_must_be_an_array');
  }

  const missingInputFields = [];
  const points = input.points;
  if (points === undefined) missingInputFields.push('points');
  if (points) {
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (point === undefined) {
        missingInputFields.push(`points[${index}]`);
        continue;
      }
      if (point === null || typeof point !== 'object' || Array.isArray(point)) {
        throw new TypeError(`malformed_point_${index}`);
      }
      for (const field of ['x', 'y', 't']) {
        if (point[field] === undefined) missingInputFields.push(`points[${index}].${field}`);
      }
    }
  }

  const aggregateOptions = {};
  if (options.pauseThresholdMs !== undefined) {
    aggregateOptions.pauseThresholdMs = options.pauseThresholdMs;
  }
  const aggregated = missingInputFields.length
    ? null
    : aggregateMouseAttempt(points, aggregateOptions);
  const issues = missingInputFields.length
    ? ['missing_input_fields']
    : aggregated.issues;
  const status = missingInputFields.length
    ? 'incomplete'
    : aggregated.status;
  const features = aggregated?.features ?? null;
  const unavailableFeatures = features
    ? Object.entries(features).filter(([, value]) => value === null).map(([name]) => name)
    : [...FEATURE_NAMES];

  const record = {
    schemaVersion: INPUT_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    provenance: {
      source: 'mouse-telemetry',
      inputSchemaVersion: input.schemaVersion,
      transformation: {
        name: 'aggregateMouseAttempt',
        version: TRANSFORMATION_VERSION,
        parameters: { pauseThresholdMs: aggregateOptions.pauseThresholdMs ?? 100 },
      },
    },
    status,
    issues,
    pointCount: points?.length ?? 0,
    features,
    missingInputFields,
    unavailableFeatures,
  };
  if (input.attemptId !== undefined) record.attemptId = input.attemptId;
  return record;
}

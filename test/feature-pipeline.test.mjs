import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMouseFeatureRecord } from '../src/feature-pipeline.mjs';

const fixture = {
  schemaVersion: 1,
  attemptId: 'attempt-1',
  points: [
    { x: 0, y: 0, t: 0 },
    { x: 3, y: 4, t: 10 },
    { x: 3, y: 4, t: 120 },
  ],
};

test('builds a repeatable feature record with provenance and schema versions', () => {
  const first = buildMouseFeatureRecord(fixture);
  assert.deepEqual(first, buildMouseFeatureRecord(fixture));
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.pipelineVersion, 1);
  assert.equal(first.attemptId, 'attempt-1');
  assert.deepEqual(first.provenance, {
    source: 'mouse-telemetry',
    inputSchemaVersion: 1,
    transformation: {
      name: 'aggregateMouseAttempt',
      version: 1,
      parameters: { pauseThresholdMs: 100 },
    },
  });
  assert.equal(first.status, 'complete');
  assert.equal(first.features.distancePx, 5);
  assert.equal(first.features.durationMs, 120);
  assert.deepEqual(first.unavailableFeatures, []);
});

test('lists null-valued features as unavailable without replacing them with zero', () => {
  const record = buildMouseFeatureRecord({
    schemaVersion: 1,
    points: [{ x: 4, y: 4, t: 0 }, { x: 4, y: 4, t: 200 }],
  });

  assert.equal(record.features.speedVariation, null);
  assert.equal(record.features.meanAccelerationPxPerMs2, null);
  assert.equal(record.features.meanAbsoluteAccelerationPxPerMs2, null);
  assert.deepEqual(record.unavailableFeatures, [
    'meanAccelerationPxPerMs2',
    'meanAbsoluteAccelerationPxPerMs2',
    'speedVariation',
  ]);
});

test('lists all features unavailable when the input is missing', () => {
  const record = buildMouseFeatureRecord({ schemaVersion: 1 });
  assert.equal(record.status, 'incomplete');
  assert.deepEqual(record.missingInputFields, ['points']);
  assert.equal(record.features, null);
  assert.equal(record.unavailableFeatures.length, 11);
  assert.ok(record.unavailableFeatures.includes('distancePx'));
});

test('marks missing point fields incomplete and does not emit numeric features', () => {
  const record = buildMouseFeatureRecord({
    schemaVersion: 1,
    points: [{ x: 1, t: 0 }, { x: 2, y: 3, t: 10 }],
  });
  assert.equal(record.status, 'incomplete');
  assert.deepEqual(record.missingInputFields, ['points[0].y']);
  assert.equal(record.features, null);
  assert.deepEqual(record.issues, ['missing_input_fields']);
});

test('retains aggregator incomplete semantics for empty or insufficient points', () => {
  assert.deepEqual(buildMouseFeatureRecord({ schemaVersion: 1, points: [] }).issues, ['insufficient_points']);
  const single = buildMouseFeatureRecord({ schemaVersion: 1, points: [{ x: 1, y: 2, t: 3 }] });
  assert.equal(single.status, 'incomplete');
  assert.deepEqual(single.issues, ['insufficient_points']);
});

test('rejects unknown or malformed input schemas explicitly', () => {
  assert.throws(() => buildMouseFeatureRecord({ schemaVersion: 2, points: [] }), /unsupported_input_schema_version/);
  assert.throws(() => buildMouseFeatureRecord({ schemaVersion: 1, points: {} }), /points_must_be_an_array/);
});

test('does not include raw points in the feature record', () => {
  const record = buildMouseFeatureRecord(fixture);
  assert.equal(Object.hasOwn(record, 'points'), false);
  assert.equal(JSON.stringify(record).includes('attempt-1'), true);
  assert.equal(JSON.stringify(record).includes('"x"'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMouseAttempt } from '../src/mouse-telemetry.mjs';

test('aggregates distance and speed for valid movement', () => {
  const output = aggregateMouseAttempt([
    { x: 0, y: 0, t: 0 },
    { x: 3, y: 4, t: 100 },
    { x: 6, y: 8, t: 200 },
  ]);

  assert.equal(output.status, 'complete');
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.features.distancePx, 10);
  assert.equal(output.features.durationMs, 200);
  assert.equal(output.features.meanSpeedPxPerMs, 0.05);
  assert.equal(output.features.maxSpeedPxPerMs, 0.05);
  assert.equal(output.features.directionChanges, 0);
  assert.equal(output.features.trajectoryEntropyBits, 0);
});

test('calculates speed variation across segment speeds', () => {
  const output = aggregateMouseAttempt([
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 0, t: 100 },
    { x: 50, y: 0, t: 300 },
  ]);

  assert.equal(output.features.speedVariation, 1 / 3);
});

test('aggregates pauses, direction changes, speed variation, and acceleration', () => {
  const output = aggregateMouseAttempt([
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 0, t: 100 },
    { x: 10, y: 0, t: 300 },
    { x: 0, y: 0, t: 400 },
    { x: 0, y: 10, t: 600 },
  ]);

  assert.equal(output.status, 'complete');
  assert.equal(output.features.pauseCount, 1);
  assert.equal(output.features.pauseDurationMs, 200);
  assert.equal(output.features.directionChanges, 2);
  assert.ok(output.features.speedVariation > 0);
  assert.ok(output.features.meanAbsoluteAccelerationPxPerMs2 > 0);
  assert.ok(output.features.trajectoryEntropyBits > 0);
});

test('marks missing and insufficient attempts incomplete', () => {
  assert.equal(aggregateMouseAttempt([]).status, 'incomplete');
  assert.deepEqual(aggregateMouseAttempt([]).issues, ['insufficient_points']);
  assert.equal(aggregateMouseAttempt([{ x: 0, y: 0, t: 1 }]).status, 'incomplete');
});

test('marks malformed, non-finite, duplicate, and non-monotonic events invalid', () => {
  assert.equal(aggregateMouseAttempt(null).status, 'invalid');
  assert.equal(aggregateMouseAttempt([{ x: 0, y: 0, t: 0 }, null]).status, 'invalid');
  assert.equal(aggregateMouseAttempt([
    { x: 0, y: 0, t: 0 }, { x: Infinity, y: 1, t: 1 },
  ]).issues[0], 'non_finite_point_value');
  assert.equal(aggregateMouseAttempt([
    { x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 0 },
  ]).issues[0], 'non_monotonic_timestamp');
  assert.equal(aggregateMouseAttempt([
    { x: 0, y: 0, t: 2 }, { x: 1, y: 1, t: 1 },
  ]).issues[0], 'non_monotonic_timestamp');
  assert.equal(aggregateMouseAttempt([
    { x: -1e308, y: 0, t: 0 }, { x: 1e308, y: 0, t: 1 },
  ]).issues[0], 'non_finite_derived_value');
});

test('reports undefined zero-denominator features as null and omits raw points', () => {
  const input = [{ x: 4, y: 4, t: 0 }, { x: 4, y: 4, t: 200 }];
  const output = aggregateMouseAttempt(input);

  assert.equal(output.features.meanSpeedPxPerMs, 0);
  assert.equal(output.features.speedVariation, null);
  assert.equal(output.features.meanAccelerationPxPerMs2, null);
  assert.equal(output.features.meanAbsoluteAccelerationPxPerMs2, null);
  assert.equal(output.features.trajectoryEntropyBits, 0);
  assert.equal('points' in output, false);
  assert.equal(JSON.stringify(output).includes('"x"'), false);
});

test('rejects invalid pause thresholds', () => {
  const output = aggregateMouseAttempt([], { pauseThresholdMs: -1 });
  assert.equal(output.status, 'invalid');
  assert.deepEqual(output.issues, ['invalid_pause_threshold']);
});

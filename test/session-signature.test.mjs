import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSessionSignature, compareSessionSignatures, SESSION_SIGNATURE_SCHEMA_VERSION } from '../src/session-signature.mjs';

test('flattens allowlisted minimized values and explicitly marks unavailable groups', () => {
  const signature = buildSessionSignature({ perception: { duration_ms: 100, correct: false }, behavior: { features: { pauseCount: 0 } } });
  assert.deepEqual(signature.features, { 'perception.duration_ms': 100, 'perception.correct': 0, 'behavior.pauseCount': 0 });
  assert.ok(signature.unavailable.journey.includes('journey.sessionCount'));
  assert.ok(signature.unavailable.history.includes('history.sessionCount'));
  assert.equal(Object.hasOwn(signature.features, 'history.sessionCount'), false);
});

test('compares only jointly available values and reports coverage', () => {
  const left = buildSessionSignature({ perception: { duration_ms: 100 }, timing: { reactionTimeMs: 50 } });
  const right = buildSessionSignature({ perception: { duration_ms: 200 } });
  const result = compareSessionSignatures(left, right);
  assert.equal(result.distance, 0.5);
  assert.equal(result.commonFeatureCount, 1);
  assert.equal(result.unionFeatureCount, 2);
  assert.equal(result.coverage, 0.5);
});

test('returns unavailable distance when there are no common features', () => {
  const result = compareSessionSignatures(buildSessionSignature({}), buildSessionSignature({}));
  assert.equal(result.distance, null);
  assert.equal(result.coverage, 0);
});

test('fixture report inputs stay synthetic, deterministic, and do not require history', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/session-signatures-v0.json', import.meta.url), 'utf8'));
  assert.equal(fixture.schemaVersion, SESSION_SIGNATURE_SCHEMA_VERSION);
  const first = fixture.sessions.map((session) => buildSessionSignature(session));
  assert.deepEqual(first, fixture.sessions.map((session) => buildSessionSignature(session)));
  assert.ok(first.every((signature) => signature.unavailable.history.length === 3));
  assert.ok(fixture.sessions.every((session) => !Object.hasOwn(session, 'pseudonym')));
});

test('rejects non-session input', () => {
  assert.throws(() => buildSessionSignature(null), /session_must_be_an_object/);
});

test('marks invalid, negative, and fractional values unavailable', () => {
  const signature = buildSessionSignature({
    perception: { duration_ms: -1, correct: 1 },
    timing: { reactionTimeMs: Infinity },
    behavior: { features: { pauseCount: 1.5, distancePx: -2, meanSpeedPxPerMs: 0.2 } },
  });
  assert.deepEqual(signature.features, { 'behavior.meanSpeedPxPerMs': 0.2 });
  assert.ok(signature.unavailable.perception.includes('perception.duration_ms'));
  assert.ok(signature.unavailable.perception.includes('perception.correct'));
  assert.ok(signature.unavailable.timing.includes('timing.reactionTimeMs'));
  assert.ok(signature.unavailable.behavior.includes('behavior.pauseCount'));
  assert.ok(signature.unavailable.behavior.includes('behavior.distancePx'));
});

test('rejects malformed comparison keys and feature values', () => {
  const valid = buildSessionSignature({ perception: { duration_ms: 100, correct: true } });
  assert.throws(() => compareSessionSignatures(valid, {
    schemaVersion: 0,
    features: { ...valid.features, 'perception.unknown': 1 },
  }), /unsupported_signature_feature/);
  assert.throws(() => compareSessionSignatures(valid, {
    schemaVersion: 0,
    features: { 'perception.duration_ms': -1 },
  }), /invalid_signature_feature/);
});

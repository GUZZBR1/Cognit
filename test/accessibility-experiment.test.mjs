import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReport, recordSession } from '../src/accessibility-experiment.mjs';

const fixturePath = new URL('../fixtures/accessibility-experiment-v1/equivalent-challenges.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

test('visual and accessible session and attempt records remain distinct', () => {
  const report = buildReport(fixture);
  assert.equal(report.evidence_class, 'SIMULATED');
  assert.equal(report.modalities.VISUAL.denominators.sessions, 1);
  assert.equal(report.modalities.VISUAL.denominators.attempts, 2);
  assert.equal(report.modalities.ACCESSIBLE.denominators.sessions, 2);
  assert.equal(report.modalities.ACCESSIBLE.denominators.attempts, 2);
  assert.equal(report.modalities.ACCESSIBLE.time_ms.mean, null);
  assert.equal(report.modalities.ACCESSIBLE.time_ms.denominator, 0);
  assert.deepEqual(Object.keys(report.modalities.VISUAL.challenge_results), ['sequence-count-01']);
  assert.equal(report.modalities.VISUAL.challenge_results['sequence-count-01'].counts.CORRECT, 1);
  assert.equal(report.modalities.ACCESSIBLE.challenge_results['sequence-count-01'].counts.CORRECT, 1);
});

test('completion, retries, abandonment, time, and missing data retain denominators', () => {
  const report = buildReport(fixture);
  const visual = report.modalities.VISUAL;
  const accessible = report.modalities.ACCESSIBLE;
  const unknown = report.modalities.UNKNOWN;

  assert.deepEqual(visual.completion, { completed: 1, abandoned: 0, rate: 1 });
  assert.deepEqual(visual.retries, { count: 1, denominator: 2 });
  assert.deepEqual(visual.abandonment, { count: 0, denominator: 2, rate: 0 });
  assert.equal(visual.time_ms.mean, 535);
  assert.equal(visual.time_ms.denominator, 2);

  assert.deepEqual(accessible.completion, { completed: 1, abandoned: 1, rate: 0.5 });
  assert.deepEqual(accessible.abandonment, { count: 1, denominator: 2, rate: 0.5 });
  assert.equal(accessible.missing.duration_ms, 2);
  assert.equal(accessible.challenge_results['sequence-count-01'].missing, 1);

  assert.equal(unknown.denominators.sessions, 1);
  assert.equal(unknown.missing.completion_status, 1);
  assert.equal(unknown.missing.attempt_status, 1);
  assert.equal(unknown.missing.challenge_result, 1);
});

test('empty modalities are reported UNAVAILABLE with null rates', () => {
  const report = buildReport({ evidence_class: 'SIMULATED', sessions: [fixture.sessions[0]] });
  const accessible = report.modalities.ACCESSIBLE;
  assert.equal(accessible.status, 'UNAVAILABLE');
  assert.equal(accessible.denominators.sessions, 0);
  assert.equal(accessible.completion.rate, null);
  assert.equal(accessible.abandonment.rate, null);
});

test('absent modality or result is UNKNOWN and is never inferred from its session', () => {
  const session = recordSession({
    session_id: 'missing-mode',
    challenge_id: 'same-challenge',
    attempts: [{
      attempt_id: 'missing-attempt-mode',
      challenge_id: 'same-challenge',
      attempt_number: 1,
      status: 'SUBMITTED',
    }],
  });
  assert.equal(session.attempts[0].accessibility_mode, 'UNKNOWN');
  assert.equal(session.attempts[0].challenge_result, 'UNKNOWN');
  const report = buildReport({ evidence_class: 'SIMULATED', sessions: [session] });
  assert.equal(report.modalities.ACCESSIBLE.denominators.attempts, 0);
  assert.equal(report.modalities.UNKNOWN.denominators.attempts, 1);
});

test('report requires explicit SIMULATED provenance and rejects other evidence classes', () => {
  assert.throws(() => buildReport({ sessions: fixture.sessions }), /evidence_class must be SIMULATED/);
  assert.throws(() => buildReport({ evidence_class: 'MEASURED_LAB', sessions: fixture.sessions }), /evidence_class must be SIMULATED/);
});

test('adapter rejects risk, policy, diagnostics, and free-text fields', () => {
  assert.throws(() => recordSession({
    session_id: 'no-risk-coupling', challenge_id: 'c1', accessibility_mode: 'ACCESSIBLE',
    risk_score: 99,
  }), /unsupported field: risk_score/);
  assert.throws(() => recordSession({
    session_id: 'no-reason-collection', challenge_id: 'c1', accessibility_mode: 'ACCESSIBLE',
    accessibility_reason: 'unneeded diagnostic',
  }), /unsupported field: accessibility_reason/);
  assert.throws(() => recordSession({
    session_id: 'no-policy-coupling', challenge_id: 'c1', accessibility_mode: 'ACCESSIBLE',
    policy: 'BLOCK',
  }), /unsupported field: policy/);
  assert.throws(() => recordSession({
    session_id: 'unsupported-mode', challenge_id: 'c1', accessibility_mode: 'TEXT',
  }), /unsupported value: TEXT/);
  assert.throws(() => recordSession({
    session_id: 'mismatched-challenge', challenge_id: 'c1', attempts: [{
      attempt_id: 'a1', challenge_id: 'c2', accessibility_mode: 'VISUAL',
    }],
  }), /different challenge_id/);
});

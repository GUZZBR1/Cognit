import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_SCENARIOS, describeComparison, generateScenario } from '../../examples/scripted-automation/engine.mjs';
import { runCli } from '../../examples/scripted-automation/run.mjs';

const fixture = JSON.parse(await readFile(new URL('../../fixtures/challenge-v1.json', import.meta.url), 'utf8'));

function options(overrides = {}) {
  return { fixture, fixtureName: 'fixtures/challenge-v1.json', scenarioId: 'steady', seed: 'repeat-1', trials: 4, ...overrides };
}

test('same seed and configuration replay byte-for-byte', () => {
  const first = generateScenario(options());
  const replay = generateScenario(options());
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
});

test('different seeds can change sampled behavior parameters', () => {
  const first = generateScenario(options({ trials: 1 }))[0].scenario.parameters;
  const second = generateScenario(options({ seed: 'repeat-2', trials: 1 }))[0].scenario.parameters;
  assert.notDeepEqual(second, first);
});

test('decimal speed samples stay inside the configured range', () => {
  const records = generateScenario(options({ trials: 40 }));
  for (const record of records) {
    const speed = record.scenario.parameters.target_cursor_speed_px_per_ms;
    assert.ok(speed >= 0.65 && speed <= 1.1, `sampled speed ${speed} fell outside [0.65, 1.1]`);
  }
  assert.ok(new Set(records.map((record) => record.scenario.parameters.target_cursor_speed_px_per_ms)).size > 2);
});

test('records capture delays, cursor speed, pauses, retries and profile without raw points', () => {
  const profile = {
    stimulus_delay_ms: [50, 50], cursor_speed_px_per_ms: [1, 1], segments: [4, 4],
    pause_count: [2, 2], pause_duration_ms: [120, 120], retry_limit: [2, 2],
    response_after_movement_ms: [40, 40], correctness_probability: 0,
  };
  const records = generateScenario(options({ profile, trials: 1 }));
  assert.equal(records.length, 3);
  for (const [index, record] of records.entries()) {
    assert.equal(record.retry_count, index);
    assert.equal(record.is_retry, index > 0);
    assert.equal(record.scenario.parameters.stimulus_delay_ms, 50);
    assert.ok(record.scenario.parameters.movement_duration_ms > 0);
    assert.equal(record.scenario.parameters.target_cursor_speed_px_per_ms, 1);
    assert.equal(record.scenario.parameters.pause_count, 2);
    assert.equal(record.scenario.parameters.pause_duration_ms, 240);
    assert.ok(record.scenario.parameters.cursor_speed_px_per_ms > 0);
    assert.deepEqual(record.scenario.profile, profile);
    assert.equal(JSON.stringify(record).includes('"points"'), false);
    assert.equal(JSON.stringify(record).includes('"x"'), false);
  }
});

test('zero cursor speed is rejected and wrong simulated answers stay incorrect', () => {
  const invalidProfile = { ...DEFAULT_SCENARIOS.steady, cursor_speed_px_per_ms: [0, 0.5] };
  assert.throws(() => generateScenario(options({ profile: invalidProfile })), /cursor_speed_px_per_ms/);
  const collisionFixture = { expected_answer: '__simulated_incorrect_response__' };
  const profile = { ...DEFAULT_SCENARIOS.steady, retry_limit: [0, 0], correctness_probability: 0 };
  const [record] = generateScenario(options({ fixture: collisionFixture, profile, trials: 1 }));
  assert.equal(record.result, 'INCORRECT');
});

test('zero-duration pauses and excessive custom work are rejected before generation', () => {
  const zeroPause = { ...DEFAULT_SCENARIOS.steady, pause_count: [1, 1], pause_duration_ms: [0, 0] };
  assert.throws(() => generateScenario(options({ profile: zeroPause })), /pause_duration_ms/);
  const hugeSegments = { ...DEFAULT_SCENARIOS.steady, segments: [1000000000, 1000000000] };
  assert.throws(() => generateScenario(options({ profile: hugeSegments })), /segments cannot exceed/);
  const hugeRetries = { ...DEFAULT_SCENARIOS.steady, retry_limit: [1000000000, 1000000000] };
  assert.throws(() => generateScenario(options({ profile: hugeRetries })), /retry_limit cannot exceed/);
  const excessRecords = { ...DEFAULT_SCENARIOS.steady, retry_limit: [20, 20] };
  assert.throws(() => generateScenario(options({ profile: excessRecords, trials: 1000 })), /attempt records/);
});

test('all records declare scripted simulated provenance and never a human label', () => {
  for (const scenarioId of Object.keys(DEFAULT_SCENARIOS)) {
    const records = generateScenario(options({ scenarioId }));
    for (const record of records) {
      assert.equal(record.actor_label, 'SCRIPTED_AUTOMATION');
      assert.notEqual(record.actor_label, 'HUMAN_CONFIRMED');
      assert.equal(record.evidence_class, 'SIMULATED');
      assert.equal(record.provenance.evidence, 'SIMULATED');
      assert.equal(record.oracle_access, true);
      assert.equal(record.provenance.oracle, 'local_fixture_expected_answer');
      assert.equal(record.provenance.scenario_id, record.scenario.id);
      assert.equal(record.provenance.seed, record.scenario.seed);
      assert.deepEqual(record.provenance.parameters, record.scenario.parameters);
    }
  }
});

test('missing local oracle attribution stays UNKNOWN and comparisons do not infer across fixtures', async () => {
  const unknownFixture = JSON.parse(await readFile(new URL('../../fixtures/scripted-automation/unknown-result.json', import.meta.url), 'utf8'));
  const unknown = generateScenario(options({ fixture: unknownFixture, fixtureName: 'unknown.json', trials: 1 }));
  assert.equal(unknown[0].result, 'UNKNOWN');
  assert.equal(unknown[0].oracle_access, false);
  assert.equal(describeComparison(unknown, generateScenario(options({ trials: 1 }))).comparison, 'UNKNOWN');
});

test('scenario CLI output replays and comparison is descriptive only', async () => {
  const args = ['--scenario', 'steady', '--seed', 'cli-1', '--trials', '2', '--compare', 'bursty'];
  const first = await runCli(args);
  const replay = await runCli(args);
  assert.equal(replay.text, first.text);
  const output = JSON.parse(first.text);
  assert.equal(output.comparison.comparison, 'DESCRIPTIVE_ONLY');
  assert.equal(output.comparison.descriptive_only, true);
  assert.equal(output.evidence_class, 'SIMULATED');
  assert.equal(output.comparison.scenarios[0].trial_count, 2);
  assert.equal(output.comparison.scenarios[0].attempt_count, output.records.filter((record) => record.scenario.id === 'steady').length);
  assert.ok('final_correct' in output.comparison.scenarios[0]);
});

test('custom config accepts numeric seed zero', async (t) => {
  const directory = await mkdtemp(join(process.cwd(), '.tmp-scripted-automation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'scenario.json'), JSON.stringify({ scenario_id: 'zero-seed', seed: 0, trials: 1, fixture: resolve('fixtures/challenge-v1.json'), profile: DEFAULT_SCENARIOS.steady }));
  const args = ['--config', 'scenario.json', '--output', 'records.json'];
  const result = await runCli(args, directory);
  const replay = await runCli(args, directory);
  assert.equal(replay.text, result.text);
  assert.equal(await readFile(join(directory, 'records.json'), 'utf8'), result.text);
  assert.equal(JSON.parse(result.text).records[0].scenario.seed, '0');
  const overridden = await runCli(['--config', 'scenario.json', '--scenario', 'bursty'], directory);
  const overriddenRecord = JSON.parse(overridden.text).records[0];
  assert.equal(overriddenRecord.scenario.id, 'bursty');
  assert.deepEqual(overriddenRecord.scenario.profile, DEFAULT_SCENARIOS.bursty);
});

test('scenario runner stays outside production policy, token, and blocking code', async () => {
  const source = await readFile(new URL('../../examples/scripted-automation/engine.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /decision_policy|risk_score|verificationtoken|session-engine|blockUser/i);
});

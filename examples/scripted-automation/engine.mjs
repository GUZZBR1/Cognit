import { createHash } from 'node:crypto';
import { aggregateMouseAttempt } from '../../src/mouse-telemetry.mjs';
import { ReactionTimeCollector } from '../../src/reaction-time-collector.mjs';

export const DEFAULT_SCENARIOS = Object.freeze({
  steady: Object.freeze({
    stimulus_delay_ms: [180, 320],
    cursor_speed_px_per_ms: [0.65, 1.1],
    segments: [8, 12],
    pause_count: [0, 1],
    pause_duration_ms: [100, 180],
    retry_limit: [0, 1],
    response_after_movement_ms: [80, 180],
    correctness_probability: 0.82,
  }),
  bursty: Object.freeze({
    stimulus_delay_ms: [40, 140],
    cursor_speed_px_per_ms: [1.4, 2.8],
    segments: [3, 6],
    pause_count: [1, 3],
    pause_duration_ms: [120, 300],
    retry_limit: [1, 3],
    response_after_movement_ms: [20, 100],
    correctness_probability: 0.58,
  }),
});

const RANGE_FIELDS = [
  'stimulus_delay_ms',
  'cursor_speed_px_per_ms',
  'segments',
  'pause_count',
  'pause_duration_ms',
  'retry_limit',
  'response_after_movement_ms',
];
const MAX_PROFILE_VALUE = 1000;
const MAX_ATTEMPT_RECORDS = 10000;
const MAX_GENERATED_POINTS = 1000000;

function validateProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('scenario profile must be an object');
  }
  for (const field of RANGE_FIELDS) {
    const range = profile[field];
    const minimum = field === 'segments' ? 1 : 0;
    const invalidLowerBound = field === 'cursor_speed_px_per_ms'
      ? range?.[0] <= 0
      : field === 'pause_duration_ms' && profile.pause_count?.[1] > 0
        ? range?.[0] <= 0
        : range?.[0] < minimum;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || invalidLowerBound || range[1] < range[0]) {
      throw new TypeError(`${field} must be an ascending pair of non-negative numbers`);
    }
    if (['segments', 'pause_count', 'retry_limit'].includes(field) && !range.every(Number.isInteger)) {
      throw new TypeError(`${field} must contain integers`);
    }
    if (['segments', 'pause_count', 'retry_limit'].includes(field) && range[1] > MAX_PROFILE_VALUE) {
      throw new RangeError(`${field} cannot exceed ${MAX_PROFILE_VALUE}`);
    }
  }
  if (!Number.isFinite(profile.correctness_probability) || profile.correctness_probability < 0 || profile.correctness_probability > 1) {
    throw new TypeError('correctness_probability must be between 0 and 1');
  }
}

function hashSeed(seed, scenarioId) {
  return createHash('sha256').update(`${String(seed)}\0${scenarioId}`).digest().readUInt32LE(0);
}

function createRandom(seed, scenarioId) {
  let state = hashSeed(seed, scenarioId);
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function pick(random, range) {
  if (Number.isInteger(range[0]) && Number.isInteger(range[1])) {
    return range[0] + Math.floor(random() * (range[1] - range[0] + 1));
  }
  return range[0] + random() * (range[1] - range[0]);
}

function fixtureId(fixture, fixtureName) {
  return createHash('sha256').update(JSON.stringify(fixture)).digest('hex').slice(0, 16) || fixtureName;
}

function createCursorPoints(parameters, random) {
  const points = [{ x: 0, y: 0, t: parameters.stimulus_delay_ms }];
  const pauseBefore = new Set();
  while (pauseBefore.size < parameters.pause_count && pauseBefore.size < parameters.segments - 1) {
    pauseBefore.add(Math.floor(random() * (parameters.segments - 1)) + 1);
  }
  let elapsed = parameters.stimulus_delay_ms;
  for (let segment = 1; segment <= parameters.segments; segment += 1) {
    if (pauseBefore.has(segment)) {
      const pause = pick(random, parameters.pause_duration_ms_range);
      elapsed += pause;
      points.push({ x: points.at(-1).x, y: points.at(-1).y, t: elapsed });
      parameters.actual_pause_duration_ms += pause;
      parameters.actual_pause_count += 1;
    }
    const progress = segment / parameters.segments;
    const jitterX = (random() - 0.5) * 18;
    const jitterY = (random() - 0.5) * 18;
    const x = 360 * progress + jitterX;
    const y = 220 * progress + jitterY;
    const duration = Math.hypot(x - points.at(-1).x, y - points.at(-1).y) / parameters.target_speed_px_per_ms;
    elapsed += duration;
    parameters.actual_movement_duration_ms += duration;
    points.push({ x, y, t: elapsed });
  }
  return points;
}

function buildAttempt({ fixture, fixtureName, scenarioId, seed, trial, trials, attempt, retryLimit, profile, random, knownFixture }) {
  const parameters = {
    stimulus_delay_ms: pick(random, profile.stimulus_delay_ms),
    target_speed_px_per_ms: pick(random, profile.cursor_speed_px_per_ms),
    segments: pick(random, profile.segments),
    pause_count: pick(random, profile.pause_count),
    pause_duration_ms_range: profile.pause_duration_ms,
    actual_pause_count: 0,
    actual_pause_duration_ms: 0,
    actual_movement_duration_ms: 0,
    retry_count: attempt,
  };
  parameters.pause_count = Math.min(parameters.pause_count, Math.max(0, parameters.segments - 1));
  const points = createCursorPoints(parameters, random);
  const responseAt = points.at(-1).t + pick(random, profile.response_after_movement_ms);
  const timings = new ReactionTimeCollector(0)
    .recordMovement(parameters.stimulus_delay_ms)
    .recordInteraction(parameters.stimulus_delay_ms)
    .recordClick(responseAt)
    .recordResponse(responseAt)
    .finish(responseAt);
  const mouse = aggregateMouseAttempt(points);
  const matchesFixtureOracle = knownFixture && random() < profile.correctness_probability;
  const result = knownFixture
    ? (matchesFixtureOracle ? 'CORRECT' : 'INCORRECT')
    : 'UNKNOWN';
  const scenarioParameters = {
    stimulus_delay_ms: parameters.stimulus_delay_ms,
    movement_duration_ms: parameters.actual_movement_duration_ms,
    segment_count: parameters.segments,
    pause_count: parameters.actual_pause_count,
    pause_duration_ms: parameters.actual_pause_duration_ms,
    target_cursor_speed_px_per_ms: parameters.target_speed_px_per_ms,
    cursor_speed_px_per_ms: mouse.features?.meanSpeedPxPerMs ?? null,
    retry_limit: retryLimit,
  };
  return {
    trial_id: `${scenarioId}-${seed}-${trial}`,
    attempt_index: attempt + 1,
    is_retry: attempt > 0,
    retry_count: attempt,
    actor_label: 'SCRIPTED_AUTOMATION',
    evidence_class: 'SIMULATED',
    oracle_access: knownFixture,
    result,
    fixture: { name: fixtureName, id: fixtureId(fixture, fixtureName) },
    scenario: { id: scenarioId, seed: String(seed), trial_count: trials, profile: structuredClone(profile), parameters: scenarioParameters },
    timing: { response_delay_ms: timings.totalTime },
    cursor_features: mouse.features,
    provenance: {
      type: 'local_scripted_scenario',
      fixture: fixtureName,
      fixture_id: fixtureId(fixture, fixtureName),
      scenario_id: scenarioId,
      seed: String(seed),
      trial_count: trials,
      parameters: structuredClone(scenarioParameters),
      oracle: knownFixture ? 'local_fixture_expected_answer' : 'unavailable',
      evidence: 'SIMULATED',
    },
  };
}

export function generateScenario({ fixture, fixtureName = 'challenge.json', scenarioId = 'steady', seed, trials = 1, profile = DEFAULT_SCENARIOS[scenarioId] }) {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) throw new TypeError('fixture must be an object');
  if (typeof seed !== 'string' && !Number.isSafeInteger(seed)) throw new TypeError('seed must be a string or safe integer');
  if (String(seed).length === 0) throw new TypeError('seed must not be empty');
  if (!Number.isInteger(trials) || trials < 1 || trials > 1000) throw new RangeError('trials must be an integer from 1 to 1000');
  validateProfile(profile);
  const maxRecords = trials * (profile.retry_limit[1] + 1);
  const maxPointsPerAttempt = 1 + profile.segments[1] + Math.min(profile.pause_count[1], profile.segments[1] - 1);
  if (maxRecords > MAX_ATTEMPT_RECORDS) throw new RangeError(`scenario could generate more than ${MAX_ATTEMPT_RECORDS} attempt records`);
  if (maxRecords * maxPointsPerAttempt > MAX_GENERATED_POINTS) throw new RangeError(`scenario could generate more than ${MAX_GENERATED_POINTS} cursor points`);
  const knownFixture = typeof fixture.expected_answer === 'string' && fixture.expected_answer.length > 0;
  const random = createRandom(seed, scenarioId);
  const records = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    const retryLimit = pick(random, profile.retry_limit);
    let attempt = 0;
    let result;
    do {
      result = buildAttempt({ fixture, fixtureName, scenarioId, seed, trial, trials, attempt, retryLimit, profile, random, knownFixture });
      records.push(result);
      attempt += 1;
    } while (knownFixture && result.result !== 'CORRECT' && attempt <= retryLimit);
  }
  return records;
}

function average(records, selector) {
  const values = records.map(selector).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function describeComparison(leftRecords, rightRecords) {
  const sameFixture = leftRecords.length > 0 && rightRecords.length > 0 && leftRecords.every((record) => record.fixture.id === leftRecords[0].fixture.id) && rightRecords.every((record) => record.fixture.id === leftRecords[0].fixture.id);
  if (!sameFixture) {
    return { evidence_class: 'SIMULATED', comparison: 'UNKNOWN', reason: 'fixture_attribution_unavailable_or_mismatched', descriptive_only: true };
  }
  const summarize = (records) => {
    const byTrial = Map.groupBy(records, (record) => record.trial_id);
    const firstAttempts = [...byTrial.values()].map((attempts) => attempts[0]);
    const finalAttempts = [...byTrial.values()].map((attempts) => attempts.at(-1));
    return {
    scenario_id: records[0].scenario.id,
    trial_count: byTrial.size,
    attempt_count: records.length,
    final_correct: finalAttempts.filter((record) => record.result === 'CORRECT').length,
    final_incorrect: finalAttempts.filter((record) => record.result === 'INCORRECT').length,
    final_unknown: finalAttempts.filter((record) => record.result === 'UNKNOWN').length,
    mean_initial_response_delay_ms: average(firstAttempts, (record) => record.timing.response_delay_ms),
    mean_initial_pause_count: average(firstAttempts, (record) => record.scenario.parameters.pause_count),
    retries: records.filter((record) => record.is_retry).length,
    };
  };
  return { evidence_class: 'SIMULATED', comparison: 'DESCRIPTIVE_ONLY', descriptive_only: true, fixture_id: leftRecords[0].fixture.id, scenarios: [summarize(leftRecords), summarize(rightRecords)] };
}

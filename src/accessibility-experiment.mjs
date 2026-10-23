/**
 * Local, simulated reporting for visual and accessible challenge conditions.
 * This module records experimental outcomes only; it has no risk or policy input.
 */

export const MODALITIES = Object.freeze(['VISUAL', 'ACCESSIBLE', 'UNKNOWN']);
const COMPLETION_STATES = new Set(['COMPLETED', 'ABANDONED', 'UNKNOWN']);
const ATTEMPT_STATES = new Set(['SUBMITTED', 'ABANDONED', 'UNKNOWN']);
const CHALLENGE_RESULTS = new Set(['CORRECT', 'INCORRECT', 'UNKNOWN']);
const SESSION_FIELDS = new Set([
  'session_id', 'challenge_id', 'accessibility_mode', 'completion_status', 'attempts',
]);
const DATASET_FIELDS = new Set(['evidence_class', 'sessions']);
const ATTEMPT_FIELDS = new Set([
  'attempt_id', 'challenge_id', 'accessibility_mode', 'attempt_number', 'status', 'challenge_result', 'duration_ms',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertAllowedFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`${label} contains unsupported field: ${field}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function knownOrUnknown(value, allowed, label) {
  if (value === undefined || value === null || value === '') return 'UNKNOWN';
  if (!allowed.has(value)) throw new TypeError(`${label} has unsupported value: ${String(value)}`);
  return value;
}

function normalizeAttempt(attempt, index) {
  assertObject(attempt, `attempt ${index + 1}`);
  assertAllowedFields(attempt, ATTEMPT_FIELDS, `attempt ${index + 1}`);
  const attemptId = nonEmptyString(attempt.attempt_id, `attempt ${index + 1}.attempt_id`);
  const challengeId = nonEmptyString(attempt.challenge_id, `attempt ${attemptId}.challenge_id`);
  const mode = knownOrUnknown(attempt.accessibility_mode, new Set(MODALITIES), `attempt ${attemptId}.accessibility_mode`);
  const number = attempt.attempt_number;
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) {
    throw new TypeError(`attempt ${attemptId}.attempt_number must be a positive integer`);
  }
  const duration = attempt.duration_ms;
  if (duration !== undefined && duration !== null &&
      (!Number.isFinite(duration) || duration < 0)) {
    throw new TypeError(`attempt ${attemptId}.duration_ms must be a non-negative finite number or null`);
  }
  return {
    attempt_id: attemptId,
    challenge_id: challengeId,
    accessibility_mode: mode,
    attempt_number: number ?? null,
    status: knownOrUnknown(attempt.status, ATTEMPT_STATES, `attempt ${attemptId}.status`),
    challenge_result: knownOrUnknown(attempt.challenge_result, CHALLENGE_RESULTS, `attempt ${attemptId}.challenge_result`),
    duration_ms: duration ?? null,
  };
}

/**
 * Normalize one minimized session and its attempts. Absent categorical evidence
 * stays UNKNOWN; unrecognized values are rejected instead of guessed.
 */
export function recordSession(input) {
  assertObject(input, 'session');
  assertAllowedFields(input, SESSION_FIELDS, 'session');
  const sessionId = nonEmptyString(input.session_id, 'session.session_id');
  const challengeId = nonEmptyString(input.challenge_id, `session ${sessionId}.challenge_id`);
  const mode = knownOrUnknown(input.accessibility_mode, new Set(MODALITIES), `session ${sessionId}.accessibility_mode`);
  const completion = knownOrUnknown(input.completion_status, COMPLETION_STATES, `session ${sessionId}.completion_status`);
  if (input.attempts !== undefined && !Array.isArray(input.attempts)) {
    throw new TypeError(`session ${sessionId}.attempts must be an array`);
  }
  const attempts = (input.attempts ?? []).map((attempt, index) => normalizeAttempt(attempt, index));
  if (attempts.some(({ challenge_id }) => challenge_id !== challengeId)) {
    throw new TypeError(`session ${sessionId} contains an attempt for a different challenge_id`);
  }
  if (new Set(attempts.map(({ attempt_id }) => attempt_id)).size !== attempts.length) {
    throw new TypeError(`session ${sessionId} contains duplicate attempt_id values`);
  }
  return Object.freeze({
    session_id: sessionId,
    challenge_id: challengeId,
    accessibility_mode: mode,
    completion_status: completion,
    attempts: Object.freeze(attempts.map(Object.freeze)),
  });
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function summarize(sessions, attempts) {
  const knownCompletion = sessions.filter(({ completion_status }) => completion_status !== 'UNKNOWN');
  const completed = sessions.filter(({ completion_status }) => completion_status === 'COMPLETED').length;
  const knownAttemptStatus = attempts.filter(({ status }) => status !== 'UNKNOWN');
  const abandonedAttempts = attempts.filter(({ status }) => status === 'ABANDONED').length;
  const numberedAttempts = attempts.filter(({ attempt_number }) => attempt_number !== null);
  const retries = numberedAttempts.filter(({ attempt_number }) => attempt_number > 1).length;
  const knownResults = attempts.filter(({ challenge_result }) => challenge_result !== 'UNKNOWN');
  const timedAttempts = attempts.filter(({ duration_ms }) => duration_ms !== null);
  const challengeResults = Object.fromEntries(
    [...new Set(attempts.map(({ challenge_id }) => challenge_id))].sort().map((challengeId) => {
      const rows = attempts.filter((attempt) => attempt.challenge_id === challengeId);
      const counts = Object.fromEntries([...CHALLENGE_RESULTS].map((result) => [result, 0]));
      for (const { challenge_result } of rows) counts[challenge_result]++;
      return [challengeId, {
        denominator: rows.length,
        observed_denominator: rows.filter(({ challenge_result }) => challenge_result !== 'UNKNOWN').length,
        missing: rows.filter(({ challenge_result }) => challenge_result === 'UNKNOWN').length,
        counts,
      }];
    }),
  );

  return {
    status: sessions.length || attempts.length ? 'AVAILABLE' : 'UNAVAILABLE',
    denominators: {
      sessions: sessions.length,
      completion_observed: knownCompletion.length,
      attempts: attempts.length,
      attempt_status_observed: knownAttemptStatus.length,
      retry_classification_observed: numberedAttempts.length,
      challenge_result_observed: knownResults.length,
      duration_observed: timedAttempts.length,
    },
    missing: {
      completion_status: sessions.length - knownCompletion.length,
      attempt_status: attempts.length - knownAttemptStatus.length,
      attempt_number: attempts.length - numberedAttempts.length,
      challenge_result: attempts.length - knownResults.length,
      duration_ms: attempts.length - timedAttempts.length,
    },
    completion: {
      completed: completed,
      abandoned: knownCompletion.length - completed,
      rate: rate(completed, knownCompletion.length),
    },
    retries: { count: retries, denominator: numberedAttempts.length },
    abandonment: {
      count: abandonedAttempts,
      denominator: knownAttemptStatus.length,
      rate: rate(abandonedAttempts, knownAttemptStatus.length),
    },
    time_ms: {
      mean: timedAttempts.length
        ? timedAttempts.reduce((sum, { duration_ms }) => sum + duration_ms, 0) / timedAttempts.length
        : null,
      denominator: timedAttempts.length,
    },
    challenge_results: challengeResults,
  };
}

/** Build a deterministic report from an explicitly simulated local dataset. */
export function buildReport(dataset) {
  assertObject(dataset, 'dataset');
  assertAllowedFields(dataset, DATASET_FIELDS, 'dataset');
  if (dataset.evidence_class !== 'SIMULATED') {
    throw new TypeError('dataset.evidence_class must be SIMULATED');
  }
  if (!Array.isArray(dataset.sessions)) throw new TypeError('dataset.sessions must be an array');
  const sessions = dataset.sessions.map(recordSession);
  if (new Set(sessions.map(({ session_id }) => session_id)).size !== sessions.length) {
    throw new TypeError('sessions contains duplicate session_id values');
  }
  return {
    report_version: 'accessibility-experiment-v1',
    evidence_class: dataset.evidence_class,
    modalities: Object.fromEntries(MODALITIES.map((modality) => [
      modality,
      summarize(
        sessions.filter(({ accessibility_mode }) => accessibility_mode === modality),
        sessions.flatMap(({ attempts }) => attempts).filter(({ accessibility_mode }) => accessibility_mode === modality),
      ),
    ])),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { createStudyParticipantKey, DEFAULT_RETENTION_MS, HumanConfirmationRegistry } from "../src/human-confirmation-registry.js";
import fixtureCases from "../fixtures/human-confirmation-v1.json" with { type: "json" };

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const START = "2027-01-15T12:00:00.000Z";
const END = "2027-01-15T12:00:10.000Z";
const RESULT = { challenge_id: "color-count-01", stimulus_id: "grid-blue-01", duration_ms: 100, response: "3", correct: true, reaction_time_ms: 700 };
const CONFIRMATION = {
  outcome: "confirmed",
  method: "direct-researcher-observation",
  origin: "researcher-facilitated-controlled-session",
  procedure: "human-control-observation-v1",
  protocolVersion: "human-observation-v1",
  observerId: "observer-random-01",
  scope: { sessionId: "session-01", attemptId: "attempt-01", observedFrom: START, observedTo: END, complete: true },
  confirmedAt: "2027-01-15T12:00:11.000Z",
};

function createDataset(options = {}) {
  let now = Date.parse("2027-01-15T12:01:00.000Z");
  let nextTimer = 0;
  const timers = new Map();
  const cleared = [];
  const dataset = new HumanConfirmationRegistry({
    studyId: "study-01",
    pseudonymKey: KEY,
    now: () => now,
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: (id) => { cleared.push(id); timers.delete(id); },
    ...options,
  });
  return {
    dataset,
    timers,
    cleared,
    advance: (ms) => { now += ms; },
  };
}

const PARTICIPANT = "A".repeat(32);

function consent(dataset, participantKey = PARTICIPANT) {
  return dataset.consent({ participantKey, informed: true, consentVersion: "consent-v1" });
}

function record(dataset, participantKey = PARTICIPANT, attemptId = "attempt-01", sessionId = "session-01", result = RESULT) {
  return dataset.recordAttempt({ participantKey, sessionId, attemptId, startedAt: START, endedAt: END, result });
}

test("consent and a correct answer alone leave the attempt UNKNOWN", () => {
  const { dataset } = createDataset();
  assert.equal(dataset.rawEnabled, false);
  assert.throws(() => record(dataset), /consent/i);
  consent(dataset);
  const saved = record(dataset);
  assert.equal(saved.result.correct, true);
  assert.equal(saved.label, "UNKNOWN");
  assert.equal(saved.confirmation, null);
  assert.equal(dataset.verifyProvenance(saved), true);
});

test("only full independent observation of the exact attempt produces an auditable label", () => {
  const { dataset } = createDataset();
  consent(dataset);
  record(dataset);
  const confirmed = dataset.confirmAttempt({ participantKey: PARTICIPANT, sessionId: "session-01", attemptId: "attempt-01", ...CONFIRMATION });
  assert.equal(confirmed.label, "HUMAN_CONFIRMED");
  assert.equal(confirmed.evidence_status, "INDEPENDENTLY_OBSERVED");
  assert.deepEqual(Object.keys(confirmed.confirmation).sort(), ["confirmed_at", "method", "observer_id", "origin", "procedure", "protocol_version", "scope"].sort());
  assert.equal(confirmed.confirmation.scope.complete, true);
  assert.equal(dataset.verifyProvenance(confirmed), true);
  assert.equal(dataset.verifyProvenance({ ...confirmed, label: "UNKNOWN" }), false);
});

test("an independently observed attempt can be confirmed regardless of answer correctness", () => {
  const { dataset } = createDataset();
  consent(dataset);
  record(dataset, PARTICIPANT, "attempt-wrong-answer", "session-wrong-answer", { ...RESULT, response: "2", correct: false });
  const confirmed = dataset.confirmAttempt({
    participantKey: PARTICIPANT,
    sessionId: "session-wrong-answer",
    attemptId: "attempt-wrong-answer",
    ...CONFIRMATION,
    scope: { ...CONFIRMATION.scope, sessionId: "session-wrong-answer", attemptId: "attempt-wrong-answer" },
  });
  assert.equal(confirmed.result.correct, false);
  assert.equal(confirmed.label, "HUMAN_CONFIRMED");
});

test("missing provenance, partial observation, and mismatched attempts are rejected", () => {
  const { dataset } = createDataset();
  consent(dataset);
  record(dataset);
  const base = { participantKey: PARTICIPANT, sessionId: "session-01", attemptId: "attempt-01", ...CONFIRMATION };
  assert.throws(() => dataset.confirmAttempt({ ...base, method: " " }), /method is required/i);
  assert.throws(() => dataset.confirmAttempt({ ...base, scope: { ...CONFIRMATION.scope, complete: false } }), /complete recorded attempt/i);
  assert.throws(() => dataset.confirmAttempt({ ...base, scope: { ...CONFIRMATION.scope, observedTo: "2027-01-15T12:00:09.000Z" } }), /complete recorded attempt/i);
  assert.throws(() => dataset.confirmAttempt({ ...base, attemptId: "other-attempt" }), /no recorded attempt/i);
  assert.throws(() => dataset.confirmAttempt({ ...base, method: "risk-score" }), /independent researcher observation/i);
  assert.equal(dataset.getRecords()[0].label, "UNKNOWN");
});

test("unconfirmed and inconclusive procedures remain UNKNOWN", () => {
  const { dataset } = createDataset();
  consent(dataset);
  record(dataset);
  const saved = dataset.confirmAttempt({ participantKey: PARTICIPANT, sessionId: "session-01", attemptId: "attempt-01", outcome: "unknown" });
  assert.equal(saved.label, "UNKNOWN");
  assert.equal(saved.confirmation, null);
  assert.equal(dataset.verifyProvenance(saved), true);

  const unconfirmed = dataset.recordAttempt({ participantKey: PARTICIPANT, sessionId: "session-02", attemptId: "attempt-02", startedAt: START, endedAt: END, result: RESULT });
  const rejected = dataset.confirmAttempt({ participantKey: PARTICIPANT, sessionId: "session-02", attemptId: "attempt-02", outcome: "unconfirmed" });
  assert.equal(unconfirmed.label, "UNKNOWN");
  assert.equal(rejected.label, "UNKNOWN");
});

test("participant pseudonyms are stable within a study and separated across studies", () => {
  const first = createDataset().dataset;
  const second = createDataset().dataset;
  const otherStudy = new HumanConfirmationRegistry({ studyId: "study-02", pseudonymKey: KEY });
  const participantKey = createStudyParticipantKey();
  const one = first.participantId(participantKey);
  assert.equal(second.participantId(participantKey), one);
  assert.notEqual(otherStudy.participantId(participantKey), one);
  assert.notEqual(first.participantId(createStudyParticipantKey()), one);
});

test("attempt uniqueness is scoped to participant, session, and attempt", () => {
  const { dataset } = createDataset();
  const subjectA = "A".repeat(32);
  const subjectB = "B".repeat(32);
  consent(dataset, subjectA);
  consent(dataset, subjectB);
  record(dataset, subjectA);
  record(dataset, subjectB);
  assert.equal(dataset.getRecords().length, 2);
  assert.throws(() => record(dataset, subjectA), /already recorded/i);
});

test("withdrawal deletes only that participant's records and blocks further collection", () => {
  const { dataset, cleared } = createDataset();
  const subjectA = "A".repeat(32);
  const subjectB = "B".repeat(32);
  consent(dataset, subjectA);
  consent(dataset, subjectB);
  record(dataset, subjectA, "attempt-a", "session-a");
  record(dataset, subjectB, "attempt-b", "session-b");
  dataset.withdraw(subjectA);
  assert.deepEqual(dataset.getRecords().map((entry) => entry.participant_id), [dataset.participantId(subjectB)]);
  assert.throws(() => consent(dataset, subjectA), /withdrawn/i);
  assert.throws(() => record(dataset, subjectA, "attempt-c", "session-a"), /active consent/i);
  assert.ok(cleared.length >= 1);
});

test("records expire after the documented retention period", () => {
  assert.equal(DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  const { dataset, advance } = createDataset({ retentionMs: 1000 });
  consent(dataset);
  record(dataset);
  advance(1001);
  assert.deepEqual(dataset.getRecords(), []);
});

test("raw and unapproved personal fields cannot enter collector records", () => {
  const { dataset } = createDataset();
  consent(dataset);
  assert.throws(() => record(dataset, PARTICIPANT, "attempt-01", "session-01", { ...RESULT, email: "person@example.test" }), /raw data is not collected/i);
  assert.throws(() => record(dataset, PARTICIPANT, "attempt-01", "session-01", { ...RESULT, trajectory: [{ x: 1, y: 2 }] }), /raw data is not collected/i);
  assert.throws(() => dataset.participantId("name@example.test"), /random base64url/i);
});

test("versioned fixtures distinguish confirmed, unconfirmed, and unknown simulated evidence", () => {
  assert.equal(fixtureCases.evidence, "SIMULATED");
  assert.deepEqual(fixtureCases.cases.map(({ expected_label }) => expected_label), ["HUMAN_CONFIRMED", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  assert.ok(fixtureCases.cases[0].confirmation);
  assert.equal(fixtureCases.cases[1].confirmation, null);
  assert.equal(fixtureCases.cases[2].procedure_outcome, "unconfirmed");
  assert.equal(fixtureCases.cases[3].reason, "observation_incomplete");
});

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETENTION_MS, HumanDataset } from "../src/human-dataset.js";
import { fixedChallenges, createResult } from "../src/fixed-challenges.js";

function fixture(options = {}) {
  let now = 1_800_000_000_000;
  let id = 0;
  const dataset = new HumanDataset({ now: () => now, randomUUID: () => `participant-${++id}`, ...options });
  return { dataset, advance: (ms) => { now += ms; } };
}

const result = { challenge_id: "color-count-01", stimulus_id: "grid-blue-01", duration_ms: 100, response: "3", correct: true, reaction_time_ms: 700 };
const consent = (dataset) => dataset.consent({ informed: true, consentVersion: "consent-v1" });

test("requires explicit consent and records only minimized fields with a pseudonym", () => {
  const { dataset } = fixture();
  assert.equal(dataset.rawEnabled, false);
  assert.throws(() => dataset.record(result), /consent/i);
  assert.throws(() => dataset.consent({ informed: false, consentVersion: "v1" }), /consent/i);
  const pseudonym = consent(dataset);
  const saved = dataset.record(result);
  assert.equal(saved.pseudonym, pseudonym);
  assert.equal(saved.consent_version, "consent-v1");
  assert.deepEqual(dataset.getRecords(), [saved]);
  assert.throws(() => dataset.record({ ...result, trajectory: [{ x: 1, y: 2 }] }), /raw data/i);
  assert.throws(() => dataset.record({ ...result, response: "a@b.com" }), /allowed answer/i);
  assert.throws(() => dataset.record({ ...result, stimulus_id: "wrong-stimulus" }), /IDs do not match/i);
  assert.throws(() => dataset.record({ ...result, correct: false }), /correctness does not match/i);
  assert.throws(() => dataset.record({ ...result, humanConfirmed: { method: "review", origin: "record", procedure: "v1" } }), /unsupported fields/i);
});

test("records accessible untimed results without inventing timing evidence", () => {
  const { dataset } = fixture();
  consent(dataset);
  const accessibleResult = createResult({
    challenge: fixedChallenges[0],
    duration_ms: null,
    response: "3",
    reaction_time_ms: null,
  });

  assert.equal(accessibleResult.duration_ms, null);
  assert.equal(accessibleResult.reaction_time_ms, null);
  assert.deepEqual(
    (({ duration_ms, reaction_time_ms }) => ({ duration_ms, reaction_time_ms }))(dataset.record(accessibleResult)),
    { duration_ms: null, reaction_time_ms: null },
  );
  assert.throws(() => dataset.record({ ...accessibleResult, reaction_time_ms: 1 }), /non-negative/);
  assert.throws(() => dataset.record({ ...accessibleResult, duration_ms: 100 }), /non-negative/);
});

test("withdrawal deletes records and permanently closes collection", () => {
  const { dataset } = fixture();
  consent(dataset);
  dataset.record(result);
  dataset.withdraw();
  assert.deepEqual(dataset.getRecords(), []);
  assert.throws(() => dataset.record(result), /consent/i);
  assert.throws(() => consent(dataset), /withdrawn/i);
});

test("expires records after the short configured retention period", () => {
  assert.equal(DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  const { dataset, advance } = fixture({ retentionMs: 1000 });
  consent(dataset);
  dataset.record(result);
  advance(1001);
  assert.deepEqual(dataset.getRecords(), []);
});

test("removes expired records on a timer while the page remains open", () => {
  const scheduled = [];
  const cleared = [];
  const { dataset, advance } = fixture({
    retentionMs: 1000,
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimeout: (id) => cleared.push(id),
  });
  consent(dataset);
  dataset.record(result);
  assert.equal(scheduled[0].delay, 1000);
  advance(1000);
  scheduled[0].callback();
  assert.deepEqual(dataset.getRecords(), []);
  assert.deepEqual(cleared, []);
});

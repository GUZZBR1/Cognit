import test from "node:test";
import assert from "node:assert/strict";
import { createAttemptRecorder, createResult, fixedChallenges, normalizeResponse } from "../src/fixed-challenges.js";
import { createSeededStimulus } from "../src/seeded-generator.js";

test("fixed challenges have authored identity and expected answers", () => {
  assert.equal(fixedChallenges.length, 3);
  for (const challenge of fixedChallenges) {
    assert.ok(challenge.challenge_id);
    assert.ok(challenge.stimulus_id);
    assert.ok(challenge.expected_answer);
    assert.equal(challenge.tiles.length, 9);
  }
});

test("result contains the attempt contract and normalizes simple answer differences", () => {
  const challenge = fixedChallenges[0];
  assert.deepEqual(createResult({ challenge, duration_ms: 2000, response: " 3 ", reaction_time_ms: 1534.6 }), {
    challenge_id: "color-count-01",
    stimulus_id: "grid-blue-01",
    duration_ms: 2000,
    response: "3",
    correct: true,
    reaction_time_ms: 1535
  });
  assert.equal(createResult({ challenge, duration_ms: 1000, response: "2", reaction_time_ms: 12 }).correct, false);
  assert.equal(createResult({ challenge, duration_ms: 1000, response: "3", reaction_time_ms: -1 }).reaction_time_ms, 0);
  assert.equal(normalizeResponse("  Green "), "green");
});

test("an attempt recorder accepts only its first completed submission", () => {
  const recordAttempt = createAttemptRecorder();
  const firstResult = { response: "3" };
  let resultCreations = 0;

  assert.equal(recordAttempt(() => { resultCreations += 1; return firstResult; }), firstResult);
  assert.equal(recordAttempt(() => { resultCreations += 1; return { response: "2" }; }), null);
  assert.equal(resultCreations, 1);
  assert.equal(createAttemptRecorder()(() => "next attempt"), "next attempt");
});

test("seeded generator is deterministic and independent of fixed catalog", () => {
  assert.deepEqual(createSeededStimulus(42), createSeededStimulus(42));
  assert.notDeepEqual(createSeededStimulus(42), createSeededStimulus(43));
  assert.throws(() => createSeededStimulus(42, 0), RangeError);
  assert.equal(fixedChallenges[0].tiles[0], "blue-circle");
});

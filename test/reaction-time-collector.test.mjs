import assert from "node:assert/strict";
import test from "node:test";

import { ReactionTimeCollector } from "../src/reaction-time-collector.mjs";

test("collects first event timestamps and total attempt time", () => {
  const attempt = new ReactionTimeCollector(100);
  attempt.recordMovement(125).recordMovement(130);
  attempt.recordClick(150).recordInteraction(145).recordResponse(210);

  assert.deepEqual(attempt.finish(220), {
    stimulusAt: 100,
    firstMovementAt: 125,
    firstClickAt: 150,
    firstInteractionAt: 125,
    responseAt: 210,
    totalTime: 120,
  });
});

test("keeps missing event timestamps explicit and derives total from attempt end", () => {
  const attempt = new ReactionTimeCollector(10);
  attempt.recordInteraction(15);

  assert.deepEqual(attempt.finish(42), {
    stimulusAt: 10,
    firstMovementAt: null,
    firstClickAt: null,
    firstInteractionAt: 15,
    responseAt: null,
    totalTime: 32,
  });
});

test("uses the earliest movement or click as the first interaction", () => {
  const attempt = new ReactionTimeCollector(0);
  attempt.recordClick(20).recordMovement(12);

  assert.equal(attempt.finish(30).firstInteractionAt, 12);
});

test("rejects invalid timestamps and changes after the attempt is finished", () => {
  assert.throws(() => new ReactionTimeCollector(Number.NaN), TypeError);

  const attempt = new ReactionTimeCollector(10);
  assert.throws(() => attempt.recordClick(9), RangeError);
  attempt.recordClick(19);
  assert.throws(() => attempt.finish(18), RangeError);
  attempt.finish(20);
  assert.throws(() => attempt.recordResponse(19), Error);
});

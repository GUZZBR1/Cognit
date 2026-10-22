import test from "node:test";
import assert from "node:assert/strict";
import { mutateChallenge } from "./challenge_mutations.mjs";

const challenge = {
  id: "c1",
  title: "Memory task",
  accessibility: { description: "Three shapes", announce: true },
  items: [
    { id: "a", position: { x: 0, y: 0 }, content: { kind: "circle", color: "blue" } },
    { id: "b", position: { x: 1, y: 0 }, content: { kind: "square", color: "red" } },
    { id: "c", position: { x: 0, y: 1 }, content: { kind: "triangle", color: "gold" } }
  ],
  distractors: ["c"]
};

const config = {
  durationMs: [500, 1000],
  positions: [
    { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 } },
    { a: { x: 2, y: 2 }, b: { x: 3, y: 2 }, c: { x: 2, y: 3 } }
  ],
  order: [["a", "b", "c"], ["c", "a", "b"]],
  distractors: [["c"], ["b"]]
};

test("selects deterministic mutations in independent named substreams", () => {
  const first = mutateChallenge(challenge, config, 2718);
  const second = mutateChallenge(challenge, config, 2718);
  assert.deepEqual(first, second);
  assert.equal(first.metadata.seed, 2718);
  assert.equal(first.metadata.engineVersion, "1.0.0");
  assert.deepEqual(Object.keys(first.metadata.selectedOptions), ["durationMs", "positions", "order", "distractors"]);
  for (const [name, index] of Object.entries(first.metadata.selectedOptions)) {
    assert.ok(Number.isInteger(index));
    assert.ok(index >= 0 && index < config[name].length);
    const chosen = config[name][index];
    if (name === "durationMs") assert.equal(first.presentation.durationMs, chosen);
    if (name === "positions") assert.deepEqual(first.presentation.positions, chosen);
    if (name === "order") assert.deepEqual(first.presentation.visualOrder, chosen);
    if (name === "distractors") assert.deepEqual(first.presentation.distractors, chosen);
  }
});

test("returns presentation separately and preserves challenge content and accessibility", () => {
  const before = structuredClone(challenge);
  const result = mutateChallenge(challenge, config, "seed");
  assert.equal(result.challenge, challenge);
  assert.deepEqual(challenge, before);
  assert.deepEqual(result.challenge.accessibility, before.accessibility);
  assert.deepEqual(result.challenge.items.map(({ id, content }) => ({ id, content })), before.items.map(({ id, content }) => ({ id, content })));
  assert.deepEqual(result.presentation.visualOrder.toSorted(), ["a", "b", "c"]);
  assert.equal(result.presentation.durationMs > 0, true);
  assert.equal(result.presentation.distractors.length, challenge.distractors.length);
  result.presentation.positions.a.x = 99;
  result.presentation.visualOrder.reverse();
  result.presentation.distractors.push("a");
  assert.deepEqual(challenge, before);
});

test("rejects invalid challenges before mutation", () => {
  assert.throws(() => mutateChallenge({ ...challenge, items: [{ ...challenge.items[0], id: "a" }, { ...challenge.items[1], id: "a" }] }, config, 1), /unique/);
  assert.throws(() => mutateChallenge({ ...challenge, items: [{ ...challenge.items[0], position: { x: Infinity, y: 0 } }] }, config, 1), /finite/);
  assert.throws(() => mutateChallenge({ ...challenge, items: [{ ...challenge.items[0], position: { x: "0", y: 0 } }] }, config, 1), /finite/);
  assert.throws(() => mutateChallenge({ ...challenge, distractors: ["unknown"] }, config, 1), /unknown ID/);
});

test("rejects invalid duration, seed, and empty configuration lists", () => {
  assert.throws(() => mutateChallenge(challenge, { ...config, durationMs: [0] }, 1), /positive finite/);
  assert.throws(() => mutateChallenge(challenge, { ...config, durationMs: [Infinity] }, 1), /positive finite/);
  assert.throws(() => mutateChallenge(challenge, { ...config, positions: [] }, 1), /non-empty/);
  assert.throws(() => mutateChallenge(challenge, config, NaN), /seed/);
  assert.throws(() => mutateChallenge(challenge, { ...config, distrctor: [[]] }, 1), /unsupported mutation/);
});

test("requires position options to define exactly all valid item positions", () => {
  assert.throws(() => mutateChallenge(challenge, { ...config, positions: [{ a: { x: 0, y: 0 } }] }, 1), /every item ID/);
  assert.throws(() => mutateChallenge(challenge, { ...config, positions: [{ a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: NaN, y: 1 } }] }, 1), /finite/);
});

test("requires every visual order to contain each item exactly once", () => {
  assert.throws(() => mutateChallenge(challenge, { ...config, order: [["a", "a", "c"]] }, 1), /duplicate/);
  assert.throws(() => mutateChallenge(challenge, { ...config, order: [["a", "b"]] }, 1), /every item ID/);
  assert.throws(() => mutateChallenge(challenge, { ...config, order: [["a", "b", "other"]] }, 1), /unknown ID/);
});

test("requires distractor options to preserve original cardinality", () => {
  assert.throws(() => mutateChallenge(challenge, { ...config, distractors: [[]] }, 1), /contain 1 IDs/);
  assert.throws(() => mutateChallenge(challenge, { ...config, distractors: [["a", "a"]] }, 1), /duplicate/);
});

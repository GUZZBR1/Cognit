import assert from "node:assert/strict";
import test from "node:test";

import { createOperationalMetrics } from "../src/operational-metrics.js";

test("reports only the aggregate count and page-visit start", () => {
  const startedAt = new Date("2026-10-22T12:00:00.000Z");
  const metrics = createOperationalMetrics({ startedAt });

  assert.deepEqual(metrics.snapshot(), {
    completedAttempts: 0,
    periodStart: "2026-10-22T12:00:00.000Z",
  });
  metrics.recordCompletedAttempt();
  metrics.recordCompletedAttempt();
  assert.deepEqual(metrics.snapshot(), {
    completedAttempts: 2,
    periodStart: "2026-10-22T12:00:00.000Z",
  });
  assert.equal("records" in metrics.snapshot(), false);
});

test("rejects an invalid dashboard period start", () => {
  assert.throws(() => createOperationalMetrics({ startedAt: "2026-10-22" }), /valid Date/);
  assert.throws(() => createOperationalMetrics({ startedAt: new Date(Number.NaN) }), /valid Date/);
});

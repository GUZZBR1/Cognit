import test from "node:test";
import assert from "node:assert/strict";
import { scenarios, makeResult, makeRunDocument, validateResult } from "./shared.js";

test("Selenium/Puppeteer share the complete fixed challenge catalog", () => {
  assert.deepEqual(scenarios.map(({ id }) => id), ["color-count-01", "symbol-count-01", "color-majority-01"]);
});

test("records use the Playwright run envelope and validate known ground truth", () => {
  const scenario = scenarios[0];
  const record = makeResult({
    tool: "selenium-webdriver", toolVersion: "4.0.0", browserVersion: "120.0",
    scenario, appResult: { challenge_id: scenario.challengeId, stimulus_id: "stimulus-1", duration_ms: 50, correct: true },
    mouseTelemetry: { schemaVersion: 1, pointCount: 0, features: null },
    features: { framework: "selenium", webdriver: true },
  });
  const document = makeRunDocument([record]);
  assert.equal(document.schema_version, 1);
  assert.equal(document.source, "cognit-fixed-demo");
  assert.ok(document.session_id);
  assert.deepEqual(Object.keys(document), ["schema_version", "session_id", "started_at", "source", "attempts"]);
  assert.equal(document.attempts[0].challenge_id, scenario.challengeId);
  assert.equal(record.ground_truth.label, "AUTOMATION_CONTROLLED");
  assert.equal(record.ground_truth.expected_answer, scenario.answer);
  assert.equal(record.tool, "selenium-webdriver");
  assert.equal(record.tool_version, "4.0.0");
  assert.equal(record.mouse_telemetry.schemaVersion, 1);
  validateResult(record, scenario);
  assert.throws(() => validateResult({ ...record, observed_result: { ...record.observed_result, correct: false } }, scenario), /did not match ground truth/);
});

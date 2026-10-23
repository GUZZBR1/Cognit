import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { normalizeRunnerOutput, validateTrialRecord, TRIAL_RECORD_REQUIRED_FIELDS } from "../scripts/browser-baseline-adapter.mjs";

const fixtureRoot = new URL("../fixtures/browser-baseline/", import.meta.url);
const [expected, run] = await Promise.all([
  readFile(new URL("trial-record-v1.json", fixtureRoot), "utf8").then(JSON.parse),
  readFile(new URL("runner-output-v1.json", fixtureRoot), "utf8").then(JSON.parse),
]);
const schema = JSON.parse(await readFile(new URL("../schemas/browser-baseline-trial-record-v1.schema.json", import.meta.url), "utf8"));
const context = expected;
const frameworkContext = (framework) => ({ ...context, framework });

function runnerFor(framework, attempts = run.attempts) {
  const result = structuredClone(run);
  result.attempts = structuredClone(attempts);
  if (framework === "selenium") Object.assign(result.attempts[0], { tool: "selenium-webdriver", tool_version: "1.0.0-fixture", browser: context.browser, browser_version: context.browser_version });
  if (framework === "puppeteer") Object.assign(result.attempts[0], { tool: "puppeteer", tool_version: "1.0.0-fixture", browser: context.browser, browser_version: context.browser_version });
  return result;
}

for (const framework of ["playwright", "selenium", "puppeteer"]) {
  test(`${framework} fixture maps to an oracle-isolated control TrialRecord`, () => {
    const metadata = frameworkContext(framework);
    if (framework === "selenium") metadata.tool_version = "4.38.0-fixture";
    if (framework === "puppeteer") metadata.tool_version = "25.16.0-fixture";
    const frameworkRun = runnerFor(framework);
    frameworkRun.attempts[0].tool_version = metadata.tool_version;
    const [record] = normalizeRunnerOutput({ framework, run: frameworkRun, context: metadata });
    assert.deepEqual(validateTrialRecord(record), { valid: true, errors: [] });
    assert.equal(record.framework, framework);
    assert.equal(record.tool_version, metadata.tool_version);
    assert.equal(record.browser, context.browser);
    assert.equal(record.browser_version, context.browser_version);
    assert.equal(record.cognit_commit, context.cognit_commit);
    assert.equal(record.protocol_version, context.protocol_version);
    assert.deepEqual(record.config, context.config);
    assert.equal(record.seed, context.seed);
    assert.equal(record.session_id, "fixture-session-001");
    assert.equal(record.attempt_id, "fixture-session-001-1");
    assert.equal(record.challenge_id, "fixture-challenge-001");
    assert.equal(record.target_origin, "http://127.0.0.1:4173");
    assert.equal(record.actor_class, "AUTOMATION_CONTROLLED");
    assert.equal(record.evidence_class, "SIMULATED");
    assert.equal(record.oracle_access, true);
    assert.equal(record.oracle_source, "runner.ground_truth.expected_answer");
    assert.equal(record.human_ground_truth, undefined);
    assert.equal(record.perception_metric_eligible, false);
    if (framework === "playwright") assert.deepEqual(record, expected);
  });
}

test("rejects runner output that does not explicitly name the controlled demo", () => {
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context, run: { ...run, source: "https://example.com" } }), /only cognit-fixed-demo is accepted/);
});

test("rejects absent oracle answer disclosure and cannot disable oracle_access", () => {
  const missing = structuredClone(run);
  delete missing.attempts[0].ground_truth.expected_answer;
  assert.throws(() => normalizeRunnerOutput({ framework: "selenium", context: frameworkContext("selenium"), run: runnerFor("selenium", missing.attempts) }), /missing oracle disclosure source/);
  const disabled = structuredClone(run);
  disabled.attempts[0].oracle_access = false;
  assert.throws(() => normalizeRunnerOutput({ framework: "puppeteer", context: frameworkContext("puppeteer"), run: runnerFor("puppeteer", disabled.attempts) }), /cannot be disabled/);
});

test("rejects human-confirmed labels, unsupported fixture versions, and invalid records", () => {
  const human = structuredClone(run);
  human.attempts[0].human_ground_truth = "HUMAN_CONFIRMED";
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context, run: human }), /cannot be HUMAN_CONFIRMED/);
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context: { ...context, record_version: "2.0.0" }, run }), /unsupported version/);
  const [record] = normalizeRunnerOutput({ framework: "playwright", context, run });
  assert.match(validateTrialRecord({ ...record, oracle_access: undefined }).errors.join("\n"), /oracle_access: must be true/);
  assert.match(validateTrialRecord({ ...record, actor_class: "HUMAN_CONFIRMED" }).errors.join("\n"), /must be AUTOMATION_CONTROLLED/);
  assert.match(validateTrialRecord({ ...record, perception_metric_eligible: true }).errors.join("\n"), /must be false/);
  assert.match(validateTrialRecord({ ...record, human_ground_truth: "HUMAN_CONFIRMED" }).errors.join("\n"), /cannot include human ground truth/);
  assert.deepEqual([...schema.required].sort(), [...TRIAL_RECORD_REQUIRED_FIELDS].sort());
  assert.deepEqual(Object.keys(schema.properties).sort(), [...TRIAL_RECORD_REQUIRED_FIELDS, "human_ground_truth"].sort());
  assert.equal(schema.additionalProperties, false);
  const originPattern = new RegExp(schema.properties.target_origin.pattern);
  assert.equal(originPattern.test(expected.target_origin), true);
  assert.equal(originPattern.test("http://localhost:99999"), false);
  assert.equal(originPattern.test("http://localhost/demo"), false);
  assert.equal(originPattern.test("http://localhost:80"), true);
  assert.equal(originPattern.test("http://localhost:0"), false);
  assert.equal(schema.properties.observed_result.type, "object");
  assert.match(schema.properties.tool_version.pattern, /\\S/);
  assert.equal(schema.properties.seed.oneOf[1].maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(validateTrialRecord({ ...record, observed_result: "not an object" }).valid, false);
  assert.equal(validateTrialRecord({ ...record, tool_version: "   " }).valid, false);
  assert.equal(validateTrialRecord({ ...record, seed: "   " }).valid, false);
  assert.equal(validateTrialRecord({ ...record, seed: Number.MAX_SAFE_INTEGER + 1 }).valid, false);
  assert.equal(validateTrialRecord({ ...record, target_origin: "http://localhost:0" }).valid, false);
});

test("rejects mismatched challenge results and changed config hashes with diagnostics", () => {
  const mismatched = structuredClone(run);
  mismatched.attempts[0].observed_result.challenge_id = "different";
  assert.throws(() => normalizeRunnerOutput({ framework: "puppeteer", context: frameworkContext("puppeteer"), run: runnerFor("puppeteer", mismatched.attempts) }), /does not match challenge_id/);
  assert.throws(() => normalizeRunnerOutput({ framework: "puppeteer", context: { ...frameworkContext("puppeteer"), config: { mode: "changed" } }, run: runnerFor("puppeteer") }), /does not match canonical config SHA-256/);
});

test("rejects a runner framework or embedded tool metadata mismatch", () => {
  assert.throws(() => normalizeRunnerOutput({ framework: "selenium", context, run }), /does not match requested selenium/);
  const mismatch = runnerFor("selenium");
  mismatch.attempts[0].tool = "puppeteer";
  assert.throws(() => normalizeRunnerOutput({ framework: "selenium", context: { ...context, framework: "selenium" }, run: mismatch }), /does not match framework selenium/);
});

test("rejects optional Playwright version and browser metadata that contradicts context", () => {
  for (const [key, value] of [["tool_version", "wrong"], ["browser", "Other"], ["browser_version", "999"]]) {
    const mismatched = structuredClone(run);
    mismatched.attempts[0][key] = value;
    assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context, run: mismatched }), /does not match TrialRecord context/);
  }
});

test("rejects non-loopback target origins and unknown record fields", () => {
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context: { ...context, target_origin: "https://example.com" }, run }), /expected an http loopback origin/);
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context: { ...context, target_origin: "http://localhost:99999" }, run }), /expected an http loopback origin/);
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context: { ...context, target_origin: "http://localhost/demo" }, run }), /expected an http loopback origin/);
  assert.equal(validateTrialRecord({ ...normalizeRunnerOutput({ framework: "playwright", context: { ...context, target_origin: "http://localhost:80" }, run })[0], target_origin: "http://localhost:80" }).valid, true);
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context, run: { ...run, target_origin: "https://example.com" } }), /does not match TrialRecord context/);
  const [record] = normalizeRunnerOutput({ framework: "playwright", context, run });
  assert.match(validateTrialRecord({ ...record, unrecognized: true }).errors.join("\n"), /unrecognized: unknown field/);
  assert.match(validateTrialRecord({ ...record, human_ground_truth: { label: "HUMAN_CONFIRMED" } }).errors.join("\n"), /cannot include human ground truth/);
});

test("rejects structured attempt IDs instead of stringifying them", () => {
  const malformed = structuredClone(run);
  malformed.attempts[0].attempt_id = { opaque: true };
  assert.throws(() => normalizeRunnerOutput({ framework: "playwright", context, run: malformed }), /attempt_id: required non-empty string/);
});

test("CLI writes a normalized export for the local TrialRecord fixture", () => {
  const outputPath = new URL("../fixtures/browser-baseline/export-smoke.json", import.meta.url);
  const result = spawnSync(process.execPath, [new URL("../scripts/browser-baseline-adapter.mjs", import.meta.url).pathname, "--framework", "playwright", "--input", new URL("../fixtures/browser-baseline/runner-output-v1.json", import.meta.url).pathname, "--context", new URL("../fixtures/browser-baseline/trial-record-v1.json", import.meta.url).pathname, "--output", outputPath.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const exported = readFileSync(outputPath, "utf8");
  const document = JSON.parse(exported);
  assert.equal(document.record_version, "1.0.0");
  assert.deepEqual(document.records, [expected]);
  unlinkSync(outputPath);
});

test("CLI refuses to overwrite its runner input", () => {
  const inputPath = new URL("../fixtures/browser-baseline/runner-output-v1.json", import.meta.url);
  const before = readFileSync(inputPath, "utf8");
  const result = spawnSync(process.execPath, [new URL("../scripts/browser-baseline-adapter.mjs", import.meta.url).pathname, "--framework", "playwright", "--input", inputPath.pathname, "--context", new URL("../fixtures/browser-baseline/trial-record-v1.json", import.meta.url).pathname, "--output", inputPath.pathname], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not resolve to the same file/);
  assert.equal(readFileSync(inputPath, "utf8"), before);
});

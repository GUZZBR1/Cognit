import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fixedChallenges } from "../src/fixed-challenges.js";

export const scenarios = fixedChallenges.map((challenge) => ({
  id: challenge.challenge_id,
  challengeId: challenge.challenge_id,
  answer: challenge.expected_answer,
  groundTruth: { label: "AUTOMATION_CONTROLLED", source: "runner configuration" },
}));
export const sessionId = randomUUID();
export const startedAt = new Date().toISOString();

export function makeResult({ tool, toolVersion, browserVersion, scenario, appResult, mouseTelemetry, features }) {
  return {
    challenge_id: scenario.challengeId,
    stimulus_id: appResult.stimulus_id,
    duration_ms: appResult.duration_ms,
    mouse_telemetry: mouseTelemetry,
    ground_truth: { type: "authored_answer", expected_answer: scenario.answer, ...scenario.groundTruth },
    observed_result: appResult,
    tool,
    tool_version: toolVersion,
    browser: "Chrome",
    browser_version: browserVersion,
    features,
  };
}

export function validateResult(record, scenario) {
  if (record.challenge_id !== scenario.challengeId || record.stimulus_id === undefined) throw new Error(`Scenario mismatch for ${scenario.id}`);
  if (record.ground_truth?.type !== "authored_answer" || record.ground_truth?.expected_answer !== scenario.answer || record.ground_truth?.label !== "AUTOMATION_CONTROLLED") throw new Error(`Ground truth mismatch for ${scenario.id}`);
  if (!record.tool || !record.tool_version || !record.browser || !record.browser_version) throw new Error(`Missing tool or version metadata for ${scenario.id}`);
  if (!record.mouse_telemetry || typeof record.mouse_telemetry !== "object" || !record.features || typeof record.features !== "object" || !record.observed_result) throw new Error(`Missing features or observed result for ${scenario.id}`);
  if (record.observed_result.challenge_id !== scenario.challengeId || record.observed_result.correct !== true) throw new Error(`Cognit result did not match ground truth for ${scenario.id}`);
}

export function makeRunDocument(attempts) {
  return {
    schema_version: 1,
    session_id: sessionId,
    started_at: startedAt,
    source: "cognit-fixed-demo",
    attempts,
  };
}

export async function startAppServer() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: process.cwd(), stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Cognit server exited with code ${server.exitCode}`);
      try { if ((await fetch(url)).ok) return { server, url }; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Cognit server did not become ready");
  } catch (error) { server.kill(); throw error; }
}

export function stopProcess(process) {
  if (!process || process.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => process.kill("SIGKILL"), 2000);
    process.once("exit", () => { clearTimeout(timeout); resolve(); });
    process.kill("SIGTERM");
  });
}

export async function browserFeatures(readBrowserFeatures, framework) {
  const observed = await readBrowserFeatures();
  return { framework, ...observed };
}

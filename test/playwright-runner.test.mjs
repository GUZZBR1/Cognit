import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDemoServer, parseArgs, buildRunDocument, isAllowedRequest, advanceToSetup } from "../scripts/run-playwright.mjs";

test("runner accepts only its documented bounded options", () => {
  assert.deepEqual(parseArgs(["--repeat", "2", "--duration", "200", "--output", "runs.json"]), { output: "runs.json", repeat: 2, duration: 200 });
  for (const args of [["--url", "https://example.com"], ["--repeat", "101"], ["--duration", "75"], ["--output"]]) assert.throws(() => parseArgs(args));
});

test("run document has a stable schema", () => {
  const attempt = { session_id: "session-1", challenge_id: "c1", stimulus_id: "s1", mouse_telemetry: { schemaVersion: 1 }, ground_truth: {}, observed_result: {} };
  assert.deepEqual(buildRunDocument("session-1", [attempt], "2026-10-22T00:00:00.000Z"), { schema_version: 1, session_id: "session-1", started_at: "2026-10-22T00:00:00.000Z", source: "cognit-fixed-demo", evidence_class: "SIMULATED", human_consent: "NOT_ESTABLISHED", attempts: [attempt] });
});

test("request guard allows only the exact local demo origin", () => {
  assert.equal(isAllowedRequest("http://127.0.0.1:8123/src/app.js", "http://127.0.0.1:8123"), true);
  assert.equal(isAllowedRequest("https://example.com/", "http://127.0.0.1:8123"), false);
  assert.equal(isAllowedRequest("http://127.0.0.1:8124/", "http://127.0.0.1:8123"), false);
});

test("static server serves demo and rejects outside paths", async (t) => {
  const server = createDemoServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const demo = await fetch(`${origin}/`);
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /Cognit/);
  for (const modulePath of ["/src/human-dataset.js", "/src/operational-metrics.js"]) {
    const moduleResponse = await fetch(`${origin}${modulePath}`);
    assert.equal(moduleResponse.status, 200, `${modulePath} is served`);
    assert.match(moduleResponse.headers.get("content-type"), /^text\/javascript/);
    assert.ok((await moduleResponse.text()).length > 0);
  }
  assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/src/seeded-generator.js`)).status, 404);
});

test("Playwright startup reaches setup through the UI and labels consent as unestablished", async (t) => {
  const server = createDemoServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await advanceToSetup(page);
  assert.equal(await page.locator("#setup-panel").isVisible(), true);
  const run = buildRunDocument("simulated-session", [], "2026-10-22T00:00:00.000Z");
  assert.equal(run.evidence_class, "SIMULATED");
  assert.equal(run.human_consent, "NOT_ESTABLISHED");
});

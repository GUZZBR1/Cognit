import test from "node:test";
import assert from "node:assert/strict";
import { createDemoServer, parseArgs, buildRunDocument, isAllowedRequest } from "../scripts/run-playwright.mjs";

test("runner accepts only its documented bounded options", () => {
  assert.deepEqual(parseArgs(["--repeat", "2", "--duration", "200", "--output", "runs.json"]), { output: "runs.json", repeat: 2, duration: 200 });
  for (const args of [["--url", "https://example.com"], ["--repeat", "101"], ["--duration", "75"], ["--output"]]) assert.throws(() => parseArgs(args));
});

test("run document has a stable schema", () => {
  const attempt = { session_id: "session-1", challenge_id: "c1", stimulus_id: "s1", mouse_telemetry: { schemaVersion: 1 }, ground_truth: {}, observed_result: {} };
  assert.deepEqual(buildRunDocument("session-1", [attempt], "2026-10-22T00:00:00.000Z"), { schema_version: 1, session_id: "session-1", started_at: "2026-10-22T00:00:00.000Z", source: "cognit-fixed-demo", attempts: [attempt] });
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
  assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/src/seeded-generator.js`)).status, 404);
});

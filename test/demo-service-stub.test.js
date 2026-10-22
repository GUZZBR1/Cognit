import test from "node:test";
import assert from "node:assert/strict";
import { CognitClient, CognitClientError } from "../src/cognit/client-sdk.js";
import { createDemoServiceStub } from "../src/cognit/demo-service-stub.js";

test("demo stub supports the session, challenge, telemetry, pending, and result flow", async () => {
  const service = createDemoServiceStub();
  const client = new CognitClient({ baseUrl: "http://cognit-demo.local", fetch: service.fetch });
  const session = await client.createSession();
  assert.equal(session.status, "active");

  const challenge = await client.getChallenge(session.session_id);
  assert.equal(challenge.challenge_id, "color-count-01");
  assert.equal("expected_answer" in challenge, false);

  assert.deepEqual(await client.submitTelemetry(session.session_id, {
    status: "complete", features: { distancePx: 12 }
  }), { status: "received" });
  const accepted = await client.submitResult(session.session_id, { response: "3" });
  assert.equal(accepted.status, "pending");
  assert.equal((await client.getResult(session.session_id)).status, "pending");

  const completed = await client.getResult(session.session_id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.status, "received");
  assert.equal(completed.verification_token, "demo-token-not-for-production");
});

test("demo stub can expose a simulated network failure through the SDK", async () => {
  const service = createDemoServiceStub();
  const client = new CognitClient({ baseUrl: "http://cognit-demo.local", fetch: service.fetch });
  service.failNextRequest();
  await assert.rejects(client.createSession(), (error) => {
    assert.ok(error instanceof CognitClientError);
    assert.equal(error.code, "NETWORK_ERROR");
    return true;
  });
});

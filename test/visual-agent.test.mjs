import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ALLOWED_ORIGIN, runVisualAttempt } from '../scripts/visual-agent/adapter.mjs';
import { createMockPolicy } from '../scripts/visual-agent/mock-policy.mjs';
import { createPlaywrightVisualPort, isAllowedVisualRequest } from '../scripts/visual-agent/playwright-port.mjs';
import { runMock } from '../scripts/visual-agent/run-mock.mjs';

const provenance = {
  execution_mode: 'SIMULATED', provider: 'mock', model: 'fixture-policy', model_version: '1',
  configuration: { fixture: 'actions.json', api_key: 'test-secret' }, prompt_template_version: 'visual-agent-v1',
  browser: 'mock-visual-port', cognit_commit: 'abc123',
};

function browserPort(overrides = {}) {
  return {
    origin: ALLOWED_ORIGIN,
    async screenshot() { return { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 640, height: 360 }; },
    async click() {},
    ...overrides,
  };
}

test('mock traverses screenshot → visual click → observed attempt and exports provenance', async () => {
  const { attempt, evidence } = await runMock();
  assert.equal(attempt.execution_mode, 'SIMULATED');
  assert.equal(attempt.result, 'UNKNOWN');
  assert.equal(attempt.failure, null);
  assert.deepEqual(attempt.actions, [{ type: 'click', x: 100, y: 136 }]);
  assert.equal(attempt.provenance.prompt_template_version, 'visual-agent-v1');
  assert.deepEqual(attempt.provenance.configuration, { fixture: 'actions.json' });
  assert.ok(Date.parse(attempt.started_at) <= Date.parse(attempt.completed_at));
  assert.equal(attempt.provenance.browser, 'mock-visual-port');
  assert.deepEqual(evidence.applied_clicks, [{ x: 100, y: 136 }]);
  assert.equal(evidence.screenshot_count, 2);
});

test('the agent receives screenshots and viewport only, never DOM, API, or challenge answers', async () => {
  const fixture = await readFile(new URL('./fixtures/visual-agent/actions.json', import.meta.url), 'utf8');
  const fixtureSteps = JSON.parse(fixture);
  for (const step of fixtureSteps) {
    assert.deepEqual(Object.keys(step).sort(), ['action', 'observation']);
    assert.equal(Object.hasOwn(step, 'expected_answer'), false);
    assert.equal(Object.hasOwn(step, 'correct_answer'), false);
  }
  let received;
  const agent = { async act(input) { received = input; return { action: { type: 'stop' } }; } };
  await runVisualAttempt({ browser: browserPort(), agent, provenance });
  assert.deepEqual(Object.keys(received).sort(), ['screenshot', 'viewport']);
  assert.deepEqual(Object.keys(received.screenshot).sort(), ['data', 'mimeType']);
  assert.deepEqual(Object.keys(received.viewport).sort(), ['height', 'width']);
});

test('rejects origins outside the controlled local demo and exposes no navigation capability', async () => {
  await assert.rejects(runVisualAttempt({
    browser: browserPort({ origin: 'https://example.com' }), agent: createMockPolicy([]), provenance,
  }), /blocked browser origin/);
  await assert.rejects(runVisualAttempt({
    browser: browserPort({ origin: 'http://127.0.0.1:4174' }), agent: createMockPolicy([]), provenance,
  }), /blocked browser origin/);
  await assert.rejects(runVisualAttempt({
    browser: browserPort({ navigate() {} }), agent: createMockPolicy([]), provenance,
  }), /browser.navigate is not an allowed visual capability/);
});

test('refusals, exceptions, and uncertain observations stay UNKNOWN and carry failure evidence', async () => {
  const refusal = await runVisualAttempt({
    browser: browserPort(), agent: { async act() { return { refusal: 'provider declined the request' }; } }, provenance,
  });
  assert.equal(refusal.result, 'UNKNOWN');
  assert.deepEqual(refusal.failure, { name: 'AgentRefusal', message: 'provider declined the request' });

  const uncertain = await runVisualAttempt({
    browser: browserPort(), agent: { async act() { return { action: { type: 'stop' }, observation: 'I cannot determine the outcome.' }; } }, provenance,
  });
  assert.equal(uncertain.result, 'UNKNOWN');
  assert.equal(uncertain.failure, null);
  assert.match(uncertain.observed_result, /cannot determine/);

  const failed = await runVisualAttempt({ browser: browserPort(), agent: { async act() { throw new Error('provider refused'); } }, provenance });
  assert.equal(failed.result, 'UNKNOWN');
  assert.deepEqual(failed.failure, { name: 'Error', message: 'provider refused' });
});

test('requires complete typed provenance fields', async () => {
  for (const [field, value] of [['provider', '  '], ['model_version', null], ['browser', 4], ['configuration', null]]) {
    const invalid = { ...provenance, [field]: value };
    await assert.rejects(runVisualAttempt({ browser: browserPort(), agent: createMockPolicy([]), provenance: invalid }), /provenance\./);
  }
  await assert.rejects(runVisualAttempt({ browser: browserPort(), agent: createMockPolicy([]), provenance: { ...provenance, configuration: {} } }), /non-empty object/);
});

test('blocks cross-origin and internal API requests at the browser network boundary', async () => {
  assert.equal(isAllowedVisualRequest('http://127.0.0.1:4173/visual-agent-demo'), true);
  assert.equal(isAllowedVisualRequest('http://127.0.0.1:4173/api/sessions'), false);
  assert.equal(isAllowedVisualRequest('https://example.com/'), false);
  assert.equal(isAllowedVisualRequest('http://user:pass@127.0.0.1:4173/visual-agent-demo'), false);
  assert.equal(isAllowedVisualRequest('http://127.0.0.1:4173/visual-agent-demo?outside=1'), false);
  let installRoute;
  const events = [];
  let screenshotCount = 0;
  let currentUrl = `${ALLOWED_ORIGIN}/visual-agent-demo`;
  const context = {
    async route(_pattern, handler) { installRoute = handler; },
    async newPage() { return page; },
  };
  const page = {
    async goto(url) { currentUrl = url; },
    url() { return currentUrl; },
    viewportSize() { return { width: 640, height: 360 }; },
    async screenshot() { screenshotCount += 1; events.push(`screenshot-${screenshotCount}`); return new Uint8Array([1, 2, 3]); },
    mouse: { async click() {
      events.push('click');
      await installRoute({
        request() { return { url: () => 'https://outside.example/navigation' }; },
        async abort(reason) { abortReason = reason; events.push('blocked'); },
        async continue() { continued = true; },
      });
    } },
  };
  const chromium = { async launch() { return { version() { return 'test-browser'; }, async newContext() { return context; }, async close() {} }; } };
  const controlled = await createPlaywrightVisualPort({ chromium });
  let abortReason;
  let continued = false;
  const result = await runVisualAttempt({
    browser: controlled.port,
    agent: createMockPolicy([{ action: { type: 'click', x: 10, y: 10 } }, { action: { type: 'stop' } }]),
    provenance,
  });
  assert.equal(result.failure, null);
  assert.equal(abortReason, 'blockedbyclient');
  assert.equal(continued, false);
  assert.deepEqual(controlled.blockedRequests, ['https://outside.example/navigation']);
  assert.deepEqual(events, ['screenshot-1', 'click', 'blocked', 'screenshot-2']);
  await controlled.close();
});

test('sensitive provenance configuration is redacted and mock mode cannot be mislabeled as measured', async () => {
  const redacted = await runVisualAttempt({ browser: browserPort(), agent: { async act() { return { action: { type: 'stop' } }; } }, provenance });
  assert.equal(redacted.provenance.configuration.api_key, '[REDACTED]');
  await assert.rejects(runVisualAttempt({
    browser: browserPort(), agent: createMockPolicy([]), provenance: { ...provenance, execution_mode: 'MEASURED_LAB' },
  }), /mock executions must be marked SIMULATED/);
  const invalid = await runVisualAttempt({
    browser: browserPort(), agent: { async act() { return { action: { type: 'click', x: 640, y: 2 } }; } }, provenance,
  });
  assert.equal(invalid.result, 'UNKNOWN');
  assert.match(invalid.failure.message, /within the screenshot viewport/);
  const roundedOutside = await runVisualAttempt({
    browser: browserPort(),
    agent: { async act() { return { action: { type: 'click', x: 639.9, y: 359.9 } }; } },
    provenance,
  });
  assert.match(roundedOutside.failure.message, /within the screenshot viewport/);
  const nonImage = await runVisualAttempt({
    browser: browserPort({ async screenshot() { return { data: new Uint8Array([1]), mimeType: 'text/html', width: 640, height: 360 }; } }),
    agent: createMockPolicy([]), provenance,
  });
  assert.match(nonImage.failure.message, /image/);
});

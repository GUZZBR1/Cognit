import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitClient, CognitClientError } from '../../dist/client-sdk.js';

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

test('client sends session, challenge, telemetry, result and verification requests', async () => {
  const calls = [];
  const replies = [
    { session_id: 's/1', state: 'active' },
    { challenge_id: 'c1', question: 'Choose' },
    { accepted: true },
    { result_id: 'r1', state: 'pending' },
    { result_id: 'r1', state: 'pending' },
    { session_id: 's/1', state: 'active', attempt_state: 'succeeded' },
  ];
  const client = new CognitClient({
    baseUrl: 'https://api.example.test/',
    fetch: async (...args) => {
      calls.push(args);
      return response(replies.shift());
    },
  });
  const telemetry = { events: [{ at: 12 }] };
  const result = { answer: 'blue' };

  assert.deepEqual(await client.createSession(), { session_id: 's/1', state: 'active' });
  assert.deepEqual(await client.getChallenge('s/1'), { challenge_id: 'c1', question: 'Choose' });
  assert.deepEqual(await client.submitTelemetry('s/1', telemetry), { accepted: true });
  assert.deepEqual(await client.submitResult('s/1', result), { result_id: 'r1', state: 'pending' });
  assert.deepEqual(await client.getResult('s/1'), { result_id: 'r1', state: 'pending' });
  assert.deepEqual(await client.verifySession('s/1'), {
    session_id: 's/1', state: 'active', attempt_state: 'succeeded',
  });
  assert.deepEqual(calls.map(([url, init]) => [url, init.method, init.body]), [
    ['https://api.example.test/sessions', 'POST', undefined],
    ['https://api.example.test/sessions/s%2F1/challenge', 'GET', undefined],
    ['https://api.example.test/sessions/s%2F1/telemetry', 'POST', JSON.stringify(telemetry)],
    ['https://api.example.test/sessions/s%2F1/result', 'POST', JSON.stringify(result)],
    ['https://api.example.test/sessions/s%2F1/result', 'GET', undefined],
    ['https://api.example.test/sessions/s%2F1/verify', 'POST', undefined],
  ]);
  assert.equal(calls[2][1].headers['Content-Type'], 'application/json');
});

test('network failures are reported as CognitClientError', async () => {
  const cause = new TypeError('offline');
  const client = new CognitClient({ baseUrl: '/api', fetch: async () => { throw cause; } });

  await assert.rejects(client.createSession(), (error) => {
    assert.ok(error instanceof CognitClientError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.status, null);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('the default browser fetch keeps its globalThis receiver', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async function fetchWithReceiver() {
    assert.equal(this, globalThis);
    return response({ session_id: 's1' });
  };
  try {
    const client = new CognitClient({ baseUrl: '/api' });
    assert.deepEqual(await client.createSession(), { session_id: 's1' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('HTTP failures preserve the response status and API error code', async () => {
  const client = new CognitClient({
    baseUrl: '/api',
    fetch: async () => response({ code: 'SESSION_GONE', message: 'Gone' }, 410),
  });

  await assert.rejects(client.getResult('s1'), (error) => {
    assert.ok(error instanceof CognitClientError);
    assert.equal(error.status, 410);
    assert.equal(error.code, 'SESSION_GONE');
    assert.equal(error.message, 'Gone');
    return true;
  });
});

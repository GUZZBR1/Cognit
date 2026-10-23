import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitClient, CognitClientError } from '../src/cognit/client-sdk.js';

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

test('client sends session and challenge requests to their endpoints', async () => {
  const calls = [];
  const client = new CognitClient({
    baseUrl: 'https://api.example.test/',
    fetch: async (...args) => { calls.push(args); return response({ id: 's/1' }); },
  });
  assert.deepEqual(await client.createSession(), { id: 's/1' });
  assert.deepEqual(await client.getChallenge('s/1'), { id: 's/1' });
  assert.equal(calls[0][0], 'https://api.example.test/sessions');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[1][0], 'https://api.example.test/sessions/s%2F1/challenge');
  assert.equal(calls[1][1].method, 'GET');
  assert.equal(calls[1][1].headers.Accept, 'application/json');
});

test('client submits telemetry and results as JSON and can retrieve pending results', async () => {
  const calls = [];
  const telemetry = { events: [{ at: 12 }] };
  const result = { answer: 'x' };
  const client = new CognitClient({ baseUrl: '/api', fetch: async (...args) => {
    calls.push(args);
    return response(calls.length === 3 ? { status: 'pending' } : { accepted: true });
  } });
  assert.deepEqual(await client.submitTelemetry('s1', telemetry), { accepted: true });
  assert.deepEqual(await client.submitResult('s1', result), { accepted: true });
  assert.deepEqual(await client.getResult('s1'), { status: 'pending' });
  assert.deepEqual(calls.map(([url, init]) => [url, init.method, init.body]), [
    ['/api/sessions/s1/telemetry', 'POST', JSON.stringify(telemetry)],
    ['/api/sessions/s1/result', 'POST', JSON.stringify(result)],
    ['/api/sessions/s1/result', 'GET', undefined],
  ]);
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
});

test('network failures have a distinct error code', async () => {
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

test('response body read failures are represented as network errors', async () => {
  const cause = new TypeError('connection reset while reading');
  const client = new CognitClient({ baseUrl: '/api', fetch: async () => ({
    ok: true, status: 200, text: async () => { throw cause; },
  }) });
  await assert.rejects(client.createSession(), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.status, 200);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('HTTP failures expose status and API error code', async () => {
  const client = new CognitClient({ baseUrl: '/api', fetch: async () => response({ code: 'SESSION_GONE', message: 'Gone' }, 410) });
  await assert.rejects(client.getResult('s1'), (error) => {
    assert.equal(error.name, 'CognitClientError');
    assert.equal(error.status, 410);
    assert.equal(error.code, 'SESSION_GONE');
    assert.equal(error.message, 'Gone');
    return true;
  });
});

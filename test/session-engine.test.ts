import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine } from '../src/cognit/session-engine.ts';

function fixture() {
  let now = 100;
  let nextId = 0;
  const engine = new SessionEngine({
    now: () => now,
    createId: () => `opaque/${++nextId}:id`,
  });
  return { engine, setNow: (value: number) => { now = value; } };
}

test('creates an active session and updates its registered associations', () => {
  const { engine, setNow } = fixture();
  for (const [kind, id] of [['challenge', 'c-1'], ['result', 'r-1'], ['telemetry', 't-1']] as const) {
    engine.registerReference('app-a', kind, id);
  }

  const created = engine.createSession('app-a', 200);
  assert.deepEqual(created, {
    id: 'opaque/1:id', appId: 'app-a', state: 'active', attemptState: 'pending',
    createdAt: 100, updatedAt: 100, expiresAt: 200,
  });

  setNow(125);
  const updated = engine.updateSession('app-a', created.id, {
    challengeId: 'c-1', resultId: 'r-1', telemetryId: 't-1',
  });
  assert.equal(updated.updatedAt, 125);
  assert.equal(updated.challengeId, 'c-1');
  assert.equal(updated.resultId, 'r-1');
  assert.equal(updated.telemetryId, 't-1');
  assert.equal(engine.getSession('app-a', created.id).state, 'active');
});

test('starts attempts as pending and allows a valid update to mark success', () => {
  const { engine } = fixture();
  const session = engine.createSession('app-a', 200);

  assert.equal(session.attemptState, 'pending');
  assert.equal(engine.updateSession('app-a', session.id, { attemptState: 'succeeded' }).attemptState, 'succeeded');
});

test('rejects invalid attempt states without changing the session', () => {
  const { engine } = fixture();
  const session = engine.createSession('app-a', 200);
  const before = engine.getSession('app-a', session.id);

  assert.throws(() => engine.updateSession('app-a', session.id, { attemptState: 'unknown' } as never));
  assert.deepEqual(engine.getSession('app-a', session.id), before);
});

test('rejects protected session fields in updates without changing the session', () => {
  const { engine } = fixture();
  const session = engine.createSession('app-a', 200);
  const before = engine.getSession('app-a', session.id);

  for (const update of [
    { state: 'expired' },
    { appId: 'other-app' },
    { expiresAt: 999 },
  ]) {
    assert.throws(() => engine.updateSession('app-a', session.id, update as never));
    assert.deepEqual(engine.getSession('app-a', session.id), before);
  }
});

test('expires automatically at the expiry boundary and rejects later updates', () => {
  const { engine, setNow } = fixture();
  const session = engine.createSession('app-a', 200);
  setNow(200);

  const expired = engine.getSession('app-a', session.id);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.expiredAt, 200);
  assert.equal(expired.updatedAt, 200);
  assert.throws(() => engine.updateSession('app-a', session.id, {}), /session is expired/);
});

test('explicitly expires an active session and keeps the first expiry time', () => {
  const { engine, setNow } = fixture();
  const session = engine.createSession('app-a', 300);
  setNow(150);
  const expired = engine.expireSession('app-a', session.id);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.expiredAt, 150);

  setNow(175);
  assert.equal(engine.expireSession('app-a', session.id).expiredAt, 150);
});

test('rejects missing and cross-app references without changing the session', () => {
  const { engine } = fixture();
  engine.registerReference('app-b', 'challenge', 'shared');
  const session = engine.createSession('app-a', 200);

  assert.throws(() => engine.updateSession('app-a', session.id, { challengeId: 'missing' }), /challenge reference does not exist/);
  assert.throws(() => engine.updateSession('app-a', session.id, { challengeId: 'shared' }), /challenge reference does not exist/);
  assert.equal(engine.getSession('app-a', session.id).challengeId, undefined);
});

test('scopes opaque session IDs by app', () => {
  let now = 100;
  const ids = ['same/id:opaque', 'same/id:opaque'];
  const engine = new SessionEngine({ now: () => now, createId: () => ids.shift()! });
  const firstApp = engine.createSession('a:b', 200);
  const secondApp = engine.createSession('a', 200);

  assert.equal(firstApp.id, secondApp.id);
  assert.equal(engine.getSession('a:b', firstApp.id).appId, 'a:b');
  assert.equal(engine.getSession('a', secondApp.id).appId, 'a');
  assert.throws(() => engine.getSession('b', firstApp.id), /session does not exist for app/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HISTORY_RETENTION_MS,
  DEFAULT_MAX_RECENT_SESSIONS,
  HistoryProfileEngine,
} from '../src/cognit/history-profile-engine.ts';

function createEngine(options: ConstructorParameters<typeof HistoryProfileEngine>[0] = {}) {
  let currentTime = 1_800_000_000_000;
  const engine = new HistoryProfileEngine({ now: () => currentTime, ...options });
  return { engine, advance: (ms: number) => { currentTime += ms; } };
}

test('uses only app-supplied pseudonyms and isolates matching pseudonyms by app', () => {
  const { engine } = createEngine();
  assert.equal(engine.getProfile('app-a', 'visitor-1'), undefined);

  engine.recordSession('app-a', 'visitor-1', { outcome: 'succeeded' });
  engine.recordSession('app-b', 'visitor-1', { outcome: 'failed' });

  assert.equal(engine.getProfile('app-a', 'visitor-1')?.previousResults[0].outcome, 'succeeded');
  assert.equal(engine.getProfile('app-b', 'visitor-1')?.previousResults[0].outcome, 'failed');
  assert.equal(engine.getProfile('app-c', 'visitor-1'), undefined);
});

test('returns only recent session timestamps and result categories', () => {
  const { engine, advance } = createEngine();
  engine.recordSession('app-a', 'visitor-1', {});
  advance(1000);
  engine.recordSession('app-a', 'visitor-1', { outcome: 'failed' });

  const profile = engine.getProfile('app-a', 'visitor-1');
  assert.equal(profile?.recentSessions.length, 2);
  assert.equal(profile?.previousResults.length, 1);
  assert.equal(profile?.previousResults[0].outcome, 'failed');
  assert.deepEqual(Object.keys(profile?.recentSessions[0] ?? {}), ['lastActivityAt']);
  assert.deepEqual(Object.keys(profile?.previousResults[0] ?? {}), ['outcome', 'recordedAt']);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile?.recentSessions), true);
});

test('absent and expired history stay absent, with a bounded recent-session window', () => {
  assert.equal(DEFAULT_HISTORY_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_MAX_RECENT_SESSIONS, 10);
  const { engine, advance } = createEngine({ maxRecentSessions: 2, retentionMs: 1000 });
  for (let i = 0; i < 3; i += 1) engine.recordSession('app-a', 'visitor-1', { outcome: 'succeeded' });

  const profile = engine.getProfile('app-a', 'visitor-1');
  assert.equal(profile?.recentSessions.length, 2);
  assert.equal(profile?.previousResults.length, 2);
  advance(1001);
  assert.equal(engine.getProfile('app-a', 'visitor-1'), undefined);
});

test('purges expired profile data while the engine is idle', async () => {
  let clockReads = 0;
  const engine = new HistoryProfileEngine({
    now: () => { clockReads += 1; return Date.now(); },
    retentionMs: 20,
  });
  engine.recordSession('app-a', 'visitor-1', { outcome: 'failed' });
  const readsBeforeExpiry = clockReads;

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(clockReads > readsBeforeExpiry, 'expiry timer should run without a profile read');
  assert.equal(engine.getProfile('app-a', 'visitor-1'), undefined);
});

test('opt-out removes the profile and the app controls whether further history is recorded', () => {
  const { engine } = createEngine();
  engine.recordSession('app-a', 'visitor-1', { outcome: 'failed' });
  engine.optOut('app-a', 'visitor-1');
  assert.equal(engine.getProfile('app-a', 'visitor-1'), undefined);

  // The consent-owning application must stop calling recordSession after opt-out.
  engine.recordSession('app-a', 'visitor-1', { outcome: 'succeeded' });
  assert.equal(engine.getProfile('app-a', 'visitor-1')?.previousResults[0].outcome, 'succeeded');
});

test('rejects missing identifiers, unsupported data, and invalid outcomes', () => {
  const { engine } = createEngine();
  assert.throws(() => engine.recordSession('', 'visitor-1', {}), /appId/);
  assert.throws(() => engine.getProfile('app-a', ' '), /pseudonym/);
  assert.throws(() => engine.recordSession('app-a', 'visitor-1', { details: 'raw payload' } as never), /unsupported fields/);
  assert.throws(() => engine.recordSession('app-a', 'visitor-1', { outcome: 'unknown' } as never), /outcome/);
  assert.equal(engine.getProfile('app-a', 'visitor-1'), undefined);
});

test('validates retention and profile limits', () => {
  assert.throws(() => new HistoryProfileEngine({ retentionMs: 0 }), RangeError);
  assert.throws(() => new HistoryProfileEngine({ maxRecentSessions: 1.5 }), RangeError);
});

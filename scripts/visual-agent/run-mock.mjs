import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ALLOWED_ORIGIN, runVisualAttempt } from './adapter.mjs';
import { createMockPolicy } from './mock-policy.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export async function runMock() {
  const fixtureRoot = resolve(root, 'test/fixtures/visual-agent');
  const [screenshot, fixtureText] = await Promise.all([
    readFile(resolve(fixtureRoot, 'demo-screen.svg')),
    readFile(resolve(fixtureRoot, 'actions.json'), 'utf8'),
  ]);
  const steps = JSON.parse(fixtureText);
  let screenshotCount = 0;
  const clicks = [];
  const browser = Object.freeze({
    origin: ALLOWED_ORIGIN,
    async screenshot() {
      screenshotCount += 1;
      return { data: new Uint8Array(screenshot), mimeType: 'image/svg+xml', width: 640, height: 360 };
    },
    async click(x, y) { clicks.push({ x, y }); },
  });
  const attempt = await runVisualAttempt({
    browser,
    agent: createMockPolicy(steps),
    provenance: {
      execution_mode: 'SIMULATED',
      provider: 'mock',
      model: 'fixture-policy',
      model_version: '1',
      configuration: { fixture: 'actions.json' },
      prompt_template_version: 'visual-agent-v1',
      browser: 'mock-visual-port',
      cognit_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    },
    sessionId: 'mock-session-1',
    attemptId: 'mock-attempt-1',
  });
  return { attempt, evidence: { screenshot_count: screenshotCount, applied_clicks: clicks } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runMock(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runVisualAttempt } from './adapter.mjs';
import { createPlaywrightVisualPort } from './playwright-port.mjs';
import { createMockPolicy } from './mock-policy.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function waitForDemo(server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`could not start the local demo server (exit=${server.exitCode}, signal=${server.signalCode})`);
    try {
      const response = await fetch('http://127.0.0.1:4173/visual-agent-demo');
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('timed out waiting for local visual demo on port 4173');
}

export async function runBrowserMock() {
  const server = spawn(process.execPath, ['examples/browser/mock-server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: '4173' },
    stdio: 'ignore',
  });
  let browserPort;
  try {
    await waitForDemo(server);
    const { chromium } = await import('playwright');
    const controlled = await createPlaywrightVisualPort({ chromium });
    browserPort = controlled;
    const attempt = await runVisualAttempt({
      browser: controlled.port,
      agent: createMockPolicy([
        { action: { type: 'click', x: 237, y: 210 }, observation: 'A shape was selected.' },
        { action: { type: 'stop' }, observation: 'The visible result was captured; no ground truth was inferred.' },
      ]),
      provenance: {
        execution_mode: 'SIMULATED',
        provider: 'mock',
        model: 'fixed-coordinate-policy',
        model_version: '1',
        configuration: { fixture: 'visual action sequence' },
        prompt_template_version: 'visual-agent-v1',
        browser: `Chromium/${controlled.browserVersion} via Playwright`,
        cognit_commit: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      },
      sessionId: 'mock-browser-session-1',
      attemptId: 'mock-browser-attempt-1',
    });
    return { attempt, blocked_requests: controlled.blockedRequests };
  } finally {
    await browserPort?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
      server.kill('SIGTERM');
      await exited;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runBrowserMock(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

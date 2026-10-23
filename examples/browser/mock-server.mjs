import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const sessions = new Map();
const staticFiles = new Map([
  ['/', ['examples/browser/index.html', 'text/html; charset=utf-8']],
  ['/examples/browser/index.html', ['examples/browser/index.html', 'text/html; charset=utf-8']],
  ['/examples/browser/app.js', ['examples/browser/app.js', 'text/javascript; charset=utf-8']],
  ['/visual-agent-demo', ['examples/browser/visual-agent-demo.html', 'text/html; charset=utf-8']],
  ['/examples/browser/visual-agent-demo.js', ['examples/browser/visual-agent-demo.js', 'text/javascript; charset=utf-8']],
  ['/dist/client-sdk.js', ['dist/client-sdk.js', 'text/javascript; charset=utf-8']],
]);

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = staticFiles.get(url.pathname);
  if (request.method === 'GET' && file) {
    const filePath = resolve(root, file[0]);
    if (!filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { 'content-type': file[1] });
    response.end(await readFile(filePath));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    const session = { session_id: `mock-${sessions.size + 1}`, state: 'active' };
    sessions.set(session.session_id, { session, telemetry: null, result: null });
    json(response, 201, session);
    return;
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(challenge|telemetry|result|verify))?$/);
  const record = match && sessions.get(decodeURIComponent(match[1]));
  if (!record) {
    json(response, 404, { code: 'SESSION_NOT_FOUND', message: 'Mock session not found' });
    return;
  }
  switch (`${request.method} ${match[2] ?? ''}`) {
    case 'GET challenge':
      json(response, 200, { challenge_id: 'mock-challenge', question: 'Choose blue', choices: ['blue', 'red'] });
      return;
    case 'POST telemetry':
      record.telemetry = await readJson(request);
      json(response, 202, { accepted: true });
      return;
    case 'POST result':
      const submitted = await readJson(request);
      record.result = {
        result_id: `result-${record.session.session_id}`,
        accepted: submitted.answer === 'blue',
        state: submitted.answer === 'blue' ? 'succeeded' : 'failed',
      };
      json(response, 201, record.result);
      return;
    case 'GET result':
      json(response, 200, record.result ?? { state: 'pending' });
      return;
    case 'POST verify':
      json(response, 200, {
        session_id: record.session.session_id,
        state: record.session.state,
        attempt_state: record.result?.state ?? 'pending',
      });
      return;
    default:
      json(response, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported mock request' });
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => {
  console.log(`Cognit browser mock running at http://127.0.0.1:${port}`);
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

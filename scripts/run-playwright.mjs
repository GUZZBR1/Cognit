import { createServer } from "node:http";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixedChallenges } from "../src/fixed-challenges.js";
import { aggregateMouseAttempt } from "../src/mouse-telemetry.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
const SCHEMA_VERSION = 1;
const ALLOWED_FILES = new Set(["index.html", "styles.css", "src/app.js", "src/fixed-challenges.js", "src/mouse-telemetry.mjs", "src/human-dataset.js", "src/operational-metrics.js"]);

export function parseArgs(args) {
  const options = { output: "playwright-results.json", repeat: 1, duration: 100 };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!["--output", "--repeat", "--duration"].includes(name) || !args[index + 1]) throw new Error(`Unsupported or incomplete argument: ${name}`);
    const value = args[++index];
    if (name === "--output") options.output = value;
    if (name === "--repeat") options.repeat = Number(value);
    if (name === "--duration") options.duration = Number(value);
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 100) throw new Error("--repeat must be an integer from 1 to 100");
  if (![50, 100, 200, 500].includes(options.duration)) throw new Error("--duration must be one of 50, 100, 200, or 500");
  if (options.output.startsWith("-") || !options.output.trim()) throw new Error("--output must be a file path");
  return options;
}

export function buildRunDocument(sessionId, attempts, startedAt) {
  return { schema_version: SCHEMA_VERSION, session_id: sessionId, started_at: startedAt, source: "cognit-fixed-demo", evidence_class: "SIMULATED", human_consent: "NOT_ESTABLISHED", attempts };
}

export async function advanceToSetup(page) {
  // This automated UI action only unlocks the demo flow; it is not human consent.
  await page.locator("#consent").check();
  await page.locator("#begin-study").click();
  await page.locator("#setup-panel").waitFor({ state: "visible" });
}

export function isAllowedRequest(url, origin) {
  try { return new URL(url).origin === origin; }
  catch { return false; }
}

export function createDemoServer(root = ROOT) {
  const absoluteRoot = resolve(root);
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const relativePath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
      if (!ALLOWED_FILES.has(relativePath.slice(1))) return response.writeHead(404).end("Not found");
      const target = resolve(absoluteRoot, `.${relativePath}`);
      if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) return response.writeHead(403).end("Forbidden");
      if (target.split(sep).some((part) => [".git", ".omx", "node_modules"].includes(part))) return response.writeHead(404).end("Not found");
      const [rootReal, targetReal] = await Promise.all([realpath(absoluteRoot), realpath(target)]);
      if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) return response.writeHead(403).end("Forbidden");
      response.writeHead(200, { "content-type": MIME_TYPES[extname(targetReal)] ?? "application/octet-stream" });
      response.end(await readFile(targetReal));
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function run(options) {
  const server = createDemoServer();
  const origin = await listen(server);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => isAllowedRequest(route.request().url(), origin) ? route.continue() : route.abort("blockedbyclient"));
    await page.addInitScript(() => {
      window.__cognitMousePoints = [];
      window.addEventListener("mousemove", (event) => window.__cognitMousePoints.push({ x: event.clientX, y: event.clientY, t: performance.now() }), { passive: true });
    });
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await advanceToSetup(page);
    const sessionId = randomUUID();
    const attempts = [];
    for (let repeat = 0; repeat < options.repeat; repeat += 1) {
      for (let index = 0; index < fixedChallenges.length; index += 1) {
        const challenge = fixedChallenges[index];
        await page.locator("#challenge").selectOption(String(index));
        await page.locator("#duration").selectOption(String(options.duration));
        await page.evaluate(() => { window.__cognitMousePoints = []; });
        await page.locator("#start").click();
        await page.locator("#answer-form").waitFor({ state: "visible" });
        await page.locator("#answer").fill(challenge.expected_answer);
        await page.locator('#answer-form button[type="submit"]').click();
        const observed = JSON.parse(await page.locator("#result-json").textContent());
        const points = await page.evaluate(() => { const current = window.__cognitMousePoints; window.__cognitMousePoints = []; return current; });
        attempts.push({ session_id: sessionId, challenge_id: challenge.challenge_id, stimulus_id: challenge.stimulus_id, duration_ms: observed.duration_ms,
          mouse_telemetry: aggregateMouseAttempt(points),
          ground_truth: { type: "authored_answer", expected_answer: challenge.expected_answer }, observed_result: observed });
      }
    }
    const document = buildRunDocument(sessionId, attempts, new Date().toISOString());
    const outputPath = resolve(options.output);
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "w" });
    process.stdout.write(`Saved ${attempts.length} attempts to ${outputPath}\n`);
  } finally {
    await browser?.close();
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await run(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { aggregateMouseAttempt } from "../src/mouse-telemetry.mjs";
import { scenarios, makeResult, makeRunDocument, validateResult, startAppServer, stopProcess, browserFeatures } from "./shared.js";

const require = createRequire(import.meta.url);
const toolVersion = require("puppeteer/package.json").version;
const outputPath = process.argv[2] ?? "attack-lab/puppeteer-results.json";
const { server, url } = await startAppServer();
let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__cognitMousePoints = [];
    window.addEventListener("mousemove", (event) => window.__cognitMousePoints.push({ x: event.clientX, y: event.clientY, t: performance.now() }), { passive: true });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ url: `${url}/browser-automation-signals.js` });
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const browserVersion = userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? userAgent;
  const results = [];
  if (await page.$("#consent")) {
    await page.click("#consent");
    await page.waitForFunction(() => !document.querySelector("#begin-study").disabled);
    await page.click("#begin-study");
  }
  for (const [index, scenario] of scenarios.entries()) {
    await page.select("#challenge", String(index));
    await page.select("#duration", "50");
    const pointStart = await page.evaluate(() => window.__cognitMousePoints.length);
    await page.click("#start");
    await page.waitForFunction(() => !document.querySelector("#answer-form").hidden);
    await page.type("#answer", scenario.answer);
    await page.click('#answer-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector("#result-json").textContent.trim().length > 0);
    const appResult = await page.$eval("#result-json", (element) => JSON.parse(element.textContent));
    const points = await page.evaluate((start) => window.__cognitMousePoints.slice(start), pointStart);
    const features = await browserFeatures(() => page.evaluate(() => window.CognitAutomationSignals.collect(window)), "puppeteer");
    const record = makeResult({ tool: "puppeteer", toolVersion, browserVersion, scenario, appResult, mouseTelemetry: aggregateMouseAttempt(points), features });
    validateResult(record, scenario);
    results.push(record);
  }
  await writeFile(outputPath, `${JSON.stringify(makeRunDocument(results), null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outputPath, scenarios: results.length })}\n`);
} finally {
  try { if (browser) await browser.close(); }
  finally { await stopProcess(server); }
}

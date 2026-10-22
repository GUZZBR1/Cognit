import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { aggregateMouseAttempt } from "../src/mouse-telemetry.mjs";
import { scenarios, makeResult, makeRunDocument, validateResult, startAppServer, stopProcess, browserFeatures } from "./shared.js";

const require = createRequire(import.meta.url);
const toolVersion = require("selenium-webdriver/package.json").version;
const outputPath = process.argv[2] ?? "attack-lab/selenium-results.json";
const { server, url } = await startAppServer();
let driver;
try {
  const options = new chrome.Options();
  options.addArguments("--headless=new");
  if (process.env.CHROME_BIN) options.setChromeBinaryPath(process.env.CHROME_BIN);
  driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  await driver.get(url);
  const signalScript = await readFile(new URL("../browser-automation-signals.js", import.meta.url), "utf8");
  await driver.executeScript(signalScript);
  await driver.executeScript(`
    window.__cognitMousePoints = [];
    window.addEventListener("mousemove", (event) => window.__cognitMousePoints.push({ x: event.clientX, y: event.clientY, t: performance.now() }), { passive: true });
  `);
  const userAgent = await driver.executeScript("return navigator.userAgent");
  const browserVersion = userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? userAgent;
  const results = [];
  const consentElements = await driver.findElements(By.id("consent"));
  if (consentElements.length) {
    if (!(await consentElements[0].isSelected())) await consentElements[0].click();
    const begin = await driver.findElement(By.id("begin-study"));
    await driver.wait(until.elementIsEnabled(begin), 5000);
    await begin.click();
  }
  for (const [index, scenario] of scenarios.entries()) {
    const challenge = await driver.findElement(By.id("challenge"));
    await driver.executeScript("arguments[0].value=arguments[1]; arguments[0].dispatchEvent(new Event('change',{bubbles:true}))", challenge, String(index));
    await driver.executeScript("document.getElementById('duration').value='50'");
    const pointStart = await driver.executeScript("return window.__cognitMousePoints.length");
    await driver.findElement(By.id("start")).click();
    await driver.wait(async () => driver.findElement(By.id("answer-form")).then((element) => element.isDisplayed()), 5000);
    await driver.findElement(By.id("answer")).then((element) => element.sendKeys(scenario.answer));
    await driver.findElement(By.css('#answer-form button[type="submit"]')).click();
    await driver.wait(async () => driver.findElement(By.id("result-json")).then((element) => element.getText()).then((text) => text.length > 0), 5000);
    const appResult = JSON.parse(await driver.findElement(By.id("result-json")).then((element) => element.getText()));
    const points = await driver.executeScript("return window.__cognitMousePoints.slice(arguments[0])", pointStart);
    const features = await browserFeatures(() => driver.executeScript("return window.CognitAutomationSignals.collect(window)"), "selenium");
    const record = makeResult({ tool: "selenium-webdriver", toolVersion, browserVersion, scenario, appResult, mouseTelemetry: aggregateMouseAttempt(points), features });
    validateResult(record, scenario);
    results.push(record);
  }
  await writeFile(outputPath, `${JSON.stringify(makeRunDocument(results), null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outputPath, scenarios: results.length })}\n`);
} finally {
  try { if (driver) await driver.quit(); }
  finally { await stopProcess(server); }
}

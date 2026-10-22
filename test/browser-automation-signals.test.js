const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const { collect } = require("../browser-automation-signals.js");

function signal(result, id) {
  return result.signals.find((entry) => entry.id === id);
}

test("returns structured, cautious results for a normal-browser baseline", () => {
  const result = collect({
    navigator: {
      webdriver: false,
      userAgent: "Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36",
      plugins: [{ name: "PDF Viewer" }],
      languages: ["pt-BR", "en"],
    },
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.summary, "no_known_indicators_observed");
  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.every((entry) => typeof entry.limitation === "string" && entry.limitation.length > 0));
  assert.ok(result.limitations.some((limitation) => limitation.includes("do not establish")));
  assert.equal(signal(result, "navigator_webdriver").observed, false);
});

test("reports Playwright, Selenium/WebDriver, and Puppeteer markers separately", () => {
  const result = collect({
    navigator: { webdriver: true, userAgent: "HeadlessChrome" },
    __playwright__binding__: () => {},
    __webdriver_evaluate: () => {},
    __puppeteer_evaluation_script__: true,
    cdc_adoQpoasnfa76pfcZLmcfl_Array: Array,
  });

  assert.equal(signal(result, "navigator_webdriver").observed, true);
  assert.equal(signal(result, "playwright_globals").observed, true);
  assert.equal(signal(result, "selenium_globals").observed, true);
  assert.ok(signal(result, "selenium_globals").evidence.markers.includes("cdc_adoQpoasnfa76pfcZLmcfl_Array"));
  assert.equal(signal(result, "puppeteer_global").observed, true);
  assert.equal(signal(result, "headless_chromium_user_agent").observed, true);
  assert.equal(result.summary, "known_indicators_observed");
});

test("does not infer a human user from an environment with no known indicators", () => {
  const result = collect({ navigator: {} });

  assert.equal(result.summary, "no_known_indicators_observed");
  assert.ok(result.limitations.some((limitation) => limitation.includes("Missing indicators do not establish")));
});

test("exposes the collector as a browser global when loaded as a script", () => {
  const sandbox = { navigator: { webdriver: false } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../browser-automation-signals.js"), "utf8"), sandbox);

  assert.equal(typeof sandbox.CognitAutomationSignals.collect, "function");
  assert.equal(sandbox.CognitAutomationSignals.collect(sandbox).summary, "no_known_indicators_observed");
});

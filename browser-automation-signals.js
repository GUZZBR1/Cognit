(function attachAutomationSignals(root, buildApi) {
  const api = buildApi();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CognitAutomationSignals = api;
  }
})(typeof globalThis === "undefined" ? this : globalThis, function buildApi() {
  const markerGroups = [
    {
      id: "playwright_globals",
      target: "Playwright",
      names: ["__playwright__binding__", "__pwInitScripts"],
      strength: "medium",
      rationale: "A known Playwright initialization global is present.",
      limitation: "These globals are implementation details and may be absent, renamed, or created by page code.",
    },
    {
      id: "selenium_globals",
      target: "Selenium/WebDriver",
      names: [
        "__driver_evaluate",
        "__driver_unwrapped",
        "__fxdriver_evaluate",
        "__selenium_unwrapped",
        "__webdriver_evaluate",
        "__webdriver_script_fn",
        "_Selenium_IDE_Recorder",
      ],
      strength: "medium",
      rationale: "A known Selenium or WebDriver global is present.",
      limitation: "These globals are implementation details and may be absent, renamed, or created by page code.",
    },
    {
      id: "puppeteer_global",
      target: "Puppeteer",
      names: ["__puppeteer_evaluation_script__"],
      strength: "medium",
      rationale: "A known Puppeteer evaluation global is present.",
      limitation: "Puppeteer does not expose this marker in every configuration; page code can also define it.",
    },
  ];

  function collect(environment) {
    const env = environment || globalThis;
    const navigator = env.navigator || {};
    const propertyNames = Object.getOwnPropertyNames(env);
    const signals = [];

    const webdriverEnabled = navigator.webdriver === true;
    signals.push({
      id: "navigator_webdriver",
      target: "WebDriver",
      observed: webdriverEnabled,
      strength: "strong",
      evidence: {
        available: typeof navigator.webdriver === "boolean",
        matched: webdriverEnabled,
      },
      rationale: "navigator.webdriver is true when the browser reports WebDriver control.",
      limitation: "This flag can be disabled or altered, and legitimate testing tools may set it; it does not identify a person or prove malicious automation.",
    });

    for (const group of markerGroups) {
      const matched = group.names.filter((name) => name in env);
      if (group.id === "selenium_globals") {
        matched.push(...propertyNames.filter((name) => /^cdc_/i.test(name)));
      }

      signals.push({
        id: group.id,
        target: group.target,
        observed: matched.length > 0,
        strength: group.strength,
        evidence: { markers: [...new Set(matched)].sort() },
        rationale: group.rationale,
        limitation: group.limitation,
      });
    }

    const userAgent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
    signals.push({
      id: "headless_chromium_user_agent",
      target: "Other headless-browser indicator",
      observed: /HeadlessChrome/i.test(userAgent),
      strength: "medium",
      evidence: { matched: /HeadlessChrome/i.test(userAgent) },
      rationale: "The user agent contains the HeadlessChrome token.",
      limitation: "User agents can be changed, and headless use is not proof of automation intent.",
    });

    const pluginsEmpty = Array.isArray(navigator.plugins) && navigator.plugins.length === 0;
    signals.push({
      id: "empty_plugin_list",
      target: "Other browser-environment indicator",
      observed: pluginsEmpty,
      strength: "low",
      evidence: { matched: pluginsEmpty },
      rationale: "The browser exposes an empty navigator.plugins list.",
      limitation: "Privacy settings, browser version, and legitimate minimal environments can produce an empty list.",
    });

    const languagesEmpty = Array.isArray(navigator.languages) && navigator.languages.length === 0;
    signals.push({
      id: "empty_languages_list",
      target: "Other browser-environment indicator",
      observed: languagesEmpty,
      strength: "low",
      evidence: { matched: languagesEmpty },
      rationale: "The browser exposes an empty navigator.languages list.",
      limitation: "Locale configuration, privacy settings, or browser differences can produce an empty list.",
    });

    const observedCount = signals.filter((signal) => signal.observed).length;
    return {
      schemaVersion: 1,
      summary: observedCount > 0 ? "known_indicators_observed" : "no_known_indicators_observed",
      signals,
      limitations: [
        "These are experimental heuristics. Missing indicators do not establish that a browser is human-operated.",
        "No individual indicator, or combination returned here, proves automation or malicious intent.",
        "Indicators may change between browser versions and can produce false positives or false negatives.",
      ],
    };
  }

  return { collect };
});

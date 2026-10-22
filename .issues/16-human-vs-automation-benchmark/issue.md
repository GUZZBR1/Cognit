# Human vs Automation Benchmark

## Description
Measure observed differences between identified Human, Playwright, Selenium, and Puppeteer sessions. Compare reaction time, accuracy, mouse features, completion time, browser signals, and challenge performance. Generate a reproducible report and include only groups with identified data.

## Acceptance criteria
- The report includes protocol, available tool/browser versions, sample size by group, and uncertainty.
- Human false-positive rate and other available metrics are calculated with explicit denominators.
- Groups without eligible identified data are marked unavailable without inferred results.

## Scope constraints
Do not claim a feature universally separates humans from automation. Do not define production policy.

## Completion criteria
- Deterministic JSON report generator consumes existing HumanDataset and browser-runner exports.
- Human records require explicit independent confirmation and provenance.
- Missing groups, timings, signals, and predictions stay unavailable.
- Targeted and repository test suites pass; final commit is pushed to the issue branch.

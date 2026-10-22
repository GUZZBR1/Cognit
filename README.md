# Cognit

Cognit is a human-presence verification product library. This repository contains the runtime building blocks for challenges, session and journey state, behavioral signals, risk and policy evaluation, browser integration, and signed verification tokens.

## Product components

- `src/cognit/client-sdk.js` is the browser client for a host application's verification service.
- `src/fixed-challenges.js`, `src/seeded-generator.js`, `challenge_generator.py`, and `challenge_mutations.mjs` provide fixed and reproducible challenge generation.
- `src/reaction-time-collector.mjs` and `src/mouse-telemetry.mjs` collect attempt timing and return derived mouse features without retaining raw trajectories.
- `browser-automation-signals.js` reports heuristic browser signals. An individual signal is not proof of automation, and an empty result does not prove human presence.
- `src/cognit/session-engine.ts` and `journey_tracker.py` provide session state and an event timeline.
- `risk_score.py` combines available evidence into an advisory score. `decision_policy.py` maps it to configured `ALLOW`, `CHALLENGE`, `RESTRICT`, `BLOCK`, or `UNKNOWN` outcomes.
- `verification_token.py` issues and validates server-side, action-bound, expiring, one-use signed tokens.
- `docs/api/verification-v0.yaml` defines the application-facing verification API contract.

Keep signing secrets and final policy decisions on the server. Supply token claims and expected bindings from trusted server-side context. Treat risk scores and browser signals as uncertain evidence; they do not establish identity or intent. Use `UNKNOWN` when evidence is missing or insufficient.

This repository provides product components and an API contract; it does not include a hosted verification service. Applications must connect the SDK to their own authenticated server implementation.

## Experimental lab

This branch preserves the test suite and research tools excluded from `main`: controlled Playwright, Selenium, and Puppeteer runners; the human dataset pilot; AI Observer and classifier experiments; feature and session-signature prototypes; and benchmark/evaluation scripts. Browser attack runners are restricted to the local Cognit demo.

Install this branch's development dependencies with `npm install`. Run the suites with `npm test` and `npm run test:python`. The controlled browser runners are available as `npm run run:playwright`, `npm run attack-lab:selenium`, and `npm run attack-lab:puppeteer`.

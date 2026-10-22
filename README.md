# Cognit — Visual challenge

A small, client-only perception challenge. Choose an authored pattern and display duration, study it, then answer after it disappears. The result is shown on screen and can be downloaded as JSON.

## Run

Serve this directory with any static HTTP server and open its `index.html`. For example, with Python installed:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. The app uses native browser modules and has no install step or external dependencies. Run the focused logic tests with Node 22 or newer:

```sh
node --test
```

## Result contract

Each completed attempt produces one JSON object:

```json
{
  "challenge_id": "color-count-01",
  "stimulus_id": "grid-blue-01",
  "duration_ms": 100,
  "response": "3",
  "correct": true,
  "reaction_time_ms": 843
}
```

`duration_ms` is the selected exposure duration. `reaction_time_ms` is measured with the browser's monotonic `performance.now()` clock from when the answer prompt becomes available until submission. Browser timers can drift, so this is a lightweight demonstration and not a lab-precision measurement.

Fixed challenges and expected answers are authored in `src/fixed-challenges.js`. The deterministic seed-based generator is an independent API in `src/seeded-generator.js`; the fixed runner does not call it. It is included as a separate foundation only. There is no adaptive generation, person classification, or production threshold.

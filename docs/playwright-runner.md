# Fixed demo Playwright runner

Install dependencies and the Chromium browser once:

```sh
npm install
npx playwright install chromium
```

Run one pass across the authored fixed challenges:

```sh
npm run run:playwright -- --output results.json
```

`--repeat N` repeats the fixed challenge set (1–100); `--duration MS` selects 50, 100, 200, or 500 ms. The runner has no URL option. It starts a temporary static server from this repository on `127.0.0.1`, uses an ephemeral port, serves only the demo's five required local files, blocks browser requests outside that exact origin, and closes both browser and server when done.

The output is a JSON object with `schema_version: 1`, a unique suite `session_id`, and one attempt entry per challenge execution. Every attempt repeats the suite `session_id` and associates authored challenge/stimulus identifiers, aggregate-only mouse telemetry, the fixed challenge's authored expected answer, and the result displayed by the demo. Raw mouse points are held only in page memory during an attempt and are never written to the output file.

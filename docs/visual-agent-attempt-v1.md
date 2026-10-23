# Visual Agent Attempt Record v1

The adapter exports one minimized JSON record per run. Screenshots and raw browser state are never included.

```json
{
  "schema_version": 1,
  "session_id": "session-id",
  "attempt_id": "attempt-id",
  "started_at": "2026-10-23T00:00:00.000Z",
  "completed_at": "2026-10-23T00:00:01.000Z",
  "execution_mode": "SIMULATED",
  "result": "UNKNOWN",
  "observed_result": "Visible text or agent observation, if supplied.",
  "actions": [{ "type": "click", "x": 237, "y": 210 }],
  "failure": null,
  "provenance": {
    "execution_mode": "SIMULATED",
    "provider": "mock",
    "model": "fixed-coordinate-policy",
    "model_version": "1",
    "configuration": { "fixture": "visual action sequence" },
    "prompt_template_version": "visual-agent-v1",
    "browser": "Chromium/156.0.8078.4 via Playwright",
    "cognit_commit": "commit-sha"
  }
}
```

`result` is always `UNKNOWN`; an agent's visible observation does not establish challenge ground truth. A thrown error or explicit refusal is recorded in `failure` and leaves that result unchanged. `SIMULATED` identifies fixture/mock execution. `MEASURED_LAB` is reserved for a real model run with complete provenance and does not imply general validity. Sensitive configuration keys are redacted before export.

The agent input contains only PNG screenshot bytes and viewport width/height. Its actions are a bounded click coordinate or stop. The Playwright port allows only the local visual demo document and its static script; all other URLs, including internal API paths, are aborted before the browser follows them.

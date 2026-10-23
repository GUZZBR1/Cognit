# Python session signatures v0

`session_signature.py` mirrors the experimental `src/session-signature.mjs`
contract: deterministic schema version 0, allowlisted minimized aggregates,
and mean symmetric relative difference over jointly available dimensions.
Missing or invalid values remain unavailable; no values are inferred. History
features are included only when supplied explicitly under `history`.

From the repository root, run `python -m scripts.report_session_signatures` to
compare the synthetic fixture sessions. This is feature similarity only: it
does not classify, establish identity, provide a service, or persist data. The
builder has no persistence behavior.

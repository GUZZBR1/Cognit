# Cognit

## Server-side decision policy

`decision_policy.py` maps a numeric risk score and confidence to a decision
using a caller-supplied policy. It does not set production thresholds or make
claims about identity or intent. A policy consists of ordered `PolicyRule`
score bands (both ends inclusive), a minimum confidence, and optional signal
keys that must be present. The first matching rule wins. Configure any desired
bands for `ALLOW`, `CHALLENGE`, `RESTRICT`, `BLOCK`, or `UNKNOWN`; unmatched or
insufficient evidence returns `UNKNOWN`.

```python
from decision_policy import DecisionOutcome, DecisionPolicy, PolicyRule, decide

policy = DecisionPolicy(
    rules=(
        PolicyRule(DecisionOutcome.ALLOW, 0, 24),
        PolicyRule(DecisionOutcome.CHALLENGE, 25, 49),
        PolicyRule(DecisionOutcome.RESTRICT, 50, 74),
        PolicyRule(DecisionOutcome.BLOCK, 75, 100),
    ),
    minimum_confidence=0.8,
    required_signals=("session_age", "device_consistency"),
)
result = decide(
    score=32,
    confidence=0.92,
    signals={"session_age": 0.4, "device_consistency": 0.8},
    policy=policy,
)
```

Scores must be finite numbers from 0 through 100; confidence must be finite
from 0 through 1. Missing/invalid inputs, confidence below the configured
minimum, missing required signals, and unmatched bands return `UNKNOWN` with a
machine-readable reason. Invalid policy configurations raise `ValueError`.
Signal values are opaque to this engine: rules currently test signal presence,
not identity, intent, or signal meaning. Run the standard-library tests with
`python3 -m unittest -v`.

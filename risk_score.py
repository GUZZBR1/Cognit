"""Fixture-friendly, advisory risk aggregation.

Each optional group (perception, timing, mouse, browser, journey, traps) accepts
one mapping or an iterable of mappings. A valid evidence mapping has ``risk``
and ``confidence`` numbers normalized to [0, 1]. Invalid entries are ignored.

For each group, risk and confidence are arithmetic means of its valid items.
Across groups, the score is the confidence-weighted mean group risk, scaled to
0–100 and rounded to an integer. Overall confidence is the mean group
confidence multiplied by min(1, valid_group_count / 3), reflecting breadth.
At least two valid independent groups and confidence >= 0.5 are required for
a ``scored`` result. Otherwise the result is ``inconclusive`` with score zero.
This function reports evidence only; it does not classify people or decide
whether to allow, challenge, or block anyone.
"""

from collections.abc import Iterable, Mapping
from typing import Any

SIGNAL_GROUPS = ("perception", "timing", "mouse", "browser", "journey", "traps")
MIN_GROUPS = 2
MIN_CONFIDENCE = 0.5


def _items(value: Any) -> Iterable[Any]:
    if isinstance(value, Mapping):
        return (value,)
    if isinstance(value, (str, bytes)) or value is None:
        return ()
    try:
        return iter(value)
    except TypeError:
        return ()


def _normalized_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not 0.0 <= number <= 1.0:
        return None
    return number


def score_risk(
    *,
    perception: Any = None,
    timing: Any = None,
    mouse: Any = None,
    browser: Any = None,
    journey: Any = None,
    traps: Any = None,
) -> dict[str, Any]:
    """Return a deterministic risk summary for any supplied signal fixtures."""
    supplied = locals()
    group_values: list[tuple[float, float]] = []
    used: list[str] = []

    for group in SIGNAL_GROUPS:
        observations = []
        for item in _items(supplied[group]):
            if not isinstance(item, Mapping):
                continue
            risk = _normalized_number(item.get("risk"))
            confidence = _normalized_number(item.get("confidence"))
            if risk is not None and confidence is not None:
                observations.append((risk, confidence))
        if observations:
            used.append(group)
            group_values.append((
                sum(risk for risk, _ in observations) / len(observations),
                sum(confidence for _, confidence in observations) / len(observations),
            ))

    missing = [group for group in SIGNAL_GROUPS if group not in used]
    result: dict[str, Any] = {
        "risk_score": 0,
        "confidence": 0.0,
        "state": "inconclusive",
        "used_signals": used,
        "missing_signals": missing,
    }
    if len(group_values) < MIN_GROUPS:
        return result

    confidence_sum = sum(confidence for _, confidence in group_values)
    confidence = confidence_sum / len(group_values) * min(1.0, len(group_values) / 3)
    if confidence < MIN_CONFIDENCE or confidence_sum == 0:
        result["confidence"] = round(confidence, 4)
        return result

    risk = sum(risk * group_confidence for risk, group_confidence in group_values) / confidence_sum
    result.update(risk_score=round(risk * 100), confidence=round(confidence, 4), state="scored")
    return result

"""Configurable server-side policy for converting risk assessments to decisions.

The module contains no production thresholds. Callers supply a policy and the
assessment data; incomplete, invalid, or unmatched data produces UNKNOWN.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from collections.abc import Mapping
from typing import Any


class DecisionOutcome(str, Enum):
    ALLOW = "ALLOW"
    CHALLENGE = "CHALLENGE"
    RESTRICT = "RESTRICT"
    BLOCK = "BLOCK"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class PolicyRule:
    """An inclusive score band that returns an outcome when it matches."""

    outcome: DecisionOutcome
    min_score: float
    max_score: float

    def __post_init__(self) -> None:
        if not isinstance(self.outcome, DecisionOutcome):
            raise ValueError("outcome must be a DecisionOutcome")
        _validate_number(self.min_score, "min_score", 0, 100)
        _validate_number(self.max_score, "max_score", 0, 100)
        if self.min_score > self.max_score:
            raise ValueError("min_score must be less than or equal to max_score")


@dataclass(frozen=True)
class DecisionPolicy:
    """Explicit policy configuration, evaluated in rule order."""

    rules: tuple[PolicyRule, ...]
    minimum_confidence: float
    required_signals: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.rules, tuple) or any(
            not isinstance(rule, PolicyRule) for rule in self.rules
        ):
            raise ValueError("rules must be a tuple of PolicyRule values")
        _validate_number(self.minimum_confidence, "minimum_confidence", 0, 1)
        if not isinstance(self.required_signals, tuple) or any(
            not isinstance(signal, str) or not signal.strip()
            for signal in self.required_signals
        ):
            raise ValueError("required_signals must be a tuple of non-empty strings")
        if len(set(self.required_signals)) != len(self.required_signals):
            raise ValueError("required_signals must not contain duplicates")


@dataclass(frozen=True)
class Decision:
    outcome: DecisionOutcome
    reason: str


def decide(
    score: float | int | None,
    confidence: float | int | None,
    signals: Mapping[str, Any] | None,
    policy: DecisionPolicy,
) -> Decision:
    """Return a policy outcome; unusable or insufficient evidence is UNKNOWN."""

    if not isinstance(policy, DecisionPolicy):
        raise ValueError("policy must be a DecisionPolicy")
    if not _is_number_in_range(score, 0, 100):
        return Decision(DecisionOutcome.UNKNOWN, "missing_or_invalid_score")
    if not _is_number_in_range(confidence, 0, 1):
        return Decision(DecisionOutcome.UNKNOWN, "missing_or_invalid_confidence")
    if confidence < policy.minimum_confidence:
        return Decision(DecisionOutcome.UNKNOWN, "insufficient_confidence")
    if not isinstance(signals, Mapping):
        return Decision(DecisionOutcome.UNKNOWN, "missing_signals")
    if any(
        signal not in signals or signals[signal] is None
        for signal in policy.required_signals
    ):
        return Decision(DecisionOutcome.UNKNOWN, "insufficient_signals")

    for rule in policy.rules:
        if rule.min_score <= score <= rule.max_score:
            return Decision(rule.outcome, "policy_rule_matched")
    return Decision(DecisionOutcome.UNKNOWN, "no_policy_rule_matched")


def _is_number_in_range(value: object, minimum: float, maximum: float) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and minimum <= value <= maximum
    except OverflowError:
        return False


def _validate_number(value: object, name: str, minimum: float, maximum: float) -> None:
    if not _is_number_in_range(value, minimum, maximum):
        raise ValueError(f"{name} must be a finite number from {minimum} to {maximum}")

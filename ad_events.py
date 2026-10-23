"""Minimal, versioned ad event records linked to a verification result.

Ad events carry only an opaque result reference and a small confidence summary.
They intentionally do not contain a session ID, telemetry, or policy inputs.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from enum import Enum
import math


class AdEventType(str, Enum):
    IMPRESSION = "impression"
    INTERACTION = "interaction"


@dataclass(frozen=True)
class AdEvent:
    """One ad impression or interaction linked to an existing result."""

    event_id: str
    event_type: AdEventType
    ad_id: str
    occurred_at: str
    verification_result_id: str
    verification_result_origin: str
    decision_version: str
    confidence: float
    confidence_origin: str
    risk_score: float | None = None

    def __post_init__(self) -> None:
        try:
            event_type = AdEventType(self.event_type)
        except (TypeError, ValueError) as error:
            raise ValueError("event_type must be impression or interaction") from error
        object.__setattr__(self, "event_type", event_type)

        for name in (
            "event_id", "ad_id", "verification_result_id", "verification_result_origin",
            "decision_version", "confidence_origin",
        ):
            _require_text(getattr(self, name), name)

        if not isinstance(self.occurred_at, str):
            raise TypeError("occurred_at must be an ISO 8601 timestamp")
        try:
            timestamp = datetime.fromisoformat(self.occurred_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("occurred_at must be an ISO 8601 timestamp") from error
        if timestamp.tzinfo is None or timestamp.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")

        _require_number(self.confidence, "confidence", 0, 1)
        if self.risk_score is not None:
            _require_number(self.risk_score, "risk_score", 0, 100)

    def to_dict(self) -> dict[str, str | float | None]:
        """Return the allowlisted event fields in a JSON-friendly mapping."""
        event = asdict(self)
        event["event_type"] = self.event_type.value
        if self.risk_score is None:
            del event["risk_score"]
        return event


def _require_text(value: object, name: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError(f"{name} must be a non-empty string of at most 256 characters")


def _require_number(value: object, name: str, minimum: float, maximum: float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number from {minimum} to {maximum}")
    try:
        valid = math.isfinite(value) and minimum <= value <= maximum
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{name} must be a finite number from {minimum} to {maximum}")

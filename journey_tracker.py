"""In-memory, per-session timeline for allowed journey events."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum


class JourneyEventType(StrEnum):
    """Event categories accepted by the journey tracker."""

    NAVIGATION = "navigation"
    ACTION = "action"
    CHALLENGE = "challenge"
    ATTEMPT = "attempt"
    RETRY = "retry"


class MissingSessionError(ValueError):
    """Raised when an event is emitted without a session reference."""


class InvalidEventTypeError(ValueError):
    """Raised when an event category is not allowlisted."""


class InvalidTimestampError(ValueError):
    """Raised when a timestamp is not a timezone-aware datetime."""


@dataclass(frozen=True, slots=True)
class JourneyEvent:
    """An immutable event with its session reference and UTC timestamp."""

    session_id: str
    event_type: JourneyEventType
    timestamp: datetime
    sequence: int


class JourneyTracker:
    """Collect a caller-scoped session timeline without managing its lifecycle."""

    def __init__(self, session_id: str) -> None:
        if not isinstance(session_id, str) or not session_id.strip():
            raise MissingSessionError("session_id must be a non-empty string")
        self._session_id = session_id
        self._events: list[JourneyEvent] = []

    def emit(
        self,
        event_type: JourneyEventType | str,
        *,
        timestamp: datetime | None = None,
    ) -> JourneyEvent:
        """Append an allowed event, normalizing its timestamp to UTC."""
        try:
            typed_event = JourneyEventType(event_type)
        except (ValueError, TypeError) as error:
            raise InvalidEventTypeError(f"unsupported event type: {event_type!r}") from error

        occurred_at = timestamp if timestamp is not None else datetime.now(UTC)
        if not isinstance(occurred_at, datetime) or occurred_at.tzinfo is None:
            raise InvalidTimestampError("timestamp must be a timezone-aware datetime")

        event = JourneyEvent(
            session_id=self._session_id,
            event_type=typed_event,
            timestamp=occurred_at.astimezone(UTC),
            sequence=len(self._events),
        )
        self._events.append(event)
        return event

    def timeline(self) -> tuple[JourneyEvent, ...]:
        """Return events by occurrence time, preserving emission order on ties."""
        return tuple(sorted(self._events, key=lambda event: (event.timestamp, event.sequence)))

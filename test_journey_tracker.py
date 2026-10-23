import unittest
from datetime import UTC, datetime, timedelta, timezone

from journey_tracker import (
    InvalidEventTypeError,
    InvalidTimestampError,
    JourneyEventType,
    JourneyTracker,
    MissingSessionError,
)


class JourneyTrackerTests(unittest.TestCase):
    def test_emits_each_allowed_event_with_session_and_utc_timestamp(self):
        tracker = JourneyTracker("session-123")
        expected_types = tuple(JourneyEventType)

        events = [tracker.emit(event_type) for event_type in expected_types]

        self.assertEqual(tuple(event.event_type for event in events), expected_types)
        self.assertTrue(all(event.session_id == "session-123" for event in events))
        self.assertTrue(all(event.timestamp.tzinfo == UTC for event in events))

    def test_timeline_orders_by_timestamp_and_preserves_emission_order_on_ties(self):
        tracker = JourneyTracker("session-123")
        later = datetime(2026, 1, 1, 12, tzinfo=UTC)
        earlier = later - timedelta(seconds=1)

        first = tracker.emit("action", timestamp=later)
        second = tracker.emit("retry", timestamp=earlier)
        third = tracker.emit("attempt", timestamp=later)

        self.assertEqual(tracker.timeline(), (second, first, third))

    def test_normalizes_aware_timestamps_to_utc(self):
        tracker = JourneyTracker("session-123")
        local = datetime(2026, 1, 1, 12, tzinfo=timezone(timedelta(hours=-3)))

        event = tracker.emit("navigation", timestamp=local)

        self.assertEqual(event.timestamp, datetime(2026, 1, 1, 15, tzinfo=UTC))

    def test_rejects_missing_session(self):
        for session_id in (None, "", "   "):
            with self.subTest(session_id=session_id):
                with self.assertRaises(MissingSessionError):
                    JourneyTracker(session_id)  # type: ignore[arg-type]

    def test_rejects_unknown_event_type_without_recording_it(self):
        tracker = JourneyTracker("session-123")

        with self.assertRaises(InvalidEventTypeError):
            tracker.emit("typed-content")

        self.assertEqual(tracker.timeline(), ())

    def test_rejects_naive_or_non_datetime_timestamp_without_recording(self):
        tracker = JourneyTracker("session-123")

        for timestamp in (datetime(2026, 1, 1), "2026-01-01T00:00:00Z"):
            with self.subTest(timestamp=timestamp):
                with self.assertRaises(InvalidTimestampError):
                    tracker.emit("action", timestamp=timestamp)  # type: ignore[arg-type]

        self.assertEqual(tracker.timeline(), ())

    def test_timeline_is_immutable_snapshot(self):
        tracker = JourneyTracker("session-123")
        snapshot = tracker.timeline()
        tracker.emit("challenge")

        self.assertEqual(snapshot, ())
        self.assertEqual(len(tracker.timeline()), 1)


if __name__ == "__main__":
    unittest.main()

import unittest

from ad_events import AdEvent, AdEventType


class AdEventTests(unittest.TestCase):
    def make_event(self, **overrides):
        values = {
            "event_id": "event-1",
            "event_type": AdEventType.IMPRESSION,
            "ad_id": "ad-1",
            "occurred_at": "2026-10-22T12:00:00Z",
            "verification_result_id": "result-opaque-1",
            "verification_result_origin": "cognit.verification.v1",
            "decision_version": "policy-v2",
            "confidence": 0.82,
            "confidence_origin": "risk_score.score_risk.v1",
        }
        values.update(overrides)
        return AdEvent(**values)

    def test_impression_and_interaction_are_distinct_and_link_to_same_result(self):
        impression = self.make_event()
        interaction = self.make_event(
            event_id="event-2", event_type="interaction", occurred_at="2026-10-22T12:00:03Z"
        )

        self.assertEqual(impression.to_dict()["event_type"], "impression")
        self.assertEqual(interaction.to_dict()["event_type"], "interaction")
        self.assertEqual(impression.verification_result_id, interaction.verification_result_id)
        self.assertEqual(impression.verification_result_origin, "cognit.verification.v1")
        self.assertEqual(impression.decision_version, interaction.decision_version)
        self.assertEqual(impression.confidence, interaction.confidence)

    def test_optional_risk_score_is_bounded(self):
        self.assertEqual(self.make_event(risk_score=34).to_dict()["risk_score"], 34)
        with self.assertRaisesRegex(ValueError, "risk_score"):
            self.make_event(risk_score=101)
        self.assertNotIn("risk_score", self.make_event().to_dict())

    def test_requires_timezone_and_confidence_provenance(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            self.make_event(occurred_at="2026-10-22T12:00:00")
        with self.assertRaisesRegex(ValueError, "confidence_origin"):
            self.make_event(confidence_origin=" ")
        with self.assertRaisesRegex(ValueError, "verification_result_origin"):
            self.make_event(verification_result_origin=" ")

    def test_rejects_invalid_type_confidence_and_unbounded_values(self):
        with self.assertRaisesRegex(ValueError, "event_type"):
            self.make_event(event_type="view")
        with self.assertRaisesRegex(ValueError, "confidence"):
            self.make_event(confidence=1.01)
        with self.assertRaisesRegex(ValueError, "confidence"):
            self.make_event(confidence=float("nan"))

    def test_serialized_contract_contains_no_session_or_raw_telemetry_fields(self):
        record = self.make_event().to_dict()
        self.assertEqual(
            set(record),
            {
                "event_id", "event_type", "ad_id", "occurred_at",
                "verification_result_id", "verification_result_origin", "decision_version",
                "confidence", "confidence_origin",
            },
        )
        with self.assertRaises(TypeError):
            self.make_event(session_id="session-1")
        with self.assertRaises(TypeError):
            self.make_event(mouse_telemetry={"x": [1, 2]})


if __name__ == "__main__":
    unittest.main()

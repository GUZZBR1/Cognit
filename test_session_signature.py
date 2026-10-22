import json
import unittest
from pathlib import Path

from session_signature import (
    SESSION_SIGNATURE_SCHEMA_VERSION,
    build_session_signature,
    compare_session_signatures,
)


class SessionSignatureTests(unittest.TestCase):
    def test_fixture_signatures_are_deterministic_and_versioned(self):
        fixture = json.loads((Path(__file__).parent / "test/fixtures/session-signatures-v0.json").read_text())
        self.assertEqual(fixture["schemaVersion"], SESSION_SIGNATURE_SCHEMA_VERSION)
        signatures = [build_session_signature(item) for item in fixture["sessions"]]
        self.assertEqual(signatures, [build_session_signature(item) for item in fixture["sessions"]])
        self.assertEqual(signatures[0]["schemaVersion"], 0)
        self.assertEqual(signatures[0]["features"]["perception.correct"], 1)

    def test_absent_fields_stay_unavailable_and_history_is_opt_in(self):
        signature = build_session_signature({"journey": {"sessionCount": 4}})
        self.assertEqual(signature["features"], {"journey.sessionCount": 4})
        self.assertEqual(signature["unavailable"]["history"], [
            "history.sessionCount", "history.succeededCount", "history.failedCount"
        ])
        explicit = build_session_signature({"history": {"sessionCount": 2, "succeededCount": 1, "failedCount": 1}})
        self.assertEqual(explicit["features"]["history.sessionCount"], 2)

    def test_invalid_input_values_are_unavailable(self):
        signature = build_session_signature({
            "perception": {"correct": 1, "duration_ms": -1},
            "behavior": {"features": {"pauseCount": 1.5, "meanSpeedPxPerMs": 0.2}},
        })
        self.assertEqual(signature["features"], {"behavior.meanSpeedPxPerMs": 0.2})
        self.assertIn("perception.correct", signature["unavailable"]["perception"])
        self.assertIn("behavior.pauseCount", signature["unavailable"]["behavior"])
        with self.assertRaisesRegex(TypeError, "session_must_be_an_object"):
            build_session_signature(None)

    def test_comparison_uses_common_features_and_relative_difference(self):
        left = build_session_signature({"perception": {"duration_ms": 100}, "timing": {"reactionTimeMs": 50}})
        right = build_session_signature({"perception": {"duration_ms": 200}})
        result = compare_session_signatures(left, right)
        self.assertEqual(result["method"], "mean-symmetric-relative-difference-v0")
        self.assertEqual(result["distance"], 0.5)
        self.assertEqual(result["commonFeatures"], ["perception.duration_ms"])
        self.assertEqual(result["commonFeatureCount"], 1)
        self.assertEqual(result["unionFeatureCount"], 2)
        self.assertEqual(result["coverage"], 0.5)
        no_overlap = compare_session_signatures(build_session_signature({}), build_session_signature({}))
        self.assertIsNone(no_overlap["distance"])
        self.assertEqual(no_overlap["coverage"], 0)

    def test_comparison_rejects_bad_versions_keys_and_values(self):
        valid = build_session_signature({"perception": {"duration_ms": 100}})
        with self.assertRaisesRegex(TypeError, "incompatible_signature_schema_version"):
            compare_session_signatures({**valid, "schemaVersion": 1}, valid)
        with self.assertRaisesRegex(TypeError, "unsupported_signature_feature"):
            compare_session_signatures(valid, {"schemaVersion": 0, "features": {"perception.unknown": 1}})
        with self.assertRaisesRegex(TypeError, "invalid_signature_feature"):
            compare_session_signatures(valid, {"schemaVersion": 0, "features": {"perception.duration_ms": -1}})


if __name__ == "__main__":
    unittest.main()

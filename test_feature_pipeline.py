import json
import subprocess
import sys
import unittest
from pathlib import Path

from feature_pipeline import FEATURE_NAMES, build_mouse_feature_record

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "test" / "fixtures" / "mouse-attempt-v1.json"


class FeaturePipelineTests(unittest.TestCase):
    def setUp(self):
        self.input_record = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_fixture_known_values_and_determinism(self):
        first = build_mouse_feature_record(self.input_record)
        second = build_mouse_feature_record(self.input_record)
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "complete")
        self.assertEqual(first["features"]["distancePx"], 5)
        self.assertEqual(first["features"]["durationMs"], 16)
        self.assertEqual(first["features"]["meanSpeedPxPerMs"], 5 / 16)
        self.assertEqual(first["features"]["maxSpeedPxPerMs"], 5 / 16)
        self.assertEqual(first["features"]["meanAccelerationPxPerMs2"], None)
        self.assertEqual(first["features"]["trajectoryEntropyBits"], 0)

    def test_schema_and_provenance(self):
        record = build_mouse_feature_record(self.input_record)
        self.assertEqual(record["schemaVersion"], 1)
        self.assertEqual(record["pipelineVersion"], 1)
        self.assertEqual(record["provenance"]["source"], "mouse-telemetry")
        self.assertEqual(record["provenance"]["transformation"]["parameters"]["pauseThresholdMs"], 100)
        self.assertEqual(record["unavailableFeatures"], ["meanAccelerationPxPerMs2", "meanAbsoluteAccelerationPxPerMs2"])

    def test_missing_fields_are_explicit(self):
        record = build_mouse_feature_record({"schemaVersion": 1, "points": [{"x": 1, "t": 1}]})
        self.assertEqual(record["status"], "incomplete")
        self.assertEqual(record["issues"], ["missing_input_fields"])
        self.assertEqual(record["missingInputFields"], ["points[0].y"])
        self.assertIsNone(record["features"])
        self.assertEqual(record["unavailableFeatures"], list(FEATURE_NAMES))

    def test_invalid_timestamps_and_threshold_are_reported(self):
        points = [{"x": 0, "y": 0, "t": 5}, {"x": 1, "y": 1, "t": 5}]
        record = build_mouse_feature_record({"schemaVersion": 1, "points": points})
        self.assertEqual(record["status"], "invalid")
        self.assertEqual(record["issues"], ["non_monotonic_timestamp"])
        invalid_threshold = build_mouse_feature_record(self.input_record, {"pauseThresholdMs": -1})
        self.assertEqual(invalid_threshold["issues"], ["invalid_pause_threshold"])

    def test_non_finite_threshold_stays_serializable_and_explicitly_invalid(self):
        record = build_mouse_feature_record(self.input_record, {"pauseThresholdMs": float("nan")})
        self.assertEqual(record["status"], "invalid")
        self.assertEqual(record["issues"], ["invalid_pause_threshold"])
        self.assertIsNone(record["provenance"]["transformation"]["parameters"]["pauseThresholdMs"])
        json.dumps(record, allow_nan=False)

    def test_pause_and_direction_feature_values(self):
        attempt = {"schemaVersion": 1, "points": [
            {"x": 0, "y": 0, "t": 0}, {"x": 0, "y": 0, "t": 120},
            {"x": 1, "y": 0, "t": 130}, {"x": 1, "y": 1, "t": 140},
        ]}
        features = build_mouse_feature_record(attempt)["features"]
        self.assertEqual(features["pauseCount"], 1)
        self.assertEqual(features["pauseDurationMs"], 120)
        self.assertEqual(features["directionChanges"], 1)
        self.assertEqual(features["trajectoryEntropyBits"], 1)

    def test_output_does_not_include_raw_trajectory(self):
        serialized = json.dumps(build_mouse_feature_record(self.input_record))
        self.assertNotIn('"points"', serialized)
        self.assertNotIn('"x"', serialized)
        self.assertNotIn('"y"', serialized)
        self.assertNotIn('"t"', serialized)

    def test_cli_reads_json_and_emits_only_record(self):
        completed = subprocess.run(
            [sys.executable, str(ROOT / "feature_pipeline.py"), str(FIXTURE)],
            check=True, capture_output=True, text=True,
        )
        output = json.loads(completed.stdout)
        self.assertEqual(output, build_mouse_feature_record(self.input_record))
        self.assertEqual(completed.stderr, "")

    def test_bad_envelopes_raise_type_error(self):
        with self.assertRaisesRegex(TypeError, "unsupported_input_schema_version"):
            build_mouse_feature_record({"schemaVersion": 2, "points": []})
        with self.assertRaisesRegex(TypeError, "options_must_be_an_object"):
            build_mouse_feature_record({"schemaVersion": 1, "points": []}, None)
        with self.assertRaisesRegex(TypeError, "points_must_be_an_array"):
            build_mouse_feature_record({"schemaVersion": 1, "points": {}})
        with self.assertRaisesRegex(TypeError, "attempt_id_must_be_a_string"):
            build_mouse_feature_record({"schemaVersion": 1, "attemptId": 4, "points": []})


if __name__ == "__main__":
    unittest.main()

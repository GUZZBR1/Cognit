import copy
import unittest

from ai_observer import analyze_dataset


class AiObserverTests(unittest.TestCase):
    def test_reports_aggregate_clusters_and_numeric_candidates_deterministically(self):
        dataset = {
            "schema_version": 1,
            "source_id": "offline-export-2026-01",
            "records": [
                {"signals": {"browser": {"webdriver": False}, "mouse": {"duration_ms": 1}}},
                {"signals": {"browser": {"webdriver": False}, "mouse": {"duration_ms": 1}}},
                {"signals": {"browser": {"webdriver": True}, "mouse": {"duration_ms": 1}}},
                {"signals": {"browser": {"webdriver": True}, "mouse": {"duration_ms": 100}}},
            ],
        }

        first = analyze_dataset(dataset)
        second = analyze_dataset(dataset)

        self.assertEqual(first, second)
        self.assertEqual(first["status"], "analyzed")
        self.assertEqual(first["provenance"]["source_id"], "offline-export-2026-01")
        self.assertEqual(len(first["provenance"]["canonical_input_sha256"]), 64)
        self.assertEqual(len(first["provenance"]["configuration_sha256"]), 64)
        kinds = {observation["kind"] for observation in first["observations"]}
        self.assertIn("repeated_pattern_cluster", kinds)
        self.assertIn("numeric_outlier_candidate", kinds)
        self.assertTrue(all(item["conclusion"] is None for item in first["observations"]))
        self.assertEqual(first["conclusions"], [])
        self.assertEqual(first["field_summaries"]["mouse.duration_ms"]["numeric"]["outlier_count_iqr_1_5"], 1)
        serialized = str(first)
        self.assertNotIn('"webdriver": False', serialized)
        self.assertNotIn('"webdriver": True', serialized)

    def test_input_is_not_mutated(self):
        dataset = {
            "schema_version": 1,
            "source_id": "fixture",
            "records": [{"signals": {"timing": {"response_ms": value}}} for value in (10, 11, 12, 13)],
        }
        original = copy.deepcopy(dataset)

        analyze_dataset(dataset)

        self.assertEqual(dataset, original)

    def test_sparse_or_empty_data_is_explicitly_insufficient(self):
        report = analyze_dataset({"schema_version": 1, "source_id": "empty-fixture", "records": []})
        self.assertEqual(report["status"], "insufficient_data")
        coverage = next(item for item in report["observations"] if item["kind"] == "data_coverage")
        self.assertEqual(coverage["evidence"]["record_count"], 0)

    def test_rejects_missing_origin_wrong_schema_and_non_finite_values(self):
        for dataset in (
            {"schema_version": 1, "records": []},
            {"schema_version": 2, "source_id": "fixture", "records": []},
            {"schema_version": 1, "source_id": "fixture", "records": [{"signals": {"timing": {"x": float("nan")}}}]},
        ):
            with self.subTest(dataset=dataset), self.assertRaises(ValueError):
                analyze_dataset(dataset)

    def test_explicitly_does_not_infer_false_positive_or_negative_labels(self):
        report = analyze_dataset({
            "schema_version": 1,
            "source_id": "fixture",
            "records": [{"signals": {"browser": {"indicator": value}}} for value in (True, False, True, False)],
        })
        self.assertEqual(report["conclusions"], [])
        self.assertTrue(any("False-positive and false-negative labels are not inferred" in item for item in report["limitations"]))


if __name__ == "__main__":
    unittest.main()

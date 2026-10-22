import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
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
        field_key = '["mouse","duration_ms"]'
        self.assertEqual(first["field_summaries"][field_key]["numeric"]["outlier_count_iqr_1_5"], 1)
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

    def test_cli_reads_source_without_modifying_it_and_writes_report_to_stdout(self):
        dataset = {
            "schema_version": 1,
            "source_id": "offline-fixture",
            "records": [{"signals": {"timing": {"response_ms": value}}} for value in (10, 11, 12, 13)],
        }
        source = Path(__file__).with_name("ai_observer.py")
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp_dir:
            input_path = Path(temp_dir) / "minimized.json"
            original = json.dumps(dataset).encode("utf-8")
            input_path.write_bytes(original)

            result = subprocess.run(
                [sys.executable, str(source), str(input_path)],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(input_path.read_bytes(), original)
            self.assertEqual(json.loads(result.stdout)["status"], "analyzed")

    def test_issue_19_fixture_produces_a_repeatable_distribution_deviation_candidate(self):
        fixture_path = Path(__file__).parent / "test" / "fixtures" / "anomaly-dataset-v1.json"
        observer_path = Path(__file__).with_name("ai_observer.py")
        original = fixture_path.read_bytes()

        reports = []
        for _ in range(2):
            result = subprocess.run(
                [sys.executable, str(observer_path), str(fixture_path)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            reports.append(json.loads(result.stdout))

        self.assertEqual(reports[0], reports[1])
        self.assertEqual(fixture_path.read_bytes(), original)
        report = reports[0]
        self.assertEqual(report["status"], "analyzed")
        self.assertEqual(report["provenance"]["source_id"], "issue-19-offline-fixture")
        self.assertIn(
            "numeric_outlier_candidate",
            {observation["kind"] for observation in report["observations"]},
        )
        scores = report["record_scores"]
        self.assertEqual([item["score"] for item in scores], [0, 0, 0, 100])
        self.assertEqual(max(scores, key=lambda item: item["score"])["record_index"], 3)
        self.assertEqual(report["conclusions"], [])

    def test_record_score_is_unavailable_when_record_has_no_numeric_fields(self):
        report = analyze_dataset({
            "schema_version": 1,
            "source_id": "categorical-only-fixture",
            "records": [{"signals": {"browser": {"webdriver": False}}} for _ in range(4)],
        })

        self.assertTrue(all(item["score"] is None for item in report["record_scores"]))

    def test_dotted_group_and_field_names_do_not_collide(self):
        dataset = {
            "schema_version": 1,
            "source_id": "fixture",
            "records": [
                {"signals": {"a.b": {"c": 1}, "a": {"b.c": 10}}}
                for _ in range(4)
            ],
        }

        report = analyze_dataset(dataset)

        self.assertEqual(report["field_summaries"]['["a.b","c"]']["numeric"]["mean"], 1)
        self.assertEqual(report["field_summaries"]['["a","b.c"]']["numeric"]["mean"], 10)

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
            {"schema_version": 1, "source_id": "fixture", "records": [{"signals": {"timing": {"x": 10**10000}}}]},
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
        self.assertEqual(report["provenance"]["reviewed_comparison_count"], 0)
        self.assertEqual(report["provenance"]["potential_false_positive_count"], 0)
        self.assertEqual(report["provenance"]["potential_false_negative_count"], 0)

    def test_reports_aggregated_false_positive_and_negative_review_candidates(self):
        provenance = {"method": "manual review", "origin": "study review", "procedure": "protocol v1"}
        dataset = {
            "schema_version": 1,
            "source_id": "reviewed-export",
            "positive_class": "automation_indicator",
            "records": [
                {"signals": {"browser": {"webdriver": True}}, "evaluation": {
                    "prediction": "positive", "reviewed_outcome": "negative", "review_provenance": provenance,
                }},
                {"signals": {"browser": {"webdriver": False}}, "evaluation": {
                    "prediction": "negative", "reviewed_outcome": "positive", "review_provenance": provenance,
                }},
            ],
        }

        report = analyze_dataset(dataset)

        kinds = {item["kind"] for item in report["observations"]}
        self.assertIn("potential_false_positive_candidate", kinds)
        self.assertIn("potential_false_negative_candidate", kinds)
        self.assertEqual(report["provenance"]["potential_false_positive_count"], 1)
        self.assertEqual(report["provenance"]["potential_false_negative_count"], 1)
        self.assertNotIn("manual review", json.dumps(report))
        self.assertTrue(all(item["conclusion"] is None for item in report["observations"]))

    def test_review_comparisons_require_positive_class_and_complete_provenance(self):
        record = {"evaluation": {
            "prediction": "positive", "reviewed_outcome": "negative",
            "review_provenance": {"method": "manual", "origin": "review", "procedure": "v1"},
        }}
        for dataset in (
            {"schema_version": 1, "source_id": "fixture", "records": [record]},
            {"schema_version": 1, "source_id": "fixture", "positive_class": "automation", "records": [{
                "evaluation": {**record["evaluation"], "review_provenance": {"method": "manual"}}
            }]},
        ):
            with self.subTest(dataset=dataset), self.assertRaises(ValueError):
                analyze_dataset(dataset)


if __name__ == "__main__":
    unittest.main()

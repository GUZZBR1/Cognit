import json
import tempfile
import unittest
from pathlib import Path

from benchmark_report import build_report


class BenchmarkReportTests(unittest.TestCase):
    def write_json(self, directory, name, document):
        path = Path(directory) / name
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def test_missing_groups_are_unavailable_without_inferred_metrics(self):
        report = build_report({})
        self.assertEqual(report, build_report({}))
        self.assertEqual(set(report["groups"]), {"human", "playwright", "selenium", "puppeteer"})
        for group in report["groups"].values():
            self.assertEqual(group["status"], "unavailable")
            self.assertEqual(group["reason"], "no_dataset_supplied")
        self.assertIn("95% percentile cluster bootstrap", report["protocol"]["uncertainty"])
        self.assertEqual(len(report["protocol"]["challenge_set_sha256"]), 64)

    def test_automation_aggregates_rates_features_versions_and_session_uncertainty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "selenium.json", {
                "schema_version": 1,
                "session_id": "session-1",
                "attempts": [
                    {
                        "session_id": "session-1",
                        "tool": "selenium-webdriver",
                        "tool_version": "4.0",
                        "browser": "Chrome",
                        "browser_version": "130",
                        "challenge_id": "c1",
                        "mouse_telemetry": {"status": "complete", "features": {"pauseCount": 2}},
                        "features": {"signals": [{"id": "navigator_webdriver", "observed": True}]},
                        "observed_result": {"correct": True, "reaction_time_ms": 100, "duration_ms": 50},
                    },
                    {
                        "session_id": "session-2",
                        "tool": "selenium-webdriver",
                        "tool_version": "4.0",
                        "browser": "Chrome",
                        "browser_version": "130",
                        "challenge_id": "c1",
                        "mouse_telemetry": {"status": "incomplete", "features": None},
                        "observed_result": {"correct": False, "reaction_time_ms": 300, "duration_ms": 50},
                    },
                ],
            })
            group = build_report({"selenium": path})["groups"]["selenium"]

        self.assertEqual(group["status"], "available")
        self.assertEqual(group["sample"], {
            "clusters": 2, "cluster_unit": "session_id", "attempts": 2, "accuracy_eligible_attempts": 2,
            "independently_confirmed_human_attempts": 0,
        })
        self.assertEqual(group["metrics"]["accuracy"]["numerator"], 1)
        self.assertEqual(group["metrics"]["accuracy"]["denominator"], 2)
        self.assertEqual(group["metrics"]["reaction_time_ms"]["mean"], 200)
        self.assertEqual(group["metrics"]["reaction_time_ms"]["uncertainty_95"]["method"],
                         "percentile bootstrap resampling cluster summaries")
        self.assertEqual(group["metrics"]["accuracy"]["value"], 0.5)
        self.assertEqual(group["mouse_features"]["pauseCount"]["count"], 1)
        self.assertEqual(group["browser_signals"]["navigator_webdriver"]["denominator"], 1)
        self.assertEqual(group["versions"]["browser_version"], ["130"])
        self.assertEqual(group["challenge_performance"]["c1"]["denominator"], 2)
        self.assertIsNone(group["metrics"]["completion_time_ms"]["mean"])
        self.assertEqual(group["metrics"]["completion_time_ms"]["unavailable_reason"], "no_eligible_observations")

    def test_human_metrics_require_confirmation_and_prediction_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [
                    {
                        "pseudonym": f"p-{index}", "HUMAN_CONFIRMED": True,
                        "human_confirmation": {"method": "review", "origin": "observed", "procedure": "v1"},
                        "correct": index == 0, "reaction_time_ms": 100 + index,
                        "duration_ms": 50, "predicted_automation": index == 0,
                        "prediction_provenance": {"method": "detector", "origin": "offline-eval", "version": "v1"},
                    }
                    for index in range(2)
                ] + [{"pseudonym": "unreviewed", "correct": True, "reaction_time_ms": 1}],
            })
            report = build_report({"human": path})
            group = report["groups"]["human"]

        self.assertEqual(group["sample"]["attempts"], 2)
        self.assertEqual(group["metrics"]["accuracy"]["denominator"], 2)
        self.assertEqual(group["metrics"]["human_false_positive_rate"]["numerator"], 1)
        self.assertEqual(group["metrics"]["human_false_positive_rate"]["denominator"], 2)
        self.assertEqual(group["metrics"]["reaction_time_ms"]["uncertainty_95"]["confidence_level"], 0.95)
        self.assertEqual(group["sample"]["cluster_unit"], "consent_pseudonym")

    def test_repeated_human_attempts_share_a_consent_cluster_not_independent_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [
                    {
                        "pseudonym": "same-consent", "HUMAN_CONFIRMED": True,
                        "human_confirmation": {"method": "review", "origin": "observed", "procedure": "v1"},
                        "correct": index == 0, "reaction_time_ms": 100 + index,
                        "duration_ms": 50,
                    }
                    for index in range(3)
                ],
            })
            group = build_report({"human": path})["groups"]["human"]

        self.assertEqual(group["sample"]["clusters"], 1)
        self.assertEqual(group["sample"]["cluster_unit"], "consent_pseudonym")
        self.assertEqual(group["sample"]["attempts"], 3)
        self.assertEqual(group["metrics"]["accuracy"]["cluster_count"], 1)
        self.assertEqual(
            group["metrics"]["accuracy"]["uncertainty_95"]["unavailable_reason"],
            "requires_at_least_two_clusters",
        )

    def test_human_without_operator_confirmation_stays_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [{"pseudonym": "p-1", "correct": True}],
            })
            group = build_report({"human": path})["groups"]["human"]
        self.assertEqual(group["status"], "unavailable")
        self.assertEqual(group["reason"], "no_independently_confirmed_human_records")

    def test_human_null_timing_and_missing_prediction_are_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [{
                    "pseudonym": f"p-{index}", "HUMAN_CONFIRMED": True,
                    "human_confirmation": {"method": "review", "origin": "observed", "procedure": "v1"},
                    "correct": True, "reaction_time_ms": None, "duration_ms": None,
                } for index in range(2)],
            })
            metrics = build_report({"human": path})["groups"]["human"]["metrics"]
        self.assertIsNone(metrics["reaction_time_ms"]["mean"])
        self.assertEqual(metrics["reaction_time_ms"]["unavailable_reason"], "no_eligible_observations")
        self.assertEqual(metrics["human_false_positive_rate"]["denominator"], 0)
        self.assertIsNone(metrics["human_false_positive_rate"]["value"])

    def test_invalid_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "run.json", {"schema_version": 2, "attempts": []})
            with self.assertRaisesRegex(ValueError, "schema_version 1"):
                build_report({"playwright": path})


if __name__ == "__main__":
    unittest.main()
